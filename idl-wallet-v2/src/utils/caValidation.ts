/**
 * CA (Certification Authority) Credential Validation Utility
 *
 * Validates CA Authority Identity credentials embedded in OOB invitations
 * for wallet initialization and trust establishment.
 */

/**
 * CA credential data structure from invitation attachment
 */
export interface CACredentialData {
  credential: string; // JWT
  claims: {
    organizationName: string;
    website: string;
    jurisdiction: string;
    registrationNumber: string;
    authorityLevel: string;
    cloudAgentEndpoint: string;
    didcommEndpoint: string;
    mediatorEndpoint: string;
    supportedProtocols: string[];
    [key: string]: any;
  };
  issuerDID: string;
  holderDID: string;
  credentialType: string;
  issuedDate: string;
}

/**
 * Validated CA configuration extracted from credential
 */
export interface ValidatedCAConfig {
  caDID: string;
  organizationName: string;
  website: string;
  jurisdiction: string;
  registrationNumber: string;
  authorityLevel: string;
  cloudAgentEndpoint: string;
  credentialJWT: string;
  claims: any;
}

/**
 * Parse CA credential from OOB invitation attachment
 *
 * @param invitation - DIDComm OOB invitation object
 * @returns CA credential data or null if not found
 */
export function parseCACredentialFromInvitation(invitation: any): CACredentialData | null {
  try {
    console.log('🔍 [CA Validation] Parsing CA credential from invitation');

    // Check if invitation has requests_attach
    if (!invitation.requests_attach || !Array.isArray(invitation.requests_attach)) {
      console.warn('⚠️ [CA Validation] No requests_attach found in invitation');
      return null;
    }

    // Find CA credential attachment
    const caAttachment = invitation.requests_attach.find(
      (att: any) => att['@id'] === 'ca-authority-credential'
    );

    if (!caAttachment) {
      console.warn('⚠️ [CA Validation] No CA authority credential attachment found');
      return null;
    }

    // Extract credential data
    const credentialData = caAttachment.data?.json;

    if (!credentialData) {
      console.warn('⚠️ [CA Validation] CA attachment has no data.json');
      return null;
    }

    console.log('✅ [CA Validation] CA credential found:', credentialData.credentialType);
    return credentialData as CACredentialData;

  } catch (error) {
    console.error('❌ [CA Validation] Error parsing CA credential:', error);
    return null;
  }
}

/**
 * Validate CA credential JWT signature and structure
 *
 * @param caCredential - CA credential data
 * @returns Validated CA configuration or throws error
 */
export async function validateCACredential(
  caCredential: CACredentialData
): Promise<ValidatedCAConfig> {
  console.log('🔐 [CA Validation] Validating CA credential...');

  // Basic structure validation
  if (!caCredential.credential) {
    throw new Error('CA credential JWT missing');
  }

  if (!caCredential.holderDID) {
    throw new Error('CA holder DID missing');
  }

  if (caCredential.credentialType !== 'CertificationAuthorityIdentity') {
    throw new Error(`Invalid credential type: ${caCredential.credentialType}`);
  }

  // Validate required claims
  const requiredClaims = [
    'organizationName',
    'website',
    'jurisdiction',
    'registrationNumber',
    'authorityLevel',
    'cloudAgentEndpoint'
  ];

  for (const claim of requiredClaims) {
    if (!caCredential.claims[claim]) {
      throw new Error(`Missing required claim: ${claim}`);
    }
  }

  // JWT signature validation (basic check)
  // In production, this would use the Identus SDK to verify the JWT signature
  // against the issuer's DID
  const jwtParts = caCredential.credential.split('.');
  if (jwtParts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  // Decode JWT payload to verify claims match
  try {
    const payloadBase64 = jwtParts[1];
    const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    console.log('✅ [CA Validation] JWT payload decoded');

    // Verify credential subject matches claims
    if (payload.vc?.credentialSubject) {
      const subject = payload.vc.credentialSubject;

      // Basic claim verification
      if (subject.organizationName !== caCredential.claims.organizationName) {
        throw new Error('JWT claims do not match provided claims');
      }
    }

  } catch (error) {
    console.error('❌ [CA Validation] JWT decoding error:', error);
    throw new Error(`Failed to decode JWT: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  console.log('✅ [CA Validation] CA credential valid');

  // Return validated configuration
  return {
    caDID: caCredential.holderDID,
    organizationName: caCredential.claims.organizationName,
    website: caCredential.claims.website,
    jurisdiction: caCredential.claims.jurisdiction,
    registrationNumber: caCredential.claims.registrationNumber,
    authorityLevel: caCredential.claims.authorityLevel,
    cloudAgentEndpoint: caCredential.claims.cloudAgentEndpoint,
    credentialJWT: caCredential.credential,
    claims: caCredential.claims
  };
}

/**
 * Parse base64-encoded OOB invitation
 *
 * @param oobBase64 - Base64-encoded OOB invitation
 * @returns Parsed invitation object
 */
export function parseOOBInvitation(oobBase64: string): any {
  try {
    const invitationJson = atob(oobBase64);
    return JSON.parse(invitationJson);
  } catch (error) {
    throw new Error(`Failed to parse OOB invitation: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Extract OOB parameter from invitation URL
 *
 * @param invitationUrl - Full invitation URL with _oob parameter
 * @returns Base64-encoded OOB invitation or null
 */
export function extractOOBFromURL(invitationUrl: string): string | null {
  try {
    const url = new URL(invitationUrl);
    const oobParam = url.searchParams.get('_oob');
    return oobParam;
  } catch (error) {
    console.error('❌ [CA Validation] Invalid invitation URL:', error);
    return null;
  }
}
