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
  // @deprecated — superseded by `capabilities` below. Kept (write + read) only during the
  // service-access/1.0 migration window; removed once every reader is repointed (see
  // packages/service-access-didcomm and idl-wallet/src/utils/serviceAccessGrant.ts).
  isCAConnection?: boolean;
  // Set at connection-establishment time for a connection to a company (employee OOB invitation
  // carrying goal_code 'company-employee-verification' — see OOB.tsx's isCompanyInvitation), or
  // backfilled by connectionAccessTargets.ts's name-match fallback for a connection that predates
  // this flag. Mirrors isCAConnection's role but is not deprecated — unlike the CA (a single
  // fixed service), there is no single well-known company DID this could collapse into, so the
  // flag plus the per-connection `capabilities` entry below remain the mechanism going forward.
  isCompanyConnection?: boolean;
  // service-access/1.0 capability keys this connection's peer is trusted to grant (e.g.
  // ['portal','login','security-clearance'] for a CA connection). Set at connection-
  // establishment time from real evidence (e.g. fetched directly from a pinned HTTPS
  // well-known-invitation endpoint), not from a locally-editable display name — see
  // packages/service-access-didcomm/PROTOCOL.md "Trust model".
  capabilities?: string[];
  // Access targets discovered from VCs received through this connection
  supportedTargets?: Array<{ key: string; label: string; icon: string }>;
  // Peer DID used by the remote party for this connection (resolved at credential issuance time)
  remotePartyDid?: string;
  // Outcome of the POST-CONNECTION live identity verification round trip (RealPerson-typed
  // invitations only) — see utils/liveIdentityVerification.ts and components/OOB.tsx. Distinct
  // from `establishedWithVCProof`/`vcProofType` above, which only record that a pre-connection
  // vc-proof-0 PREVIEW was attached — not that its claimed identity was ever cryptographically
  // proven live. Absent entirely for connections that never carried a RealPerson preview.
  identityVerificationStatus?: 'pending' | 'verified' | 'failed';
  identityVerificationError?: string;
  identityVerifiedAt?: number;
  // Full credentialSubject from the LIVE, cryptographically-verified credential (never the
  // unverified pre-connection preview — see liveIdentityVerification.ts's `verifiedSubject` on
  // LiveIdentityVerificationResult), persisted only once that live post-connection verification
  // has actually passed (OOB.tsx's performLiveIdentityVerificationAndMaybeRespond and its CA/
  // Company counterpart / ConnectionRequest.tsx's performLiveIdentityVerificationOfInvitee — all
  // three now funnel through liveIdentityVerification.ts's shared verifyAndRecordLiveIdentity).
  // The wallet never received an actual stored Credential from this peer (live verification
  // proves possession without issuing/storing a VC), so there is otherwise no record at all for
  // this connection's peer identity — this is that record, in the SAME shape as a real
  // credential's credentialSubject (whatever fields the issuer put there: photo/firstName/
  // lastName/uniqueId for a live-verified RealPersonIdentity, clearanceLevel/holderName/
  // holderUniqueId/etc. for a live-verified SecurityClearance, or organizationName/companyName/
  // registrationNumber/etc. for a live-verified CertificationAuthorityIdentity/CompanyIdentity),
  // so it can be rendered through the same type-specific layout a real held
  // credential uses (see CredentialCardTypeLayouts.tsx's getCredentialLayout, wired up in
  // ConnectionCredentialsModal.tsx). Never set for an unverified/failed result. SSI-Agent
  // security-reviewed as safe to cache (display-only, no signing material, sourced
  // post-verification) but flagged as a point-in-time snapshot with no ongoing revocation check —
  // readers should apply a staleness cutoff against `identityVerifiedAt` (see connections.tsx's
  // PREVIEW_PHOTO_TTL_MS) rather than trusting it indefinitely.
  verifiedCredentialSubject?: Record<string, any>;
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
 * Record the outcome of a live identity verification round trip (see
 * utils/liveIdentityVerification.ts) for a connection, without risking clobbering unrelated
 * fields already stored for it.
 *
 * `updateConnectionMetadata()` merges but silently no-ops if no metadata record exists yet for
 * this `hostDID` — and `saveConnectionMetadata()` fully REPLACES whatever was there (it does not
 * merge). Some connection-establishment code paths (notably OOB.tsx's RFC 0434 branch) don't
 * call `saveConnectionMetadata()` at connection time at all, so there may be no existing record
 * to update. This helper picks the non-destructive option in both cases: merge if a record
 * exists, otherwise create a minimal new one (never overwriting fields it doesn't know about).
 *
 * @param hostDID    our own local peer DID for this connection (same key used elsewhere)
 * @param walletType only used if no metadata record exists yet and one must be created
 */
export function recordIdentityVerificationResult(
  hostDID: string,
  walletType: WalletType,
  patch: Pick<ConnectionMetadata, 'identityVerificationStatus'> &
    Partial<Pick<ConnectionMetadata, 'identityVerificationError' | 'identityVerifiedAt' | 'establishedWithVCProof' | 'vcProofType' | 'verifiedCredentialSubject'>>
): void {
  const existing = getConnectionMetadata(hostDID);
  if (existing) {
    updateConnectionMetadata(hostDID, patch);
  } else {
    saveConnectionMetadata(hostDID, { walletType, ...patch });
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
