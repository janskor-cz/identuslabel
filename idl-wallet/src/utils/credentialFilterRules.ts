/**
 * Credential Filtering Rules for Proof Requests
 *
 * Provides purpose-based filtering to ensure only appropriate credentials
 * are shown when responding to proof requests.
 *
 * Created: January 2, 2026
 * Purpose: Filter credentials by request purpose/claim type
 */

import { CredentialType, getCredentialType } from './credentialTypeDetector';

/**
 * System credentials that should NEVER be offered for sharing in proof requests.
 * These are internal wallet configuration/identity credentials.
 */
export const SYSTEM_CREDENTIAL_BLOCKLIST: CredentialType[] = [
  'CertificationAuthorityIdentity',  // CA identity - internal use only
  'ServiceConfiguration',            // Enterprise config - contains API keys
];

/**
 * Credential types that can be shared in proof requests (shareable credentials)
 */
export const SHAREABLE_CREDENTIAL_TYPES: CredentialType[] = [
  'RealPersonIdentity',
  'SecurityClearance',
  'EmployeeRole',
  'CISTrainingCertificate',
  'DocumentCopy',
];

/**
 * Maps goalCode/purpose to appropriate credential types
 */
export const PURPOSE_TO_CREDENTIAL_MAP: Record<string, CredentialType[]> = {
  // Identity verification requests
  'authentication.identity': ['RealPersonIdentity'],
  'identity-verification': ['RealPersonIdentity'],
  'present-vp': ['RealPersonIdentity', 'SecurityClearance', 'EmployeeRole'],

  // Security clearance requests
  'authentication.clearance': ['SecurityClearance'],
  'clearance-verification': ['SecurityClearance'],
  'resource-authorization': ['SecurityClearance'],

  // Employment verification requests
  'employment-verification': ['EmployeeRole'],
  'employee-verification': ['EmployeeRole'],

  // Training certificate requests
  'training-verification': ['CISTrainingCertificate'],
  'cis-training': ['CISTrainingCertificate'],

  // Document access requests
  'document-access': ['DocumentCopy'],

  // Generic - show all shareable types
  'connect': SHAREABLE_CREDENTIAL_TYPES,
  'issue-vc': SHAREABLE_CREDENTIAL_TYPES,
};

/**
 * Schema ID patterns mapped to credential types
 * Keys are case-insensitive substring matches
 */
export const SCHEMA_TO_CREDENTIAL_MAP: Record<string, CredentialType[]> = {
  'RealPerson': ['RealPersonIdentity'],
  'real-person': ['RealPersonIdentity'],
  'identity': ['RealPersonIdentity'],

  'SecurityClearance': ['SecurityClearance'],
  'security-clearance': ['SecurityClearance'],
  'clearance': ['SecurityClearance'],

  'EmployeeRole': ['EmployeeRole'],
  'employee-role': ['EmployeeRole'],
  'employee': ['EmployeeRole'],

  'CISTraining': ['CISTrainingCertificate'],
  'cis-training': ['CISTrainingCertificate'],
  'training': ['CISTrainingCertificate'],

  'DocumentCopy': ['DocumentCopy'],
  'document': ['DocumentCopy'],
};

/**
 * Check if a credential type is blocked from sharing
 */
export function isSystemCredential(credentialType: CredentialType): boolean {
  return SYSTEM_CREDENTIAL_BLOCKLIST.includes(credentialType);
}

/**
 * Check if a credential can be shared in proof requests
 */
export function isShareableCredential(credential: any): boolean {
  const credType = getCredentialType(credential);
  return !isSystemCredential(credType);
}

/**
 * Get appropriate credential types for a proof request
 *
 * @param goalCode - The goal_code from the proof request
 * @param schemaId - The schema ID requested
 * @param comment - The comment/goal field (may contain schema hints)
 * @returns Array of appropriate credential types, or all shareable types if no match
 */
export function getCredentialTypesForRequest(
  goalCode?: string,
  schemaId?: string,
  comment?: string
): CredentialType[] {
  // 1. Try goalCode first (most explicit)
  if (goalCode && PURPOSE_TO_CREDENTIAL_MAP[goalCode]) {
    console.log(`[credentialFilterRules] Matched goalCode: ${goalCode}`);
    return PURPOSE_TO_CREDENTIAL_MAP[goalCode];
  }

  // 2. Try schema ID matching (case-insensitive substring)
  if (schemaId) {
    const lowerSchema = schemaId.toLowerCase();
    for (const [pattern, types] of Object.entries(SCHEMA_TO_CREDENTIAL_MAP)) {
      if (lowerSchema.includes(pattern.toLowerCase())) {
        console.log(`[credentialFilterRules] Matched schema pattern: ${pattern}`);
        return types;
      }
    }
  }

  // 3. Try extracting schema from comment (format: "schema:RealPerson - ...")
  if (comment) {
    const schemaMatch = comment.match(/schema:([A-Za-z0-9_-]+)/i);
    if (schemaMatch) {
      const extractedSchema = schemaMatch[1];
      for (const [pattern, types] of Object.entries(SCHEMA_TO_CREDENTIAL_MAP)) {
        if (extractedSchema.toLowerCase().includes(pattern.toLowerCase())) {
          console.log(`[credentialFilterRules] Matched schema from comment: ${extractedSchema}`);
          return types;
        }
      }
    }
  }

  // 4. Default: return all shareable types (let user choose)
  console.log('[credentialFilterRules] No specific match, returning all shareable types');
  return SHAREABLE_CREDENTIAL_TYPES;
}

/**
 * Request purpose information for filtering
 */
export interface RequestPurpose {
  goalCode?: string;
  schemaId?: string;
  comment?: string;
}

/**
 * Filter credentials based on proof request purpose
 *
 * This is the main entry point for credential filtering.
 * It applies two layers of filtering:
 * 1. Remove system credentials (hard blocklist)
 * 2. Filter by request purpose/schema
 *
 * @param credentials - All credentials in wallet (already filtered by revocation)
 * @param request - The proof request with goalCode, schemaId, comment
 * @returns Filtered credentials appropriate for the request
 */
export function filterCredentialsForProofRequest(
  credentials: any[],
  request: RequestPurpose
): any[] {
  console.log('[credentialFilterRules] Filtering credentials for proof request');
  console.log('[credentialFilterRules] Input credentials:', credentials.length);
  console.log('[credentialFilterRules] Request purpose:', request);

  // Step 1: Remove system credentials (hard blocklist)
  const nonSystemCredentials = credentials.filter(cred => {
    const credType = getCredentialType(cred);
    const isBlocked = isSystemCredential(credType);
    if (isBlocked) {
      console.log(`[credentialFilterRules] Blocked system credential: ${credType}`);
    }
    return !isBlocked;
  });

  console.log(`[credentialFilterRules] After blocklist: ${nonSystemCredentials.length} credentials`);

  // Step 2: Get appropriate types for this request
  const appropriateTypes = getCredentialTypesForRequest(
    request.goalCode,
    request.schemaId,
    request.comment
  );

  console.log('[credentialFilterRules] Appropriate types:', appropriateTypes);

  // Step 3: Filter by appropriate types
  const filteredCredentials = nonSystemCredentials.filter(cred => {
    const credType = getCredentialType(cred);
    const matches = appropriateTypes.includes(credType);
    if (!matches) {
      console.log(`[credentialFilterRules] Excluded by purpose: ${credType}`);
    }
    return matches;
  });

  console.log(`[credentialFilterRules] After purpose filtering: ${filteredCredentials.length} credentials`);

  // If no matching credentials found, return all shareable credentials
  // (user can manually select - better UX than empty list)
  if (filteredCredentials.length === 0 && nonSystemCredentials.length > 0) {
    console.log('[credentialFilterRules] No matching credentials for types:', appropriateTypes);
    console.log('[credentialFilterRules] Falling back to all shareable credentials');
    return nonSystemCredentials;
  }

  return filteredCredentials;
}
