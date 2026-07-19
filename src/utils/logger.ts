/**
 * Structured logging system with multiple log levels and context support.
 *
 * Child loggers share a mutable settings object with the root logger so that
 * initLogger() updates (level / silent / structured) apply to module-level
 * children created before initialization (INFRA-3).
 */

import { createSingleton } from './singleton.js';
import { redactSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

interface LogSettings {
  level: LogLevel;
  silent: boolean;
  structured: boolean;
}

export class Logger {
  private context: Record<string, unknown>;
  private readonly settings: LogSettings;

  private static readonly LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(
    level: LogLevel = 'info',
    silent = false,
    context: Record<string, unknown> = {},
    structured = false,
    settings?: LogSettings
  ) {
    this.settings = settings ?? { level, silent, structured };
    // Keep constructor args as the initial settings when creating a fresh root.
    if (!settings) {
      this.settings.level = level;
      this.settings.silent = silent;
      this.settings.structured = structured;
    }
    this.context = context;
  }

  /**
   * Create a child logger with additional context.
   * Shares settings with the parent so initLogger updates propagate.
   */
  child(additionalContext: Record<string, unknown>): Logger {
    return new Logger(
      this.settings.level,
      this.settings.silent,
      { ...this.context, ...additionalContext },
      this.settings.structured,
      this.settings
    );
  }

  /**
   * Set structured logging mode (JSON output)
   */
  setStructured(structured: boolean): void {
    this.settings.structured = structured;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.settings.level = level;
  }

  /**
   * Set silent mode (no console output)
   */
  setSilent(silent: boolean): void {
    this.settings.silent = silent;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.LEVEL_PRIORITY[level] >= Logger.LEVEL_PRIORITY[this.settings.level];
  }

  private formatLogEntry(entry: LogEntry, structured: boolean): string {
    if (structured) {
      // JSON structured logging for production
      return this.stringify({
        ...entry.context,
        // Reserved envelope fields must not be replaceable by caller context.
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
      });
    }

    // Human-readable format for development
    const contextStr = entry.context ? ' ' + this.stringify(entry.context) : '';
    return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${contextStr}`;
  }

  private stringify(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item
    );
  }

  private log(level: LogLevel, message: string, additionalContext?: Record<string, unknown>): void {
    if (!this.shouldLog(level) || this.settings.silent) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: redactSecrets({ ...this.context, ...additionalContext }) as Record<string, unknown>,
    };

    const formatted = this.formatLogEntry(entry, this.settings.structured);

    switch (level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }
}

// Global logger instance — settings object is retained across reset so that
// children created before initLogger still observe configuration updates.
const _sharedSettings: LogSettings = {
  level: 'info',
  silent: false,
  structured: false,
};
let _pendingLoggerArgs: { level: LogLevel; silent: boolean; structured: boolean } | null = null;

const loggerSingleton = createSingleton(() => {
  if (_pendingLoggerArgs) {
    const { level, silent, structured } = _pendingLoggerArgs;
    _pendingLoggerArgs = null;
    _sharedSettings.level = level;
    _sharedSettings.silent = silent;
    _sharedSettings.structured = structured;
    return new Logger(level, silent, {}, structured, _sharedSettings);
  }
  return new Logger('info', false, {}, false, _sharedSettings);
});

/**
 * Initialize the global logger.
 * Updates the shared settings object in place so pre-existing child loggers
 * pick up level/silent/structured without being recreated (INFRA-2/3).
 */
export function initLogger(level: LogLevel = 'info', silent = false, structured = false): Logger {
  _sharedSettings.level = level;
  _sharedSettings.silent = silent;
  _sharedSettings.structured = structured;
  _pendingLoggerArgs = { level, silent, structured };
  loggerSingleton.reset();
  return loggerSingleton.get();
}

/**
 * Get the global logger instance
 */
export const getLogger = loggerSingleton.get;

/**
 * Create a silent logger for testing (independent settings — does not share
 * the global settings object).
 */
export function createSilentLogger(): Logger {
  return new Logger('debug', true);
}
