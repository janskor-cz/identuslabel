// Security Key Storage Utilities for Ed25519-based Security Clearance VCs

import { SecurityKey, SecurityKeyStorage, SecurityKeyExport } from '../types/securityKeys';
import * as jose from 'jose';
import { sha256 } from '@noble/hashes/sha256';
import { getItem, setItem, removeItem } from './prefixedStorage';

const STORAGE_KEY = 'security-clearance-keys';

/**
 * Generate a fingerprint from a public key (SHA256 hash formatted as XX:XX:XX...)
 */
export function generateFingerprint(publicKeyBytes: string): string {
  try {
    // Decode base64url to bytes
    const keyBytes = jose.base64url.decode(publicKeyBytes);

    // Use @noble/hashes for SHA256 (works in HTTP and HTTPS)
    const hashBytes = sha256(keyBytes);
    const hashArray = Array.from(hashBytes);

    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

    // Format as XX:XX:XX:XX...
    return hash.match(/.{2}/g)?.join(':') || hash;
  } catch (error) {
    console.error('Error generating fingerprint:', error);
    // Fallback to simple hash
    return `SHA256:${publicKeyBytes.substring(0, 16)}...`;
  }
}

/**
 * Generate a unique key ID
 */
export function generateKeyId(): string {
  return `sec-key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Load security keys from localStorage
 */
export function loadSecurityKeys(): SecurityKeyStorage {
  try {
    const stored = getItem(STORAGE_KEY);
    if (stored) {
      // getItem() already parses JSON, so just return the object directly
      return stored as SecurityKeyStorage;
    }
  } catch (error) {
    console.error('Failed to load security keys:', error);
  }

  return { keys: [] };
}

/**
 * Save security keys to localStorage
 */
export function saveSecurityKeys(storage: SecurityKeyStorage): void {
  try {
    // setItem() already stringifies objects, so pass the object directly
    setItem(STORAGE_KEY, storage);
  } catch (error) {
    console.error('Failed to save security keys:', error);
  }
}

/**
 * Add a new security key to storage (LEGACY - for backward compatibility)
 * Use addSecurityKeyDual() for new dual-key credentials
 */
export async function addSecurityKey(
  privateKeyBytes: string,
  publicKeyBytes: string,
  label?: string
): Promise<SecurityKey> {
  const storage = loadSecurityKeys();

  const newKey: SecurityKey = {
    keyId: generateKeyId(),
    privateKeyBytes,
    publicKeyBytes,
    fingerprint: generateFingerprint(publicKeyBytes),
    curve: 'Ed25519',
    purpose: 'security-clearance',
    label: label || `Security Key ${storage.keys.length + 1}`,
    createdAt: new Date().toISOString(),
    usageCount: 0
  };

  storage.keys.push(newKey);

  // Set as active if it's the first key
  if (storage.keys.length === 1) {
    storage.activeKeyId = newKey.keyId;
  }

  saveSecurityKeys(storage);
  return newKey;
}

/**
 * Add a new dual-key (Ed25519 + X25519) security key to storage
 * This is the NEW recommended method for security clearance credentials
 */
export async function addSecurityKeyDual(
  ed25519PrivateKey: string,
  ed25519PublicKey: string,
  ed25519Fingerprint: string,
  x25519PrivateKey: string,
  x25519PublicKey: string,
  x25519Fingerprint: string,
  label?: string
): Promise<import('../types/securityKeys').SecurityKeyDual> {
  const storage = loadSecurityKeys();

  const newKey: import('../types/securityKeys').SecurityKeyDual = {
    keyId: generateKeyId(),
    ed25519: {
      privateKeyBytes: ed25519PrivateKey,
      publicKeyBytes: ed25519PublicKey,
      fingerprint: ed25519Fingerprint,
      curve: 'Ed25519',
      purpose: 'signing'
    },
    x25519: {
      privateKeyBytes: x25519PrivateKey,
      publicKeyBytes: x25519PublicKey,
      fingerprint: x25519Fingerprint,
      curve: 'X25519',
      purpose: 'encryption'
    },
    label: label || `Security Key ${storage.keys.length + 1}`,
    createdAt: new Date().toISOString(),
    usageCount: 0
  };

  storage.keys.push(newKey);
  storage.version = '2.0'; // Mark storage as using dual-key format

  // Set as active if it's the first key
  if (storage.keys.length === 1) {
    storage.activeKeyId = newKey.keyId;
  }

  saveSecurityKeys(storage);
  return newKey;
}

/**
 * Get a security key by ID
 */
export function getSecurityKey(keyId: string): SecurityKey | undefined {
  const storage = loadSecurityKeys();
  return storage.keys.find(key => key.keyId === keyId);
}

/**
 * Get the active security key
 */
export function getActiveSecurityKey(): SecurityKey | undefined {
  const storage = loadSecurityKeys();
  if (!storage.activeKeyId) {
    return storage.keys[0]; // Return first key if no active key set
  }
  return storage.keys.find(key => key.keyId === storage.activeKeyId);
}

/**
 * Set the active security key
 */
export function setActiveSecurityKey(keyId: string): void {
  const storage = loadSecurityKeys();
  if (storage.keys.some(key => key.keyId === keyId)) {
    storage.activeKeyId = keyId;
    saveSecurityKeys(storage);
  }
}

/**
 * Delete a security key
 */
export function deleteSecurityKey(keyId: string): void {
  const storage = loadSecurityKeys();
  storage.keys = storage.keys.filter(key => key.keyId !== keyId);

  // If we deleted the active key, set a new one
  if (storage.activeKeyId === keyId) {
    storage.activeKeyId = storage.keys[0]?.keyId;
  }

  saveSecurityKeys(storage);
}

/**
 * Export a public key for submission to CA
 * Handles both legacy single-key and dual-key formats
 */
export function exportPublicKey(keyId: string): import('../types/securityKeys').SecurityKeyExport | undefined {
  const key = getSecurityKey(keyId);
  if (!key) return undefined;

  // Check if this is a dual-key using type guard
  const isDual = 'ed25519' in key && 'x25519' in key;

  if (isDual) {
    // Export dual-key format
    const dualKey = key as import('../types/securityKeys').SecurityKeyDual;
    return {
      ed25519PublicKey: dualKey.ed25519.publicKeyBytes,
      ed25519Fingerprint: dualKey.ed25519.fingerprint,
      x25519PublicKey: dualKey.x25519.publicKeyBytes,
      x25519Fingerprint: dualKey.x25519.fingerprint,
      createdAt: dualKey.createdAt,
      keyId: dualKey.keyId
    } as import('../types/securityKeys').SecurityKeyExportDual;
  } else {
    // Export legacy format
    const legacyKey = key as import('../types/securityKeys').SecurityKeyLegacy;
    return {
      publicKeyBytes: legacyKey.publicKeyBytes,
      fingerprint: legacyKey.fingerprint,
      algorithm: 'Ed25519',
      createdAt: legacyKey.createdAt,
      keyId: legacyKey.keyId
    } as import('../types/securityKeys').SecurityKeyExportLegacy;
  }
}

/**
 * Update key usage statistics
 */
export function updateKeyUsage(keyId: string): void {
  const storage = loadSecurityKeys();
  const key = storage.keys.find(k => k.keyId === keyId);

  if (key) {
    key.usageCount++;
    key.lastUsedAt = new Date().toISOString();
    saveSecurityKeys(storage);
  }
}

/**
 * Check if a key has expired
 */
export function isKeyExpired(key: SecurityKey): boolean {
  if (!key.expiresAt) return false;
  return new Date(key.expiresAt) < new Date();
}

/**
 * Get all valid (non-expired) keys
 */
export function getValidKeys(): SecurityKey[] {
  const storage = loadSecurityKeys();
  return storage.keys.filter(key => !isKeyExpired(key));
}

/**
 * Clear all security keys (use with caution!)
 */
export function clearAllKeys(): void {
  removeItem(STORAGE_KEY);
}

/**
 * Get Security Clearance keys in flat format for encryption/decryption
 *
 * This function provides backward compatibility for code that expects
 * flat key properties (x25519PrivateKey, x25519PublicKey, etc.)
 *
 * @param connectionDID - Optional connection DID (currently unused, for future filtering)
 * @returns Object with flat key properties or null if no active key
 */
export function getSecurityClearanceKeys(connectionDID?: string): {
  x25519PrivateKey: string;
  x25519PublicKey: string;
  x25519Fingerprint: string;
  ed25519PrivateKey?: string;
  ed25519PublicKey?: string;
  ed25519Fingerprint?: string;
} | null {
  const activeKey = getActiveSecurityKey();

  if (!activeKey) {
    return null;
  }

  // Handle dual-key structure (new format)
  if ('x25519' in activeKey && 'ed25519' in activeKey) {
    return {
      x25519PrivateKey: activeKey.x25519.privateKeyBytes,
      x25519PublicKey: activeKey.x25519.publicKeyBytes,
      x25519Fingerprint: activeKey.x25519.fingerprint,
      ed25519PrivateKey: activeKey.ed25519.privateKeyBytes,
      ed25519PublicKey: activeKey.ed25519.publicKeyBytes,
      ed25519Fingerprint: activeKey.ed25519.fingerprint
    };
  }

  // Handle legacy single-key structure (old format)
  // This shouldn't have X25519 keys, but return null gracefully
  return null;
}