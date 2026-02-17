/**
 * Arbitrage Detection Utilities
 *
 * Helper functions for analyzing Frank-Wolfe results and computing trade recommendations.
 */

import { ALGORITHM_CONFIG } from '../utils/config.js';
import type { FrankWolfeResult } from './frank-wolfe-types.js';

/**
 * Check if the Frank-Wolfe result indicates profitable arbitrage
 *
 * @param result Frank-Wolfe result
 * @param minProfit Minimum profit threshold
 * @returns Whether arbitrage is profitable
 */
export function isProfitableArbitrage(
  result: FrankWolfeResult,
  minProfit: number = ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD
): boolean {
  // Guaranteed profit = divergence - gap
  const guaranteedProfit = result.objective - result.gap;
  return guaranteedProfit >= minProfit;
}

/**
 * Compute the trade recommendation from Frank-Wolfe result
 *
 * @param result Frank-Wolfe result
 * @param prices Current market prices
 * @returns Recommended trade vector (positive = buy, negative = sell)
 */
export function computeTradeRecommendation(
  result: FrankWolfeResult,
  prices: number[]
): number[] {
  // Trade = projection - prices (positive = buy, negative = sell)
  return result.mu.map((mu_i, i) => mu_i - (prices[i] ?? 0));
}

/**
 * Estimate potential profit from arbitrage
 *
 * @param result Frank-Wolfe result
 * @returns Estimated profit in USD
 */
export function estimateProfit(result: FrankWolfeResult): number {
  return Math.max(0, result.objective - result.gap);
}

/**
 * Compute confidence score for the arbitrage opportunity
 *
 * @param result Frank-Wolfe result
 * @returns Confidence score between 0 and 1
 */
export function computeConfidence(result: FrankWolfeResult): number {
  // Higher gap relative to objective means lower confidence
  if (result.objective <= 0) return 0;
  const relativeGap = result.gap / result.objective;
  return Math.max(0, 1 - relativeGap);
}
