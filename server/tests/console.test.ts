import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmbedder } from "../src/embedder.ts";
import { TenantRegistry } from "../src/server.ts";
import {
  BASELINE_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
  sha256Hex,
  TenantStore,
} from "../src/store.ts";
import { daysAgoIso, makeTmpDir, trackDir } from "./helpers.ts";

const PORT = 3794;
const OPORT = 3797;
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${OPORT}`;
const ALICE = "alice-console-token";
const ROOT = "root-console-token";
const OPS = "ops-console-token";

let proc: Subprocess;
let dataDir: string;

function form(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

async function login(name: string, token: string): Promise<Response> {
  return fetch(`${CONSOLE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ name, token }),
    redirect: "manual",
  });
}

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0]!;
}

async function csrfOf(cookie: string): Promise<string> {
  const res = await fetch(`${CONSOLE}/`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no csrf token on dashboard");
  return match[1]!;
}

async function consoleFetch(path: string, cookie: string): Promise<Response> {
  return fetch(`${CONSOLE}${path}`, { headers: { cookie }, redirect: "manual" });
}

async function mutate(
  path: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${CONSOLE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form(fields),
    redirect: "manual",
  });
}

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
      PCM_TOKENS: `alice=${ALICE}`,
      PCM_OPERATOR_TOKENS: `root=${ROOT},ops=${OPS}`,
      PCM_OPERATOR_HOST: "127.0.0.1",
      PCM_OPERATOR_PORT: String(OPORT),
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const [a, b] = await Promise.all([
        fetch(`${BASE}/healthz`),
        fetch(`${CONSOLE}/healthz`),
      ]);
      if (a.ok && b.ok) return;
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

describe("operator console listener", () => {
  test("unauthenticated requests redirect to /login", async () => {
    for (const path of ["/", "/t/alice", "/t/alice/pins", "/t/alice/audit"]) {
      const res = await consoleFetch(path, "");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    }
    // mutating POSTs redirect too (no CSRF surface for anonymous callers)
    const anon = await mutate("/t/alice/m/x/retract", "", { reason: "r", csrf: "x" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login");
  });

  test("login with a wrong token or a TENANT token fails with no cookie", async () => {
    for (const token of ["not-the-token", ALICE]) {
      const res = await login("root", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // wrong name with a valid operator token also fails
    const wrongName = await login("alice", ROOT);
    expect(wrongName.status).toBe(401);
    expect(wrongName.headers.get("set-cookie")).toBeNull();
  });

  test("successful login sets a hardened session cookie and it works", async () => {
    const res = await login("root", ROOT);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pcm_op=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toMatch(/Max-Age=28800/);

    const cookie = cookieOf(res);
    const dash = await consoleFetch("/", cookie);
    expect(dash.status).toBe(200);
    const html = await dash.text();
    expect(html).toContain("operator: root");
    expect(html).toContain("alice");
    // tenant API bearer tokens stay on the tenant listener: the dashboard
    // must not accept them, and /ingest must not accept operator cookies.
    const tenantApi = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `pcm_op=${ROOT}` },
      body: JSON.stringify({ text: "x".repeat(50) }),
    });
    expect(tenantApi.status).toBe(401);
  });

  test("logout clears the session", async () => {
    const res = await login("ops", OPS);
    const cookie = cookieOf(res);
    const csrf = await csrfOf(cookie);
    const out = await mutate("/logout", cookie, { csrf });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    const dash = await consoleFetch("/", cookie);
    expect(dash.status).toBe(303);
    expect(dash.headers.get("location")).toBe("/login");
  });

  test("operator /healthz exposes only status and operator names", async () => {
    const res = await fetch(`${CONSOLE}/healthz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", operators: ["root", "ops"] });
    expect(json.tenants).toBeUndefined();
    expect(json.schemaVersion).toBeUndefined();
    expect(json.tenantStores).toBeUndefined();
    expect(json.embedding).toBeUndefined();
  });
});

describe("operator console mutations", () => {
  const TEXT =
    "The cert-manager issuer for the lab wildcard uses the vault pki mount for all ingress certificates.";
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    const res = await login("root", ROOT);
    cookie = cookieOf(res);
    csrf = await csrfOf(cookie);
    // seed one memory through the tenant REST API (same process, other listener)
    const ingest = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
      body: JSON.stringify({ text: TEXT, source: "console-test" }),
    });
    expect(ingest.status).toBe(200);
    expect((await ingest.json()).ingested).toBe(1);
  });

  test("mutating POST without a CSRF token is rejected with 403", async () => {
    const hash = sha256Hex(TEXT);
    const store = new TenantStore(dataDir, "alice");
    const row = store.getByHash(hash)!;
    const res = await mutate(`/t/alice/m/${row.id}/retract`, cookie, { reason: "no csrf" });
    expect(res.status).toBe(403);
    expect(store.getById(row.id)!.retracted_at).toBeNull();
    store.close();
  });

  test("retract via the UI writes an audit row with the operator as actor", async () => {
    const hash = sha256Hex(TEXT);
    const store = new TenantStore(dataDir, "alice");
    const row = store.getByHash(hash)!;
    store.close();

    const res = await mutate(`/t/alice/m/${row.id}/retract`, cookie, {
      reason: "fact drifted",
      csrf,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/t/alice/m/${row.id}`);

    const check = new TenantStore(dataDir, "alice");
    const retracted = check.getById(row.id)!;
    expect(retracted.retracted_at).not.toBeNull();
    const audit = check
      .listCorrections()
      .filter((c) => c.body_hash === hash && c.action === "retract");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe("root");
    expect(audit[0]!.reason).toBe("fact drifted");
    check.close();

    // unretract through the UI as the other operator: actor switches
    const res2 = await mutate(`/t/alice/m/${row.id}/unretract`, cookie, {
      reason: "retracted by mistake",
      csrf,
    });
    expect(res2.status).toBe(303);
    const check2 = new TenantStore(dataDir, "alice");
    expect(check2.getById(row.id)!.retracted_at).toBeNull();
    expect(check2.listCorrections(1)[0]!.action).toBe("unretract");
    expect(check2.listCorrections(1)[0]!.actor).toBe("root");
    check2.close();
  });

  test("set importance via the UI pins and unpins with an audit row", async () => {
    const store = new TenantStore(dataDir, "alice");
    const row = store.getByHash(sha256Hex(TEXT))!;
    store.close();

    const pin = await mutate(`/t/alice/m/${row.id}/importance`, cookie, {
      importance: "pinned",
      reason: "golden guardrail",
      csrf,
    });
    expect(pin.status).toBe(303);
    let check = new TenantStore(dataDir, "alice");
    expect(check.getById(row.id)!.importance).toBe("pinned");
    expect(check.getById(row.id)!.strength).toBe(1);
    expect(check.listCorrections(1)[0]!.action).toBe("set_importance");
    check.close();

    // no-op same-value change is refused
    const noop = await mutate(`/t/alice/m/${row.id}/importance`, cookie, {
      importance: "pinned",
      reason: "no change",
      csrf,
    });
    expect(noop.status).toBe(400);

    const unpin = await mutate(`/t/alice/m/${row.id}/importance`, cookie, {
      importance: "default",
      reason: "no longer a guardrail",
      csrf,
    });
    expect(unpin.status).toBe(303);
    check = new TenantStore(dataDir, "alice");
    expect(check.getById(row.id)!.importance).toBe("default");
    check.close();
  });

  test("correct via the UI replaces the memory and links supersession", async () => {
    const oldHash = sha256Hex(TEXT);
    const store = new TenantStore(dataDir, "alice");
    const oldRow = store.getByHash(oldHash)!;
    store.close();
    const NEW = "The cert-manager issuer for the lab wildcard now uses the stepca mount for all ingress certificates.";

    const res = await mutate(`/t/alice/m/${oldRow.id}/correct`, cookie, {
      newText: NEW,
      reason: "issuer moved off vault",
      importance: "high",
      csrf,
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toContain(`/t/alice/m/`);

    const check = new TenantStore(dataDir, "alice");
    const newRow = check.getByHash(sha256Hex(NEW))!;
    expect(newRow.superseded_by).toBe(oldHash);
    expect(newRow.importance).toBe("high");
    expect(check.getById(oldRow.id)!.retracted_at).not.toBeNull();
    const audit = check.listCorrections(1)[0]!;
    expect(audit.action).toBe("correct");
    expect(audit.actor).toBe("root");
    expect(audit.new_hash).toBe(sha256Hex(NEW));
    check.close();
  });

  test("sanitize via the UI purges the row, denies the hash and blocks re-ingest", async () => {
    const PURGE =
      "The temporary wireguard key for the testbench is printed in the bench drawer label.";
    const ingest = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
      body: JSON.stringify({ text: PURGE }),
    });
    expect(await ingest.json()).toMatchObject({ ingested: 1 });

    const hash = sha256Hex(PURGE);
    const store = new TenantStore(dataDir, "alice");
    const row = store.getByHash(hash)!;
    store.close();

    // typed confirmation must match the memory id
    const wrong = await mutate(`/t/alice/m/${row.id}/sanitize`, cookie, {
      reason: "contains a secret",
      confirm: "not-the-id",
      csrf,
    });
    expect(wrong.status).toBe(400);
    let check = new TenantStore(dataDir, "alice");
    expect(check.getById(row.id)).not.toBeNull();
    check.close();

    const res = await mutate(`/t/alice/m/${row.id}/sanitize`, cookie, {
      reason: "contains a secret",
      confirm: row.id,
      csrf,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/t/alice");

    check = new TenantStore(dataDir, "alice");
    expect(check.getById(row.id)).toBeNull();
    expect(check.isDenied(hash)).toBe(true);
    expect(check.deniedReason(hash)).toBe("contains a secret");
    const audit = check.listCorrections(1)[0]!;
    expect(audit.action).toBe("purge");
    expect(audit.actor).toBe("root");
    check.close();

    // re-ingest of the purged text on the tenant listener is blocked (D1)
    const re = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
      body: JSON.stringify({ text: PURGE }),
    });
    expect(re.status).toBe(200);
    expect(await re.json()).toMatchObject({ ingested: 0, deduplicated: 0, blocked: 1 });
  });

  test("preemptive deny via the UI writes purged_hashes plus a deny audit row", async () => {
    const SECRET = "A denylist probe sentence that was never ingested and must stay blocked.";
    const res = await mutate("/t/alice/denylist/deny", cookie, {
      text: SECRET,
      reason: "preemptive secret block",
      csrf,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/t/alice/denylist");

    const check = new TenantStore(dataDir, "alice");
    const hash = sha256Hex(SECRET);
    expect(check.isDenied(hash)).toBe(true);
    const audit = check.listCorrections(1)[0]!;
    expect(audit.action).toBe("deny");
    expect(audit.actor).toBe("root");
    expect(audit.body_hash).toBe(hash);
    check.close();

    const page = await consoleFetch("/t/alice/denylist", cookie);
    const html = await page.text();
    expect(html).toContain(hash);
    expect(html).toContain("preemptive secret block");
  });

  test("GET pages render: browser filters, detail, pins, audit", async () => {
    const browser = await consoleFetch("/t/alice?q=cert-manager", cookie);
    expect(browser.status).toBe(200);
    const html = await browser.text();
    expect(html).toContain("cert-manager");

    const detail = await consoleFetch(`/t/alice/m/${encodeURIComponent("nope")}`, cookie);
    expect(detail.status).toBe(404);

    const pins = await consoleFetch("/t/alice/pins", cookie);
    expect(pins.status).toBe(200);

    const audit = await consoleFetch("/t/alice/audit", cookie);
    expect(audit.status).toBe(200);
    const auditHtml = await audit.text();
    expect(auditHtml).toContain("set_importance");
    expect(auditHtml).toContain("root");

    const unknown = await consoleFetch("/t/ mallory", cookie);
    expect(unknown.status).toBe(404);
  });
});

describe("store: operator-actor schema and console support methods", () => {
  test("v1→v2→v3 chain: baseline store upgrades and reopens idempotently with actor", () => {
    const dir = trackDir(makeTmpDir());
    const v1 = new TenantStore(dir, "legacy", []);
    expect(v1.storedSchemaVersion()).toBe(BASELINE_SCHEMA_VERSION);
    v1.close();

    const v3 = new TenantStore(dir, "legacy", [...SCHEMA_MIGRATIONS]);
    expect(v3.storedSchemaVersion()).toBe(3);
    expect(v3.storedSchemaVersion()).toBe(SCHEMA_VERSION);
    const cols = v3.db.prepare("PRAGMA table_info(corrections)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("actor");
    v3.close();

    const reopened = new TenantStore(dir, "legacy", [...SCHEMA_MIGRATIONS]);
    expect(reopened.storedSchemaVersion()).toBe(3);
    reopened.close();
  });

  test("correction methods record the actor; MCP-side calls stay NULL", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    store.insert({
      id: "actor-1",
      bodyHash: sha256Hex("actor probe memory about a probe thing"),
      text: "actor probe memory about a probe thing",
      importance: "default",
      strength: 0.5,
      occurredAt: daysAgoIso(1),
      embedding: null,
    });

    store.retract({ id: "actor-1" }, "agent retracts", undefined);
    store.unretract({ id: "actor-1" }, "operator restores", undefined, "root");
    const audit = store.listCorrections();
    expect(audit.map((c) => c.actor)).toEqual(["root", null]);
    store.close();
  });

  test("denyHash is audited only when the deny lands, and keeps idempotency", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    const hash = sha256Hex("some never ingested secret text for deny audit");

    store.denyHash(hash, "first deny", "root");
    store.denyHash(hash, "second deny attempt", "ops");
    const audit = store.listCorrections();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("deny");
    expect(audit[0]!.actor).toBe("root");
    expect(store.deniedReason(hash)).toBe("first deny");
    store.close();
  });

  test("setImportance is transactional, audited, and refuses no-op changes", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    store.insert({
      id: "imp-1",
      bodyHash: sha256Hex("importance probe memory text"),
      text: "importance probe memory text",
      importance: "default",
      strength: 0.5,
      occurredAt: daysAgoIso(1),
      embedding: null,
    });

    const { row, correction } = store.setImportance({ id: "imp-1" }, "pinned", "promote", "ops");
    expect(row.importance).toBe("pinned");
    expect(row.strength).toBe(1);
    expect(correction.action).toBe("set_importance");
    expect(correction.actor).toBe("ops");

    expect(() => store.setImportance({ id: "imp-1" }, "pinned", "noop", "ops")).toThrow(
      /no-op/,
    );
    expect(store.listCorrections()).toHaveLength(1);
    store.close();
  });

  test("listMemories filters, searches and reports truncation; tenantStats counts", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    for (let i = 0; i < 5; i += 1) {
      store.insert({
        id: `mem-${i}`,
        bodyHash: sha256Hex(`probe memory number ${i} about zfs pools`),
        text: `probe memory number ${i} about zfs pools`,
        importance: i === 0 ? "pinned" : "default",
        strength: 0.5,
        occurredAt: daysAgoIso(i),
        embedding: null,
        source: "probe",
        sourceRef: `ref-${i}`,
      });
    }
    store.retract({ id: "mem-4" }, "old");

    const all = store.listMemories({ status: "all", limit: 200 });
    expect(all.rows).toHaveLength(5);
    expect(all.truncated).toBe(false);
    // most-recent-first
    expect(all.rows[0]!.id).toBe("mem-0");

    const pinned = store.listMemories({ importance: "pinned" });
    expect(pinned.rows.map((r) => r.id)).toEqual(["mem-0"]);

    const live = store.listMemories({ status: "live" });
    expect(live.rows.map((r) => r.id)).not.toContain("mem-4");
    const retracted = store.listMemories({ status: "retracted" });
    expect(retracted.rows.map((r) => r.id)).toEqual(["mem-4"]);

    const searched = store.listMemories({ status: "all", search: "zfs" });
    expect(searched.rows).toHaveLength(5);
    const none = store.listMemories({ search: "no-such-term" });
    expect(none.rows).toHaveLength(0);
    // LIKE metacharacters are literal, not wildcards
    const literal = store.listMemories({ search: "%" });
    expect(literal.rows).toHaveLength(0);

    const bySource = store.listMemories({ status: "all", source: "probe" });
    expect(bySource.rows).toHaveLength(5);

    const capped = store.listMemories({ limit: 3 });
    expect(capped.rows).toHaveLength(3);
    expect(capped.truncated).toBe(true);

    expect(store.listSources()).toEqual(["probe"]);

    const stats = store.tenantStats();
    expect(stats).toEqual({ total: 5, live: 4, retracted: 1, pinned: 1, nullEmbedding: 4 });
    store.close();
  });
});

describe("registry: embedder reuse for console-side corrections", () => {
  test("a correct() through the console sees the same embedder/registry state", () => {
    const dir = trackDir(makeTmpDir());
    const embedder = createEmbedder({ baseUrl: null, model: "nomic-embed-text", timeoutMs: 1000 });
    const registry = new TenantRegistry(dir, embedder, 0.05);
    const ctx = registry.get("alpha");
    expect(ctx.embedder).toBe(embedder);
    expect(registry.tenantNames()).toEqual(["alpha"]);
    expect(registry.opened()).toHaveLength(1);
  });
});
