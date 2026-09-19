import type { LLMResponse } from "../llm/types.js";

/**
 * Cost units are miss-token equivalents. Defaults follow deepseek-flash off-peak
 * prices per million: hit $0.003, miss $0.15, output $0.60. Peak doubles every
 * price, so the ratios hold; usdPerMillion is the off-peak miss price.
 */
export interface CostWeights {
  hit: number;
  miss: number;
  completion: number;
  usdPerMillion: number;
}

export const DEFAULT_WEIGHTS: CostWeights = { hit: 0.02, miss: 1, completion: 4, usdPerMillion: 0.15 };

export interface CallUsage {
  hit: number;
  miss: number;
  completion: number;
}

export function splitUsage(u: LLMResponse["usage"]): CallUsage {
  if (!u) return { hit: 0, miss: 0, completion: 0 };
  const hit = u.promptHit ?? 0;
  const miss = u.promptMiss ?? Math.max(0, u.prompt - hit);
  return { hit, miss, completion: u.completion };
}

export function callCost(u: CallUsage, w: CostWeights): number {
  return Math.ceil(u.miss * w.miss + u.hit * w.hit + u.completion * w.completion);
}

export function usd(cost: number, w: CostWeights): number {
  return (cost / 1_000_000) * w.usdPerMillion;
}
