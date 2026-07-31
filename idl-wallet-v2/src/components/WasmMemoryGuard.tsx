/**
 * WebAssembly Memory Guard - Prevents WASM memory allocation errors
 *
 * This component aggressively monitors and cleans up WebAssembly memory
 * to prevent "Out of memory: Cannot allocate Wasm memory" errors.
 *
 * Enhanced with automatic reload at 90% memory usage to prevent crashes.
 */

import React, { useEffect, useRef, useState } from 'react';

interface WasmMemoryStats {
  instances: number;
  totalMemory: number;
  lastCleanup: number;
}

const WasmMemoryGuard: React.FC = () => {
  const statsRef = useRef<WasmMemoryStats>({
    instances: 0,
    totalMemory: 0,
    lastCleanup: Date.now()
  });

  // State for automatic reload countdown
  const [showReloadModal, setShowReloadModal] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const cleanupWasmMemory = () => {

    try {
      // Force garbage collection if available
      if (typeof window !== 'undefined' && (window as any).gc) {
        (window as any).gc();
      }

      // Clear any cached WASM modules
      if (typeof window !== 'undefined') {
        // Clear IndexedDB caches that might hold WASM instances
        const clearIndexedDB = async () => {
          try {
            const dbs = await window.indexedDB.databases();
            for (const db of dbs) {
              // Don't delete wallet databases, only temporary caches
              if (db.name && (db.name.includes('cache') || db.name.includes('temp'))) {
                window.indexedDB.deleteDatabase(db.name);
              }
            }
          } catch (error) {
            console.warn('⚠️ [WasmGuard] Could not clear IndexedDB caches:', error);
          }
        };
        clearIndexedDB();
      }

      statsRef.current.lastCleanup = Date.now();
    } catch (error) {
      console.error('❌ [WasmGuard] Error during WASM cleanup:', error);
    }
  };

  // Start automatic reload countdown
  const startReloadCountdown = () => {
    // Prevent multiple countdowns
    if (showReloadModal) return;

    setShowReloadModal(true);
    setCountdown(10);

    // Save current URL to sessionStorage for recovery after reload
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('wallet-reload-url', window.location.href);
      sessionStorage.setItem('wallet-reload-timestamp', Date.now().toString());
    }
  };

  // Cancel automatic reload
  const cancelReload = () => {
    setShowReloadModal(false);
    setCountdown(10);
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  };

  // Execute reload
  const executeReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const checkMemoryPressure = () => {
    if (typeof window === 'undefined' || !(window as any).performance?.memory) {
      return;
    }

    const memory = (window as any).performance.memory;
    const usedMB = Math.round(memory.usedJSHeapSize / 1024 / 1024);
    const limitMB = Math.round(memory.jsHeapSizeLimit / 1024 / 1024);
    const percentage = Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);

    // Aggressive cleanup at 70% memory usage
    if (percentage >= 70) {
      console.warn(`⚠️ [WasmGuard] High memory usage detected: ${usedMB}MB / ${limitMB}MB (${percentage}%)`);

      // Only cleanup if last cleanup was more than 30 seconds ago
      const timeSinceLastCleanup = Date.now() - statsRef.current.lastCleanup;
      if (timeSinceLastCleanup > 30000) {
        cleanupWasmMemory();
      }
    }

    // Critical alert at 85%
    if (percentage >= 85) {
      console.error(`🔴 [WasmGuard] CRITICAL memory usage: ${percentage}%`);
      console.error('🔴 [WasmGuard] User should perform hard refresh (Ctrl+Shift+R)');

      // Show user-visible warning
      const showWarning = () => {
        const warningDiv = document.createElement('div');
        warningDiv.id = 'wasm-memory-warning';
        warningDiv.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          background: #ff4444;
          color: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          z-index: 10000;
          max-width: 400px;
          font-family: sans-serif;
        `;
        warningDiv.innerHTML = `
          <strong>⚠️ High Memory Usage Detected</strong>
          <p style="margin: 10px 0;">The wallet is using too much memory (${percentage}%).</p>
          <p style="margin: 10px 0;"><strong>Please perform a hard refresh:</strong></p>
          <ul style="margin: 5px 0; padding-left: 20px;">
            <li>Windows/Linux: Ctrl + Shift + R</li>
            <li>Mac: Cmd + Shift + R</li>
          </ul>
          <button onclick="location.reload(true)" style="
            background: white;
            color: #ff4444;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            margin-top: 10px;
            font-weight: bold;
          ">Reload Now</button>
        `;

        // Remove existing warning if present
        const existing = document.getElementById('wasm-memory-warning');
        if (existing) {
          existing.remove();
        }

        document.body.appendChild(warningDiv);
      };

      showWarning();

      // Force cleanup immediately
      cleanupWasmMemory();
    }

    // ✅ NEW: Automatic reload at 90% to prevent crash
    if (percentage >= 90 && !showReloadModal) {
      console.error(`🚨 [WasmGuard] DANGER: Memory at ${percentage}% - Starting automatic reload countdown`);
      startReloadCountdown();
    }
  };

  // Countdown effect
  useEffect(() => {
    if (!showReloadModal) return;

    // Start countdown interval
    countdownIntervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          // Countdown finished - execute reload
          executeReload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Cleanup interval on unmount or modal close
    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [showReloadModal]);

  useEffect(() => {

    // Initial cleanup on mount
    cleanupWasmMemory();

    // Check memory every 10 seconds
    const memoryCheckInterval = setInterval(checkMemoryPressure, 10000);

    // Cleanup on route changes
    const handleRouteChange = () => {
      cleanupWasmMemory();
    };

    // Listen for Next.js route changes
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', handleRouteChange);

      // Also listen for visibility changes
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          checkMemoryPressure();
        }
      });
    }

    // Cleanup on unmount
    return () => {
      clearInterval(memoryCheckInterval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('popstate', handleRouteChange);
      }
    };
  }, []);

  // Render automatic reload modal when memory reaches 90%
  if (!showReloadModal) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[99999]"
      style={{ backdropFilter: 'blur(4px)' }}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-orange-600 to-red-600 text-white px-6 py-4 rounded-t-xl">
          <div className="flex items-center space-x-3">
            <span className="text-3xl">⚠️</span>
            <div>
              <h2 className="text-xl font-bold">Memory Critical</h2>
              <p className="text-orange-100 text-sm mt-1">
                Automatic reload in {countdown} seconds
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            WebAssembly memory usage has reached critical levels (90%+).
            To prevent crashes and data loss, the wallet will automatically
            reload in <strong>{countdown} seconds</strong>.
          </p>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              💡 <strong>What happens next:</strong>
            </p>
            <ul className="text-sm text-blue-700 dark:text-blue-300 mt-2 space-y-1 ml-5 list-disc">
              <li>Your wallet will reload automatically</li>
              <li>All credentials and connections are safely stored</li>
              <li>You'll return to your current page</li>
            </ul>
          </div>

          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
            <p className="text-xs text-yellow-800 dark:text-yellow-200">
              <strong>Why this happens:</strong> Extended wallet usage accumulates
              WebAssembly memory. Automatic reloads ensure stable operation.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 bg-gray-50 dark:bg-gray-900 px-6 py-4 rounded-b-xl border-t border-gray-200 dark:border-gray-700">
          <div className="flex space-x-3">
            <button
              onClick={cancelReload}
              className="flex-1 px-4 py-3 bg-gray-300 hover:bg-gray-400 dark:bg-gray-700 dark:hover:bg-gray-600
                       text-gray-800 dark:text-gray-200 font-medium rounded-lg transition-colors duration-200
                       focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
            >
              Cancel ({countdown}s)
            </button>
            <button
              onClick={executeReload}
              className="flex-1 px-4 py-3 bg-orange-600 hover:bg-orange-700
                       text-white font-medium rounded-lg transition-colors duration-200
                       focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2"
            >
              Reload Now
            </button>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-3">
            Auto-reload will occur when countdown reaches 0
          </p>
        </div>
      </div>
    </div>
  );
};

export default WasmMemoryGuard;
