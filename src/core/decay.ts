import type { Importance } from "../schema/index.js";

export const DEFAULT_DECAY_RATE = 0.05; // ~14 day effective half-life
export const PINNED_STRENGTH = 1.0;
export const HIGH_INITIAL_STRENGTH = 0.85;
export const DEFAULT_INITIAL_STRENGTH = 0.70;

export function getInitialStrength(importance: Importance): number {
  switch (importance) {
    case "pinned":
      return PINNED_STRENGTH;
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
): number {
  if (importance === "pinned") {
    return PINNED_STRENGTH;
  }

  const elapsedDays = Math.max(0, elapsedMs / (1000 * 60 * 60 * 24));
  const savingsFactor = 1.0 + Math.log(1.0 + Math.max(0, boostCount));
  const effectiveDecay = (decayRate * elapsedDays) / savingsFactor;
  const decayed = initialStrength * Math.exp(-effectiveDecay);

  return Math.max(0.01, Math.min(1.0, decayed));
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
