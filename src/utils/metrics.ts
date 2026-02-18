/**
 * Prometheus-style metrics collection for trading system monitoring
 *
 * Provides counters, gauges, and histograms for key performance indicators.
 * Metrics can be exported to Prometheus or other monitoring systems.
 */

import { getLogger } from './logger.js';
import {
  AlertNotificationService,
  type AlertLevel,
  type AlertNotification,
  type MetricAlert,
} from '../alerts/index.js';
import { calculateHistogramPercentiles, type HistogramPoint } from './percentile.js';

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
    for (const [, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${String(point.value)}`);
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
    for (const [, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${String(point.value)}`);
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

  constructor(name: string, description: string, buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    super(name, description);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels = {}, value: number): void {
    const key = this.serializeLabels(labels);

    // Initialize buckets if needed
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array<number>(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.counts_total.set(key, 0);
    }

    const bucketCounts = this.counts.get(key);
    if (!bucketCounts) return;
    for (let i = 0; i < this.buckets.length; i++) {
      const bucketValue = this.buckets[i];
      if (bucketValue !== undefined && value <= bucketValue) {
        const currentCount = bucketCounts[i];
        if (currentCount !== undefined) {
          bucketCounts[i] = currentCount + 1;
        }
      }
    }

    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts_total.set(key, (this.counts_total.get(key) ?? 0) + 1);
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} histogram`];

    for (const [key, bucketCounts] of this.counts) {
      const labelEntries: [string, string][] = key
        .split(',')
        .filter((s) => s)
        .map((s) => {
          const [k, v] = s.split('=');
          return [k ?? '', v?.replace(/"/g, '') ?? ''];
        });

      // Output bucket counts
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketValue = this.buckets[i];
        const bucketCount = bucketCounts[i];
        if (bucketValue === undefined || bucketCount === undefined) continue;
        const labels = [...labelEntries, ['le', bucketValue.toString()] as [string, string]]
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        lines.push(`${this.name}_bucket{${labels}} ${String(bucketCount)}`);
      }

      // +Inf bucket
      const infLabels = [...labelEntries, ['le', '+Inf'] as [string, string]].map(([k, v]) => `${k}="${v}"`).join(',');
      const totalCount = this.counts_total.get(key);
      if (totalCount !== undefined) {
        lines.push(`${this.name}_bucket{${infLabels}} ${String(totalCount)}`);
      }

      // Sum and count
      const baseLabels = labelEntries.map(([k, v]) => `${k}="${v}"`).join(',');
      const sumValue = this.sums.get(key);
      if (sumValue !== undefined) {
        lines.push(`${this.name}_sum{${baseLabels}} ${String(sumValue)}`);
      }
      if (totalCount !== undefined) {
        lines.push(`${this.name}_count{${baseLabels}} ${String(totalCount)}`);
      }
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
export const TradingMetrics = {
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

// Register all trading metrics
Object.values(TradingMetrics).forEach((metric) => { globalRegistry.register(metric); });

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

/**
 * Get latency percentiles for a histogram metric
 * Returns p50, p95, p99 values
 */
export function getLatencyPercentiles(
  metricName: 'orderBookUpdateLatency' | 'arbitrageDetectionLatency' | 'wsMessageProcessingTime' | 'orderExecutionLatency' | 'riskCheckLatency'
): { p50: number; p95: number; p99: number; count: number } {
  const metric = TradingMetrics[metricName];

  // Access histogram internals for percentile calculation
  // This is a simplified approach - in production you'd want a cleaner API
  const histogramData: HistogramPoint[] = [];

  // Get bucket counts from histogram
  // @ts-expect-error - accessing private fields for percentile calculation
  const counts = metric.counts as Map<string, number[]>;
  // @ts-expect-error - accessing private fields
  const buckets = metric.buckets as number[];

  if (counts.size === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }

  // Aggregate counts across all label combinations
  const totalCounts = new Array(buckets.length).fill(0);
  let totalObservations = 0;

  for (const [, bucketCounts] of counts) {
    for (let i = 0; i < buckets.length; i++) {
      totalCounts[i]! += bucketCounts[i] ?? 0;
    }
  }

  // @ts-expect-error - accessing private fields
  const countsTotal = metric.counts_total as Map<string, number>;
  for (const [, count] of countsTotal) {
    totalObservations += count;
  }

  // Build histogram points
  for (let i = 0; i < buckets.length; i++) {
    histogramData.push({
      value: buckets[i]!,
      count: totalCounts[i]!,
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

/**
 * Performance alert manager
 * Monitors metrics and triggers alerts when thresholds are breached
 */
export class PerformanceAlertManager {
  private alertConfigs: Map<string, MetricAlert> = new Map();
  private alertStates: Map<string, { firstTriggeredAt: number; lastAlertedAt: number }> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private notificationService: AlertNotificationService | null = null;
  private alertHistory: AlertNotification[] = [];
  private logger = getLogger().child({ module: 'PerformanceAlertManager' });

  constructor(notificationService?: AlertNotificationService) {
    if (notificationService) {
      this.notificationService = notificationService;
    }
  }

  /**
   * Set notification service
   */
  setNotificationService(service: AlertNotificationService): void {
    this.notificationService = service;
  }

  /**
   * Add a metric alert configuration
   */
  addAlert(config: MetricAlert): void {
    this.alertConfigs.set(config.metricName, config);
    this.logger.info(`Added alert for metric: ${config.metricName}`);
  }

  /**
   * Remove a metric alert
   */
  removeAlert(metricName: string): void {
    this.alertConfigs.delete(metricName);
    this.alertStates.delete(metricName);
    this.logger.info(`Removed alert for metric: ${metricName}`);
  }

  /**
   * Start monitoring with specified check interval
   */
  start(checkIntervalMs: number = 30000): void {
    if (this.checkInterval) {
      this.logger.warn('Alert manager already running');
      return;
    }

    this.logger.info(`Starting performance alert manager (interval: ${checkIntervalMs}ms)`);
    this.checkInterval = setInterval(() => {
      void this.checkAlerts();
    }, checkIntervalMs);

    // Ensure interval doesn't keep process alive
    this.checkInterval.unref();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info('Stopped performance alert manager');
    }
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit: number = 100): AlertNotification[] {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.alertHistory = [];
  }

  /**
   * Check all configured alerts
   */
  private async checkAlerts(): Promise<void> {
    for (const [metricName, config] of this.alertConfigs) {
      try {
        const currentValue = this.getMetricValue(metricName);
        if (currentValue === null) continue;

        const shouldAlert = this.evaluateAlert(config, currentValue);

        if (shouldAlert) {
          await this.fireAlert(config, currentValue);
        }
      } catch (error) {
        this.logger.error(`Error checking alert for ${metricName}:`, error);
      }
    }
  }

  /**
   * Get current value for a metric
   */
  private getMetricValue(metricName: string): number | null {
    // Handle latency metrics
    if (metricName.endsWith('_latency_ms') || metricName.endsWith('_processing_ms')) {
      const mapping: Record<string, keyof typeof TradingMetrics> = {
        orderBookUpdateLatency: 'orderBookUpdateLatency',
        arbitrageDetectionLatency: 'arbitrageDetectionLatency',
        wsMessageProcessingTime: 'wsMessageProcessingTime',
        orderExecutionLatency: 'orderExecutionLatency',
        riskCheckLatency: 'riskCheckLatency',
      };

      for (const [key, metricKey] of Object.entries(mapping)) {
        if (metricName.includes(key)) {
          const percentiles = getLatencyPercentiles(metricKey);
          // Use p95 for latency alerts
          return percentiles.p95;
        }
      }
      return null;
    }

    // Handle counter/gauge metrics
    const metric = TradingMetrics[metricName as keyof typeof TradingMetrics];
    if (metric instanceof Counter || metric instanceof Gauge) {
      return metric.get();
    }

    return null;
  }

  /**
   * Evaluate if alert should fire
   */
  private evaluateAlert(config: MetricAlert, currentValue: number): boolean {
    const now = Date.now();
    const state = this.alertStates.get(config.metricName);

    // Check if threshold is breached
    let thresholdBreached = false;
    switch (config.operator) {
      case 'gt':
        thresholdBreached = currentValue > config.threshold;
        break;
      case 'lt':
        thresholdBreached = currentValue < config.threshold;
        break;
      case 'eq':
        thresholdBreached = currentValue === config.threshold;
        break;
    }

    if (!thresholdBreached) {
      // Reset state if threshold is no longer breached
      if (state) {
        this.alertStates.delete(config.metricName);
      }
      return false;
    }

    // Check duration requirement
    if (config.duration > 0) {
      if (!state) {
        // First time threshold breached
        this.alertStates.set(config.metricName, { firstTriggeredAt: now, lastAlertedAt: 0 });
        return false;
      }

      const elapsedSeconds = (now - state.firstTriggeredAt) / 1000;
      if (elapsedSeconds < config.duration) {
        return false; // Haven't met duration requirement yet
      }

      // Check if we've already alerted for this breach
      if (state.lastAlertedAt > state.firstTriggeredAt) {
        return false; // Already alerted for this breach
      }

      // Mark as alerted
      state.lastAlertedAt = now;
      return true;
    }

    // Immediate alert (no duration)
    if (!state) {
      this.alertStates.set(config.metricName, { firstTriggeredAt: now, lastAlertedAt: now });
      return true;
    }

    return false;
  }

  /**
   * Fire an alert
   */
  private async fireAlert(config: MetricAlert, currentValue: number): Promise<void> {
    const notification: AlertNotification = {
      level: config.level,
      title: config.title,
      message: config.message.replace('{{value}}', String(currentValue)),
      metadata: {
        metricName: config.metricName,
        threshold: config.threshold,
        currentValue,
        operator: config.operator,
      },
      timestamp: new Date(),
      source: 'PerformanceAlertManager',
      id: `metric-alert-${config.metricName}-${Date.now()}`,
    };

    // Add to history
    this.alertHistory.push(notification);
    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }

    // Send through notification service
    if (this.notificationService) {
      try {
        await this.notificationService.send(notification);
      } catch (error) {
        this.logger.error('Failed to send alert notification:', error);
      }
    }

    this.logger.warn(`Alert fired: ${config.title} (value: ${currentValue})`);
  }
}

// Global instance
let globalAlertManager: PerformanceAlertManager | null = null;

/**
 * Initialize global performance alert manager
 */
export function initPerformanceAlertManager(
  notificationService?: AlertNotificationService
): PerformanceAlertManager {
  globalAlertManager = new PerformanceAlertManager(notificationService);
  return globalAlertManager;
}

/**
 * Get global performance alert manager
 */
export function getPerformanceAlertManager(): PerformanceAlertManager | null {
  return globalAlertManager;
}

/**
 * Setup default performance alerts
 */
export function setupDefaultAlerts(manager: PerformanceAlertManager): void {
  // Order execution latency alert (p95 > 5s)
  manager.addAlert({
    metricName: 'orderExecutionLatency',
    threshold: 5000,
    operator: 'gt',
    level: 'warning',
    duration: 60, // Alert if consistently high for 60 seconds
    title: 'High Order Execution Latency',
    message: 'Order execution p95 latency ({{value}}ms) exceeds 5000ms threshold',
  });

  // Arbitrage detection latency alert (p95 > 500ms)
  manager.addAlert({
    metricName: 'arbitrageDetectionLatency',
    threshold: 500,
    operator: 'gt',
    level: 'warning',
    duration: 30,
    title: 'High Arbitrage Detection Latency',
    message: 'Arbitrage detection p95 latency ({{value}}ms) exceeds 500ms threshold',
  });

  // WebSocket errors alert
  manager.addAlert({
    metricName: 'websocketErrors',
    threshold: 10,
    operator: 'gt',
    level: 'critical',
    duration: 0, // Immediate
    title: 'High WebSocket Error Rate',
    message: 'WebSocket error count ({{value}}) exceeds threshold',
  });

  // Risk check latency alert (p95 > 100ms)
  manager.addAlert({
    metricName: 'riskCheckLatency',
    threshold: 100,
    operator: 'gt',
    level: 'warning',
    duration: 60,
    title: 'High Risk Check Latency',
    message: 'Risk check p95 latency ({{value}}ms) exceeds 100ms threshold',
  });
}
