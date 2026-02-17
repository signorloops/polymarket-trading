/**
 * Arbitrage Detector for Polymarket
 *
 * Detects arbitrage opportunities in prediction markets:
 * 1. Single-market arbitrage: YES + NO ≠ $1
 * 2. Cross-market arbitrage: Inconsistent probabilities across related markets
 *
 * Uses the marginal polytope framework to detect and score arbitrage opportunities.
 */

import { MarginalPolytope, Event } from '../core/marginal-polytope.js';
import { BregmanProjectionResult } from '../core/bregman-projection.js';
import {
  frankWolfe,
  isProfitableArbitrage,
  linearMinimizationOracle as fwLinearMinimizationOracle,
} from '../core/frank-wolfe.js';
import { initFW } from '../core/init-fw.js';
import { vectorSubtract, klDivergence } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';
import { OrderBook } from './order-book.js';

export interface ArbitrageOpportunity {
  id: string;
  type: 'single-market' | 'cross-market';
  markets: string[];
  expectedProfit: number;
  guaranteedProfit: number;
  confidence: number;
  tradeDirection: number[];
  timestamp: number;
  expiresAt: number;
}

export interface SingleMarketArbitrage {
  eventId: string;
  yesMarketId: string;
  noMarketId: string;
  yesPrice: number;
  noPrice: number;
  sum: number;
  deviation: number;
  profitPotential: number;
}

export interface CrossMarketArbitrage {
  markets: string[];
  prices: number[];
  projection: number[];
  divergence: number;
  gap: number;
  guaranteedProfit: number;
}

export class ArbitrageDetector {
  private polytope: MarginalPolytope;
  private logger = getLogger().child({ module: 'ArbitrageDetector' });
  private lastResults: Map<string, BregmanProjectionResult> = new Map();

  constructor() {
    this.polytope = new MarginalPolytope();
  }

  /**
   * Add an event to the detector
   */
  addEvent(event: Event): void {
    this.polytope.addEvent(event);
    this.logger.debug(`Added event ${event.id}`);
  }

  /**
   * Update market price
   */
  updatePrice(marketId: string, price: number): void {
    this.polytope.updateMarketPrice(marketId, price);
  }

  /**
   * Detect single-market arbitrage opportunities
   * Returns opportunities where YES + NO ≠ 1
   */
  detectSingleMarketArbitrage(tolerance = 0.01): SingleMarketArbitrage[] {
    const opportunities: SingleMarketArbitrage[] = [];
    const events = this.getEventsFromPolytope();

    for (const event of events) {
      if (event.markets.length === 2) {
        const yesMarket = event.markets.find((m) => m.outcome === 'YES');
        const noMarket = event.markets.find((m) => m.outcome === 'NO');

        if (yesMarket && noMarket) {
          const sum = yesMarket.price + noMarket.price;
          const deviation = Math.abs(sum - 1);

          if (deviation > tolerance) {
            // Calculate profit potential
            // If sum < 1, buy both YES and NO for guaranteed profit
            // If sum > 1, sell both (short) for guaranteed profit
            const profitPotential = Math.abs(1 - sum);

            opportunities.push({
              eventId: event.id,
              yesMarketId: yesMarket.id,
              noMarketId: noMarket.id,
              yesPrice: yesMarket.price,
              noPrice: noMarket.price,
              sum,
              deviation,
              profitPotential,
            });

            this.logger.info(
              `Single-market arbitrage: ${event.id}, YES=${yesMarket.price.toFixed(4)}, NO=${noMarket.price.toFixed(4)}, sum=${sum.toFixed(4)}`
            );
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * Detect cross-market arbitrage using Frank-Wolfe optimization
   */
  detectCrossMarketArbitrage(): CrossMarketArbitrage | null {
    const markets = this.polytope.getMarkets();
    if (markets.length < 2) {
      return null;
    }

    const prices = this.polytope.getPriceVector();
    const constraints = this.polytope.getConstraints();

    // Initialize with InitFW
    const initResult = initFW(
      prices.length,
      (mu) => this.computeGradient(mu, prices),
      (mu) => klDivergence(mu, prices),
      { initIterations: 5 }
    );

    // Run Frank-Wolfe
    const fwResult = frankWolfe(
      initResult.initialPoint,
      (mu) => klDivergence(Array.from(mu), prices),
      (mu) => this.computeGradient(Array.from(mu), prices),
      (grad: number[] | Float64Array) => this.linearMinimizationOracle([...Array.from(grad)], constraints),
      {
        maxIterations: ALGORITHM_CONFIG.MAX_ITERATIONS,
        tolerance: ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
        stepSize: 'line-search',
      }
    );

    // Check if profitable
    const guaranteedProfit = fwResult.objective - fwResult.gap;

    if (isProfitableArbitrage(fwResult, ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD)) {
      this.logger.info(`Cross-market arbitrage detected`, {
        markets: markets.length,
        divergence: fwResult.objective,
        gap: fwResult.gap,
        guaranteedProfit,
      });

      return {
        markets: markets.map((m) => m.id),
        prices,
        projection: fwResult.mu,
        divergence: fwResult.objective,
        gap: fwResult.gap,
        guaranteedProfit,
      };
    }

    return null;
  }

  /**
   * Find all arbitrage opportunities
   */
  findAllOpportunities(): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    const timestamp = Date.now();
    const expiresAt = timestamp + 60000; // 1 minute validity

    // Single-market arbitrage
    const singleMarket = this.detectSingleMarketArbitrage();
    for (const arb of singleMarket) {
      opportunities.push({
        id: `single-${arb.eventId}-${String(timestamp)}`,
        type: 'single-market',
        markets: [arb.yesMarketId, arb.noMarketId],
        expectedProfit: arb.profitPotential,
        guaranteedProfit: arb.profitPotential * 0.9, // Conservative estimate
        confidence: Math.min(arb.deviation * 10, 1),
        tradeDirection: this.computeSingleMarketTrade(arb),
        timestamp,
        expiresAt,
      });
    }

    // Cross-market arbitrage
    const crossMarket = this.detectCrossMarketArbitrage();
    if (crossMarket) {
      opportunities.push({
        id: `cross-${crossMarket.markets.join('-')}-${String(timestamp)}`,
        type: 'cross-market',
        markets: crossMarket.markets,
        expectedProfit: crossMarket.divergence,
        guaranteedProfit: crossMarket.guaranteedProfit,
        confidence: Math.min(crossMarket.guaranteedProfit / crossMarket.divergence, 1),
        tradeDirection: vectorSubtract(crossMarket.projection, crossMarket.prices),
        timestamp,
        expiresAt,
      });
    }

    return opportunities.sort((a, b) => b.guaranteedProfit - a.guaranteedProfit);
  }

  /**
   * Score an arbitrage opportunity based on multiple factors
   */
  scoreOpportunity(opportunity: ArbitrageOpportunity, orderBooks: Map<string, OrderBook>): number {
    let score = opportunity.guaranteedProfit;

    // Adjust for liquidity
    for (const marketId of opportunity.markets) {
      const book = orderBooks.get(marketId);
      if (book) {
        const liquidity = book.getLiquidityMetrics();
        if (liquidity) {
          // Reduce score for low liquidity
          const liquidityFactor = Math.min(liquidity.bidDepth, liquidity.askDepth) / 1000;
          score *= Math.min(liquidityFactor, 1);
        }
      }
    }

    // Adjust for confidence
    score *= opportunity.confidence;

    // Time decay (urgency)
    const timeRemaining = opportunity.expiresAt - Date.now();
    const urgencyFactor = Math.max(0, timeRemaining / 60000);
    score *= urgencyFactor;

    return score;
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.polytope.clear();
    this.lastResults.clear();
  }

  private computeGradient(mu: number[], theta: number[]): number[] {
    // Gradient of KL divergence: ∇_μ D(μ||θ) = log(μ/θ) + 1
    const epsilon = 1e-10;
    return mu.map((m, i) => {
      const safeMu = Math.max(m, epsilon);
      const thetaValue = theta[i];
      const safeTheta = thetaValue === undefined ? epsilon : Math.max(thetaValue, epsilon);
      return Math.log(safeMu / safeTheta) + 1;
    });
  }

  private linearMinimizationOracle(
    gradient: number[],
    constraints: { coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }[]
  ): number[] {
    return fwLinearMinimizationOracle(gradient, constraints);
  }

  private computeSingleMarketTrade(arb: SingleMarketArbitrage): number[] {
    // Trade direction: positive = buy, negative = sell
    if (arb.sum < 1) {
      // Buy both YES and NO
      return [1 - arb.yesPrice, 1 - arb.noPrice];
    } else {
      // Sell both (represented as negative buy)
      return [-arb.yesPrice, -arb.noPrice];
    }
  }

  private getEventsFromPolytope(): Event[] {
    // Access internal state through markets
    const markets = this.polytope.getMarkets();
    const eventMap = new Map<string, Event>();

    for (const market of markets) {
      // Extract event ID from market (assuming format: eventId-outcome)
      const eventId = market.eventId;

      if (!eventMap.has(eventId)) {
        eventMap.set(eventId, {
          id: eventId,
          markets: [],
          outcomes: ['YES', 'NO'],
        });
      }

      const event = eventMap.get(eventId);
      if (event) {
        event.markets.push(market);
      }
    }

    return Array.from(eventMap.values());
  }
}

/**
 * Create a singleton arbitrage detector
 */
let globalDetector: ArbitrageDetector | null = null;

export function getArbitrageDetector(): ArbitrageDetector {
  globalDetector ??= new ArbitrageDetector();
  return globalDetector;
}

/**
 * Reset the global detector (for testing)
 */
export function resetArbitrageDetector(): void {
  globalDetector = null;
}
