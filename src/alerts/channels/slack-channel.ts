/**
 * Slack notification channel implementation
 */

import { IncomingWebhook } from '@slack/webhook';
import type { IncomingWebhookSendArguments } from '@slack/webhook';
import {
  type AlertNotification,
  type NotificationChannel,
  type SlackConfig,
  type AlertLevel,
} from '../types.js';

/**
 * Color mapping for alert levels
 */
const LEVEL_COLORS: Record<AlertLevel, string> = {
  info: '#36a64f', // Green
  warning: '#ff9900', // Orange
  critical: '#ff0000', // Red
};

/**
 * Slack notification channel
 */
export class SlackChannel implements NotificationChannel {
  readonly name = 'slack';
  readonly enabled: boolean;

  private client: IncomingWebhook | null = null;
  private config: SlackConfig | null = null;

  constructor(config?: SlackConfig) {
    if (config?.webhookUrl) {
      this.config = config;
      this.client = new IncomingWebhook(config.webhookUrl);
      this.enabled = true;
    } else {
      this.enabled = false;
    }
  }

  /**
   * Send notification to Slack
   */
  async send(notification: AlertNotification): Promise<boolean> {
    if (!this.enabled || !this.client) {
      return false;
    }

    try {
      const blocks = this.buildBlocks(notification);
      const payload: IncomingWebhookSendArguments = {
        username: this.config?.username ?? 'Polymarket Alerts',
        icon_emoji: this.config?.iconEmoji ?? ':warning:',
        blocks,
        attachments: [
          {
            color: LEVEL_COLORS[notification.level],
            fields: this.buildFields(notification.metadata),
            footer: `Source: ${notification.source ?? 'unknown'}`,
            ts: String(Math.floor(notification.timestamp.getTime() / 1000)),
          },
        ],
        ...(this.config?.channel ? { channel: this.config.channel } : {}),
      };

      await this.client.send(payload);

      return true;
    } catch (error) {
      console.error('[SlackChannel] Failed to send notification:', error);
      return false;
    }
  }

  /**
   * Test Slack connectivity
   */
  async test(): Promise<boolean> {
    if (!this.enabled || !this.client) {
      return false;
    }

    try {
      await this.client.send({
        text: '🔔 Slack notification channel test successful',
        username: this.config?.username ?? 'Polymarket Alerts',
      });
      return true;
    } catch (error) {
      console.error('[SlackChannel] Test failed:', error);
      return false;
    }
  }

  /**
   * Build Slack blocks from notification
   */
  private buildBlocks(
    notification: AlertNotification
  ): NonNullable<IncomingWebhookSendArguments['blocks']> {
    const blocks: NonNullable<IncomingWebhookSendArguments['blocks']> = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${this.getLevelEmoji(notification.level)} ${notification.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: notification.message,
        },
      },
    ];

    // Add metadata section if present
    if (notification.metadata && Object.keys(notification.metadata).length > 0) {
      blocks.push({
        type: 'section',
        fields: Object.entries(notification.metadata).map(([key, value]) => ({
          type: 'mrkdwn',
          text: `*${key}:*\n${this.formatValue(value)}`,
        })),
      });
    }

    return blocks;
  }

  /**
   * Build attachment fields from metadata
   */
  private buildFields(
    metadata: Record<string, unknown> | undefined
  ): Array<{ title: string; value: string; short: boolean }> {
    if (!metadata) return [];

    return Object.entries(metadata).map(([key, value]) => ({
      title: key,
      value: this.formatValue(value),
      short: String(value).length < 50,
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
      return '```' + JSON.stringify(value, null, 2).slice(0, 100) + '```';
    }
    return String(value);
  }
}
