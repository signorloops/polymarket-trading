import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DiscordChannel } from '../../../src/alerts/channels/discord-channel.js';
import type { AlertNotification } from '../../../src/alerts/types.js';

describe('DiscordChannel', () => {
  const mockWebhookUrl = 'https://discord.com/api/webhooks/1234/fake-token';
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    it('should be enabled with valid webhookUrl', () => {
      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      expect(channel.enabled).toBe(true);
      expect(channel.name).toBe('discord');
    });

    it('should be disabled without config', () => {
      const channel = new DiscordChannel(undefined);
      expect(channel.enabled).toBe(false);
    });

    it('should be disabled with empty webhookUrl', () => {
      const channel = new DiscordChannel({ webhookUrl: '' });
      expect(channel.enabled).toBe(false);
    });
  });

  describe('send', () => {
    it('should return false when disabled', async () => {
      const channel = new DiscordChannel(undefined);
      const result = await channel.send(makeNotification());
      expect(result).toBe(false);
    });

    it('should send successfully and return true', async () => {
      const mockFetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.send(makeNotification());

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        mockWebhookUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should return false on fetch failure', async () => {
      const mockFetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('Network error'));
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should return false on non-ok response', async () => {
      const mockFetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' })
        );
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should include correct embed structure in payload', async () => {
      let capturedBody = '';
      const mockFetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(null, { status: 204 });
      });
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl, username: 'Bot' });
      await channel.send(makeNotification({ level: 'critical', title: 'Down' }));

      const payload = JSON.parse(capturedBody) as {
        username: string;
        embeds: {
          title: string;
          color: number;
          timestamp: string;
          footer: { text: string };
        }[];
      };
      expect(payload.username).toBe('Bot');
      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].color).toBe(0xff0000); // critical = red
      expect(payload.embeds[0].title).toContain('Down');
      expect(payload.embeds[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(payload.embeds[0].footer.text).toBe('Source: test');
    });

    it('should map level emojis correctly', async () => {
      const bodies: string[] = [];
      const mockFetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        bodies.push((init?.body as string) ?? '');
        return new Response(null, { status: 204 });
      });
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });

      await channel.send(makeNotification({ level: 'info', title: 'Info' }));
      await channel.send(makeNotification({ level: 'warning', title: 'Warn' }));
      await channel.send(makeNotification({ level: 'critical', title: 'Crit' }));

      const parsed = bodies.map(
        (b) => (JSON.parse(b) as { embeds: { title: string; color: number }[] }).embeds[0]
      );

      expect(parsed[0].title).toMatch(/ℹ️/);
      expect(parsed[0].color).toBe(0x36a64f);
      expect(parsed[1].title).toMatch(/⚠️/);
      expect(parsed[1].color).toBe(0xff9900);
      expect(parsed[2].title).toMatch(/🚨/);
      expect(parsed[2].color).toBe(0xff0000);
    });

    it('should convert metadata to fields and truncate long values', async () => {
      let capturedBody = '';
      const mockFetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(null, { status: 204 });
      });
      globalThis.fetch = mockFetch;

      const longValue = 'x'.repeat(2000);
      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      await channel.send(
        makeNotification({
          metadata: { shortKey: 'val', longKey: longValue },
        })
      );

      const payload = JSON.parse(capturedBody) as {
        embeds: {
          fields: { name: string; value: string; inline: boolean }[];
        }[];
      };
      const fields = payload.embeds[0].fields;
      expect(fields).toHaveLength(2);
      expect(fields[0].name).toBe('shortKey');
      expect(fields[0].value).toBe('val');
      expect(fields[0].inline).toBe(true);
      expect(fields[1].value.length).toBeLessThanOrEqual(1024);
      expect(fields[1].inline).toBe(false);
    });

    it('redacts secret metadata when used without the alert service', async () => {
      let capturedBody = '';
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(null, { status: 204 });
      });

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      await channel.send(makeNotification({ metadata: { authToken: 'TOP-SECRET' } }));

      expect(capturedBody).not.toContain('TOP-SECRET');
      expect(capturedBody).toContain('[REDACTED]');
    });
  });

  describe('test', () => {
    it('should return false when disabled', async () => {
      const channel = new DiscordChannel(undefined);
      const result = await channel.test();
      expect(result).toBe(false);
    });

    it('should return true on successful test', async () => {
      const mockFetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.test();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return false on fetch error', async () => {
      const mockFetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('fail'));
      globalThis.fetch = mockFetch;

      const channel = new DiscordChannel({ webhookUrl: mockWebhookUrl });
      const result = await channel.test();

      expect(result).toBe(false);
    });
  });
});
