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

import { getCredentialSubject } from './credentialTypeDetector';

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
 * Known schema GUIDs mapped to credential types
 */
const SCHEMA_GUID_MAP: Record<string, string> = {
  'e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f': 'RealPerson',
  'ba309a53-9661-33df-92a3-2023b4a56fd5': 'SecurityClearance',
  'f600cf0b-326c-345d-a17a-4c033c02c241': 'ServiceConfiguration',  // TechCorp Multitenancy Cloud Agent (older)
  'c8d20a5e-3060-3655-bf0b-35e8542c927f': 'ServiceConfiguration',  // Multitenancy Cloud Agent (v2.0.0)
  '8fb9b1d4-a47a-3f60-8bf1-1145d3eaab72': 'ServiceConfiguration'   // Multitenancy Cloud Agent (v3.0.0 with walletId)
};

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
 * Get credential type from schema ID/URL
 *
 * Extracts GUID from schema URL and maps to known credential types
 *
 * @param schemaId - Schema URL or ID
 * @returns Credential type or 'Unknown'
 */
export function getCredentialTypeFromSchema(schemaId: string): 'RealPerson' | 'SecurityClearance' | 'ServiceConfiguration' | 'Unknown' {
  try {
    // Extract GUID from schema URL
    // Format: http://91.99.4.54:8000/cloud-agent/schema-registry/schemas/{guid}
    const guidMatch = schemaId.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);

    if (guidMatch) {
      const guid = guidMatch[1].toLowerCase();
      const type = SCHEMA_GUID_MAP[guid];

      if (type) {
        console.log(`[credentialSchemaExtractor] Schema GUID ${guid} mapped to type: ${type}`);
        return type as 'RealPerson' | 'SecurityClearance' | 'ServiceConfiguration';
      }
    }

    console.log('[credentialSchemaExtractor] Schema ID not recognized:', schemaId);
    return 'Unknown';
  } catch (error) {
    console.warn('[credentialSchemaExtractor] Error parsing schema ID:', error);
    return 'Unknown';
  }
}

/**
 * Get credential type from claims or credentialSubject
 *
 * Fallback method when schema is not available
 *
 * @param credential - The credential to extract type from
 * @returns Credential type string or null
 */
export function getCredentialTypeFromClaims(credential: any): string | null {
  try {
    // Use multi-method subject extraction for SDK JWTCredential support
    const subject = getCredentialSubject(credential);

    // Check credentialSubject (using multi-method extraction)
    if (subject?.credentialType) {
      console.log('[credentialSchemaExtractor] Found credentialType in subject:', subject.credentialType);

      // Map known credentialType values
      if (subject.credentialType === 'RealPersonIdentity') return 'RealPerson';
      if (subject.credentialType === 'SecurityClearance') return 'SecurityClearance';

      return subject.credentialType;
    }

    // Check claims array (legacy JWT credentials)
    if (credential.claims && Array.isArray(credential.claims) && credential.claims.length > 0) {
      const firstClaim = credential.claims[0];

      // Check credentialType in first claim
      if (firstClaim.credentialType) {
        console.log('[credentialSchemaExtractor] Found credentialType in claims[0]:', firstClaim.credentialType);

        // Map known credentialType values
        if (firstClaim.credentialType === 'RealPersonIdentity') return 'RealPerson';
        if (firstClaim.credentialType === 'SecurityClearance') return 'SecurityClearance';

        return firstClaim.credentialType;
      }
    }

    // Check type array (W3C VC standard)
    if (credential.type && Array.isArray(credential.type)) {
      for (const type of credential.type) {
        if (type !== 'VerifiableCredential') {
          console.log('[credentialSchemaExtractor] Found credential type in type array:', type);
          return type;
        }
      }
    }

    console.log('[credentialSchemaExtractor] No credentialType found in claims or credentialSubject');
    return null;
  } catch (error) {
    console.warn('[credentialSchemaExtractor] Error extracting type from claims:', error);
    return null;
  }
}

/**
 * Identify credential type using all available methods
 *
 * Attempts multiple extraction strategies in order of reliability:
 * 1. Schema-based identification (most reliable)
 * 2. Claims-based identification
 * 3. Field-based heuristics (least reliable)
 *
 * @param credential - The credential to identify
 * @returns Credential type information with source
 */
export function identifyCredentialType(credential: any): CredentialTypeInfo {
  // Strategy 1: Extract from schema (most reliable)
  const schemaInfo = extractCredentialSchema(credential);
  if (schemaInfo) {
    const type = getCredentialTypeFromSchema(schemaInfo.id);
    if (type !== 'Unknown') {
      console.log(`[credentialSchemaExtractor] ✅ Identified as ${type} from schema`);
      return { type, source: 'schema', schemaInfo };
    }
  }

  // Strategy 2: Extract from claims/credentialSubject
  const claimsType = getCredentialTypeFromClaims(credential);
  if (claimsType) {
    // Normalize to known types
    if (claimsType === 'RealPersonIdentity' || claimsType === 'RealPerson') {
      console.log('[credentialSchemaExtractor] ✅ Identified as RealPerson from claims');
      return { type: 'RealPerson', source: 'claims', schemaInfo };
    }
    if (claimsType === 'SecurityClearance') {
      console.log('[credentialSchemaExtractor] ✅ Identified as SecurityClearance from claims');
      return { type: 'SecurityClearance', source: 'claims', schemaInfo };
    }
    if (claimsType === 'ServiceConfiguration') {
      console.log('[credentialSchemaExtractor] ✅ Identified as ServiceConfiguration from claims');
      return { type: 'ServiceConfiguration', source: 'claims', schemaInfo };
    }
  }

  // Strategy 3: Heuristic field detection (least reliable)
  const hasPersonFields = checkForPersonFields(credential);
  if (hasPersonFields) {
    console.log('[credentialSchemaExtractor] ⚠️ Identified as RealPerson from heuristics');
    return { type: 'RealPerson', source: 'heuristic', schemaInfo };
  }

  console.log('[credentialSchemaExtractor] ❌ Could not identify credential type');
  return { type: 'Unknown', source: 'heuristic', schemaInfo };
}

/**
 * Check if credential contains typical person identity fields
 *
 * Heuristic detection based on field presence
 *
 * @param credential - The credential to check
 * @returns True if person fields detected
 */
function checkForPersonFields(credential: any): boolean {
  const personFields = ['firstName', 'lastName', 'uniqueId', 'dateOfBirth', 'gender'];

  // Use multi-method subject extraction for SDK JWTCredential support
  const subject = getCredentialSubject(credential);
  if (subject) {
    const hasFields = personFields.some(field => field in subject);
    console.log('[checkForPersonFields] Subject fields check:', hasFields, 'Fields found:', personFields.filter(f => f in subject));
    if (hasFields) return true;
  }

  // Fallback: Check in claims array (legacy)
  if (credential.claims && Array.isArray(credential.claims)) {
    for (const claim of credential.claims) {
      if (claim.credentialSubject) {
        const hasFields = personFields.some(field => field in claim.credentialSubject);
        if (hasFields) return true;
      }
      // Check directly in claim
      const hasFields = personFields.some(field => field in claim);
      if (hasFields) return true;
    }
  }

  console.log('[checkForPersonFields] No person fields found');
  return false;
}

/**
 * Register a new schema GUID mapping
 *
 * Allows dynamic registration of new credential types
 *
 * @param guid - Schema GUID
 * @param type - Credential type name
 */
export function registerSchemaMapping(guid: string, type: string): void {
  SCHEMA_GUID_MAP[guid.toLowerCase()] = type;
  console.log(`[credentialSchemaExtractor] Registered schema mapping: ${guid} → ${type}`);
}

/**
 * Get all registered schema mappings
 *
 * @returns Copy of schema GUID map
 */
export function getSchemaMappings(): Record<string, string> {
  return { ...SCHEMA_GUID_MAP };
}
