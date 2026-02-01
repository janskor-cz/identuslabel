import SDK from '@hyperledger/identus-edge-agent-sdk';

export interface ConnectionRequestItem {
  id: string;
  message: SDK.Domain.Message;
  timestamp: number;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  attachedCredential?: any;
  verificationResult?: any;
  expiresAt?: number;
}

export interface ConnectionRequestQueue {
  requests: ConnectionRequestItem[];
  lastUpdated: number;
}

const STORAGE_KEY = 'connection_request_queue';
const DEFAULT_EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Connection Request Queue Manager
 * Provides persistent storage and management for connection requests using IndexedDB
 */
export class ConnectionRequestQueueManager {
  private dbName: string;
  private dbVersion: number = 1;
  private db: IDBDatabase | null = null;

  constructor(walletId: string) {
    this.dbName = `connection_requests_${walletId}`;
  }

  /**
   * Initialize the IndexedDB database
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('connection_requests')) {
          const store = db.createObjectStore('connection_requests', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
      };
    });
  }

  /**
   * Add a new connection request to the queue
   * DEDUPLICATION: Checks for existing message.id before adding
   */
  async addConnectionRequest(
    message: SDK.Domain.Message,
    attachedCredential?: any,
    expirationHours: number = 24
  ): Promise<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // ✅ FIX 1: Check if request with this message.id already exists
    const existingRequest = await this.findRequestByMessageId(message.id);

    if (existingRequest) {
      return existingRequest.id;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    const expiresAt = now + (expirationHours * 60 * 60 * 1000);

    const requestItem: ConnectionRequestItem = {
      id: requestId,
      message: {
        id: message.id,
        piuri: message.piuri,
        from: message.from?.toString() || '',
        to: message.to?.toString() || '',
        body: message.body,
        createdTime: message.createdTime,
        direction: message.direction,
        attachments: message.attachments || []
      } as any, // Type assertion to handle DID serialization
      timestamp: now,
      status: 'pending',
      attachedCredential,
      expiresAt
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readwrite');
      const store = transaction.objectStore('connection_requests');

      const request = store.add(requestItem);

      request.onsuccess = () => {
        resolve(requestId);
      };

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to add request:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Find a request by message.id to prevent duplicates
   */
  private async findRequestByMessageId(messageId: string): Promise<ConnectionRequestItem | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readonly');
      const store = transaction.objectStore('connection_requests');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => {
        const allRequests = getAllRequest.result || [];
        const matchingRequest = allRequests.find(req => req.message.id === messageId);
        resolve(matchingRequest || null);
      };

      getAllRequest.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to search for existing message:', getAllRequest.error);
        reject(getAllRequest.error);
      };
    });
  }

  /**
   * Get all pending connection requests
   */
  async getPendingRequests(): Promise<ConnectionRequestItem[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readonly');
      const store = transaction.objectStore('connection_requests');
      const index = store.index('status');

      const request = index.getAll('pending');

      request.onsuccess = () => {
        const requests = request.result || [];
        const now = Date.now();

        // Filter out expired requests
        const validRequests = requests.filter(req =>
          !req.expiresAt || req.expiresAt > now
        );

        resolve(validRequests);
      };

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to get pending requests:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Update connection request status
   */
  async updateRequestStatus(
    requestId: string,
    status: 'accepted' | 'rejected' | 'expired',
    verificationResult?: any
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readwrite');
      const store = transaction.objectStore('connection_requests');

      const getRequest = store.get(requestId);

      getRequest.onsuccess = () => {
        const requestItem = getRequest.result;
        if (!requestItem) {
          reject(new Error('Request not found'));
          return;
        }

        requestItem.status = status;
        if (verificationResult) {
          requestItem.verificationResult = verificationResult;
        }

        const putRequest = store.put(requestItem);

        putRequest.onsuccess = () => {
          resolve();
        };

        putRequest.onerror = () => {
          console.error('🔴 [CONNECTION QUEUE] Failed to update request status:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to get request for update:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Remove a connection request from the queue
   */
  async removeRequest(requestId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readwrite');
      const store = transaction.objectStore('connection_requests');

      const request = store.delete(requestId);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to remove request:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clean up expired requests
   */
  async cleanupExpiredRequests(): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const allRequests = await this.getAllRequests();
    const now = Date.now();
    let cleanedCount = 0;

    for (const request of allRequests) {
      if (request.expiresAt && request.expiresAt <= now && request.status === 'pending') {
        await this.updateRequestStatus(request.id, 'expired');
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Get all requests (for debugging/admin purposes)
   */
  async getAllRequests(): Promise<ConnectionRequestItem[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readonly');
      const store = transaction.objectStore('connection_requests');

      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to get all requests:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
  }> {
    const allRequests = await this.getAllRequests();

    return {
      total: allRequests.length,
      pending: allRequests.filter(r => r.status === 'pending').length,
      accepted: allRequests.filter(r => r.status === 'accepted').length,
      rejected: allRequests.filter(r => r.status === 'rejected').length,
      expired: allRequests.filter(r => r.status === 'expired').length,
    };
  }

  /**
   * Clear all requests (for testing/reset purposes)
   */
  async clearAllRequests(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['connection_requests'], 'readwrite');
      const store = transaction.objectStore('connection_requests');

      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [CONNECTION QUEUE] Failed to clear requests:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Remove duplicate connection requests with same message.id
   * Keeps the earliest entry (by timestamp) and removes duplicates
   */
  async deduplicateRequests(): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const allRequests = await this.getAllRequests();

    // Group requests by message.id
    const requestsByMessageId = new Map<string, ConnectionRequestItem[]>();

    for (const request of allRequests) {
      const messageId = request.message.id;
      if (!requestsByMessageId.has(messageId)) {
        requestsByMessageId.set(messageId, []);
      }
      requestsByMessageId.get(messageId)!.push(request);
    }

    let removedCount = 0;

    // For each group with duplicates, keep earliest and remove rest
    for (const [messageId, requests] of requestsByMessageId.entries()) {
      if (requests.length > 1) {
        // Sort by timestamp (earliest first)
        requests.sort((a, b) => a.timestamp - b.timestamp);

        // Keep the first one (earliest), remove the rest
        const toKeep = requests[0];
        const toRemove = requests.slice(1);


        for (const duplicate of toRemove) {
          await this.removeRequest(duplicate.id);
          removedCount++;
        }
      }
    }

    return removedCount;
  }
}

/**
 * Singleton instance manager for connection request queue
 */
class ConnectionRequestQueueSingleton {
  private static instances: Map<string, ConnectionRequestQueueManager> = new Map();

  static async getInstance(walletId: string): Promise<ConnectionRequestQueueManager> {
    if (!this.instances.has(walletId)) {
      const manager = new ConnectionRequestQueueManager(walletId);
      await manager.initialize();
      this.instances.set(walletId, manager);
    }
    return this.instances.get(walletId)!;
  }

  static clearInstances(): void {
    this.instances.clear();
  }
}

export { ConnectionRequestQueueSingleton };

/**
 * Utility functions for managing connection request queue
 */
export const connectionRequestQueue = {
  /**
   * Add a new connection request to the persistent queue
   */
  async addRequest(
    walletId: string,
    message: SDK.Domain.Message,
    attachedCredential?: any,
    expirationHours: number = 24
  ): Promise<string> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    return manager.addConnectionRequest(message, attachedCredential, expirationHours);
  },

  /**
   * Get all pending connection requests
   */
  async getPendingRequests(walletId: string): Promise<ConnectionRequestItem[]> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    await manager.cleanupExpiredRequests(); // Auto-cleanup on fetch
    return manager.getPendingRequests();
  },

  /**
   * Mark a request as handled (accepted/rejected)
   */
  async handleRequest(
    walletId: string,
    requestId: string,
    status: 'accepted' | 'rejected',
    verificationResult?: any
  ): Promise<void> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    return manager.updateRequestStatus(requestId, status, verificationResult);
  },

  /**
   * Remove a request completely
   */
  async removeRequest(walletId: string, requestId: string): Promise<void> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    return manager.removeRequest(requestId);
  },

  /**
   * Get queue statistics for debugging
   */
  async getStats(walletId: string): Promise<any> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    return manager.getQueueStats();
  },

  /**
   * Remove duplicate connection requests with same message.id
   * Keeps the earliest entry and removes duplicates
   */
  async deduplicate(walletId: string): Promise<number> {
    const manager = await ConnectionRequestQueueSingleton.getInstance(walletId);
    return manager.deduplicateRequests();
  }
};