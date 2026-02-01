import SDK from '@hyperledger/identus-edge-agent-sdk';

export interface RejectionRecord {
  messageId: string;
  fromDID: string;
  rejectedAt: number;
  expiresAt: number;
  reason?: string;
  type: 'connection_request' | 'credential_offer' | 'presentation_request';
}

export interface RejectionStorage {
  rejections: RejectionRecord[];
  lastCleanup: number;
}

const STORAGE_KEY_PREFIX = 'message_rejections';
const DEFAULT_REJECTION_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Message Rejection Manager
 * Handles persistent tracking of rejected DIDComm messages to prevent re-showing
 */
export class MessageRejectionManager {
  private dbName: string;
  private dbVersion: number = 1;
  private db: IDBDatabase | null = null;
  private walletId: string;

  constructor(walletId: string) {
    this.walletId = walletId;
    this.dbName = `message_rejections_${walletId}`;
  }

  /**
   * Initialize the IndexedDB database for rejection tracking
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Auto-cleanup on initialization
        this.cleanupExpiredRejections().catch(error =>
          console.warn('⚠️ [REJECTION MANAGER] Auto-cleanup failed:', error)
        );

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('rejections')) {
          const store = db.createObjectStore('rejections', { keyPath: 'messageId' });
          store.createIndex('fromDID', 'fromDID', { unique: false });
          store.createIndex('rejectedAt', 'rejectedAt', { unique: false });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
  }

  /**
   * Mark a message as rejected
   */
  async rejectMessage(
    message: SDK.Domain.Message,
    reason?: string,
    expiryDays: number = 30
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const now = Date.now();
    const expiresAt = now + (expiryDays * 24 * 60 * 60 * 1000);

    // Determine message type
    let messageType: RejectionRecord['type'] = 'connection_request';
    if (message.piuri.includes('credential')) {
      messageType = 'credential_offer';
    } else if (message.piuri.includes('presentation')) {
      messageType = 'presentation_request';
    }

    const rejectionRecord: RejectionRecord = {
      messageId: message.id,
      fromDID: message.from?.toString() || 'unknown',
      rejectedAt: now,
      expiresAt,
      reason,
      type: messageType
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readwrite');
      const store = transaction.objectStore('rejections');

      const request = store.put(rejectionRecord);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to store rejection:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Check if a message has been rejected
   */
  async isMessageRejected(messageId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readonly');
      const store = transaction.objectStore('rejections');

      const request = store.get(messageId);

      request.onsuccess = () => {
        const rejectionRecord = request.result as RejectionRecord | undefined;

        if (!rejectionRecord) {
          resolve(false);
          return;
        }

        // Check if rejection has expired
        const now = Date.now();
        if (rejectionRecord.expiresAt <= now) {
          // Remove expired rejection
          this.removeRejection(messageId).catch(error =>
            console.warn('⚠️ [REJECTION MANAGER] Failed to remove expired rejection:', error)
          );
          resolve(false);
          return;
        }

        resolve(true);
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to check rejection status:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Check if messages from a specific DID should be blocked
   */
  async isDIDBlocked(fromDID: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readonly');
      const store = transaction.objectStore('rejections');
      const index = store.index('fromDID');

      const request = index.getAll(fromDID);

      request.onsuccess = () => {
        const rejections = request.result as RejectionRecord[];
        const now = Date.now();

        // Count recent rejections (within 24 hours)
        const recentRejections = rejections.filter(r =>
          r.rejectedAt > (now - 24 * 60 * 60 * 1000) && r.expiresAt > now
        );

        // Block if more than 3 rejections in 24 hours
        const shouldBlock = recentRejections.length >= 3;

        if (shouldBlock) {
        }

        resolve(shouldBlock);
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to check DID block status:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Remove a rejection record
   */
  async removeRejection(messageId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readwrite');
      const store = transaction.objectStore('rejections');

      const request = store.delete(messageId);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to remove rejection:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get all rejection records (for debugging)
   */
  async getAllRejections(): Promise<RejectionRecord[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readonly');
      const store = transaction.objectStore('rejections');

      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to get all rejections:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clean up expired rejection records
   */
  async cleanupExpiredRejections(): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const allRejections = await this.getAllRejections();
    const now = Date.now();
    let cleanedCount = 0;

    for (const rejection of allRejections) {
      if (rejection.expiresAt <= now) {
        await this.removeRejection(rejection.messageId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
    }

    return cleanedCount;
  }

  /**
   * Get rejection statistics
   */
  async getRejectionStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    byDID: Record<string, number>;
    recentCount: number;
  }> {
    const allRejections = await this.getAllRejections();
    const now = Date.now();
    const last24Hours = now - (24 * 60 * 60 * 1000);

    const stats = {
      total: allRejections.length,
      byType: {} as Record<string, number>,
      byDID: {} as Record<string, number>,
      recentCount: 0
    };

    for (const rejection of allRejections) {
      // Count by type
      stats.byType[rejection.type] = (stats.byType[rejection.type] || 0) + 1;

      // Count by DID (truncated for privacy)
      const shortDID = rejection.fromDID.substring(0, 20) + '...';
      stats.byDID[shortDID] = (stats.byDID[shortDID] || 0) + 1;

      // Count recent rejections
      if (rejection.rejectedAt > last24Hours) {
        stats.recentCount++;
      }
    }

    return stats;
  }

  /**
   * Clear all rejection records (for testing/reset)
   */
  async clearAllRejections(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['rejections'], 'readwrite');
      const store = transaction.objectStore('rejections');

      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [REJECTION MANAGER] Failed to clear rejections:', request.error);
        reject(request.error);
      };
    });
  }
}

/**
 * Singleton instance manager for message rejection tracking
 */
class RejectionManagerSingleton {
  private static instances: Map<string, MessageRejectionManager> = new Map();

  static async getInstance(walletId: string): Promise<MessageRejectionManager> {
    if (!this.instances.has(walletId)) {
      const manager = new MessageRejectionManager(walletId);
      await manager.initialize();
      this.instances.set(walletId, manager);
    }
    return this.instances.get(walletId)!;
  }

  static clearInstances(): void {
    this.instances.clear();
  }
}

export { RejectionManagerSingleton };

/**
 * Utility functions for message rejection management
 */
export const messageRejection = {
  /**
   * Mark a message as rejected
   */
  async rejectMessage(
    walletId: string,
    message: SDK.Domain.Message,
    reason?: string,
    expiryDays: number = 30
  ): Promise<void> {
    const manager = await RejectionManagerSingleton.getInstance(walletId);
    return manager.rejectMessage(message, reason, expiryDays);
  },

  /**
   * Check if a message is rejected
   */
  async isRejected(walletId: string, messageId: string): Promise<boolean> {
    const manager = await RejectionManagerSingleton.getInstance(walletId);
    return manager.isMessageRejected(messageId);
  },

  /**
   * Check if a DID is blocked due to multiple rejections
   */
  async isDIDBlocked(walletId: string, fromDID: string): Promise<boolean> {
    const manager = await RejectionManagerSingleton.getInstance(walletId);
    return manager.isDIDBlocked(fromDID);
  },

  /**
   * Get rejection statistics
   */
  async getStats(walletId: string): Promise<any> {
    const manager = await RejectionManagerSingleton.getInstance(walletId);
    return manager.getRejectionStats();
  },

  /**
   * Clean up expired rejections
   */
  async cleanup(walletId: string): Promise<number> {
    const manager = await RejectionManagerSingleton.getInstance(walletId);
    return manager.cleanupExpiredRejections();
  }
};