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

  test("calculateDecayedStrength returns the floor, not NaN, for non-finite inputs", () => {
    const init = getInitialStrength("default");

    for (const garbage of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(calculateDecayedStrength(init, garbage)).toBe(0.01);
      expect(Number.isNaN(calculateDecayedStrength(init, garbage))).toBe(false);
    }
    // NaN can also arrive through the savings-effect term
    expect(calculateDecayedStrength(init, 30 * 24 * 60 * 60 * 1000, Number.NaN)).toBe(0.01);
    // pinned still wins regardless of inputs
    expect(calculateDecayedStrength(1.0, Number.NaN, 0, "pinned")).toBe(1.0);
  });

  test("future-dated elapsed clamps to zero, full strength (pinned by design)", () => {
    const init = getInitialStrength("default");
    expect(calculateDecayedStrength(init, -30 * 24 * 60 * 60 * 1000)).toBe(init);
  });
});
