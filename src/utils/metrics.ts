/**
 * Barrel file — re-exports all metrics modules.
 */
export { type MetricValue, type MetricLabels, Counter, Gauge, Histogram } from './metric-types.js';
export {
  TradingMetrics,
  getRegistry,
  resetMetricsRegistry,
  recordTrade,
  recordArbitrage,
  getMetricsForScraping,
  getLatencyPercentiles,
} from './metric-registry.js';
export { PerformanceAlertManager } from './performance-alert-manager.js';
