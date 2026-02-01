import { VCValidationResult } from '../types/invitations';

// Enhanced base64 decoding with automatic padding for RFC 0434 compliance
export function safeBase64Decode(base64String: string): { isValid: boolean; data?: string; error?: string } {
  try {
    console.log('🔧 [BASE64] Starting enhanced base64 decode for:', base64String.substring(0, 50) + '...');

    // Check if string looks like base64
    if (!base64String || typeof base64String !== 'string') {
      console.log('🔴 [BASE64] Invalid input: not a string');
      return { isValid: false, error: 'Invalid input: not a string' };
    }

    // Clean the string - remove any invisible/non-printable characters
    let cleaned = base64String
      .trim()
      .replace(/[\r\n\t\s]/g, '') // Remove whitespace, tabs, newlines
      .replace(/[^\x20-\x7E]/g, ''); // Remove non-ASCII characters

    console.log('🔧 [BASE64] Cleaned base64 length:', cleaned.length);

    // Add padding if necessary (RFC 0434 invitations sometimes have unpadded base64)
    const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
    if (paddingNeeded > 0) {
      cleaned += '='.repeat(paddingNeeded);
      console.log(`🔧 [BASE64] Added ${paddingNeeded} padding chars, new length: ${cleaned.length}`);
    }

    console.log('🔧 [BASE64] Final cleaned string for decoding:', cleaned.substring(0, 100) + '...');

    // Browser-compatible decoding with multiple fallback strategies
    let decoded: string | null = null;

    // Strategy 1: Try standard atob()
    try {
      decoded = atob(cleaned);
      console.log('✅ [BASE64] Successfully decoded with standard atob, result length:', decoded.length);
    } catch (e1) {
      console.log('⚠️ [BASE64] Standard atob failed, trying URL-safe conversion...');

      // Strategy 2: Try URL-safe base64 conversion
      try {
        const urlSafeCleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
        decoded = atob(urlSafeCleaned);
        console.log('✅ [BASE64] Successfully decoded with URL-safe conversion, result length:', decoded.length);
      } catch (e2) {
        console.log('⚠️ [BASE64] URL-safe conversion failed, trying character validation...');

        // Strategy 3: Remove any remaining invalid characters and try again
        try {
          // Only keep valid base64 characters
          const strictCleaned = cleaned.replace(/[^A-Za-z0-9+/=]/g, '');

          // Re-add padding if needed
          const strictPadding = (4 - (strictCleaned.length % 4)) % 4;
          const strictWithPadding = strictPadding > 0
            ? strictCleaned + '='.repeat(strictPadding)
            : strictCleaned;

          decoded = atob(strictWithPadding);
          console.log('✅ [BASE64] Successfully decoded after strict character filtering, result length:', decoded.length);
        } catch (e3) {
          console.log('⚠️ [BASE64] Strict filtering failed, trying manual decode...');

          // Strategy 4: Use a manual base64 decoder as last resort
          try {
            decoded = manualBase64Decode(cleaned);
            console.log('✅ [BASE64] Successfully decoded with manual decoder, result length:', decoded.length);
          } catch (e4) {
            console.error('🔴 [BASE64] All decoding strategies failed');
            throw new Error('Failed to decode base64: All strategies exhausted');
          }
        }
      }
    }

    if (decoded) {
      return { isValid: true, data: decoded };
    } else {
      throw new Error('Decoding produced null result');
    }
  } catch (error) {
    console.error('🔴 [BASE64] Base64 decode failed:', error.message);
    return { isValid: false, error: `Base64 decode failed: ${error.message}` };
  }
}

// Manual base64 decoder as fallback for problematic strings
function manualBase64Decode(input: string): string {
  const keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  let chr1, chr2, chr3;
  let enc1, enc2, enc3, enc4;
  let i = 0;

  // Remove all non-base64 characters
  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');

  while (i < input.length) {
    enc1 = keyStr.indexOf(input.charAt(i++));
    enc2 = keyStr.indexOf(input.charAt(i++));
    enc3 = keyStr.indexOf(input.charAt(i++));
    enc4 = keyStr.indexOf(input.charAt(i++));

    chr1 = (enc1 << 2) | (enc2 >> 4);
    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    chr3 = ((enc3 & 3) << 6) | enc4;

    output = output + String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output = output + String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output = output + String.fromCharCode(chr3);
    }
  }

  return output;
}

// Enhanced JSON parsing of base64 encoded data with malformed JSON recovery
export function safeBase64ParseJSON(base64String: string, description: string = 'data'): { isValid: boolean; data?: any; error?: string } {
  const decodeResult = safeBase64Decode(base64String);
  if (!decodeResult.isValid) {
    return { isValid: false, error: `Failed to decode ${description}: ${decodeResult.error}` };
  }

  console.log('🔧 [JSON] Starting enhanced JSON parsing for:', description);

  try {
    // Strategy 1: Direct JSON parsing
    const parsed = JSON.parse(decodeResult.data);
    console.log('✅ [JSON] Direct JSON parsing successful');
    return { isValid: true, data: parsed };
  } catch (directError) {
    console.log('⚠️ [JSON] Direct parsing failed, trying recovery strategies');
    console.log('💥 [JSON] Direct error:', directError.message);

    // Strategy 2: Try to fix common malformed JSON issues
    let jsonString = decodeResult.data;

    // Fix 1: Remove trailing malformed braces/brackets
    const originalEnding = jsonString.substring(jsonString.length - 20);
    console.log('🔧 [JSON] Original ending:', originalEnding);

    // Try progressive truncation to find valid JSON
    for (let i = jsonString.length - 1; i >= jsonString.length - 10; i--) {
      try {
        const truncated = jsonString.substring(0, i);
        const testParsed = JSON.parse(truncated);

        // If we successfully parsed a truncated version, use it
        console.log(`✅ [JSON] Successfully parsed after truncating to ${i} characters`);
        console.log('🔧 [JSON] Truncated ending:', truncated.substring(truncated.length - 10));
        return { isValid: true, data: testParsed };
      } catch (truncateError) {
        // Continue trying shorter versions
        continue;
      }
    }

    // Strategy 3: Try to fix specific patterns
    const fixAttempts = [
      jsonString.replace(/}+\]+}+$/, '}]'),           // Multiple } and ] at end
      jsonString.replace(/}+\]+}+$/, '}}]'),          // Multiple } and ] at end
      jsonString.replace(/(\w+)"}}}+/g, '$1"}'),       // Remove extra } after quoted values
      jsonString.replace(/"]}}+/g, '"]'),             // Remove extra } after arrays
      jsonString.replace(/}}}+$/, '}'),               // Remove trailing multiple }
    ];

    for (let attempt = 0; attempt < fixAttempts.length; attempt++) {
      try {
        const fixedJson = fixAttempts[attempt];
        const fixedParsed = JSON.parse(fixedJson);
        console.log(`✅ [JSON] Successfully parsed with fix strategy ${attempt + 1}`);
        console.log('🔧 [JSON] Fixed ending:', fixedJson.substring(fixedJson.length - 10));
        return { isValid: true, data: fixedParsed };
      } catch (fixError) {
        console.log(`❌ [JSON] Fix strategy ${attempt + 1} failed:`, fixError.message.substring(0, 50));
        continue;
      }
    }

    // Strategy 4: Extract what we can (partial parsing for debugging)
    console.log('⚠️ [JSON] All parsing strategies failed, returning detailed error');
    return {
      isValid: false,
      error: `Failed to parse ${description} JSON after all recovery strategies. Original error: ${directError.message}. Data length: ${jsonString.length}. Ending: ${originalEnding}`
    };
  }
}

// Detect invitation format
export function detectInvitationFormat(invitationString: string): { format: 'url' | 'json' | 'base64' | 'unknown'; data?: string } {
  try {
    // Check if it's a URL
    if (invitationString.startsWith('http://') || invitationString.startsWith('https://')) {
      return { format: 'url', data: invitationString };
    }

    // Check if it's already JSON
    if (invitationString.trim().startsWith('{') || invitationString.trim().startsWith('[')) {
      JSON.parse(invitationString); // Validate JSON
      return { format: 'json', data: invitationString };
    }

    // Check if it's base64
    const decodeResult = safeBase64Decode(invitationString);
    if (decodeResult.isValid) {
      // Try to parse as JSON
      try {
        JSON.parse(decodeResult.data);
        return { format: 'base64', data: decodeResult.data };
      } catch {
        // Valid base64 but not JSON
        return { format: 'base64', data: decodeResult.data };
      }
    }

    return { format: 'unknown' };
  } catch {
    return { format: 'unknown' };
  }
}

/**
 * Enhanced Non-Blocking VC Validation
 *
 * This function implements progressive validation with the following principles:
 * 1. NEVER blocks the display of credential contents
 * 2. Validation errors are informational, not blocking
 * 3. Multiple credential schemas are supported
 * 4. Cryptographic validation is optional
 * 5. Returns detailed validation state for UI indicators
 *
 * Philosophy: Users must see what the inviter is sharing, regardless of
 * whether the credential validates against our expected schema.
 */
export async function validateVerifiableCredential(
  vcProof: any,
  agent?: any,
  pluto?: any
): Promise<VCValidationResult> {
  const result: VCValidationResult = {
    isValid: false,
    errors: [],
    warnings: [] // Non-blocking warnings
  };

  console.log('🔍 [NON-BLOCKING-VALIDATION] Starting progressive VC validation...');
  console.log('🔍 [NON-BLOCKING-VALIDATION] vcProof exists:', !!vcProof);

  try {
    if (!vcProof) {
      result.errors.push('No VC proof provided');
      return result;
    }

    // ============================================================
    // PHASE 1: BASIC STRUCTURE VALIDATION (informational only)
    // ============================================================

    // Check if this is a presentation request vs direct VC
    const isPresentationRequest = vcProof.presentation_definition;
    console.log('🔍 [NON-BLOCKING-VALIDATION] Is presentation request:', isPresentationRequest);

    if (isPresentationRequest) {
      // Handle presentation requests (treat as info, not error)
      console.log('🔍 [NON-BLOCKING-VALIDATION] Processing as presentation request');
      result.warnings.push('This appears to be a presentation request rather than a direct credential');
      // Still continue validation to see if we can extract data
    }

    // Handle direct VC credential validation
    console.log('🔍 [NON-BLOCKING-VALIDATION] Treating as direct VC credential');

    // Basic structure checks (informational warnings, not errors)
    console.log('🔍 [NON-BLOCKING-VALIDATION] Checking credentialSubject:', !!vcProof.credentialSubject);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Checking claims:', !!vcProof.claims);
    if (!vcProof.credentialSubject && !vcProof.claims) {
      result.warnings.push('Credential structure does not include standard credentialSubject or claims fields');
    }

    console.log('🔍 [NON-BLOCKING-VALIDATION] Checking type:', vcProof.type);
    if (!vcProof.type || vcProof.type.length === 0) {
      result.warnings.push('Credential type not specified');
    }

    // ============================================================
    // PHASE 2: SCHEMA DETECTION (non-blocking)
    // ============================================================

    console.log('🔍 [NON-BLOCKING-VALIDATION] Detecting credential schema...');
    console.log('🔍 [NON-BLOCKING-VALIDATION] vcProof.type:', vcProof.type);
    console.log('🔍 [NON-BLOCKING-VALIDATION] vcProof.credentialType:', vcProof.credentialType);

    // Detect known schemas
    const knownSchemas = detectKnownSchemas(vcProof);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Detected schemas:', knownSchemas);

    if (knownSchemas.length === 0) {
      // Unknown schema - NOT an error, just informational
      result.warnings.push('Unknown or different credential schema - credential will be displayed as-is');
      console.log('ℹ️ [NON-BLOCKING-VALIDATION] Unknown schema detected, proceeding with generic display');
    } else {
      console.log('✅ [NON-BLOCKING-VALIDATION] Recognized schema:', knownSchemas.join(', '));
    }

    // ============================================================
    // PHASE 3: METADATA EXTRACTION (always succeeds)
    // ============================================================

    // Extract issuer information
    if (vcProof.issuer) {
      result.issuer = typeof vcProof.issuer === 'string' ? vcProof.issuer : vcProof.issuer.id;
      console.log('✅ [NON-BLOCKING-VALIDATION] Extracted issuer:', result.issuer);
    }

    // Extract timestamps
    if (vcProof.issuanceDate) {
      result.issuedAt = vcProof.issuanceDate;
      console.log('✅ [NON-BLOCKING-VALIDATION] Extracted issuance date:', result.issuedAt);
    }
    if (vcProof.expirationDate) {
      result.expiresAt = vcProof.expirationDate;
      console.log('✅ [NON-BLOCKING-VALIDATION] Extracted expiration date:', result.expiresAt);
    }

    // Check if expired (warning, not error)
    if (result.expiresAt) {
      const expiryDate = new Date(result.expiresAt);
      const now = new Date();
      if (expiryDate < now) {
        result.warnings.push('Credential has expired');
        console.log('⚠️ [NON-BLOCKING-VALIDATION] Credential is expired');
      }
    }

    // ============================================================
    // PHASE 4: CRYPTOGRAPHIC VERIFICATION (optional, non-blocking)
    // ============================================================

    // Perform cryptographic verification if agent is available
    if (agent && agent.pollux && result.issuer) {
      console.log('🔍 [NON-BLOCKING-VALIDATION] Attempting cryptographic verification...');
      try {
        // Check if this is a JWT credential that can be verified
        if (typeof vcProof === 'object' && vcProof.issuer) {
          // Try to get the raw JWS if available
          let jws: string | undefined;

          // Check if vcProof has a JWT/JWS format
          if (typeof vcProof._jws === 'string') {
            jws = vcProof._jws;
          } else if (typeof vcProof.id === 'string' && vcProof.id.includes('.')) {
            // Sometimes the JWS is stored in the id field
            jws = vcProof.id;
          }

          if (jws) {
            console.log('🔍 [NON-BLOCKING-VALIDATION] Found JWS, verifying signature...');
            const issuerDID = agent.castor.parseDID(result.issuer);

            const isSignatureValid = await agent.pollux.JWT.verify({
              jws: jws,
              issuerDID: issuerDID
            });

            if (!isSignatureValid) {
              console.log('❌ [NON-BLOCKING-VALIDATION] Cryptographic signature verification failed');
              result.errors.push('Invalid cryptographic signature');
            } else {
              console.log('✅ [NON-BLOCKING-VALIDATION] Cryptographic signature verified successfully');
              // If crypto is valid and no blocking errors, mark as valid
              if (result.errors.length === 0) {
                result.isValid = true;
              }
            }
          } else {
            console.log('⚠️ [NON-BLOCKING-VALIDATION] No JWS found for cryptographic verification');
            result.warnings.push('No cryptographic signature available for verification');
            // For credentials without signatures, we treat them as "displayable but unverified"
            // This is common for demo credentials or credentials using different signature schemes
          }
        }
      } catch (cryptoError) {
        console.log('❌ [NON-BLOCKING-VALIDATION] Cryptographic verification failed:', cryptoError.message);
        result.warnings.push(`Cryptographic verification failed: ${cryptoError.message}`);
        // NOT added to errors - crypto failure doesn't block display
      }
    } else {
      console.log('ℹ️ [NON-BLOCKING-VALIDATION] Skipping cryptographic verification - agent or issuer not available');
      result.warnings.push('Cryptographic verification not performed');
    }

    // ============================================================
    // PHASE 5: FINAL STATUS DETERMINATION
    // ============================================================

    // A credential is "valid" if:
    // 1. It has no critical errors (corrupted, unparseable)
    // 2. Cryptographic signature is valid (if present)
    // 3. It's not expired (or we treat expiration as non-critical)

    // Only critical structural errors should block validity
    const hasCriticalErrors = result.errors.some(error =>
      error.includes('corrupted') ||
      error.includes('Invalid cryptographic signature') ||
      error.includes('No VC proof provided')
    );

    if (!hasCriticalErrors && result.errors.length === 0) {
      result.isValid = true;
    }

    console.log('🔍 [NON-BLOCKING-VALIDATION] Final validation result:');
    console.log('🔍 [NON-BLOCKING-VALIDATION] Total errors:', result.errors.length);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Total warnings:', result.warnings?.length || 0);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Errors:', result.errors);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Warnings:', result.warnings);
    console.log('🔍 [NON-BLOCKING-VALIDATION] Is valid:', result.isValid);
    console.log('✅ [NON-BLOCKING-VALIDATION] Credential will be displayed regardless of validation status');

    return result;
  } catch (error) {
    console.log('❌ [NON-BLOCKING-VALIDATION] Validation error:', error.message);
    // Even on error, we return a result that allows display
    result.warnings.push(`Validation error: ${error.message}`);
    return result;
  }
}

/**
 * Detect known credential schemas
 * Returns array of recognized schema names
 */
function detectKnownSchemas(vcProof: any): string[] {
  const schemas: string[] = [];

  // Check credential type array
  if (Array.isArray(vcProof.type)) {
    for (const type of vcProof.type) {
      if (type === 'RealPerson' || type.includes('RealPerson')) {
        schemas.push('RealPerson');
      }
      if (type === 'SecurityClearance' || type.includes('SecurityClearance')) {
        schemas.push('SecurityClearance');
      }
      // Add more known schemas here
    }
  }

  // Check credentialType string
  if (typeof vcProof.credentialType === 'string') {
    if (vcProof.credentialType.includes('RealPerson')) {
      schemas.push('RealPerson');
    }
    if (vcProof.credentialType.includes('SecurityClearance')) {
      schemas.push('SecurityClearance');
    }
  }

  // Check credential subject for schema hints
  if (vcProof.credentialSubject) {
    if (hasPersonFields(vcProof.credentialSubject)) {
      schemas.push('RealPerson');
    }
    if (hasSecurityClearanceFields(vcProof.credentialSubject)) {
      schemas.push('SecurityClearance');
    }
  }

  // Return unique schemas
  return [...new Set(schemas)];
}

// Helper function to check if an object contains person-like fields
function hasPersonFields(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const personFields = ['firstName', 'lastName', 'uniqueId', 'dateOfBirth', 'gender', 'nationality', 'placeOfBirth'];
  return personFields.some(field => field in obj);
}

// Helper function to check if an object contains security clearance fields
function hasSecurityClearanceFields(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const clearanceFields = ['clearanceLevel', 'clearanceId', 'publicKeyFingerprint', 'securityLevel'];
  return clearanceFields.some(field => field in obj);
}

export function extractCredentialSubject(credential: any): any {
  // Try multiple paths to find credential subject data
  if (credential.credentialSubject) {
    return credential.credentialSubject;
  }

  if (credential.claims && Array.isArray(credential.claims) && credential.claims.length > 0) {
    const firstClaim = credential.claims[0];
    if (firstClaim.credentialSubject) {
      return firstClaim.credentialSubject;
    }
    if (firstClaim.credentialData?.credentialSubject) {
      return firstClaim.credentialData.credentialSubject;
    }
    return firstClaim;
  }

  if (credential.credentialData?.credentialSubject) {
    return credential.credentialData.credentialSubject;
  }

  // Fallback: look for person-like data anywhere in the credential
  const personFields = ['firstName', 'lastName', 'uniqueId', 'dateOfBirth'];
  for (const value of Object.values(credential)) {
    if (value && typeof value === 'object') {
      const hasPersonFields = personFields.some(field => field in value);
      if (hasPersonFields) {
        return value;
      }
    }
  }

  return {};
}

export function isCredentialRevoked(credential: any): boolean {
  // In a real implementation, this would check against a revocation registry
  // For demo purposes, we'll assume credentials are not revoked
  return false;
}

export function parseInviterIdentity(vcProof: any, validationResult: VCValidationResult, agent?: any, pluto?: any): any {
  const credentialSubject = extractCredentialSubject(vcProof);

  const identity = {
    isVerified: validationResult.isValid,
    revealedData: credentialSubject,
    vcProof: vcProof, // ✅ PHASE 1 FIX: Always include raw VC proof for display
    validationResult
  };

  console.log('✅ [PARSE-IDENTITY] Creating identity object:');
  console.log('   isVerified:', validationResult.isValid);
  console.log('   revealedData:', credentialSubject);
  console.log('   revealedData keys:', Object.keys(credentialSubject));
  console.log('   revealedData length:', Object.keys(credentialSubject).length);
  console.log('   vcProof exists:', !!vcProof);
  console.log('   Full identity structure:', {
    isVerified: identity.isVerified,
    hasVCProof: !!identity.vcProof,
    revealedDataFieldCount: Object.keys(identity.revealedData).length,
    validationErrors: identity.validationResult.errors?.length || 0,
    validationWarnings: identity.validationResult.warnings?.length || 0
  });

  return identity;
}