/**
 * Polymarket Arbitrage Trading System
 *
 * Main entry point for the trading system.
 * Integrates all components: data pipeline, arbitrage detection, and execution.
 */

import { DataPipeline, DataPipelineEvent } from './market/data-pipeline.js';
import {
  getOrderBookManager,
  resetOrderBookManager,
} from './market/order-book.js';
import {
  ArbitrageDetector,
  ArbitrageOpportunity,
  getArbitrageDetector,
  resetArbitrageDetector,
} from './market/arbitrage-detector.js';
import { getExecutionEngine, resetExecutionEngine } from './execution/execution-engine.js';
import { getRiskManager, resetRiskManager } from './execution/risk-manager.js';
import {
  calculateMultiLegPositionSize,
  calculateSingleMarketArbitrageSize,
} from './execution/position-sizing.js';
import { initLogger, getLogger } from './utils/logger.js';
import {
  validateConfig,
  printConfigSummary,
  LOG_CONFIG,
  NETWORK_CONFIG,
  RISK_CONFIG,
} from './utils/config.js';

export interface TradingSystemConfig {
  /** Enable live trading (false = paper trading) */
  liveTrading: boolean;
  /** Markets to monitor */
  markets: string[];
  /** Events to track */
  events: Array<{
    id: string;
    markets: Array<{ id: string; outcome: 'YES' | 'NO'; price: number }>;
  }>;
}

export class PolymarketTradingSystem {
  private pipeline: DataPipeline;
  private detector: ArbitrageDetector;
  private logger = getLogger().child({ module: 'TradingSystem' });
  private isRunning = false;
  private unsubscribe?: () => void;
  private config: TradingSystemConfig;

  constructor(config: TradingSystemConfig) {
    this.config = config;
    this.pipeline = new DataPipeline(NETWORK_CONFIG.WS_URL);
    this.detector = new ArbitrageDetector();
  }

  /**
   * Initialize the trading system
   */
  async initialize(): Promise<void> {
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
    }

    this.logger.info('Trading system initialized');
  }

  /**
   * Start the trading system
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Trading system already running');
      return;
    }

    this.logger.info('Starting trading system');
    this.isRunning = true;

    // Connect to data pipeline
    this.pipeline.connect();

    // Start main loop
    this.runMainLoop();
  }

  /**
   * Stop the trading system
   */
  async stop(): Promise<void> {
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
  async runDetectionCycle(): Promise<ArbitrageOpportunity[]> {
    // Find all opportunities
    const opportunities = this.detector.findAllOpportunities();

    if (opportunities.length > 0) {
      this.logger.info(`Found ${opportunities.length} arbitrage opportunities`);

      // Log top opportunities
      for (const opp of opportunities.slice(0, 3)) {
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
  async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    const riskManager = getRiskManager();

    // Check risk limits
    const riskCheck = riskManager.checkTrade(
      opportunity.markets[0]!,
      0, // Size will be calculated
      opportunity.tradeDirection[0]! > 0 ? 'buy' : 'sell',
      opportunity.guaranteedProfit
    );

    if (!riskCheck.allowed) {
      this.logger.warn('Trade rejected by risk manager', { reason: riskCheck.reason });
      return false;
    }

    // Calculate position sizes
    // This is simplified - real implementation would use order books
    const sizes = opportunity.tradeDirection.map((d) => Math.abs(d) * 100);

    this.logger.info('Executing arbitrage', {
      id: opportunity.id,
      type: opportunity.type,
      sizes,
    });

    // Execute trades
    if (this.config.liveTrading) {
      const engine = getExecutionEngine();
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
        break;

      case 'orderbook':
        // Update order book
        const manager = getOrderBookManager();
        manager.updateBook(event.data.marketId, event.data.bids, event.data.asks);
        break;

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
          await this.stop();
          break;
        }

        // Run detection cycle
        const opportunities = await this.runDetectionCycle();

        // Execute profitable opportunities
        for (const opp of opportunities) {
          if (opp.guaranteedProfit > 0.05) {
            // Minimum $0.05 profit
            await this.executeOpportunity(opp);
          }
        }

        // Wait before next cycle
        await sleep(1000);
      } catch (error) {
        this.logger.error('Error in main loop', {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(5000); // Wait longer on error
      }
    }
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
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
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
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down...');
    await system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    await system.stop();
    process.exit(0);
  });

  // Initialize and start
  await system.initialize();
  await system.start();
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
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
export * from './utils/math.js';
export * from './utils/logger.js';
export * from './utils/config.js';
