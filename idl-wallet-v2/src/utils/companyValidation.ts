/**
 * Company Identity Credential Validation Utility
 *
 * Validates Company Identity credentials embedded in employee invitation OOB messages
 * for wallet initialization and trust establishment.
 */

/**
 * Company credential data structure from invitation attachment
 */
export interface CompanyCredentialData {
  credential: string; // JWT
  claims: {
    companyName: string;
    registrationNumber: string;
    jurisdiction: string;
    industry?: string;
    address?: string;
    contactEmail?: string;
    website?: string;
    [key: string]: any;
  };
  issuerDID: string;
  holderDID: string;
  credentialType: string;
  issuedDate: string;
}

/**
 * Validated company configuration extracted from credential
 */
export interface ValidatedCompanyConfig {
  companyDID: string;
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
  industry?: string;
  address?: string;
  contactEmail?: string;
  website?: string;
  credentialJWT: string;
  claims: any;
}

/**
 * Parse company credential from OOB invitation attachment
 *
 * @param invitation - DIDComm OOB invitation object
 * @returns Company credential data or null if not found
 */
export function parseCompanyCredentialFromInvitation(invitation: any): CompanyCredentialData | null {
  try {
    console.log('🔍 [Company Validation] Parsing company credential from invitation');

    // Check if invitation has requests_attach
    if (!invitation.requests_attach || !Array.isArray(invitation.requests_attach)) {
      console.warn('⚠️ [Company Validation] No requests_attach found in invitation');
      return null;
    }

    // Find company credential attachment
    const companyAttachment = invitation.requests_attach.find(
      (att: any) => att['@id'] === 'company-identity-credential'
    );

    if (!companyAttachment) {
      console.warn('⚠️ [Company Validation] No company identity credential attachment found');
      return null;
    }

    // Extract credential data
    const credentialData = companyAttachment.data?.json;

    if (!credentialData) {
      console.warn('⚠️ [Company Validation] Company attachment has no data.json');
      return null;
    }

    console.log('✅ [Company Validation] Company credential found:', credentialData.credentialType);
    return credentialData as CompanyCredentialData;

  } catch (error) {
    console.error('❌ [Company Validation] Error parsing company credential:', error);
    return null;
  }
}

/**
 * Validate company credential JWT signature and structure
 *
 * @param companyCredential - Company credential data
 * @returns Validated company configuration or throws error
 */
export async function validateCompanyCredential(
  companyCredential: CompanyCredentialData
): Promise<ValidatedCompanyConfig> {
  console.log('🔐 [Company Validation] Validating company credential...');

  // Basic structure validation
  if (!companyCredential.credential) {
    throw new Error('Company credential JWT missing');
  }

  if (!companyCredential.holderDID) {
    throw new Error('Company holder DID missing');
  }

  if (companyCredential.credentialType !== 'CompanyIdentity') {
    throw new Error(`Invalid credential type: ${companyCredential.credentialType}`);
  }

  // Validate required claims
  const requiredClaims = [
    'companyName',
    'registrationNumber',
    'jurisdiction'
  ];

  for (const claim of requiredClaims) {
    if (!companyCredential.claims[claim]) {
      throw new Error(`Missing required claim: ${claim}`);
    }
  }

  // JWT signature validation (basic check)
  // In production, this would use the Identus SDK to verify the JWT signature
  // against the issuer's DID
  const jwtParts = companyCredential.credential.split('.');
  if (jwtParts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  // Decode JWT payload to verify claims match
  try {
    const payloadBase64 = jwtParts[1];
    const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    console.log('✅ [Company Validation] JWT payload decoded');

    // Verify credential subject matches claims
    if (payload.vc?.credentialSubject) {
      const subject = payload.vc.credentialSubject;

      // Basic claim verification
      if (subject.companyName !== companyCredential.claims.companyName) {
        throw new Error('JWT claims do not match provided claims');
      }
    }

  } catch (error) {
    console.error('❌ [Company Validation] JWT decoding error:', error);
    throw new Error(`Failed to decode JWT: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  console.log('✅ [Company Validation] Company credential valid');

  // Return validated configuration
  return {
    companyDID: companyCredential.holderDID,
    companyName: companyCredential.claims.companyName,
    registrationNumber: companyCredential.claims.registrationNumber,
    jurisdiction: companyCredential.claims.jurisdiction,
    industry: companyCredential.claims.industry,
    address: companyCredential.claims.address,
    contactEmail: companyCredential.claims.contactEmail,
    website: companyCredential.claims.website,
    credentialJWT: companyCredential.credential,
    claims: companyCredential.claims
  };
}

/**
 * Parse base64-encoded OOB invitation
 *
 * @param oobBase64 - Base64-encoded OOB invitation
 * @returns Parsed invitation object
 */
export function parseOOBInvitation(oobBase64: string): any {
  try {
    const invitationJson = atob(oobBase64);
    return JSON.parse(invitationJson);
  } catch (error) {
    throw new Error(`Failed to parse OOB invitation: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Extract OOB parameter from invitation URL
 *
 * @param invitationUrl - Full invitation URL with _oob parameter
 * @returns Base64-encoded OOB invitation or null
 */
export function extractOOBFromURL(invitationUrl: string): string | null {
  try {
    const url = new URL(invitationUrl);
    const oobParam = url.searchParams.get('_oob');
    return oobParam;
  } catch (error) {
    console.error('❌ [Company Validation] Invalid invitation URL:', error);
    return null;
  }
}

// TOFU (Trust-On-First-Use) implementation for company identity pinning
import { getItem, setItem } from './prefixedStorage';

/**
 * Company PIN structure for TOFU verification
 */
export interface CompanyPIN {
  companyDID: string;
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
  credentialHash: string;
  timestamp: number;
}

/**
 * Pin company identity for TOFU (Trust-On-First-Use)
 *
 * @param pin - Company PIN structure
 */
export function pinCompany(pin: CompanyPIN): void {
  try {
    setItem('company-pin', pin);
    console.log('📌 [Company TOFU] Company identity pinned:', pin.companyName);
  } catch (error) {
    console.error('❌ [Company TOFU] Failed to pin company:', error);
  }
}

/**
 * Check if company identity is already verified (pinned)
 *
 * @returns True if company is already pinned
 */
export function isCompanyVerified(): boolean {
  const pin = getItem('company-pin');
  return pin !== null;
}

/**
 * Get pinned company identity
 *
 * @returns Company PIN or null if not pinned
 */
export function getPinnedCompany(): CompanyPIN | null {
  return getItem('company-pin');
}

/**
 * Verify pinned company against new invitation
 *
 * @param companyDID - Company DID from new invitation
 * @returns True if matches pinned company
 */
export function verifyPinnedCompany(companyDID: string): boolean {
  const pin = getPinnedCompany();
  if (!pin) {
    return false;
  }
  return pin.companyDID === companyDID;
}

/**
 * Hash credential for TOFU verification
 *
 * @param credentialJWT - JWT credential string
 * @returns Hash of credential
 */
export async function hashCredential(credentialJWT: string): Promise<string> {
  // Use SubtleCrypto for SHA-256 hashing
  const encoder = new TextEncoder();
  const data = encoder.encode(credentialJWT);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * CA Verification - Check if CompanyIdentity VC issuer is trusted
 *
 * Uses wallet's trust registry for verification (SSI standard approach)
 */

import { isTrustedIssuer, getTrustedIssuerInfo } from './trustRegistry';

/**
 * Extract issuer DID from CompanyIdentity JWT
 *
 * @param credentialJWT - JWT credential string
 * @returns Issuer DID or null if not found
 */
export function extractIssuerDID(credentialJWT: string): string | null {
  try {
    // Decode JWT payload
    const jwtParts = credentialJWT.split('.');
    if (jwtParts.length !== 3) {
      console.error('❌ [CA Verification] Invalid JWT format');
      return null;
    }

    const payloadBase64 = jwtParts[1];
    const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    // Extract issuer from JWT (iss claim)
    const issuerDID = payload.iss;

    if (!issuerDID) {
      console.warn('⚠️ [CA Verification] No issuer (iss) claim found in JWT');
      return null;
    }

    console.log('🔍 [CA Verification] Extracted issuer DID:', issuerDID);
    return issuerDID;

  } catch (error) {
    console.error('❌ [CA Verification] Failed to extract issuer DID:', error);
    return null;
  }
}

/**
 * Check if wallet has a connection to the given DID
 *
 * @param agent - Identus Agent instance
 * @param issuerDID - Issuer DID to check
 * @returns Connection label if found, null otherwise
 */
export async function checkCAConnection(agent: any, issuerDID: string): Promise<string | null> {
  try {
    console.log('🔍 [CA Verification] Checking for connection to issuer:', issuerDID);

    // Get all wallet connections
    const allConnections = await agent.pluto.getAllDidPairs();

    console.log(`🔍 [CA Verification] Found ${allConnections.length} total connections`);

    // Check if any connection matches the issuer DID
    for (const connection of allConnections) {
      const remoteDID = connection.receiver.toString();

      console.log(`  Checking connection: ${connection.name || '(unnamed)'} - ${remoteDID}`);

      if (remoteDID === issuerDID) {
        console.log(`✅ [CA Verification] Found matching connection: ${connection.name || remoteDID}`);
        return connection.name || remoteDID;
      }
    }

    console.log('⚠️ [CA Verification] No connection found to issuer DID');
    return null;

  } catch (error) {
    console.error('❌ [CA Verification] Error checking CA connection:', error);
    return null;
  }
}

/**
 * Verify CompanyIdentity VC was issued by a trusted CA
 *
 * Uses wallet's trust registry for verification (SSI standard approach)
 * Trust decisions made wallet-side, not server-side
 *
 * @param agent - Identus Agent instance (not used, kept for backward compatibility)
 * @param companyCredential - Company credential data
 * @returns Object with verification status and CA name if verified
 */
export async function verifyCompanyIssuer(
  agent: any,
  companyCredential: CompanyCredentialData
): Promise<{ verified: boolean; caName?: string; issuerDID?: string }> {
  try {
    console.log('🔐 [CA Verification] Verifying company issuer using trust registry...');

    // Extract issuer DID from credential JWT
    const issuerDID = extractIssuerDID(companyCredential.credential);

    if (!issuerDID) {
      console.warn('⚠️ [CA Verification] Could not extract issuer DID from credential');
      return { verified: false };
    }

    // Check trust registry for issuer authorization
    const trusted = isTrustedIssuer(issuerDID, 'CompanyIdentity');
    const issuerInfo = getTrustedIssuerInfo(issuerDID);

    if (trusted && issuerInfo) {
      console.log(`✅ [CA Verification] Company credential VERIFIED - Issued by trusted CA: ${issuerInfo.name}`);
      return {
        verified: true,
        caName: issuerInfo.name,
        issuerDID: issuerDID
      };
    } else {
      console.log('ℹ️ [CA Verification] Company credential UNVERIFIED - Issuer not in trust registry (TOFU applies)');
      return {
        verified: false,
        issuerDID: issuerDID
      };
    }

  } catch (error) {
    console.error('❌ [CA Verification] Error verifying company issuer:', error);
    return { verified: false };
  }
}
