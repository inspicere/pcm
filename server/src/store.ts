import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Version of a freshly created database (the original v1 schema).
 */
export const BASELINE_SCHEMA_VERSION = 1;

export interface SchemaMigration {
  /** Schema version after this migration applies. Must be sequential. */
  readonly version: number;
  readonly name: string;
  apply(db: Database): void;
}

/**
 * Ordered, sequential migrations. Empty today; later branches append here
 * (corrections v2, etc.). The code refuses to open a database newer than
 * SCHEMA_VERSION, and refuses a gap in the sequence, rather than guessing.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [];

export const SCHEMA_VERSION = SCHEMA_MIGRATIONS.length
  ? SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]!.version
  : BASELINE_SCHEMA_VERSION;

export type Importance = "pinned" | "high" | "default";

export interface MemoryRow {
  id: string;
  body_hash: string;
  text: string;
  importance: Importance;
  strength: number;
  boost_count: number;
  occurred_at: string;
  embedding: Uint8Array | null;
  dims: number | null;
  source: string | null;
  source_ref: string | null;
  created_at: string;
}

export interface InsertMemoryInput {
  id: string;
  bodyHash: string;
  text: string;
  importance: Importance;
  strength: number;
  occurredAt: string;
  embedding: Float32Array | null;
  source?: string;
  sourceRef?: string;
}

const MEMORIES_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance IN ('pinned', 'high', 'default')),
  strength REAL NOT NULL,
  boost_count INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  embedding BLOB,
  dims INTEGER,
  source TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance);
CREATE INDEX IF NOT EXISTS idx_memories_occurred_at ON memories (occurred_at);
`;

const META_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class TenantStore {
  readonly tenant: string;
  readonly db: Database;
  private readonly storedVersion: number;

  constructor(dataDir: string, tenant: string, migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS) {
    this.tenant = tenant;
    const dir = join(dataDir, tenant);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "memory.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(MEMORIES_DDL);
    this.db.exec(META_DDL);
    this.storedVersion = this.runMigrations(migrations);
  }

  /**
   * Applies pending migrations in order, each in its own transaction, and
   * returns the resulting stored version. Fails loudly: a stored version
   * newer than the code, a non-sequential migration list, a corrupt version
   * string, or a failing migration all throw — the store refuses to open
   * rather than run against an unknown schema.
   */
  private runMigrations(migrations: readonly SchemaMigration[]): number {
    const existing = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (!existing) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(BASELINE_SCHEMA_VERSION));
    }

    const raw = existing?.value ?? String(BASELINE_SCHEMA_VERSION);
    let current = Number.parseInt(raw, 10);
    if (!Number.isInteger(current) || current < 1) {
      throw new Error(`tenant ${this.tenant}: corrupt schema_version '${raw}' in meta`);
    }
    // "Code" for this open is the baseline plus the migrations in force: the
    // target is the last declared version, not the build-wide constant (which
    // only reflects the default production list).
    const target = migrations.length
      ? migrations[migrations.length - 1]!.version
      : BASELINE_SCHEMA_VERSION;
    if (current > target) {
      throw new Error(
        `tenant ${this.tenant}: database schema v${current} is newer than this code supports (v${target}); upgrade pcm-server`,
      );
    }

    for (const migration of migrations) {
      if (migration.version <= current) continue;
      if (migration.version !== current + 1) {
        throw new Error(
          `tenant ${this.tenant}: migration gap (at v${current}, next declared is v${migration.version} '${migration.name}')`,
        );
      }
      const apply = this.db.transaction(() => {
        migration.apply(this.db);
        this.db
          .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
          .run(String(migration.version));
      });
      apply();
      current = migration.version;
    }

    return current;
  }

  /** Schema version actually stored in this tenant's database. */
  storedSchemaVersion(): number {
    return this.storedVersion;
  }

  getByHash(bodyHash: string): MemoryRow | null {
    return (
      this.db.prepare("SELECT * FROM memories WHERE body_hash = ?").get(bodyHash) ?? null
    ) as MemoryRow | null;
  }

  insert(input: InsertMemoryInput): MemoryRow {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, body_hash, text, importance, strength, boost_count, occurred_at, embedding, dims, source, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.bodyHash,
        input.text,
        input.importance,
        input.strength,
        input.occurredAt,
        input.embedding ? new Uint8Array(input.embedding.buffer.slice(0)) : null,
        input.embedding ? input.embedding.length : null,
        input.source ?? null,
        input.sourceRef ?? null,
        new Date().toISOString(),
      );
    return this.getByHash(input.bodyHash)!;
  }

  updateEmbedding(id: string, embedding: Float32Array): void {
    this.db
      .prepare("UPDATE memories SET embedding = ?, dims = ? WHERE id = ?")
      .run(new Uint8Array(embedding.buffer.slice(0)), embedding.length, id);
  }

  rowsMissingEmbedding(limit = 500): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE embedding IS NULL ORDER BY created_at LIMIT ?")
      .all(limit) as unknown as MemoryRow[];
  }

  getByIds(ids: string[]): MemoryRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[];
  }

  listPinned(): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE importance = 'pinned'")
      .all() as unknown as MemoryRow[];
  }

  listNonPinned(): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE importance != 'pinned'")
      .all() as unknown as MemoryRow[];
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    return row.n;
  }

  incrementBoost(id: string): void {
    this.db.prepare("UPDATE memories SET boost_count = boost_count + 1 WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
