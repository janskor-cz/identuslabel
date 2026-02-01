/**
 * Connection Name Resolver - Extract real names from RealPerson VCs
 *
 * This utility resolves connection names by matching connection DIDs
 * with RealPerson verifiable credentials and extracting the person's
 * actual name instead of showing "Unknown Connection".
 */

import SDK from "@hyperledger/identus-edge-agent-sdk";
import { extractCredentialSubject } from './vcValidation';

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
  credentials: SDK.Domain.Credential[]
): string {
  try {
    // Early return for missing inputs
    if (!connectionDID || !credentials || credentials.length === 0) {
      return 'Unknown Connection';
    }

    // Normalize connection DID for comparison
    const normalizedConnectionDID = connectionDID.trim();

    // Find credentials where subject matches the connection DID
    const matchingCredentials = credentials.filter(cred => {
      try {
        const credSubject = cred.subject?.toString().trim();
        return credSubject === normalizedConnectionDID;
      } catch {
        return false;
      }
    });

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
  fallbackName?: string
): string {
  const vcName = getConnectionName(connectionDID, credentials);

  if (vcName !== 'Unknown Connection') {
    return vcName;
  }

  if (fallbackName && fallbackName.trim() !== '') {
    return fallbackName;
  }

  return 'Unknown Connection';
}
