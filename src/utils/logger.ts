/**
 * Structured logging system with multiple log levels and context support
 */

import { createSingleton } from './singleton.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Keys whose values must never be logged (trading credentials, signing keys, etc.).
// Substring match, case-insensitive — over-redaction is safer than leakage.
const SECRET_KEY_RE =
  /(secret|password|passwd|passphrase|api[_-]?key|api[_-]?secret|private[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer|mnemonic)/i;

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export class Logger {
  private level: LogLevel;
  private silent: boolean;
  private context: Record<string, unknown>;
  private structured: boolean;

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
    structured = false
  ) {
    this.level = level;
    this.silent = silent;
    this.context = context;
    this.structured = structured;
  }

  /**
   * Create a child logger with additional context
   */
  child(additionalContext: Record<string, unknown>): Logger {
    return new Logger(
      this.level,
      this.silent,
      { ...this.context, ...additionalContext },
      this.structured
    );
  }

  /**
   * Set structured logging mode (JSON output)
   */
  setStructured(structured: boolean): void {
    this.structured = structured;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Set silent mode (no console output)
   */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.LEVEL_PRIORITY[level] >= Logger.LEVEL_PRIORITY[this.level];
  }

  /**
   * Recursively clone a log context, replacing values whose key looks like a
   * credential/signing secret with '[REDACTED]'. Guards against leaking keys
   * nested inside logged objects (e.g. an axios error carrying an Authorization
   * header, or a config snapshot with PRIVATE_KEY). Never throws.
   */
  private redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((v) => this.redactSecrets(v, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : this.redactSecrets(v, seen);
    }
    return out;
  }

  private formatLogEntry(entry: LogEntry, structured: boolean): string {
    if (structured) {
      // JSON structured logging for production
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        ...entry.context,
      });
    }

    // Human-readable format for development
    const contextStr = entry.context ? ' ' + JSON.stringify(entry.context) : '';
    return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, additionalContext?: Record<string, unknown>): void {
    if (!this.shouldLog(level) || this.silent) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: this.redactSecrets({ ...this.context, ...additionalContext }) as Record<
        string,
        unknown
      >,
    };

    const formatted = this.formatLogEntry(entry, this.structured);

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

// Global logger instance
let _pendingLoggerArgs: { level: LogLevel; silent: boolean; structured: boolean } | null = null;

const loggerSingleton = createSingleton(() => {
  if (_pendingLoggerArgs) {
    const { level, silent, structured } = _pendingLoggerArgs;
    _pendingLoggerArgs = null;
    return new Logger(level, silent, {}, structured);
  }
  return new Logger();
});

/**
 * Initialize the global logger
 */
export function initLogger(level: LogLevel = 'info', silent = false, structured = false): Logger {
  loggerSingleton.reset();
  _pendingLoggerArgs = { level, silent, structured };
  return loggerSingleton.get();
}

/**
 * Get the global logger instance
 */
export const getLogger = loggerSingleton.get;

/**
 * Create a silent logger for testing
 */
export function createSilentLogger(): Logger {
  return new Logger('debug', true);
}
