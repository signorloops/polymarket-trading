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
  isSignificantIncoherence,
  linearMinimizationOracle as fwLinearMinimizationOracle,
} from '../core/frank-wolfe.js';
import { generalizedKLDivergence } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import { ALGORITHM_CONFIG } from '../utils/config.js';
import { TradingMetrics } from '../utils/metrics.js';
import { OrderBook } from './order-book.js';
import { createSingleton } from '../utils/singleton.js';
import {
  findDollarPayoffArbitrage,
  validatePayoffModel,
  type CrossMarketPayoffModel,
} from './payoff-model.js';
import type { TakerFeeSchedule } from '../api/polymarket-client.js';

export interface ArbitrageOpportunity {
  id: string;
  type: 'single-market' | 'cross-market';
  markets: string[];
  expectedProfit: number;
  guaranteedProfit: number;
  profitUnit: 'USD';
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

export interface CrossMarketIncoherenceDiagnostic {
  markets: string[];
  prices: number[];
  projection: number[];
  divergenceNats: number;
  dualityGapNats: number;
  lowerBoundNats: number;
}

export interface ArbitrageDetectorOptions {
  maxOrderBookAgeMs?: number;
  maxSingleMarketShares?: number;
  conservativeTakerFeeRate?: number;
  maxTakerFeeAgeMs?: number;
}

export class ArbitrageDetector {
  private polytope: MarginalPolytope;
  private logger = getLogger().child({ module: 'ArbitrageDetector' });
  private lastResults: Map<string, BregmanProjectionResult> = new Map();
  private payoffModels: CrossMarketPayoffModel[];
  private readonly maxOrderBookAgeMs: number;
  private readonly maxSingleMarketShares: number;
  private readonly conservativeTakerFeeRate: number;
  private readonly maxTakerFeeAgeMs: number;
  private readonly takerFeeSchedules = new Map<string, TakerFeeSchedule>();

  constructor(payoffModels: CrossMarketPayoffModel[] = [], options: ArbitrageDetectorOptions = {}) {
    this.polytope = new MarginalPolytope();
    for (const model of payoffModels) {
      validatePayoffModel(model);
    }
    this.payoffModels = [...payoffModels];
    this.maxOrderBookAgeMs = options.maxOrderBookAgeMs ?? 5000;
    this.maxSingleMarketShares = options.maxSingleMarketShares ?? 100;
    this.conservativeTakerFeeRate = options.conservativeTakerFeeRate ?? 0.07;
    this.maxTakerFeeAgeMs = options.maxTakerFeeAgeMs ?? 10 * 60 * 1000;
  }

  setPayoffModels(payoffModels: CrossMarketPayoffModel[]): void {
    for (const model of payoffModels) {
      validatePayoffModel(model);
    }
    this.payoffModels = [...payoffModels];
  }

  /** Replace cached dynamic fee parameters after a successful public API refresh. */
  setTakerFeeSchedules(schedules: readonly TakerFeeSchedule[]): void {
    for (const schedule of schedules) {
      if (
        schedule.tokenId.trim() === '' ||
        !Number.isFinite(schedule.rate) ||
        schedule.rate < 0 ||
        schedule.rate > 1 ||
        !Number.isFinite(schedule.exponent) ||
        schedule.exponent < 0 ||
        schedule.exponent > 10 ||
        !Number.isFinite(schedule.fetchedAt) ||
        schedule.fetchedAt <= 0
      ) {
        throw new Error(`Invalid taker fee schedule for token ${schedule.tokenId}`);
      }
      this.takerFeeSchedules.set(schedule.tokenId, schedule);
    }
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

  /** Diagnose probability incoherence using Frank-Wolfe optimization. */
  diagnoseCrossMarketIncoherence(): CrossMarketIncoherenceDiagnostic | null {
    const markets = this.polytope.getMarkets();
    if (markets.length < 2) {
      return null;
    }

    const prices = this.polytope.getPriceVector();
    const constraints = this.polytope.getConstraints();

    // Start from a polytope-feasible point to preserve equality constraints.
    const initialPoint = this.polytope.project(prices);

    // Run Frank-Wolfe
    const fwResult = frankWolfe(
      initialPoint,
      (mu) => generalizedKLDivergence(Array.from(mu), prices),
      (mu) => this.computeGradient(Array.from(mu), prices),
      (grad: number[] | Float64Array) =>
        this.linearMinimizationOracle([...Array.from(grad)], constraints),
      {
        maxIterations: ALGORITHM_CONFIG.MAX_ITERATIONS,
        tolerance: ALGORITHM_CONFIG.CONVERGENCE_THRESHOLD,
        stepSize: 'line-search',
      }
    );

    // `objective - gap` is a KL-divergence lower bound in NATS (dimensionless),
    // not dollars. It is a useful research signal
    // that the markets are mispriced relative to the marginal polytope, but it is
    // not comparable to a dollar threshold and does not account for fills, depth,
    // or fees. Converting it to a real dollar-payoff estimate requires modeling the
    // cross-market arbitrage's payoff structure (which outcomes pay across markets),
    // which this Frank-Wolfe-on-probabilities formulation does not expose. Until
    // that payoff model exists, cross-market execution must use findDollarPayoffArbitrage.
    const lowerBoundNats = fwResult.objective - fwResult.gap;
    TradingMetrics.frankWolfeIterations.observe({}, fwResult.iterations);
    TradingMetrics.frankWolfeGap.observe({}, fwResult.gap);

    if (isSignificantIncoherence(fwResult, ALGORITHM_CONFIG.MIN_PROFIT_THRESHOLD)) {
      this.logger.info(`Cross-market probability incoherence detected`, {
        markets: markets.length,
        divergenceNats: fwResult.objective,
        dualityGapNats: fwResult.gap,
        lowerBoundNats,
      });

      return {
        markets: markets.map((m) => m.id),
        prices,
        projection: fwResult.mu,
        divergenceNats: fwResult.objective,
        dualityGapNats: fwResult.gap,
        lowerBoundNats,
      };
    }

    return null;
  }

  /**
   * Find all arbitrage opportunities
   */
  findAllOpportunities(orderBooks: Map<string, OrderBook> = new Map()): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    const timestamp = Date.now();
    opportunities.push(...this.findExecutableSingleMarketOpportunities(orderBooks, timestamp));

    // Cross-market execution candidates must come from an explicit terminal
    // payoff model and executable asks. The KL diagnostic above remains useful
    // for research, but is dimensionless and is never returned as USD profit.
    for (const model of this.payoffModels) {
      const quotes = model.marketIds.flatMap((marketId) => {
        const book = orderBooks.get(marketId);
        const ask =
          book && !book.isStale(this.maxOrderBookAgeMs, timestamp) ? book.getBestAsk() : null;
        const fee = this.resolveTakerFeeSchedule(marketId, timestamp);
        return ask
          ? [
              {
                marketId,
                askPrice: ask.price,
                availableSize: ask.size,
                takerFeeRate: fee.rate,
                takerFeeExponent: fee.exponent,
              },
            ]
          : [];
      });
      const crossMarket = findDollarPayoffArbitrage(model, quotes);
      if (!crossMarket) {
        continue;
      }

      const activeEventIds = new Set(
        crossMarket.marketIds.flatMap((marketId, index) => {
          if ((crossMarket.quantities[index] ?? 0) <= 1e-8) {
            return [];
          }
          const eventId = this.polytope.getMarket(marketId)?.eventId;
          return eventId ? [eventId] : [];
        })
      );
      if (activeEventIds.size < 2) {
        this.logger.warn('Ignoring payoff cover that does not span multiple events', {
          modelId: model.id,
        });
        continue;
      }

      opportunities.push({
        id: `cross-${crossMarket.modelId}-${String(timestamp)}`,
        type: 'cross-market',
        markets: crossMarket.marketIds,
        expectedProfit: crossMarket.guaranteedProfitUsd,
        guaranteedProfit: crossMarket.guaranteedProfitUsd,
        profitUnit: 'USD',
        confidence: Math.min(Math.max(crossMarket.returnOnCost, 0), 1),
        tradeDirection: crossMarket.quantities,
        timestamp,
        expiresAt:
          Math.min(
            ...crossMarket.marketIds.map(
              (marketId) => orderBooks.get(marketId)?.getTimestamp() ?? timestamp
            )
          ) + this.maxOrderBookAgeMs,
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
    this.takerFeeSchedules.clear();
  }

  private computeGradient(mu: number[], theta: number[]): number[] {
    // Gradient of generalized KL divergence: ∇_μ D(μ||θ) = log(μ/θ)
    const epsilon = 1e-10;
    return mu.map((m, i) => {
      const safeMu = Math.max(m, epsilon);
      const thetaValue = theta[i];
      const safeTheta = thetaValue === undefined ? epsilon : Math.max(thetaValue, epsilon);
      return Math.log(safeMu / safeTheta);
    });
  }

  private linearMinimizationOracle(
    gradient: number[],
    constraints: { coefficients: number[]; rhs: number; type: 'equality' | 'inequality' }[]
  ): number[] {
    return fwLinearMinimizationOracle(gradient, constraints);
  }

  private findExecutableSingleMarketOpportunities(
    orderBooks: Map<string, OrderBook>,
    timestamp: number
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    for (const event of this.getEventsFromPolytope()) {
      const yes = event.markets.find((market) => market.outcome === 'YES');
      const no = event.markets.find((market) => market.outcome === 'NO');
      if (!yes || !no) continue;

      const yesBook = orderBooks.get(yes.id);
      const noBook = orderBooks.get(no.id);
      if (
        !yesBook ||
        !noBook ||
        yesBook.isStale(this.maxOrderBookAgeMs, timestamp) ||
        noBook.isStale(this.maxOrderBookAgeMs, timestamp)
      ) {
        continue;
      }

      const size = Math.min(
        yesBook.getAskDepth(),
        noBook.getAskDepth(),
        this.maxSingleMarketShares
      );
      if (!Number.isFinite(size) || size <= 0) continue;

      const yesExecution = yesBook.calculateTakerExecutionCost(
        size,
        'buy',
        this.resolveTakerFeeSchedule(yes.id, timestamp).rate,
        this.resolveTakerFeeSchedule(yes.id, timestamp).exponent
      );
      const noExecution = noBook.calculateTakerExecutionCost(
        size,
        'buy',
        this.resolveTakerFeeSchedule(no.id, timestamp).rate,
        this.resolveTakerFeeSchedule(no.id, timestamp).exponent
      );
      if (yesExecution.remainingSize > 1e-8 || noExecution.remainingSize > 1e-8) continue;

      const totalCost = yesExecution.totalCost + noExecution.totalCost;
      const guaranteedProfit = size - totalCost;
      if (!Number.isFinite(guaranteedProfit) || guaranteedProfit <= 1e-8) continue;

      const expiresAt =
        Math.min(yesBook.getTimestamp(), noBook.getTimestamp()) + this.maxOrderBookAgeMs;
      opportunities.push({
        id: `single-${event.id}-${String(timestamp)}`,
        type: 'single-market',
        markets: [yes.id, no.id],
        expectedProfit: guaranteedProfit,
        guaranteedProfit,
        profitUnit: 'USD',
        confidence: Math.min(Math.max(guaranteedProfit / Math.max(totalCost, 1e-8), 0), 1),
        tradeDirection: [size, size],
        timestamp,
        expiresAt,
      });
    }
    return opportunities;
  }

  private resolveTakerFeeSchedule(
    tokenId: string,
    now: number
  ): Pick<TakerFeeSchedule, 'rate' | 'exponent'> {
    const schedule = this.takerFeeSchedules.get(tokenId);
    if (
      schedule &&
      schedule.fetchedAt <= now &&
      now - schedule.fetchedAt <= this.maxTakerFeeAgeMs
    ) {
      return schedule;
    }
    return { rate: this.conservativeTakerFeeRate, exponent: 1 };
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
const arbitrageDetectorSingleton = createSingleton(() => new ArbitrageDetector());

export const getArbitrageDetector = arbitrageDetectorSingleton.get;
export const resetArbitrageDetector = arbitrageDetectorSingleton.reset;
