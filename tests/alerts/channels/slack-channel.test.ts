import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockWebhookSend = jest.fn<() => Promise<unknown>>().mockResolvedValue({ text: 'ok' });

jest.unstable_mockModule('@slack/webhook', () => ({
  IncomingWebhook: jest.fn().mockImplementation(() => ({
    send: mockWebhookSend,
  })),
}));

const { SlackChannel } = await import('../../../src/alerts/channels/slack-channel.js');
import type { AlertNotification } from '../../../src/alerts/types.js';

describe('SlackChannel', () => {
  const mockWebhookUrl = 'https://hooks.slack.example.com/services/T00/B00/FAKE';

  beforeEach(() => {
    jest.clearAllMocks();
    mockWebhookSend.mockResolvedValue({ text: 'ok' });
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
    it('should create enabled channel with valid config', () => {
      const channel = new SlackChannel({
        webhookUrl: mockWebhookUrl,
        username: 'Test Bot',
        channel: '#alerts',
      });
      expect(channel.enabled).toBe(true);
      expect(channel.name).toBe('slack');
    });

    it('should create disabled channel without webhook URL', () => {
      const channel = new SlackChannel(undefined);
      expect(channel.enabled).toBe(false);
    });

    it('should create disabled channel with empty webhook URL', () => {
      const channel = new SlackChannel({ webhookUrl: '' });
      expect(channel.enabled).toBe(false);
    });
  });

  describe('send', () => {
    it('should return false when disabled', async () => {
      const channel = new SlackChannel(undefined);
      const result = await channel.send(makeNotification());
      expect(result).toBe(false);
    });

    it('should send notification successfully', async () => {
      const channel = new SlackChannel({
        webhookUrl: mockWebhookUrl,
        username: 'Bot',
        channel: '#alerts',
      });
      const result = await channel.send(makeNotification());

      expect(result).toBe(true);
      expect(mockWebhookSend).toHaveBeenCalledTimes(1);
    });

    it('should return false when send throws', async () => {
      mockWebhookSend.mockRejectedValueOnce(new Error('Webhook error'));

      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should include attachments with correct color', async () => {
      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      await channel.send(makeNotification({ level: 'critical' }));

      const call = mockWebhookSend.mock.calls[0] as {
        attachments: { color: string }[];
      }[];
      const payload = call[0];
      expect(payload.attachments[0].color).toBe('#ff0000');
    });

    it('should include fields from metadata', async () => {
      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      await channel.send(makeNotification({ metadata: { region: 'us-east', count: 5 } }));

      const call = mockWebhookSend.mock.calls[0] as {
        attachments: { fields: { title: string; value: string }[] }[];
      }[];
      const fields = call[0].attachments[0].fields;
      expect(fields).toHaveLength(2);
      expect(fields[0].title).toBe('region');
      expect(fields[0].value).toBe('us-east');
    });

    it('should include blocks with header and section', async () => {
      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      await channel.send(makeNotification({ level: 'info', title: 'Info Alert' }));

      const call = mockWebhookSend.mock.calls[0] as {
        blocks: { type: string; text: { type: string; text: string } }[];
      }[];
      const blocks = call[0].blocks;
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks[0].type).toBe('header');
      expect(blocks[0].text.text).toContain('Info Alert');
      expect(blocks[1].type).toBe('section');
    });

    it('should set channel when configured', async () => {
      const channel = new SlackChannel({
        webhookUrl: mockWebhookUrl,
        channel: '#ops',
      });
      await channel.send(makeNotification());

      const call = mockWebhookSend.mock.calls[0] as { channel: string }[];
      expect(call[0].channel).toBe('#ops');
    });
  });

  describe('test', () => {
    it('should return false when disabled', async () => {
      const channel = new SlackChannel(undefined);
      const result = await channel.test();
      expect(result).toBe(false);
    });

    it('should return true on successful test', async () => {
      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.test();

      expect(result).toBe(true);
      expect(mockWebhookSend).toHaveBeenCalledTimes(1);
    });

    it('should return false when test send throws', async () => {
      mockWebhookSend.mockRejectedValueOnce(new Error('fail'));

      const channel = new SlackChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.test();

      expect(result).toBe(false);
    });
  });
});
