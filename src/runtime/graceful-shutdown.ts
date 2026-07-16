import { getErrorMessage } from '../utils/errors.js';

export interface ShutdownLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface GracefulShutdownOptions {
  stop(): Promise<void>;
  exit(code: number): void;
  logger: ShutdownLogger;
  forceTimeoutMs?: number;
}

export type GracefulShutdown = (
  trigger: string,
  exitCode?: number,
  cause?: unknown
) => Promise<void>;

const DEFAULT_FORCE_TIMEOUT_MS = 10_000;

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  let shutdownPromise: Promise<void> | undefined;

  return (trigger: string, exitCode = 0, cause?: unknown): Promise<void> => {
    if (shutdownPromise) {
      options.logger.error('Received another termination event during shutdown; forcing exit', {
        trigger,
      });
      options.exit(1);
      return shutdownPromise;
    }

    options.logger.info('Starting graceful shutdown', {
      trigger,
      ...(cause === undefined ? {} : { error: getErrorMessage(cause) }),
    });

    const forceTimer = setTimeout(() => {
      options.logger.error('Graceful shutdown timed out; forcing exit', {
        trigger,
        timeoutMs: options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS,
      });
      options.exit(1);
    }, options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS);
    forceTimer.unref();

    shutdownPromise = (async () => {
      try {
        await options.stop();
        clearTimeout(forceTimer);
        options.exit(exitCode);
      } catch (error) {
        clearTimeout(forceTimer);
        options.logger.error('Graceful shutdown failed', {
          trigger,
          error: getErrorMessage(error),
        });
        options.exit(1);
      }
    })();

    return shutdownPromise;
  };
}
