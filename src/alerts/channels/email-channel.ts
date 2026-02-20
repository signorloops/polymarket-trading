/**
 * Email notification channel implementation using nodemailer
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type {
  AlertLevel,
  AlertNotification,
  EmailConfig,
  NotificationChannel,
} from '../types.js';

/**
 * Email notification channel
 */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  readonly enabled: boolean;

  private transporter: Transporter | null = null;
  private config: EmailConfig | null = null;

  constructor(config?: EmailConfig) {
    if (config && config.smtp.host && config.from && config.to.length > 0) {
      this.config = config;
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.auth,
        // Add timeout to prevent hanging
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      });
      this.enabled = true;
    } else {
      this.enabled = false;
    }
  }

  /**
   * Send notification via email
   */
  async send(notification: AlertNotification): Promise<boolean> {
    if (!this.enabled || !this.transporter || !this.config) {
      return false;
    }

    try {
      const html = this.buildHtml(notification);
      const text = this.buildText(notification);

      await this.transporter.sendMail({
        from: this.config.from,
        to: this.config.to.join(', '),
        subject: `[${notification.level.toUpperCase()}] ${notification.title}`,
        text,
        html,
        priority: this.getPriority(notification.level),
      });

      return true;
    } catch (error) {
      console.error('[EmailChannel] Failed to send notification:', error);
      return false;
    }
  }

  /**
   * Test email connectivity
   */
  async test(): Promise<boolean> {
    if (!this.enabled || !this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      console.error('[EmailChannel] Test failed:', error);
      return false;
    }
  }

  /**
   * Build HTML email body
   */
  private buildHtml(notification: AlertNotification): string {
    const color = this.getLevelColor(notification.level);

    const metadataRows = notification.metadata
      ? Object.entries(notification.metadata)
          .map(
            ([key, value]) => `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">${this.escapeHtml(key)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${this.formatHtmlValue(value)}</td>
          </tr>
        `
          )
          .join('')
      : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(notification.title)}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: ${color}; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
      <h1 style="margin: 0; font-size: 24px;">${this.getLevelEmoji(notification.level)} ${this.escapeHtml(notification.title)}</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">Level: ${notification.level.toUpperCase()}</p>
    </div>

    <div style="background-color: #f9f9f9; padding: 20px; border-left: 4px solid ${color};">
      <p style="margin: 0; white-space: pre-wrap;">${this.escapeHtml(notification.message)}</p>
    </div>

    ${metadataRows ? `
    <div style="margin-top: 20px;">
      <h3 style="margin-bottom: 10px;">Additional Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        ${metadataRows}
      </table>
    </div>
    ` : ''}

    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
      <p>Source: ${notification.source ?? 'unknown'}</p>
      <p>Time: ${notification.timestamp.toISOString()}</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Build plain text email body
   */
  private buildText(notification: AlertNotification): string {
    const metadata = notification.metadata
      ? '\n\nAdditional Details:\n' +
        Object.entries(notification.metadata)
          .map(([key, value]) => `  ${key}: ${this.formatTextValue(value)}`)
          .join('\n')
      : '';

    return `
[${notification.level.toUpperCase()}] ${notification.title}

${notification.message}
${metadata}

---
Source: ${notification.source ?? 'unknown'}
Time: ${notification.timestamp.toISOString()}
    `.trim();
  }

  /**
   * Get priority for email header
   */
  private getPriority(level: AlertLevel): 'high' | 'normal' | 'low' {
    switch (level) {
      case 'critical':
        return 'high';
      case 'warning':
        return 'normal';
      case 'info':
        return 'low';
    }
  }

  /**
   * Get color for alert level
   */
  private getLevelColor(level: AlertLevel): string {
    switch (level) {
      case 'info':
        return '#36a64f';
      case 'warning':
        return '#ff9900';
      case 'critical':
        return '#ff0000';
    }
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
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const div = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => div[char as keyof typeof div]);
  }

  /**
   * Format value for HTML display
   */
  private formatHtmlValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      return `<pre style="background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto;">${this.escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
    }
    if (typeof value === 'string') return this.escapeHtml(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return this.escapeHtml(value.toString());
    }
    if (typeof value === 'symbol') {
      return this.escapeHtml(value.description ?? 'Symbol');
    }
    return this.escapeHtml('[Function]');
  }

  /**
   * Format value for text display
   */
  private formatTextValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'symbol') {
      return value.description ?? 'Symbol';
    }
    return '[Function]';
  }
}
