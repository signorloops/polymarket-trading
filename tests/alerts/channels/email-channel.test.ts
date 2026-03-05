import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSendMail = jest.fn<() => Promise<unknown>>().mockResolvedValue({ messageId: 'test' });
const mockVerify = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockCreateTransport = jest.fn().mockReturnValue({
  sendMail: mockSendMail,
  verify: mockVerify,
});

jest.unstable_mockModule('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

const { EmailChannel } = await import('../../../src/alerts/channels/email-channel.js');
import type { AlertNotification, EmailConfig } from '../../../src/alerts/types.js';

describe('EmailChannel', () => {
  const validConfig: EmailConfig = {
    smtp: { host: 'smtp.example.com', port: 587, secure: false },
    from: 'alerts@example.com',
    to: ['admin@example.com'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
    mockVerify.mockResolvedValue(true);
  });

  function makeNotification(overrides: Partial<AlertNotification> = {}): AlertNotification {
    return {
      level: 'warning',
      title: 'Test Alert',
      message: 'Something happened',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      source: 'test',
      ...overrides,
    };
  }

  describe('constructor', () => {
    it('should be enabled with complete config', () => {
      const channel = new EmailChannel(validConfig);
      expect(channel.enabled).toBe(true);
      expect(channel.name).toBe('email');
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          secure: false,
        })
      );
    });

    it('should be disabled without config', () => {
      const channel = new EmailChannel(undefined);
      expect(channel.enabled).toBe(false);
    });

    it('should be disabled without smtp.host', () => {
      const channel = new EmailChannel({
        smtp: { host: '', port: 587, secure: false },
        from: 'a@b.com',
        to: ['c@d.com'],
      });
      expect(channel.enabled).toBe(false);
    });

    it('should be disabled without from', () => {
      const channel = new EmailChannel({
        smtp: { host: 'smtp.example.com', port: 587, secure: false },
        from: '',
        to: ['c@d.com'],
      });
      expect(channel.enabled).toBe(false);
    });

    it('should be disabled with empty to array', () => {
      const channel = new EmailChannel({
        smtp: { host: 'smtp.example.com', port: 587, secure: false },
        from: 'a@b.com',
        to: [],
      });
      expect(channel.enabled).toBe(false);
    });
  });

  describe('send', () => {
    it('should return false when disabled', async () => {
      const channel = new EmailChannel(undefined);
      const result = await channel.send(makeNotification());
      expect(result).toBe(false);
    });

    it('should send successfully and return true', async () => {
      const channel = new EmailChannel(validConfig);
      const result = await channel.send(makeNotification());

      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('should return false when sendMail throws', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));

      const channel = new EmailChannel(validConfig);
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should set subject with level prefix', async () => {
      const channel = new EmailChannel(validConfig);
      await channel.send(makeNotification({ level: 'critical', title: 'Server Down' }));

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[CRITICAL] Server Down',
        })
      );
    });

    it('should map priority correctly for each level', async () => {
      const channel = new EmailChannel(validConfig);

      await channel.send(makeNotification({ level: 'critical' }));
      expect(mockSendMail).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'high' }));

      await channel.send(makeNotification({ level: 'warning' }));
      expect(mockSendMail).toHaveBeenLastCalledWith(
        expect.objectContaining({ priority: 'normal' })
      );

      await channel.send(makeNotification({ level: 'info' }));
      expect(mockSendMail).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'low' }));
    });

    it('should include metadata in HTML body', async () => {
      const channel = new EmailChannel(validConfig);
      await channel.send(
        makeNotification({
          metadata: { region: 'us-east-1', count: 42 },
        })
      );

      const call = mockSendMail.mock.calls[0] as { html: string; text: string }[];
      const { html, text } = call[0];

      expect(html).toContain('region');
      expect(html).toContain('us-east-1');
      expect(text).toContain('region');
      expect(text).toContain('42');
    });

    it('should escape HTML special characters', async () => {
      const channel = new EmailChannel(validConfig);
      await channel.send(
        makeNotification({
          title: '<script>alert("xss")</script>',
          metadata: { key: '<b>bold</b>' },
        })
      );

      const call = mockSendMail.mock.calls[0] as { html: string }[];
      const { html } = call[0];

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('should set from and to fields correctly', async () => {
      const multiTo: EmailConfig = {
        ...validConfig,
        to: ['a@b.com', 'c@d.com'],
      };
      const channel = new EmailChannel(multiTo);
      await channel.send(makeNotification());

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'alerts@example.com',
          to: 'a@b.com, c@d.com',
        })
      );
    });
  });

  describe('test', () => {
    it('should return false when disabled', async () => {
      const channel = new EmailChannel(undefined);
      const result = await channel.test();
      expect(result).toBe(false);
    });

    it('should return true when verify succeeds', async () => {
      const channel = new EmailChannel(validConfig);
      const result = await channel.test();

      expect(result).toBe(true);
      expect(mockVerify).toHaveBeenCalledTimes(1);
    });

    it('should return false when verify throws', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Connection refused'));

      const channel = new EmailChannel(validConfig);
      const result = await channel.test();

      expect(result).toBe(false);
    });
  });
});
