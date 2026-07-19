/**
 * Arbitrage Detection Utilities
 *
 * Helper functions for analyzing Frank-Wolfe results and computing trade recommendations.
 */

import { ALGORITHM_CONFIG } from '../utils/config.js';
import type { FrankWolfeResult } from './frank-wolfe-types.js';

/**
 * Check if the Frank-Wolfe result indicates significant price incoherence.
 *
 * The objective and gap are KL nats, not dollar profit (CORE-9). Prefer
 * isSignificantIncoherence when naming matters for call-site clarity.
 */
export function isProfitableArbitrage(
  result: FrankWolfeResult,
  minProfit: number = ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD
): boolean {
  const incoherenceLowerBound = result.objective - result.gap;
  return incoherenceLowerBound >= minProfit;
}

/**
 * Interpret the Frank-Wolfe objective and duality gap only as a dimensionless
 * incoherence diagnostic. The lower bound is measured in nats, not dollars.
 */
export function isSignificantIncoherence(
  result: FrankWolfeResult,
  minLowerBoundNats: number
): boolean {
  return result.objective - result.gap >= minLowerBoundNats;
}

/**
 * Compute the trade recommendation from Frank-Wolfe result
 *
 * @param result Frank-Wolfe result
 * @param prices Current market prices
 * @returns Recommended trade vector (positive = buy, negative = sell)
 */
export function computeTradeRecommendation(result: FrankWolfeResult, prices: number[]): number[] {
  // Trade = projection - prices (positive = buy, negative = sell)
  return result.mu.map((mu_i, i) => mu_i - (prices[i] ?? 0));
}
