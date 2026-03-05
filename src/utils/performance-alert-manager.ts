/**
 * PerformanceAlertManager - monitors metrics and triggers alerts.
 */

import { getLogger } from './logger.js';
import {
  AlertNotificationService,
  type AlertNotification,
  type MetricAlert,
} from '../alerts/index.js';
import { getErrorMessage } from './errors.js';
import { Counter, Gauge } from './metric-types.js';
import { TradingMetrics, getLatencyPercentiles } from './metric-registry.js';

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

  setNotificationService(service: AlertNotificationService): void {
    this.notificationService = service;
  }

  addAlert(config: MetricAlert): void {
    this.alertConfigs.set(config.metricName, config);
    this.logger.info(`Added alert for metric: ${config.metricName}`);
  }

  removeAlert(metricName: string): void {
    this.alertConfigs.delete(metricName);
    this.alertStates.delete(metricName);
    this.logger.info(`Removed alert for metric: ${metricName}`);
  }

  start(checkIntervalMs = 30000): void {
    if (this.checkInterval) {
      this.logger.warn('Alert manager already running');
      return;
    }

    this.logger.info(`Starting performance alert manager (interval: ${String(checkIntervalMs)}ms)`);
    this.checkInterval = setInterval(() => {
      void this.checkAlerts();
    }, checkIntervalMs);

    this.checkInterval.unref();
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info('Stopped performance alert manager');
    }
  }

  getAlertHistory(limit = 100): AlertNotification[] {
    return this.alertHistory.slice(-limit);
  }

  clearHistory(): void {
    this.alertHistory = [];
  }

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
        this.logger.error(`Error checking alert for ${metricName}:`, {
          error: getErrorMessage(error),
        });
      }
    }
  }

  private getMetricValue(metricName: string): number | null {
    type LatencyMetricName = Parameters<typeof getLatencyPercentiles>[0];
    const mapping: { patterns: string[]; metricKey: LatencyMetricName }[] = [
      {
        patterns: [
          'orderBookUpdateLatency',
          'orderbook_update_latency',
          'trading_orderbook_update_latency_ms',
        ],
        metricKey: 'orderBookUpdateLatency',
      },
      {
        patterns: [
          'arbitrageDetectionLatency',
          'arbitrage_detection_latency',
          'trading_arbitrage_detection_latency_ms',
        ],
        metricKey: 'arbitrageDetectionLatency',
      },
      {
        patterns: [
          'wsMessageProcessingTime',
          'ws_message_processing',
          'trading_ws_message_processing_ms',
        ],
        metricKey: 'wsMessageProcessingTime',
      },
      {
        patterns: [
          'orderExecutionLatency',
          'order_execution_latency',
          'trading_order_execution_latency_ms',
        ],
        metricKey: 'orderExecutionLatency',
      },
      {
        patterns: ['riskCheckLatency', 'risk_check_latency', 'trading_risk_check_latency_ms'],
        metricKey: 'riskCheckLatency',
      },
    ];

    for (const { patterns, metricKey } of mapping) {
      if (patterns.some((pattern) => metricName === pattern || metricName.includes(pattern))) {
        return getLatencyPercentiles(metricKey).p95;
      }
    }

    const metric = TradingMetrics[metricName as keyof typeof TradingMetrics];
    if (metric instanceof Counter || metric instanceof Gauge) {
      return metric.get();
    }

    return null;
  }

  private evaluateAlert(config: MetricAlert, currentValue: number): boolean {
    const now = Date.now();
    const state = this.alertStates.get(config.metricName);

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
      if (state) {
        this.alertStates.delete(config.metricName);
      }
      return false;
    }

    if (config.duration > 0) {
      if (!state) {
        this.alertStates.set(config.metricName, { firstTriggeredAt: now, lastAlertedAt: 0 });
        return false;
      }

      const elapsedSeconds = (now - state.firstTriggeredAt) / 1000;
      if (elapsedSeconds < config.duration) {
        return false;
      }

      if (state.lastAlertedAt > state.firstTriggeredAt) {
        return false;
      }

      state.lastAlertedAt = now;
      return true;
    }

    if (!state) {
      this.alertStates.set(config.metricName, { firstTriggeredAt: now, lastAlertedAt: now });
      return true;
    }

    return false;
  }

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
      id: `metric-alert-${config.metricName}-${String(Date.now())}`,
    };

    this.alertHistory.push(notification);
    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }

    if (this.notificationService) {
      try {
        await this.notificationService.send(notification);
      } catch (error) {
        this.logger.error('Failed to send alert notification:', {
          error: getErrorMessage(error),
        });
      }
    }

    this.logger.warn(`Alert fired: ${config.title} (value: ${String(currentValue)})`);
  }
}

