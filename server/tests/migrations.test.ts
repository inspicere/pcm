import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  BASELINE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  TenantStore,
  type SchemaMigration,
} from "../src/store.ts";
import { makeTmpDir, trackDir } from "./helpers.ts";

function migrations(...defs: Array<{ version: number; name: string; apply: (db: Database) => void }>) {
  return defs satisfies SchemaMigration[];
}

describe("schema migration runner", () => {
  test("fresh store starts at the current schema version", () => {
    const store = new TenantStore(trackDir(makeTmpDir()), "alpha");
    expect(store.storedSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(BASELINE_SCHEMA_VERSION);
    store.close();
  });

  test("reopening an existing store applies nothing and stays at the stored version", () => {
    const dir = trackDir(makeTmpDir());
    const first = new TenantStore(dir, "alpha");
    first.close();
    const second = new TenantStore(dir, "alpha", [
      ...SCHEMA_MIGRATIONS,
      {
        version: SCHEMA_VERSION + 1,
        name: "test-only",
        apply: (db) => db.exec("ALTER TABLE memories ADD COLUMN test_marker TEXT"),
      },
    ]);
    expect(second.storedSchemaVersion()).toBe(SCHEMA_VERSION + 1);
    const cols = second.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "test_marker")).toBe(true);
    second.close();
    // idempotent: reopening with the same migrations does not reapply or advance
    const third = new TenantStore(dir, "alpha", [
      {
        version: SCHEMA_VERSION + 1,
        name: "test-only",
        apply: () => {
          throw new Error("must not reapply");
        },
      },
    ]);
    expect(third.storedSchemaVersion()).toBe(SCHEMA_VERSION + 1);
    third.close();
  });

  test("migrations apply in order, each exactly once", () => {
    const applied: string[] = [];
    const list = migrations(
      {
        version: SCHEMA_VERSION + 1,
        name: "first",
        apply: () => {
          applied.push("first");
        },
      },
      {
        version: SCHEMA_VERSION + 2,
        name: "second",
        apply: () => {
          applied.push("second");
        },
      },
    );
    const store = new TenantStore(trackDir(makeTmpDir()), "alpha", [...SCHEMA_MIGRATIONS, ...list]);
    expect(applied).toEqual(["first", "second"]);
    expect(store.storedSchemaVersion()).toBe(SCHEMA_VERSION + 2);
    store.close();
  });

  test("a failing migration rolls back its own step and stops the sequence", () => {
    const dir = trackDir(makeTmpDir());
    const ok = new TenantStore(dir, "alpha");
    ok.close();

    const failing = migrations(
      {
        version: SCHEMA_VERSION + 1,
        name: "adds-column",
        apply: (db) => db.exec("ALTER TABLE memories ADD COLUMN committed_step TEXT"),
      },
      {
        version: SCHEMA_VERSION + 2,
        name: "explodes",
        apply: () => {
          throw new Error("boom");
        },
      },
    );
    expect(() => new TenantStore(dir, "alpha", failing)).toThrow("boom");

    // the earlier step committed atomically; the failed step left no trace
    const reopened = new TenantStore(dir, "alpha", [
      {
        version: SCHEMA_VERSION + 1,
        name: "adds-column",
        apply: () => {},
      },
    ]);
    expect(reopened.storedSchemaVersion()).toBe(SCHEMA_VERSION + 1);
    const cols = reopened.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "committed_step")).toBe(true);
    reopened.close();

    // and a code line without that migration still refuses to open the newer schema
    expect(() => new TenantStore(dir, "alpha")).toThrow(/newer than this code supports/);
  });

  test("a store newer than the code refuses to open", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    store.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    store.close();

    expect(() => new TenantStore(dir, "alpha")).toThrow(/newer than this code supports/);
  });

  test("a gap in the migration sequence refuses to run", () => {
    const gapped = migrations({
      version: SCHEMA_VERSION + 2,
      name: "skips-ahead",
      apply: () => {},
    });
    expect(() => new TenantStore(trackDir(makeTmpDir()), "alpha", gapped)).toThrow(/migration gap/);
  });

  test("a corrupt version string refuses to open", () => {
    const dir = trackDir(makeTmpDir());
    const store = new TenantStore(dir, "alpha");
    store.db.prepare("UPDATE meta SET value = 'banana' WHERE key = 'schema_version'").run();
    store.close();

    expect(() => new TenantStore(dir, "alpha")).toThrow(/corrupt schema_version/);
  });

  test("each tenant migrates independently", () => {
    const dir = trackDir(makeTmpDir());
    const withMigration = migrations({
      version: SCHEMA_VERSION + 1,
      name: "tenant-specific",
      apply: (db) => db.exec("ALTER TABLE memories ADD COLUMN tenant_marker TEXT"),
    });

    const alpha = new TenantStore(dir, "alpha", [...SCHEMA_MIGRATIONS, ...withMigration]);
    const beta = new TenantStore(dir, "beta");
    expect(alpha.storedSchemaVersion()).toBe(SCHEMA_VERSION + 1);
    expect(beta.storedSchemaVersion()).toBe(SCHEMA_VERSION);
    alpha.close();
    beta.close();
  });
});
