import { VCValidationResult } from '../types/invitations';
import { getCredentialType } from './credentialTypeDetector';

// Trusted issuer DID for RealPerson VCs — issued exclusively by the Certification Authority.
// Exported so utils/liveIdentityVerification.ts can pin the SAME trusted issuer when verifying a
// live, post-connection presentation — single source of truth, no drift between the pre-connection
// preview check here and the live check there.
export const TRUSTED_REALPERSON_ISSUER = 'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c';

// Trusted schema id for RealPerson VCs — the CA's current live schema (v4.0.0, photo-carrying;
// confirmed against certification-authority/server.js's ServiceAccessService capabilities and
// DIDComm-auth proof requests, which all pin this same schemaId as of the 2026-07-05 protocol
// migration commit). NOTE: this is intentionally NOT the same id as SCHEMA_GUID_MAP's 'RealPerson'
// entry in credentialSchemaExtractor.ts (e3ed8a7b-...) — that map is a best-effort structural-type
// *hint* built from an older/stale schema generation and is used for display purposes only; it is
// not a security control and must not be reused for pinning here. Exported so
// utils/liveIdentityVerification.ts can pin the SAME schema id when verifying a live, post-connection
// presentation — single source of truth, no drift between the pre-connection preview check here and
// the live check there (mirrors TRUSTED_REALPERSON_ISSUER above).
export const TRUSTED_REALPERSON_SCHEMA_ID = 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/4755a426-b80b-3f6a-b9ea-ca202bd7ce16';

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
 *
 * NOTE ON HOLDER BINDING: this function intentionally does NOT attempt to prove that the party
 * sending an invitation actually possesses the RealPerson VC's subject key — that turned out to
 * be unprovable at invitation time (see below) and has been moved to a POST-CONNECTION step.
 * What this function still verifies (issuer pinning + cryptographic signature, both still
 * blocking for RealPerson VCs — see the ISSUER PINNING and REALPERSON SIGNATURE ENFORCEMENT
 * blocks below) establishes only that the attached VC-JWT is a genuine, unexpired, CA-issued
 * credential for *someone* — a "claims to be X — unverified preview", not proof that today's
 * sender is X.
 *
 * History: an earlier version of this function required the invitation's `from` DID (a
 * freshly-minted did:peer:2, pairwise/relationship-scoped by design) to string-equal the VC's
 * own did:prism subject DID — CONFIRMED BROKEN in production, since different DID methods can
 * never be equal, so it rejected every legitimate RealPerson-VC-attached invitation. A follow-up
 * replaced that with a self-signed proof-of-possession JWT (utils/holderProofOfPossession.ts,
 * now removed) bound to the invitation id/connection DID/VC hash. An SSI compliance review found
 * that insufficient too: a self-signed proof with no live verifier-issued challenge cannot
 * actually prove *current* possession in a way that resists a captured/replayed invitation — an
 * OOB invitation is a one-shot, pre-connection artifact, so no live challenge/response is
 * possible before a connection exists.
 *
 * CURRENT DESIGN: let the connection establish on this lightweight preview alone. Once connected,
 * the accepting wallet sends a fresh, nonce-bound present-proof request back to the inviter over
 * the live DIDComm connection and verifies the (live-signed) response — including checking that
 * the live identity matches THIS preview's subject DID/uniqueId — before upgrading the
 * connection's trust state to "verified". See utils/liveIdentityVerification.ts and
 * components/OOB.tsx's post-connection handling for the live half of this design.
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
    // PRE-PROCESSING: Expand JWT-embedded format
    // ============================================================
    // createVCProofAttachment embeds the raw JWS so the ES256K signature can
    // be verified. Two formats exist:
    //   new: vcProof.jwt = "eyJ..." (raw 3-part JWS)
    //   old: vcProof.jwt = JSON string of { id: "eyJ...", vc: {...}, iss: "...", ... }
    // Extract the JWS from either format, decode the payload, and flatten it
    // onto vcProof so downstream phases see a standard VC-shaped object.
    if (typeof vcProof?.jwt === 'string') {
      let jws: string | null = null;
      const isRawJws = (s: any): s is string =>
        typeof s === 'string' && s.startsWith('eyJ') && s.split('.').length === 3;

      if (isRawJws(vcProof.jwt)) {
        jws = vcProof.jwt;
      }
      // JSON-wrapper fallback intentionally removed: extracting a JWS from
      // an unauthenticated JSON envelope allows JWS substitution attacks.
      // Senders now always embed the raw JWS directly.

      if (jws) {
        try {
          const b64 = jws.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(atob(b64));
          vcProof = {
            ...(payload.vc || {}),
            issuer: payload.iss || payload.vc?.issuer,
            issuanceDate: payload.iat
              ? new Date(payload.iat * 1000).toISOString()
              : payload.vc?.issuanceDate,
            expirationDate: payload.exp
              ? new Date(payload.exp * 1000).toISOString()
              : payload.vc?.expirationDate,
            // Holder-binding subject DID: prefer the JWT's own `sub` claim (the identifier
            // the issuer actually bound the credential to), falling back to
            // credentialSubject.id per the W3C VC-JWT convention.
            subjectDID: payload.sub || payload.vc?.credentialSubject?.id || null,
            _embeddedJwt: jws,
            disclosedFields: vcProof.disclosedFields,
          };
          console.log('🔍 [NON-BLOCKING-VALIDATION] Decoded embedded JWT for validation');
        } catch (_) {
          result.errors.push('Embedded JWT is malformed and cannot be decoded');
          return result;
        }
      }
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
    // ISSUER PINNING: RealPerson VCs must come from the trusted CA
    // ============================================================
    if (knownSchemas.includes('RealPerson')) {
      const rawIssuer = vcProof.issuer
        ? (typeof vcProof.issuer === 'string' ? vcProof.issuer : vcProof.issuer?.id)
        : null;
      if (rawIssuer && rawIssuer !== TRUSTED_REALPERSON_ISSUER) {
        console.log('❌ [NON-BLOCKING-VALIDATION] RealPerson VC from untrusted issuer:', rawIssuer);
        result.errors.push(`RealPerson VC issuer not trusted: expected CA DID, got ${rawIssuer}`);
        result.isValid = false;
        return result;
      }
    }

    // ============================================================
    // SUBJECT DID EXTRACTION (RealPerson only): no holder-binding check is performed here — see
    // the file-level "NOTE ON HOLDER BINDING" doc comment above for why that moved to a
    // post-connection live-verification step (utils/liveIdentityVerification.ts). This function
    // still resolves and exposes the subject DID via `result.subjectDID` so that later step has
    // a trusted anchor (from THIS preview) to compare a live presentation's identity against,
    // without re-implementing the same JWT-field extraction a second time.
    // ============================================================
    if (knownSchemas.includes('RealPerson')) {
      const subjectDID = vcProof.subjectDID || vcProof.credentialSubject?.id || null;
      if (subjectDID) {
        result.subjectDID = subjectDID;
      }
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
    // PHASE 4: CRYPTOGRAPHIC VERIFICATION
    // ============================================================

    // Tracks whether a signature was actually, successfully cryptographically verified in this
    // phase (as opposed to merely "not checked" — every degraded/fallback branch below only
    // pushes a WARNING when it can't check a signature, by design, so this function stays
    // lenient/informational for the many non-RealPerson credential types the wallet previews.
    // RealPerson is the one schema this file exists to gate for real — see the hard check right
    // after this block, which turns "no signature could be checked" into a blocking error for it.
    let cryptoSignatureVerified = false;

    if (agent && agent.pollux && result.issuer) {
      console.log('🔍 [NON-BLOCKING-VALIDATION] Attempting cryptographic verification...');
      try {
        // Primary path: raw JWT preserved by createVCProofAttachment — verify ES256K signature
        if (typeof vcProof._embeddedJwt === 'string') {
          console.log('🔍 [NON-BLOCKING-VALIDATION] Found embedded JWT, verifying ES256K signature...');
          const issuerDID = agent.castor.parseDID(result.issuer);
          const isSignatureValid = await (agent.pollux as any).JWT.verify({
            jws: vcProof._embeddedJwt,
            issuerDID,
          });
          if (!isSignatureValid) {
            console.log('❌ [NON-BLOCKING-VALIDATION] ES256K signature verification FAILED');
            result.errors.push('Invalid cryptographic signature — credential may be forged');
            result.isValid = false;
          } else {
            console.log('✅ [NON-BLOCKING-VALIDATION] ES256K signature verified');
            cryptoSignatureVerified = true;
            if (result.errors.length === 0) result.isValid = true;
          }
        } else if (vcProof._unverifiable) {
          // Fallback blob from old createVCProofAttachment — no signature to verify
          console.log('⚠️ [NON-BLOCKING-VALIDATION] Credential is display-only (no verifiable JWT)');
          result.warnings.push('No cryptographic signature available for verification');
        } else {
          // Legacy path: _jws or dot-separated id field
          let jws: string | undefined;
          if (typeof vcProof._jws === 'string') {
            jws = vcProof._jws;
          } else if (typeof vcProof.id === 'string' && vcProof.id.split('.').length === 3) {
            jws = vcProof.id;
          }
          if (jws) {
            console.log('🔍 [NON-BLOCKING-VALIDATION] Found legacy JWS, verifying signature...');
            const issuerDID = agent.castor.parseDID(result.issuer);
            const isSignatureValid = await (agent.pollux as any).JWT.verify({ jws, issuerDID });
            if (!isSignatureValid) {
              console.log('❌ [NON-BLOCKING-VALIDATION] Signature verification failed');
              result.errors.push('Invalid cryptographic signature');
              result.isValid = false;
            } else {
              console.log('✅ [NON-BLOCKING-VALIDATION] Signature verified');
              cryptoSignatureVerified = true;
              if (result.errors.length === 0) result.isValid = true;
            }
          } else {
            console.log('⚠️ [NON-BLOCKING-VALIDATION] No JWS found for cryptographic verification');
            result.warnings.push('No cryptographic signature available for verification');
          }
        }
      } catch (cryptoError) {
        console.log('❌ [NON-BLOCKING-VALIDATION] Cryptographic verification error:', cryptoError.message);
        // Any exception during verify() means no cryptographic assurance — must block.
        result.errors.push(`Cryptographic signature verification failed: ${cryptoError.message}`);
        result.isValid = false;
      }
    } else {
      console.log('ℹ️ [NON-BLOCKING-VALIDATION] Skipping crypto verification — agent or issuer not available');
      result.warnings.push('Cryptographic verification not performed');
    }

    // ============================================================
    // REALPERSON SIGNATURE ENFORCEMENT: unlike every other schema this function previews,
    // RealPerson identity claims MUST be backed by an actually-verified signature. Without
    // this, an attacker can hand-craft a plain JSON vc-proof-0 attachment (no JWT at all, or
    // marked `_unverifiable`), copy the well-known trusted CA DID string into `issuer`, and set
    // `credentialSubject.id` to whatever DID they like — sailing through issuer-pinning and the
    // holder-binding check above with zero cryptographic backing. Every "couldn't check a
    // signature" branch above is intentionally non-fatal for other credential types; for
    // RealPerson it must not be.
    // ============================================================
    if (knownSchemas.includes('RealPerson') && !cryptoSignatureVerified) {
      console.log('❌ [NON-BLOCKING-VALIDATION] RealPerson VC has no verified cryptographic signature — rejecting');
      result.errors.push('RealPerson credential has no verified cryptographic signature — cannot trust claims');
      result.isValid = false;
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
    result.errors.push(`Validation error: ${error.message}`);
    result.isValid = false;
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
// Exported so utils/liveIdentityVerification.ts can reuse the SAME field list for its live,
// post-connection shape check (mirrors how looksLikeRealPerson there mirrors isRealPersonTypedIdentity
// below) — single source of truth, no drift between the pre-connection preview check here and the
// live check there.
export function hasSecurityClearanceFields(obj: any): boolean {
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
  let credentialSubject = extractCredentialSubject(vcProof);

  // vcProof from OOB attachment is { jwt: rawJWS, disclosedFields: [...] }.
  // extractCredentialSubject can't find credentialSubject there — decode the JWT directly.
  if (Object.keys(credentialSubject).length === 0 && typeof vcProof?.jwt === 'string') {
    try {
      const isRawJws = (s: any): s is string =>
        typeof s === 'string' && s.startsWith('eyJ') && s.split('.').length === 3;
      if (isRawJws(vcProof.jwt)) {
        const b64 = vcProof.jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64));
        const fullSubject = payload.vc?.credentialSubject || payload.credentialSubject || {};
        const disclosedFields: string[] | undefined = vcProof.disclosedFields;
        if (disclosedFields && disclosedFields.length > 0) {
          const filtered: any = {};
          disclosedFields.forEach((field: string) => {
            if (fullSubject[field] !== undefined) filtered[field] = fullSubject[field];
          });
          // Always include credentialType — it's non-PII metadata needed for UI type detection
          if (fullSubject.credentialType && !filtered.credentialType) {
            filtered.credentialType = fullSubject.credentialType;
          }
          credentialSubject = filtered;
        } else {
          credentialSubject = fullSubject;
        }
      }
    } catch (_) {}
  }

  // Attach credentialSubject to vcProof so InvitationPreviewModal can detect type via getCredentialType()
  const vcProofWithSubject = Object.keys(credentialSubject).length > 0
    ? { ...vcProof, credentialSubject }
    : vcProof;

  const identity = {
    isVerified: validationResult.isValid,
    revealedData: credentialSubject,
    vcProof: vcProofWithSubject,
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

/**
 * Detect whether an inviter identity (as produced by parseInviterIdentity) carries a
 * RealPerson-typed credential — i.e. this invitation declares/carries a RealPersonIdentity VC,
 * as opposed to an ordinary invitation that was never meant to carry one.
 *
 * Single source of truth for this detection, shared by:
 *  - InvitationPreviewModal.tsx (UI: drives header styling / "unverified preview" messaging)
 *  - OOB.tsx's onConnectionHandleClick (the actual connection-establishment chokepoint — used
 *    there to decide whether to run POST-connection live identity verification, and to gate the
 *    vc-proof-sharing/1.0/proof auto-disclosure on its result; see
 *    performLiveIdentityVerificationAndMaybeRespond)
 * NOTE: this no longer gates connection establishment itself (see vcValidation.ts's "NOTE ON
 * HOLDER BINDING" doc comment above validateVerifiableCredential) — a RealPerson-typed invitation
 * is always allowed to connect on its preview; this detector now only decides whether the live
 * post-connection verification step runs.
 */
export function isRealPersonTypedIdentity(inviterIdentity: any): boolean {
  if (!inviterIdentity?.vcProof || !inviterIdentity?.revealedData) return false;

  const revealedData = inviterIdentity.revealedData;

  // Method 1: Check credentialType field
  if (revealedData.credentialType === 'RealPersonIdentity') return true;

  // Method 2: Check for characteristic RealPerson fields (firstName, lastName, uniqueId)
  const hasRealPersonFields = revealedData.firstName && revealedData.lastName && revealedData.uniqueId;
  if (hasRealPersonFields) return true;

  // Method 3: Use getCredentialType helper with mock credential structure
  const mockCredential = { credentialSubject: revealedData };
  return getCredentialType(mockCredential) === 'RealPersonIdentity';
}

/**
 * The set of credential types this wallet knows how to run POST-CONNECTION live
 * challenge/response verification for (see utils/liveIdentityVerification.ts's
 * `verifyLiveIdentity`) — each has its own trust-anchoring rules there: single hardcoded
 * issuer+schema pin for RealPersonIdentity; multi-issuer trust-registry pin (no schema pin) for
 * SecurityClearance, CertificationAuthorityIdentity, and CompanyIdentity. The latter two are used
 * by OOB.tsx's `walletType === 'cloud'` CA/Company connection-establishment path (not by
 * `detectLiveVerifiableIdentityType` below, which is only wired up for the RFC 0434
 * personal-wallet-to-personal-wallet path — CA/Company invitations are detected via their own
 * `isCAInvitation`/`isCompanyInvitation` flags instead, see OOB.tsx).
 */
export type LiveVerifiableCredentialType = 'RealPersonIdentity' | 'SecurityClearance' | 'CertificationAuthorityIdentity' | 'CompanyIdentity';

/**
 * Detect which live-verifiable type (if any) a preview identity (as produced by
 * parseInviterIdentity) claims to carry — i.e. whether it's worth running the live
 * post-connection verification round trip at all, and if so, which trust-anchoring branch that
 * round trip should use. Sibling to isRealPersonTypedIdentity above; RealPerson detection is
 * delegated to it unchanged (kept standalone since it's still used on its own in a couple of
 * places) rather than re-implemented here.
 *
 * Checked in priority order — RealPerson first (its detection is the more specific/established
 * one), then SecurityClearance via the same vcProof+revealedData shape, using the same
 * hasSecurityClearanceFields() field-signature check vcValidation's own detectKnownSchemas() uses
 * for the pre-connection preview, so the preview-time and live-time "does this look like a
 * SecurityClearance" checks never drift apart.
 *
 * Returns null for any invitation that isn't claiming to carry either type — the live
 * verification step should not run at all for those (see OOB.tsx/ConnectionRequest.tsx call sites).
 */
export function detectLiveVerifiableIdentityType(inviterIdentity: any): LiveVerifiableCredentialType | null {
  if (isRealPersonTypedIdentity(inviterIdentity)) return 'RealPersonIdentity';

  if (
    inviterIdentity?.vcProof &&
    inviterIdentity?.revealedData &&
    (inviterIdentity.revealedData.credentialType === 'SecurityClearance' ||
      hasSecurityClearanceFields(inviterIdentity.revealedData))
  ) {
    return 'SecurityClearance';
  }

  return null;
}
