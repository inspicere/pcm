/**
 * Re-embed memories whose embedding is NULL (e.g. ingested while the
 * embedding backend was unreachable). Fills SQLite only; sync the ANN index
 * afterwards with `bun run backfill:pgvector`. Idempotent; safe to re-run.
 *
 *   bun run tools/re-embed.ts
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createEmbedder } from "../src/embedder.ts";

const DATA_DIR = process.env.PCM_DATA_DIR ?? "/data/tenants";
const BATCH = 500;

async function main() {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || null;
  if (!baseUrl) {
    console.log("re-embed: OLLAMA_BASE_URL unset, nothing to do");
    process.exit(0);
  }
  const embedder = createEmbedder({
    baseUrl,
    apiKey: process.env.OLLAMA_TOKEN?.trim() || null,
    model: process.env.PCM_EMBEDDING_MODEL ?? "nomic-embed-text",
    timeoutMs: 10000,
  });

  for (const tenant of readdirSync(DATA_DIR)) {
    const dbPath = join(DATA_DIR, tenant, "memory.db");
    if (!statSync(join(DATA_DIR, tenant)).isDirectory() || !existsSync(dbPath)) continue;
    const db = new Database(dbPath);
    let done = 0;
    let failed = 0;
    let emptyBatches = 0;
    for (;;) {
      const rows = db
        .prepare("SELECT id, text, body_hash FROM memories WHERE embedding IS NULL ORDER BY created_at LIMIT ?")
        .all(BATCH) as Array<{ id: string; text: string; body_hash: string }>;
      if (rows.length === 0) break;
      let batchDone = 0;
      for (const row of rows) {
        try {
          const embedding = await embedder.embed(row.text);
          if (!embedding) {
            failed++;
            continue;
          }
          db.prepare("UPDATE memories SET embedding = ?, dims = ? WHERE id = ?").run(
            new Uint8Array(embedding.buffer.slice(0)),
            embedding.length,
            row.id,
          );
          done++;
          batchDone++;
        } catch {
          failed++;
        }
      }
      process.stdout.write(`\r${tenant}: embedded=${done} failed=${failed}`);
      // A fully-failed batch means the backend is down; stop instead of
      // re-selecting the same NULL rows forever.
      if (batchDone === 0) {
        if (++emptyBatches >= 2) {
          console.log(`\n${tenant}: embedding backend unavailable, stopping`);
          break;
        }
      } else {
        emptyBatches = 0;
      }
    }
    console.log();
    db.close();
  }
  console.log("re-embed done (mode was", embedder.mode + ")");
}

main().catch((err) => {
  console.error("re-embed failed:", err);
  process.exit(1);
});
