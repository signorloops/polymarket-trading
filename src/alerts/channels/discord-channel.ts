/**
 * Discord notification channel implementation
 */

import type {
  AlertLevel,
  AlertNotification,
  DiscordConfig,
  NotificationChannel,
} from '../types.js';
import { getLogger } from '../../utils/logger.js';
import { redactSecrets } from '../../utils/redact.js';

/**
 * Color mapping for alert levels (Discord uses integer colors)
 */
const LEVEL_COLORS: Record<AlertLevel, number> = {
  info: 0x36a64f, // Green
  warning: 0xff9900, // Orange
  critical: 0xff0000, // Red
};

/**
 * Discord notification channel
 */
export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord';
  readonly enabled: boolean;

  private webhookUrl: string | null = null;
  private username: string;
  private readonly logger = getLogger().child({ module: 'DiscordChannel' });

  constructor(config?: DiscordConfig) {
    if (config?.webhookUrl) {
      this.webhookUrl = config.webhookUrl;
      this.username = config.username ?? 'Polymarket Alerts';
      this.enabled = true;
    } else {
      this.enabled = false;
      this.username = 'Polymarket Alerts';
    }
  }

  /**
   * Send notification to Discord
   */
  async send(notification: AlertNotification): Promise<boolean> {
    if (!this.enabled || !this.webhookUrl) {
      return false;
    }

    try {
      const payload = this.buildPayload({
        ...notification,
        ...(notification.metadata
          ? { metadata: redactSecrets(notification.metadata) as Record<string, unknown> }
          : {}),
      });

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.warn('Discord webhook rejected notification', { status: response.status });
        return false;
      }

      return true;
    } catch {
      this.logger.error('Discord notification delivery failed');
      return false;
    }
  }

  /**
   * Test Discord connectivity
   */
  async test(): Promise<boolean> {
    if (!this.enabled || !this.webhookUrl) {
      return false;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: '🔔 Discord notification channel test successful',
          username: this.username,
        }),
      });

      return response.ok;
    } catch {
      this.logger.error('Discord connectivity test failed');
      return false;
    }
  }

  /**
   * Build Discord webhook payload
   */
  private buildPayload(notification: AlertNotification): unknown {
    const embed = {
      title: `${this.getLevelEmoji(notification.level)} ${notification.title}`,
      description: notification.message,
      color: LEVEL_COLORS[notification.level],
      timestamp: notification.timestamp.toISOString(),
      footer: {
        text: `Source: ${notification.source ?? 'unknown'}`,
      },
      fields: this.buildFields(notification.metadata),
    };

    return {
      username: this.username,
      embeds: [embed],
    };
  }

  /**
   * Build embed fields from metadata
   */
  private buildFields(
    metadata: Record<string, unknown> | undefined
  ): { name: string; value: string; inline: boolean }[] {
    if (!metadata) return [];

    return Object.entries(metadata).map(([key, value]) => ({
      name: key,
      value: this.formatValue(value).slice(0, 1024), // Discord limit
      inline: String(value).length < 50,
    }));
  }

  /**
   * Get emoji for alert level
   */
  private getLevelEmoji(level: AlertLevel): string {
    switch (level) {
      case 'info':
        return 'ℹ️';
      case 'warning':
        return '⚠️';
      case 'critical':
        return '🚨';
    }
  }

  /**
   * Format a value for display
   */
  private formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      return '```json\n' + JSON.stringify(value, null, 2).slice(0, 1000) + '\n```';
    }
    return typeof value === 'string' ? value : String(value as number | boolean);
  }
}
