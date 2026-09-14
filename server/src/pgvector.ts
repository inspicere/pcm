import postgres from "postgres";

export type PgvectorStatus = "ready" | "stale" | "disabled";

export interface AnnCandidate {
  memoryId: string;
  distance: number;
}

export interface AnnIndex {
  readonly status: PgvectorStatus;
  readonly host: string | null;
  ping(): Promise<boolean>;
  upsert(
    tenant: string,
    memoryId: string,
    bodyHash: string,
    embedding: Float32Array,
  ): Promise<void>;
  search(tenant: string, query: Float32Array, limit: number): Promise<AnnCandidate[]>;
}

const TABLE_PREFIX = "embeddings_";

export function sanitizeTenantName(tenant: string): string {
  const normalized = tenant.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (normalized.length === 0) {
    throw new Error(`tenant name "${tenant}" cannot be mapped to a pgvector table`);
  }
  return normalized;
}

function tableFor(tenant: string): string {
  return TABLE_PREFIX + sanitizeTenantName(tenant);
}

function vectorLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

interface PgRow {
  memory_id: string;
  distance: number;
}

export class PgvectorIndex implements AnnIndex {
  private readonly sql: postgres.Sql;
  private stale = false;
  private ensured = new Set<string>();

  constructor(private readonly dsn: string) {
    this.sql = postgres(dsn, { max: 2 });
  }

  get status(): PgvectorStatus {
    return this.stale ? "stale" : "ready";
  }

  get host(): string | null {
    try {
      return new URL(this.dsn).hostname;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`;
      // The extension lives per-database; POSTGRES_DB=pcm does not get it
      // from the image init scripts. pcm is the container superuser.
      await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      this.stale = false;
      return true;
    } catch (err) {
      this.stale = true;
      console.warn(`pgvector ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async ensureTenant(tenant: string, dims: number): Promise<string> {
    const table = tableFor(tenant);
    if (this.ensured.has(table)) return table;
    await this.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (
         memory_id TEXT PRIMARY KEY,
         body_hash TEXT NOT NULL,
         embedding vector(${dims})
       )`,
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS ${table}_hnsw ON ${table} USING hnsw (embedding vector_cosine_ops)`,
    );
    this.ensured.add(table);
    return table;
  }

  async upsert(
    tenant: string,
    memoryId: string,
    bodyHash: string,
    embedding: Float32Array,
  ): Promise<void> {
    const table = await this.ensureTenant(tenant, embedding.length);
    await this.sql.unsafe(
      `INSERT INTO ${table} (memory_id, body_hash, embedding)
       VALUES ($1, $2, $3::vector)
       ON CONFLICT (memory_id) DO UPDATE SET
         body_hash = EXCLUDED.body_hash,
         embedding = EXCLUDED.embedding`,
      [memoryId, bodyHash, vectorLiteral(embedding)],
    );
    this.stale = false;
  }

  async search(tenant: string, query: Float32Array, limit: number): Promise<AnnCandidate[]> {
    const table = tableFor(tenant);
    let rows: PgRow[];
    try {
      rows = await this.sql.unsafe(
        `SELECT memory_id, embedding <=> $1::vector AS distance
         FROM ${table}
         ORDER BY embedding <=> $1
         LIMIT $2`,
        [vectorLiteral(query), limit],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") {
        // Tenant table not created yet (nothing upserted) — empty index, not an outage.
        return [];
      }
      throw err;
    }
    this.stale = false;
    return rows.map((row) => ({ memoryId: row.memory_id, distance: Number(row.distance) }));
  }
}

export function createPgvectorIndex(dsn: string | null | undefined): PgvectorIndex | null {
  const trimmed = dsn?.trim();
  if (!trimmed) return null;
  return new PgvectorIndex(trimmed);
}
