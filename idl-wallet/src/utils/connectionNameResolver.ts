/**
 * Connection Name Resolver - Extract real names from RealPerson VCs
 *
 * This utility resolves connection names by matching connection DIDs
 * with RealPerson verifiable credentials and extracting the person's
 * actual name instead of showing "Unknown Connection".
 */

import SDK from "@hyperledger/identus-edge-agent-sdk";
import { extractCredentialSubject } from './vcValidation';
import { getCredentialsForConnection } from './connectionCredentialMatcher';

const VC_PROOF_SHARING_PIURI = 'https://identuslabel.cz/protocols/vc-proof-sharing/1.0/proof';

const isRawJws = (s: any): s is string =>
  typeof s === 'string' && s.startsWith('eyJ') && s.split('.').length === 3;

/**
 * Extract a full name from a vc-proof-sharing/1.0/proof message's embedded vcProof — same two
 * shapes createVCProofAttachment produces (raw JWT + disclosedFields, or a plain credentialSubject
 * object), mirroring vcValidation.ts's parseInviterIdentity without needing that function's async
 * signature verification — a display-name hint only, not a trust decision.
 */
function extractNameFromVCProof(vcProof: any): string | null {
  try {
    let credSubject = extractCredentialSubject(vcProof);

    if (Object.keys(credSubject || {}).length === 0 && isRawJws(vcProof?.jwt)) {
      const b64 = vcProof.jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64));
      const fullSubject = payload.vc?.credentialSubject || payload.credentialSubject || {};
      const disclosedFields: string[] | undefined = vcProof.disclosedFields;
      if (disclosedFields && disclosedFields.length > 0) {
        const filtered: any = {};
        disclosedFields.forEach((field: string) => {
          if (fullSubject[field] !== undefined) filtered[field] = fullSubject[field];
        });
        credSubject = filtered;
      } else {
        credSubject = fullSubject;
      }
    }

    const firstName = credSubject?.firstName?.trim() || '';
    const lastName = credSubject?.lastName?.trim() || '';
    if (firstName && lastName) return `${firstName} ${lastName}`;
    if (firstName) return firstName;
    if (lastName) return lastName;
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract a display name from a live-verified credentialSubject snapshot
 * (ConnectionMetadata.verifiedCredentialSubject — see that field's doc comment).
 */
export function getNameFromVerifiedSubject(subject?: Record<string, any> | null): string | null {
  if (!subject) return null;
  const firstName = (subject.firstName || '').trim?.() || '';
  const lastName = (subject.lastName || '').trim?.() || '';
  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  if (lastName) return lastName;
  if (subject.organizationName) return subject.organizationName;
  if (subject.companyName) return subject.companyName;
  return null;
}

/**
 * Find a verified name from a live vc-proof-sharing/1.0/proof message sent by `connectionDID` —
 * no time window: whenever this message arrives (immediately or much later, see connections.tsx's
 * indefinite watch for late VP replies), it takes priority over a self-declared alias.
 */
export function getVerifiedNameFromVCProofSharing(
  connectionDID: string,
  messages: SDK.Domain.Message[] = []
): string | null {
  try {
    if (!connectionDID || !messages?.length) return null;

    const vcMsg = messages.find((m: any) =>
      m.piuri === VC_PROOF_SHARING_PIURI &&
      m.from?.toString() === connectionDID &&
      m.direction === SDK.Domain.MessageDirection.RECEIVED
    );
    if (!vcMsg) return null;

    const body = typeof vcMsg.body === 'string' ? JSON.parse(vcMsg.body) : vcMsg.body;
    const vcProof = body?.vcProof;
    if (!vcProof) return null;

    return extractNameFromVCProof(vcProof);
  } catch {
    return null;
  }
}

/**
 * Check if a credential is a RealPerson VC
 */
function isRealPersonVC(credential: SDK.Domain.Credential): boolean {
  try {
    // Extract credential subject to check for person fields
    const credSubject = extractCredentialSubject(credential);

    // Check if credential has person-identifying fields
    const hasPersonFields = !!(
      credSubject.firstName ||
      credSubject.lastName ||
      credSubject.dateOfBirth ||
      credSubject.uniqueId
    );

    if (!hasPersonFields) {
      return false;
    }

    // Check credential type array
    if (credential.credentialType) {
      const typeStr = credential.credentialType.toString().toLowerCase();
      if (typeStr.includes('realperson') || typeStr.includes('person')) {
        return true;
      }
    }

    // Check for RealPerson in credential properties
    const credentialString = JSON.stringify(credential).toLowerCase();
    if (credentialString.includes('realperson')) {
      return true;
    }

    // If has person fields, assume it's a person credential
    return hasPersonFields;
  } catch (error) {
    return false;
  }
}

/**
 * Extract full name from RealPerson VC credential subject
 */
function extractNameFromCredential(credential: SDK.Domain.Credential): string | null {
  try {
    const credSubject = extractCredentialSubject(credential);

    const firstName = credSubject.firstName?.trim() || '';
    const lastName = credSubject.lastName?.trim() || '';

    if (firstName && lastName) {
      return `${firstName} ${lastName}`;
    } else if (firstName) {
      return firstName;
    } else if (lastName) {
      return lastName;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Get connection display name from RealPerson VC
 *
 * Matches the connection DID with credential subject DID and extracts
 * the person's name from their RealPerson verifiable credential.
 *
 * @param connectionDID - The DID of the connection (receiver DID)
 * @param credentials - List of all credentials in wallet
 * @returns Full name from VC or "Unknown Connection" as fallback
 *
 * @example
 * const name = getConnectionName(
 *   "did:peer:2.Ez6LSghw...",
 *   app.credentials
 * );
 * // Returns: "Bob Johnson" or "Unknown Connection"
 */
export function getConnectionName(
  connectionDID: string,
  credentials: SDK.Domain.Credential[],
  messages: SDK.Domain.Message[] = []
): string {
  try {
    // Early return for missing inputs
    if (!connectionDID || !credentials || credentials.length === 0) {
      return 'Unknown Connection';
    }

    // Find credentials issued over this connection — shared with ConnectionAvatar/
    // ConnectionCredentialsList via connectionCredentialMatcher.ts, so there is exactly one
    // implementation of this match (issue-credential message from === connection.receiver).
    const matchingCredentials = getCredentialsForConnection(connectionDID, credentials, messages);

    // No match found - return fallback
    if (matchingCredentials.length === 0) {
      return 'Unknown Connection';
    }

    // Filter to only RealPerson VCs
    const realPersonVCs = matchingCredentials.filter(isRealPersonVC);

    if (realPersonVCs.length === 0) {
      return 'Unknown Connection';
    }

    // If multiple VCs, use the most recent one
    // (credentials are typically ordered by creation time)
    const latestVC = realPersonVCs[realPersonVCs.length - 1];

    // Extract name from the credential
    const name = extractNameFromCredential(latestVC);

    return name || 'Unknown Connection';
  } catch (error) {
    console.warn('[ConnectionNameResolver] Error resolving connection name:', error);
    return 'Unknown Connection';
  }
}

/**
 * Get connection display name with fallback to connection.name
 *
 * Tries to get name from VC first, then falls back to connection.name,
 * then finally to "Unknown Connection".
 *
 * @param connectionDID - The DID of the connection
 * @param credentials - List of all credentials
 * @param fallbackName - Optional fallback name (e.g., connection.name)
 * @returns Display name with multi-level fallback
 */
export function getConnectionNameWithFallback(
  connectionDID: string,
  credentials: SDK.Domain.Credential[],
  fallbackName?: string,
  messages: SDK.Domain.Message[] = []
): string {
  const vcName = getConnectionName(connectionDID, credentials, messages);

  if (vcName !== 'Unknown Connection') {
    return vcName;
  }

  // Live-verified name from the other party's own present-proof round trip (see
  // liveIdentityVerification.ts / performLiveIdentityVerificationAndMaybeRespond) — takes priority
  // over a self-declared connection alias whenever it arrives, no matter how late.
  const verifiedName = getVerifiedNameFromVCProofSharing(connectionDID, messages);
  if (verifiedName) {
    return verifiedName;
  }

  if (fallbackName && fallbackName.trim() !== '') {
    return fallbackName;
  }

  return 'Unknown Connection';
}
