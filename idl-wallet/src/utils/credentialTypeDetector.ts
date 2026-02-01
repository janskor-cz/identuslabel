/**
 * Credential Type Detection and Classification Utility
 *
 * Provides reliable credential type detection, clearance level color mapping,
 * and expiration checking for enhanced credential display.
 *
 * Created: November 2, 2025
 * Updated: December 14, 2025 - Added CertificationAuthorityIdentity type, multi-method credentialSubject extraction
 * Purpose: Support grouped credential display with type-specific layouts
 */

export type CredentialType = 'RealPersonIdentity' | 'SecurityClearance' | 'ServiceConfiguration' | 'EmployeeRole' | 'CISTrainingCertificate' | 'DocumentCopy' | 'CertificationAuthorityIdentity' | 'Unknown';
export type ClearanceLevel = 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'TOP-SECRET';
export type ClearanceColor = 'green' | 'blue' | 'orange' | 'red' | 'gray';

/**
 * Extract credentialSubject from credential object
 *
 * Handles multiple credential formats:
 * 1. SDK JWTCredential with properties Map (primary for issued credentials)
 * 2. Direct credentialSubject property (W3C format)
 * 3. claims array (alternative format)
 * 4. vc.credentialSubject (nested JWT format)
 *
 * @param credential - Credential object to extract subject from
 * @returns credentialSubject object or null if not found
 */
export function getCredentialSubject(credential: any): any {
  if (!credential) return null;

  console.log('[getCredentialSubject] INPUT:', {
    hasProperties: !!credential.properties,
    propertiesType: credential.properties?.constructor?.name,
    keys: Object.keys(credential)
  });

  // Method 1: Try class getter directly (if prototype intact)
  try {
    const directSubject = credential.credentialSubject;
    console.log('[getCredentialSubject] Method 1 result:', directSubject ? 'FOUND' : 'null/undefined');
    if (directSubject && typeof directSubject === 'object') {
      return directSubject;
    }
  } catch (e) {
    console.log('[getCredentialSubject] Method 1 threw:', e);
  }

  // Method 2: Try properties Map with explicit function check
  if (credential.properties && typeof credential.properties.get === 'function') {
    try {
      const vc = credential.properties.get('vc');
      console.log('[getCredentialSubject] Method 2 (Map.get) vc:', vc ? 'FOUND' : 'null');
      if (vc?.credentialSubject) {
        console.log('[getCredentialSubject] Method 2 returning credentialSubject');
        return vc.credentialSubject;
      }
    } catch (e) {
      console.log('[getCredentialSubject] Method 2 threw:', e);
    }
  }

  // Method 3: Try properties Map iteration (most reliable for SDK JWTCredential)
  if (credential.properties && typeof credential.properties.forEach === 'function') {
    let vcValue: any = null;
    credential.properties.forEach((value: any, key: any) => {
      console.log('[getCredentialSubject] Method 3 iterating key:', key);
      if (key === 'vc' || String(key) === 'vc') {
        vcValue = value;
      }
    });
    console.log('[getCredentialSubject] Method 3 vcValue:', vcValue ? 'FOUND' : 'null');
    if (vcValue?.credentialSubject) {
      console.log('[getCredentialSubject] Method 3 returning credentialSubject');
      return vcValue.credentialSubject;
    }
  }

  // Method 4: Try properties as plain object (if Map was serialized)
  if (credential.properties && typeof credential.properties === 'object' &&
      !(credential.properties instanceof Map)) {
    const vcObj = credential.properties.vc || credential.properties['vc'];
    console.log('[getCredentialSubject] Method 4 vcObj:', vcObj ? 'FOUND' : 'null');
    if (vcObj?.credentialSubject) {
      return vcObj.credentialSubject;
    }
  }

  // Method 5: Legacy fallbacks
  console.log('[getCredentialSubject] Method 5 - trying legacy fallbacks');
  console.log('[getCredentialSubject] claims[0]:', credential.claims?.[0] ? 'FOUND' : 'null');
  console.log('[getCredentialSubject] vc.credentialSubject:', credential.vc?.credentialSubject ? 'FOUND' : 'null');
  if (credential.claims?.[0]) return credential.claims[0];
  if (credential.vc?.credentialSubject) return credential.vc.credentialSubject;

  console.log('[getCredentialSubject] ALL METHODS FAILED - returning null');
  return null;
}

/**
 * Detect credential type from credential object
 *
 * Checks multiple locations for credentialType field:
 * 1. properties Map -> vc -> credentialSubject (SDK JWTCredential)
 * 2. credential.credentialSubject.credentialType
 * 3. credential.claims[0].credentialType (if claims array exists)
 * 4. credential.vc.credentialSubject.credentialType (JWT format)
 *
 * @param credential - Credential object to analyze
 * @returns Detected credential type or 'Unknown'
 */
export function getCredentialType(credential: any): CredentialType {
  if (!credential) {
    return 'Unknown';
  }

  // Use helper to get subject from any credential format (including properties Map)
  const subject = getCredentialSubject(credential);
  console.log('[getCredentialType] Subject:', subject);
  console.log('[getCredentialType] Subject keys:', subject ? Object.keys(subject) : 'null');
  console.log('[getCredentialType] credentialType field:', subject?.credentialType);

  if (subject?.credentialType) {
    const propsType = subject.credentialType;
    console.log('[getCredentialType] Detected type:', propsType);
    if (propsType === 'RealPersonIdentity') return 'RealPersonIdentity';
    if (propsType === 'SecurityClearance') return 'SecurityClearance';
    if (propsType === 'ServiceConfiguration') return 'ServiceConfiguration';
    if (propsType === 'EmployeeRole') return 'EmployeeRole';
    if (propsType === 'CISTrainingCertificate') return 'CISTrainingCertificate';
    if (propsType === 'DocumentCopy') return 'DocumentCopy';
    if (propsType === 'CertificationAuthorityIdentity') return 'CertificationAuthorityIdentity';
  }

  // Legacy checks for backward compatibility
  // Check credentialSubject.credentialType (standard location)
  const subjectType = credential.credentialSubject?.credentialType;
  if (subjectType === 'RealPersonIdentity') return 'RealPersonIdentity';
  if (subjectType === 'SecurityClearance') return 'SecurityClearance';
  if (subjectType === 'ServiceConfiguration') return 'ServiceConfiguration';
  if (subjectType === 'EmployeeRole') return 'EmployeeRole';
  if (subjectType === 'CISTrainingCertificate') return 'CISTrainingCertificate';
  if (subjectType === 'DocumentCopy') return 'DocumentCopy';
  if (subjectType === 'CertificationAuthorityIdentity') return 'CertificationAuthorityIdentity';

  // Check claims[0].credentialType (alternative location)
  const claimsType = credential.claims?.[0]?.credentialType;
  if (claimsType === 'RealPersonIdentity') return 'RealPersonIdentity';
  if (claimsType === 'SecurityClearance') return 'SecurityClearance';
  if (claimsType === 'ServiceConfiguration') return 'ServiceConfiguration';
  if (claimsType === 'EmployeeRole') return 'EmployeeRole';
  if (claimsType === 'CISTrainingCertificate') return 'CISTrainingCertificate';
  if (claimsType === 'DocumentCopy') return 'DocumentCopy';
  if (claimsType === 'CertificationAuthorityIdentity') return 'CertificationAuthorityIdentity';

  // Check vc.credentialSubject.credentialType (JWT format)
  const vcType = credential.vc?.credentialSubject?.credentialType;
  if (vcType === 'RealPersonIdentity') return 'RealPersonIdentity';
  if (vcType === 'SecurityClearance') return 'SecurityClearance';
  if (vcType === 'ServiceConfiguration') return 'ServiceConfiguration';
  if (vcType === 'EmployeeRole') return 'EmployeeRole';
  if (vcType === 'CISTrainingCertificate') return 'CISTrainingCertificate';
  if (vcType === 'DocumentCopy') return 'DocumentCopy';
  if (vcType === 'CertificationAuthorityIdentity') return 'CertificationAuthorityIdentity';

  // Check vc.type array for ServiceConfiguration (W3C VC format)
  const vcTypeArray = credential.vc?.type || credential.type;
  if (Array.isArray(vcTypeArray) && vcTypeArray.includes('ServiceConfiguration')) {
    return 'ServiceConfiguration';
  }
  if (Array.isArray(vcTypeArray) && vcTypeArray.includes('CISTrainingCertificate')) {
    return 'CISTrainingCertificate';
  }
  if (Array.isArray(vcTypeArray) && vcTypeArray.includes('CertificationAuthorityIdentity')) {
    return 'CertificationAuthorityIdentity';
  }

  // Detect ServiceConfiguration by field signature (enterpriseAgentUrl + enterpriseAgentApiKey)
  // Use the already-extracted subject from getCredentialSubject() above
  if (subject?.enterpriseAgentUrl && subject?.enterpriseAgentApiKey) {
    return 'ServiceConfiguration';
  }

  // Detect EmployeeRole by field signature (employeeId + email + role + department)
  if (subject?.employeeId && subject?.email && subject?.role && subject?.department) {
    return 'EmployeeRole';
  }

  // Detect CISTrainingCertificate by field signature (certificateNumber + trainingYear + completionDate)
  if (subject?.certificateNumber && subject?.trainingYear && subject?.completionDate) {
    return 'CISTrainingCertificate';
  }

  // Detect DocumentCopy by field signature (ephemeralDID + ephemeralServiceEndpoint)
  if (subject?.ephemeralDID && subject?.ephemeralServiceEndpoint) {
    return 'DocumentCopy';
  }

  // Detect CertificationAuthorityIdentity by field signature (website + issuedDate)
  if (subject?.website && subject?.issuedDate && !subject?.employeeId) {
    return 'CertificationAuthorityIdentity';
  }

  console.warn('[credentialTypeDetector] Could not determine credential type:', credential);
  return 'Unknown';
}

/**
 * Get Tailwind color class for clearance level badge
 *
 * Color mapping:
 * - INTERNAL: Green (bg-green-500, text-green-800, border-green-600)
 * - CONFIDENTIAL: Blue (bg-blue-500, text-blue-800, border-blue-600)
 * - RESTRICTED: Orange (bg-orange-500, text-orange-800, border-orange-600)
 * - TOP-SECRET: Red (bg-red-500, text-red-800, border-red-600)
 *
 * @param level - Clearance level string (case-insensitive)
 * @returns Tailwind color name
 */
export function getClearanceLevelColor(level: string | undefined): ClearanceColor {
  if (!level) return 'gray';

  const normalizedLevel = level.toUpperCase().trim();

  switch (normalizedLevel) {
    case 'INTERNAL':
      return 'green';
    case 'CONFIDENTIAL':
      return 'blue';
    case 'RESTRICTED':
      return 'orange';
    case 'TOP-SECRET':
    case 'TOP SECRET':
    case 'TOPSECRET':
      return 'red';
    default:
      console.warn('[credentialTypeDetector] Unknown clearance level:', level);
      return 'gray';
  }
}

/**
 * Get full Tailwind CSS classes for clearance level badge
 *
 * @param level - Clearance level string
 * @returns Object with className strings for different badge elements
 */
export function getClearanceBadgeClasses(level: string | undefined) {
  const color = getClearanceLevelColor(level);

  const colorMap = {
    green: {
      background: 'bg-green-100',
      text: 'text-green-800',
      border: 'border-green-600',
      badgeBg: 'bg-green-500'
    },
    blue: {
      background: 'bg-blue-100',
      text: 'text-blue-800',
      border: 'border-blue-600',
      badgeBg: 'bg-blue-500'
    },
    orange: {
      background: 'bg-orange-100',
      text: 'text-orange-800',
      border: 'border-orange-600',
      badgeBg: 'bg-orange-500'
    },
    red: {
      background: 'bg-red-100',
      text: 'text-red-800',
      border: 'border-red-600',
      badgeBg: 'bg-red-500'
    },
    gray: {
      background: 'bg-gray-100',
      text: 'text-gray-800',
      border: 'border-gray-600',
      badgeBg: 'bg-gray-500'
    }
  };

  return colorMap[color];
}

/**
 * Check if credential is expired based on expiryDate field
 *
 * Checks multiple locations for expiryDate:
 * 1. credential.credentialSubject.expiryDate
 * 2. credential.claims[0].expiryDate
 * 3. credential.vc.credentialSubject.expiryDate
 * 4. credential.expirationDate (W3C standard field name)
 *
 * @param credential - Credential object to check
 * @returns True if credential is expired, false otherwise
 */
export function isCredentialExpired(credential: any): boolean {
  if (!credential) {
    return false;
  }

  // Use getCredentialSubject helper to handle all credential formats
  const subject = getCredentialSubject(credential);

  // Try multiple locations for expiry date
  const expiryDate =
    subject?.expiryDate ||
    credential.expirationDate;

  if (!expiryDate) {
    // No expiry date = never expires
    return false;
  }

  try {
    const expiryTimestamp = new Date(expiryDate).getTime();
    const nowTimestamp = Date.now();
    return nowTimestamp > expiryTimestamp;
  } catch (error) {
    console.warn('[credentialTypeDetector] Invalid expiry date format:', expiryDate);
    return false;
  }
}

/**
 * Get credential holder name from credential
 *
 * Checks multiple locations:
 * - RealPersonIdentity: firstName + lastName
 * - SecurityClearance: holderName
 * - Fallback: "Unknown"
 *
 * @param credential - Credential object
 * @returns Full name of credential holder
 */
export function getCredentialHolderName(credential: any): string {
  if (!credential) {
    return 'Unknown';
  }

  // Use getCredentialSubject helper to handle all credential formats
  const subject = getCredentialSubject(credential);

  if (!subject) {
    return 'Unknown';
  }

  // RealPersonIdentity: firstName + lastName
  if (subject.firstName && subject.lastName) {
    return `${subject.firstName} ${subject.lastName}`;
  }

  // SecurityClearance: holderName
  if (subject.holderName) {
    return subject.holderName;
  }

  // Fallback
  return 'Unknown';
}

/**
 * Sort credentials alphabetically by holder name
 *
 * @param credentials - Array of credential objects
 * @returns Sorted array (A-Z by name)
 */
export function sortCredentialsAlphabetically(credentials: any[]): any[] {
  return [...credentials].sort((a, b) => {
    const nameA = getCredentialHolderName(a).toLowerCase();
    const nameB = getCredentialHolderName(b).toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/**
 * Document Copy credential information
 */
export interface DocumentCopyInfo {
  ephemeralDID: string;
  ephemeralServiceEndpoint: string;
  originalDocumentDID: string;
  title: string;
  classification: string;
  clearanceLevelGranted: string;
  redactedSectionCount: number;
  visibleSectionCount: number;
  expiresAt: string;
  viewsAllowed: number;
  isExpired: boolean;
  timeRemaining: string;
}

/**
 * Extract DocumentCopy information from credential
 *
 * @param credential - DocumentCopy credential object
 * @returns DocumentCopyInfo object or null if not a DocumentCopy credential
 */
export function getDocumentCopyInfo(credential: any): DocumentCopyInfo | null {
  if (!credential) return null;

  // Use getCredentialSubject helper to handle all credential formats
  const subject = getCredentialSubject(credential);
  if (!subject) return null;

  // Check if this is a DocumentCopy credential
  if (!subject.ephemeralDID || !subject.ephemeralServiceEndpoint) {
    return null;
  }

  // Parse expiration
  const expiresAt = subject.expiresAt || credential.expirationDate;
  const expiryDate = expiresAt ? new Date(expiresAt) : null;
  const now = new Date();
  const isExpired = expiryDate ? expiryDate < now : false;

  // Calculate time remaining
  let timeRemaining = 'Unknown';
  if (expiryDate && !isExpired) {
    const diffMs = expiryDate.getTime() - now.getTime();
    const diffMins = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      timeRemaining = `${diffDays}d ${diffHours % 24}h`;
    } else if (diffHours > 0) {
      timeRemaining = `${diffHours}h ${diffMins % 60}m`;
    } else {
      timeRemaining = `${diffMins}m`;
    }
  } else if (isExpired) {
    timeRemaining = 'EXPIRED';
  }

  return {
    ephemeralDID: subject.ephemeralDID,
    ephemeralServiceEndpoint: subject.ephemeralServiceEndpoint,
    originalDocumentDID: subject.originalDocumentDID || '',
    title: subject.title || 'Untitled Document',
    classification: subject.classification || 'UNCLASSIFIED',
    clearanceLevelGranted: subject.clearanceLevelGranted || 'UNCLASSIFIED',
    redactedSectionCount: subject.redactedSectionCount || 0,
    visibleSectionCount: subject.visibleSectionCount || 0,
    expiresAt: expiresAt || '',
    viewsAllowed: subject.viewsAllowed ?? -1,
    isExpired,
    timeRemaining
  };
}

/**
 * Filter credentials to get only DocumentCopy credentials
 *
 * @param credentials - Array of credential objects
 * @returns Array of credentials that are DocumentCopy type
 */
export function filterDocumentCopyCredentials(credentials: any[]): any[] {
  return credentials.filter(cred => getCredentialType(cred) === 'DocumentCopy');
}
