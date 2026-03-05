/**
 * Cross-Market Arbitrage Strategy
 *
 * Detects and executes arbitrage across related markets
 * using marginal polytope constraints
 */

import {
  BaseStrategy,
  type StrategyMarketData,
  type TradeSignal,
  type StrategyConfig,
} from './base.js';
import { MarketDependencyGraph } from '../market/dependency-graph.js';
import {
  frankWolfe,
  linearMinimizationOracle,
  type FrankWolfeResult,
  type Constraint,
} from '../core/frank-wolfe.js';
import { generalizedKLDivergence } from '../utils/math.js';

export interface CrossMarketArbitrageConfig extends StrategyConfig {
  /** Minimum guaranteed-profit threshold (divergence units) */
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

interface RegisteredDependency {
  fromEventId: string;
  toEventId: string;
  type: 'mutually_exclusive' | 'implies';
}

export class CrossMarketArbitrageStrategy extends BaseStrategy {
  private crossConfig: CrossMarketArbitrageConfig;
  private dependencyGraph: MarketDependencyGraph;
  private registeredDependencies: RegisteredDependency[] = [];

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
    const maxIdx =
      opportunity.tradeVector
        .map((x, i) => ({ val: Math.abs(x), idx: i }))
        .sort((a, b) => b.val - a.val)[0]?.idx ?? 0;

    const primaryMarket = data[maxIdx];
    if (!primaryMarket) return null;

    const tradeValue = opportunity.tradeVector[maxIdx];
    if (tradeValue === undefined) return null;

    const direction = tradeValue > 0 ? 'buy' : 'sell';
    const size = Math.abs(tradeValue);

    return {
      type: direction,
      marketId: primaryMarket.marketId,
      size: Math.min(size, this.config.maxPositionSize ?? 1000),
      price: primaryMarket.lastPrice,
      confidence: opportunity.confidence,
      reason: `Cross-market arbitrage: profit=${opportunity.expectedProfit.toFixed(4)}, markets=${opportunity.markets.length.toString()}`,
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

    this.dependencyGraph.clear();

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
    this.applyRegisteredDependencies();

    // Build constraints from dependency graph
    const matrix = this.dependencyGraph.buildConstraintMatrix();
    const constraints: Constraint[] = matrix.coefficients.map((coefficients, i) => ({
      coefficients,
      rhs: matrix.rhs[i] ?? 0,
      type: matrix.types[i] ?? 'inequality',
    }));

    // Get current prices as theta
    const epsilon = 1e-10;
    const theta = data.map((m) => {
      const value = m.lastPrice;
      if (!Number.isFinite(value)) {
        return Number.NaN;
      }
      return Math.max(value, epsilon);
    });
    if (theta.some((v) => !Number.isFinite(v))) {
      return null;
    }

    // Objective function: generalized KL (non-negative even when distributions are unnormalized)
    const objectiveFn = (mu: number[] | Float64Array): number =>
      generalizedKLDivergence(Array.from(mu), theta);

    // Gradient function
    const gradientFn = (mu: number[] | Float64Array): number[] => {
      return Array.from(mu).map((m, i) => {
        const thetaVal = theta[i];
        if (thetaVal === undefined) return 0;
        return Math.log(Math.max(m, epsilon) / Math.max(thetaVal, epsilon));
      });
    };

    // Linear minimization oracle with constraints
    const lmoFn = (grad: number[] | Float64Array): number[] =>
      linearMinimizationOracle(Array.from(grad), constraints);

    // Build a feasible initial point for event-level equality constraints.
    const initialMu = this.buildFeasibleInitialPoint(theta, constraints);

    // Run Frank-Wolfe optimization
    const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
      maxIterations: this.crossConfig.maxIterations,
      tolerance: 1e-6,
      stepSize: 'line-search',
    });

    // Calculate guaranteed profit
    const divergence = generalizedKLDivergence(result.mu, theta);
    const guaranteedProfit = Math.max(0, divergence - Math.max(result.gap, 0));
    const expectedProfit = Math.max(divergence, guaranteedProfit);

    if (expectedProfit < this.crossConfig.minProfitThreshold) {
      return null;
    }

    // Calculate trade vector (difference from current prices)
    const tradeVector = result.mu.map((m, i) => {
      const thetaVal = theta[i];
      if (thetaVal === undefined) return 0;
      return m - thetaVal;
    });

    // Confidence based on convergence and profit
    const convergenceConfidence = divergence / (divergence + Math.max(result.gap, 0) + 1e-10);
    const confidence = Math.min(0.5 + 0.5 * convergenceConfidence * this.crossConfig.alpha, 1.0);

    return {
      markets: data.map((m) => m.marketId),
      tradeVector,
      expectedProfit,
      confidence,
      frankWolfeResult: result,
    };
  }

  /**
   * Extract event ID from market ID
   */
  private extractEventId(marketId: string): string {
    const normalized = marketId.trim();
    const match = /^(.*?)(?:[-_](yes|no))$/i.exec(normalized);
    if (match?.[1]) {
      return match[1];
    }
    return normalized;
  }

  /**
   * Extract outcome from market ID
   */
  private extractOutcome(marketId: string): 'YES' | 'NO' | 'UNKNOWN' {
    const lower = marketId.toLowerCase();
    if (lower.endsWith('-yes') || lower.endsWith('_yes')) return 'YES';
    if (lower.endsWith('-no') || lower.endsWith('_no')) return 'NO';
    return 'UNKNOWN';
  }

  private buildFeasibleInitialPoint(theta: number[], constraints: Constraint[]): number[] {
    const n = theta.length;
    const initial = new Array<number>(n).fill(0);
    const assigned = new Set<number>();

    const equalityConstraints = constraints.filter(
      (c) => c.type === 'equality' && c.coefficients.some((coef) => coef > 0)
    );

    if (equalityConstraints.length === 0) {
      const uniform = 1 / n;
      return new Array<number>(n).fill(uniform);
    }

    for (const constraint of equalityConstraints) {
      const support: number[] = [];
      for (let i = 0; i < n; i++) {
        if ((constraint.coefficients[i] ?? 0) > 0) {
          support.push(i);
        }
      }
      if (support.length === 0) {
        continue;
      }

      let sum = 0;
      for (const idx of support) {
        sum += Math.max(theta[idx] ?? 0, 1e-12);
      }

      const target = constraint.rhs;
      if (sum <= 0) {
        const uniform = target / support.length;
        for (const idx of support) {
          initial[idx] = uniform;
          assigned.add(idx);
        }
      } else {
        for (const idx of support) {
          const value = Math.max(theta[idx] ?? 0, 1e-12);
          initial[idx] = (target * value) / sum;
          assigned.add(idx);
        }
      }
    }

    // Fallback for variables not covered by equality constraints.
    const remaining = n - assigned.size;
    if (remaining > 0) {
      const fallback = 1 / remaining;
      for (let i = 0; i < n; i++) {
        if (!assigned.has(i)) {
          initial[i] = fallback;
        }
      }
    }

    return initial;
  }

  /**
   * Add explicit market dependency
   */
  addDependency(marketId1: string, marketId2: string, type: 'mutex' | 'implies'): void {
    const fromEventId = this.extractEventId(marketId1);
    const toEventId = this.extractEventId(marketId2);
    if (fromEventId === toEventId) {
      return;
    }

    const normalizedType: RegisteredDependency['type'] =
      type === 'mutex' ? 'mutually_exclusive' : 'implies';
    const alreadyRegistered = this.registeredDependencies.some(
      (dep) =>
        dep.fromEventId === fromEventId &&
        dep.toEventId === toEventId &&
        dep.type === normalizedType
    );
    if (!alreadyRegistered) {
      this.registeredDependencies.push({
        fromEventId,
        toEventId,
        type: normalizedType,
      });
    }
  }

  private applyRegisteredDependencies(): void {
    for (const dep of this.registeredDependencies) {
      this.dependencyGraph.addEdge({
        from: dep.fromEventId,
        to: dep.toEventId,
        type: dep.type,
        weight: 1,
      });
    }
  }
}
