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
 * Known credential-type aliases, keyed by canonical type. `schemaId` values seen in this
 * app are always one of these exact alias tokens (extracted upstream from a `schema:X`
 * convention in goalCode/goal/comment — see actions/index.ts), never free-form text, so
 * exact alias equality identifies the requested type without needing substring matching.
 */
const SCHEMA_KEYWORD_ALIASES: Record<string, string[]> = {
  RealPersonIdentity: ['realperson', 'realpersonidentity', 'identity'],
  SecurityClearance: ['securityclearance', 'clearance', 'security'],
};

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolves a free-form schema/type string to one of the canonical keys above, or null. */
function canonicalSchemaKey(value: string): string | null {
  const normalized = normalizeKey(value);
  for (const [canonical, aliases] of Object.entries(SCHEMA_KEYWORD_ALIASES)) {
    if (aliases.some((alias) => normalizeKey(alias) === normalized)) {
      return canonical;
    }
  }
  return null;
}

/**
 * Check if a credential matches a requested schema
 *
 * Matching is by exact alias equality (via canonicalSchemaKey), not substring
 * containment — `.includes()` risked false positives between similarly-named schemas
 * (e.g. a hypothetical "RealPersonRevoked" would satisfy `.includes('realperson')`) and
 * isn't part of any actual schema-matching spec.
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

  const requestedType = canonicalSchemaKey(schemaId);
  if (!requestedType) {
    // schemaId isn't one of the known alias tokens (e.g. it's an opaque schema-registry
    // GUID/URL) — none of the checks below have a reliable text signal to match against.
    return false;
  }

  const subject = credential.credentialSubject || credential.claims?.[0] || {};

  // Prefer the credential's own self-declared type — most reliable signal, and avoids
  // false positives between VC types that happen to share overlapping field names
  // (e.g. RealPersonIdentity and SecurityClearance can both carry firstName/lastName).
  if (subject.credentialType && typeof subject.credentialType === 'string') {
    return canonicalSchemaKey(subject.credentialType) === requestedType;
  }

  // Check credential schema field
  const credSchema = credential.schema || credential.credentialSchema || credential.type;

  if (Array.isArray(credSchema)) {
    // Handle array of types (W3C VC format)
    return credSchema.some((type) => typeof type === 'string' && canonicalSchemaKey(type) === requestedType);
  }

  if (typeof credSchema === 'string') {
    return canonicalSchemaKey(credSchema) === requestedType;
  }

  // Last-resort fallback: shape-based heuristic (least reliable — can collide between
  // VC types with overlapping field names, which is exactly what credentialType above avoids)
  if (requestedType === 'RealPersonIdentity') {
    // RealPerson has firstName, lastName, dateOfBirth, uniqueId
    return !!(subject.firstName && subject.lastName && subject.uniqueId);
  }

  if (requestedType === 'SecurityClearance') {
    // SecurityClearance has clearanceLevel
    return !!(subject.clearanceLevel);
  }

  // No match found
  return false;
}
