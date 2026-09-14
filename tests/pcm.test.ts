import { describe, expect, test } from "bun:test";
import {
  getInitialStrength,
  calculateDecayedStrength,
  boostStrengthOnAccess,
  calculateReRankScore,
  PinnedGuardrailsCache,
  shouldInvokeNeuralReranker,
  buildPAESlots,
  formatSlotsToMarkdown,
  resolveSupersededContext,
} from "../src/index.js";

describe("PCM Standalone Engine Tests", () => {
  test("Pinned memories never decay over time", () => {
    const pinnedStr = getInitialStrength("pinned");
    expect(pinnedStr).toBe(1.0);

    const after365Days = calculateDecayedStrength(
      pinnedStr,
      365 * 24 * 60 * 60 * 1000,
      0,
      "pinned"
    );
    expect(after365Days).toBe(1.0);
  });

  test("Default memories follow Ebbinghaus retention decay", () => {
    const initStr = getInitialStrength("default");
    const after14Days = calculateDecayedStrength(
      initStr,
      14 * 24 * 60 * 60 * 1000,
      0,
      "default"
    );
    expect(after14Days).toBeLessThan(initStr);
    expect(after14Days).toBeGreaterThan(0.01);
  });

  test("Savings effect slows decay when boostCount increases", () => {
    const initStr = getInitialStrength("default");
    const elapsed = 30 * 24 * 60 * 60 * 1000;

    const unboosted = calculateDecayedStrength(initStr, elapsed, 0, "default");
    const boosted = calculateDecayedStrength(initStr, elapsed, 5, "default");

    expect(boosted).toBeGreaterThan(unboosted);
  });

  test("PinnedGuardrailsCache provides sub-millisecond retrieval", () => {
    const cache = new PinnedGuardrailsCache(10_000);
    expect(cache.get("user-123")).toBeNull();

    cache.set("user-123", [
      {
        id: "rule-1",
        userId: "user-123",
        text: "Always use Bun",
        importance: "pinned",
        strength: 1.0,
        createdAt: new Date(),
      },
    ]);

    const hit = cache.get("user-123");
    expect(hit).not.toBeNull();
    expect(hit!.length).toBe(1);
    expect(hit![0]!.text).toBe("Always use Bun");
  });

  test("Margin heuristic bypasses reranker on decisive margin", () => {
    const candidates = [
      { id: "1", score: 0.85 },
      { id: "2", score: 0.65 }, // margin 0.20 >= 0.15
    ];
    expect(shouldInvokeNeuralReranker(candidates)).toBe(false);
  });

  test("Margin heuristic invokes reranker on ambiguous margin", () => {
    const candidates = [
      { id: "1", score: 0.80 },
      { id: "2", score: 0.75 }, // margin 0.05 < 0.15
    ];
    expect(shouldInvokeNeuralReranker(candidates)).toBe(true);
  });

  test("PAE formats slotted context strictly under token budget", () => {
    const slots = buildPAESlots({
      userQuery: "How do we run tests?",
      askerItems: [
        { memoryId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", text: "Always use Bun test runner", importance: "pinned", strength: 1.0 },
      ],
      situationalItems: [
        { memoryId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22", text: "Tests run in apps/server/tests" },
      ],
    });

    const markdown = formatSlotsToMarkdown(slots);
    expect(markdown).toContain("[ASKER CONTEXT: Pinned Rules & Preferences]");
    expect(markdown).toContain("[SITUATIONAL CONTEXT: Recent Decisions & Context]");
    expect(markdown.length).toBeLessThan(500); // well under 125 tokens
  });

  test("formatSlotsToMarkdown returns stored situational text verbatim", () => {
    const storedText = "Team note: Dana resigned from fintech corp last quarter, so reassign the on-call rotation for the billing service.";
    const slots = buildPAESlots({
      userQuery: "Who is on call for billing?",
      situationalItems: [
        { memoryId: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33", text: storedText },
      ],
    });

    const markdown = formatSlotsToMarkdown(slots);
    expect(markdown).toContain(storedText);
    // markdown and structuredContent must agree — no silent rewriting between them
    for (const item of slots.situational_context) {
      expect(markdown).toContain(item.text);
    }
  });

  test("resolveSupersededContext formats a SUPERSEDES triplet and prunes its exact target", () => {
    const out = resolveSupersededContext([
      { memoryId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44", text: "[RELATION](Dana)-[SUPERSEDES]->(Dana, on-call for billing)" },
      { memoryId: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55", text: "Dana, on-call for billing" },
      { memoryId: "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66", text: "Unrelated memory about dnsmasq failover" },
    ]);

    expect(out.map((i) => i.text)).toEqual([
      "[ACTIVE STATE] Dana",
      "Unrelated memory about dnsmasq failover",
    ]);
  });

  test("resolveSupersededContext keeps partial mentions when no exact target matches", () => {
    const mentioning = "Billing rotation still references Dana's old schedule";
    const out = resolveSupersededContext([
      { memoryId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44", text: "[RELATION](Dana)-[SUPERSEDES]->(Dana, on-call for billing)" },
      { memoryId: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55", text: mentioning },
    ]);

    // partial mention is retained, not silently dropped
    expect(out.some((i) => i.text === mentioning)).toBe(true);
  });

  test("resolveSupersededContext honors [SUPERSEDES: memoryId] markers", () => {
    const out = resolveSupersededContext([
      { memoryId: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55", text: "[SUPERSEDES: d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44] Dana owns on-call for billing as of this week" },
      { memoryId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44", text: "Dana owns on-call for billing" },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.memoryId).toBe("e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55");
    expect(out[0]!.text).toBe("Dana owns on-call for billing as of this week");
  });

  test("resolveSupersededContext formats FORBIDDEN_DUE_TO and CONFIDENTIAL_INVARIANT without inventing content", () => {
    const out = resolveSupersededContext([
      { memoryId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", text: "[RELATION](prod deploys)-[FORBIDDEN_DUE_TO]->(open change window)" },
      { memoryId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22", text: "[RELATION](patient record)-[CONFIDENTIAL_INVARIANT]->(patient record)" },
    ]);

    expect(out[0]!.text).toBe("[RESTRICTION] prod deploys (FORBIDDEN DUE TO: open change window)");
    // names the target, withholds details — must not fabricate specifics
    expect(out[1]!.text).toBe("[CONFIDENTIAL INVARIANT] (patient record — details withheld)");
    expect(out[1]!.text).not.toContain("psychiatric");
  });

  test("resolveSupersededContext passes unknown relation predicates through unchanged", () => {
    const triplet = "[RELATION](api)-[CALLS]->(database)";
    const out = resolveSupersededContext([
      { memoryId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", text: triplet },
    ]);
    expect(out[0]!.text).toBe(triplet);
  });
});
