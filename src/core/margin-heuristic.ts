export interface RerankCandidate {
  id: string;
  score: number;
}

export interface MarginGateConfig {
  highConfidenceThreshold: number; // e.g. 0.88
  decisiveMarginThreshold: number; // e.g. 0.15
}

export const DEFAULT_MARGIN_GATE_CONFIG: MarginGateConfig = {
  highConfidenceThreshold: 0.88,
  decisiveMarginThreshold: 0.15,
};

/**
 * Evaluates whether expensive neural cross-encoder reranking is needed:
 * H(s) = (s_1 < tau_conf) AND (s_1 - s_2 < Delta_margin)
 */
export function shouldInvokeNeuralReranker(
  candidates: RerankCandidate[],
  config: MarginGateConfig = DEFAULT_MARGIN_GATE_CONFIG,
): boolean {
  if (candidates.length <= 1) {
    return false;
  }

  const s1 = candidates[0]!.score;
  const s2 = candidates[1]!.score;

  if (s1 >= config.highConfidenceThreshold) {
    return false;
  }

  const margin = s1 - s2;
  if (margin >= config.decisiveMarginThreshold) {
    return false;
  }

  return true;
}
