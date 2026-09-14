# Laima Fork Working Agreement

How this repository relates to upstream `anthonelyee991/pcm`, what may be changed where, and how
work flows back. Read this before committing anything.

## Remotes & branches

- `upstream` = `https://github.com/anthonylee991/pcm.git` (read-only mirror).
- `main` tracks `upstream/main`. Never commit here; reset it with
  `git fetch upstream && git switch main && git reset --hard upstream/main` after upstream moves.
- `laima/main` is our integration branch. Rebase it onto `main` (upstream) routinely — small
  rebases often, not big ones at release time.
- Topic branches off `laima/main`, one concern each, named by kind:
  - `pr/*` — changes intended for upstream as pull requests. These touch **only files that exist
    upstream** (`src/`, `tests/`, docs), stay minimal, and are written as if a stranger will
    review them without any Laima context.
  - `feat/*`, `fix/*` — Laima-only work. These touch **only additive paths** (see layout contract).
  - Anything that needs both is split into two branches.

There is no push remote yet. When we create a GitHub fork, it becomes `origin`; `pr/*` branches
push there and PRs open against `upstream:main` from the fork.

## Layout contract (the upgrade-safety rule)

Upstream owns these paths; we modify them **only** on `pr/*` branches, never on `laima/main`
except by merging a landed/accepted PR:

    src/            pcm-core library (decay, prompt-builder, associative, margin-heuristic, pinned-cache, schema, graph, evals)
    tests/          upstream test suite
    PCM-SPEC.md, README.md, LICENSE, package.json, tsconfig.json, bun.lock

Laima owns these additive paths; upstream will never touch them, so rebases never conflict:

    server/         the memvault MCP sidecar + operator console (moved from laima services/pcm-server;
                    imports ../src directly — no vendored copy inside this repo)
    scripts/        tooling (sync-to-laima, vendor, probes)
    LAIMA.md        this file

Commit #1 on `laima/main` is tooling-only: rewrite upstream's `.js` import extensions to `.ts` so
Bun resolves them (`server/` imports `../src` directly). It touches only import lines, conflicts
trivially on rebase, and is a prerequisite for everything Laima-side. Do not mix it into `pr/*`
branches — upstream builds TS its own way and doesn't need it.

## PR candidates (from PCM-AUDIT-2026-09-14.md, in order)

1. `pr/fix-remove-fixture-supersession` — delete the hardcoded rewrites and the
   `resolveSupersededContext` call from `prompt-builder.ts` / `formatSlotsToMarkdown`. Provable
   fabrication of agent-facing content (audit finding 12.C1, Critical upstream of anything else).
2. `pr/fix-decay-hardness` — `calculateDecayedStrength` NaN on unparseable input (audit 2.H2) and
   future-date `elapsedDays` clamp that grants permanent decay immunity (audit 1.H2). Return a
   sane floor instead of NaN; document the clamp.
3. `pr/fix-invariant-slot-cap` — `buildPAESlots` truncates asker context after
   `selectAskerContext` prepends unbounded invariants, evicting all query-relevant guardrails
   (audit 12.M3, latent). Cap invariants inside the slot budget.
4. `pr/feat-real-supersession` — **later, from the corrections work.** A real supersession/tombstone
   module to replace the deleted fixture rewriter. This is the flagship upstream contribution;
   design source: `docs/specs/2026-09-13-pcm-corrections-design.md` (M2b) in laima.

## Work map (Laima-side branches, roughly dependency order)

- `feat/migration-runner` — schema-versioned migration runner in the store. **First.** The audit
  (finding 11.C1) proved `SCHEMA_VERSION` is decorative; the occurredAt backfill and all of M2b
  corrections are queued behind this.
- `feat/occurred-at-validation` — server-side: zod-validate `occurredAt` on REST `/ingest`,
  reject >24 h future skew, NaN regression test. (Writer-side fixes — `backfill_pcm.py`,
  `vault_watcher` — live in laima `services/`, not here.)
- `feat/corrections-m2b` — spec v3: `retracted_at`/`superseded_by`, append-only `corrections`
  log, `purged_hashes` denylist (checked before dedup on every ingest path), `memvault_retract` /
  `memvault_correct` tools, pgvector `delete()`.
- `feat/operator-console` — :3601 listener, named operator tokens, HTMX UI (pin curation,
  sanitize, denylist, audit viewer). Depends on corrections-m2b.
- `feat/observability` — log embed failures (audit 2.H1 root cause of F5), `/metrics`,
  authenticated `/healthz` detail (audit 1.M1), embed-failure counter, NULL-embedding gauge.

Laima-repo work that does **not** belong here: ansible hardening (env split, resource limits,
host/DNS parameterisation — audit §5), watcher/backfill writer fixes, nftables codification,
ZBF/Caddy for :3601.

## Flow to the deployed service

Deploys build from `laima/services/pcm-server` (ansible `pcm-build.yml`) — that stays the deploy
artifact until we deliberately switch it. Per release:

1. Tag this repo `laima-vX.Y.Z` at a tested `laima/main`.
2. Run `scripts/sync-to-laima.sh <tag>` — rsyncs `server/` → laima `services/pcm-server/`
   (excluding laima's deploy files: `vendor/`, `Dockerfile`, `bun.lock`, `node_modules/`) and
   vendors `src/{core,schema,index.ts}` → `vendor/pcm-core/` (excluding `graph/`/`evals/`,
   filtering the one `graph` re-export line from the vendored `index.ts`; fork `src/` already
   carries the `.ts` extensions so no rewrite step). `DRY_RUN=1` previews. The script never
   commits — it leaves a **reviewable working-tree change** in laima; laima commits it with
   the normal `titan()` convention.
3. Deploy with the existing playbooks.

Known drift the first sync fixes: laima's vendored `prompt-builder.ts` still carried the
fixture-based supersession stub (audit finding 12.C1) — the merge of the resolver
(`43c8bcb`) only existed here until this sync existed.

## Rules

- Never rewrite upstream history; never force-push `laima/main` after laima has vendored a tag
  built on it (tags are the contract).
- Every behavioural fix lands with a regression test in `server/tests/` (or upstream `tests/` for
  `pr/*`) that fails before the fix.
- The audit's cross-cutting lesson applies here: fix at the layer where the defect originates —
  no mitigation one layer above a live root cause.
