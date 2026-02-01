import SDK from '@hyperledger/identus-edge-agent-sdk';
import { ConnectionRequestItem } from './connectionRequestQueue';

export interface InvitationRecord {
  id: string;
  invitationId: string;
  status: "InvitationGenerated" | "ConnectionRequested" | "Connected" | "Rejected";
  createdAt: number;
  label: string;
  inviterDID: string;
  invitationUrl?: string;
  pendingRequests: ConnectionRequestItem[];
}

export interface InvitationStateConfig {
  walletId: string;
  dbName?: string;
}

/**
 * Invitation State Manager
 * Manages the lifecycle of DIDComm invitations from creation to connection establishment
 * Implements the user's suggested approach: InvitationGenerated → ConnectionRequested → Connected
 */
export class InvitationStateManager {
  private dbName: string;
  private dbVersion: number = 1;
  private db: IDBDatabase | null = null;
  private walletId: string;

  constructor(config: InvitationStateConfig) {
    this.walletId = config.walletId;
    this.dbName = config.dbName || `invitation_states_${config.walletId}`;
  }

  /**
   * Initialize the IndexedDB database for invitation state management
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ [INVITATION STATE] IndexedDB initialized successfully');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('invitation_records')) {
          const store = db.createObjectStore('invitation_records', { keyPath: 'id' });
          store.createIndex('invitationId', 'invitationId', { unique: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          console.log('🏗️ [INVITATION STATE] Created invitation_records object store');
        }
      };
    });
  }

  /**
   * Create a new invitation record when Alice generates an invitation
   */
  async createInvitationRecord(
    invitationId: string,
    label: string,
    inviterDID: string,
    invitationUrl?: string
  ): Promise<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const recordId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const invitationRecord: InvitationRecord = {
      id: recordId,
      invitationId,
      status: "InvitationGenerated",
      createdAt: now,
      label,
      inviterDID,
      invitationUrl,
      pendingRequests: []
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');

      const request = store.add(invitationRecord);

      request.onsuccess = () => {
        console.log(`✅ [INVITATION STATE] Created invitation record: ${recordId} with status: InvitationGenerated`);
        resolve(recordId);
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to create invitation record:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Add a connection request to an existing invitation record
   */
  async addConnectionRequestToInvitation(
    invitationId: string,
    connectionRequest: ConnectionRequestItem
  ): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update record status and add the connection request
        record.status = "ConnectionRequested";
        record.pendingRequests.push(connectionRequest);

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Added connection request to invitation ${invitationId}, status now: ConnectionRequested`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to update invitation record:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Mark invitation as connected (when connection request is accepted)
   */
  async markInvitationConnected(
    invitationId: string,
    requestId: string
  ): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update status and mark the specific request as accepted
        record.status = "Connected";
        record.pendingRequests = record.pendingRequests.map(req =>
          req.id === requestId ? { ...req, status: 'accepted' } : req
        );

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Marked invitation ${invitationId} as Connected`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to mark invitation as connected:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Mark invitation as rejected (when connection request is rejected)
   */
  async markInvitationRejected(
    invitationId: string,
    requestId: string
  ): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update status and mark the specific request as rejected
        record.status = "Rejected";
        record.pendingRequests = record.pendingRequests.map(req =>
          req.id === requestId ? { ...req, status: 'rejected' } : req
        );

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Marked invitation ${invitationId} as Rejected`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to mark invitation as rejected:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Get all invitation records with their current status
   */
  async getAllInvitationRecords(): Promise<InvitationRecord[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readonly');
      const store = transaction.objectStore('invitation_records');

      const request = store.getAll();

      request.onsuccess = () => {
        const records = request.result || [];
        console.log(`📋 [INVITATION STATE] Retrieved ${records.length} invitation records`);
        resolve(records);
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to get invitation records:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get invitation records by status
   */
  async getInvitationRecordsByStatus(status: InvitationRecord['status']): Promise<InvitationRecord[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readonly');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('status');

      const request = index.getAll(status);

      request.onsuccess = () => {
        const records = request.result || [];
        console.log(`📋 [INVITATION STATE] Retrieved ${records.length} invitation records with status: ${status}`);
        resolve(records);
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to get invitation records by status:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Find invitation record by invitation ID
   */
  async findByInvitationId(invitationId: string): Promise<InvitationRecord | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readonly');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const request = index.get(invitationId);

      request.onsuccess = () => {
        const record = request.result || null;
        resolve(record);
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get invitation statistics for debugging
   */
  async getInvitationStats(): Promise<{
    total: number;
    generated: number;
    connectionRequested: number;
    connected: number;
    rejected: number;
  }> {
    const allRecords = await this.getAllInvitationRecords();

    return {
      total: allRecords.length,
      generated: allRecords.filter(r => r.status === 'InvitationGenerated').length,
      connectionRequested: allRecords.filter(r => r.status === 'ConnectionRequested').length,
      connected: allRecords.filter(r => r.status === 'Connected').length,
      rejected: allRecords.filter(r => r.status === 'Rejected').length,
    };
  }

  /**
   * Clear all invitation records (for testing/reset purposes)
   */
  async clearAllInvitationRecords(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');

      const request = store.clear();

      request.onsuccess = () => {
        console.log('🧹 [INVITATION STATE] Cleared all invitation records');
        resolve();
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to clear invitation records:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Mark invitation request as sent (without needing requestId)
   * Used when Bob sends connection request to CA
   */
  async markInvitationRequestSent(invitationId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update status to ConnectionRequested
        record.status = "ConnectionRequested";

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Marked invitation ${invitationId} as ConnectionRequested`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to mark invitation request sent:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Create received invitation record (Bob's perspective when receiving from Alice/CA)
   */
  async createReceivedInvitationRecord(
    invitationId: string,
    inviterDID: string,
    inviterDisplayLabel: string,
    oob: string,
    hasVCProof: boolean,
    vcProofType?: string
  ): Promise<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const recordId = `inv_received_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const invitationRecord: InvitationRecord = {
      id: recordId,
      invitationId,
      status: "InvitationGenerated",
      createdAt: now,
      label: inviterDisplayLabel,
      inviterDID,
      invitationUrl: oob,
      pendingRequests: []
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');

      const request = store.add(invitationRecord);

      request.onsuccess = () => {
        console.log(`✅ [INVITATION STATE] Created received invitation record: ${recordId} (VC Proof: ${hasVCProof})`);
        resolve(recordId);
      };

      request.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to create received invitation record:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Mark invitation as established/connected (without needing requestId)
   * Used when connection is successfully established
   */
  async markInvitationEstablished(invitationId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update status to Connected
        record.status = "Connected";

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Marked invitation ${invitationId} as Connected`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to mark invitation as established:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  /**
   * Mark invitation as rejected by user (without needing requestId)
   * Used when user explicitly rejects an invitation
   */
  async markInvitationRejectedByUser(invitationId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['invitation_records'], 'readwrite');
      const store = transaction.objectStore('invitation_records');
      const index = store.index('invitationId');

      const getRequest = index.get(invitationId);

      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          console.warn(`⚠️ [INVITATION STATE] No invitation record found for ID: ${invitationId}`);
          resolve(false);
          return;
        }

        // Update status to Rejected
        record.status = "Rejected";

        const putRequest = store.put(record);

        putRequest.onsuccess = () => {
          console.log(`✅ [INVITATION STATE] Marked invitation ${invitationId} as Rejected`);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error('🔴 [INVITATION STATE] Failed to mark invitation as rejected:', putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error('🔴 [INVITATION STATE] Failed to find invitation record:', getRequest.error);
        reject(getRequest.error);
      };
    });
  }
}

/**
 * Singleton instance manager for invitation state
 */
class InvitationStateManagerSingleton {
  private static instances: Map<string, InvitationStateManager> = new Map();

  static async getInstance(walletId: string): Promise<InvitationStateManager> {
    if (!this.instances.has(walletId)) {
      const manager = new InvitationStateManager({ walletId });
      await manager.initialize();
      this.instances.set(walletId, manager);
    }
    return this.instances.get(walletId)!;
  }

  static clearInstances(): void {
    this.instances.clear();
  }
}

export { InvitationStateManagerSingleton };

/**
 * Utility functions for managing invitation state
 */
export const invitationStateManager = {
  /**
   * Create new invitation record when Alice creates an invitation
   */
  async createInvitation(
    walletId: string,
    invitationId: string,
    label: string,
    inviterDID: string,
    invitationUrl?: string
  ): Promise<string> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.createInvitationRecord(invitationId, label, inviterDID, invitationUrl);
  },

  /**
   * Add connection request to invitation when Bob connects
   */
  async addConnectionRequest(
    walletId: string,
    invitationId: string,
    connectionRequest: ConnectionRequestItem
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.addConnectionRequestToInvitation(invitationId, connectionRequest);
  },

  /**
   * Mark invitation as connected when Alice accepts the request
   */
  async acceptConnection(
    walletId: string,
    invitationId: string,
    requestId: string
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.markInvitationConnected(invitationId, requestId);
  },

  /**
   * Mark invitation as rejected when Alice rejects the request
   */
  async rejectConnection(
    walletId: string,
    invitationId: string,
    requestId: string
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.markInvitationRejected(invitationId, requestId);
  },

  /**
   * Get all invitation records for display
   */
  async getAllInvitations(walletId: string): Promise<InvitationRecord[]> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.getAllInvitationRecords();
  },

  /**
   * Find invitation by ID for correlation
   */
  async findInvitation(walletId: string, invitationId: string): Promise<InvitationRecord | null> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.findByInvitationId(invitationId);
  },

  /**
   * Get invitation statistics for debugging
   */
  async getStats(walletId: string): Promise<any> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.getInvitationStats();
  },

  /**
   * Mark invitation as previewed (no-op for now, returns true for compatibility)
   */
  async markPreviewed(walletId: string, invitationId: string): Promise<boolean> {
    // No-op function for compatibility - "Previewed" status doesn't exist yet
    // This prevents errors when InvitationPreviewModal calls this function
    console.log(`✅ [INVITATION STATE] Invitation ${invitationId} marked as previewed (no-op)`);
    return true;
  },

  /**
   * Create received invitation record when Bob receives invitation from Alice/CA
   */
  async createReceivedInvitation(
    walletId: string,
    invitationId: string,
    inviterDID: string,
    inviterDisplayLabel: string,
    oob: string,
    hasVCProof: boolean,
    vcProofType?: string
  ): Promise<string> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.createReceivedInvitationRecord(
      invitationId,
      inviterDID,
      inviterDisplayLabel,
      oob,
      hasVCProof,
      vcProofType
    );
  },

  /**
   * Mark invitation request as sent (Bob's perspective)
   */
  async markRequestSent(
    walletId: string,
    invitationId: string,
    senderDID: string
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.markInvitationRequestSent(invitationId);
  },

  /**
   * Mark invitation as established/connected (without requestId)
   */
  async markEstablished(
    walletId: string,
    invitationId: string
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.markInvitationEstablished(invitationId);
  },

  /**
   * Mark invitation as rejected by user (without requestId)
   */
  async markRejected(
    walletId: string,
    invitationId: string
  ): Promise<boolean> {
    const manager = await InvitationStateManagerSingleton.getInstance(walletId);
    return manager.markInvitationRejectedByUser(invitationId);
  }
};