/**
 * Polymarket Arbitrage Trading System
 *
 * Main entry point for the trading system.
 * Integrates all components: data pipeline, arbitrage detection, and execution.
 */

import { DataPipeline, DataPipelineEvent } from './market/data-pipeline.js';
import { getOrderBookManager, resetOrderBookManager } from './market/order-book.js';
import {
  ArbitrageDetector,
  ArbitrageOpportunity,
  resetArbitrageDetector,
} from './market/arbitrage-detector.js';
import { resetExecutionEngine } from './execution/execution-engine.js';
import { getRiskManager, resetRiskManager } from './execution/risk-manager.js';
import { resetTransactionTracker } from './blockchain/transaction-tracker.js';
import { resetMetricsRegistry } from './utils/metrics.js';
import { initLogger, getLogger } from './utils/logger.js';
import { validateConfig, printConfigSummary, LOG_CONFIG, NETWORK_CONFIG } from './utils/config.js';
import { getErrorMessage } from './utils/errors.js';

// Trading system constants
const MIN_PROFIT_THRESHOLD = 0.05; // Minimum guaranteed profit (divergence units)
const POSITION_SIZE_MULTIPLIER = 100; // Base multiplier for position sizing
const MAIN_LOOP_INTERVAL_MS = 1000; // Normal cycle interval
const ERROR_RETRY_INTERVAL_MS = 5000; // Retry interval after error
const TOP_OPPORTUNITIES_TO_LOG = 3; // Number of top opportunities to log

export interface TradingSystemConfig {
  /** Enable live trading (false = paper trading) */
  liveTrading: boolean;
  /** Markets to monitor */
  markets: string[];
  /** Events to track */
  events: {
    id: string;
    markets: { id: string; outcome: 'YES' | 'NO'; price: number }[];
  }[];
}

export class PolymarketTradingSystem {
  private pipeline: DataPipeline;
  private detector: ArbitrageDetector;
  private logger = getLogger().child({ module: 'TradingSystem' });
  private isRunning = false;
  private unsubscribe?: () => void;
  private config: TradingSystemConfig;
  private latestPrices: Map<string, number> = new Map();

  constructor(config: TradingSystemConfig) {
    this.config = config;
    this.pipeline = new DataPipeline(NETWORK_CONFIG.WS_URL);
    this.detector = new ArbitrageDetector();
  }

  /**
   * Initialize the trading system
   */
  initialize(): void {
    this.logger.info('Initializing Polymarket Trading System');

    // Validate configuration
    validateConfig();
    printConfigSummary();

    // Initialize logger
    initLogger(LOG_CONFIG.LOG_LEVEL, LOG_CONFIG.SILENT);

    // Set up event handlers
    this.setupEventHandlers();

    // Add events to detector
    for (const event of this.config.events) {
      this.detector.addEvent({
        id: event.id,
        markets: event.markets.map((m) => ({
          id: m.id,
          eventId: event.id,
          outcome: m.outcome,
          price: m.price,
        })),
        outcomes: ['YES', 'NO'],
      });

      for (const market of event.markets) {
        if (Number.isFinite(market.price) && market.price > 0) {
          this.latestPrices.set(market.id, market.price);
        }
      }
    }

    this.logger.info('Trading system initialized');
  }

  /**
   * Start the trading system
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn('Trading system already running');
      return;
    }

    this.logger.info('Starting trading system');
    this.isRunning = true;

    // Connect to data pipeline
    this.pipeline.connect();

    // Start main loop
    void this.runMainLoop();
  }

  /**
   * Stop the trading system
   */
  stop(): void {
    this.logger.info('Stopping trading system');
    this.isRunning = false;

    // Disconnect from data pipeline
    this.pipeline.disconnect();

    // Unsubscribe from events
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.logger.info('Trading system stopped');
  }

  /**
   * Run a single arbitrage detection cycle
   */
  runDetectionCycle(): ArbitrageOpportunity[] {
    // Find all opportunities
    const opportunities = this.detector.findAllOpportunities();

    if (opportunities.length > 0) {
      this.logger.info(`Found ${String(opportunities.length)} arbitrage opportunities`);

      // Log top opportunities
      for (const opp of opportunities.slice(0, TOP_OPPORTUNITIES_TO_LOG)) {
        this.logger.info(`Opportunity: ${opp.type}`, {
          id: opp.id,
          profit: opp.guaranteedProfit.toFixed(4),
          confidence: opp.confidence.toFixed(2),
          markets: opp.markets,
        });
      }
    }

    return opportunities;
  }

  /**
   * Execute an arbitrage opportunity
   */
  executeOpportunity(opportunity: ArbitrageOpportunity): boolean {
    const riskManager = getRiskManager();

    // Build executable legs with per-leg notional estimates.
    const legs: {
      marketId: string;
      side: 'buy' | 'sell';
      size: number;
      notional: number;
    }[] = [];

    for (let i = 0; i < opportunity.markets.length; i++) {
      const marketId = opportunity.markets[i];
      const direction = opportunity.tradeDirection[i];
      if (marketId === undefined || direction === undefined) {
        continue;
      }

      const size = Math.abs(direction) * POSITION_SIZE_MULTIPLIER;
      if (!Number.isFinite(size) || size <= 0) {
        continue;
      }

      const side: 'buy' | 'sell' = direction > 0 ? 'buy' : 'sell';
      const referencePrice = this.getReferencePrice(marketId);
      const notional = size * referencePrice;
      legs.push({ marketId, side, size, notional });
    }

    if (legs.length === 0) {
      this.logger.warn('Invalid opportunity: no executable legs', { id: opportunity.id });
      return false;
    }

    const primaryLeg = legs[0];
    if (!primaryLeg) {
      this.logger.warn('Invalid opportunity: missing primary leg', { id: opportunity.id });
      return false;
    }

    // Portfolio-level check uses aggregate notional across all legs.
    const totalEstimatedNotional = legs.reduce((sum, leg) => sum + leg.notional, 0);
    const aggregateCheck = riskManager.checkTrade(
      primaryLeg.marketId,
      primaryLeg.size,
      primaryLeg.side,
      totalEstimatedNotional
    );
    if (!aggregateCheck.allowed) {
      this.logger.warn('Trade rejected by risk manager', { reason: aggregateCheck.reason });
      return false;
    }

    // Per-leg checks catch concentration and single-market risks.
    for (const leg of legs) {
      const riskCheck = riskManager.checkTrade(leg.marketId, leg.size, leg.side, leg.notional);
      if (!riskCheck.allowed) {
        this.logger.warn('Trade rejected by per-leg risk check', {
          reason: riskCheck.reason,
          marketId: leg.marketId,
        });
        return false;
      }
    }

    const sizes = legs.map((leg) => leg.size);
    this.logger.info('Executing arbitrage', {
      id: opportunity.id,
      type: opportunity.type,
      sizes,
    });

    // Execute trades
    if (this.config.liveTrading) {
      // Actual execution would go here
      this.logger.info('Live trading execution would happen here');
    } else {
      this.logger.info('Paper trading - no actual execution');
    }

    return true;
  }

  private setupEventHandlers(): void {
    this.unsubscribe = this.pipeline.subscribe((event: DataPipelineEvent) => {
      this.handleDataEvent(event);
    });
  }

  private handleDataEvent(event: DataPipelineEvent): void {
    switch (event.type) {
      case 'trade':
        // Update detector with new price
        this.detector.updatePrice(event.data.marketId, event.data.price);
        getRiskManager().updateMarketPrice(event.data.marketId, event.data.price);
        if (Number.isFinite(event.data.price) && event.data.price > 0) {
          this.latestPrices.set(event.data.marketId, event.data.price);
        }
        break;

      case 'orderbook': {
        // Update order book
        const manager = getOrderBookManager();
        manager.updateBook(event.data.marketId, event.data.bids, event.data.asks);
        break;
      }

      case 'connected':
        this.logger.info('Data pipeline connected');
        break;

      case 'disconnected':
        this.logger.warn('Data pipeline disconnected');
        break;

      case 'error':
        this.logger.error('Data pipeline error', { error: event.error.message });
        break;
    }
  }

  private async runMainLoop(): Promise<void> {
    const riskManager = getRiskManager();

    while (this.isRunning) {
      try {
        // Check emergency stop
        if (riskManager.checkEmergencyStop()) {
          this.logger.error('Emergency stop triggered, halting trading');
          this.stop();
          break;
        }

        // Run detection cycle
        const opportunities = this.runDetectionCycle();

        // Execute profitable opportunities
        for (const opp of opportunities) {
          if (opp.guaranteedProfit > MIN_PROFIT_THRESHOLD) {
            // Minimum $0.05 profit
            this.executeOpportunity(opp);
          }
        }

        // Wait before next cycle
        await sleep(MAIN_LOOP_INTERVAL_MS);
      } catch (error) {
        this.logger.error('Error in main loop', {
          error: getErrorMessage(error),
        });
        await sleep(ERROR_RETRY_INTERVAL_MS); // Wait longer on error
      }
    }
  }

  private getReferencePrice(marketId: string): number {
    const cachedPrice = this.latestPrices.get(marketId);
    if (cachedPrice !== undefined && Number.isFinite(cachedPrice) && cachedPrice > 0) {
      return cachedPrice;
    }

    const book = getOrderBookManager().peekBook(marketId);
    const midPrice = book?.getMidPrice();
    if (midPrice !== null && midPrice !== undefined && Number.isFinite(midPrice) && midPrice > 0) {
      this.latestPrices.set(marketId, midPrice);
      return midPrice;
    }

    // Conservative fallback for binary market contracts in [0, 1].
    return 1;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reset all global state (for testing)
 */
export function resetTradingSystem(): void {
  resetOrderBookManager();
  resetArbitrageDetector();
  resetExecutionEngine();
  resetRiskManager();
  resetTransactionTracker();
  resetMetricsRegistry();
}

/**
 * Main entry point
 */
function main(): void {
  const config: TradingSystemConfig = {
    liveTrading: false, // Start with paper trading
    markets: [],
    events: [
      {
        id: 'example-event',
        markets: [
          { id: 'market-yes', outcome: 'YES', price: 0.6 },
          { id: 'market-no', outcome: 'NO', price: 0.35 },
        ],
      },
    ],
  };

  const system = new PolymarketTradingSystem(config);

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...');
    system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    system.stop();
    process.exit(0);
  });

  // Initialize and start
  system.initialize();
  system.start();
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  try {
    main();
  } catch (error: unknown) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Re-exports for library usage
export * from './core/marginal-polytope.js';
export * from './core/bregman-projection.js';
export * from './core/frank-wolfe.js';
export * from './core/init-fw.js';
export * from './market/data-pipeline.js';
export * from './market/order-book.js';
export * from './market/arbitrage-detector.js';
export * from './market/dependency-graph.js';
export * from './execution/execution-engine.js';
export * from './execution/position-sizing.js';
export * from './execution/risk-manager.js';
export * from './optimization/lp-solver.js';
export * from './optimization/ip-solver.js';
export * from './api/index.js';
export * from './strategies/index.js';
export * from './utils/math.js';
export * from './utils/logger.js';
export * from './utils/config.js';
