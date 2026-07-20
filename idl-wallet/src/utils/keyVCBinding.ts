/**
 * Key-VC Binding Verification
 *
 * Ensures that encryption keys are cryptographically bound to Security Clearance
 * Verifiable Credentials via public key fingerprinting.
 */

import { SecurityKey, SecurityKeyStorage, SecurityKeyDual } from '../types/securityKeys';
import { loadSecurityKeys } from './securityKeyStorage';
import { SecurityLevel, parseSecurityLevel } from './securityLevels';
import { extractKeysFromPrismDID, plutoKeysToSecurityKeyDual, findKeyByFingerprintInPluto } from './plutoKeyExtractor';
import SDK from '@hyperledger/identus-edge-agent-sdk';

/**
 * Trusted Security Clearance VC issuer.
 * Only VCs signed by this DID will be accepted as legitimate Security Clearance VCs.
 */
const TRUSTED_CA_DID = "did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c";

/**
 * Validate that a VC is a legitimate Security Clearance VC from a trusted issuer.
 *
 * This prevents accepting malicious Security Clearance VCs from untrusted sources.
 * All three conditions must be met:
 * 1. VC schema matches the Security Clearance schema
 * 2. VC issuer is the trusted Certification Authority
 * 3. VC contains a clearanceLevel claim
 *
 * @param vc - Verifiable Credential to validate
 * @returns true if VC is a valid Security Clearance VC, false otherwise
 *
 * @example
 * const vc = credentials[0];
 * if (validateSecurityClearanceVC(vc)) {
 *   const level = getVCClearanceLevel(vc);
 *   // Safe to use clearance level
 * } else {
 *   console.error('Untrusted or malformed VC - rejected');
 * }
 */
export function validateSecurityClearanceVC(vc: any): boolean {
  if (!vc) {
    console.warn('⚠️ [validateSecurityClearanceVC] VC is null or undefined');
    return false;
  }

  // Check 1: Verify VC has a credentialSchema (basic structure check).
  // We deliberately do NOT match schema.id against a hardcoded URL: the CA's schema
  // registry host/UUID has changed before (e.g. IP-based -> identuslabel.cz) and will
  // again, and a hardcoded match silently breaks every legitimately-issued credential
  // when that happens (confirmed live: a real, correctly-signed, correctly-issued VC
  // was rejected here after the CA moved its schema registry to a new domain/UUID).
  // Trust is anchored on the CA issuer DID (Check 2) plus the semantic credentialType
  // claim (below), not on a specific schema URL.
  let schema = vc.credentialSchema?.[0];

  // Try W3C VC structure inside JWT if not found at top level
  if (!schema && vc.vc?.credentialSchema?.[0]) {
    schema = vc.vc.credentialSchema[0];
    console.log('✅ [validateSecurityClearanceVC] Found schema via vc.vc.credentialSchema');
  }

  if (!schema) {
    console.warn('⚠️ [validateSecurityClearanceVC] VC has no credentialSchema');
    return false;
  }
  console.log('✅ [validateSecurityClearanceVC] VC schema present:', schema.id);

  // Check 1b: Verify credentialType claim identifies this specifically as a Security
  // Clearance credential (same field/locations used by credentialTypeDetector.ts
  // elsewhere in this codebase), rather than any other CA-issued credential type that
  // happens to also carry a clearanceLevel-shaped claim.
  let credentialType = vc.credentialSubject?.credentialType;
  if (!credentialType && vc.claims && vc.claims.length > 0) {
    credentialType = vc.claims[0]?.credentialType;
  }
  if (!credentialType && vc.vc?.credentialSubject?.credentialType) {
    credentialType = vc.vc.credentialSubject.credentialType;
  }
  if (credentialType !== 'SecurityClearance') {
    console.warn('⚠️ [validateSecurityClearanceVC] credentialType is not SecurityClearance', {
      actual: credentialType || 'none'
    });
    return false;
  }

  // Check 2: Verify issuer is trusted CA
  // JWT credentials can store issuer in multiple locations:
  // 1. vc.iss (top-level JWT property)
  // 2. vc.properties.get('iss') (SDK properties Map)
  // 3. vc.vc.issuer (W3C VC structure inside JWT)
  let issuer = vc.issuer?.id || vc.iss;

  // Try SDK properties Map if direct access failed
  if (!issuer && vc.properties && typeof vc.properties.get === 'function') {
    issuer = vc.properties.get('iss');
    if (issuer) {
      console.log('✅ [validateSecurityClearanceVC] Found issuer via vc.properties.get("iss")');
    }
  }

  // Try W3C VC structure inside JWT
  if (!issuer && vc.vc?.issuer) {
    issuer = typeof vc.vc.issuer === 'string' ? vc.vc.issuer : vc.vc.issuer.id;
    if (issuer) {
      console.log('✅ [validateSecurityClearanceVC] Found issuer via vc.vc.issuer');
    }
  }

  if (issuer !== TRUSTED_CA_DID) {
    console.warn('⚠️ [validateSecurityClearanceVC] Untrusted issuer', {
      expected: TRUSTED_CA_DID,
      actual: issuer || 'none',
      vcStructure: {
        hasIss: !!vc.iss,
        hasIssuer: !!vc.issuer,
        hasProperties: !!vc.properties,
        hasVcIssuer: !!(vc.vc && vc.vc.issuer)
      }
    });
    return false;
  }

  // Check 3: Verify clearanceLevel claim exists
  // 🔇 DEBUG-VC-STRUCTURE logs temporarily hidden for readability
  // console.log('🔍 [DEBUG-VC-STRUCTURE] ========== INSPECTING VC FOR CLEARANCE LEVEL ==========');
  // console.log('🔍 [DEBUG-VC-STRUCTURE] VC top-level keys:', Object.keys(vc));
  // console.log('🔍 [DEBUG-VC-STRUCTURE] credentialSubject:', JSON.stringify(vc.credentialSubject, null, 2));
  // console.log('🔍 [DEBUG-VC-STRUCTURE] claims:', vc.claims);
  // console.log('🔍 [DEBUG-VC-STRUCTURE] subject:', vc.subject);

  // Try to find clearanceLevel in vc.vc (W3C VC structure inside JWT)
  // if (vc.vc) {
  //   console.log('🔍 [DEBUG-VC-STRUCTURE] vc.vc exists - checking nested structure');
  //   console.log('🔍 [DEBUG-VC-STRUCTURE] vc.vc.credentialSubject:', JSON.stringify(vc.vc.credentialSubject, null, 2));
  // }

  let hasClearanceLevel = false;

  // Try credentialSubject (standard JWT structure)
  if (vc.credentialSubject?.clearanceLevel) {
    // console.log('✅ [DEBUG-VC-STRUCTURE] Found clearanceLevel in vc.credentialSubject.clearanceLevel');
    hasClearanceLevel = true;
  }

  // Try claims array (Edge Agent SDK structure)
  if (!hasClearanceLevel && vc.claims && vc.claims.length > 0) {
    // console.log('🔍 [DEBUG-VC-STRUCTURE] Checking claims[0]:', JSON.stringify(vc.claims[0], null, 2));
    if (vc.claims[0]?.clearanceLevel) {
      // console.log('✅ [DEBUG-VC-STRUCTURE] Found clearanceLevel in vc.claims[0].clearanceLevel');
      hasClearanceLevel = true;
    }
  }

  // Try W3C VC structure inside JWT
  if (!hasClearanceLevel && vc.vc?.credentialSubject?.clearanceLevel) {
    // console.log('✅ [DEBUG-VC-STRUCTURE] Found clearanceLevel in vc.vc.credentialSubject.clearanceLevel');
    hasClearanceLevel = true;
  }

  // console.log('🔍 [DEBUG-VC-STRUCTURE] hasClearanceLevel:', hasClearanceLevel);
  // console.log('🔍 [DEBUG-VC-STRUCTURE] ========================================');

  if (!hasClearanceLevel) {
    console.warn('⚠️ [validateSecurityClearanceVC] Missing clearanceLevel claim');
    return false;
  }

  console.log('✅ [validateSecurityClearanceVC] Valid Security Clearance VC from trusted CA');
  return true;
}

/**
 * Verify that a security key is bound to a Security Clearance VC
 * by comparing fingerprints.
 *
 * The VC contains a keyFingerprint field that must match the fingerprint
 * of the stored private key. This ensures the key was generated by the
 * user and is legitimately associated with the VC.
 *
 * @param securityKey - The security key from localStorage
 * @param securityClearanceVC - The Security Clearance Verifiable Credential
 * @returns true if fingerprints match, false otherwise
 *
 * @example
 * const key = getSecurityKeyByFingerprint("AB:CD:EF:...");
 * const vc = credentials.find(c => c.type.includes('SecurityClearanceCredential'));
 * if (verifyKeyVCBinding(key, vc)) {
 *   // Key is bound to VC - safe to use for encryption
 * }
 */
export function verifyKeyVCBinding(
  securityKey: SecurityKey,
  securityClearanceVC: any
): boolean {
  const subject = securityClearanceVC.credentialSubject || securityClearanceVC.subject;

  // Check if this is a dual-key structure
  const isDualKey = 'x25519' in securityKey;

  if (isDualKey) {
    // v3.0.0: Check X25519 fingerprint
    let vcX25519Fingerprint = subject?.x25519Fingerprint;

    // Try claims array for X25519 fingerprint
    if (!vcX25519Fingerprint && securityClearanceVC.claims && securityClearanceVC.claims.length > 0) {
      vcX25519Fingerprint = securityClearanceVC.claims[0]?.x25519Fingerprint;
    }

    if (!vcX25519Fingerprint) {
      console.error('❌ [keyVCBinding] v3.0.0 VC missing x25519Fingerprint');
      return false;
    }

    const keyX25519Fingerprint = (securityKey as any).x25519.fingerprint;
    if (keyX25519Fingerprint !== vcX25519Fingerprint) {
      console.error('❌ [keyVCBinding] X25519 fingerprint mismatch', {
        keyFingerprint: keyX25519Fingerprint,
        vcFingerprint: vcX25519Fingerprint
      });
      return false;
    }

    console.log('✅ [keyVCBinding] Key-VC binding verified (v3.0.0 dual-key)', {
      x25519Fingerprint: vcX25519Fingerprint.substring(0, 20) + '...'
    });
    return true;

  } else {
    // Legacy: Check old keyFingerprint field
    let vcFingerprint = subject?.keyFingerprint;

    if (!vcFingerprint && securityClearanceVC.claims && securityClearanceVC.claims.length > 0) {
      vcFingerprint = securityClearanceVC.claims[0]?.keyFingerprint;
    }

    if (!vcFingerprint) {
      console.error('❌ [keyVCBinding] Legacy VC missing keyFingerprint');
      return false;
    }

    if ((securityKey as any).fingerprint !== vcFingerprint) {
      console.error('❌ [keyVCBinding] Legacy fingerprint mismatch', {
        keyFingerprint: (securityKey as any).fingerprint,
        vcFingerprint: vcFingerprint
      });
      return false;
    }

    console.log('✅ [keyVCBinding] Key-VC binding verified (legacy single-key)', {
      fingerprint: vcFingerprint.substring(0, 20) + '...'
    });
    return true;
  }
}

/**
 * Extract the clearance level from a Security Clearance VC
 *
 * @param vc - Security Clearance Verifiable Credential
 * @returns SecurityLevel enum value
 *
 * @example
 * const vc = credentials.find(c => c.type.includes('SecurityClearanceCredential'));
 * const level = getVCClearanceLevel(vc);
 * // SecurityLevel.RESTRICTED
 */
export function getVCClearanceLevel(vc: any): SecurityLevel {
  if (!vc) {
    console.warn('⚠️ [keyVCBinding] No VC provided, defaulting to INTERNAL');
    return SecurityLevel.INTERNAL;
  }

  // Try credentialSubject first (standard JWT structure)
  let clearanceLevelStr = vc.credentialSubject?.clearanceLevel;

  // Try claims array (Edge Agent SDK structure)
  if (!clearanceLevelStr && vc.claims && vc.claims.length > 0) {
    clearanceLevelStr = vc.claims[0]?.clearanceLevel;
  }

  if (!clearanceLevelStr) {
    console.warn('⚠️ [keyVCBinding] VC missing clearanceLevel, defaulting to INTERNAL');
    return SecurityLevel.INTERNAL;
  }

  return parseSecurityLevel(clearanceLevelStr);
}

/**
 * Retrieve a security key from localStorage by its fingerprint (synchronous fast-path).
 *
 * Intentionally kept as a synchronous first check ahead of getSecurityKeyByFingerprintAsync:
 * it avoids an unawaited Pluto DID enumeration on the common case where the key is
 * already cached in localStorage. Not deprecated - both are meant to be used together.
 * @param fingerprint - Public key fingerprint (format: "AB:CD:EF:...")
 * @returns SecurityKey if found, undefined otherwise
 */
export function getSecurityKeyByFingerprint(fingerprint: string): SecurityKey | undefined {
  const storage: SecurityKeyStorage = loadSecurityKeys();

  const key = storage.keys.find(k => {
    // Check legacy single-key format
    if ('fingerprint' in k) {
      return (k as any).fingerprint === fingerprint;
    }
    // Check dual-key format (v3.0.0) - search both ed25519 and x25519 fingerprints
    if ('ed25519' in k && 'x25519' in k) {
      const dualKey = k as any;
      return dualKey.ed25519.fingerprint === fingerprint ||
             dualKey.x25519.fingerprint === fingerprint;
    }
    return false;
  });

  if (!key) {
    console.warn(`⚠️ [keyVCBinding] No security key found in localStorage for fingerprint: ${fingerprint.substring(0, 20)}...`);
    return undefined;
  }

  console.log('✅ [keyVCBinding] Security key retrieved from localStorage', {
    keyId: key.keyId,
    fingerprint: fingerprint.substring(0, 20) + '...'
  });

  return key;
}

/**
 * Retrieve a security key by its fingerprint with Pluto fallback
 *
 * This is used to find the private key that corresponds to a public key
 * fingerprint embedded in a Security Clearance VC.
 *
 * Lookup order:
 * 1. First tries localStorage (SecurityClearanceKeyManager generated keys)
 * 2. If not found AND agent provided:
 *    - Searches ALL PRISM DIDs in Pluto (IndexedDB)
 *    - Matches fingerprint against PRISM DID keys
 *    - Returns full SecurityKeyDual with both ed25519 and x25519 keys
 *
 * @param fingerprint - Public key fingerprint (format: "AB:CD:EF:...")
 * @param agent - Optional SDK Agent instance (enables Pluto fallback)
 * @returns Promise<SecurityKey | undefined>
 *
 * @example
 * // Without Pluto fallback (legacy behavior)
 * const key = await getSecurityKeyByFingerprintAsync(fingerprint);
 *
 * // With Pluto fallback (for PRISM DID-issued VCs)
 * const key = await getSecurityKeyByFingerprintAsync(fingerprint, agent);
 */
export async function getSecurityKeyByFingerprintAsync(
  fingerprint: string,
  agent?: SDK.Agent
): Promise<SecurityKey | undefined> {
  // Step 1: Try localStorage lookup (existing behavior)
  const localKey = getSecurityKeyByFingerprint(fingerprint);
  if (localKey) {
    console.log(`✅ [keyVCBinding] Found key in localStorage for fingerprint: ${fingerprint.substring(0, 20)}...`);
    return localKey;
  }

  // Step 2: Try Pluto fallback if agent provided
  if (!agent) {
    console.warn(`⚠️ [keyVCBinding] No Pluto fallback available (agent not provided)`);
    return undefined;
  }

  console.log(`🔍 [keyVCBinding] Key not in localStorage, trying Pluto fallback for fingerprint: ${fingerprint.substring(0, 20)}...`);

  try {
    // Search all PRISM DIDs for matching fingerprint
    const result = await findKeyByFingerprintInPluto(agent, fingerprint);

    if (!result) {
      console.warn(`⚠️ [keyVCBinding] Fingerprint not found in any PRISM DID`);
      return undefined;
    }

    console.log(`✅ [keyVCBinding] Found matching key in PRISM DID: ${result.prismDID.substring(0, 50)}...`);

    // Now extract BOTH keys from this PRISM DID to get full SecurityKeyDual
    const plutoKeys = await extractKeysFromPrismDID(agent, result.prismDID);
    if (!plutoKeys) {
      console.warn(`⚠️ [keyVCBinding] Failed to extract full key pair from PRISM DID`);
      return undefined;
    }

    // Convert to SecurityKeyDual format
    const securityKey = plutoKeysToSecurityKeyDual(plutoKeys);
    if (securityKey) {
      console.log(`✅ [keyVCBinding] Converted Pluto keys to SecurityKeyDual format`);
      return securityKey;
    }

    console.warn(`⚠️ [keyVCBinding] Could not convert Pluto keys to SecurityKeyDual (missing ed25519 or x25519)`);
    return undefined;

  } catch (error: any) {
    console.error(`❌ [keyVCBinding] Error during Pluto fallback:`, error);
    return undefined;
  }
}
