import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPgvectorIndex } from "../src/pgvector.ts";
import { toFloat32 } from "../src/scoring.ts";

interface BackfillRow {
  id: string;
  body_hash: string;
  embedding: Uint8Array | null;
  dims: number | null;
}

async function main(): Promise<void> {
  const dsn = process.env.PGVECTOR_DSN?.trim();
  if (!dsn) {
    console.log("pgvector backfill: disabled (PGVECTOR_DSN unset)");
    return;
  }
  const dataDir = process.env.PCM_DATA_DIR ?? "/data/tenants";
  const index = createPgvectorIndex(dsn);
  if (!(await index!.ping())) {
    console.error("pgvector backfill: cannot reach postgres; aborting (rerun once pgvector is healthy)");
    process.exit(1);
  }

  const tenants = readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const tenant of tenants) {
    const dbPath = join(dataDir, tenant, "memory.db");
    if (!existsSync(dbPath)) {
      console.log(`${tenant}: no memory.db, skipped`);
      continue;
    }
    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT id, body_hash, embedding, dims FROM memories WHERE embedding IS NOT NULL")
      .all() as unknown as BackfillRow[];
    let indexed = 0;
    let skipped = 0;
    let errors = 0;
    for (const row of rows) {
      const embedding = toFloat32(row.embedding);
      if (!embedding || embedding.length === 0 || (row.dims !== null && row.dims !== embedding.length)) {
        skipped += 1;
        continue;
      }
      try {
        await index!.upsert(tenant, row.id, row.body_hash, embedding);
        indexed += 1;
      } catch (err) {
        errors += 1;
        console.warn(`${tenant}: upsert ${row.id} failed: ${(err as Error).message}`);
      }
    }
    db.close();
    console.log(`${tenant}: indexed=${indexed} skipped=${skipped} errors=${errors}`);
  }
}

await main();
