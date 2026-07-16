import { jest } from '@jest/globals';

import { createGracefulShutdown } from '../../src/runtime/graceful-shutdown.js';

describe('createGracefulShutdown', () => {
  function createLogger() {
    return {
      info: jest.fn(),
      error: jest.fn(),
    };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for resources to stop before exiting successfully', async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {
        calls.push('stop');
      },
      exit: (code) => {
        calls.push(`exit:${String(code)}`);
      },
      logger: createLogger(),
    });

    await shutdown('SIGTERM');

    expect(calls).toEqual(['stop', 'exit:0']);
  });

  it('exits with failure when resource cleanup rejects', async () => {
    const exit = jest.fn();
    const logger = createLogger();
    const shutdown = createGracefulShutdown({
      stop: async () => {
        throw new Error('close failed');
      },
      exit,
      logger,
    });

    await shutdown('uncaughtException', 1, new Error('fatal'));

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown failed',
      expect.objectContaining({ error: 'close failed' })
    );
  });

  it('forces exit when cleanup exceeds the deadline', async () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    const shutdown = createGracefulShutdown({
      stop: () => new Promise<void>(() => {}),
      exit,
      logger: createLogger(),
      forceTimeoutMs: 100,
    });

    void shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(100);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit immediately on a second termination event', async () => {
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const exit = jest.fn();
    const shutdown = createGracefulShutdown({
      stop: () => stopPromise,
      exit,
      logger: createLogger(),
    });

    const firstShutdown = shutdown('SIGTERM');
    void shutdown('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    resolveStop();
    await firstShutdown;
  });
});
