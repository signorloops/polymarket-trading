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
import { createSingleton } from '../utils/singleton.js';
import { getLogger } from '../utils/logger.js';
import { redactSecrets } from '../utils/redact.js';

function parseAlertLevel(value: string | undefined): AlertLevel {
  if (value === 'info' || value === 'warning' || value === 'critical') {
    return value;
  }
  return 'info';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Alert notification service
 * Manages multiple notification channels with deduplication and history
 */
export class AlertNotificationService {
  private channels: Map<string, NotificationChannel> = new Map();
  private config: AlertConfig;
  private alertHistory: AlertHistoryEntry[] = [];
  private recentAlerts: Map<string, number> = new Map();
  private logger = getLogger().child({ module: 'AlertNotificationService' });

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
    const channels: AlertConfig['channels'] = {};

    if (process.env.SLACK_WEBHOOK_URL) {
      channels.slack = {
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        ...(process.env.SLACK_CHANNEL ? { channel: process.env.SLACK_CHANNEL } : {}),
        username: process.env.SLACK_USERNAME ?? 'Polymarket Alerts',
        ...(process.env.SLACK_ICON_EMOJI ? { iconEmoji: process.env.SLACK_ICON_EMOJI } : {}),
      };
    }

    if (process.env.DISCORD_WEBHOOK_URL) {
      channels.discord = {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        username: process.env.DISCORD_USERNAME ?? 'Polymarket Alerts',
      };
    }

    if (process.env.SMTP_HOST && process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_TO) {
      channels.email = {
        smtp: {
          host: process.env.SMTP_HOST,
          port: parsePositiveInt(process.env.SMTP_PORT, 587),
          secure: process.env.SMTP_SECURE === 'true',
          ...(process.env.SMTP_USER && process.env.SMTP_PASS
            ? {
                auth: {
                  user: process.env.SMTP_USER,
                  pass: process.env.SMTP_PASS,
                },
              }
            : {}),
        },
        from: process.env.ALERT_EMAIL_FROM,
        to: parseCsvList(process.env.ALERT_EMAIL_TO),
      };
    }

    if (process.env.PAGERDUTY_INTEGRATION_KEY) {
      channels.pagerduty = {
        integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
      };
    }

    const config: AlertConfig = {
      enabled: process.env.ALERTS_ENABLED !== 'false',
      minLevel: parseAlertLevel(process.env.ALERTS_MIN_LEVEL),
      dedupWindowMinutes: parsePositiveInt(process.env.ALERTS_DEDUP_WINDOW_MINUTES, 5),
      channelTimeoutMs: parsePositiveInt(process.env.ALERTS_CHANNEL_TIMEOUT_MS, 10000),
      channels,
      routing: {
        info: parseCsvList(process.env.ALERT_ROUTING_INFO),
        warning:
          parseCsvList(process.env.ALERT_ROUTING_WARNING).length > 0
            ? parseCsvList(process.env.ALERT_ROUTING_WARNING)
            : ['slack', 'email'],
        critical:
          parseCsvList(process.env.ALERT_ROUTING_CRITICAL).length > 0
            ? parseCsvList(process.env.ALERT_ROUTING_CRITICAL)
            : ['slack', 'email', 'pagerduty'],
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

    // Redact credential values from metadata BEFORE it reaches any external
    // channel. Slack/Email/PagerDuty/Discord all stringify metadata verbatim
    // (PagerDuty even spreads it into custom_details), including nested objects —
    // so an axios error or request config in metadata would exfiltrate
    // authorization headers / API keys off-box. Sanitize once here.
    const safeNotification = this.sanitizeNotification(notification);

    // Get routing for this level
    const routing = this.config.routing[safeNotification.level];

    // Dispatch to every routed, enabled channel CONCURRENTLY with a per-channel
    // timeout. A sequential await loop lets one hung channel (Slack/Discord/
    // PagerDuty use bare fetch with no default timeout) block every later channel,
    // so a critical alert routed [slack, email, pagerduty] may never reach PagerDuty.
    const enabledChannels: [string, NotificationChannel][] = [];
    for (const channelName of routing) {
      const channel = this.channels.get(channelName);
      if (channel?.enabled) {
        enabledChannels.push([channelName, channel]);
      }
    }

    const results = await Promise.all(
      enabledChannels.map(async ([channelName, channel]) => {
        const ok = await this.sendToChannelWithTimeout(channel, safeNotification);
        if (!ok) {
          this.logger.warn('Alert channel send failed or timed out', { channel: channelName });
        }
        return { channelName, ok };
      })
    );

    const sentTo = results.filter((r) => r.ok).map((r) => r.channelName);
    const failedTo = results.filter((r) => !r.ok).map((r) => r.channelName);

    // Only record dedup when at least one channel succeeded; otherwise a transient
    // full outage would suppress all retries within the dedup window, silently
    // dropping the alert entirely.
    if (sentTo.length > 0) {
      this.recordAlert(safeNotification);
    }

    // Add to history
    const entry = this.createHistoryEntry(safeNotification, sentTo, failedTo);
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
    const notification: AlertNotification = {
      level,
      title,
      message,
      timestamp: new Date(),
      source: 'polymarket-trader',
      ...(metadata ? { metadata } : {}),
    };
    return this.send(notification);
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
  getHistory(limit = 100): AlertHistoryEntry[] {
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
   * Return a copy of `notification` with credential values redacted from its
   * metadata (recursively). Notifications without metadata are returned as-is.
   */
  private sanitizeNotification(notification: AlertNotification): AlertNotification {
    if (!notification.metadata) {
      return notification;
    }
    return {
      ...notification,
      metadata: redactSecrets(notification.metadata) as Record<string, unknown>,
    };
  }

  /**
   * Send to a single channel bounded by channelTimeoutMs. Never rejects: a thrown
   * send, a false result, or a timeout all resolve to false so concurrent dispatch
   * (Promise.all) is not short-circuited by one failing channel.
   */
  private async sendToChannelWithTimeout(
    channel: NotificationChannel,
    notification: AlertNotification
  ): Promise<boolean> {
    const timeoutMs = this.config.channelTimeoutMs ?? 10000;
    try {
      const sendPromise = Promise.resolve(channel.send(notification)).catch(() => false);
      if (timeoutMs <= 0) {
        const noTimeoutResult = await sendPromise;
        return noTimeoutResult;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timer.unref();
      });
      try {
        const result = await Promise.race([sendPromise, timeoutPromise]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return false;
    }
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
const notificationServiceSingleton = createSingleton(() => AlertNotificationService.fromEnv());

let notificationServiceOverride: AlertNotificationService | null = null;

/**
 * Initialize global notification service
 */
export function initNotificationService(service: AlertNotificationService): void {
  notificationServiceOverride = service;
}

/**
 * Get global notification service
 */
export function getNotificationService(): AlertNotificationService | null {
  return notificationServiceOverride ?? notificationServiceSingleton.get();
}

/**
 * Send alert using global service
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<AlertHistoryEntry> {
  const service = notificationServiceOverride ?? notificationServiceSingleton.get();
  return service.alert(level, title, message, metadata);
}
