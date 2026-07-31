/**
 * Credential Schema Extraction Utility
 *
 * Extracts and identifies credential types from various credential formats:
 * - JWT credentials (with vc.credentialSchema)
 * - Embedded VCs (with top-level credentialSchema)
 * - Legacy credentials (with credentialType in claims)
 *
 * Used for:
 * - Filtering credentials in OOB modal
 * - Selective disclosure
 * - Custom rendering based on credential type
 * - Schema validation
 *
 * Updated: December 14, 2025 - Added multi-method VC and subject extraction for SDK JWTCredential support
 */

import { getCredentialType } from './credentialTypeDetector';

/**
 * Extract VC object from credential using multiple methods
 * Handles SDK JWTCredential with properties Map
 */
function getVC(credential: any): any {
  if (!credential) return null;

  // Method 1: Try class getter directly
  try {
    if (credential.vc) {
      console.log('[getVC] Method 1 (getter): FOUND');
      return credential.vc;
    }
  } catch (e) {
    console.log('[getVC] Method 1 threw:', e);
  }

  // Method 2: Try properties Map with .get()
  if (credential.properties && typeof credential.properties.get === 'function') {
    try {
      const vc = credential.properties.get('vc');
      if (vc) {
        console.log('[getVC] Method 2 (Map.get): FOUND');
        return vc;
      }
    } catch (e) {
      console.log('[getVC] Method 2 threw:', e);
    }
  }

  // Method 3: Try properties Map iteration
  if (credential.properties && typeof credential.properties.forEach === 'function') {
    let vcValue: any = null;
    credential.properties.forEach((value: any, key: any) => {
      if (key === 'vc' || String(key) === 'vc') {
        vcValue = value;
      }
    });
    if (vcValue) {
      console.log('[getVC] Method 3 (forEach): FOUND');
      return vcValue;
    }
  }

  console.log('[getVC] All methods failed - returning null');
  return null;
}

/**
 * Schema information extracted from credential
 */
export interface CredentialSchemaInfo {
  id: string;
  type: string;
  schemaType?: string;
}

/**
 * Credential type identification result
 */
export interface CredentialTypeInfo {
  type: 'RealPerson' | 'SecurityClearance' | 'ServiceConfiguration' | 'Unknown';
  source: 'schema' | 'claims' | 'heuristic';
  schemaInfo?: CredentialSchemaInfo;
}

/**
 * Extract schema information from a credential
 *
 * Handles multiple credential formats:
 * - JWT: vc.credentialSchema array
 * - Embedded VC: top-level credentialSchema property
 *
 * @param credential - The credential to extract schema from
 * @returns Schema info or null if not found
 */
export function extractCredentialSchema(credential: any): CredentialSchemaInfo | null {
  try {
    // Use multi-method VC extraction for SDK JWTCredential support
    const vc = getVC(credential);

    // JWT credentials: Check vc.credentialSchema array
    if (vc?.credentialSchema && Array.isArray(vc.credentialSchema)) {
      const schema = vc.credentialSchema[0];
      if (schema?.id) {
        console.log('[credentialSchemaExtractor] Found schema in JWT vc.credentialSchema:', schema.id);
        return {
          id: schema.id,
          type: schema.type || 'CredentialSchema2022',
          schemaType: 'jwt'
        };
      }
    }

    // Embedded VCs: Check top-level credentialSchema
    if (credential.credentialSchema) {
      if (Array.isArray(credential.credentialSchema)) {
        const schema = credential.credentialSchema[0];
        if (schema?.id) {
          console.log('[credentialSchemaExtractor] Found schema in embedded VC credentialSchema array:', schema.id);
          return {
            id: schema.id,
            type: schema.type || 'CredentialSchema2022',
            schemaType: 'embedded'
          };
        }
      } else if (credential.credentialSchema.id) {
        console.log('[credentialSchemaExtractor] Found schema in embedded VC credentialSchema object:', credential.credentialSchema.id);
        return {
          id: credential.credentialSchema.id,
          type: credential.credentialSchema.type || 'CredentialSchema2022',
          schemaType: 'embedded'
        };
      }
    }

    console.log('[credentialSchemaExtractor] No schema found in credential');
    return null;
  } catch (error) {
    console.warn('[credentialSchemaExtractor] Error extracting schema:', error);
    return null;
  }
}

/**
 * Identify credential type.
 *
 * Delegates to credentialTypeDetector.ts's getCredentialType(), which identifies credentials by
 * their explicit `credentialType` claim, W3C `type` array, and per-type field signatures — none
 * of it keyed on a schema GUID. This module previously kept its own parallel, hardcoded
 * schema-GUID → type table; new companies/schema versions never got added to it (confirmed live:
 * EvilCorp's ServiceConfiguration schema GUID was absent, so this function reported 0 matches for
 * an EvilCorp employee's wallet even though the credential — and the enterprise wallet it powers —
 * was genuinely present and valid). credentialTypeDetector.ts's ServiceConfiguration field
 * signature (`enterpriseAgentUrl` + `enterpriseAgentApiKey`) already covers every company without
 * per-company maintenance, so there is no schema-based table to keep in sync anymore.
 *
 * `schemaInfo` is retained purely as optional display/debug metadata (the schema id, if present)
 * — it plays no role in the type decision.
 *
 * @param credential - The credential to identify
 * @returns Credential type information
 */
export function identifyCredentialType(credential: any): CredentialTypeInfo {
  const schemaInfo = extractCredentialSchema(credential);
  const detected = getCredentialType(credential);

  const type: CredentialTypeInfo['type'] =
    detected === 'RealPersonIdentity' ? 'RealPerson' :
    detected === 'SecurityClearance'  ? 'SecurityClearance' :
    detected === 'ServiceConfiguration' ? 'ServiceConfiguration' :
    'Unknown';

  console.log(`[credentialSchemaExtractor] Identified as ${type} (detector: ${detected})`);
  return { type, source: 'claims', schemaInfo: schemaInfo ?? undefined };
}
