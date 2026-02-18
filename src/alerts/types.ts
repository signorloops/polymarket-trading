/**
 * Alert notification types and interfaces
 */

/**
 * Alert severity levels
 */
export type AlertLevel = 'info' | 'warning' | 'critical';

/**
 * Alert notification structure
 */
export interface AlertNotification {
  /** Alert severity level */
  level: AlertLevel;
  /** Short alert title */
  title: string;
  /** Detailed alert message */
  message: string;
  /** Optional metadata for context */
  metadata?: Record<string, unknown>;
  /** Alert timestamp */
  timestamp: Date;
  /** Unique alert identifier (for deduplication) */
  id?: string;
  /** Source component */
  source?: string;
}

/**
 * Notification channel interface
 */
export interface NotificationChannel {
  /** Channel name */
  readonly name: string;
  /** Channel enabled status */
  readonly enabled: boolean;
  /**
   * Send notification through this channel
   * @param notification - Alert to send
   * @returns Promise resolving to success status
   */
  send(notification: AlertNotification): Promise<boolean>;
  /**
   * Test channel connectivity
   * @returns Promise resolving to test success status
   */
  test(): Promise<boolean>;
}

/**
 * Channel configuration types
 */
export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
}

export interface DiscordConfig {
  webhookUrl: string;
  username?: string;
}

export interface EmailConfig {
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  };
  from: string;
  to: string[];
}

export interface PagerDutyConfig {
  integrationKey: string;
  severityMap?: Record<AlertLevel, 'info' | 'warning' | 'error' | 'critical'>;
}

/**
 * Complete alert configuration
 */
export interface AlertConfig {
  /** Global alert enabled */
  enabled: boolean;
  /** Minimum level to send (defaults to 'info') */
  minLevel: AlertLevel;
  /** Deduplication window in minutes (defaults to 5) */
  dedupWindowMinutes: number;
  /** Channel configurations */
  channels: {
    slack?: SlackConfig;
    discord?: DiscordConfig;
    email?: EmailConfig;
    pagerduty?: PagerDutyConfig;
  };
  /** Level routing rules (which channels for each level) */
  routing: Record<AlertLevel, string[]>;
}

/**
 * Alert history entry
 */
export interface AlertHistoryEntry extends AlertNotification {
  /** Channels that successfully received this alert */
  sentTo: string[];
  /** Channels that failed to send */
  failedTo: string[];
}

/**
 * Metric alert definition
 */
export interface MetricAlert {
  /** Metric name */
  metricName: string;
  /** Threshold value */
  threshold: number;
  /** Comparison operator */
  operator: 'gt' | 'lt' | 'eq';
  /** Alert level */
  level: AlertLevel;
  /** Duration in seconds before triggering (0 = immediate) */
  duration: number;
  /** Alert title template */
  title: string;
  /** Alert message template */
  message: string;
}
