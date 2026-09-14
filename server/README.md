# pcm-server

MCP memory sidecar implementing PCM (Peripheral Cognitive Mesh) scoring: Ebbinghaus
decay with boost savings, pinned guardrails, and PAE slotting. Phase 1 of
`docs/specs/2026-09-11-pcm-memory-migration-design.md`.

> The scoring core is vendored from [anthonylee991/pcm](https://github.com/anthonylee991/pcm)
> @ `5dfb7ecc` (MIT) — see `vendor/pcm-core/` (only `src/core` + `src/schema`; no graph, no evals).

## Runtime

Bun + TypeScript (ESM). Storage is `bun:sqlite`, one DB file per tenant under
`<PCM_DATA_DIR>/<tenant>/memory.db` — physical tenant isolation, never a shared DB
with filters. Embeddings are optional: nomic-embed-text via Ollama, with an
automatic lexical fallback (token overlap) when Ollama is unreachable.

## Endpoints

- `GET /healthz` (no auth) →
  `{status, tenants, embedding: "ready"|"fallback", schemaVersion, pgvector: "ready"|"stale"|"disabled", pgvectorHost}`
- `POST /ingest` — `{text, source?, sourceRef?, occurredAt?}` with bearer auth →
  `{tenant, ingested, deduplicated}`. Plain-REST write path for the vault-watcher
  dual-write (services/vault-watcher): paragraph-splits the page into memory blocks
  sharing one `sourceRef`, same idempotency as `memvault_ingest`.
- `/mcp` — streamable-http MCP (stateless, JSON responses). Every request requires
  `Authorization: Bearer <token>`; unknown/missing token → `401`.

## Tools (exactly three — no delete/clear/list, per the Agent-Memory-Poisoning decision)

- `memvault_ingest` — `{text, importance?, occurredAt?, source?, sourceRef?}` →
  `{id, bodyHash, strength, decayedStrengthNow, deduplicated}`. Idempotent on
  `sha256(text)` per tenant. Invariant content or `importance="pinned"` auto-promotes
  to strength 1.0 pinned.
- `memvault_recall` — `{query, k?=5, includeStale?=false}` →
  `{slots, markdown, tokenEstimate, latencyMs}`. Pinned guardrails fill asker context
  (invariants always included, others top-3 by lexical relevance); situational context
  is ranked `retrievalScore × decayedStrength` (cosine when embeddings are ready, else
  token overlap; decayed strength < 0.05 dropped unless `includeStale`). Recalled rows
  get `boost_count++` (B savings effect).
- `memvault_session_wrap` — `{sessionId, turns, occurredAt?}` →
  `{sessionId, ingested, deduplicated}`. Paragraph-splits turns into ≤500-char items,
  skips <40-char noise, ingests each with `source="session"`, `sourceRef=sessionId`.

## pgvector (ANN recall)

The per-tenant SQLite stores are the source of truth — idempotent ingest
(sha256), importance/pinned, strength, boosts, occurred_at, embeddings as
float32 BLOBs. pgvector is purely a recall accelerator layered on top:

- **Write path** — after the embedder resolves, each ingested embedding is
  upserted into `embeddings_<tenant>` (one table per sanitized tenant name,
  `vector(N)` where N is the actual embedding length, plus an HNSW index with
  `vector_cosine_ops`). An index failure never fails ingest: it logs a warning
  and flips the in-memory status to `stale` (reported on `/healthz`).
- **Recall path** — when pgvector is reachable, the query embedding runs
  `embedding <=> $1` (cosine distance, top-50). Candidates are re-scored as
  `(1 - distance) × Ebbinghaus-decayed strength` with the same boost/stale
  rules as before. If fewer than `k` live candidates come back, the
  brute-force path tops up the shortlist — so rows with a NULL embedding (not
  yet indexed) are still reachable and recall never regresses.
- **Fallback** — with `PGVECTOR_DSN` unset or unreachable, everything works
  exactly as before: brute-force cosine over the sqlite embeddings, or the
  lexical fallback when Ollama is down. No postgres is needed to run or test.
- **Backfill** — populate the index from existing tenant DBs (non-destructive,
  rerunnable; prints per-tenant indexed/skipped/errors counts):

  ```sh
  PGVECTOR_DSN=postgres://pcm:PASS@pgvector:5432/pcm bun run backfill:pgvector
  ```

  Without a DSN it prints `disabled` and exits 0.

## Env

| Var | Default | Notes |
|---|---|---|
| `PCM_PORT` | `3600` | listen port |
| `PCM_HOST` | `0.0.0.0` | listen host |
| `PCM_TOKENS` | — | **required**, `name=TOKEN,name=TOKEN`; refuses to start without it |
| `PCM_DATA_DIR` | `/data/tenants` | per-tenant DB root |
| `OLLAMA_BASE_URL` | unset | e.g. `http://192.168.86.62:11434`; unset → lexical fallback |
| `PCM_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embeddings model |
| `PCM_DECAY_RATE` | `0.05` | Ebbinghaus λ |
| `PGVECTOR_DSN` | unset | e.g. `postgres://pcm:PASS@pgvector:5432/pcm`; unset → ANN disabled, sqlite fallback |

## Run

```sh
bun install
PCM_TOKENS="hermes=dev-token-hermes" OLLAMA_BASE_URL=http://192.168.86.62:11434 bun run src/index.ts
curl localhost:3600/healthz
```

## Test

```sh
bun test
```

Tests use a tmp `PCM_DATA_DIR` and test tokens; embedding fallback is exercised with
`OLLAMA_BASE_URL` unset.

## Docker

```sh
docker build -t pcm-server .
docker run -p 3600:3600 -v pcm-data:/data -e PCM_TOKENS="hermes=TOKEN1,claude=TOKEN2" pcm-server
```

The image creates `/data` owned by the non-root `bun` user; mount a volume there for
persistent per-tenant DBs.
