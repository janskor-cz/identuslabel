/**
 * VPVerificationService.js
 *
 * Verifiable Presentation verification for document access control.
 *
 * Responsibilities:
 *   1. Decode each VC JWT in the presented VP
 *   2. VERIFY the JWT-VC signature cryptographically (ES256K / secp256k1)
 *      by resolving the issuer's DID and checking against their assertionMethod key
 *   3. Extract document-access-relevant claims (clearanceLevel, issuerDID, etc.)
 *
 * Signature verification uses Node.js built-in crypto (no external deps):
 *   - Converts the JWT compact signature (r||s, 64 bytes) to DER format
 *   - Loads the issuer's secp256k1 JWK as a Node.js KeyObject
 *   - Verifies with crypto.verify('SHA256', signingInput, key, derSig)
 *
 * Previously (before April 2026) this service only decoded JWTs without
 * verifying their signatures — any forged VP would have been accepted.
 * That mock verification path has been removed.
 */

'use strict';

const crypto               = require('crypto');
const { resolveIssuerDID } = require('./DIDDocumentResolver');
const AdminConfigStore     = require('./AdminConfigStore');

// ── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Base64url decode to Buffer.
 */
function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(b64 + pad, 'base64');
}

/**
 * Convert a compact 64-byte secp256k1 signature (r||s) to DER format.
 * DER is required by Node.js crypto.verify for ECDSA.
 */
function compactToDER(sigBytes) {
  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  // Prefix with 0x00 if high bit is set (to keep value positive in DER)
  const rPad = (r[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), r]) : r;
  const sPad = (s[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), s]) : s;
  const body = Buffer.concat([
    Buffer.from([0x02, rPad.length]), rPad,
    Buffer.from([0x02, sPad.length]), sPad
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Decode a JWT string and return { header, payload, signingInput, signature }.
 * Returns null if the string is not a valid 3-part JWT.
 */
function decodeJWT(jwtString) {
  if (typeof jwtString !== 'string') return null;
  const parts = jwtString.split('.');
  if (parts.length !== 3) return null;

  try {
    const header  = JSON.parse(b64urlToBuffer(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64urlToBuffer(parts[1]).toString('utf8'));
    return {
      header,
      payload,
      // Signing input is the raw ASCII bytes of "header64url.payload64url"
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
      // Compact 64-byte signature (r||s)
      signature: b64urlToBuffer(parts[2])
    };
  } catch (_) {
    return null;
  }
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Verify an ES256K JWT signature using Node.js built-in crypto.
 *
 * 1. Resolve issuer DID → get assertionMethod secp256k1 keys (JWK format)
 * 2. Convert compact signature to DER
 * 3. crypto.verify('SHA256', signingInput, jwkKey, derSig)
 *
 * Returns true if any key verifies, false otherwise.
 *
 * @param {object} decoded  — output of decodeJWT()
 * @param {string} issuerDID
 * @returns {Promise<boolean>}
 */
async function verifyES256KSignature(decoded, issuerDID) {
  if (!issuerDID) {
    console.warn('[VPVerificationService] No issuer DID in JWT — cannot verify signature');
    return false;
  }

  let issuerDoc;
  try {
    issuerDoc = await resolveIssuerDID(issuerDID);
  } catch (err) {
    console.error(`[VPVerificationService] DID resolution failed for ${issuerDID}: ${err.message}`);
    return false;
  }

  const assertionRefs = issuerDoc.assertionMethod || [];
  const allVMs        = issuerDoc.verificationMethod || [];

  // Prefer assertionMethod keys; fall back to all secp256k1 keys if none found
  let keysToTry = assertionRefs
    .map(ref => typeof ref === 'object' ? ref : allVMs.find(vm => vm.id === ref) || null)
    .filter(k => k && k.publicKeyJwk && k.publicKeyJwk.crv === 'secp256k1');

  if (keysToTry.length === 0) {
    keysToTry = allVMs.filter(vm => vm.publicKeyJwk && vm.publicKeyJwk.crv === 'secp256k1');
    if (keysToTry.length === 0) {
      console.warn(`[VPVerificationService] No secp256k1 keys found for ${issuerDID}`);
      return false;
    }
    console.warn(`[VPVerificationService] No assertionMethod keys — trying all ${keysToTry.length} secp256k1 VMs`);
  }

  // Convert compact r||s to DER once
  let sigDER;
  try {
    sigDER = compactToDER(decoded.signature);
  } catch (err) {
    console.error(`[VPVerificationService] Invalid signature encoding: ${err.message}`);
    return false;
  }

  for (const vm of keysToTry) {
    try {
      const jwk    = { ...vm.publicKeyJwk, kty: 'EC' };
      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const valid  = crypto.verify('SHA256', decoded.signingInput, { key: pubKey, dsaEncoding: 'der' }, sigDER);
      if (valid) {
        console.log(`[VPVerificationService] ✅ ES256K signature verified with key ${vm.id}`);
        return true;
      }
    } catch (err) {
      console.debug(`[VPVerificationService] Key ${vm.id} failed: ${err.message}`);
    }
  }

  console.warn(`[VPVerificationService] ❌ No key matched signature for issuer ${issuerDID}`);
  return false;
}

// ── VC type helpers ──────────────────────────────────────────────────────────

function isEmployeeRoleCred(claims) {
  return claims.role !== undefined && claims.department !== undefined;
}

function isSecurityClearanceCred(claims) {
  return claims.clearanceLevel !== undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Verify a Verifiable Presentation and extract document-access-relevant claims.
 *
 * Each VC JWT in the presentation is decoded and its ES256K signature is
 * cryptographically verified against the issuer's DID assertionMethod key
 * before any claims are trusted.
 *
 * @param {object}   vp                — { verifiableCredential: string[] }
 * @param {string[]} acceptedIssuerDIDs — from the document's releasableTo field
 * @returns {Promise<
 *   { success: true, companyDID: string|null, clearanceLevel: string|null, issuerDID: string, ... }
 *   | { success: false, error: string, message: string }
 * >}
 */
async function verifyVPAndExtractClaims(vp, acceptedIssuerDIDs) {
  if (!vp) {
    return { success: false, error: 'NoVP', message: 'No verifiable presentation provided' };
  }

  if (!Array.isArray(vp.verifiableCredential) || vp.verifiableCredential.length === 0) {
    return { success: false, error: 'NoCredentials', message: 'No verifiable credentials in presentation' };
  }

  let employeeRoleCred      = null;
  let securityClearanceCred = null;
  // Track credential subject DID for holder binding consistency check
  let sharedSubjectDID      = null;
  let credentialStatuses    = [];

  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const decoded = decodeJWT(vp.verifiableCredential[i]);
    if (!decoded) {
      console.warn(`[VPVerificationService] Credential at index ${i} is not a valid JWT — rejecting VP`);
      return {
        success: false,
        error:   'MALFORMED_CREDENTIAL',
        message: `Credential at index ${i} is not a valid JWT`
      };
    }

    const { payload } = decoded;
    const claims      = payload.vc?.credentialSubject || {};
    const issuerDID   = payload.iss;

    // Track first-seen subject for informational logging; mixed subjects are permitted
    // (W3C VP spec §4.3 does not require all VCs to share the same credential subject —
    // employees legitimately hold VCs issued to their personal DID and their enterprise DID)
    const vcSubject = payload.sub || payload.vc?.credentialSubject?.id || null;
    if (vcSubject && sharedSubjectDID === null) {
      sharedSubjectDID = vcSubject;
    }

    // Extract StatusList2021 revocation pointer for direct bitstring check by callers
    const cs = payload.vc?.credentialStatus || payload.credentialStatus || null;
    if (cs?.statusListCredential && cs?.statusListIndex != null) {
      credentialStatuses.push({
        statusListCredential: cs.statusListCredential,
        statusListIndex:      Number(cs.statusListIndex),
        statusPurpose:        cs.statusPurpose || 'revocation'
      });
    }

    // ── Verify signature ───────────────────────────────────────────────────
    if (decoded.header.alg !== 'ES256K') {
      console.warn(`[VPVerificationService] Unsupported alg "${decoded.header.alg}" at index ${i}`);
      return {
        success: false,
        error:   'UNSUPPORTED_SIGNATURE_ALG',
        message: `Credential at index ${i} uses unsupported algorithm: ${decoded.header.alg}`
      };
    }

    const sigValid = await verifyES256KSignature(decoded, issuerDID);
    if (!sigValid) {
      console.error(`[VPVerificationService] ❌ Invalid signature on credential ${i} (iss=${issuerDID})`);
      return {
        success: false,
        error:   'INVALID_VC_SIGNATURE',
        message: `Credential at index ${i} failed signature verification`
      };
    }

    // ── Admin schema policy check (optional; backwards-compatible) ────────
    const policyResult = AdminConfigStore.applySchemaPolicy(claims, issuerDID, payload);
    if (policyResult && !policyResult.trusted) {
      console.error(`[VPVerificationService] ❌ Policy: issuer ${issuerDID} not in trustedIssuers for level ${policyResult.level}`);
      return { success: false, error: 'POLICY_ISSUER_NOT_TRUSTED', message: `Issuer not trusted for ${policyResult.level} by admin policy` };
    }

    // ── Classify ───────────────────────────────────────────────────────────
    if (isEmployeeRoleCred(claims)) {
      console.log(`[VPVerificationService] ✅ EmployeeRole verified at index ${i}`);
      employeeRoleCred = { claims, issuer: issuerDID, payload };
    } else if (isSecurityClearanceCred(claims) || policyResult?.clearanceLevel) {
      // Apply policy-configured clearanceField if present
      const policiedClaims = policyResult?.clearanceLevel
        ? { ...claims, clearanceLevel: policyResult.clearanceLevel }
        : claims;
      console.log(`[VPVerificationService] ✅ SecurityClearance verified at index ${i}`);
      securityClearanceCred = { claims: policiedClaims, issuer: issuerDID, payload };
    } else {
      console.log(`[VPVerificationService] ✅ Other credential verified at index ${i}: [${Object.keys(claims).join(', ')}]`);
    }
  }

  if (!employeeRoleCred && !securityClearanceCred) {
    return {
      success: false,
      error:   'NoUsableCredential',
      message: 'VP must contain a verified EmployeeRole or SecurityClearance credential'
    };
  }

  // ── Enterprise path: EmployeeRole present ─────────────────────────────────
  if (employeeRoleCred) {
    const issuerDID  = employeeRoleCred.claims?.issuerDID || employeeRoleCred.issuer;
    const companyDID = issuerDID;

    if (acceptedIssuerDIDs.length > 0 && !acceptedIssuerDIDs.includes(issuerDID)) {
      console.error(`[VPVerificationService] Untrusted issuer: ${issuerDID}`);
      return { success: false, error: 'UntrustedIssuer', message: 'Credential issuer is not in the trusted list' };
    }

    const clearanceLevel = securityClearanceCred?.claims.clearanceLevel || null;
    console.log(`[VPVerificationService] Enterprise path — issuer=${issuerDID} clearance=${clearanceLevel}`);

    return {
      success:              true,
      companyDID,
      clearanceLevel,
      issuerDID,
      viewerName:           employeeRoleCred.claims.email || employeeRoleCred.claims.employeeId || null,
      employeeRoleClaims:   employeeRoleCred.claims,
      credentialSubjectDID: sharedSubjectDID,
      credentialStatuses
    };
  }

  // ── Personal wallet path: SecurityClearance only ───────────────────────────
  // SECURITY: still enforce issuer trust — a self-issued clearance VC must not be accepted.
  // If the document has a non-empty acceptedIssuerDIDs list, the clearance issuer must be in it.
  const scIssuerDID = securityClearanceCred.issuer;
  if (acceptedIssuerDIDs.length > 0 && !acceptedIssuerDIDs.includes(scIssuerDID)) {
    console.error(`[VPVerificationService] Personal path: untrusted clearance issuer ${scIssuerDID}`);
    return { success: false, error: 'UntrustedIssuer', message: 'Security Clearance issuer is not in the trusted list' };
  }

  const clearanceLevel = securityClearanceCred.claims.clearanceLevel || null;
  console.log(`[VPVerificationService] Personal wallet path — issuer=${scIssuerDID} clearance=${clearanceLevel}`);

  return {
    success:              true,
    companyDID:           null,
    clearanceLevel,
    issuerDID:            scIssuerDID,
    viewerName:           securityClearanceCred.claims.holderName || null,
    employeeRoleClaims:   null,
    credentialSubjectDID: sharedSubjectDID,
    credentialStatuses
  };
}

module.exports = { verifyVPAndExtractClaims, decodeJWT };
