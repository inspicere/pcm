import { describe, expect, test } from "bun:test";
import { calculateDecayedStrength, DEFAULT_DECAY_RATE } from "../../src/index.ts";
import { createEmbedder } from "../src/embedder.ts";
import type { AnnIndex } from "../src/pgvector.ts";
import { createPgvectorIndex, sanitizeTenantName } from "../src/pgvector.ts";
import { ingestItem, TenantRegistry } from "../src/server.ts";
import type { MemoryRow } from "../src/store.ts";
import { mergeSituational, rankSituational, recall, scoreAnnCandidates } from "../src/scoring.ts";
import { makeTmpDir, trackDir } from "./helpers.ts";

function rowFixture(overrides: Partial<MemoryRow>): MemoryRow {
  return {
    id: crypto.randomUUID(),
    body_hash: crypto.randomUUID(),
    text: "fixture memory text",
    importance: "default",
    strength: 0.7,
    boost_count: 0,
    occurred_at: new Date().toISOString(),
    embedding: null,
    dims: null,
    source: null,
    source_ref: null,
    created_at: new Date().toISOString(),
    retracted_at: null,
    superseded_by: null,
    ...overrides,
  };
}

function scoredFixture(id: string, score: number): import("../src/scoring.ts").ScoredRow {
  return { row: rowFixture({ id }), decayed: score, score };
}

describe("sanitizeTenantName", () => {
  test("normalizes mixed case and illegal characters", () => {
    expect(sanitizeTenantName("Hermes")).toBe("hermes");
    expect(sanitizeTenantName("claude-code!")).toBe("claude_code_");
    expect(sanitizeTenantName("weird name.x")).toBe("weird_name_x");
    expect(sanitizeTenantName("laima_2026")).toBe("laima_2026");
  });

  test("rejects names that normalize to empty", () => {
    expect(() => sanitizeTenantName("")).toThrow();
  });
});

describe("scoreAnnCandidates", () => {
  const options = { k: 5, includeStale: false, decayRate: DEFAULT_DECAY_RATE };

  test("score is (1 - distance) x decayed strength", () => {
    const now = new Date();
    // Future occurred_at clamps elapsed to 0, so decayed === strength exactly.
    const row = rowFixture({
      strength: 0.8,
      occurred_at: new Date(now.getTime() + 60_000).toISOString(),
    });
    const scored = scoreAnnCandidates([row], [{ memoryId: row.id, distance: 0.25 }], options, now);
    expect(scored).toHaveLength(1);
    const expectedDecayed = calculateDecayedStrength(0.8, 0, 0, "default", DEFAULT_DECAY_RATE, row.text);
    expect(scored[0]!.decayed).toBe(expectedDecayed);
    expect(scored[0]!.score).toBeCloseTo(0.75 * expectedDecayed, 10);
  });

  test("drops decayed-below-threshold rows unless includeStale", () => {
    const now = new Date();
    const stale = rowFixture({
      strength: 0.7,
      occurred_at: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(scoreAnnCandidates([stale], [{ memoryId: stale.id, distance: 0.1 }], options, now)).toHaveLength(0);
    const withStale = scoreAnnCandidates(
      [stale],
      [{ memoryId: stale.id, distance: 0.1 }],
      { ...options, includeStale: true },
      now,
    );
    expect(withStale).toHaveLength(1);
  });

  test("ignores candidate ids with no matching row", () => {
    const now = new Date();
    const row = rowFixture({});
    const scored = scoreAnnCandidates(
      [row],
      [
        { memoryId: row.id, distance: 0.1 },
        { memoryId: "missing-id", distance: 0.1 },
      ],
      options,
      now,
    );
    expect(scored.map((s) => s.row.id)).toEqual([row.id]);
  });
});

describe("mergeSituational", () => {
  test("tops up from brute-force when pgvector returns fewer than k", () => {
    const annA = scoredFixture("ann-a", 0.5);
    const bruteA = scoredFixture("ann-a", 0.9); // duplicate of the ANN row, higher score
    const bruteB = scoredFixture("brute-b", 0.4);
    const bruteC = scoredFixture("brute-c", 0.3);

    const merged = mergeSituational([annA], [bruteA, bruteB, bruteC], 3);
    expect(merged.map((m) => m.row.id)).toEqual(["ann-a", "brute-b", "brute-c"]);
    // The ANN version of ann-a is kept (not replaced by the brute-force duplicate).
    expect(merged[0]!.score).toBe(0.5);
    expect(merged).toHaveLength(3);
  });

  test("returns only ANN rows when they already cover k", () => {
    const merged = mergeSituational(
      [scoredFixture("ann-a", 0.5), scoredFixture("ann-b", 0.4)],
      [scoredFixture("brute-c", 0.9)],
      2,
    );
    expect(merged.map((m) => m.row.id)).toEqual(["ann-a", "ann-b"]);
  });
});

describe("recall with an ANN index", () => {
  const vectorEmbedder = {
    mode: "ready" as const,
    model: "fake",
    embed: async () => Float32Array.from([1, 0, 0]),
  };

  function fakeAnn(candidates: Array<{ memoryId: string; distance: number }>): AnnIndex {
    return {
      status: "ready",
      host: "mock",
      ping: async () => true,
      upsert: async () => {},
      delete: async () => {},
      search: async () => candidates,
    };
  }

  test("tops up ANN candidates with the brute-force path so recall never regresses", async () => {
    const dir = trackDir(makeTmpDir());
    const registry = new TenantRegistry(
      dir,
      createEmbedder({ baseUrl: null, model: "fake", timeoutMs: 1000 }),
      DEFAULT_DECAY_RATE,
    );
    const ctx = registry.get("hermes");
    ctx.embedder = vectorEmbedder;

    const first = await ingestItem(ctx, {
      text: "The pgvector container hosts the HNSW index for ANN recall.",
    });
    await ingestItem(ctx, {
      text: "Restic backups target the NAS snapshot pool every night at 02:00.",
    });

    // pgvector knows only the first row -> the second must still surface via top-up.
    const result = await recall(
      ctx.store,
      ctx.embedder,
      "ann recall index",
      { k: 2, includeStale: false, decayRate: ctx.decayRate },
      fakeAnn([{ memoryId: first.id, distance: 0.1 }]),
    );
    const ids = result.slots.situational_context.map((item) => item.memoryId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("ANN-only shortlist when pgvector covers k", async () => {
    const dir = trackDir(makeTmpDir());
    const registry = new TenantRegistry(
      dir,
      createEmbedder({ baseUrl: null, model: "fake", timeoutMs: 1000 }),
      DEFAULT_DECAY_RATE,
    );
    const ctx = registry.get("hermes");
    ctx.embedder = vectorEmbedder;

    const first = await ingestItem(ctx, { text: "First memory about ansible playbooks." });
    await ingestItem(ctx, { text: "Second memory about grafana dashboards." });

    const result = await recall(
      ctx.store,
      ctx.embedder,
      "ansible",
      { k: 1, includeStale: false, decayRate: ctx.decayRate },
      fakeAnn([{ memoryId: first.id, distance: 0.2 }]),
    );
    expect(result.slots.situational_context.map((item) => item.memoryId)).toEqual([first.id]);
  });

  test("invalid PGVECTOR_DSN: ingest succeeds on the warning path and recall falls back", async () => {
    const dir = trackDir(makeTmpDir());
    const pg = createPgvectorIndex("postgres://pcm:bogus@127.0.0.1:1/pcm");
    expect(pg).not.toBeNull();
    expect(pg!.host).toBe("127.0.0.1");
    expect(await pg!.ping()).toBe(false);
    expect(pg!.status).toBe("stale");

    const registry = new TenantRegistry(
      dir,
      createEmbedder({ baseUrl: null, model: "fake", timeoutMs: 1000 }),
      DEFAULT_DECAY_RATE,
      pg,
    );
    const ctx = registry.get("hermes");
    ctx.embedder = vectorEmbedder;

    const ingested = await ingestItem(ctx, {
      text: "The pgvector index accelerates ANN recall for the memory sidecar.",
    });
    expect(ingested.deduplicated).toBe(false);
    expect(pg!.status).toBe("stale");

    const result = await recall(
      ctx.store,
      ctx.embedder,
      "how does ANN recall acceleration work",
      { k: 5, includeStale: false, decayRate: ctx.decayRate },
      ctx.pgvector,
    );
    const texts = result.slots.situational_context.map((item) => item.text);
    expect(texts.some((t) => t.includes("pgvector"))).toBe(true);
    expect(pg!.status).toBe("stale");
  });

  test("pgvector disabled: createPgvectorIndex returns null, recall uses brute force", async () => {
    expect(createPgvectorIndex(undefined)).toBeNull();
    expect(createPgvectorIndex("   ")).toBeNull();

    const dir = trackDir(makeTmpDir());
    const ctx = new TenantRegistry(
      dir,
      createEmbedder({ baseUrl: null, model: "fake", timeoutMs: 1000 }),
      DEFAULT_DECAY_RATE,
    ).get("hermes");
    await ingestItem(ctx, { text: "Brute force lexical ranking still works without pgvector." });

    const result = await recall(ctx.store, ctx.embedder, "lexical ranking", {
      k: 5,
      includeStale: false,
      decayRate: ctx.decayRate,
    });
    const texts = result.slots.situational_context.map((item) => item.text);
    expect(texts.some((t) => t.includes("lexical"))).toBe(true);
  });
});
