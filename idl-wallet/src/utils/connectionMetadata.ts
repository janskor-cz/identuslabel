/**
 * Connection Metadata Storage
 *
 * Stores additional metadata for connections that isn't part of the SDK's DIDPair type.
 * Uses localStorage with wallet-specific prefix to avoid collisions.
 *
 * Metadata stored per connection:
 * - walletType: 'local' | 'cloud' - Which wallet was used for this connection
 * - prismDid: string (optional) - PRISM DID used for cloud connections
 * - enterpriseAgentUrl: string (optional) - Enterprise Agent URL for cloud connections
 * - createdAt: number - Timestamp when connection was established
 *
 * @module connectionMetadata
 */

import { getItem, setItem, removeItem } from './prefixedStorage';

export type WalletType = 'local' | 'cloud';

export interface ConnectionMetadata {
  walletType: WalletType;
  prismDid?: string;
  enterpriseAgentUrl?: string;
  enterpriseAgentApiKey?: string;
  createdAt: number;
  updatedAt: number;
  // VC Proof tracking for connections established with identity verification
  establishedWithVCProof?: boolean;
  vcProofType?: 'RealPerson' | 'SecurityClearance' | string;
}

/**
 * Generate storage key for connection metadata
 * Key format: connection-meta-{hostDID}
 */
function getConnectionMetadataKey(hostDID: string): string {
  // Use host DID as identifier (same DID for both create and accept flows)
  return `connection-meta-${hostDID}`;
}

/**
 * Save connection metadata
 *
 * @param hostDID - Host DID of the connection (our side)
 * @param metadata - Connection metadata to store
 */
export function saveConnectionMetadata(hostDID: string, metadata: Omit<ConnectionMetadata, 'createdAt' | 'updatedAt'>): void {
  try {
    const key = getConnectionMetadataKey(hostDID);
    const existingData = getItem(key);

    const fullMetadata: ConnectionMetadata = {
      ...metadata,
      createdAt: existingData?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    setItem(key, fullMetadata);
    console.log(`✅ [ConnectionMetadata] Saved metadata for connection: ${hostDID.substring(0, 40)}...`);
    console.log(`  → Wallet Type: ${metadata.walletType}`);
    if (metadata.prismDid) {
      console.log(`  → PRISM DID: ${metadata.prismDid.substring(0, 40)}...`);
    }
    if (metadata.establishedWithVCProof) {
      console.log(`  → VC Proof: ${metadata.vcProofType || 'Unknown type'}`);
    }
  } catch (error: any) {
    console.error('[ConnectionMetadata] Error saving connection metadata:', error);
  }
}

/**
 * Get connection metadata by host DID
 *
 * @param hostDID - Host DID of the connection
 * @returns {ConnectionMetadata | null} Connection metadata or null if not found
 */
export function getConnectionMetadata(hostDID: string): ConnectionMetadata | null {
  try {
    const key = getConnectionMetadataKey(hostDID);
    const metadata = getItem(key);

    if (!metadata) {
      console.log(`ℹ️ [ConnectionMetadata] No metadata found for: ${hostDID.substring(0, 40)}...`);
      return null;
    }

    console.log(`✅ [ConnectionMetadata] Retrieved metadata for: ${hostDID.substring(0, 40)}...`);
    console.log(`  → Wallet Type: ${metadata.walletType}`);

    return metadata;
  } catch (error: any) {
    console.error('[ConnectionMetadata] Error retrieving connection metadata:', error);
    return null;
  }
}

/**
 * Get wallet type for a connection (convenience function)
 *
 * @param hostDID - Host DID of the connection
 * @returns {'local' | 'cloud' | null} Wallet type or null if not found
 */
export function getConnectionWalletType(hostDID: string): WalletType | null {
  const metadata = getConnectionMetadata(hostDID);
  return metadata?.walletType || null;
}

/**
 * Check if connection is using cloud wallet
 *
 * @param hostDID - Host DID of the connection
 * @returns {boolean} True if connection is using cloud wallet
 */
export function isCloudConnection(hostDID: string): boolean {
  return getConnectionWalletType(hostDID) === 'cloud';
}

/**
 * Check if connection is using local wallet
 *
 * @param hostDID - Host DID of the connection
 * @returns {boolean} True if connection is using local wallet
 */
export function isLocalConnection(hostDID: string): boolean {
  const walletType = getConnectionWalletType(hostDID);
  return walletType === 'local' || walletType === null; // Default to local if not set
}

/**
 * Remove connection metadata (called when connection is deleted)
 *
 * @param hostDID - Host DID of the connection
 */
export function removeConnectionMetadata(hostDID: string): void {
  try {
    const key = getConnectionMetadataKey(hostDID);
    removeItem(key);
    console.log(`🗑️ [ConnectionMetadata] Removed metadata for: ${hostDID.substring(0, 40)}...`);
  } catch (error: any) {
    console.error('[ConnectionMetadata] Error removing connection metadata:', error);
  }
}

/**
 * Update connection metadata (partial update)
 *
 * @param hostDID - Host DID of the connection
 * @param updates - Partial metadata updates
 */
export function updateConnectionMetadata(hostDID: string, updates: Partial<Omit<ConnectionMetadata, 'createdAt' | 'updatedAt'>>): void {
  try {
    const existingMetadata = getConnectionMetadata(hostDID);

    if (!existingMetadata) {
      console.warn(`⚠️ [ConnectionMetadata] Cannot update non-existent metadata for: ${hostDID.substring(0, 40)}...`);
      return;
    }

    const updatedMetadata: ConnectionMetadata = {
      ...existingMetadata,
      ...updates,
      updatedAt: Date.now()
    };

    const key = getConnectionMetadataKey(hostDID);
    setItem(key, updatedMetadata);

    console.log(`✅ [ConnectionMetadata] Updated metadata for: ${hostDID.substring(0, 40)}...`);
  } catch (error: any) {
    console.error('[ConnectionMetadata] Error updating connection metadata:', error);
  }
}

/**
 * Get all connection metadata (for debugging/diagnostics)
 *
 * @returns {Array<{hostDID: string, metadata: ConnectionMetadata}>} All connection metadata
 */
export function getAllConnectionMetadata(): Array<{ hostDID: string; metadata: ConnectionMetadata }> {
  try {
    const allKeys = Object.keys(localStorage);
    const walletPrefix = getItem('__PREFIX__') || ''; // Get wallet prefix from prefixedStorage
    const metadataKeys = allKeys.filter(key =>
      key.startsWith(walletPrefix) && key.includes('connection-meta-')
    );

    const allMetadata = metadataKeys.map(key => {
      const hostDID = key.replace(walletPrefix, '').replace('connection-meta-', '');
      const metadata = getItem(`connection-meta-${hostDID}`);
      return { hostDID, metadata };
    }).filter(item => item.metadata !== null);

    console.log(`📊 [ConnectionMetadata] Found ${allMetadata.length} connection metadata entries`);

    return allMetadata as Array<{ hostDID: string; metadata: ConnectionMetadata }>;
  } catch (error: any) {
    console.error('[ConnectionMetadata] Error retrieving all connection metadata:', error);
    return [];
  }
}
