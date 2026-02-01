/**
 * Prefixed localStorage Utility
 *
 * Ensures all localStorage keys are prefixed with wallet-specific prefix
 * to prevent data leakage between multiple wallet instances on the same domain.
 *
 * Issue: Without prefixes, Alice and Bob wallets on the same machine share
 * localStorage keys, causing data collisions and stale data after database cleanup.
 *
 * Solution: All localStorage operations MUST use this utility to ensure proper prefixing.
 */

// Get wallet storage prefix from configuration
function getStoragePrefix(): string {
  // IDL wallet configuration - must match app.ts getWalletConfig()
  return 'wallet-idl-';
}

/**
 * Get prefixed storage key
 * @param key - Unprefixed key (e.g., "invitation-123")
 * @returns Prefixed key (e.g., "wallet-idl-invitation-123")
 */
export function getPrefixedKey(key: string): string {
  const prefix = getStoragePrefix();
  return `${prefix}${key}`;
}

/**
 * Get item from localStorage with wallet prefix
 * Automatically parses JSON for objects/arrays
 */
export function getItem(key: string): any | null {
  const prefixedKey = getPrefixedKey(key);
  const value = localStorage.getItem(prefixedKey);

  if (value === null) {
    return null;
  }

  // Try to parse as JSON
  try {
    return JSON.parse(value);
  } catch (e) {
    // If not valid JSON, return as string
    return value;
  }
}

/**
 * Set item in localStorage with wallet prefix
 * Automatically stringifies objects/arrays
 */
export function setItem(key: string, value: any): void {
  const prefixedKey = getPrefixedKey(key);

  // Convert value to string (JSON for objects/arrays, direct for strings)
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

  localStorage.setItem(prefixedKey, stringValue);
}

/**
 * Remove item from localStorage with wallet prefix
 */
export function removeItem(key: string): void {
  const prefixedKey = getPrefixedKey(key);
  localStorage.removeItem(prefixedKey);
}

/**
 * Get all keys matching a pattern (with prefix)
 * @param pattern - Key pattern to match (e.g., "invitation-")
 * @returns Array of unprefixed keys that match the pattern
 */
export function getKeysByPattern(pattern: string): string[] {
  const prefix = getStoragePrefix();
  const prefixedPattern = `${prefix}${pattern}`;
  const matchingKeys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefixedPattern)) {
      // Return unprefixed key for convenience
      matchingKeys.push(key.substring(prefix.length));
    }
  }

  return matchingKeys;
}

/**
 * Clear all wallet-specific localStorage data
 * WARNING: This removes ALL data for this wallet!
 */
export function clearWalletStorage(): void {
  const prefix = getStoragePrefix();
  const keysToRemove: string[] = [];

  // Collect keys to remove
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }

  // Remove collected keys
  keysToRemove.forEach(key => localStorage.removeItem(key));

  console.log(`🧹 [PrefixedStorage] Cleared ${keysToRemove.length} wallet-specific localStorage keys`);
}

/**
 * CA (Certification Authority) Pinning - Trust On First Use (TOFU)
 */

export interface CAPinData {
  caDID: string;
  organizationName: string;
  website: string;
  jurisdiction: string;
  registrationNumber: string;
  credentialHash: string; // SHA-256 hash of credential JWT for verification
  pinnedAt: string; // ISO timestamp
  lastVerified: string; // ISO timestamp
}

const CA_PIN_KEY = 'ca-authority-pin';

/**
 * Check if CA is already pinned (TOFU)
 * @returns true if CA has been verified and pinned
 */
export function isCAVerified(): boolean {
  const pinData = getItem(CA_PIN_KEY);
  return pinData !== null;
}

/**
 * Get pinned CA data
 * @returns Pinned CA data or null if not pinned
 */
export function getPinnedCA(): CAPinData | null {
  const pinData = getItem(CA_PIN_KEY);
  if (!pinData) {
    return null;
  }

  try {
    return JSON.parse(pinData);
  } catch (error) {
    console.error('❌ [CA Pin] Failed to parse pinned CA data:', error);
    return null;
  }
}

/**
 * Pin CA identity (Trust On First Use)
 * @param caData - CA identity data to pin
 */
export function pinCA(caData: Omit<CAPinData, 'pinnedAt' | 'lastVerified'>): void {
  const pinData: CAPinData = {
    ...caData,
    pinnedAt: new Date().toISOString(),
    lastVerified: new Date().toISOString()
  };

  setItem(CA_PIN_KEY, JSON.stringify(pinData));
  console.log('📌 [CA Pin] CA identity pinned:', caData.organizationName);
}

/**
 * Verify CA DID matches pinned CA (detect MITM attacks)
 * @param caDID - DID to verify against pinned CA
 * @returns true if CA DID matches, false if mismatch (potential MITM)
 */
export function verifyPinnedCA(caDID: string): boolean {
  const pinned = getPinnedCA();

  if (!pinned) {
    console.warn('⚠️ [CA Pin] No CA pinned yet - first connection');
    return false;
  }

  const matches = pinned.caDID === caDID;

  if (!matches) {
    console.error('🚨 [CA Pin] CA DID MISMATCH - Potential MITM attack!');
    console.error('  Expected:', pinned.caDID);
    console.error('  Received:', caDID);
  } else {
    console.log('✅ [CA Pin] CA DID verified successfully');

    // Update last verified timestamp
    pinned.lastVerified = new Date().toISOString();
    setItem(CA_PIN_KEY, JSON.stringify(pinned));
  }

  return matches;
}

/**
 * Clear pinned CA (use with caution!)
 */
export function clearPinnedCA(): void {
  removeItem(CA_PIN_KEY);
  console.log('🗑️ [CA Pin] Cleared pinned CA identity');
}

/**
 * Hash credential JWT for verification (simple SHA-256)
 * @param credentialJWT - JWT credential string
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashCredential(credentialJWT: string): Promise<string> {
  // Use Web Crypto API for SHA-256 hashing
  const encoder = new TextEncoder();
  const data = encoder.encode(credentialJWT);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Company Pinning - Trust On First Use (TOFU)
 */

export interface CompanyPinData {
  companyDID: string;
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
  credentialHash: string; // SHA-256 hash of credential JWT for verification
  pinnedAt: string; // ISO timestamp
  lastVerified: string; // ISO timestamp
}

const COMPANY_PIN_KEY = 'company-identity-pin';

/**
 * Check if company is already pinned (TOFU)
 * @returns true if company has been verified and pinned
 */
export function isCompanyVerified(): boolean {
  const pinData = getItem(COMPANY_PIN_KEY);
  return pinData !== null;
}

/**
 * Get pinned company data
 * @returns Pinned company data or null if not pinned
 */
export function getPinnedCompany(): CompanyPinData | null {
  const pinData = getItem(COMPANY_PIN_KEY);
  if (!pinData) {
    return null;
  }

  try {
    return JSON.parse(pinData);
  } catch (error) {
    console.error('❌ [Company Pin] Failed to parse pinned company data:', error);
    return null;
  }
}

/**
 * Pin company identity (Trust On First Use)
 * @param companyData - Company identity data to pin
 */
export function pinCompany(companyData: Omit<CompanyPinData, 'pinnedAt' | 'lastVerified'>): void {
  const pinData: CompanyPinData = {
    ...companyData,
    pinnedAt: new Date().toISOString(),
    lastVerified: new Date().toISOString()
  };

  setItem(COMPANY_PIN_KEY, JSON.stringify(pinData));
  console.log('📌 [Company Pin] Company identity pinned:', companyData.companyName);
}

/**
 * Verify company DID matches pinned company (detect MITM attacks)
 * @param companyDID - DID to verify against pinned company
 * @returns true if company DID matches, false if mismatch (potential MITM)
 */
export function verifyPinnedCompany(companyDID: string): boolean {
  const pinned = getPinnedCompany();

  if (!pinned) {
    console.warn('⚠️ [Company Pin] No company pinned yet - first connection');
    return false;
  }

  const matches = pinned.companyDID === companyDID;

  if (!matches) {
    console.error('🚨 [Company Pin] Company DID MISMATCH - Potential MITM attack!');
    console.error('  Expected:', pinned.companyDID);
    console.error('  Received:', companyDID);
  } else {
    console.log('✅ [Company Pin] Company DID verified successfully');

    // Update last verified timestamp
    pinned.lastVerified = new Date().toISOString();
    setItem(COMPANY_PIN_KEY, JSON.stringify(pinned));
  }

  return matches;
}

/**
 * Clear pinned company (use with caution!)
 */
export function clearPinnedCompany(): void {
  removeItem(COMPANY_PIN_KEY);
  console.log('🗑️ [Company Pin] Cleared pinned company identity');
}
