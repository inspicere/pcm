import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redate } from "../tools/redate.ts";
import { sha256Hex, TenantStore } from "../src/store.ts";
import { makeTmpDir, trackDir } from "./helpers.ts";

const WALL = "2026-09-12T03:49:00.000Z";
const NEW_A = "2026-02-14T09:00:00.000Z";
const NEW_B = "2026-05-01T18:30:00.000Z";

function seed(dir: string): TenantStore {
  const store = new TenantStore(dir, "redate-test");
  const rows = [
    { text: "alpha memory about backups", source: "backfill", sourceRef: "item-001" },
    { text: "bravo memory about backups", source: "backfill", sourceRef: "item-001" },
    { text: "charlie memory manual ingest", source: "manual", sourceRef: "item-001" },
    { text: "delta memory different ref", source: "backfill", sourceRef: "other-003" },
    { text: "echo memory without refs", source: null, sourceRef: null },
  ];
  for (const row of rows) {
    store.insert({
      id: crypto.randomUUID(),
      bodyHash: sha256Hex(row.text),
      text: row.text,
      importance: "default",
      strength: 0.7,
      occurredAt: WALL,
      source: row.source ?? undefined,
      sourceRef: row.sourceRef ?? undefined,
    });
  }
  return store;
}

function reportLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("redate tool", () => {
  test("refuses to run without a scoping filter", () => {
    const store = seed(trackDir(makeTmpDir()));
    expect(() => redate(store, [{ sourceRef: "item-001", occurredAt: NEW_A }], { tenant: "redate-test" })).toThrow(
      /scop/i,
    );
  });

  test("dry-run changes nothing but reports the would-change rows", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const reportPath = join(dir, "dry-report.jsonl");
    const result = redate(
      store,
      [{ sourceRef: "item-001", occurredAt: NEW_A }],
      { tenant: "redate-test", source: "backfill", dryRun: true, reportPath },
    );

    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.rowsChanged).toBe(2);
    expect(result.invalid).toBe(0);
    // DB untouched
    for (const row of store.listNonPinned(true)) {
      expect(row.occurred_at).toBe(WALL);
    }
    // Report still written, flagged as a rehearsal
    const lines = reportLines(reportPath);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.dry_run).toBe(true);
      expect(line.old_occurred_at).toBe(WALL);
      expect(line.new_occurred_at).toBe(NEW_A);
    }
  });

  test("updates land only on matched in-scope rows", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const byText = new Map(store.listNonPinned(true).map((row) => [row.text, row]));
    const reportPath = join(dir, "apply-report.jsonl");

    const result = redate(
      store,
      [
        { sourceRef: "item-001", occurredAt: NEW_A },
        { sourceRef: "item-999", occurredAt: NEW_B },
      ],
      { tenant: "redate-test", source: "backfill", sourceRefPrefix: "item-", reportPath },
    );

    expect(result.matched).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.noMatch).toBe(1);
    expect(result.rowsChanged).toBe(2);
    expect(result.reportPath).toBe(reportPath);

    // Both backfill rows sharing source_ref item-001 moved...
    expect(store.getById(byText.get("alpha memory about backups")!.id)!.occurred_at).toBe(NEW_A);
    expect(store.getById(byText.get("bravo memory about backups")!.id)!.occurred_at).toBe(NEW_A);
    // ...but the manual-source row with the same source_ref, the out-of-prefix
    // row, and the NULL-source_ref row are untouched.
    expect(store.getById(byText.get("charlie memory manual ingest")!.id)!.occurred_at).toBe(WALL);
    expect(store.getById(byText.get("delta memory different ref")!.id)!.occurred_at).toBe(WALL);
    expect(store.getById(byText.get("echo memory without refs")!.id)!.occurred_at).toBe(WALL);
  });

  test("invalid entries are counted and skipped, valid ones still apply", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const result = redate(
      store,
      [
        { sourceRef: "item-001", occurredAt: "not-a-date" },
        { sourceRef: "item-001", occurredAt: NEW_A },
      ],
      { tenant: "redate-test", source: "backfill" },
    );

    expect(result.invalid).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.rowsChanged).toBe(2);
    const changed = store.listNonPinned(true).filter((row) => row.occurred_at === NEW_A);
    expect(changed.length).toBe(2);
  });

  test("future-dated entries are rejected by the 24h skew rule", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = redate(store, [{ sourceRef: "item-001", occurredAt: farFuture }], {
      tenant: "redate-test",
      source: "backfill",
    });

    expect(result.invalid).toBe(1);
    expect(result.rowsChanged).toBe(0);
    expect(store.listNonPinned(true).every((row) => row.occurred_at === WALL)).toBe(true);
  });

  test("report file records old/new occurred_at per changed row", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const byText = new Map(store.listNonPinned(true).map((row) => [row.text, row]));
    const reportPath = join(dir, "audit.jsonl");

    redate(store, [{ sourceRef: "item-001", occurredAt: NEW_A }], {
      tenant: "redate-test",
      source: "backfill",
      reportPath,
    });

    const lines = reportLines(reportPath);
    expect(lines.length).toBe(2);
    const ids = new Set(lines.map((line) => line.id));
    expect(ids.has(byText.get("alpha memory about backups")!.id)).toBe(true);
    expect(ids.has(byText.get("bravo memory about backups")!.id)).toBe(true);
    for (const line of lines) {
      expect(line.tenant).toBe("redate-test");
      expect(line.old_occurred_at).toBe(WALL);
      expect(line.new_occurred_at).toBe(NEW_A);
      expect(typeof line.body_hash).toBe("string");
      expect(line.source_ref).toBe("item-001");
      expect(line.dry_run).toBe(false);
    }
  });

  test("--limit caps total rows changed", () => {
    const dir = trackDir(makeTmpDir());
    const store = seed(dir);
    const result = redate(store, [{ sourceRef: "item-001", occurredAt: NEW_A }], {
      tenant: "redate-test",
      source: "backfill",
      limit: 1,
    });

    expect(result.rowsChanged).toBe(1);
    const atNew = store.listNonPinned(true).filter((row) => row.occurred_at === NEW_A);
    expect(atNew.length).toBe(1);
  });
});
