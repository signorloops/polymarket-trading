/**
 * Alert notification service - central manager for all notification channels
 */

import {
  type AlertConfig,
  type AlertHistoryEntry,
  type AlertLevel,
  type AlertNotification,
  type NotificationChannel,
} from './types.js';
import { SlackChannel } from './channels/slack-channel.js';
import { DiscordChannel } from './channels/discord-channel.js';
import { EmailChannel } from './channels/email-channel.js';
import { PagerDutyChannel } from './channels/pagerduty-channel.js';

/**
 * Alert notification service
 * Manages multiple notification channels with deduplication and history
 */
export class AlertNotificationService {
  private channels: Map<string, NotificationChannel> = new Map();
  private config: AlertConfig;
  private alertHistory: AlertHistoryEntry[] = [];
  private recentAlerts: Map<string, number> = new Map();

  /**
   * Create notification service with configuration
   */
  constructor(config: AlertConfig) {
    this.config = config;
    this.initializeChannels();
  }

  /**
   * Create service from environment variables
   */
  static fromEnv(): AlertNotificationService {
    const config: AlertConfig = {
      enabled: process.env.ALERTS_ENABLED !== 'false',
      minLevel: (process.env.ALERTS_MIN_LEVEL as AlertLevel) ?? 'info',
      dedupWindowMinutes: parseInt(process.env.ALERTS_DEDUP_WINDOW_MINUTES ?? '5', 10),
      channels: {
        slack: process.env.SLACK_WEBHOOK_URL
          ? {
              webhookUrl: process.env.SLACK_WEBHOOK_URL,
              channel: process.env.SLACK_CHANNEL,
              username: process.env.SLACK_USERNAME ?? 'Polymarket Alerts',
              iconEmoji: process.env.SLACK_ICON_EMOJI,
            }
          : undefined,
        discord: process.env.DISCORD_WEBHOOK_URL
          ? {
              webhookUrl: process.env.DISCORD_WEBHOOK_URL,
              username: process.env.DISCORD_USERNAME ?? 'Polymarket Alerts',
            }
          : undefined,
        email:
          process.env.SMTP_HOST && process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_TO
            ? {
                smtp: {
                  host: process.env.SMTP_HOST,
                  port: parseInt(process.env.SMTP_PORT ?? '587', 10),
                  secure: process.env.SMTP_SECURE === 'true',
                  auth:
                    process.env.SMTP_USER && process.env.SMTP_PASS
                      ? {
                          user: process.env.SMTP_USER,
                          pass: process.env.SMTP_PASS,
                        }
                      : undefined,
                },
                from: process.env.ALERT_EMAIL_FROM,
                to: process.env.ALERT_EMAIL_TO.split(',').map((e) => e.trim()),
              }
            : undefined,
        pagerduty: process.env.PAGERDUTY_INTEGRATION_KEY
          ? {
              integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
            }
          : undefined,
      },
      routing: {
        info: process.env.ALERT_ROUTING_INFO?.split(',') ?? [],
        warning: process.env.ALERT_ROUTING_WARNING?.split(',') ?? ['slack', 'email'],
        critical: process.env.ALERT_ROUTING_CRITICAL?.split(',') ?? [
          'slack',
          'email',
          'pagerduty',
        ],
      },
    };

    return new AlertNotificationService(config);
  }

  /**
   * Send alert through configured channels
   */
  async send(notification: AlertNotification): Promise<AlertHistoryEntry> {
    // Check if alerts are enabled
    if (!this.config.enabled) {
      return this.createHistoryEntry(notification, [], []);
    }

    // Check minimum level
    if (!this.shouldSendForLevel(notification.level)) {
      return this.createHistoryEntry(notification, [], []);
    }

    // Check deduplication
    if (this.isDuplicate(notification)) {
      return this.createHistoryEntry(notification, [], []);
    }

    // Get routing for this level
    const routing = this.config.routing[notification.level] ?? [];

    const sentTo: string[] = [];
    const failedTo: string[] = [];

    // Send to each routed channel
    for (const channelName of routing) {
      const channel = this.channels.get(channelName);
      if (channel?.enabled) {
        try {
          const success = await channel.send(notification);
          if (success) {
            sentTo.push(channelName);
          } else {
            failedTo.push(channelName);
          }
        } catch (error) {
          console.error(`[AlertNotificationService] Failed to send to ${channelName}:`, error);
          failedTo.push(channelName);
        }
      }
    }

    // Record sent alert for deduplication
    this.recordAlert(notification);

    // Add to history
    const entry = this.createHistoryEntry(notification, sentTo, failedTo);
    this.addToHistory(entry);

    return entry;
  }

  /**
   * Send alert with simple parameters
   */
  async alert(
    level: AlertLevel,
    title: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<AlertHistoryEntry> {
    return this.send({
      level,
      title,
      message,
      metadata,
      timestamp: new Date(),
      source: 'polymarket-trader',
    });
  }

  /**
   * Test all enabled channels
   */
  async testChannels(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, channel] of this.channels) {
      if (channel.enabled) {
        results[name] = await channel.test();
      } else {
        results[name] = false;
      }
    }

    return results;
  }

  /**
   * Get alert history
   */
  getHistory(limit: number = 100): AlertHistoryEntry[] {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Get recent alerts for deduplication check
   */
  getRecentAlerts(): Map<string, number> {
    return new Map(this.recentAlerts);
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.alertHistory = [];
    this.recentAlerts.clear();
  }

  /**
   * Get enabled channel names
   */
  getEnabledChannels(): string[] {
    return Array.from(this.channels.entries())
      .filter(([_, channel]) => channel.enabled)
      .map(([name, _]) => name);
  }

  /**
   * Initialize all channels from config
   */
  private initializeChannels(): void {
    if (this.config.channels.slack) {
      this.channels.set('slack', new SlackChannel(this.config.channels.slack));
    }

    if (this.config.channels.discord) {
      this.channels.set('discord', new DiscordChannel(this.config.channels.discord));
    }

    if (this.config.channels.email) {
      this.channels.set('email', new EmailChannel(this.config.channels.email));
    }

    if (this.config.channels.pagerduty) {
      this.channels.set('pagerduty', new PagerDutyChannel(this.config.channels.pagerduty));
    }
  }

  /**
   * Check if alert should be sent based on level
   */
  private shouldSendForLevel(level: AlertLevel): boolean {
    const levels: AlertLevel[] = ['info', 'warning', 'critical'];
    const configLevelIndex = levels.indexOf(this.config.minLevel);
    const alertLevelIndex = levels.indexOf(level);

    return alertLevelIndex >= configLevelIndex;
  }

  /**
   * Check if this alert is a duplicate
   */
  private isDuplicate(notification: AlertNotification): boolean {
    const dedupKey = notification.id ?? `${notification.title}-${notification.level}`;
    const lastSent = this.recentAlerts.get(dedupKey);

    if (!lastSent) {
      return false;
    }

    const windowMs = this.config.dedupWindowMinutes * 60 * 1000;
    return Date.now() - lastSent < windowMs;
  }

  /**
   * Record alert for deduplication
   */
  private recordAlert(notification: AlertNotification): void {
    const dedupKey = notification.id ?? `${notification.title}-${notification.level}`;
    this.recentAlerts.set(dedupKey, Date.now());

    // Clean up old entries
    this.cleanupRecentAlerts();
  }

  /**
   * Remove expired deduplication entries
   */
  private cleanupRecentAlerts(): void {
    const windowMs = this.config.dedupWindowMinutes * 60 * 1000;
    const now = Date.now();

    for (const [key, timestamp] of this.recentAlerts) {
      if (now - timestamp > windowMs) {
        this.recentAlerts.delete(key);
      }
    }
  }

  /**
   * Create history entry
   */
  private createHistoryEntry(
    notification: AlertNotification,
    sentTo: string[],
    failedTo: string[]
  ): AlertHistoryEntry {
    return {
      ...notification,
      sentTo,
      failedTo,
    };
  }

  /**
   * Add entry to history with size limit
   */
  private addToHistory(entry: AlertHistoryEntry): void {
    this.alertHistory.push(entry);

    // Keep only last 1000 entries
    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }
  }
}

// Global instance
let globalNotificationService: AlertNotificationService | null = null;

/**
 * Initialize global notification service
 */
export function initNotificationService(service: AlertNotificationService): void {
  globalNotificationService = service;
}

/**
 * Get global notification service
 */
export function getNotificationService(): AlertNotificationService | null {
  return globalNotificationService;
}

/**
 * Send alert using global service
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<AlertHistoryEntry | null> {
  if (!globalNotificationService) {
    console.warn('[AlertNotificationService] No global service initialized');
    return null;
  }

  return globalNotificationService.alert(level, title, message, metadata);
}
