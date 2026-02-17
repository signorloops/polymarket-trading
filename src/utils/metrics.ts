/**
 * Prometheus-style metrics collection for trading system monitoring
 *
 * Provides counters, gauges, and histograms for key performance indicators.
 * Metrics can be exported to Prometheus or other monitoring systems.
 */

import { getLogger } from './logger.js';

export type MetricValue = number;
export type MetricLabels = Record<string, string>;

interface MetricPoint {
  value: MetricValue;
  timestamp: number;
  labels: MetricLabels;
}

/**
 * Base metric class with label support
 */
abstract class Metric {
  protected name: string;
  protected description: string;
  protected logger = getLogger().child({ module: 'Metrics' });

  constructor(name: string, description: string) {
    this.name = name;
    this.description = description;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return this.description;
  }

  protected serializeLabels(labels: MetricLabels): string {
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  abstract toPrometheusFormat(): string;
}

/**
 * Counter metric - monotonically increasing values
 */
export class Counter extends Metric {
  private values: Map<string, MetricPoint> = new Map();

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, {
        value,
        timestamp: Date.now(),
        labels,
      });
    }
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key)?.value ?? 0;
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} counter`];
    for (const [key, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${point.value}`);
    }
    return lines.join('\n');
  }
}

/**
 * Gauge metric - values that can go up or down
 */
export class Gauge extends Metric {
  private values: Map<string, MetricPoint> = new Map();

  set(labels: MetricLabels = {}, value: number): void {
    const key = this.serializeLabels(labels);
    this.values.set(key, {
      value,
      timestamp: Date.now(),
      labels,
    });
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.set(labels, value);
    }
  }

  dec(labels: MetricLabels = {}, value = 1): void {
    this.inc(labels, -value);
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key)?.value ?? 0;
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} gauge`];
    for (const [key, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${point.value}`);
    }
    return lines.join('\n');
  }
}

/**
 * Histogram metric - distribution of values
 */
export class Histogram extends Metric {
  private buckets: number[];
  private counts: Map<string, number[]> = new Map();
  private sums: Map<string, number> = new Map();
  private counts_total: Map<string, number> = new Map();

  constructor(name: string, description: string, buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    super(name, description);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels = {}, value: number): void {
    const key = this.serializeLabels(labels);

    // Initialize buckets if needed
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.counts_total.set(key, 0);
    }

    const bucketCounts = this.counts.get(key)!;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        bucketCounts[i]!++;
      }
    }

    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts_total.set(key, (this.counts_total.get(key) ?? 0) + 1);
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} histogram`];

    for (const [key, bucketCounts] of this.counts) {
      const labelEntries = key
        .split(',')
        .filter((s) => s)
        .map((s) => {
          const [k, v] = s.split('=');
          return [k, v?.replace(/"/g, '')];
        });

      // Output bucket counts
      for (let i = 0; i < this.buckets.length; i++) {
        const labels = [...labelEntries, ['le', this.buckets[i]!.toString()]]
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        lines.push(`${this.name}_bucket{${labels}} ${bucketCounts[i]}`);
      }

      // +Inf bucket
      const infLabels = [...labelEntries, ['le', '+Inf']].map(([k, v]) => `${k}="${v}"`).join(',');
      lines.push(`${this.name}_bucket{${infLabels}} ${this.counts_total.get(key)}`);

      // Sum and count
      const baseLabels = labelEntries.map(([k, v]) => `${k}="${v}"`).join(',');
      lines.push(`${this.name}_sum{${baseLabels}} ${this.sums.get(key)}`);
      lines.push(`${this.name}_count{${baseLabels}} ${this.counts_total.get(key)}`);
    }

    return lines.join('\n');
  }
}

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
const globalRegistry = new MetricsRegistry();

export function getRegistry(): MetricsRegistry {
  return globalRegistry;
}

export function resetRegistry(): void {
  globalRegistry.clear();
}

// Pre-defined trading metrics
export let TradingMetrics = {
  // Order execution metrics
  ordersSubmitted: new Counter('trading_orders_submitted_total', 'Total number of orders submitted'),
  ordersFilled: new Counter('trading_orders_filled_total', 'Total number of orders filled'),
  ordersFailed: new Counter('trading_orders_failed_total', 'Total number of orders that failed'),
  ordersCancelled: new Counter('trading_orders_cancelled_total', 'Total number of orders cancelled'),

  // Position metrics
  positionSize: new Gauge('trading_position_size', 'Current position size'),
  positionPnl: new Gauge('trading_position_pnl', 'Unrealized P&L'),
  totalExposure: new Gauge('trading_total_exposure', 'Total exposure across all positions'),

  // Arbitrage metrics
  arbitrageOpportunitiesFound: new Counter('trading_arbitrage_opportunities_total', 'Total arbitrage opportunities detected'),
  arbitrageExecuted: new Counter('trading_arbitrage_executed_total', 'Successful arbitrage executions'),
  arbitrageFailed: new Counter('trading_arbitrage_failed_total', 'Failed arbitrage attempts'),
  arbitrageProfit: new Counter('trading_arbitrage_profit_total', 'Total profit from arbitrage (USD)'),

  // Performance metrics
  orderExecutionTime: new Histogram('trading_order_execution_seconds', 'Order execution time in seconds', [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]),
  frankWolfeIterations: new Histogram('trading_frank_wolfe_iterations', 'Number of Frank-Wolfe iterations', [10, 25, 50, 75, 100, 150, 200]),
  frankWolfeGap: new Histogram('trading_frank_wolfe_gap', 'Frank-Wolfe optimality gap', [0.0001, 0.001, 0.01, 0.1, 1]),

  // Market data metrics
  orderBookUpdates: new Counter('trading_orderbook_updates_total', 'Total order book updates received'),
  websocketReconnects: new Counter('trading_websocket_reconnects_total', 'WebSocket reconnection count'),
  websocketErrors: new Counter('trading_websocket_errors_total', 'WebSocket error count'),
} as const;

// Register all trading metrics
Object.values(TradingMetrics).forEach((metric) => globalRegistry.register(metric));

/**
 * Record a trade execution
 */
export function recordTrade(
  marketId: string,
  side: 'buy' | 'sell',
  size: number,
  price: number,
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
  profitEstimate: number,
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
  return globalRegistry.toPrometheusFormat();
}
