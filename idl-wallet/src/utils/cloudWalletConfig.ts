/**
 * Cloud Wallet Configuration Utility
 *
 * Extracts ServiceConfiguration credential data and queries Employee Cloud Agent
 * for the employee's PRISM DID to enable cloud wallet connection mode.
 *
 * SECURITY: Always verifies ServiceConfiguration VC revocation status before use
 *
 * Workflow:
 * 1. Find ServiceConfiguration credential in wallet
 * 2. **VERIFY REVOCATION STATUS** (CRITICAL - do not skip!)
 * 3. Extract: enterpriseAgentUrl, enterpriseAgentApiKey, enterpriseAgentName
 * 4. Query Employee Cloud Agent API for DIDs using employee's API key
 * 5. Return first PRISM DID (did:prism:...)
 *
 * @module cloudWalletConfig
 */

import { identifyCredentialType } from './credentialSchemaExtractor';
import { verifyCredentialStatus, CredentialStatus } from './credentialStatus';

export interface CloudWalletConfig {
  available: boolean;
  enterpriseAgentUrl?: string;
  enterpriseAgentApiKey?: string;
  enterpriseAgentName?: string;
  prismDid?: string;
  revocationStatus?: CredentialStatus;
  error?: string;
}

/**
 * Check if cloud wallet is available and extract configuration
 *
 * SECURITY: This function ALWAYS checks revocation status before returning config
 *
 * @param credentials - Array of credentials from Redux store
 * @returns {Promise<CloudWalletConfig>} Cloud wallet configuration
 */
export async function getCloudWalletConfig(credentials: any[]): Promise<CloudWalletConfig> {
  try {
    console.log('🔍 [CloudWallet] Checking for ServiceConfiguration credential...');

    // Find ServiceConfiguration credential
    const serviceConfigCred = credentials.find(cred => {
      const { type } = identifyCredentialType(cred);
      return type === 'ServiceConfiguration';
    });

    if (!serviceConfigCred) {
      console.log('ℹ️ [CloudWallet] No ServiceConfiguration credential found');
      return { available: false };
    }

    console.log('✅ [CloudWallet] ServiceConfiguration credential found');

    // CRITICAL: Check revocation status BEFORE using credential
    console.log('🔒 [CloudWallet] Verifying credential revocation status...');
    const revocationStatus = await verifyCredentialStatus(serviceConfigCred);

    if (revocationStatus.revoked) {
      console.error('🚫 [CloudWallet] ServiceConfiguration credential has been REVOKED');
      return {
        available: false,
        revocationStatus,
        error: 'ServiceConfiguration credential has been revoked by issuer'
      };
    }

    if (revocationStatus.suspended) {
      console.warn('⚠️ [CloudWallet] ServiceConfiguration credential is SUSPENDED');
      return {
        available: false,
        revocationStatus,
        error: 'ServiceConfiguration credential has been suspended'
      };
    }

    console.log('✅ [CloudWallet] Credential is valid (not revoked or suspended)');

    // Extract credential subject claims
    const claims = extractCredentialClaims(serviceConfigCred);

    if (!claims.enterpriseAgentUrl || !claims.enterpriseAgentApiKey) {
      console.error('❌ [CloudWallet] Missing required fields in ServiceConfiguration');
      return {
        available: false,
        revocationStatus,
        error: 'ServiceConfiguration credential is missing required fields'
      };
    }

    console.log('  → Enterprise Agent URL:', claims.enterpriseAgentUrl);
    console.log('  → Enterprise Agent Name:', claims.enterpriseAgentName);
    console.log('  → API Key:', claims.enterpriseAgentApiKey.substring(0, 16) + '...');

    // Query Employee Cloud Agent for PRISM DIDs
    console.log('🔍 [CloudWallet] Querying Enterprise Agent for PRISM DIDs...');
    const prismDid = await queryEmployeePrismDid(
      claims.enterpriseAgentUrl,
      claims.enterpriseAgentApiKey
    );

    if (!prismDid) {
      console.error('❌ [CloudWallet] No PRISM DID found on Enterprise Agent');
      return {
        available: false,
        enterpriseAgentUrl: claims.enterpriseAgentUrl,
        enterpriseAgentApiKey: claims.enterpriseAgentApiKey,
        enterpriseAgentName: claims.enterpriseAgentName,
        revocationStatus,
        error: 'No PRISM DID found on Enterprise Agent'
      };
    }

    console.log('✅ [CloudWallet] PRISM DID found:', prismDid.substring(0, 60) + '...');

    return {
      available: true,
      enterpriseAgentUrl: claims.enterpriseAgentUrl,
      enterpriseAgentApiKey: claims.enterpriseAgentApiKey,
      enterpriseAgentName: claims.enterpriseAgentName,
      prismDid,
      revocationStatus
    };

  } catch (error: any) {
    console.error('❌ [CloudWallet] Error checking cloud wallet config:', error);
    return {
      available: false,
      error: error.message || 'Unknown error'
    };
  }
}

/**
 * Verify ServiceConfiguration credential is still valid (not revoked)
 *
 * SECURITY: Call this before EVERY cloud wallet operation:
 * - Creating connections
 * - Sending messages
 * - Issuing credentials
 * - Any API call using the employee's API key
 *
 * @param credentials - Array of credentials from Redux store
 * @returns {Promise<boolean>} True if valid, false if revoked/suspended/missing
 */
export async function verifyServiceConfigNotRevoked(credentials: any[]): Promise<boolean> {
  try {
    console.log('🔒 [CloudWallet] Verifying ServiceConfiguration VC status...');

    // Find ServiceConfiguration credential
    const serviceConfigCred = credentials.find(cred => {
      const { type } = identifyCredentialType(cred);
      return type === 'ServiceConfiguration';
    });

    if (!serviceConfigCred) {
      console.error('❌ [CloudWallet] No ServiceConfiguration credential found');
      return false;
    }

    // Check revocation status
    const status = await verifyCredentialStatus(serviceConfigCred);

    if (status.revoked) {
      console.error('🚫 [CloudWallet] ServiceConfiguration credential is REVOKED');
      return false;
    }

    if (status.suspended) {
      console.warn('⚠️ [CloudWallet] ServiceConfiguration credential is SUSPENDED');
      return false;
    }

    console.log('✅ [CloudWallet] ServiceConfiguration credential is valid');
    return true;

  } catch (error: any) {
    console.error('❌ [CloudWallet] Error verifying ServiceConfiguration status:', error);
    return false;
  }
}

/**
 * Extract credential claims from ServiceConfiguration VC
 * Handles both JWT and JSON-LD formats
 */
function extractCredentialClaims(credential: any): {
  enterpriseAgentUrl: string;
  enterpriseAgentApiKey: string;
  enterpriseAgentName: string;
} {
  try {
    // Try JWT format first (most common)
    if (credential.credentialType === 'prism/jwt') {
      const jwtPayload = parseJWT(credential);
      if (jwtPayload?.vc?.credentialSubject) {
        return {
          enterpriseAgentUrl: jwtPayload.vc.credentialSubject.enterpriseAgentUrl,
          enterpriseAgentApiKey: jwtPayload.vc.credentialSubject.enterpriseAgentApiKey,
          enterpriseAgentName: jwtPayload.vc.credentialSubject.enterpriseAgentName
        };
      }
    }

    // Try JSON-LD format
    if (credential.credentialSubject) {
      return {
        enterpriseAgentUrl: credential.credentialSubject.enterpriseAgentUrl,
        enterpriseAgentApiKey: credential.credentialSubject.enterpriseAgentApiKey,
        enterpriseAgentName: credential.credentialSubject.enterpriseAgentName
      };
    }

    throw new Error('Unsupported credential format');

  } catch (error: any) {
    console.error('[CloudWallet] Error extracting claims:', error);
    throw error;
  }
}

/**
 * Parse JWT credential to extract payload
 * Accesses JWT string from credential.properties.get('jti')
 */
function parseJWT(credential: any): any {
  try {
    let jwtString: string | null = null;

    // Debug: Log credential structure
    console.log('[CloudWallet] Credential structure keys:', Object.keys(credential));
    console.log('[CloudWallet] Credential type:', typeof credential);

    // PRIMARY METHOD: Get JWT from properties Map (SDK JWTCredential stores in 'jti' property)
    if (credential.properties && typeof credential.properties.get === 'function') {
      jwtString = credential.properties.get('jti');
      if (jwtString) {
        console.log('[CloudWallet] ✅ Found JWT in properties.get("jti")');
      }
    }

    // FALLBACK METHOD 1: restorationId (older SDK versions)
    if (!jwtString && credential.restorationId && typeof credential.restorationId === 'string') {
      jwtString = credential.restorationId;
      console.log('[CloudWallet] Found JWT in restorationId');
    }
    // FALLBACK METHOD 2: credential property (some VC formats)
    else if (!jwtString && credential.credential && typeof credential.credential === 'string') {
      jwtString = credential.credential;
      console.log('[CloudWallet] Found JWT in credential property');
    }
    // FALLBACK METHOD 3: data property (alternative SDK format)
    else if (!jwtString && credential.data && typeof credential.data === 'string') {
      jwtString = credential.data;
      console.log('[CloudWallet] Found JWT in data property');
    }
    // FALLBACK METHOD 4: Credential IS the JWT string
    else if (!jwtString && typeof credential === 'string') {
      jwtString = credential;
      console.log('[CloudWallet] Credential itself is JWT string');
    }

    if (!jwtString) {
      console.error('[CloudWallet] JWT string not found. Credential keys:', Object.keys(credential));
      console.error('[CloudWallet] Credential has properties.get():', credential.properties && typeof credential.properties.get === 'function');
      console.error('[CloudWallet] Credential sample:', JSON.stringify(credential).substring(0, 500));
      throw new Error('No JWT string found in credential');
    }

    // Split JWT into parts
    const parts = jwtString.split('.');
    if (parts.length !== 3) {
      console.error('[CloudWallet] Invalid JWT format. Parts:', parts.length);
      throw new Error('Invalid JWT format');
    }

    // Decode payload (part 1)
    const payload = JSON.parse(atob(parts[1]));
    console.log('[CloudWallet] ✅ JWT parsed successfully');
    return payload;

  } catch (error: any) {
    console.error('[CloudWallet] Error parsing JWT:', error);
    throw error;
  }
}

/**
 * Query Employee Cloud Agent for employee's PRISM DIDs
 * Returns first PRISM DID found
 */
async function queryEmployeePrismDid(
  agentUrl: string,
  apiKey: string
): Promise<string | null> {
  try {
    const response = await fetch(`${agentUrl}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'apikey': apiKey
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CloudWallet] API request failed: ${response.status} ${errorText}`);
      return null;
    }

    const data = await response.json();
    console.log('[CloudWallet] DIDs response:', data);

    // Find first PRISM DID (did:prism:...)
    const dids = data.contents || data.dids || [];
    const prismDid = dids.find((did: any) => {
      const didString = did.did || did.longFormDid || did;
      return typeof didString === 'string' && didString.startsWith('did:prism:');
    });

    if (!prismDid) {
      console.warn('[CloudWallet] No PRISM DIDs found in response');
      return null;
    }

    // Return DID string (handle different response formats)
    return prismDid.did || prismDid.longFormDid || prismDid;

  } catch (error: any) {
    console.error('[CloudWallet] Error querying PRISM DID:', error);
    return null;
  }
}

/**
 * Validate cloud wallet configuration
 * Checks all required fields are present
 */
export function isCloudWalletConfigValid(config: CloudWalletConfig): boolean {
  return config.available === true &&
    !!config.enterpriseAgentUrl &&
    !!config.enterpriseAgentApiKey &&
    !!config.prismDid &&
    config.revocationStatus?.revoked === false &&
    config.revocationStatus?.suspended === false;
}

/**
 * Get user-friendly error message for cloud wallet unavailability
 */
export function getCloudWalletErrorMessage(config: CloudWalletConfig): string {
  if (config.error) {
    return config.error;
  }

  if (config.revocationStatus?.revoked) {
    return 'Your ServiceConfiguration credential has been revoked. Please contact your administrator.';
  }

  if (config.revocationStatus?.suspended) {
    return 'Your ServiceConfiguration credential has been suspended. Please contact your administrator.';
  }

  if (!config.available) {
    return 'Cloud wallet not configured. Please request a ServiceConfiguration credential from your company.';
  }

  return 'Cloud wallet configuration incomplete.';
}
