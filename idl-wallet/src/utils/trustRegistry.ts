/**
 * Universal Trust Registry for Self-Sovereign Identity (SSI) Wallet
 *
 * Implements wallet-side trust decisions for verifiable credentials.
 * Based on SSI standards where the verifier (wallet) controls trust, not the issuer.
 *
 * Standards Alignment:
 * - Trust Over IP Foundation: Trust Registry V1 Specification
 * - W3C CCG: Verifiable Issuers and Verifiers Specification
 * - EUDI Wallet: Architecture and Reference Framework (ARF)
 *
 * Trust Model: Client-side trusted issuer registry (TIR)
 * - Wallet queries local registry for trust decisions
 * - Trust decisions made by wallet (verifier), not server (issuer)
 * - Supports credential type-specific authorization
 */

/**
 * Trusted issuer configuration
 * Maps issuer DID to metadata about authorization and credential types
 */
export interface TrustedIssuer {
  /** Human-readable name of the issuer */
  name: string;

  /** Credential types this issuer is authorized to issue */
  authorizedCredentialTypes: string[];

  /** Optional: Organization type (CA, Company, Government, etc.) */
  organizationType?: string;

  /** Optional: Jurisdiction or governance framework */
  jurisdiction?: string;

  /** Optional: When this trust entry was established */
  trustedSince?: string;
}

/**
 * Trust Registry: Wallet's local list of trusted issuers
 *
 * IMPORTANT: This is the single source of truth for trust decisions.
 * To add a new trusted issuer, add an entry to this map.
 */
const TRUSTED_ISSUERS: Record<string, TrustedIssuer> = {
  /**
   * Primary Certification Authority
   * Trusted to issue all credential types in this ecosystem
   */
  'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c': {
    name: 'Certification Authority',
    authorizedCredentialTypes: [
      'SecurityClearance',
      'CompanyIdentity',
      'RealPerson',
      'EmployeeIdentity',
      'OrganizationCredential'
    ],
    organizationType: 'Certification Authority',
    jurisdiction: 'Hyperledger Identus Ecosystem',
    trustedSince: '2025-01-01'
  }

  /**
   * Example: How to add additional trusted issuers
   *
   * 'did:prism:abc123...': {
   *   name: 'Government Identity Service',
   *   authorizedCredentialTypes: ['RealPerson', 'NationalID'],
   *   organizationType: 'Government',
   *   jurisdiction: 'Czech Republic'
   * }
   */
};

/**
 * Check if an issuer DID is trusted by this wallet
 *
 * @param issuerDID - The DID of the credential issuer
 * @param credentialType - Optional: Check if issuer is authorized for specific credential type
 * @returns True if issuer is trusted (and authorized for credential type if specified)
 */
export function isTrustedIssuer(issuerDID: string, credentialType?: string): boolean {
  console.log(`🔍 [Trust Registry] Checking trust for issuer: ${issuerDID}`);

  if (credentialType) {
    console.log(`🔍 [Trust Registry] Checking authorization for credential type: ${credentialType}`);
  }

  // Check if issuer exists in trust registry
  const trustedIssuer = TRUSTED_ISSUERS[issuerDID];

  if (!trustedIssuer) {
    console.warn(`⚠️ [Trust Registry] Issuer NOT in trust registry: ${issuerDID}`);
    return false;
  }

  console.log(`✅ [Trust Registry] Issuer found in trust registry: ${trustedIssuer.name}`);

  // If credential type specified, check authorization
  if (credentialType) {
    const isAuthorized = trustedIssuer.authorizedCredentialTypes.includes(credentialType);

    if (!isAuthorized) {
      console.warn(
        `⚠️ [Trust Registry] Issuer ${trustedIssuer.name} is NOT authorized for credential type: ${credentialType}`
      );
      console.warn(
        `⚠️ [Trust Registry] Authorized types: ${trustedIssuer.authorizedCredentialTypes.join(', ')}`
      );
      return false;
    }

    console.log(
      `✅ [Trust Registry] Issuer ${trustedIssuer.name} is AUTHORIZED for credential type: ${credentialType}`
    );
  }

  return true;
}

/**
 * Get trusted issuer information
 *
 * @param issuerDID - The DID of the issuer
 * @returns Trusted issuer metadata or null if not trusted
 */
export function getTrustedIssuerInfo(issuerDID: string): TrustedIssuer | null {
  return TRUSTED_ISSUERS[issuerDID] || null;
}

/**
 * Get all trusted issuer DIDs
 *
 * @returns Array of trusted issuer DIDs
 */
export function getAllTrustedIssuers(): string[] {
  return Object.keys(TRUSTED_ISSUERS);
}

/**
 * Get trusted issuers authorized for a specific credential type
 *
 * @param credentialType - The credential type to filter by
 * @returns Array of trusted issuer DIDs authorized for this credential type
 */
export function getTrustedIssuersForCredentialType(credentialType: string): string[] {
  return Object.entries(TRUSTED_ISSUERS)
    .filter(([_, issuer]) => issuer.authorizedCredentialTypes.includes(credentialType))
    .map(([did, _]) => did);
}

/**
 * Verify credential issuer against trust registry
 *
 * This is the main entry point for credential verification.
 * Call this function whenever accepting a credential to ensure it's from a trusted source.
 *
 * @param credential - The credential to verify (JWT or W3C VC format)
 * @returns Verification result with trust status and details
 */
export interface TrustVerificationResult {
  /** Whether the issuer is trusted */
  trusted: boolean;

  /** Issuer DID extracted from credential */
  issuerDID: string | null;

  /** Credential type (if determinable) */
  credentialType?: string;

  /** Trusted issuer information (if trusted) */
  issuerInfo?: TrustedIssuer;

  /** Human-readable verification message */
  message: string;
}

export function verifyCredentialTrust(credential: any): TrustVerificationResult {
  console.log('🔐 [Trust Registry] Verifying credential trust...');

  try {
    // Extract issuer DID from credential
    let issuerDID: string | null = null;
    let credentialType: string | undefined = undefined;

    // Handle JWT format
    if (typeof credential === 'string' || credential.credential) {
      const jwt = credential.credential || credential;

      // Decode JWT to extract issuer
      const jwtParts = jwt.split('.');
      if (jwtParts.length === 3) {
        const payloadBase64 = jwtParts[1];
        const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(payloadJson);

        issuerDID = payload.iss;
        credentialType = payload.vc?.type?.find((t: string) => t !== 'VerifiableCredential');
      }
    }
    // Handle W3C VC format
    else if (credential.issuer) {
      issuerDID = typeof credential.issuer === 'string'
        ? credential.issuer
        : credential.issuer.id;

      credentialType = credential.type?.find((t: string) => t !== 'VerifiableCredential');
    }

    if (!issuerDID) {
      console.error('❌ [Trust Registry] Could not extract issuer DID from credential');
      return {
        trusted: false,
        issuerDID: null,
        message: 'Could not extract issuer DID from credential'
      };
    }

    console.log(`🔍 [Trust Registry] Issuer DID: ${issuerDID}`);
    if (credentialType) {
      console.log(`🔍 [Trust Registry] Credential Type: ${credentialType}`);
    }

    // Check trust registry
    const trusted = isTrustedIssuer(issuerDID, credentialType);
    const issuerInfo = getTrustedIssuerInfo(issuerDID);

    if (trusted && issuerInfo) {
      return {
        trusted: true,
        issuerDID,
        credentialType,
        issuerInfo,
        message: `Credential issued by trusted authority: ${issuerInfo.name}`
      };
    } else {
      return {
        trusted: false,
        issuerDID,
        credentialType,
        message: 'Credential issuer is not in wallet trust registry (TOFU applies)'
      };
    }

  } catch (error) {
    console.error('❌ [Trust Registry] Error verifying credential trust:', error);
    return {
      trusted: false,
      issuerDID: null,
      message: `Trust verification failed: ${error instanceof Error ? error.message : 'unknown error'}`
    };
  }
}
