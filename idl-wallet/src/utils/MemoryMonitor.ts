/**
 * Memory Monitor - WebAssembly memory usage tracking and alerts
 *
 * This utility monitors WebAssembly memory usage and provides
 * warnings when memory usage approaches critical levels,
 * helping prevent WebAssembly allocation errors.
 */

interface MemoryStats {
  used: number;
  limit: number;
  percentage: number;
  timestamp: number;
}

interface MemoryAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  stats: MemoryStats;
  timestamp: number;
}

class MemoryMonitor {
  private isMonitoring = false;
  private monitorInterval?: NodeJS.Timeout;
  private alertCallbacks: ((alert: MemoryAlert) => void)[] = [];
  private lastStats: MemoryStats | null = null;
  private alertHistory: MemoryAlert[] = [];

  // Memory thresholds (percentage of total)
  private readonly WARNING_THRESHOLD = 70;
  private readonly CRITICAL_THRESHOLD = 85;
  private readonly MONITOR_INTERVAL = 5000; // 5 seconds
  private readonly MAX_ALERT_HISTORY = 50;

  constructor() {
    this.setupEventListeners();
  }

  /**
   * Start monitoring memory usage
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      // Already monitoring - no need to log
      return;
    }

    if (!this.isMemoryAPIAvailable()) {
      // Memory API not available - only warn once during initial setup
      return;
    }

    this.isMonitoring = true;

    this.monitorInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, this.MONITOR_INTERVAL);

    // Initial check
    this.checkMemoryUsage();
  }

  /**
   * Stop monitoring memory usage
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }
  }

  /**
   * Get current memory statistics
   */
  getCurrentStats(): MemoryStats | null {
    if (!this.isMemoryAPIAvailable()) {
      return null;
    }

    const memory = (window as any).performance.memory;
    return {
      used: Math.round(memory.usedJSHeapSize / 1024 / 1024), // MB
      limit: Math.round(memory.jsHeapSizeLimit / 1024 / 1024), // MB
      percentage: Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100),
      timestamp: Date.now()
    };
  }

  /**
   * Add callback for memory alerts
   */
  onAlert(callback: (alert: MemoryAlert) => void): () => void {
    this.alertCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.alertCallbacks.indexOf(callback);
      if (index > -1) {
        this.alertCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get alert history
   */
  getAlertHistory(): MemoryAlert[] {
    return [...this.alertHistory];
  }

  /**
   * Clear alert history
   */
  clearAlertHistory(): void {
    this.alertHistory = [];
  }

  /**
   * Force memory cleanup (if garbage collection is available)
   */
  forceCleanup(): boolean {
    if (typeof window !== 'undefined' && (window as any).gc) {
      try {
        (window as any).gc();
        return true;
      } catch (error) {
        // Silently fail - garbage collection is best effort
        return false;
      }
    }

    // Garbage collection not available - this is normal in production
    return false;
  }

  /**
   * Get memory usage trend (increasing/decreasing/stable)
   */
  getMemoryTrend(): 'increasing' | 'decreasing' | 'stable' | 'unknown' {
    if (!this.lastStats) {
      return 'unknown';
    }

    const current = this.getCurrentStats();
    if (!current) {
      return 'unknown';
    }

    const diff = current.percentage - this.lastStats.percentage;
    if (Math.abs(diff) < 2) { // Less than 2% change
      return 'stable';
    }

    return diff > 0 ? 'increasing' : 'decreasing';
  }

  /**
   * Check if memory API is available
   */
  private isMemoryAPIAvailable(): boolean {
    return typeof window !== 'undefined' &&
           typeof (window as any).performance?.memory !== 'undefined';
  }

  /**
   * Check current memory usage and trigger alerts if needed
   */
  private checkMemoryUsage(): void {
    const stats = this.getCurrentStats();
    if (!stats) {
      return;
    }

    // Store for trend analysis
    this.lastStats = stats;

    // Check for alert conditions
    if (stats.percentage >= this.CRITICAL_THRESHOLD) {
      this.triggerAlert('critical', `Critical memory usage: ${stats.percentage}%`, stats);
    } else if (stats.percentage >= this.WARNING_THRESHOLD) {
      this.triggerAlert('warning', `High memory usage: ${stats.percentage}%`, stats);
    }

    // Periodic logging removed - only log warnings and critical alerts via triggerAlert
  }

  /**
   * Trigger memory alert
   */
  private triggerAlert(level: 'info' | 'warning' | 'critical', message: string, stats: MemoryStats): void {
    const alert: MemoryAlert = {
      level,
      message,
      stats,
      timestamp: Date.now()
    };

    // Add to history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.MAX_ALERT_HISTORY) {
      this.alertHistory.shift();
    }

    // Notify callbacks
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        console.error('❌ [MemoryMonitor] Error in alert callback:', error);
      }
    });

    // Console logging
    const emoji = level === 'critical' ? '🔴' : level === 'warning' ? '🟡' : 'ℹ️';
    console.log(`${emoji} [MemoryMonitor] ${message}`);

    // Auto-cleanup on critical alerts
    if (level === 'critical') {
      setTimeout(() => {
        this.forceCleanup();
      }, 100);
    }
  }

  /**
   * Set up event listeners for automatic monitoring
   */
  private setupEventListeners(): void {
    if (typeof window === 'undefined') {
      return;
    }

    // Start monitoring when page becomes visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.isMonitoring) {
        this.startMonitoring();
      }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      this.stopMonitoring();
    });

    // Monitor on focus/blur
    window.addEventListener('focus', () => {
      if (!this.isMonitoring) {
        this.startMonitoring();
      }
    });

    window.addEventListener('blur', () => {
      // Don't stop monitoring on blur, just reduce frequency
      // This helps catch memory issues in background tabs
    });
  }

  /**
   * Create a memory monitoring React hook
   */
  createReactHook() {
    return () => {
      const [stats, setStats] = React.useState<MemoryStats | null>(null);
      const [alerts, setAlerts] = React.useState<MemoryAlert[]>([]);

      React.useEffect(() => {
        // Start monitoring
        this.startMonitoring();

        // Set up alert listener
        const unsubscribe = this.onAlert((alert) => {
          setAlerts(prev => [...prev.slice(-9), alert]); // Keep last 10 alerts
        });

        // Update stats periodically
        const interval = setInterval(() => {
          const currentStats = this.getCurrentStats();
          setStats(currentStats);
        }, this.MONITOR_INTERVAL);

        // Cleanup
        return () => {
          unsubscribe();
          clearInterval(interval);
          this.stopMonitoring();
        };
      }, []);

      return {
        stats,
        alerts,
        forceCleanup: () => this.forceCleanup(),
        clearAlerts: () => {
          this.clearAlertHistory();
          setAlerts([]);
        },
        trend: this.getMemoryTrend(),
      };
    };
  }

  /**
   * Destroy the monitor
   */
  destroy(): void {
    this.stopMonitoring();
    this.alertCallbacks = [];
    this.alertHistory = [];
    this.lastStats = null;
  }
}

// Export singleton instance
export const memoryMonitor = new MemoryMonitor();

// Export React hook
export const useMemoryMonitor = memoryMonitor.createReactHook();

// Export types
export type { MemoryStats, MemoryAlert };

export default memoryMonitor;