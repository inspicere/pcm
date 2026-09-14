import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getInitialStrength } from "../../src/index.ts";

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
 * Ordered, sequential migrations. The code refuses to open a database newer
 * than SCHEMA_VERSION, and refuses a gap in the sequence, rather than guessing.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 2,
    name: "corrections",
    apply(db) {
      // Guarded DDL: fresh databases run the baseline CREATE TABLE first, and
      // reopening an already-migrated store must not re-ADD columns.
      const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      const hasColumn = (name: string) => cols.some((c) => c.name === name);
      if (!hasColumn("retracted_at")) {
        db.exec("ALTER TABLE memories ADD COLUMN retracted_at TEXT");
      }
      if (!hasColumn("superseded_by")) {
        db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
      }
      // Append-only audit log of every correction action. No update/delete
      // methods are ever provided for this table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS corrections (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          new_hash TEXT,
          reason TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      // Operator denylist: hashes purged by sanitize() stay blocked forever so
      // the purged text can never be re-ingested (D1 purge regime).
      db.exec(`
        CREATE TABLE IF NOT EXISTS purged_hashes (
          body_hash TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const SCHEMA_VERSION = SCHEMA_MIGRATIONS.length
  ? SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]!.version
  : BASELINE_SCHEMA_VERSION;

export type Importance = "pinned" | "high" | "default";

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

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
  /** NULL = live. Set (to the retraction timestamp) for retract/correct. */
  retracted_at: string | null;
  /** For replacement rows: body_hash of the memory this one corrects. */
  superseded_by: string | null;
}

export interface CorrectionRow {
  seq: number;
  action: string;
  body_hash: string;
  new_hash: string | null;
  reason: string;
  occurred_at: string;
  created_at: string;
}

/** Exactly one of id / bodyHash must be set. */
export interface CorrectionTarget {
  id?: string;
  bodyHash?: string;
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
  /** Set only by correct(): body_hash of the memory this row replaces. */
  supersedes?: string;
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

  /** Unfiltered lookup by primary key; retracted rows are still rows (soft delete). */
  getById(id: string): MemoryRow | null {
    return (this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) ?? null) as MemoryRow | null;
  }

  /** True if this hash was purged via sanitize(); such text must never re-ingest. */
  isDenied(bodyHash: string): boolean {
    return this.deniedReason(bodyHash) !== null;
  }

  /** Purge reason for a denied hash, or null. Internal companion to isDenied. */
  deniedReason(bodyHash: string): string | null {
    const row = this.db
      .prepare("SELECT reason FROM purged_hashes WHERE body_hash = ?")
      .get(bodyHash) as { reason: string } | undefined;
    return row?.reason ?? null;
  }

  /** Idempotent: re-denying a hash keeps the original row (and its reason). */
  denyHash(bodyHash: string, reason: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO purged_hashes (body_hash, reason, created_at) VALUES (?, ?, ?)",
      )
      .run(bodyHash, reason, new Date().toISOString());
  }

  /** Appends one row to the append-only corrections log. Internal use. */
  appendCorrection(
    action: string,
    bodyHash: string,
    newHash: string | null,
    reason: string,
    occurredAt: string,
  ): CorrectionRow {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO corrections (action, body_hash, new_hash, reason, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(action, bodyHash, newHash, reason, occurredAt, createdAt);
    return {
      seq: Number(info.lastInsertRowid),
      action,
      body_hash: bodyHash,
      new_hash: newHash,
      reason,
      occurred_at: occurredAt,
      created_at: createdAt,
    };
  }

  /** Most recent correction events first. Read-only; the log is append-only. */
  listCorrections(limit = 100): CorrectionRow[] {
    return this.db
      .prepare("SELECT * FROM corrections ORDER BY seq DESC LIMIT ?")
      .all(limit) as unknown as CorrectionRow[];
  }

  private resolveTarget(target: CorrectionTarget): MemoryRow {
    const hasId = Boolean(target.id);
    const hasHash = Boolean(target.bodyHash);
    if (hasId === hasHash) {
      throw new Error("exactly one of target.id / target.bodyHash is required");
    }
    const row = target.id ? this.getById(target.id!) : this.getByHash(target.bodyHash!);
    if (!row) {
      throw new Error(
        `memory not found (${target.id ? `id=${target.id}` : `bodyHash=${target.bodyHash}`})`,
      );
    }
    return row;
  }

  /**
   * Soft-deletes a memory: excluded from all recall read paths, but the row
   * stays so re-ingesting the same text still deduplicates (D1). Idempotent:
   * an already-retracted target returns without writing a second audit row.
   */
  retract(
    target: CorrectionTarget,
    reason: string,
    occurredAt?: string,
  ): { row: MemoryRow; correction: CorrectionRow | null } {
    const row = this.resolveTarget(target);
    if (row.retracted_at !== null) {
      return { row, correction: null };
    }
    const ts = occurredAt ?? new Date().toISOString();
    const apply = this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET retracted_at = ? WHERE id = ?").run(ts, row.id);
      return this.appendCorrection("retract", row.body_hash, null, reason, ts);
    });
    const correction = apply();
    return { row: this.getById(row.id)!, correction };
  }

  /** Inverse of retract; restores recall visibility. No-op when not retracted. */
  unretract(
    target: CorrectionTarget,
    reason: string,
    occurredAt?: string,
  ): { row: MemoryRow; correction: CorrectionRow | null } {
    const row = this.resolveTarget(target);
    if (row.retracted_at === null) {
      return { row, correction: null };
    }
    const ts = occurredAt ?? new Date().toISOString();
    const apply = this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET retracted_at = NULL WHERE id = ?").run(row.id);
      return this.appendCorrection("unretract", row.body_hash, null, reason, ts);
    });
    const correction = apply();
    return { row: this.getById(row.id)!, correction };
  }

  /**
   * Transactionally replaces a memory: the target is retracted (audit action
   * 'correct' carrying both hashes) and a new live row is inserted with
   * superseded_by linkage. The replacement takes the caller-specified
   * importance (never inheriting the target's) and defaults to "high" (D4).
   * Self-correction (identical text) and collisions with an existing hash are
   * rejected before anything is written.
   */
  correct(
    target: CorrectionTarget,
    newText: string,
    reason: string,
    importance: Importance = "high",
    occurredAt?: string,
  ): { oldRow: MemoryRow; newRow: MemoryRow; correction: CorrectionRow } {
    const oldRow = this.resolveTarget(target);
    const text = newText.trim();
    if (text.length === 0) {
      throw new Error("correct(): newText cannot be empty");
    }
    const newHash = sha256Hex(text);
    if (newHash === oldRow.body_hash) {
      throw new Error("correct(): newText is identical to the target memory (self-correct)");
    }
    if (this.getByHash(newHash)) {
      throw new Error("correct(): a memory with newText already exists");
    }
    const ts = occurredAt ?? new Date().toISOString();
    const apply = this.db.transaction(() => {
      const correction = this.appendCorrection("correct", oldRow.body_hash, newHash, reason, ts);
      this.db.prepare("UPDATE memories SET retracted_at = ? WHERE id = ?").run(ts, oldRow.id);
      const newRow = this.insert({
        id: crypto.randomUUID(),
        bodyHash: newHash,
        text,
        importance,
        strength: getInitialStrength(importance),
        occurredAt: ts,
        embedding: null,
        source: oldRow.source ?? undefined,
        sourceRef: oldRow.source_ref ?? undefined,
        supersedes: oldRow.body_hash,
      });
      return { correction, newRow };
    });
    const { correction, newRow } = apply();
    return { oldRow: this.getById(oldRow.id)!, newRow, correction };
  }

  /**
   * Operator-only hard purge (never exposed as an agent tool). Deliberately
   * NOT one transaction: the denylist row lands first so that even if the
   * delete fails or the process dies mid-run, the hash stays blocked and the
   * operation is re-runnable (D1 purge regime).
   */
  sanitize(
    target: CorrectionTarget,
    reason: string,
    occurredAt?: string,
  ): { row: MemoryRow; correction: CorrectionRow } {
    const row = this.resolveTarget(target);
    const ts = occurredAt ?? new Date().toISOString();
    this.denyHash(row.body_hash, reason);
    const correction = this.appendCorrection("purge", row.body_hash, null, reason, ts);
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
    return { row, correction };
  }

  insert(input: InsertMemoryInput): MemoryRow {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, body_hash, text, importance, strength, boost_count, occurred_at, embedding, dims, source, source_ref, created_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.supersedes ?? null,
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
      .prepare(
        "SELECT * FROM memories WHERE embedding IS NULL AND retracted_at IS NULL ORDER BY created_at LIMIT ?",
      )
      .all(limit) as unknown as MemoryRow[];
  }

  getByIds(ids: string[], includeRetracted = false): MemoryRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const retractedClause = includeRetracted ? "" : " AND retracted_at IS NULL";
    return this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})${retractedClause}`)
      .all(...ids) as unknown as MemoryRow[];
  }

  listPinned(includeRetracted = false): MemoryRow[] {
    const retractedClause = includeRetracted ? "" : " AND retracted_at IS NULL";
    return this.db
      .prepare(`SELECT * FROM memories WHERE importance = 'pinned'${retractedClause}`)
      .all() as unknown as MemoryRow[];
  }

  listNonPinned(includeRetracted = false): MemoryRow[] {
    const retractedClause = includeRetracted ? "" : " AND retracted_at IS NULL";
    return this.db
      .prepare(`SELECT * FROM memories WHERE importance != 'pinned'${retractedClause}`)
      .all() as unknown as MemoryRow[];
  }

  /** Total row count, including retracted ones (retraction is a soft delete). */
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
