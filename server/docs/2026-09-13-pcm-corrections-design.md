# PCM Corrections — Methodology Assessment

- **Date:** 2026-09-13, refined 2026-09-14 (M2-vs-M4 verdict + operator tools; operator web console + purged-hash denylist)
- **Status:** Draft v3 — recommendation: **M2b at runtime (with denylist), M1 as operator console + CLI, M4 deferred**; awaiting go-ahead
- **Related:** `docs/specs/2026-09-11-pcm-memory-migration-design.md` (v1 gap: "PCM has no delete"), `1-Projects/Laima/Security/Agent-Memory-Poisoning.md` (L1), Vikunja #2161
- **Reverses (partially):** the deliberate "no delete/clear, per Agent-Memory-Poisoning decision" taken at pcm-server v1 build time. That decision removed the *unaccountable* deletion capability; this design adds *accountable* correction plus *operator-gated* physical erasure. The reversal should be recorded in `.titan/DECISIONS.md` once implemented.

## 1. Problem

PCM is append-only. Every write path (`memvault_ingest`, `memvault_session_wrap`, REST `/ingest`) dedups on `sha256(text)` and inserts; nothing ever updates or removes. Three drivers make that a liability rather than a hygiene choice:

1. **Security — poisoning is irreversible.** Any MetaMCP client bound to a namespace holding a PCM tenant token can write into that tenant's vault (L1, CRITICAL, still open). For `importance=default` memories this self-heals via Ebbinghaus decay (strength fades below the 0.05 stale threshold). For `pinned` memories it does not: pinned rows always surface in asker context, never decay out, and every recall boosts them (`boost_count++`). A poisoned pinned memory is permanent today.
2. **Edit/delete parity with the vault dual-write.** `services/vault-watcher/` POSTs redacted page bodies to PCM `/ingest`. When a vault page is later edited or deleted, graphiti is updated but PCM accumulates the stale text forever. Recall quality degrades monotonically.
3. **Operator curation requires visibility.** Today the only window into a tenant's memory is `memvault_recall` — ranked, k-limited, and boost-mutating. There is no browse/search/list, no view of the pinned set, no way to change importance after ingest, and no audit trail. Managing pins, reviewing what the vault believes, and sanitizing poison all need a human-facing surface. An operator web console is the delivery vehicle for every capability in this design (sanitize, retract/correct, pin curation, denylist, audit review) — one surface instead of N CLI tools.

**A fourth scenario sharpened the design on 2026-09-14:** poisoned content that *is itself a secret* — a credential, API key, or PII ingested into the vault. Tombstone-based correction excludes it from recall but the bytes stay on disk. Sanitization must therefore also arm an **upfront filter**: the poisoned text's hash goes into a denylist so no ingest path can ever reintroduce it.

## 2. Hard constraints from the current implementation

- Schema v1, per-tenant SQLite (`/data/tenants/<tenant>/memory.db`, WAL). `memories` has no `updatedance` flags, or status column. No migration framework — schema is `CREATE IF NOT EXISTS` plus `meta.schema_version`.
- Recall has **two paths that both must exclude corrections**: pgvector ANN (`embeddings_<tenant>` keyed by `memory_id`, no delete method exists) and brute-force over `listPinned()`/`listNonPinned()`. Note the ANN path re-fetches rows from SQLite via `getByIds()` before scoring, so filtering at the SQLite query layer automatically covers both paths.
- Dedup is exact-text. A "corrected" memory is by construction a *new row with a new hash*; naive re-ingest leaves old and new side by side.
- Vendor `resolveSupersededContext` is fixture-shaped (hardcoded strings, per the 2026-09-11 OSS reality check) — supersession must be implemented in our server layer, not delegated to pcm-core.
- `PinnedGuardrailsCache` is constructed per tenant but currently unused on the recall path. If it is ever wired in, corrections need an invalidation hook.
- Identity model: bearer token → tenant. No per-client identity within a tenant, so agent-side audit rows record tenant + source but not "which agent". Operator actions authenticate as named operators (§4), closing that gap for human actions.
- Graphiti holds an independent copy of much of the same content (dual-write). A PCM-side correction does not propagate; split-brain recall is possible if left unaddressed.
- Operator-script precedent exists: `services/pcm-server/tools/re-embed.ts` and `tools/backfill-pgvector.ts` run host-side against the same stores.
- **New (2026-09-14):** the operator console must not widen the MCP/tenant attack surface — separate listener port, separate auth namespace from tenant bearer tokens, network-scoped (ZBF) to operator VLANs.
- The purged-hash denylist must be checked on **every** ingest path *before* the dedup lookup: post-purge, the row (and its dedup gate) is gone, so the denylist is the only guard.

## 3. Methodologies assessed

### M1 — Hard delete

`DELETE FROM memories WHERE id/body_hash = ?`, plus a new `delete()` on the pgvector index.

- **Pros:** simplest possible change; memory is actually gone; recall paths need almost no modification (rows absent); bounded storage; the only mechanism that satisfies "these bytes must not exist on disk".
- **Cons as an agent-facing tool:** irreversible; destroys evidence — for a poisoning incident you lose the artifact and the record of what was removed and why; re-ingest of the same text silently succeeds again (the dedup gate is gone with the row); and it hands every MCP client permanent unauditable erasure. The v1 "no delete" decision rejected exactly this.
- **Kept in the design as an operator-only capability** (§4): web console (primary, human) + CLI script (automation/emergency). Neither is exposed over MCP. The reframing answers both objections: the audit objection is met by writing a purge record (hash + reason, never the text) and a denylist entry *before* deleting, and the capability objection is met by keeping it out of MetaMCP entirely. Operator accountability rides on named operator tokens + the host's sudo/journald layer.

### M2 — Tombstone + supersede (retract / correct)

Mark rows retracted (or superseded-by a newer row); exclude them at the store query layer; keep the original plus an append-only audit record. Two sub-variants:

- **M2a — column flags:** `ALTER TABLE memories ADD COLUMN retracted_at TEXT, superseded_by TEXT`. Recall filters `retracted_at IS NULL` in `listPinned`/`listNonPinned`/`getByIds`; `rowsMissingEmbedding` skips retracted rows so backfill doesn't waste embeds.
- **M2b — flags + correction event log:** M2a plus an append-only `corrections(tenant, action, body_hash, new_hash, reason, occurred_at)` table recording every retract/correct/unretract/purge/deny. Row state stays materialized in flags (O(1) reads); the log exists for audit. Identical read-side behavior to M2a; strictly better forensics.

Both variants share: `memvault_retract {text | id, reason}` and `memvault_correct {oldText | oldId, newText, reason, importance?}` (atomic retract + ingest, linked by `superseded_by`). Reversible (`unretract` clears the flag — itself audited). Physical purge is operator-only (§4).

- **Pros:** read paths (both ANN and brute-force) inherit the exclusion from one place in the store layer; audit trail is native (directly serves the security audit and any poisoning post-mortem); distinguishes false from outdated; un-retractable mistakes are impossible; supersedes chains (`A → B → C`) give provenance.
- **Cons:** schema migration (v1→v2, first real migration — needs a guarded `ALTER TABLE` + `schema_version` bump); pgvector accumulates dangling ids (mitigated: ANN candidates are re-validated against SQLite, so dangling ids are inert — the operator sweep reclaims them); tombstones retain the retracted text on disk until purged (accepted: that is precisely what operator sanitize is for); one more write capability to reason about in the threat model (see M5).

### M3 — Counter-memory injection

Ingest a high-importance corrective statement ("CORRECTION: X is wrong, actually Y") and rely on ranking/decay to prefer it. Zero schema change; works today.

- **Cons:** both the poison and the correction surface on recall; the model must arbitrate a contradiction it can only see if both rows are returned; the B savings effect boosts *both* rows on every recall, entrenching the contradiction; and it flatly fails for pinned poison — a counter-memory cannot un-pin anything. Rejected as a primary mechanism; acceptable as a stopgap only for non-pinned drift.

### M4 — Full event sourcing (reassessed head-to-head vs M2)

All state as a fold of an append-only event log (`Ingested`, `Retracted`, `Superseded`, `Purged`); `memories` becomes a rebuildable projection. The strongest honest case for M4: one uniform mechanism — deletes, edits, and corrections are all just events; the audit trail and the runtime state are the same object, so they can never disagree; every state is reproducible.

Against, concretely for this codebase:

1. **The only read consumer wants current belief state.** Event sourcing earns its complexity when consumers need temporal queries ("what did the vault believe on date X?") or heterogeneous projections. PCM has one consumer — recall — and it always wants *now*.
2. **M4-with-projections converges to M2.** Recall cannot fold the log per query (latency; the brute-force paths already scan rows), so you maintain a projection on write. That projection needs exactly the flags M2 adds (`retracted_at`, `superseded_by`). What remains different is only the declared source of truth — and recall still reads the projection, not the log.
3. **The canonical store retains poisoned bytes forever.** In M4 the event log *is* the database, so poisoned text lives in the canonical store, not in a separable side-table. Removing it means compacting/rewriting the log — surgery on the object everything derives from. M2 keeps poison in an ordinary row that operator sanitize can physically delete while the system of record stays intact.
4. **Audit surface.** In M2b the append-only log is small and could be hash-chained later if tamper-evidence is ever required. In M4 the entire database is the audit object; equivalent guarantees require hash-chaining everything, and the security audit must reason about the whole event store.
5. **Migration ceremony.** Existing v1 rows are snapshots, not events. Going M4 means synthesizing an `Ingested` event per row and standing up rebuild tooling *before* corrections can ship.

**Upgrade path — why deferring M4 is reversible:** M2b's `corrections` log is already event-shaped. If a genuine temporal-query or multi-consumer-projection requirement appears, the mutating operations already exist as events; you'd backfill `Ingested` events at that point. M4 is a strict superset reachable from M2b without re-architecting. The delta today is machinery, not capability we use.

### M5 — Capability gating (orthogonal to M1/M2)

Correction rights under the current model: any client holding a tenant's bearer token can ingest *and* (once M2 lands) retract/correct. Poison-and-remedy rights are equal, and agent actions are attributable only to the tenant, not the client. Options: split ingest vs. correct scopes (second token class per tenant), or require human approval (Vikunja ticket) for retracting *pinned* rows while allowing self-service retract of default/high rows. Not a data-model question, but it must be answered alongside M2 — the security audit cannot close L1 without it. Pin *demotion* is operator-only in this design (§4), which covers the worst poisoning persistence path.

### Comparison

| | M1 hard delete | M2 tombstone+supersede | M3 counter-memory | M4 event sourcing |
|---|---|---|---|---|
| Removes poison from recall | yes | yes | unreliable | yes |
| Works on pinned rows | yes | yes | **no** | yes |
| Audit trail | none (operator sanitize records hash+reason) | native (M2b strongest) | none | native |
| Reversible | no | yes | n/a | yes |
| Poisoned bytes physically removable | yes | yes — operator sanitize | no — both kept | hard — rewrite canonical log |
| Re-ingest of purged text blocked | only if paired with denylist | **yes — denylist (§4)** | no | only if folded into log |
| Source of truth | rows | rows (+ audit log) | rows | event log |
| Schema change | none (+ pgvector delete) | v2 migration | none | heavy + event backfill |
| Recall-path change | none | store-layer filter | none | projection machinery |
| Remedy for vault edit parity | yes | yes | partial | yes |
| MetaMCP exposure if agent-facing | dangerous | acceptable (gated) | n/a | acceptable |

## 4. Recommendation

**M2b at runtime + denylist + operator console/CLI. M4 deferred** (reversible via the corrections log; see §3).

The runtime design:

1. **Schema v2** (guarded migration in `TenantStore` constructor): `retracted_at TEXT`, `superseded_by TEXT` on `memories`; new append-only `corrections` table (`tenant, action, body_hash, new_hash, reason, occurred_at`); new `purged_hashes` table (`tenant, body_hash, first_purged_at, reason`). Neither new table is ever updated or deleted from code.
2. **Tools:** `memvault_retract`, `memvault_correct` — both accept `text` (hashed server-side) or `id`; both require `reason`; both write the audit row and invalidate the pinned cache if it is ever wired into recall. Agents never get purge, denylist, or pin-management tools.
3. **Read side:** filter `retracted_at IS NULL` in `listPinned`, `listNonPinned`, `getByIds`, `rowsMissingEmbedding`. Both recall paths inherit it; no changes in `scoring.ts` ranking logic.
4. **pgvector:** add `delete(tenant, memoryId)`; on retract/sanitize, delete eagerly (best-effort, log-only on failure — SQLite is authoritative); the operator sweep reaps any dangling ANN ids.
5. **Two re-ingest regimes (D1, decided 2026-09-14):**
   - *Retracted rows* keep their dedup gate: re-ingesting retracted text returns the existing (retracted) row as `deduplicated=true` and does **not** un-retract; revival requires `memvault_correct`. Rationale: implicit resurrection through a bulk path (`session_wrap` re-ingesting an old transcript) would silently undo retractions.
   - *Purged hashes* live in the denylist and are rejected **upfront at every ingest path** — `memvault_ingest`, `memvault_session_wrap`, REST `/ingest` — checked *before* the dedup lookup, pre-embed (so purged content is never re-embedded or re-upserted to pgvector). A hit returns an explicit `blocked` result; `session_wrap` counts blocked items separately; the vault watcher logs-and-skips (never blocks graphiti). Denylist rows are never GC'd.
   - The denylist also accepts manual hash entry (preemptive deny of text never ingested), and UI/CLI sanitize populates it automatically.
6. **Graphiti parity (explicit non-goal for v1, documented):** corrections are PCM-local; graphiti's independent copy is a known split-brain until the watcher learns to forward correction events. Record as a follow-up finding, not a blocker.

### Operator console (M1, human-facing)

- **Shape:** server-rendered HTML + HTMX + a single inline CSS stylesheet; no build step, no JS framework — one binary, homelab-simple. Served by pcm-server on a **separate listener, port :3601** (tenant MCP stays on :3600). TLS via a Caddy route (`pcm-admin.internal.homelab.equipment`) or the internal cert; ZBF-scoped to operator/admin VLANs only (firewall rule lands in the security-audit phase; until then it binds but stays unpublished).
- **Auth:** `PCM_OPERATOR_TOKENS` — same `name=TOKEN` format as tenants, seeded from Vault (`secret/pcm-server`), named so audit rows carry the operator identity. Login form → HttpOnly, SameSite=Strict session cookie; every mutation requires a CSRF token. The console never displays or handles tenant bearer tokens; tenant identity for reads/curation is selected from the server-side tenant list.
- **Surface:** tenant picker; browse and search memories (lexical + ANN), filter by importance / retracted / source; **pinned-set view with pin/unpin/correct** (the curation loop for the asker-context surface); retract / correct actions; **sanitize** (purge + denylist entry) with mandatory reason + typed confirmation; denylist viewer + manual hash add; audit-log viewer; stats/health (row counts, embedding/pgvector status, dangling ANN ids, per-tenant storage).
- **Architecture:** a tenant-scoped `MemoryService` (ingest, retract, correct, setImportance, sanitize, sweep) is the single write path — MCP tool handlers and operator HTTP routes both call it. Audit writes live in one place; agent and operator semantics can never diverge.
- **CLI:** `tools/purge.ts` retained alongside the console for automation/emergency (works when the UI is down; scriptable from runbooks). Both use the same service layer and the same sanitize semantics.

### Sanitize semantics (order of operations)

For a single memory: verify target → insert denylist row (`tenant, body_hash, reason`) → append audit row (`action=purge`, hash + reason, never the text) → delete SQLite row → delete pgvector row → optional `VACUUM`. Denylist-first: if the process dies between steps, the worst state is "filter armed, bytes still present" (purge is re-runnable and idempotent), never "bytes gone, filter missing" — that state would silently reopen the resurrection hole.

For vault-sourced content, sanitize is paired with fixing/deleting the source page: the watcher will keep re-sending the text on subsequent edits, and the denylist turns those into log noise (`blocked`), not re-ingestion. Whole-tenant sanitize (decommission): close store, remove `/data/tenants/<tenant>`, `DROP TABLE embeddings_<tenant>`, denylist archived in the audit log, token removed from `PCM_TOKENS` + Vault.

### Why not agent-facing M1, M3, or M4

- Agent-facing hard delete recreates the unauditable-erasure path the v1 decision rejected; the operator console gets the same physical capability with named human identity in the loop.
- M3 cannot touch pinned poison and entrenches contradictions (§3).
- M4's delta over M2b is machinery without a current consumer (§3), and it makes physical removal of poisoned bytes *harder*, not easier.

**Migration/test plan:** bump `SCHEMA_VERSION` to 2 with idempotent `ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`; extend `tests/memvault.test.ts` (retracted excluded from recall on both ANN and brute paths; pinned retract; correct supersedes chain; dedup-after-retract; denylist blocks all three ingest paths pre-dedup; sanitize order + idempotency; audit log append-only; tenant isolation unchanged — retract/deny in tenant A never affects B; purge CLI: audit row + denylist entry written, row gone from both stores, GC selector works). Console gets its own HTTP-level tests against the operator listener (auth required, CSRF enforced, tenant tokens never accepted). Deploy via existing `pcm-build.yml`/`pcm-deploy.yml`; no data backfill needed.

## 5. Open decisions

- **D1 (decided 2026-09-14):** two re-ingest regimes — retracted rows keep the dedup gate (no auto-unretract); purged hashes are denylisted and rejected upfront at all ingest paths.
- **D2:** pinned corrections via MCP — human-gated (Vikunja ticket; recommended) vs. self-service. Matches the operator stance: pinned is the persistence surface that matters. Pin *demotion* is operator-only regardless.
- **D3:** tombstone GC retention — default 90 days via the console/CLI sanitize-GC selector, adjustable; audit + denylist rows never purged.
- **D4:** `memvault_correct` on a pinned row — replacement takes caller-specified importance (recommended, default `high`?) vs. inheriting `pinned`. Inheriting would let a correct-then-poison cycle persist at full strength.
- **D5:** operator sanitize of pinned rows — ticket reference in the reason recommended, same logic as D2.
- **D6 (decided 2026-09-14):** operator console — named operator tokens + session cookie + CSRF, separate port :3601, ZBF-scoped to operator VLANs; agents get no purge/denylist/pin tools.
- **D7:** agent-facing pin changes beyond ingest-time pinning — keep status quo (operators demote rogue pins via console; recommended) vs. adding an agent unpin tool (not recommended now).
- **D8 (later):** cross-tenant / global denylist for fleet-wide poison (same hash poisoned into several tenants). Per-tenant denylist ships first; a global view is a console aggregation feature, not a schema change.
