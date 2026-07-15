/**
 * Tests for the structured logger, focused on secret redaction.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Logger } from '../../src/utils/logger.js';

describe('Logger', () => {
  let originalConsole: {
    debug: typeof console.debug;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  };

  beforeEach(() => {
    originalConsole = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
  });

  afterEach(() => {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  it('redacts top-level credential keys', () => {
    const spy = jest.fn();
    console.info = spy;
    const logger = new Logger('info', false, {}, true);

    logger.info('ctx', {
      apiKey: 'AK123',
      api_key: 'AK456',
      privateKey: '0xdeadbeef',
      passphrase: 's3cret',
      authorization: 'Bearer abc',
      password: 'hunter2',
      market_id: 'm-1', // not secret
    });

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"apiKey":"[REDACTED]"');
    expect(line).toContain('"api_key":"[REDACTED]"');
    expect(line).toContain('"privateKey":"[REDACTED]"');
    expect(line).toContain('"passphrase":"[REDACTED]"');
    expect(line).toContain('"authorization":"[REDACTED]"');
    expect(line).toContain('"password":"[REDACTED]"');
    // Non-secret values are preserved.
    expect(line).toContain('"market_id":"m-1"');
    expect(line).not.toContain('AK123');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Bearer abc');
  });

  it('redacts secrets nested inside logged objects (e.g. axios error config)', () => {
    const spy = jest.fn();
    console.error = spy;
    const logger = new Logger('error', false, {}, true);

    logger.error('upstream failed', {
      error: {
        message: '401',
        config: {
          headers: { authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
        },
      },
    });

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('secret-token');
    expect(line).toContain('"authorization":"[REDACTED]"');
    // Non-secret nested header preserved.
    expect(line).toContain('application/json');
  });

  it('does not redact non-secret keys that merely contain "token" (e.g. tokenID)', () => {
    const spy = jest.fn();
    console.info = spy;
    const logger = new Logger('info', false, {}, true);

    logger.info('trade', { tokenID: '7300', asset_id: 'a-9', event_id: 'e-1' });

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"tokenID":"7300"');
    expect(line).toContain('"asset_id":"a-9"');
  });

  it('handles circular references without throwing', () => {
    const spy = jest.fn();
    console.info = spy;
    const logger = new Logger('info', false, {}, true);

    const ctx: Record<string, unknown> = { apiKey: 'x' };
    ctx.self = ctx;

    expect(() => logger.info('circular', ctx)).not.toThrow();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('"apiKey":"[REDACTED]"');
    expect(line).toContain('[Circular]');
  });

  it('respects log level (skips lower levels)', () => {
    const infoSpy = jest.fn();
    const debugSpy = jest.fn();
    console.info = infoSpy;
    console.debug = debugSpy;
    const logger = new Logger('info');

    logger.debug('hidden', { apiKey: 'x' });
    logger.info('shown', { apiKey: 'x' });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});
