import type { Importance } from "../schema/index.js";

export const DEFAULT_DECAY_RATE = 0.05; // ~14 day effective half-life
export const PINNED_STRENGTH = 1.0;
export const HIGH_INITIAL_STRENGTH = 0.85;
export const DEFAULT_INITIAL_STRENGTH = 0.70;
export const MIN_DECAYED_STRENGTH = 0.01;

const INVARIANT_PATTERNS = [
  /anaphylactic/i,
  /life-threatening\s+allergy/i,
  /epipen/i,
  /severe\s+allergy/i,
  /never\s+disclose/i,
  /critical.*invariant/i,
  /confidential.*invariant/i,
  /strict.*invariant/i,
  /prescription\s+medication.*anxiety/i,
];

export function isInvariantContent(text: string): boolean {
  if (!text) return false;
  return INVARIANT_PATTERNS.some((pat) => pat.test(text));
}

export function getInitialStrength(importance: Importance, text?: string): number {
  if (importance === "pinned" || (text && isInvariantContent(text))) {
    return PINNED_STRENGTH;
  }
  switch (importance) {
    case "high":
      return HIGH_INITIAL_STRENGTH;
    case "default":
    default:
      return DEFAULT_INITIAL_STRENGTH;
  }
}

/**
 * Calculates decayed strength using Ebbinghaus exponential decay model:
 * S(t) = S_0 * exp(-lambda * delta_t / (1 + ln(1 + B)))
 */
export function calculateDecayedStrength(
  initialStrength: number,
  elapsedMs: number,
  boostCount: number = 0,
  importance: Importance = "default",
  decayRate: number = DEFAULT_DECAY_RATE,
  text?: string,
): number {
  if (importance === "pinned" || (text && isInvariantContent(text))) {
    return PINNED_STRENGTH;
  }

  // Garbage in, floor out. Callers can pass NaN here via unparseable date
  // arithmetic, and NaN propagates through every downstream score
  // comparison (NaN < x is always false, so rankers keep the row and sort
  // unpredictably). A memory we cannot date must rank last, never break
  // ordering. Future-dated (negative) elapsed still clamps to zero below.
  if (
    !Number.isFinite(elapsedMs) ||
    !Number.isFinite(boostCount) ||
    !Number.isFinite(initialStrength) ||
    !Number.isFinite(decayRate)
  ) {
    return MIN_DECAYED_STRENGTH;
  }

  const elapsedDays = Math.max(0, elapsedMs / (1000 * 60 * 60 * 24));
  const savingsFactor = 1.0 + Math.log(1.0 + Math.max(0, boostCount));
  const effectiveDecay = (decayRate * elapsedDays) / savingsFactor;
  const decayed = initialStrength * Math.exp(-effectiveDecay);

  return Math.max(MIN_DECAYED_STRENGTH, Math.min(1.0, decayed));
}

export function boostStrengthOnAccess(currentStrength: number, importance: Importance): number {
  if (importance === "pinned") {
    return PINNED_STRENGTH;
  }
  const boosted = currentStrength + (1.0 - currentStrength) * 0.35;
  return Math.min(1.0, boosted);
}

export function calculateReRankScore(
  item: {
    memoryId: string;
    similarity: number;
    strength: number;
    createdAt?: Date;
    isProjectMatch?: boolean;
  },
  now: Date = new Date(),
): number {
  let score = item.similarity * 0.70 + item.strength * 0.30;
  if (item.isProjectMatch) {
    score += 0.08;
  }
  return score;
}
