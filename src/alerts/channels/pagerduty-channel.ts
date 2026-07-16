/**
 * PagerDuty notification channel implementation
 */

import type {
  AlertLevel,
  AlertNotification,
  NotificationChannel,
  PagerDutyConfig,
} from '../types.js';
import { getLogger } from '../../utils/logger.js';
import { redactSecrets } from '../../utils/redact.js';

/**
 * PagerDuty severity mapping
 */
type PagerDutySeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * PagerDuty event payload
 */
interface PagerDutyEventPayload {
  routing_key: string;
  event_action: 'trigger' | 'resolve';
  dedup_key?: string;
  payload: {
    summary: string;
    severity: PagerDutySeverity;
    source: string;
    timestamp: string;
    custom_details?: Record<string, unknown>;
  };
}

/**
 * Default severity mapping
 */
const DEFAULT_SEVERITY_MAP: Record<AlertLevel, PagerDutySeverity> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

/**
 * PagerDuty notification channel
 */
export class PagerDutyChannel implements NotificationChannel {
  readonly name = 'pagerduty';
  readonly enabled: boolean;

  private integrationKey: string | null = null;
  private severityMap: Record<AlertLevel, PagerDutySeverity>;
  private readonly logger = getLogger().child({ module: 'PagerDutyChannel' });

  constructor(config?: PagerDutyConfig) {
    if (config?.integrationKey) {
      this.integrationKey = config.integrationKey;
      this.severityMap = config.severityMap ?? DEFAULT_SEVERITY_MAP;
      this.enabled = true;
    } else {
      this.enabled = false;
      this.severityMap = DEFAULT_SEVERITY_MAP;
    }
  }

  /**
   * Send notification to PagerDuty
   */
  async send(notification: AlertNotification): Promise<boolean> {
    if (!this.enabled || !this.integrationKey) {
      return false;
    }

    // Skip info level for PagerDuty (only warning and critical)
    if (notification.level === 'info') {
      return false;
    }

    try {
      const payload = this.buildPayload(notification, this.integrationKey);

      const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.warn('PagerDuty API rejected notification', { status: response.status });
        return false;
      }

      const result: unknown = await response.json();
      if (
        typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        (result as { status: unknown }).status === 'success'
      ) {
        return true;
      }
      return false;
    } catch {
      this.logger.error('PagerDuty notification delivery failed');
      return false;
    }
  }

  /**
   * Test PagerDuty connectivity
   */
  async test(): Promise<boolean> {
    if (!this.enabled || !this.integrationKey) {
      return false;
    }

    try {
      const payload: PagerDutyEventPayload = {
        routing_key: this.integrationKey,
        event_action: 'trigger',
        dedup_key: 'test-alert',
        payload: {
          summary: 'Test alert from Polymarket trading system',
          severity: 'info',
          source: 'polymarket-trader',
          timestamp: new Date().toISOString(),
        },
      };

      const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      return response.ok;
    } catch {
      this.logger.error('PagerDuty connectivity test failed');
      return false;
    }
  }

  /**
   * Build PagerDuty event payload
   */
  private buildPayload(
    notification: AlertNotification,
    integrationKey: string
  ): PagerDutyEventPayload {
    const dedupKey = notification.id ?? `${notification.title}-${notification.level}`;

    return {
      routing_key: integrationKey,
      event_action: 'trigger',
      dedup_key: dedupKey,
      payload: {
        summary: notification.title,
        severity: this.severityMap[notification.level],
        source: notification.source ?? 'polymarket-trader',
        timestamp: notification.timestamp.toISOString(),
        custom_details: {
          message: notification.message,
          ...(redactSecrets(notification.metadata) as Record<string, unknown> | undefined),
        },
      },
    };
  }
}
