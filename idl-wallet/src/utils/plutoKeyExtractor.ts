/**
 * Pluto Key Extractor Utility
 *
 * Extracts Ed25519/X25519 keys from PRISM DIDs stored in Pluto (IndexedDB).
 * This provides a fallback mechanism when keys cannot be found in localStorage
 * (e.g., when Security Clearance VCs are issued using keys from PRISM DIDs).
 *
 * @module plutoKeyExtractor
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';
import { sha256 } from '@noble/hashes/sha256';
import * as jose from 'jose';
import { SecurityKeyDual, KeyComponent } from '../types/securityKeys';

/**
 * Structure for extracted keys from Pluto
 */
export interface PlutoExtractedKeys {
  ed25519?: KeyComponent;
  x25519?: KeyComponent;
  prismDID: string;
}

/**
 * Generate fingerprint from public key bytes
 * Format: uppercase hex pairs separated by colons (e.g., "AB:CD:EF:...")
 *
 * @param publicKeyBytes - Raw public key bytes (Uint8Array)
 * @returns Fingerprint string
 */
function generateFingerprintFromBytes(publicKeyBytes: Uint8Array): string {
  const hashBytes = sha256(publicKeyBytes);
  const hashArray = Array.from(hashBytes);
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hash.match(/.{2}/g)?.join(':') || hash;
}

/**
 * Convert Uint8Array to base64url string
 *
 * @param bytes - Raw bytes
 * @returns Base64url encoded string
 */
function bytesToBase64url(bytes: Uint8Array): string {
  return jose.base64url.encode(bytes);
}

/**
 * Extract Ed25519 and X25519 keys from a PRISM DID stored in Pluto
 *
 * When a PRISM DID is created via `createLongFormPrismDID`, the SDK stores:
 * - masterKey (SECP256K1 - for DID operations)
 * - ed25519Key (Ed25519 - for authentication/signing)
 * - x25519Key (X25519 - for key agreement/encryption)
 *
 * This function retrieves those keys and formats them for security operations.
 *
 * @param agent - SDK Agent instance (must be started)
 * @param prismDID - PRISM DID string (long-form or short-form)
 * @returns Promise<PlutoExtractedKeys | null> - Extracted keys or null if not found
 *
 * @example
 * const keys = await extractKeysFromPrismDID(agent, 'did:prism:abc123...');
 * if (keys?.x25519) {
 *   // Use x25519 key for encryption
 *   const fingerprint = keys.x25519.fingerprint;
 * }
 */
export async function extractKeysFromPrismDID(
  agent: SDK.Agent,
  prismDID: string
): Promise<PlutoExtractedKeys | null> {
  try {
    console.log(`🔍 [PlutoKeyExtractor] Extracting keys for PRISM DID: ${prismDID.substring(0, 50)}...`);

    // Convert string to SDK DID object
    const did = SDK.Domain.DID.fromString(prismDID);

    // Get private keys from Pluto
    const privateKeys = await agent.pluto.getDIDPrivateKeysByDID(did);

    if (!privateKeys || privateKeys.length === 0) {
      console.warn(`⚠️ [PlutoKeyExtractor] No private keys found for DID: ${prismDID.substring(0, 50)}...`);
      return null;
    }

    console.log(`📦 [PlutoKeyExtractor] Found ${privateKeys.length} private keys for DID`);

    const result: PlutoExtractedKeys = {
      prismDID: prismDID
    };

    // Process each private key
    for (const privateKey of privateKeys) {
      const curve = privateKey.curve?.toLowerCase();
      console.log(`  → Key curve: ${curve}`);

      if (curve === 'ed25519') {
        try {
          const publicKey = privateKey.publicKey();
          const publicKeyBytes = publicKey.raw;
          const privateKeyBytes = privateKey.raw;

          result.ed25519 = {
            privateKeyBytes: bytesToBase64url(privateKeyBytes),
            publicKeyBytes: bytesToBase64url(publicKeyBytes),
            fingerprint: generateFingerprintFromBytes(publicKeyBytes),
            curve: 'Ed25519',
            purpose: 'signing'
          };

          console.log(`  ✅ Ed25519 key extracted, fingerprint: ${result.ed25519.fingerprint.substring(0, 20)}...`);
        } catch (err) {
          console.error('  ❌ Error extracting Ed25519 key:', err);
        }
      } else if (curve === 'x25519') {
        try {
          const publicKey = privateKey.publicKey();
          const publicKeyBytes = publicKey.raw;
          const privateKeyBytes = privateKey.raw;

          result.x25519 = {
            privateKeyBytes: bytesToBase64url(privateKeyBytes),
            publicKeyBytes: bytesToBase64url(publicKeyBytes),
            fingerprint: generateFingerprintFromBytes(publicKeyBytes),
            curve: 'X25519',
            purpose: 'encryption'
          };

          console.log(`  ✅ X25519 key extracted, fingerprint: ${result.x25519.fingerprint.substring(0, 20)}...`);
        } catch (err) {
          console.error('  ❌ Error extracting X25519 key:', err);
        }
      }
    }

    // Check if we found any useful keys
    if (!result.ed25519 && !result.x25519) {
      console.warn(`⚠️ [PlutoKeyExtractor] No Ed25519/X25519 keys found in PRISM DID`);
      return null;
    }

    console.log(`✅ [PlutoKeyExtractor] Successfully extracted keys from PRISM DID`);
    return result;

  } catch (error: any) {
    console.error(`❌ [PlutoKeyExtractor] Error extracting keys from PRISM DID:`, error);
    return null;
  }
}

/**
 * Find a key by fingerprint across all PRISM DIDs stored in Pluto
 *
 * This is a more comprehensive search that checks all PRISM DIDs
 * when the specific DID is unknown.
 *
 * @param agent - SDK Agent instance
 * @param targetFingerprint - Fingerprint to search for
 * @returns Promise<KeyComponent | null> - Matching key or null
 */
export async function findKeyByFingerprintInPluto(
  agent: SDK.Agent,
  targetFingerprint: string
): Promise<{ key: KeyComponent; prismDID: string } | null> {
  try {
    console.log(`🔍 [PlutoKeyExtractor] Searching all PRISM DIDs for fingerprint: ${targetFingerprint.substring(0, 20)}...`);

    // Get all PRISM DIDs from Pluto
    const prismDIDs = await agent.pluto.getAllPrismDIDs();

    if (!prismDIDs || prismDIDs.length === 0) {
      console.warn(`⚠️ [PlutoKeyExtractor] No PRISM DIDs found in Pluto`);
      return null;
    }

    console.log(`📦 [PlutoKeyExtractor] Checking ${prismDIDs.length} PRISM DIDs...`);

    // Check each PRISM DID
    for (const prismDID of prismDIDs) {
      const didString = prismDID.did.toString();
      const keys = await extractKeysFromPrismDID(agent, didString);

      if (keys) {
        // Check Ed25519 key
        if (keys.ed25519 && keys.ed25519.fingerprint === targetFingerprint) {
          console.log(`✅ [PlutoKeyExtractor] Found matching Ed25519 key in DID: ${didString.substring(0, 50)}...`);
          return { key: keys.ed25519, prismDID: didString };
        }

        // Check X25519 key
        if (keys.x25519 && keys.x25519.fingerprint === targetFingerprint) {
          console.log(`✅ [PlutoKeyExtractor] Found matching X25519 key in DID: ${didString.substring(0, 50)}...`);
          return { key: keys.x25519, prismDID: didString };
        }
      }
    }

    console.warn(`⚠️ [PlutoKeyExtractor] No key found matching fingerprint across all PRISM DIDs`);
    return null;

  } catch (error: any) {
    console.error(`❌ [PlutoKeyExtractor] Error searching Pluto for fingerprint:`, error);
    return null;
  }
}

/**
 * Extract the first Ed25519 key found across all Peer DIDs stored in Pluto.
 *
 * When `agent.createNewPeerDID()` runs, the SDK stores the peer DID's Ed25519
 * private key in local Pluto via `StorePeerDID()`. This function retrieves it
 * so the documents page can use a DID-bound signing key even when no PRISM DID
 * keys exist locally (PRISM DID private keys live in the Cloud Agent, not Pluto).
 *
 * @param agent - SDK Agent instance (must be started)
 * @returns Promise with raw key bytes + peer DID string, or null if not found
 */
export async function extractEd25519FromPeerDIDs(
  agent: SDK.Agent
): Promise<{ privateKeyBytes: Uint8Array; publicKeyBytes: Uint8Array; peerDID: string } | null> {
  try {
    console.log('[PlutoKeyExtractor] Searching peer DIDs for Ed25519 key...');

    const peerDIDs = await agent.pluto.getAllPeerDIDs();
    if (!peerDIDs || peerDIDs.length === 0) {
      console.warn('[PlutoKeyExtractor] No peer DIDs found in Pluto');
      return null;
    }

    console.log(`[PlutoKeyExtractor] Checking ${peerDIDs.length} peer DID(s)...`);

    for (const peerDID of peerDIDs) {
      const did = peerDID.did ?? peerDID;
      const privateKeys = await agent.pluto.getDIDPrivateKeysByDID(did);

      if (!privateKeys || privateKeys.length === 0) continue;

      for (const privateKey of privateKeys) {
        if (privateKey.curve?.toLowerCase() === 'ed25519') {
          const publicKey = privateKey.publicKey();
          console.log(`[PlutoKeyExtractor] Found Ed25519 key in peer DID: ${did.toString().substring(0, 50)}...`);
          return {
            privateKeyBytes: privateKey.raw,
            publicKeyBytes: publicKey.raw,
            peerDID: did.toString()
          };
        }
      }
    }

    console.warn('[PlutoKeyExtractor] No Ed25519 key found in any peer DID');
    return null;

  } catch (error: any) {
    console.error('[PlutoKeyExtractor] Error searching peer DIDs for Ed25519 key:', error);
    return null;
  }
}

/**
 * Convert Pluto extracted keys to SecurityKeyDual format
 *
 * This allows keys from Pluto to be used seamlessly with the existing
 * security key infrastructure.
 *
 * @param plutoKeys - Keys extracted from Pluto
 * @returns SecurityKeyDual | null
 */
export function plutoKeysToSecurityKeyDual(plutoKeys: PlutoExtractedKeys): SecurityKeyDual | null {
  if (!plutoKeys.ed25519 || !plutoKeys.x25519) {
    console.warn(`⚠️ [PlutoKeyExtractor] Cannot convert to SecurityKeyDual - missing keys`);
    return null;
  }

  return {
    keyId: `pluto-${plutoKeys.prismDID.substring(0, 20)}`,
    ed25519: plutoKeys.ed25519,
    x25519: plutoKeys.x25519,
    label: `PRISM DID Key`,
    createdAt: new Date().toISOString(),
    usageCount: 0
  };
}
