/**
 * Barrel file — re-exports all metrics modules.
 */
export { type MetricValue, type MetricLabels, Counter, Gauge, Histogram } from './metric-types.js';
export {
  TradingMetrics,
  getRegistry,
  resetRegistry,
  recordTrade,
  recordArbitrage,
  getMetricsForScraping,
  getLatencyPercentiles,
} from './metric-registry.js';
export {
  PerformanceAlertManager,
  initPerformanceAlertManager,
  getPerformanceAlertManager,
  setupDefaultAlerts,
} from './performance-alert-manager.js';
