/**
 * MetricsRegistry, pre-defined TradingMetrics, and helper functions.
 */

import { getLogger } from './logger.js';
import { Metric, Counter, Gauge, Histogram } from './metric-types.js';
import { calculateHistogramPercentiles, type HistogramPoint } from './percentile.js';
import { createSingleton } from './singleton.js';

/**
 * Global metrics registry
 */
class MetricsRegistry {
  private metrics: Map<string, Metric> = new Map();
  private logger = getLogger().child({ module: 'MetricsRegistry' });

  register(metric: Metric): void {
    if (this.metrics.has(metric.getName())) {
      this.logger.warn(`Metric ${metric.getName()} already registered, overwriting`);
    }
    this.metrics.set(metric.getName(), metric);
  }

  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  getAll(): Metric[] {
    return Array.from(this.metrics.values());
  }

  toPrometheusFormat(): string {
    return this.getAll()
      .map((m) => m.toPrometheusFormat())
      .join('\n\n');
  }

  clear(): void {
    this.metrics.clear();
  }
}

// Global registry instance
const registrySingleton = createSingleton(() => {
  const registry = new MetricsRegistry();
  Object.values(TradingMetrics).forEach((metric) => {
    registry.register(metric);
  });
  return registry;
});

export const getRegistry = registrySingleton.get;
export const resetMetricsRegistry = registrySingleton.reset;

// Pre-defined trading metrics
export const TradingMetrics = {
  // Order execution metrics
  ordersSubmitted: new Counter(
    'trading_orders_submitted_total',
    'Total number of orders submitted'
  ),
  ordersFilled: new Counter('trading_orders_filled_total', 'Total number of orders filled'),
  ordersFailed: new Counter('trading_orders_failed_total', 'Total number of orders that failed'),
  ordersCancelled: new Counter(
    'trading_orders_cancelled_total',
    'Total number of orders cancelled'
  ),

  // Position metrics
  positionSize: new Gauge('trading_position_size', 'Current position size'),
  positionPnl: new Gauge('trading_position_pnl', 'Unrealized P&L'),
  totalExposure: new Gauge('trading_total_exposure', 'Total exposure across all positions'),

  // Arbitrage metrics
  arbitrageOpportunitiesFound: new Counter(
    'trading_arbitrage_opportunities_total',
    'Total arbitrage opportunities detected'
  ),
  arbitrageExecuted: new Counter(
    'trading_arbitrage_executed_total',
    'Successful arbitrage executions'
  ),
  arbitrageFailed: new Counter('trading_arbitrage_failed_total', 'Failed arbitrage attempts'),
  arbitrageProfit: new Counter(
    'trading_arbitrage_profit_total',
    'Total profit from arbitrage (USD)'
  ),

  // Performance metrics
  orderExecutionTime: new Histogram(
    'trading_order_execution_seconds',
    'Order execution time in seconds',
    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
  ),
  frankWolfeIterations: new Histogram(
    'trading_frank_wolfe_iterations',
    'Number of Frank-Wolfe iterations',
    [10, 25, 50, 75, 100, 150, 200]
  ),
  frankWolfeGap: new Histogram(
    'trading_frank_wolfe_gap',
    'Frank-Wolfe optimality gap',
    [0.0001, 0.001, 0.01, 0.1, 1]
  ),

  // Market data metrics
  orderBookUpdates: new Counter(
    'trading_orderbook_updates_total',
    'Total order book updates received'
  ),
  websocketReconnects: new Counter(
    'trading_websocket_reconnects_total',
    'WebSocket reconnection count'
  ),
  websocketErrors: new Counter('trading_websocket_errors_total', 'WebSocket error count'),

  // Latency metrics (P50/P95/P99 tracking)
  orderBookUpdateLatency: new Histogram(
    'trading_orderbook_update_latency_ms',
    'Order book update processing latency in milliseconds',
    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  ),
  arbitrageDetectionLatency: new Histogram(
    'trading_arbitrage_detection_latency_ms',
    'Time from opportunity detection to execution start in milliseconds',
    [1, 5, 10, 25, 50, 100, 250, 500, 1000]
  ),
  wsMessageProcessingTime: new Histogram(
    'trading_ws_message_processing_ms',
    'WebSocket message processing time in milliseconds',
    [1, 5, 10, 25, 50, 100, 250, 500]
  ),
  orderExecutionLatency: new Histogram(
    'trading_order_execution_latency_ms',
    'Order execution latency from submission to confirmation in milliseconds',
    [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
  ),
  riskCheckLatency: new Histogram(
    'trading_risk_check_latency_ms',
    'Risk check execution time in milliseconds',
    [1, 5, 10, 25, 50, 100, 250]
  ),
} as const;

/**
 * Record a trade execution
 */
export function recordTrade(
  marketId: string,
  side: 'buy' | 'sell',
  _size: number,
  _price: number,
  executionTimeMs: number,
  success: boolean
): void {
  const labels = { market_id: marketId, side };

  TradingMetrics.ordersSubmitted.inc(labels);
  TradingMetrics.orderExecutionTime.observe(labels, executionTimeMs / 1000);

  if (success) {
    TradingMetrics.ordersFilled.inc(labels);
  } else {
    TradingMetrics.ordersFailed.inc(labels);
  }
}

/**
 * Record arbitrage opportunity and execution
 */
export function recordArbitrage(
  eventId: string,
  _profitEstimate: number,
  executed: boolean,
  actualProfit?: number
): void {
  TradingMetrics.arbitrageOpportunitiesFound.inc({ event_id: eventId });

  if (executed) {
    TradingMetrics.arbitrageExecuted.inc({ event_id: eventId });
    if (actualProfit !== undefined && actualProfit > 0) {
      TradingMetrics.arbitrageProfit.inc({ event_id: eventId }, actualProfit);
    }
  } else {
    TradingMetrics.arbitrageFailed.inc({ event_id: eventId });
  }
}

/**
 * Get metrics in Prometheus format for scraping
 */
export function getMetricsForScraping(): string {
  return getRegistry().toPrometheusFormat();
}

/**
 * Get latency percentiles for a histogram metric
 */
export function getLatencyPercentiles(
  metricName:
    | 'orderBookUpdateLatency'
    | 'arbitrageDetectionLatency'
    | 'wsMessageProcessingTime'
    | 'orderExecutionLatency'
    | 'riskCheckLatency'
): { p50: number; p95: number; p99: number; count: number } {
  const metric = TradingMetrics[metricName];

  const histogramData: HistogramPoint[] = [];
  const counts = metric.getCountsSnapshot();
  const buckets = metric.getBuckets();

  if (counts.size === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }

  const totalCounts: number[] = new Array<number>(buckets.length).fill(0);
  let totalObservations = 0;

  for (const [, bucketCounts] of counts) {
    let previousCumulative = 0;
    for (let i = 0; i < buckets.length; i++) {
      const cumulativeCount = bucketCounts[i] ?? previousCumulative;
      const bucketCount = Math.max(cumulativeCount - previousCumulative, 0);
      totalCounts[i] = (totalCounts[i] ?? 0) + bucketCount;
      previousCumulative = cumulativeCount;
    }
  }

  const countsTotal = metric.getTotalsSnapshot();
  for (const [, count] of countsTotal) {
    totalObservations += count;
  }

  for (let i = 0; i < buckets.length; i++) {
    const bucketValue = buckets[i];
    if (bucketValue === undefined) {
      continue;
    }
    histogramData.push({
      value: bucketValue,
      count: totalCounts[i] ?? 0,
    });
  }

  const percentiles = calculateHistogramPercentiles(histogramData, [50, 95, 99]);

  return {
    p50: percentiles.p50 ?? 0,
    p95: percentiles.p95 ?? 0,
    p99: percentiles.p99 ?? 0,
    count: totalObservations,
  };
}
