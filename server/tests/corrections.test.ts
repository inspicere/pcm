import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_DECAY_RATE } from "../../src/index.ts";
import { createEmbedder } from "../src/embedder.ts";
import type { AnnIndex } from "../src/pgvector.ts";
import {
  createMcpServer,
  ingestItem,
  sha256Hex,
  TenantRegistry,
  type IngestResult,
  type TenantContext,
} from "../src/server.ts";
import { recall } from "../src/scoring.ts";
import { BASELINE_SCHEMA_VERSION, SCHEMA_VERSION, TenantStore } from "../src/store.ts";
import { daysAgoIso, makeRegistry, makeTmpDir, trackDir } from "./helpers.ts";

function mustId(result: IngestResult): string {
  if (result.id === null) throw new Error("expected an ingested id, got a denylist block");
  return result.id;
}

interface RecallTexts {
  asker: string[];
  situational: string[];
}

async function recallTexts(
  ctx: TenantContext,
  query: string,
  includeStale = false,
): Promise<RecallTexts> {
  const result = await recall(ctx.store, ctx.embedder, query, {
    k: 10,
    includeStale,
    decayRate: ctx.decayRate,
  });
  return {
    asker: result.slots.asker_context.map((item) => item.text),
    situational: result.slots.situational_context.map((item) => item.text),
  };
}

async function withMcpClient<T>(ctx: TenantContext, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "corrections-test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

interface ToolCallOutcome {
  isError: boolean;
  structured: Record<string, unknown> | undefined;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: Boolean((result as { isError?: boolean }).isError),
    structured: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
  };
}

function insertRow(store: TenantStore, id: string, text: string): void {
  store.insert({
    id,
    bodyHash: sha256Hex(text),
    text,
    importance: "default",
    strength: 0.5,
    occurredAt: daysAgoIso(1),
    embedding: null,
  });
}

describe("schema v2 corrections migration", () => {
  test("fresh store opens at v2 with corrections columns and tables", () => {
    const store = new TenantStore(trackDir(makeTmpDir()), "alpha");
    expect(store.storedSchemaVersion()).toBe(2);
    expect(store.storedSchemaVersion()).toBe(SCHEMA_VERSION);

    const cols = store.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("retracted_at");
    expect(cols.map((c) => c.name)).toContain("superseded_by");

    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("corrections");
    expect(tables.map((t) => t.name)).toContain("purged_hashes");
    store.close();
  });

  test("a v1 database upgrades to v2 and reopening is idempotent", () => {
    const dir = trackDir(makeTmpDir());

    // open with an empty migration list to pin the database at the v1 baseline
    const v1 = new TenantStore(dir, "alpha", []);
    expect(v1.storedSchemaVersion()).toBe(BASELINE_SCHEMA_VERSION);
    v1.close();

    const v2 = new TenantStore(dir, "alpha");
    expect(v2.storedSchemaVersion()).toBe(2);
    v2.close();

    const reopened = new TenantStore(dir, "alpha");
    expect(reopened.storedSchemaVersion()).toBe(2);
    const correctionCols = reopened.db.prepare("PRAGMA table_info(corrections)").all() as Array<{
      name: string;
    }>;
    expect(correctionCols.map((c) => c.name)).toEqual([
      "seq",
      "action",
      "body_hash",
      "new_hash",
      "reason",
      "occurred_at",
      "created_at",
    ]);
    const purgedCols = reopened.db.prepare("PRAGMA table_info(purged_hashes)").all() as Array<{
      name: string;
    }>;
    expect(purgedCols.map((c) => c.name)).toEqual(["body_hash", "reason", "created_at"]);
    reopened.close();
  });
});

describe("denylist gating in ingestItem", () => {
  test("a denied hash blocks ingest even while a live row exists (deny runs before dedup)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "The staging database password rotates on the first of each month promptly.";
    const first = await ingestItem(ctx, { text });
    expect(first.deduplicated).toBe(false);
    expect(ctx.store.count()).toBe(1);

    ctx.store.denyHash(first.bodyHash, "operator purge");

    const second = await ingestItem(ctx, { text });
    expect(second.blocked).toBe(true);
    expect(second.deduplicated).toBe(false);
    if (second.blocked) {
      expect(second.reason).toBe("operator purge");
    }
    expect(ctx.store.count()).toBe(1);
  });

  test("a purged hash (no row left) blocks ingest on the MCP and session_wrap paths", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "Vault unseal keys are sharded across the three trustee laptops in the lab.";
    const hash = sha256Hex(text);
    ctx.store.denyHash(hash, "contains a secret");

    const direct = await ingestItem(ctx, { text });
    expect(direct.blocked).toBe(true);
    expect(ctx.store.count()).toBe(0);

    await withMcpClient(ctx, async (client) => {
      const tool = await callTool(client, "memvault_ingest", { text });
      expect(tool.isError).toBe(false);
      expect(tool.structured).toMatchObject({ id: null, blocked: true, deduplicated: false });
      expect(tool.structured?.reason).toBe("contains a secret");

      const wrap = await callTool(client, "memvault_session_wrap", {
        sessionId: "s-deny",
        turns: [
          { role: "user", content: "note this down" },
          { role: "assistant", content: text },
        ],
      });
      expect(wrap.isError).toBe(false);
      expect(wrap.structured).toMatchObject({
        sessionId: "s-deny",
        ingested: 0,
        deduplicated: 0,
        blocked: 1,
      });
    });

    expect(ctx.store.count()).toBe(0);
  });
});

describe("retract", () => {
  test("retracted rows leave both recall entry points and return with includeStale", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const situationalText = "Restic backups target the NAS snapshot pool every night at 02:00 sharp.";
    const pinnedText = "The on-call webhook for alerting routes through the incident channel only.";

    const ingSituational = await ingestItem(ctx, { text: situationalText });
    const ingPinned = await ingestItem(ctx, { text: pinnedText, importance: "pinned" });

    let r = await recallTexts(ctx, "restic backups");
    expect(r.situational.some((t) => t.includes("Restic backups"))).toBe(true);
    r = await recallTexts(ctx, "on-call webhook alerting");
    expect(r.asker.some((t) => t.includes("on-call webhook"))).toBe(true);

    const { row, correction } = ctx.store.retract(
      { bodyHash: sha256Hex(situationalText) },
      "factually wrong",
    );
    expect(row.retracted_at).not.toBeNull();
    expect(correction?.action).toBe("retract");
    expect(correction?.reason).toBe("factually wrong");
    expect(correction?.new_hash).toBeNull();

    ctx.store.retract({ id: mustId(ingPinned) }, "superseded by the runbook");

    r = await recallTexts(ctx, "restic backups");
    expect(r.situational.some((t) => t.includes("Restic backups"))).toBe(false);
    r = await recallTexts(ctx, "on-call webhook alerting");
    expect(r.asker.some((t) => t.includes("on-call webhook"))).toBe(false);

    // retraction is stronger than the stale filter but weaker than includeStale
    const withStale = await recallTexts(ctx, "restic backups", true);
    expect(withStale.situational.some((t) => t.includes("Restic backups"))).toBe(true);
    const withStalePinned = await recallTexts(ctx, "on-call webhook alerting", true);
    expect(withStalePinned.asker.some((t) => t.includes("on-call webhook"))).toBe(true);

    // the row still exists for dedup (asserted in the D1 test below)
    expect(ctx.store.getById(mustId(ingSituational))?.retracted_at).not.toBeNull();
  });

  test("re-ingest of retracted text deduplicates and never un-retracts (D1)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "Postgres WAL archiving streams to the backup stanza every hour for safety.";
    const first = await ingestItem(ctx, { text });
    ctx.store.retract({ id: mustId(first) }, "bad fact");

    const again = await ingestItem(ctx, { text });
    expect(again.deduplicated).toBe(true);
    expect(mustId(again)).toBe(mustId(first));

    const row = ctx.store.getByHash(sha256Hex(text))!;
    expect(row.retracted_at).not.toBeNull();
    expect(ctx.store.count()).toBe(1);

    const r = await recallTexts(ctx, "WAL archiving");
    expect(r.situational.some((t) => t.includes("WAL archiving"))).toBe(false);
  });

  test("retract is idempotent (no second audit row) and unretract restores recall", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "The metrics retention for prometheus is thirteen months on the NVMe tier.";
    const ingested = await ingestItem(ctx, { text });
    const id = mustId(ingested);

    const first = ctx.store.retract({ id }, "operator mistake");
    expect(first.correction?.action).toBe("retract");
    const second = ctx.store.retract({ id }, "operator mistake again");
    expect(second.correction).toBeNull();
    expect(second.row.retracted_at).not.toBeNull();

    let audit = ctx.store.listCorrections().filter((c) => c.body_hash === ingested.bodyHash);
    expect(audit).toHaveLength(1);

    let r = await recallTexts(ctx, "prometheus retention");
    expect(r.situational.some((t) => t.includes("prometheus"))).toBe(false);

    const undone = ctx.store.unretract({ id }, "mistake was not a mistake");
    expect(undone.correction?.action).toBe("unretract");
    expect(undone.row.retracted_at).toBeNull();

    const noop = ctx.store.unretract({ id }, "nothing to do");
    expect(noop.correction).toBeNull();

    audit = ctx.store.listCorrections().filter((c) => c.body_hash === ingested.bodyHash);
    expect(audit.map((c) => c.action)).toEqual(["unretract", "retract"]);
    expect(audit[0]!.reason).toBe("mistake was not a mistake");
    expect(audit[1]!.reason).toBe("operator mistake");

    r = await recallTexts(ctx, "prometheus retention");
    expect(r.situational.some((t) => t.includes("prometheus"))).toBe(true);
  });

  test("retract/unretract/correct reject missing or ambiguous targets", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    expect(() => store.retract({ id: "nope" }, "r")).toThrow(/not found/);
    expect(() => store.unretract({ bodyHash: "0".repeat(64) }, "r")).toThrow(/not found/);
    expect(() => store.correct({ id: "nope" }, "some new text", "r")).toThrow(/not found/);
    expect(() => store.retract({}, "r")).toThrow(/exactly one/);
    expect(() => store.retract({ id: "a", bodyHash: "b" }, "r")).toThrow(/exactly one/);
    store.close();
  });
});

describe("correct", () => {
  test("correct replaces a memory transactionally: old retracted, new live and recalled", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const oldText = "Offsite backups keep a 30-day retention window on the restic repository.";
    const newText = "Offsite backups keep a 14-day retention window on the restic repository.";

    const ingested = await ingestItem(ctx, {
      text: oldText,
      source: "runbook",
      sourceRef: "rb-7",
    });
    const { oldRow, newRow, correction } = ctx.store.correct(
      { id: mustId(ingested) },
      newText,
      "retention was shortened in Q3",
    );

    expect(oldRow.retracted_at).not.toBeNull();
    expect(newRow.retracted_at).toBeNull();
    expect(newRow.body_hash).toBe(sha256Hex(newText));
    expect(newRow.superseded_by).toBe(oldRow.body_hash);
    expect(newRow.importance).toBe("high");
    expect(newRow.source).toBe("runbook");
    expect(newRow.source_ref).toBe("rb-7");

    expect(correction.action).toBe("correct");
    expect(correction.body_hash).toBe(oldRow.body_hash);
    expect(correction.new_hash).toBe(newRow.body_hash);
    expect(correction.reason).toBe("retention was shortened in Q3");

    const r = await recallTexts(ctx, "offsite backup retention");
    expect(r.situational.some((t) => t.includes("14-day"))).toBe(true);
    expect(r.situational.some((t) => t.includes("30-day"))).toBe(false);
  });

  test("correcting a pinned target never inherits pinned (D4)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    const pinned = await ingestItem(ctx, {
      text: "The incident bridge channel for sev1 pages is the loud swan room.",
      importance: "pinned",
    });
    const byDefault = ctx.store.correct(
      { id: mustId(pinned) },
      "The incident bridge channel for sev1 pages is the quiet heron room.",
      "room renamed",
    );
    expect(byDefault.newRow.importance).toBe("high");
    expect(byDefault.oldRow.importance).toBe("pinned");

    const pinned2 = await ingestItem(ctx, {
      text: "The sev2 incident bridge channel is the quiet heron room upstairs.",
      importance: "pinned",
    });
    const explicit = ctx.store.correct(
      { id: mustId(pinned2) },
      "The sev2 incident bridge channel is the loud swan room upstairs.",
      "room renamed back",
      "default",
    );
    expect(explicit.newRow.importance).toBe("default");
  });

  test("correct rejects self-correction and hash collisions without writing audit", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    insertRow(store, "a-id", "alpha text one");
    insertRow(store, "b-id", "bravo text two");

    expect(() => store.correct({ id: "a-id" }, "alpha text one", "self")).toThrow(/self-correct/);
    expect(() => store.correct({ id: "a-id" }, "bravo text two", "collision")).toThrow(
      /already exists/,
    );

    expect(store.listCorrections()).toHaveLength(0);
    expect(store.getById("a-id")!.retracted_at).toBeNull();
    expect(store.getById("b-id")!.retracted_at).toBeNull();
    store.close();
  });
});

describe("MCP tools", () => {
  test("memvault_retract: resolves text server-side, audits, idempotent, enforces exactly-one-of", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "The quarterly access review for the vault happens on the first Tuesday.";
    await ingestItem(ctx, { text });

    await withMcpClient(ctx, async (client) => {
      const both = await callTool(client, "memvault_retract", { text, id: "x", reason: "r" });
      expect(both.isError).toBe(true);
      const neither = await callTool(client, "memvault_retract", { reason: "r" });
      expect(neither.isError).toBe(true);

      const ok = await callTool(client, "memvault_retract", { text, reason: "wrong quarter" });
      expect(ok.isError).toBe(false);
      expect(ok.structured).toMatchObject({
        bodyHash: sha256Hex(text),
        alreadyRetracted: false,
        reason: "wrong quarter",
      });
      expect(typeof ok.structured?.id).toBe("string");
      expect(typeof ok.structured?.retractedAt).toBe("string");
      expect(typeof ok.structured?.auditSeq).toBe("number");

      const again = await callTool(client, "memvault_retract", { text, reason: "repeat" });
      expect(again.isError).toBe(false);
      expect(again.structured).toMatchObject({ alreadyRetracted: true, auditSeq: null });
    });

    const audit = ctx.store.listCorrections().filter((c) => c.action === "retract");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe("wrong quarter");

    const r = await recallTexts(ctx, "access review");
    expect(r.situational.some((t) => t.includes("access review"))).toBe(false);
  });

  test("memvault_correct: resolves oldText, outputs old/new ids and hashes, new text recalled", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const oldText = "The warehouse snapshot job runs every six hours on the zfs pool.";
    const newText = "The warehouse snapshot job runs every two hours on the zfs pool.";
    const ingested = await ingestItem(ctx, { text: oldText });

    await withMcpClient(ctx, async (client) => {
      const both = await callTool(client, "memvault_correct", {
        oldText,
        oldId: "x",
        newText,
        reason: "r",
      });
      expect(both.isError).toBe(true);
      const neither = await callTool(client, "memvault_correct", { newText, reason: "r" });
      expect(neither.isError).toBe(true);
      const self = await callTool(client, "memvault_correct", {
        oldText,
        newText: oldText,
        reason: "r",
      });
      expect(self.isError).toBe(true);

      const ok = await callTool(client, "memvault_correct", {
        oldText,
        newText,
        reason: "cadence changed",
      });
      expect(ok.isError).toBe(false);
      expect(ok.structured).toMatchObject({
        oldId: mustId(ingested),
        oldHash: sha256Hex(oldText),
        newHash: sha256Hex(newText),
        importance: "high",
        reason: "cadence changed",
      });
      expect(typeof ok.structured?.newId).toBe("string");
      expect(typeof ok.structured?.auditSeq).toBe("number");
      expect(ok.structured?.newId).not.toBe(mustId(ingested));
    });

    const r = await recallTexts(ctx, "warehouse snapshot job");
    expect(r.situational.some((t) => t.includes("every two hours"))).toBe(true);
    expect(r.situational.some((t) => t.includes("every six hours"))).toBe(false);

    const newRow = ctx.store.getByHash(sha256Hex(newText))!;
    expect(newRow.superseded_by).toBe(sha256Hex(oldText));
  });

  test("retract/correct eagerly delete the old row from the ANN index (best-effort)", async () => {
    const dir = trackDir(makeTmpDir());
    const deleted: string[] = [];
    const fakeAnn: AnnIndex = {
      status: "ready",
      host: "mock",
      ping: async () => true,
      upsert: async () => {},
      delete: async (_tenant, memoryId) => {
        deleted.push(memoryId);
      },
      search: async () => [],
    };
    const registry = new TenantRegistry(
      dir,
      createEmbedder({ baseUrl: null, model: "fake", timeoutMs: 1000 }),
      DEFAULT_DECAY_RATE,
      fakeAnn,
    );
    const ctx = registry.get("hermes");

    const oldText = "The syslog forwarder on monitor-01 ships to the central collector.";
    const newText = "The syslog forwarder on monitor-02 ships to the central collector.";
    const ingested = await ingestItem(ctx, { text: oldText });

    await withMcpClient(ctx, async (client) => {
      const corrected = await callTool(client, "memvault_correct", {
        oldId: mustId(ingested),
        newText,
        reason: "host renamed",
      });
      expect(corrected.isError).toBe(false);

      const newId = corrected.structured?.newId as string;
      const retracted = await callTool(client, "memvault_retract", { id: newId, reason: "bad fact" });
      expect(retracted.isError).toBe(false);
    });

    expect(deleted).toEqual([mustId(ingested), ctx.store.getByHash(sha256Hex(newText))!.id]);
  });
});

describe("sanitize (operator-only, no agent tool)", () => {
  test("purge: deny first, 'purge' audit row, row deleted, re-ingest blocked (D1)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "The CI runner pool scales to forty spot workers during business hours.";
    const ingested = await ingestItem(ctx, { text });
    const id = mustId(ingested);
    const hash = ingested.bodyHash;

    const { row, correction } = ctx.store.sanitize({ id }, "gdpr erasure request");
    expect(row.id).toBe(id);
    expect(correction.action).toBe("purge");
    expect(correction.body_hash).toBe(hash);

    expect(ctx.store.getById(id)).toBeNull();
    expect(ctx.store.getByHash(hash)).toBeNull();
    expect(ctx.store.isDenied(hash)).toBe(true);
    expect(ctx.store.deniedReason(hash)).toBe("gdpr erasure request");
    expect(ctx.store.count()).toBe(0);

    const purged = ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM purged_hashes")
      .get() as { n: number };
    expect(purged.n).toBe(1);

    const re = await ingestItem(ctx, { text });
    expect(re.blocked).toBe(true);
    expect(re.deduplicated).toBe(false);
    expect(re.id).toBeNull();
    expect(ctx.store.count()).toBe(0);

    // a purge is a hard delete: not even includeStale can resurrect it
    const r = await recallTexts(ctx, "CI runner pool", true);
    expect(r.situational.some((t) => t.includes("CI runner pool"))).toBe(false);
  });

  test("sanitize is re-runnable when only the deny landed (delete failed mid-run)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");
    const text = "The bastion host for vlan70 lives behind the firewall failover pair.";
    await ingestItem(ctx, { text });
    const hash = sha256Hex(text);

    // simulate a previous sanitize that wrote the denylist entry but died
    // before the DELETE: the row is still there, the hash already denied.
    ctx.store.denyHash(hash, "earlier partial run");

    const { correction } = ctx.store.sanitize({ bodyHash: hash }, "gdpr erasure request");
    expect(correction.action).toBe("purge");
    expect(ctx.store.getByHash(hash)).toBeNull();

    const purged = ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM purged_hashes")
      .get() as { n: number };
    expect(purged.n).toBe(1);
    expect(ctx.store.listCorrections().filter((c) => c.action === "purge")).toHaveLength(1);
  });

  test("the corrections log is append-only: no store API mutates or removes audit rows", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    insertRow(store, "1", "one memory text about a thing");

    store.retract({ id: "1" }, "r1");
    store.unretract({ id: "1" }, "r2");
    store.sanitize({ id: "1" }, "r3");

    const all = store.listCorrections(100);
    expect(all.map((c) => c.action)).toEqual(["purge", "unretract", "retract"]);
    const total = (store.db.prepare("SELECT COUNT(*) AS n FROM corrections").get() as { n: number })
      .n;
    expect(total).toBe(3);
    expect(all.every((c) => Number.isInteger(c.seq) && c.seq > 0)).toBe(true);
    store.close();
  });
});

describe("tenant isolation", () => {
  test("retract and deny in tenant A never affect tenant B", async () => {
    const dir = trackDir(makeTmpDir());
    const registry = makeRegistry(dir);
    const a = registry.get("alpha");
    const b = registry.get("beta");

    const text = "The graphite relay for metrics runs on the monitor node in vlan70.";
    const ingA = await ingestItem(a, { text });
    await ingestItem(b, { text });

    a.store.retract({ id: mustId(ingA) }, "alpha-only retraction");

    const deniedText = "The syslog aggregator keeps ninety days of logs on the NAS.";
    await ingestItem(a, { text: deniedText });
    a.store.sanitize({ bodyHash: sha256Hex(deniedText) }, "alpha-only purge");

    // tenant B: its copy of the retracted text is still recalled...
    const rb = await recallTexts(b, "graphite relay metrics");
    expect(rb.situational.some((t) => t.includes("graphite relay"))).toBe(true);

    // ...and the denied text ingests normally there
    const deniedIngest = await ingestItem(b, { text: deniedText });
    expect(deniedIngest.deduplicated).toBe(false);
    expect(deniedIngest.blocked).toBe(false);
    expect(b.store.isDenied(sha256Hex(deniedText))).toBe(false);
    expect(a.store.isDenied(sha256Hex(deniedText))).toBe(true);
  });
});

const PORT = 3793;
const BASE = `http://127.0.0.1:${PORT}`;
const CAROL = "carol-test-token";

describe("REST /ingest denylist reporting", () => {
  let proc: Subprocess;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = trackDir(makeTmpDir());
    proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: import.meta.dir + "/..",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PCM_PORT: String(PORT),
        PCM_HOST: "127.0.0.1",
        PCM_DATA_DIR: dataDir,
        PCM_TOKENS: `carol=${CAROL}`,
      },
      stdout: "inherit",
      stderr: "inherit",
    });

    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("pcm-server did not start in time");
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  afterAll(() => {
    proc?.kill();
  });

  test("blocked hashes are counted in the REST /ingest response", async () => {
    const text = "The grafana dashboard for backups lives in the operations folder only.";
    const headers = { "content-type": "application/json", authorization: `Bearer ${CAROL}` };

    const first = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      tenant: "carol",
      ingested: 1,
      deduplicated: 0,
      blocked: 0,
    });

    // operator purge via the store layer (sanitize is deliberately not exposed
    // over REST/MCP, per D6)
    const store = new TenantStore(dataDir, "carol");
    store.sanitize({ bodyHash: sha256Hex(text) }, "operator purge");
    store.close();

    const second = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      tenant: "carol",
      ingested: 0,
      deduplicated: 0,
      blocked: 1,
    });
  });
});
