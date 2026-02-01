/**
 * Route Memory Cleanup - Automatic memory management on route changes
 *
 * This utility integrates with Next.js router to automatically
 * clean up WebAssembly memory when users navigate between pages,
 * preventing memory accumulation during app usage.
 */

import { Router } from 'next/router';
import { memoryMonitor } from './MemoryMonitor';

interface RouteCleanupConfig {
  enableAutoCleanup: boolean;
  cleanupDelay: number;
  memoryThreshold: number;
  cleanupOnRouteChange: boolean;
  cleanupOnBeforeUnload: boolean;
  aggressiveMode: boolean;
}

class RouteMemoryCleanup {
  private isInitialized = false;
  private router: Router | null = null;
  private cleanupTimer?: NodeJS.Timeout;
  private routeHistory: string[] = [];

  private config: RouteCleanupConfig = {
    enableAutoCleanup: true,
    cleanupDelay: 2000, // 2 seconds after route change
    memoryThreshold: 70, // Cleanup if memory usage > 70%
    cleanupOnRouteChange: true,
    cleanupOnBeforeUnload: true,
    aggressiveMode: false, // More frequent cleanup
  };

  private readonly MAX_ROUTE_HISTORY = 10;

  constructor(customConfig?: Partial<RouteCleanupConfig>) {
    if (customConfig) {
      this.config = { ...this.config, ...customConfig };
    }
  }

  /**
   * Initialize route memory cleanup
   */
  async initialize(router: Router): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.router = router;
    this.isInitialized = true;

    // Start memory monitoring
    memoryMonitor.startMonitoring();

    // Set up route change handlers
    this.setupRouteHandlers();

    // Set up browser event handlers
    this.setupBrowserEventHandlers();

    // Set up memory threshold monitoring
    this.setupMemoryThresholdMonitoring();
  }

  /**
   * Configure cleanup behavior
   */
  configure(newConfig: Partial<RouteCleanupConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Manually trigger memory cleanup
   */
  async triggerCleanup(reason: string = 'manual'): Promise<void> {
    try {
      // Get memory stats before cleanup
      const beforeStats = memoryMonitor.getCurrentStats();

      // Force garbage collection
      memoryMonitor.forceCleanup();

      // Get memory stats after cleanup
      const afterStats = memoryMonitor.getCurrentStats();
    } catch (error) {
      console.error('❌ [RouteCleanup] Cleanup failed:', error);
    }
  }

  /**
   * Set up Next.js router event handlers
   */
  private setupRouteHandlers(): void {
    if (!this.router || !this.config.cleanupOnRouteChange) {
      return;
    }

    // Before route change
    this.router.events.on('routeChangeStart', (url: string) => {
      this.addToRouteHistory(url);
    });

    // After route change complete
    this.router.events.on('routeChangeComplete', (url: string) => {
      this.scheduleCleanup('route-change');
    });

    // On route change error
    this.router.events.on('routeChangeError', (err: any, url: string) => {
      this.scheduleCleanup('route-error');
    });

    // Before route change (for cleanup)
    this.router.events.on('beforeHistoryChange', (url: string) => {
      if (this.config.aggressiveMode) {
        // Immediate cleanup in aggressive mode
        this.triggerCleanup('before-history-change');
      }
    });
  }

  /**
   * Set up browser event handlers
   */
  private setupBrowserEventHandlers(): void {
    if (typeof window === 'undefined') {
      return;
    }

    // Cleanup before page unload
    if (this.config.cleanupOnBeforeUnload) {
      window.addEventListener('beforeunload', () => {
        this.triggerCleanup('page-unload');
      });
    }

    // Cleanup on page visibility change
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.scheduleCleanup('visibility-hidden');
      } else {
        this.cancelScheduledCleanup();
      }
    });

    // Cleanup on window blur (less aggressive)
    window.addEventListener('blur', () => {
      if (this.config.aggressiveMode) {
        this.scheduleCleanup('window-blur');
      }
    });

    // Memory pressure event (if available)
    if ('memory' in navigator) {
      // Some browsers support memory pressure events
      try {
        (navigator as any).memory?.addEventListener?.('memoryPressure', () => {
          this.triggerCleanup('memory-pressure');
        });
      } catch (error) {
        // Memory pressure events not supported
      }
    }
  }

  /**
   * Set up memory threshold monitoring
   */
  private setupMemoryThresholdMonitoring(): void {
    // Monitor memory usage and trigger cleanup when threshold is exceeded
    const unsubscribe = memoryMonitor.onAlert((alert) => {
      if (alert.level === 'warning' && alert.stats.percentage >= this.config.memoryThreshold) {
        this.triggerCleanup('memory-threshold');
      }

      if (alert.level === 'critical') {
        this.triggerCleanup('critical-memory');
      }
    });

    // Store unsubscribe function for cleanup
    (this as any).memoryMonitorUnsubscribe = unsubscribe;
  }

  /**
   * Schedule cleanup with delay
   */
  private scheduleCleanup(reason: string): void {
    if (!this.config.enableAutoCleanup) {
      return;
    }

    // Cancel any existing scheduled cleanup
    this.cancelScheduledCleanup();

    this.cleanupTimer = setTimeout(() => {
      this.triggerCleanup(reason);
    }, this.config.cleanupDelay);
  }

  /**
   * Cancel scheduled cleanup
   */
  private cancelScheduledCleanup(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Add route to history for tracking
   */
  private addToRouteHistory(url: string): void {
    this.routeHistory.push(url);
    if (this.routeHistory.length > this.MAX_ROUTE_HISTORY) {
      this.routeHistory.shift();
    }
  }

  /**
   * Get route navigation statistics
   */
  getRouteStats(): {
    currentRoute: string | null;
    routeHistory: string[];
    navigationCount: number;
  } {
    return {
      currentRoute: this.router?.asPath || null,
      routeHistory: [...this.routeHistory],
      navigationCount: this.routeHistory.length,
    };
  }

  /**
   * Destroy route memory cleanup
   */
  destroy(): void {
    this.isInitialized = false;
    this.cancelScheduledCleanup();

    // Remove router event listeners
    if (this.router) {
      this.router.events.off('routeChangeStart', () => {});
      this.router.events.off('routeChangeComplete', () => {});
      this.router.events.off('routeChangeError', () => {});
      this.router.events.off('beforeHistoryChange', () => {});
    }

    // Unsubscribe from memory monitor
    if ((this as any).memoryMonitorUnsubscribe) {
      (this as any).memoryMonitorUnsubscribe();
    }

    // Final cleanup
    this.triggerCleanup('destroy');
  }
}

// Export singleton instance
export const routeMemoryCleanup = new RouteMemoryCleanup();

// Export React hook for easy integration
export function useRouteMemoryCleanup(router: Router, config?: Partial<RouteCleanupConfig>) {
  React.useEffect(() => {
    routeMemoryCleanup.configure(config || {});
    routeMemoryCleanup.initialize(router);

    return () => {
      // Don't destroy on unmount, let it persist across components
    };
  }, [router, config]);

  return {
    triggerCleanup: (reason?: string) => routeMemoryCleanup.triggerCleanup(reason),
    getStats: () => routeMemoryCleanup.getRouteStats(),
    configure: (newConfig: Partial<RouteCleanupConfig>) => routeMemoryCleanup.configure(newConfig),
  };
}

// Export types
export type { RouteCleanupConfig };

export default routeMemoryCleanup;