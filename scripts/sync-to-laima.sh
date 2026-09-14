#!/usr/bin/env bash
#
# sync-to-laima.sh — vendor a fork ref into the laima deploy tree.
#
# Contract:
#   - One-way only: fork ref -> laima deploy tree. Never writes back.
#   - Additive paths only: the fork's server/ and src/{core,schema,index.ts}
#     land in the deploy tree; laima's own deploy files (Dockerfile, bun.lock,
#     .gitignore, vendor/, node_modules/) are never overwritten or deleted.
#   - This script NEVER commits. The laima repo uses titan() commits; review
#     the working-tree change and commit manually.
#
# Usage: scripts/sync-to-laima.sh [ref] [target-dir]
#   ref         fork ref to vendor (default: laima/main)
#   target-dir  laima deploy tree (default: $HOME/laima/services/pcm-server)
#   DRY_RUN=1   rsync -n listing only; nothing copied, no git status report.

set -euo pipefail

REF="${1:-laima/main}"
TARGET="${2:-$HOME/laima/services/pcm-server}"
DRY_RUN="${DRY_RUN:-0}"

FORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { printf 'sync-to-laima: %s\n' "$*" >&2; exit 1; }

# --- validation -------------------------------------------------------------
cd "$FORK_ROOT"
git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null || die "ref '${REF}' does not resolve to a commit"
[ -d "$TARGET" ] || die "target dir '${TARGET}' does not exist"
command -v rsync >/dev/null || die "rsync not found"
SHA="$(git rev-parse --short "${REF}^{commit}")"

# --- extract the ref into a clean temp dir (no .git, no working-tree cruft) --
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# LICENSE rides along so vendor/pcm-core can carry it. src/graph and src/evals
# are intentionally NOT archived: the vendored core never included them.
git archive "$REF" src server LICENSE | tar -x -C "$TMP"

RSYNC_FLAGS=(-a --delete
  --exclude 'vendor/'
  --exclude 'node_modules/'
  --exclude 'Dockerfile'
  --exclude '.gitignore'
  --exclude 'bun.lock')
[ "$DRY_RUN" = "1" ] && RSYNC_FLAGS+=(-n -v -i)

# --- fork server/ -> deploy root (src, tests, tools, package.json, ...) ------
# The --exclude list double-duty: it keeps laima's deploy files out of the
# transfer AND shields them from --delete on the target, so vendor/, the
# Dockerfile, bun.lock and .gitignore survive the sync.
rsync "${RSYNC_FLAGS[@]}" "$TMP/server/" "$TARGET/"

# --- pcm-core -> vendor/pcm-core/{core,schema,index.ts,LICENSE} --------------
# The vendored index.ts drops the './graph' re-export (graph/ is not vendored);
# that one-line filter is the only transformation, matching the existing layout.
if [ "$DRY_RUN" = "1" ]; then
  rsync "${RSYNC_FLAGS[@]}" "$TMP/src/core/" "$TARGET/vendor/pcm-core/core/"
  rsync "${RSYNC_FLAGS[@]}" "$TMP/src/schema/" "$TARGET/vendor/pcm-core/schema/"
  printf 'would copy src/index.ts (minus graph re-export) -> %s\n' "$TARGET/vendor/pcm-core/index.ts"
  [ -f "$TMP/LICENSE" ] && printf 'would copy LICENSE -> %s\n' "$TARGET/vendor/pcm-core/LICENSE"
else
  mkdir -p "$TARGET/vendor/pcm-core"
  rsync "${RSYNC_FLAGS[@]}" "$TMP/src/core/" "$TARGET/vendor/pcm-core/core/"
  rsync "${RSYNC_FLAGS[@]}" "$TMP/src/schema/" "$TARGET/vendor/pcm-core/schema/"
  sed -e '/export \* from "\.\/graph\/index\.ts";/d' -e '${/^$/d}' "$TMP/src/index.ts" > "$TARGET/vendor/pcm-core/index.ts"
  [ -f "$TMP/LICENSE" ] && cp "$TMP/LICENSE" "$TARGET/vendor/pcm-core/LICENSE"

  # Sanity: the two entry points the deploy runtime imports must exist.
  [ -f "$TARGET/src/index.ts" ] || die "sanity check failed: $TARGET/src/index.ts missing"
  [ -f "$TARGET/vendor/pcm-core/index.ts" ] || die "sanity check failed: $TARGET/vendor/pcm-core/index.ts missing"
fi

# --- report ------------------------------------------------------------------
printf 'fork ref:  %s (%s)\n' "$REF" "$SHA"
printf 'target:    %s\n' "$TARGET"
if [ "$DRY_RUN" = "1" ]; then
  printf 'DRY_RUN: no changes applied.\n'
else
  # Reviewer's view of exactly what changed; the laima tree commits manually.
  LAima_ROOT="$(cd "$TARGET" && git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$LAima_ROOT" ]; then
    printf 'git status in %s:\n' "$LAima_ROOT"
    git -C "$LAima_ROOT" status --short -- services/pcm-server
  else
    printf 'note: %s is not inside a git work tree; skipping git status.\n' "$TARGET"
  fi
fi
