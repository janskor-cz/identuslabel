/**
 * Schema ID to Human-Readable Name Mapping
 *
 * Maps credential schema identifiers to user-friendly display names
 * for improved UX in proof request modals and credential displays.
 */

/**
 * Known schema name mappings
 * Add new schema types as they are created
 */
export const SCHEMA_NAMES: Record<string, string> = {
  // RealPerson Identity Credential
  'RealPerson': 'Identity Credential',
  'real-person': 'Identity Credential',
  'identity': 'Identity Credential',

  // Security Clearance Credential
  'SecurityClearance': 'Security Clearance',
  'security-clearance': 'Security Clearance',
  'clearance': 'Security Clearance',

  // Add more schema types here as needed
  // Example: 'DriverLicense': 'Driver\'s License',
};

/**
 * Get human-readable display name for a schema ID
 *
 * @param schemaId - The schema identifier (may be URL, GUID, or short name)
 * @returns Human-readable schema name or generic "Credential" if not found
 *
 * @example
 * getSchemaDisplayName('https://example.com/schemas/RealPerson')
 * // Returns: 'Identity Credential'
 *
 * getSchemaDisplayName('SecurityClearance-v1.0')
 * // Returns: 'Security Clearance'
 *
 * getSchemaDisplayName('unknown-schema')
 * // Returns: 'Credential'
 */
export function getSchemaDisplayName(schemaId?: string): string {
  if (!schemaId) {
    return 'Credential';
  }

  // Check if schema ID matches any known patterns
  const schemaIdLower = schemaId.toLowerCase();

  for (const [pattern, displayName] of Object.entries(SCHEMA_NAMES)) {
    if (schemaIdLower.includes(pattern.toLowerCase())) {
      return displayName;
    }
  }

  // Fallback to generic name
  return 'Credential';
}

/**
 * Check if a credential matches a requested schema
 *
 * @param credential - The credential to check
 * @param schemaId - The requested schema identifier
 * @returns true if credential matches the schema
 */
export function matchesSchema(credential: any, schemaId?: string): boolean {
  if (!schemaId) {
    // No schema specified, all credentials match
    return true;
  }

  // Check credential schema field
  const credSchema = credential.schema || credential.credentialSchema || credential.type;

  if (Array.isArray(credSchema)) {
    // Handle array of types (W3C VC format)
    return credSchema.some(type =>
      typeof type === 'string' && type.toLowerCase().includes(schemaId.toLowerCase())
    );
  }

  if (typeof credSchema === 'string') {
    return credSchema.toLowerCase().includes(schemaId.toLowerCase());
  }

  // Fallback: check credential subject fields for RealPerson/SecurityClearance patterns
  const subject = credential.credentialSubject || credential.claims?.[0] || {};

  if (schemaId.toLowerCase().includes('realperson') || schemaId.toLowerCase().includes('identity')) {
    // RealPerson has firstName, lastName, dateOfBirth, uniqueId
    return !!(subject.firstName && subject.lastName && subject.uniqueId);
  }

  if (schemaId.toLowerCase().includes('clearance') || schemaId.toLowerCase().includes('security')) {
    // SecurityClearance has clearanceLevel
    return !!(subject.clearanceLevel);
  }

  // No match found
  return false;
}
