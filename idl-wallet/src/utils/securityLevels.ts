/**
 * Security Clearance Level Management
 *
 * Defines the security classification hierarchy and access control logic
 * for encrypted DIDComm messaging.
 */

/**
 * Security classification levels (hierarchical)
 * Higher numeric values indicate higher clearance requirements
 *
 * Standardized to CA Portal naming:
 * - INTERNAL (1): Basic organizational access
 * - CONFIDENTIAL (2): Sensitive business information
 * - RESTRICTED (3): Highly sensitive strategic information
 * - TOP_SECRET (4): Classified information (highest)
 */
export enum SecurityLevel {
  INTERNAL = 1,
  CONFIDENTIAL = 2,
  RESTRICTED = 3,
  TOP_SECRET = 4
}

/**
 * Human-readable names for security levels
 */
export const SECURITY_LEVEL_NAMES: Record<SecurityLevel, string> = {
  [SecurityLevel.INTERNAL]: 'INTERNAL',
  [SecurityLevel.CONFIDENTIAL]: 'CONFIDENTIAL',
  [SecurityLevel.RESTRICTED]: 'RESTRICTED',
  [SecurityLevel.TOP_SECRET]: 'TOP-SECRET'
} as const;

/**
 * Parse a security level string into the SecurityLevel enum
 * Handles various formats (hyphenated, underscored, lowercase, uppercase)
 *
 * @param level - Security level string (e.g., "restricted", "TOP-SECRET", "top_secret", "internal")
 * @returns SecurityLevel enum value
 *
 * @example
 * parseSecurityLevel("restricted") // SecurityLevel.RESTRICTED
 * parseSecurityLevel("TOP-SECRET") // SecurityLevel.TOP_SECRET
 * parseSecurityLevel("confidential") // SecurityLevel.CONFIDENTIAL
 * parseSecurityLevel("internal") // SecurityLevel.INTERNAL
 */
export function parseSecurityLevel(level: string): SecurityLevel {
  // Normalize: uppercase and replace hyphens with underscores
  const normalized = level.toUpperCase().replace(/-/g, '_');

  switch (normalized) {
    case 'TOP_SECRET':
    case 'TOPSECRET':
      return SecurityLevel.TOP_SECRET;
    case 'RESTRICTED':
    case 'SECRET':  // Legacy: map old SECRET to RESTRICTED
      return SecurityLevel.RESTRICTED;
    case 'CONFIDENTIAL':
      return SecurityLevel.CONFIDENTIAL;
    case 'INTERNAL':
    case 'UNCLASSIFIED':  // Legacy: map old UNCLASSIFIED to INTERNAL
    default:
      return SecurityLevel.INTERNAL;
  }
}

/**
 * Check if a user with a given clearance level can decrypt a message
 * at a specific classification level.
 *
 * Access Rule: userClearance >= messageClearance
 * - TOP-SECRET clearance can decrypt: top-secret, restricted, confidential, internal
 * - RESTRICTED clearance can decrypt: restricted, confidential, internal
 * - CONFIDENTIAL clearance can decrypt: confidential, internal
 * - INTERNAL clearance can decrypt: internal only
 *
 * @param userLevel - User's clearance level
 * @param messageLevel - Message classification level
 * @returns true if user can decrypt, false otherwise
 *
 * @example
 * canDecrypt(SecurityLevel.RESTRICTED, SecurityLevel.CONFIDENTIAL) // true
 * canDecrypt(SecurityLevel.CONFIDENTIAL, SecurityLevel.RESTRICTED) // false
 */
export function canDecrypt(userLevel: SecurityLevel, messageLevel: SecurityLevel): boolean {
  return userLevel >= messageLevel;
}

/**
 * Get UI color for a security level badge
 *
 * @param level - Security level
 * @returns CSS color class or color code
 */
export function getLevelColor(level: SecurityLevel): string {
  switch (level) {
    case SecurityLevel.TOP_SECRET:
      return 'red';
    case SecurityLevel.RESTRICTED:
      return 'orange';
    case SecurityLevel.CONFIDENTIAL:
      return 'yellow';
    case SecurityLevel.INTERNAL:
    default:
      return 'green';
  }
}

/**
 * Get icon for a security level
 *
 * @param level - Security level
 * @returns Emoji icon (locked for all classified documents)
 */
export function getLevelIcon(level: SecurityLevel): string {
  return '🔒';
}

/**
 * Get all security levels that a user with a given clearance can access
 *
 * @param userLevel - User's clearance level
 * @returns Array of accessible security levels (from highest to lowest)
 *
 * @example
 * getAccessibleLevels(SecurityLevel.RESTRICTED)
 * // [SecurityLevel.RESTRICTED, SecurityLevel.CONFIDENTIAL, SecurityLevel.INTERNAL]
 */
export function getAccessibleLevels(userLevel: SecurityLevel): SecurityLevel[] {
  const levels: SecurityLevel[] = [];

  for (let level = userLevel; level >= SecurityLevel.INTERNAL; level--) {
    levels.push(level);
  }

  return levels;
}

/**
 * Check if a security level is valid
 *
 * @param level - Security level to validate
 * @returns true if valid, false otherwise
 */
export function isValidSecurityLevel(level: number): boolean {
  return level >= SecurityLevel.INTERNAL && level <= SecurityLevel.TOP_SECRET;
}
