export type DisclosureLevel = 'minimal' | 'standard' | 'full';

export interface RealPersonVCData {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  uniqueId?: string;
  gender?: string;
  nationality?: string;
  placeOfBirth?: string;
}

export interface SelectiveDisclosure {
  credential: any;
  revealedFields: string[];
  proofLevel: DisclosureLevel;
  hiddenFields: string[];
  timestamp: string;
}

export interface IdentityProofAttachment {
  id: string;
  media_type: string;
  data: {
    vcProof: string;
    proofLevel: DisclosureLevel;
    revealedFields: string[];
    timestamp: string;
    signature?: string;
  };
}

export interface EnhancedOOBInvitation {
  id: string;
  type: string;
  from: string;
  body: {
    accept: string[];
    handshake_protocols: string[];
  };
  attachments?: IdentityProofAttachment[];
}

export interface VCValidationResult {
  isValid: boolean;
  errors: string[];
  issuer?: string;
  issuedAt?: string;
  expiresAt?: string;
  revoked?: boolean;
}

/**
 * Extended validation result with cryptographic verification details
 */
export interface CryptographicValidationResult extends VCValidationResult {
  signatureVerified?: boolean;
  didResolved?: boolean;
  challengeVerified?: boolean;
  domainVerified?: boolean;
  verificationMethod?: string;
  proofType?: string;
}

/**
 * Configuration for presentation requests
 */
export interface PresentationRequestConfig {
  credentialType: string;
  requiredFields: string[];
  optionalFields?: string[];
  challenge?: string;
  domain?: string;
  expirationTime?: Date;
  description?: string;
}

/**
 * Security Clearance VC data structure
 */
export interface SecurityClearanceVCData {
  clearanceLevel?: 'RESTRICTED' | 'CONFIDENTIAL' | 'SECRET' | 'TOP SECRET';
  clearanceId?: string;
  holderUniqueId?: string;
  issuedDate?: string;
  expiryDate?: string;
  publicKeyFingerprint?: string;
  issuerOrganization?: string;
}

/**
 * Combined credential data supporting both RealPerson and SecurityClearance
 */
export interface CredentialSubjectData extends RealPersonVCData, SecurityClearanceVCData {
  // Combines all possible fields from both credential types
}

/**
 * Verification context for tracking verification requests
 */
export interface VerificationContext {
  requestId: string;
  timestamp: string;
  requester: string;
  purpose: string;
  challenge: string;
  domain?: string;
  credentialTypes: string[];
  requiredFields: string[];
  status: 'pending' | 'completed' | 'failed' | 'expired';
}

export interface InviterIdentity {
  isVerified: boolean;
  vcProof?: any;
  revealedData: RealPersonVCData;
  validationResult: VCValidationResult;
}

export const DISCLOSURE_PRESETS = {
  minimal: {
    label: 'Minimal (ID Only)',
    description: 'Share only your unique identifier',
    fields: ['uniqueId']
  },
  standard: {
    label: 'Standard (Name & ID)',
    description: 'Share your name and identifier',
    fields: ['firstName', 'lastName', 'uniqueId']
  },
  full: {
    label: 'Full Profile',
    description: 'Share all available information',
    fields: ['firstName', 'lastName', 'dateOfBirth', 'uniqueId', 'gender', 'nationality', 'placeOfBirth']
  }
} as const;

export const FIELD_LABELS = {
  firstName: 'First Name',
  lastName: 'Last Name',
  dateOfBirth: 'Date of Birth',
  uniqueId: 'Unique ID',
  gender: 'Gender',
  nationality: 'Nationality',
  placeOfBirth: 'Place of Birth'
} as const;