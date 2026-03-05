import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PagerDutyChannel } from '../../../src/alerts/channels/pagerduty-channel.js';
import type { AlertNotification } from '../../../src/alerts/types.js';

describe('PagerDutyChannel', () => {
  const mockKey = 'fake-integration-key-1234';
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
      level: 'critical',
      title: 'Server Down',
      message: 'Primary server is unreachable',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      source: 'monitor',
      id: 'alert-123',
      ...overrides,
    };
  }

  function mockFetchSuccess(): jest.Mock<typeof fetch> {
    const mock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', dedup_key: 'abc' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = mock;
    return mock;
  }

  describe('constructor', () => {
    it('should be enabled with integrationKey', () => {
      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      expect(channel.enabled).toBe(true);
      expect(channel.name).toBe('pagerduty');
    });

    it('should be disabled without config', () => {
      const channel = new PagerDutyChannel(undefined);
      expect(channel.enabled).toBe(false);
    });

    it('should be disabled with empty integrationKey', () => {
      const channel = new PagerDutyChannel({ integrationKey: '' });
      expect(channel.enabled).toBe(false);
    });
  });

  describe('send', () => {
    it('should return false when disabled', async () => {
      const channel = new PagerDutyChannel(undefined);
      const result = await channel.send(makeNotification());
      expect(result).toBe(false);
    });

    it('should skip info level and return false', async () => {
      const mockFetch = mockFetchSuccess();
      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification({ level: 'info' }));

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send warning and return true on success', async () => {
      const mockFetch = mockFetchSuccess();
      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification({ level: 'warning' }));

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://events.pagerduty.com/v2/enqueue',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should send critical and return true on success', async () => {
      mockFetchSuccess();
      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification({ level: 'critical' }));

      expect(result).toBe(true);
    });

    it('should return false on fetch error', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('Network error'));

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should return false on non-ok response', async () => {
      globalThis.fetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Bad Request', { status: 400 }));

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should return false when response status is not success', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ status: 'invalid_event' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.send(makeNotification());

      expect(result).toBe(false);
    });

    it('should include correct payload structure', async () => {
      let capturedBody = '';
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      await channel.send(
        makeNotification({
          metadata: { host: 'web-01' },
        })
      );

      const payload = JSON.parse(capturedBody) as {
        routing_key: string;
        event_action: string;
        dedup_key: string;
        payload: {
          summary: string;
          severity: string;
          source: string;
          timestamp: string;
          custom_details: Record<string, unknown>;
        };
      };

      expect(payload.routing_key).toBe(mockKey);
      expect(payload.event_action).toBe('trigger');
      expect(payload.dedup_key).toBe('alert-123');
      expect(payload.payload.summary).toBe('Server Down');
      expect(payload.payload.severity).toBe('critical');
      expect(payload.payload.source).toBe('monitor');
      expect(payload.payload.custom_details.message).toBe('Primary server is unreachable');
      expect(payload.payload.custom_details.host).toBe('web-01');
    });

    it('should use custom severityMap when provided', async () => {
      let capturedBody = '';
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const channel = new PagerDutyChannel({
        integrationKey: mockKey,
        severityMap: { info: 'info', warning: 'error', critical: 'critical' },
      });
      await channel.send(makeNotification({ level: 'warning' }));

      const payload = JSON.parse(capturedBody) as {
        payload: { severity: string };
      };
      expect(payload.payload.severity).toBe('error');
    });

    it('should use title-level as dedup_key when id is missing', async () => {
      let capturedBody = '';
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      await channel.send(makeNotification({ id: undefined, title: 'CPU High', level: 'critical' }));

      const payload = JSON.parse(capturedBody) as { dedup_key: string };
      expect(payload.dedup_key).toBe('CPU High-critical');
    });
  });

  describe('test', () => {
    it('should return false when disabled', async () => {
      const channel = new PagerDutyChannel(undefined);
      const result = await channel.test();
      expect(result).toBe(false);
    });

    it('should return true on successful test', async () => {
      globalThis.fetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ status: 'success' }), { status: 202 }));

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.test();

      expect(result).toBe(true);
    });

    it('should return false on test error', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('fail'));

      const channel = new PagerDutyChannel({ integrationKey: mockKey });
      const result = await channel.test();

      expect(result).toBe(false);
    });
  });
});
