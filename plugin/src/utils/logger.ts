import * as vscode from 'vscode';
import { LogLevel } from '../types';
import { LOG_CHANNEL_NAME, CONFIG_SECTION, CONFIG_KEYS, DEFAULT_LOG_LEVEL } from '../constants';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.Debug]: 0,
  [LogLevel.Info]: 1,
  [LogLevel.Warn]: 2,
  [LogLevel.Error]: 3,
};

export class SudxLogger {
  private static instance: SudxLogger | null = null;
  private static isCreating = false; // Guard against re-entrant getInstance() calls
  private outputChannel: vscode.OutputChannel;
  private level: LogLevel;
  private timers: Map<string, number> = new Map();

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
    this.level = this.readLogLevel();
  }

  /**
   * Thread-safe singleton accessor with re-entrancy guard.
   * Prevents multiple instances if getInstance() is called during construction.
   */
  static getInstance(): SudxLogger {
    if (SudxLogger.instance) {
      return SudxLogger.instance;
    }

    // Guard against re-entrant calls during construction
    if (SudxLogger.isCreating) {
      throw new Error('[SudxLogger] Recursive getInstance() call detected during initialization');
    }

    SudxLogger.isCreating = true;
    try {
      SudxLogger.instance = new SudxLogger();
      return SudxLogger.instance;
    } finally {
      SudxLogger.isCreating = false;
    }
  }

  getDisposable(): vscode.Disposable {
    return this.outputChannel;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
    this.info('Logger', `Log level set to ${level}`);
  }

  show(): void {
    this.outputChannel.show(true);
  }

  debug(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Debug, module, message, data);
  }

  info(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Info, module, message, data);
  }

  warn(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Warn, module, message, data);
  }

  error(module: string, message: string, err?: unknown, data?: unknown): void {
    let errorDetail = '';
    if (err instanceof Error) {
      errorDetail = ` | Error: ${err.message}`;
      if (err.stack) {
        errorDetail += `\n  Stack: ${err.stack}`;
      }
    } else if (err !== undefined) {
      errorDetail = ` | Error: ${String(err)}`;
    }

    const dataStr = data !== undefined ? ` | ${this.safeStringify(data)}` : '';
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [ERROR] [${module}] ${message}${errorDetail}${dataStr}`;

    this.outputChannel.appendLine(entry);
  }

  startTimer(label: string): void {
    this.timers.set(label, Date.now());
    this.debug('Timer', `Started: ${label}`);
  }

  endTimer(label: string): number {
    const start = this.timers.get(label);
    if (start === undefined) {
      this.warn('Timer', `No timer found for label: ${label}`);
      return 0;
    }
    const elapsed = Date.now() - start;
    this.timers.delete(label);
    this.debug('Timer', `${label}: ${elapsed}ms`);
    return elapsed;
  }

  dispose(): void {
    this.outputChannel.dispose();
    this.timers.clear();
    SudxLogger.instance = null;
  }

  private log(level: LogLevel, module: string, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5);
    const dataStr = data !== undefined ? ` | ${this.safeStringify(data)}` : '';
    const entry = `[${timestamp}] [${levelTag}] [${module}] ${message}${dataStr}`;

    this.outputChannel.appendLine(entry);
  }

  private safeStringify(data: unknown): string {
    try {
      // Use a Set to track seen objects and handle circular references
      const seen = new WeakSet<object>();
      return JSON.stringify(data, (_key, value) => {
        // Handle non-objects directly
        if (typeof value !== 'object' || value === null) {
          return value;
        }
        // Detect circular reference
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
        // Handle Error objects specially (not JSON-serializable by default)
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }
        return value;
      }, 0);
    } catch (err) {
      // Ultimate fallback — should not happen with circular detection
      return `[Stringify Error: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  private readLogLevel(): LogLevel {
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const value = config.get<string>(CONFIG_KEYS.LOG_LEVEL);
      if (value && Object.values(LogLevel).includes(value as LogLevel)) {
        return value as LogLevel;
      }
    } catch {
      // Ignore — use default
    }
    return DEFAULT_LOG_LEVEL;
  }
}
