/**
 * VPVerificationService.js
 *
 * Reusable Verifiable Presentation (VP) claim extraction and verification.
 * Extracted from the DIDComm login handler (server.js lines 2150–2360)
 * so that the document access gate can verify VCs independently of the
 * session login flow.
 *
 * Usage:
 *   const VPVerificationService = require('./VPVerificationService');
 *   const result = await VPVerificationService.verifyVPAndExtractClaims(vp, acceptedIssuerDIDs);
 *   // result: { success, companyDID, clearanceLevel, issuerDID } or { success: false, error }
 */

'use strict';

/**
 * Decode a JWT credential string and return { claims, issuer, payload }
 * Returns null if the JWT is invalid or doesn't contain a VC.
 *
 * @param {string} credentialJWT - Raw JWT string
 * @returns {{ claims: object, issuer: string, payload: object } | null}
 */
function decodeCredentialJWT(credentialJWT) {
  try {
    if (typeof credentialJWT !== 'string' || !credentialJWT.includes('.')) return null;

    const parts = credentialJWT.split('.');
    if (parts.length !== 3) return null;

    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padding = '='.repeat((4 - (payloadBase64.length % 4)) % 4);
    const payloadJson = Buffer.from(payloadBase64 + padding, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    if (payload.vc && payload.vc.credentialSubject) {
      return {
        claims:   payload.vc.credentialSubject,
        issuer:   payload.iss,
        payload
      };
    }
  } catch (_) {
    // ignore malformed JWTs
  }
  return null;
}

/**
 * Return true if claims look like an EmployeeRole credential.
 */
function isEmployeeRoleCred(claims) {
  return claims.role !== undefined && claims.department !== undefined;
}

/**
 * Return true if claims look like a SecurityClearance credential.
 */
function isSecurityClearanceCred(claims) {
  return claims.clearanceLevel !== undefined;
}

/**
 * Verify a Verifiable Presentation and extract document-access-relevant claims.
 *
 * @param {object} vp - Parsed VP object ({ verifiableCredential: string[] })
 * @param {string[]} acceptedIssuerDIDs - DIDs whose credentials are trusted
 * @returns {{ success: true, companyDID: string, clearanceLevel: string|null, issuerDID: string }
 *          |{ success: false, error: string, message: string }}
 */
function verifyVPAndExtractClaims(vp, acceptedIssuerDIDs) {
  if (!vp) {
    return { success: false, error: 'NoVP', message: 'No verifiable presentation provided' };
  }

  if (!Array.isArray(vp.verifiableCredential) || vp.verifiableCredential.length === 0) {
    return { success: false, error: 'NoCredentials', message: 'No verifiable credentials in presentation' };
  }

  let employeeRoleCred    = null;
  let securityClearanceCred = null;

  // Parse every credential in the VP
  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const decoded = decodeCredentialJWT(vp.verifiableCredential[i]);
    if (!decoded) continue;

    if (isEmployeeRoleCred(decoded.claims)) {
      console.log(`[VPVerificationService] Found EmployeeRole credential at index ${i}`);
      employeeRoleCred = decoded;
    } else if (isSecurityClearanceCred(decoded.claims)) {
      console.log(`[VPVerificationService] Found SecurityClearance credential at index ${i}`);
      securityClearanceCred = decoded;
    } else {
      console.log(`[VPVerificationService] Unknown credential at index ${i}, claims:`, Object.keys(decoded.claims));
    }
  }

  // Need at least one of EmployeeRole or SecurityClearance
  if (!employeeRoleCred && !securityClearanceCred) {
    return {
      success: false,
      error: 'NoUsableCredential',
      message: 'VP must contain an EmployeeRole or SecurityClearance credential'
    };
  }

  // ── Enterprise path: EmployeeRole present ───────────────────────────────
  if (employeeRoleCred) {
    const issuerDID  = employeeRoleCred.claims?.issuerDID || employeeRoleCred.issuer;
    const companyDID = issuerDID;

    // acceptedIssuerDIDs is [] when releasableTo was omitted from the DID (new format).
    // Treat empty list as "no DID-level restriction" — clearance level alone governs access.
    if (acceptedIssuerDIDs.length > 0 && !acceptedIssuerDIDs.includes(issuerDID)) {
      console.error(`[VPVerificationService] Untrusted EmployeeRole issuer: ${issuerDID}`);
      return { success: false, error: 'UntrustedIssuer', message: 'Credential issuer is not in the trusted list' };
    }

    let clearanceLevel = null;
    if (securityClearanceCred) {
      clearanceLevel = securityClearanceCred.claims.clearanceLevel || null;
      console.log(`[VPVerificationService] Clearance level from VC: ${clearanceLevel}`);
    }

    return {
      success: true,
      companyDID,
      clearanceLevel,
      issuerDID,
      viewerName:         employeeRoleCred.claims.email || employeeRoleCred.claims.employeeId || null,
      employeeRoleClaims: employeeRoleCred.claims
    };
  }

  // ── Personal wallet path: SecurityClearance only ─────────────────────────
  // No EmployeeRole — clearance-level-only access (personal wallet holder).
  // Releasability check is skipped server-side for this path.
  console.log('[VPVerificationService] SecurityClearance-only VP — personal wallet path');
  const clearanceLevel = securityClearanceCred.claims.clearanceLevel || null;
  console.log(`[VPVerificationService] Clearance level from VC: ${clearanceLevel}`);

  return {
    success:            true,
    companyDID:         null,   // signals: skip releasability check
    clearanceLevel,
    issuerDID:          securityClearanceCred.issuer,
    viewerName:         securityClearanceCred.claims.holderName || null,
    employeeRoleClaims: null    // signals: personal wallet path
  };
}

module.exports = { verifyVPAndExtractClaims, decodeCredentialJWT };
