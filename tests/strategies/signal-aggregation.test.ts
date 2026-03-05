/**
 * Signal Aggregation Tests
 */

import {
  priorityAggregation,
  weightedAggregation,
  consensusAggregation,
  aggregateSignals,
  type SignalWithStrategy,
} from '../../src/strategies/signal-aggregation.js';
import type { TradeSignal } from '../../src/strategies/base.js';

describe('priorityAggregation', () => {
  it('should return null for empty signals', () => {
    expect(priorityAggregation([])).toBeNull();
  });

  it('should return highest confidence signal', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.6) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.9) },
      { strategy: 's3', signal: createSignal('market-1', 'buy', 0.7) },
    ];

    const result = priorityAggregation(signals);
    expect(result).not.toBeNull();
    expect(result!.signal.confidence).toBe(0.9);
    expect(result!.contributingStrategies).toContain('s2');
  });

  it('should calculate consensus correctly', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'sell', 0.7) },
    ];

    const result = priorityAggregation(signals)!;
    expect(result.consensus).toBe(0.5);
  });
});

describe('weightedAggregation', () => {
  it('should return null for empty signals', () => {
    expect(weightedAggregation([])).toBeNull();
  });

  it('should aggregate by market with highest total confidence', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.9, 100, 0.5) },
      { strategy: 's2', signal: createSignal('market-2', 'buy', 0.6, 200, 0.6) },
      { strategy: 's3', signal: createSignal('market-1', 'buy', 0.8, 150, 0.55) },
    ];

    const result = weightedAggregation(signals);
    expect(result).not.toBeNull();
    expect(result!.signal.marketId).toBe('market-1');
  });

  it('should confidence-weight price and size', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8, 100, 0.5) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.6, 200, 0.6) },
    ];

    const result = weightedAggregation(signals)!;
    expect(result.signal.price).toBeCloseTo(0.5429, 3);
    expect(result.signal.size).toBeCloseTo(142.8571, 3);
  });

  it('should determine direction by majority', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.7) },
      { strategy: 's3', signal: createSignal('market-1', 'sell', 0.6) },
    ];

    const result = weightedAggregation(signals)!;
    expect(result.signal.type).toBe('buy');
  });

  it('should include metadata', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.7) },
    ];

    const result = weightedAggregation(signals)!;
    expect(result.signal.metadata).toBeDefined();
    expect(result.signal.metadata!.aggregated).toBe(true);
    expect(result.signal.metadata!.strategies).toContain('s1');
  });

  it('should weight price and size by confidence', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.9, 100, 0.4) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.1, 100, 0.8) },
    ];

    const result = weightedAggregation(signals)!;
    // Weighted price = (0.4*0.9 + 0.8*0.1) / (0.9+0.1) = 0.44
    expect(result.signal.price).toBeCloseTo(0.44, 3);
  });

  it('should determine direction by confidence-weighted vote', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.2) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.2) },
      { strategy: 's3', signal: createSignal('market-1', 'sell', 0.95) },
    ];

    const result = weightedAggregation(signals)!;
    expect(result.signal.type).toBe('sell');
  });
});

describe('consensusAggregation', () => {
  it('should return null for empty signals', () => {
    expect(consensusAggregation([], 5, 0.5)).toBeNull();
  });

  it('should require minimum consensus', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.7) },
    ];

    // 2/5 = 0.4 consensus, min is 0.5
    const result = consensusAggregation(signals, 5, 0.5);
    expect(result).toBeNull();
  });

  it('should return signal when consensus met', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'buy', 0.7) },
      { strategy: 's3', signal: createSignal('market-1', 'buy', 0.9) },
    ];

    // 3/4 = 0.75 consensus
    const result = consensusAggregation(signals, 4, 0.5);
    expect(result).not.toBeNull();
    expect(result!.consensus).toBe(0.75);
  });

  it('should group by market and direction', () => {
    const signals: SignalWithStrategy[] = [
      { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
      { strategy: 's2', signal: createSignal('market-1', 'sell', 0.7) },
      { strategy: 's3', signal: createSignal('market-1', 'buy', 0.9) },
      { strategy: 's4', signal: createSignal('market-1', 'sell', 0.6) },
    ];

    // 2 buys vs 2 sells, both have 0.5 consensus with 4 strategies
    const result = consensusAggregation(signals, 4, 0.4);
    expect(result).not.toBeNull();
  });
});

describe('aggregateSignals', () => {
  const signals: SignalWithStrategy[] = [
    { strategy: 's1', signal: createSignal('market-1', 'buy', 0.8) },
    { strategy: 's2', signal: createSignal('market-1', 'buy', 0.7) },
  ];

  it('should use priority mode', () => {
    const result = aggregateSignals(signals, 'priority');
    expect(result).not.toBeNull();
    expect(result!.signal.confidence).toBe(0.8);
  });

  it('should use weighted mode', () => {
    const result = aggregateSignals(signals, 'weighted');
    expect(result).not.toBeNull();
  });

  it('should use consensus mode', () => {
    const result = aggregateSignals(signals, 'consensus', 2, 0.5);
    expect(result).not.toBeNull();
    expect(result!.consensus).toBe(1); // 2/2
  });

  it('should default to priority for unknown mode', () => {
    const result = aggregateSignals(signals, 'unknown' as any);
    expect(result).not.toBeNull();
    expect(result!.signal.confidence).toBe(0.8);
  });

  it('should throw for consensus without params', () => {
    expect(() => aggregateSignals(signals, 'consensus')).toThrow(
      'totalStrategies and minConsensus required'
    );
  });
});

function createSignal(
  marketId: string,
  type: 'buy' | 'sell',
  confidence: number,
  size = 100,
  price = 0.5
): TradeSignal {
  return {
    type,
    marketId,
    size,
    price,
    confidence,
    reason: 'test',
  };
}
