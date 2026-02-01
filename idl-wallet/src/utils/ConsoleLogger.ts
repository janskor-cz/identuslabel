/**
 * ConsoleLogger - Captures browser console output and sends to server
 *
 * This utility intercepts all console methods (log, error, warn, info) and
 * batches the logs for sending to a server endpoint. Logs are persisted
 * in sessionStorage to survive page reloads.
 *
 * Usage:
 *   import { initConsoleLogger, cleanupConsoleLogger } from '@/utils/ConsoleLogger';
 *   initConsoleLogger('idl');
 *   // ... later
 *   cleanupConsoleLogger();
 */

interface LogEntry {
  timestamp: number;
  walletId: string;
  level: 'log' | 'error' | 'warn' | 'info';
  messages: any[];
  stack?: string;
  url: string;
  userAgent: string;
}

class ConsoleLogger {
  private walletId: string = '';
  private logBuffer: LogEntry[] = [];
  private maxBufferSize: number = 1000;
  private batchSize: number = 100;
  private flushInterval: number = 5000; // 5 seconds
  private flushTimer: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private sessionKey: string = 'console-logger-buffer';
  private logFilePathDisplayed: boolean = false;

  // Store original console methods
  private originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info
  };

  /**
   * Initialize the console logger
   */
  public init(walletId: string): void {
    if (this.isInitialized) {
      console.warn('[ConsoleLogger] Already initialized');
      return;
    }

    this.walletId = walletId;
    this.isInitialized = true;

    // Load any unsent logs from sessionStorage
    this.loadBufferFromStorage();

    // Intercept console methods
    this.interceptConsole();

    // Start periodic flush timer
    this.startFlushTimer();

    // Send any buffered logs on beforeunload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    this.originalConsole.log(`✅ [ConsoleLogger] Initialized for wallet: ${walletId}`);
  }

  /**
   * Cleanup and restore original console methods
   */
  public cleanup(): void {
    if (!this.isInitialized) return;

    // Flush any remaining logs
    this.flush();

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Remove event listener
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }

    // Restore original console methods
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;

    this.isInitialized = false;
    this.originalConsole.log('🛑 [ConsoleLogger] Cleaned up');
  }

  /**
   * Intercept console methods
   */
  private interceptConsole(): void {
    const self = this;

    // Intercept console.log
    console.log = function(...args: any[]) {
      self.originalConsole.log.apply(console, args);
      self.captureLog('log', args);
    };

    // Intercept console.error
    console.error = function(...args: any[]) {
      self.originalConsole.error.apply(console, args);
      self.captureLog('error', args);
    };

    // Intercept console.warn
    console.warn = function(...args: any[]) {
      self.originalConsole.warn.apply(console, args);
      self.captureLog('warn', args);
    };

    // Intercept console.info
    console.info = function(...args: any[]) {
      self.originalConsole.info.apply(console, args);
      self.captureLog('info', args);
    };
  }

  /**
   * Capture a log entry
   */
  private captureLog(level: 'log' | 'error' | 'warn' | 'info', args: any[]): void {
    if (!this.isInitialized) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      walletId: this.walletId,
      level,
      messages: args.map(arg => this.serializeArg(arg)),
      url: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    };

    // Capture stack trace for errors
    if (level === 'error') {
      try {
        const error = new Error();
        entry.stack = error.stack || '';
      } catch (e) {
        // Ignore stack trace errors
      }
    }

    // Add to buffer
    this.logBuffer.push(entry);

    // Trim buffer if too large (ring buffer behavior)
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
    }

    // Save to sessionStorage
    this.saveBufferToStorage();

    // Flush if batch size reached
    if (this.logBuffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Serialize an argument for JSON transmission
   */
  private serializeArg(arg: any): any {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';

    const type = typeof arg;

    if (type === 'string' || type === 'number' || type === 'boolean') {
      return arg;
    }

    if (type === 'function') {
      return `[Function: ${arg.name || 'anonymous'}]`;
    }

    if (type === 'symbol') {
      return arg.toString();
    }

    // Objects and arrays
    try {
      // Try to JSON stringify
      return JSON.parse(JSON.stringify(arg));
    } catch (e) {
      // Circular reference or other issue
      try {
        return arg.toString();
      } catch (e2) {
        return '[Object: unable to serialize]';
      }
    }
  }

  /**
   * Flush logs to server
   */
  private flush = async (): Promise<void> => {
    if (this.logBuffer.length === 0) return;

    // Take current buffer and clear it
    const logsToSend = [...this.logBuffer];
    this.logBuffer = [];
    this.saveBufferToStorage(); // Clear storage

    try {
      const response = await fetch('/wallet/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ logs: logsToSend })
      });

      if (!response.ok) {
        // Put logs back in buffer if send failed
        this.logBuffer = [...logsToSend, ...this.logBuffer];
        this.saveBufferToStorage();
        this.originalConsole.error(`[ConsoleLogger] Failed to send logs: ${response.status}`);
      } else {
        // Display log file path once on first successful flush
        const data = await response.json();
        if (data.logFilePath && !this.logFilePathDisplayed) {
          this.originalConsole.log(`📁 [ConsoleLogger] Logging to: ${data.logFilePath}`);
          this.logFilePathDisplayed = true;
        }
      }
    } catch (error) {
      // Put logs back in buffer if send failed
      this.logBuffer = [...logsToSend, ...this.logBuffer];
      this.saveBufferToStorage();
      this.originalConsole.error('[ConsoleLogger] Error sending logs:', error);
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  /**
   * Handle beforeunload event
   */
  private handleBeforeUnload = (): void => {
    // Try to flush logs synchronously (not guaranteed to complete)
    this.saveBufferToStorage(); // At least save to sessionStorage
  }

  /**
   * Load buffer from sessionStorage
   */
  private loadBufferFromStorage(): void {
    if (typeof sessionStorage === 'undefined') return;

    try {
      const stored = sessionStorage.getItem(this.sessionKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this.logBuffer = parsed;
          this.originalConsole.log(`[ConsoleLogger] Loaded ${this.logBuffer.length} unsent logs from sessionStorage`);

          // Send them immediately
          this.flush();
        }
      }
    } catch (error) {
      this.originalConsole.error('[ConsoleLogger] Error loading buffer from storage:', error);
    }
  }

  /**
   * Save buffer to sessionStorage
   */
  private saveBufferToStorage(): void {
    if (typeof sessionStorage === 'undefined') return;

    try {
      sessionStorage.setItem(this.sessionKey, JSON.stringify(this.logBuffer));
    } catch (error) {
      // Ignore storage errors (e.g., quota exceeded)
    }
  }
}

// Singleton instance
const logger = new ConsoleLogger();

/**
 * Initialize the console logger
 */
export function initConsoleLogger(walletId: string): void {
  logger.init(walletId);
}

/**
 * Cleanup the console logger
 */
export function cleanupConsoleLogger(): void {
  logger.cleanup();
}
