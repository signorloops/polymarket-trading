/**
 * Signal Aggregation Utilities
 *
 * Provides reusable functions for aggregating trading signals from multiple strategies.
 * Supports priority, weighted, and consensus-based aggregation modes.
 */

import type { TradeSignal } from './base.js';

export type AggregationMode = 'priority' | 'weighted' | 'consensus';

export interface AggregatedSignal {
  signal: TradeSignal;
  contributingStrategies: string[];
  confidence: number;
  consensus: number;
}

export interface SignalWithStrategy {
  strategy: string;
  signal: TradeSignal;
}

/**
 * Priority-based aggregation (highest confidence wins)
 *
 * @param signals - Array of signals with strategy names
 * @returns Aggregated signal or null if no signals
 */
export function priorityAggregation(
  signals: SignalWithStrategy[]
): AggregatedSignal | null {
  if (signals.length === 0) return null;

  // Sort by confidence descending
  const sorted = [...signals].sort((a, b) => b.signal.confidence - a.signal.confidence);
  const best = sorted[0]!;

  return {
    signal: best.signal,
    contributingStrategies: [best.strategy],
    confidence: best.signal.confidence,
    consensus: 1 / signals.length,
  };
}

/**
 * Weighted aggregation (average weighted by confidence)
 *
 * @param signals - Array of signals with strategy names
 * @returns Aggregated signal or null if no signals
 */
export function weightedAggregation(
  signals: SignalWithStrategy[]
): AggregatedSignal | null {
  if (signals.length === 0) return null;

  // Group by market
  const byMarket = groupByMarket(signals);

  // Find market with highest total confidence
  let bestMarket: string | null = null;
  let maxConfidence = 0;

  for (const [marketId, marketSignals] of byMarket) {
    const totalConfidence = marketSignals.reduce((sum, s) => sum + s.signal.confidence, 0);
    if (totalConfidence > maxConfidence) {
      maxConfidence = totalConfidence;
      bestMarket = marketId;
    }
  }

  if (!bestMarket) return null;

  const marketSignals = byMarket.get(bestMarket)!;

  // Average signal properties
  const avgPrice =
    marketSignals.reduce((sum, s) => sum + s.signal.price, 0) / marketSignals.length;
  const avgSize =
    marketSignals.reduce((sum, s) => sum + s.signal.size, 0) / marketSignals.length;
  const avgConfidence =
    marketSignals.reduce((sum, s) => sum + s.signal.confidence, 0) / marketSignals.length;

  // Determine direction by majority
  const buyCount = marketSignals.filter((s) => s.signal.type === 'buy').length;
  const direction: 'buy' | 'sell' = buyCount > marketSignals.length / 2 ? 'buy' : 'sell';

  const aggregatedSignal: TradeSignal = {
    type: direction,
    marketId: bestMarket,
    size: avgSize,
    price: avgPrice,
    confidence: avgConfidence,
    reason: `Weighted aggregation: ${marketSignals.map((s) => s.strategy).join(', ')}`,
    metadata: {
      aggregated: true,
      strategyCount: marketSignals.length,
      strategies: marketSignals.map((s) => s.strategy),
      rawSignals: marketSignals.map((s) => s.signal),
    },
  };

  return {
    signal: aggregatedSignal,
    contributingStrategies: marketSignals.map((s) => s.strategy),
    confidence: avgConfidence,
    consensus: marketSignals.length / signals.length,
  };
}

/**
 * Consensus-based aggregation (require minimum agreement)
 *
 * @param signals - Array of signals with strategy names
 * @param totalStrategies - Total number of strategies (for consensus calculation)
 * @param minConsensus - Minimum consensus threshold (0-1)
 * @returns Aggregated signal or null if no consensus
 */
export function consensusAggregation(
  signals: SignalWithStrategy[],
  totalStrategies: number,
  minConsensus: number
): AggregatedSignal | null {
  if (signals.length === 0) return null;

  // Group by market and direction
  const grouped = new Map<string, SignalWithStrategy[]>();

  for (const { strategy, signal } of signals) {
    const key = `${signal.marketId}-${signal.type}`;
    const existing = grouped.get(key) ?? [];
    existing.push({ strategy, signal });
    grouped.set(key, existing);
  }

  // Find group with highest consensus
  let bestKey: string | null = null;
  let bestConsensus = 0;

  for (const [key, groupSignals] of grouped) {
    const consensus = groupSignals.length / totalStrategies;
    if (consensus > bestConsensus && consensus >= minConsensus) {
      bestConsensus = consensus;
      bestKey = key;
    }
  }

  if (!bestKey) return null;

  const bestSignals = grouped.get(bestKey)!;

  // Use weighted average of best group
  const totalConfidence = bestSignals.reduce((sum, s) => sum + s.signal.confidence, 0);
  const avgPrice =
    bestSignals.reduce((sum, s) => sum + s.signal.price * s.signal.confidence, 0) /
    totalConfidence;
  const avgSize =
    bestSignals.reduce((sum, s) => sum + s.signal.size * s.signal.confidence, 0) /
    totalConfidence;

  const aggregatedSignal: TradeSignal = {
    type: bestSignals[0]!.signal.type,
    marketId: bestSignals[0]!.signal.marketId,
    size: avgSize,
    price: avgPrice,
    confidence: totalConfidence / bestSignals.length,
    reason: `Consensus aggregation: ${bestSignals.map((s) => s.strategy).join(', ')}`,
    metadata: {
      aggregated: true,
      consensus: bestConsensus,
      strategies: bestSignals.map((s) => s.strategy),
    },
  };

  return {
    signal: aggregatedSignal,
    contributingStrategies: bestSignals.map((s) => s.strategy),
    confidence: totalConfidence / bestSignals.length,
    consensus: bestConsensus,
  };
}

/**
 * Group signals by market ID
 */
function groupByMarket(
  signals: SignalWithStrategy[]
): Map<string, SignalWithStrategy[]> {
  const grouped = new Map<string, SignalWithStrategy[]>();

  for (const item of signals) {
    const existing = grouped.get(item.signal.marketId) ?? [];
    existing.push(item);
    grouped.set(item.signal.marketId, existing);
  }

  return grouped;
}

/**
 * Aggregate signals based on mode
 *
 * @param signals - Array of signals with strategy names
 * @param mode - Aggregation mode
 * @param totalStrategies - Total number of strategies (for consensus mode)
 * @param minConsensus - Minimum consensus threshold (for consensus mode)
 * @returns Aggregated signal or null
 */
export function aggregateSignals(
  signals: SignalWithStrategy[],
  mode: AggregationMode,
  totalStrategies?: number,
  minConsensus?: number
): AggregatedSignal | null {
  switch (mode) {
    case 'priority':
      return priorityAggregation(signals);
    case 'weighted':
      return weightedAggregation(signals);
    case 'consensus':
      if (totalStrategies === undefined || minConsensus === undefined) {
        throw new Error('totalStrategies and minConsensus required for consensus aggregation');
      }
      return consensusAggregation(signals, totalStrategies, minConsensus);
    default:
      return priorityAggregation(signals);
  }
}
