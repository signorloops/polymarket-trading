import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  AlertNotificationService,
  initNotificationService,
  getNotificationService,
  sendAlert,
} from '../../src/alerts/alert-notification-service.js';
import type { AlertConfig, AlertNotification } from '../../src/alerts/types.js';

// Mock fetch for tests
global.fetch = jest.fn() as unknown as typeof fetch;

describe('AlertNotificationService', () => {
  let service: AlertNotificationService;
  let config: AlertConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    config = {
      enabled: true,
      minLevel: 'info',
      dedupWindowMinutes: 5,
      channels: {},
      routing: {
        info: [],
        warning: [],
        critical: [],
      },
    };

    service = new AlertNotificationService(config);
  });

  describe('constructor', () => {
    it('should create service with config', () => {
      expect(service).toBeDefined();
      expect(service.getEnabledChannels()).toEqual([]);
    });

    it('should create disabled service when enabled is false', async () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledService = new AlertNotificationService(disabledConfig);

      const notification: AlertNotification = {
        level: 'critical',
        title: 'Test',
        message: 'Test message',
        timestamp: new Date(),
      };

      const result = await disabledService.send(notification);
      expect(result.sentTo).toEqual([]);
    });
  });

  describe('send', () => {
    it('should skip alerts below minLevel', async () => {
      const warningConfig: AlertConfig = {
        ...config,
        minLevel: 'warning',
        routing: { info: [], warning: [], critical: [] },
      };
      const warningService = new AlertNotificationService(warningConfig);

      const notification: AlertNotification = {
        level: 'info',
        title: 'Test',
        message: 'Test message',
        timestamp: new Date(),
      };

      const result = await warningService.send(notification);
      expect(result.sentTo).toEqual([]);
    });

    it('should deduplicate alerts within window', async () => {
      const notification: AlertNotification = {
        id: 'test-alert-1',
        level: 'critical',
        title: 'Test',
        message: 'Test message',
        timestamp: new Date(),
      };

      // First send
      await service.send(notification);
      // Second send (should be deduplicated)
      const result = await service.send(notification);

      expect(result.sentTo).toEqual([]);
    });

    it('should track alert history', async () => {
      const notification: AlertNotification = {
        level: 'info',
        title: 'Test',
        message: 'Test message',
        timestamp: new Date(),
      };

      await service.send(notification);

      const history = service.getHistory(10);
      expect(history).toHaveLength(1);
      expect(history[0]?.title).toBe('Test');
    });
  });

  describe('alert', () => {
    it('should send alert with simple parameters', async () => {
      const result = await service.alert('warning', 'Test Title', 'Test message', { key: 'value' });

      expect(result).toBeDefined();
      expect(result?.level).toBe('warning');
      expect(result?.title).toBe('Test Title');
    });
  });

  describe('clearHistory', () => {
    it('should clear all history', async () => {
      await service.alert('info', 'Test', 'Message');
      expect(service.getHistory()).toHaveLength(1);

      service.clearHistory();
      expect(service.getHistory()).toHaveLength(0);
    });
  });

  describe('fromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should create service from environment variables', () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      process.env.ALERTS_ENABLED = 'true';
      process.env.ALERTS_MIN_LEVEL = 'warning';

      const envService = AlertNotificationService.fromEnv();
      expect(envService.getEnabledChannels()).toContain('slack');
    });

    it('should handle missing environment variables', () => {
      delete process.env.SLACK_WEBHOOK_URL;
      delete process.env.DISCORD_WEBHOOK_URL;

      const envService = AlertNotificationService.fromEnv();
      expect(envService.getEnabledChannels()).toEqual([]);
    });
  });
});

describe('global notification service', () => {
  beforeEach(() => {
    // Reset global state
    jest.resetModules();
  });

  it('should initialize and retrieve global service', () => {
    const config: AlertConfig = {
      enabled: true,
      minLevel: 'info',
      dedupWindowMinutes: 5,
      channels: {},
      routing: { info: [], warning: [], critical: [] },
    };

    const service = new AlertNotificationService(config);
    initNotificationService(service);

    expect(getNotificationService()).toBe(service);
  });

  it('should send alert through global service', async () => {
    const config: AlertConfig = {
      enabled: true,
      minLevel: 'info',
      dedupWindowMinutes: 5,
      channels: {},
      routing: { info: [], warning: [], critical: [] },
    };

    const service = new AlertNotificationService(config);
    initNotificationService(service);

    const result = await sendAlert('info', 'Test', 'Message');
    expect(result).toBeDefined();
  });

  it('should return null when no global service', async () => {
    // Reset by reinitializing with new module
    const result = await sendAlert('info', 'Test', 'Message');
    // Should log warning but not throw
    expect(result).toBeNull();
  });
});

// Restore fetch after tests
delete (global as Record<string, unknown>).fetch;
