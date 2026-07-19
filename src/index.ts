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
import { getMetricsForScraping, resetMetricsRegistry, TradingMetrics } from './utils/metrics.js';
import { initLogger, getLogger } from './utils/logger.js';
import { validateConfig, printConfigSummary, LOG_CONFIG, NETWORK_CONFIG } from './utils/config.js';
import { getErrorMessage } from './utils/errors.js';
import { createRuntimeHttpServer } from './runtime/http-server.js';
import {
  loadTradingSystemConfigFromEnv,
  parseRuntimeServerConfigFromEnv,
  shouldReconcileOnStartup,
} from './runtime/runtime-config.js';
import { createGracefulShutdown } from './runtime/graceful-shutdown.js';
import { isMainModule } from './runtime/entrypoint.js';
import type { CrossMarketPayoffModel } from './market/payoff-model.js';
import { createSignedClobTradingClientFromEnv } from './api/signed-clob-client.js';
import {
  getPolymarketClient,
  type TakerFeeProvider,
  type TakerFeeSchedule,
} from './api/polymarket-client.js';
import { reconcileConfiguredBalances } from './execution/balance-reconciliation.js';

// Trading system constants
const MIN_SINGLE_MARKET_PROFIT_USD = 0.05;
const MAIN_LOOP_INTERVAL_MS = 1000; // Normal cycle interval
const ERROR_RETRY_INTERVAL_MS = 5000; // Retry interval after error
const TOP_OPPORTUNITIES_TO_LOG = 3; // Number of top opportunities to log
const FEE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FEE_RETRY_INTERVAL_MS = 30 * 1000;

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
  /** Explicit exhaustive payoff scenarios for related-market USD analysis. */
  payoffModels?: CrossMarketPayoffModel[];
}

export interface TradingSystemStatus {
  running: boolean;
  websocketConnected: boolean;
  liveTrading: boolean;
  configuredMarkets: number;
  configuredEvents: number;
  circuitBreakerActive: boolean;
}

export interface TradingSystemDependencies {
  feeProvider?: TakerFeeProvider;
}

export class PolymarketTradingSystem {
  private pipeline: DataPipeline;
  private detector: ArbitrageDetector;
  private logger = getLogger().child({ module: 'TradingSystem' });
  private isRunning = false;
  private unsubscribe: (() => void) | undefined;
  private config: TradingSystemConfig;
  private latestPrices: Map<string, number> = new Map();
  private mainLoopPromise?: Promise<void>;
  private mainLoopAbortController: AbortController | undefined;
  private disconnectPromise: Promise<void> = Promise.resolve();
  private nextFeeRefreshAt = 0;

  constructor(
    config: TradingSystemConfig,
    private readonly dependencies: TradingSystemDependencies = {}
  ) {
    this.config = config;
    this.pipeline = new DataPipeline(NETWORK_CONFIG.WS_URL, config.markets);
    this.detector = new ArbitrageDetector(config.payoffModels ?? []);
  }

  /**
   * Initialize the trading system
   */
  initialize(): void {
    this.logger.info('Initializing Polymarket Trading System');

    if (this.config.liveTrading) {
      throw new Error(
        'Automatic live trading is disabled until the funded canary, reconciliation, and multi-leg readiness gates are approved'
      );
    }

    // Validate configuration
    validateConfig();
    printConfigSummary();

    // Logger is initialized once in main()/tests with STRUCTURED_LOGGING.
    // Do not re-init here — a second init without the structured flag would
    // wipe JSON logging (INFRA-2).

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
    this.mainLoopAbortController = new AbortController();

    if (!this.unsubscribe) {
      this.setupEventHandlers();
    }

    // Connect to data pipeline
    this.pipeline.connect();

    // Start main loop
    this.mainLoopPromise = this.runMainLoop(this.mainLoopAbortController.signal);
  }

  /**
   * Stop the trading system
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping trading system');
    this.requestStop();
    await this.mainLoopPromise;
    await this.disconnectPromise;

    this.logger.info('Trading system stopped');
  }

  getStatus(): TradingSystemStatus {
    return {
      running: this.isRunning,
      websocketConnected: this.pipeline.isConnected(),
      liveTrading: this.config.liveTrading,
      configuredMarkets: this.config.markets.length,
      configuredEvents: this.config.events.length,
      circuitBreakerActive: getRiskManager().isCircuitBreakerActive(),
    };
  }

  /**
   * Run a single arbitrage detection cycle
   */
  runDetectionCycle(): ArbitrageOpportunity[] {
    const startedAt = performance.now();
    // Find all opportunities
    const orderBookManager = getOrderBookManager();
    const orderBooks = new Map(
      this.config.markets.flatMap((marketId) => {
        const book = orderBookManager.peekBook(marketId);
        return book ? [[marketId, book] as const] : [];
      })
    );
    const opportunities = this.detector.findAllOpportunities(orderBooks);
    TradingMetrics.arbitrageDetectionLatency.observe({}, performance.now() - startedAt);
    for (const opportunity of opportunities) {
      TradingMetrics.arbitrageOpportunitiesFound.inc({ type: opportunity.type });
    }

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
    if (opportunity.type === 'cross-market') {
      this.logger.warn(
        'Cross-market automatic execution is disabled until payoff review and multi-leg safety gates are complete',
        { id: opportunity.id }
      );
      return false;
    }

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

      const size = Math.abs(direction);
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

    const riskCheck = riskManager.checkTrades(
      legs.map((leg) => ({
        marketId: leg.marketId,
        side: leg.side,
        size: leg.size,
        estimatedNotional: leg.notional,
      }))
    );
    if (!riskCheck.allowed) {
      this.logger.warn('Trade rejected by portfolio risk check', { reason: riskCheck.reason });
      return false;
    }

    const sizes = legs.map((leg) => leg.size);
    this.logger.info('Executing arbitrage', {
      id: opportunity.id,
      type: opportunity.type,
      sizes,
    });

    // Execute trades
    if (this.config.liveTrading) {
      this.logger.error('Automatic live trading remains disabled by the readiness gate');
      return false;
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
        // Unknown market ids must not abort the rest of this handler (MKT-3).
        try {
          this.detector.updatePrice(event.data.marketId, event.data.price);
        } catch (error) {
          this.logger.debug('Ignoring trade for unregistered market', {
            marketId: event.data.marketId,
            error: getErrorMessage(error),
          });
        }
        getRiskManager().updateMarketPrice(event.data.marketId, event.data.price);
        if (Number.isFinite(event.data.price) && event.data.price > 0) {
          this.latestPrices.set(event.data.marketId, event.data.price);
        }
        break;

      case 'orderbook': {
        // Update order book
        const manager = getOrderBookManager();
        manager.updateBook(
          event.data.marketId,
          event.data.bids,
          event.data.asks,
          event.data.timestamp,
          event.data.kind
        );
        break;
      }

      case 'tick-size':
        this.logger.info('Market tick size changed', {
          marketId: event.marketId,
          tickSize: event.tickSize,
        });
        break;

      case 'market-resolved':
        getOrderBookManager().removeBook(event.marketId);
        this.latestPrices.delete(event.marketId);
        this.logger.warn('Resolved market removed from active books', { marketId: event.marketId });
        break;

      case 'connected':
        this.logger.info('Data pipeline connected');
        break;

      case 'disconnected':
        // Stale books + post-reconnect deltas would refresh lastUpdate without
        // replacing depth (MKT-1). Force a full snapshot before trading again.
        getOrderBookManager().invalidateAll('data pipeline disconnected');
        this.logger.warn('Data pipeline disconnected; order books invalidated');
        break;

      case 'reconnect_exhausted':
        this.logger.error('Data pipeline reconnect exhausted; channel is silent until reset', {
          attempts: event.attempts,
        });
        break;

      case 'error':
        this.logger.error('Data pipeline error', { error: event.error.message });
        break;
    }
  }

  private async runMainLoop(signal: AbortSignal): Promise<void> {
    const riskManager = getRiskManager();

    while (this.isRunning && !signal.aborted) {
      try {
        // Check emergency stop
        if (riskManager.checkEmergencyStop()) {
          this.logger.error('Emergency stop triggered, halting trading');
          this.requestStop();
          break;
        }

        // API-12: do not act on opportunities while the market channel is down
        // or has permanently given up reconnecting — books may be empty/stale.
        if (this.pipeline.isReconnectExhausted()) {
          this.logger.error('Skipping cycle: market data reconnect exhausted');
          await sleep(ERROR_RETRY_INTERVAL_MS, signal);
          continue;
        }
        if (!this.pipeline.isConnected()) {
          this.logger.warn('Skipping cycle: market data WebSocket is not connected');
          await sleep(MAIN_LOOP_INTERVAL_MS, signal);
          continue;
        }

        await this.refreshTakerFeesIfDue();

        // Run detection cycle
        const opportunities = this.runDetectionCycle();

        // Execute profitable opportunities
        for (const opp of opportunities) {
          if (
            opp.type === 'single-market' &&
            opp.guaranteedProfit > MIN_SINGLE_MARKET_PROFIT_USD &&
            opp.expiresAt > Date.now()
          ) {
            this.executeOpportunity(opp);
          }
        }

        // Wait before next cycle
        await sleep(MAIN_LOOP_INTERVAL_MS, signal);
      } catch (error) {
        this.logger.error('Error in main loop', {
          error: getErrorMessage(error),
        });
        await sleep(ERROR_RETRY_INTERVAL_MS, signal); // Wait longer on error
      }
    }
  }

  private async refreshTakerFeesIfDue(now = Date.now()): Promise<void> {
    const provider = this.dependencies.feeProvider;
    if (!provider || now < this.nextFeeRefreshAt) return;

    const results = await mapSettledWithConcurrency(this.config.markets, 5, (marketId) =>
      provider.getTakerFeeSchedule(marketId)
    );
    const schedules: TakerFeeSchedule[] = [];
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') schedules.push(result.value);
      else failed++;
    }
    if (schedules.length > 0) {
      this.detector.setTakerFeeSchedules(schedules);
    }
    if (failed > 0) {
      this.logger.warn('Some dynamic taker fee schedules could not be refreshed', {
        failed,
        refreshed: schedules.length,
      });
    }
    this.nextFeeRefreshAt = now + (failed === 0 ? FEE_REFRESH_INTERVAL_MS : FEE_RETRY_INTERVAL_MS);
  }

  private requestStop(): void {
    this.isRunning = false;
    this.mainLoopAbortController?.abort();
    this.mainLoopAbortController = undefined;
    this.disconnectPromise = this.pipeline.disconnect();

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
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
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function mapSettledWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        const value = values[index];
        if (value === undefined) continue;
        try {
          results[index] = { status: 'fulfilled', value: await mapper(value) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );
  return results;
}

/**
 * Reset all global state (for testing)
 */
export function resetTradingSystem(): void {
  resetOrderBookManager();
  resetArbitrageDetector();
  resetExecutionEngine();
  resetRiskManager();
  resetMetricsRegistry();
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  initLogger(LOG_CONFIG.LOG_LEVEL, LOG_CONFIG.SILENT, LOG_CONFIG.STRUCTURED_LOGGING);

  const logger = getLogger().child({ module: 'Bootstrap' });
  const config = loadTradingSystemConfigFromEnv();
  const serverConfig = parseRuntimeServerConfigFromEnv();
  const system = new PolymarketTradingSystem(config, { feeProvider: getPolymarketClient() });

  if (shouldReconcileOnStartup()) {
    const reconciliation = await reconcileConfiguredBalances(
      getRiskManager(),
      createSignedClobTradingClientFromEnv(),
      config.markets
    );
    logger.info('Startup balance reconciliation completed', {
      checkedAssets: reconciliation.checkedAssetIds.length,
      synced: reconciliation.synced.length,
      removed: reconciliation.removed.length,
      imported: reconciliation.imported.length,
    });
  }

  const httpServer = createRuntimeHttpServer({
    host: serverConfig.host,
    port: serverConfig.port,
    ...(serverConfig.riskStatusToken ? { riskStatusToken: serverConfig.riskStatusToken } : {}),
    ...(serverConfig.metricsToken ? { metricsToken: serverConfig.metricsToken } : {}),
    getHealthStatus: () => {
      const status = system.getStatus();
      return {
        ok: true,
        ready:
          status.running &&
          status.configuredMarkets > 0 &&
          status.configuredEvents > 0 &&
          status.websocketConnected,
        uptimeSeconds: Math.floor(process.uptime()),
        mode: status.liveTrading ? 'live' : 'paper',
        running: status.running,
        websocketConnected: status.websocketConnected,
        configuredMarkets: status.configuredMarkets,
        configuredEvents: status.configuredEvents,
        circuitBreakerActive: status.circuitBreakerActive,
      };
    },
    getMetrics: () => {
      const risk = getRiskManager().getRiskMetrics();
      TradingMetrics.totalExposure.set({}, risk.totalExposure);
      TradingMetrics.dailyPnl.set({}, risk.dailyPnL);
      TradingMetrics.unrealizedPnl.set({}, risk.unrealizedPnL);
      TradingMetrics.maxDrawdown.set({}, risk.maxDrawdown);
      TradingMetrics.circuitBreakerOpen.set({}, getRiskManager().isCircuitBreakerActive() ? 1 : 0);
      TradingMetrics.websocketConnected.set({}, system.getStatus().websocketConnected ? 1 : 0);
      TradingMetrics.positionSize.clear();
      TradingMetrics.positionPnl.clear();
      for (const position of getRiskManager().getPositions()) {
        const labels = { market_id: position.marketId };
        TradingMetrics.positionSize.set(labels, position.size);
        const positionPnl = getRiskManager().getPositionUnrealizedPnL(position.marketId);
        if (positionPnl !== undefined) {
          TradingMetrics.positionPnl.set(labels, positionPnl);
        }
      }
      return getMetricsForScraping();
    },
    getRiskStatus: () => ({
      circuitBreakerActive: getRiskManager().isCircuitBreakerActive(),
      metrics: getRiskManager().getRiskMetrics(),
    }),
  });

  const shutdown = createGracefulShutdown({
    stop: async () => {
      await system.stop();
      await httpServer.stop();
    },
    exit: (code: number) => {
      process.exit(code);
    },
    logger,
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (error: Error) => {
    void shutdown('uncaughtException', 1, error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    void shutdown('unhandledRejection', 1, reason);
  });

  system.initialize();
  await httpServer.start();
  logger.info('Runtime HTTP server started', {
    host: serverConfig.host,
    port: serverConfig.port,
  });
  system.start();
}

// Run if this file is executed directly
if (isMainModule(import.meta.url)) {
  void main().catch((error: unknown) => {
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
export * from './market/payoff-model.js';
export * from './market/dependency-graph.js';
export * from './execution/execution-engine.js';
export * from './execution/position-sizing.js';
export * from './execution/risk-manager.js';
export * from './execution/balance-reconciliation.js';
export * from './execution/order-idempotency-store.js';
export * from './execution/postgres-order-idempotency-store.js';
export * from './execution/onchain-balance-reader.js';
export * from './execution/operator-readiness-audit.js';
export * from './optimization/lp-solver.js';
export * from './optimization/ip-solver.js';
export * from './api/index.js';
export * from './utils/math.js';
export * from './utils/logger.js';
export * from './utils/config.js';
