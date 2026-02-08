/**
 * Cross-Market Arbitrage Strategy
 *
 * Detects and executes arbitrage across related markets
 * using marginal polytope constraints
 */

import { BaseStrategy, type StrategyMarketData, type TradeSignal, type StrategyConfig } from './base.js';
import { MarketDependencyGraph } from '../market/dependency-graph.js';
import { bregmanProjection } from '../core/bregman-projection.js';
import { frankWolfe, type FrankWolfeResult } from '../core/frank-wolfe.js';
import { klDivergence } from '../utils/math.js';

export interface CrossMarketArbitrageConfig extends StrategyConfig {
  /** Minimum profit threshold ($) */
  minProfitThreshold: number;
  /** Maximum Frank-Wolfe iterations */
  maxIterations: number;
  /** Alpha extraction threshold (0-1) */
  alpha: number;
}

export interface CrossMarketOpportunity {
  markets: string[];
  tradeVector: number[];
  expectedProfit: number;
  confidence: number;
  frankWolfeResult: FrankWolfeResult;
}

export class CrossMarketArbitrageStrategy extends BaseStrategy {
  private crossConfig: CrossMarketArbitrageConfig;
  private dependencyGraph: MarketDependencyGraph;

  constructor(config: Partial<CrossMarketArbitrageConfig> = {}) {
    super('CrossMarketArbitrage', config);
    this.crossConfig = {
      minProfitThreshold: 0.05,
      maxIterations: 100,
      alpha: 0.9,
      ...config,
    };
    this.dependencyGraph = new MarketDependencyGraph();
  }

  /**
   * Analyze cross-market opportunities using marginal polytope
   */
  analyze(data: StrategyMarketData[]): TradeSignal | null {
    if (!this.canTrade()) return null;

    const opportunity = this.findCrossMarketOpportunity(data);
    if (!opportunity || opportunity.expectedProfit < this.crossConfig.minProfitThreshold) {
      return null;
    }

    if (opportunity.confidence < (this.config.minConfidence ?? 0.5)) return null;

    this.recordTrade();

    // Return primary trade (largest position)
    const maxIdx = opportunity.tradeVector
      .map((x, i) => ({ val: Math.abs(x), idx: i }))
      .sort((a, b) => b.val - a.val)[0]?.idx ?? 0;

    const primaryMarket = data[maxIdx];
    if (!primaryMarket) return null;

    const direction = opportunity.tradeVector[maxIdx]! > 0 ? 'buy' : 'sell';
    const size = Math.abs(opportunity.tradeVector[maxIdx]!);

    return {
      type: direction,
      marketId: primaryMarket.marketId,
      size: Math.min(size, this.config.maxPositionSize ?? 1000),
      price: primaryMarket.lastPrice,
      confidence: opportunity.confidence,
      reason: `Cross-market arbitrage: profit=${opportunity.expectedProfit.toFixed(4)}, markets=${opportunity.markets.length}`,
      metadata: {
        arbitrageType: 'cross-market',
        tradeVector: opportunity.tradeVector,
        expectedProfit: opportunity.expectedProfit,
        frankWolfeIterations: opportunity.frankWolfeResult.iterations,
        allMarkets: opportunity.markets,
      },
    };
  }

  /**
   * Find cross-market arbitrage opportunity using Bregman projection
   */
  private findCrossMarketOpportunity(data: StrategyMarketData[]): CrossMarketOpportunity | null {
    if (data.length < 2) return null;

    // Build dependency graph from market relationships
    for (const market of data) {
      this.dependencyGraph.addMarket({
        id: market.marketId,
        eventId: this.extractEventId(market.marketId),
        outcome: this.extractOutcome(market.marketId),
        price: market.lastPrice,
        metadata: {},
      });
    }

    // Build constraints from dependency graph
    const constraintMatrix = this.dependencyGraph.buildConstraintMatrix();
    const constraints = constraintMatrix.types.map((type, i) => ({
      coefficients: constraintMatrix.coefficients[i]!,
      rhs: constraintMatrix.rhs[i]!,
      type,
    }));

    // Get current prices as theta
    const theta = data.map((m) => m.lastPrice);

    // Objective function: KL divergence
    const objectiveFn = (mu: number[]): number => klDivergence(mu, theta);

    // Gradient function
    const gradientFn = (mu: number[]): number[] => {
      const epsilon = 1e-10;
      return mu.map((m, i) => Math.log(Math.max(m, epsilon) / Math.max(theta[i]!, epsilon)) + 1);
    };

    // Linear minimization oracle with constraints
    const lmoFn = (grad: number[]): number[] => {
      const n = grad.length;
      const vertex = new Array(n).fill(0);

      // Simplex constraint: sum = 1
      let minIdx = 0;
      let minValue = grad[0]!;
      for (let i = 1; i < n; i++) {
        if (grad[i]! < minValue) {
          minValue = grad[i]!;
          minIdx = i;
        }
      }
      vertex[minIdx] = 1;
      return vertex;
    };

    // Initial point
    const initialMu = new Array(theta.length).fill(1 / theta.length);

    // Run Frank-Wolfe optimization
    const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
      maxIterations: this.crossConfig.maxIterations,
      tolerance: 1e-6,
      stepSize: 'adaptive',
    });

    // Calculate guaranteed profit
    const divergence = klDivergence(result.mu, theta);
    const guaranteedProfit = divergence - result.gap;

    if (guaranteedProfit < this.crossConfig.minProfitThreshold) {
      return null;
    }

    // Calculate trade vector (difference from current prices)
    const tradeVector = result.mu.map((m, i) => (m - theta[i]!) * 100);

    // Confidence based on convergence and profit
    const confidence = Math.min(
      (1 - result.gap / Math.max(divergence, 1e-10)) * this.crossConfig.alpha,
      1.0
    );

    return {
      markets: data.map((m) => m.marketId),
      tradeVector,
      expectedProfit: guaranteedProfit,
      confidence,
      frankWolfeResult: result,
    };
  }

  /**
   * Extract event ID from market ID
   */
  private extractEventId(marketId: string): string {
    // Assume format: event-outcome or event_outcome
    const parts = marketId.split(/[-_]/);
    return parts.slice(0, -1).join('-') || marketId;
  }

  /**
   * Extract outcome from market ID
   */
  private extractOutcome(marketId: string): 'YES' | 'NO' {
    const lower = marketId.toLowerCase();
    if (lower.endsWith('-yes') || lower.endsWith('_yes')) return 'YES';
    if (lower.endsWith('-no') || lower.endsWith('_no')) return 'NO';
    return 'YES'; // Default
  }

  /**
   * Add explicit market dependency
   */
  addDependency(marketId1: string, marketId2: string, type: 'mutex' | 'implies'): void {
    this.dependencyGraph.addEdge({
      from: marketId1,
      to: marketId2,
      type: type === 'mutex' ? 'mutually_exclusive' : 'implies',
      weight: 1,
    });
  }
}
