import {
  buildPAESlots,
  calculateDecayedStrength,
  formatSlotsToMarkdown,
  isInvariantContent,
  DEFAULT_DECAY_RATE,
} from "../../src/index.ts";
import type { AskerContextItem, SituationalContextItem } from "../../src/index.ts";
import type { Embedder } from "./embedder.ts";
import type { AnnCandidate, AnnIndex } from "./pgvector.ts";
import type { MemoryRow, TenantStore } from "./store.ts";

const STALE_THRESHOLD = 0.05;
const ANN_CANDIDATE_LIMIT = 50;

export interface RecallOptions {
  k: number;
  includeStale: boolean;
  decayRate: number;
}

export interface RecallOutput {
  slots: ReturnType<typeof buildPAESlots>;
  markdown: string;
  tokenEstimate: number;
  latencyMs: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

export function tokenOverlapRatio(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const docTokens = new Set(tokenize(text));
  let hits = 0;
  for (const tok of new Set(queryTokens)) {
    if (docTokens.has(tok)) hits += 1;
  }
  return hits / new Set(queryTokens).size;
}

export function toFloat32(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function selectAskerContext(
  pinnedRows: MemoryRow[],
  queryTokens: string[],
): AskerContextItem[] {
  const invariantItems: AskerContextItem[] = [];
  const ranked: Array<{ item: AskerContextItem; score: number }> = [];

  for (const row of pinnedRows) {
    const item: AskerContextItem = {
      memoryId: row.id,
      text: row.text,
      importance: row.importance,
      strength: row.strength,
    };
    if (isInvariantContent(row.text)) {
      invariantItems.push(item);
    } else {
      ranked.push({ item, score: tokenOverlapRatio(queryTokens, row.text) });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return [...invariantItems, ...ranked.slice(0, 3).map((r) => r.item)];
}

export interface ScoredRow {
  row: MemoryRow;
  decayed: number;
  score: number;
}

export function rankSituational(
  rows: MemoryRow[],
  queryTokens: string[],
  queryEmbedding: Float32Array | null,
  options: RecallOptions,
  now: Date,
): ScoredRow[] {
  const scored: ScoredRow[] = [];
  for (const row of rows) {
    const embedding = toFloat32(row.embedding);
    const retrievalScore =
      queryEmbedding && embedding && row.dims === embedding.length
        ? cosineSimilarity(queryEmbedding, embedding)
        : tokenOverlapRatio(queryTokens, row.text);
    const elapsedMs = now.getTime() - new Date(row.occurred_at).getTime();
    const decayed = calculateDecayedStrength(
      row.strength,
      elapsedMs,
      row.boost_count,
      row.importance,
      options.decayRate,
      row.text,
    );
    // NaN comparisons are always false, which would keep unparseable-date rows (2.H2)
    if (!(decayed >= STALE_THRESHOLD) && !options.includeStale) continue;
    scored.push({ row, decayed, score: retrievalScore * decayed });
  }
  scored.sort((a, b) => b.score - a.score || b.row.occurred_at.localeCompare(a.row.occurred_at));
  return scored;
}

export function scoreAnnCandidates(
  rows: MemoryRow[],
  candidates: AnnCandidate[],
  options: RecallOptions,
  now: Date,
): ScoredRow[] {
  const distanceById = new Map(candidates.map((c) => [c.memoryId, c.distance]));
  const scored: ScoredRow[] = [];
  for (const row of rows) {
    const distance = distanceById.get(row.id);
    if (distance === undefined) continue;
    const elapsedMs = now.getTime() - new Date(row.occurred_at).getTime();
    const decayed = calculateDecayedStrength(
      row.strength,
      elapsedMs,
      row.boost_count,
      row.importance,
      options.decayRate,
      row.text,
    );
    // NaN comparisons are always false, which would keep unparseable-date rows (2.H2)
    if (!(decayed >= STALE_THRESHOLD) && !options.includeStale) continue;
    scored.push({ row, decayed, score: (1 - distance) * decayed });
  }
  scored.sort((a, b) => b.score - a.score || b.row.occurred_at.localeCompare(a.row.occurred_at));
  return scored;
}

export function mergeSituational(annScored: ScoredRow[], bruteScored: ScoredRow[], k: number): ScoredRow[] {
  const seen = new Set(annScored.map((s) => s.row.id));
  const merged = [...annScored];
  for (const candidate of bruteScored) {
    if (merged.length >= k) break;
    if (seen.has(candidate.row.id)) continue;
    seen.add(candidate.row.id);
    merged.push(candidate);
  }
  merged.sort((a, b) => b.score - a.score || b.row.occurred_at.localeCompare(a.row.occurred_at));
  return merged;
}

export async function recall(
  store: TenantStore,
  embedder: Embedder,
  query: string,
  options: RecallOptions,
  ann?: AnnIndex | null,
): Promise<RecallOutput> {
  const started = performance.now();
  const now = new Date();
  const queryTokens = tokenize(query);
  const queryEmbedding = await embedder.embed(query);

  const askerItems = selectAskerContext(store.listPinned(), queryTokens);

  let situational: ScoredRow[];
  let annCandidates: AnnCandidate[] | null = null;
  if (ann && queryEmbedding) {
    try {
      annCandidates = await ann.search(store.tenant, queryEmbedding, ANN_CANDIDATE_LIMIT);
    } catch (err) {
      console.warn(`pgvector search failed for tenant ${store.tenant}: ${(err as Error).message}`);
      annCandidates = null;
    }
  }

  if (annCandidates && annCandidates.length > 0) {
    const rows = store.getByIds(annCandidates.map((c) => c.memoryId));
    const annScored = scoreAnnCandidates(rows, annCandidates, options, now);
    if (annScored.length >= options.k) {
      situational = annScored.slice(0, options.k);
    } else {
      // ANN returned too few live rows: top up from the brute-force path so
      // recall never regresses (covers NULL-embedding rows not yet indexed).
      const bruteScored = rankSituational(
        store.listNonPinned(),
        queryTokens,
        queryEmbedding,
        options,
        now,
      );
      situational = mergeSituational(annScored, bruteScored, options.k);
    }
  } else {
    situational = rankSituational(
      store.listNonPinned(),
      queryTokens,
      queryEmbedding,
      options,
      now,
    ).slice(0, options.k);
  }

  const situationalItems: SituationalContextItem[] = situational.map(({ row }) => ({
    memoryId: row.id,
    text: row.text,
    occurredAt: row.occurred_at,
  }));

  for (const item of askerItems) {
    store.incrementBoost(item.memoryId);
  }
  for (const item of situationalItems) {
    store.incrementBoost(item.memoryId);
  }

  const slots = buildPAESlots({ userQuery: query, askerItems, situationalItems });
  const markdown = formatSlotsToMarkdown(slots);

  return {
    slots,
    markdown,
    tokenEstimate: Math.ceil(markdown.length / 4),
    latencyMs: Math.round(performance.now() - started),
  };
}

export { DEFAULT_DECAY_RATE };
