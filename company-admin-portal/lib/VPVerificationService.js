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

  const CLEARANCE_ORDER = ['UNCLASSIFIED', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET', 'TOP-SECRET', 'TOP_SECRET'];

  let employeeRoleCred      = null;
  let securityClearanceCred = null; // highest-clearance trusted security VC found so far

  // Parse every credential in the VP
  // Track credential subject DID for holder binding consistency check
  let sharedSubjectDID  = null;
  let credentialStatuses = [];

  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const decoded = decodeCredentialJWT(vp.verifiableCredential[i]);
    if (!decoded) continue;

    // Subject consistency check: all VCs in a VP must belong to the same subject
    const vcSubject = decoded.payload.sub || decoded.payload.vc?.credentialSubject?.id || null;
    if (vcSubject) {
      if (sharedSubjectDID === null) {
        sharedSubjectDID = vcSubject;
      } else if (vcSubject !== sharedSubjectDID) {
        console.error(`[VPVerificationService] HOLDER BINDING: Mixed credential subjects detected — index ${i} subject=${vcSubject} differs from expected=${sharedSubjectDID}`);
        return {
          success: false,
          error: 'MixedCredentialSubjects',
          message: 'All credentials in a presentation must belong to the same subject'
        };
      }
    }

    // Extract StatusList2021 revocation pointer so callers can do a direct bitstring check
    const cs = decoded.payload.vc?.credentialStatus || decoded.payload.credentialStatus || null;
    if (cs?.statusListCredential && cs?.statusListIndex != null) {
      credentialStatuses.push({
        statusListCredential: cs.statusListCredential,
        statusListIndex:      Number(cs.statusListIndex),
        statusPurpose:        cs.statusPurpose || 'revocation'
      });
    }

    if (isEmployeeRoleCred(decoded.claims)) {
      console.log(`[VPVerificationService] Found EmployeeRole credential at index ${i}`);
      employeeRoleCred = decoded;
    } else if (isSecurityClearanceCred(decoded.claims)) {
      console.log(`[VPVerificationService] Found SecurityClearance credential at index ${i} (issuer: ${decoded.issuer?.substring(0, 30)}...)`);
      // Only keep if issuer is trusted; keep whichever has the highest clearance level
      if (acceptedIssuerDIDs.includes(decoded.issuer)) {
        const incoming = CLEARANCE_ORDER.indexOf((decoded.claims.clearanceLevel || '').toUpperCase());
        const existing = securityClearanceCred
          ? CLEARANCE_ORDER.indexOf((securityClearanceCred.claims.clearanceLevel || '').toUpperCase())
          : -1;
        if (incoming > existing) {
          securityClearanceCred = decoded;
        }
      } else {
        console.log(`[VPVerificationService] SecurityClearance at index ${i} has untrusted issuer — skipping`);
      }
    } else {
      console.log(`[VPVerificationService] Unknown credential at index ${i}, claims:`, Object.keys(decoded.claims));
    }
  }

  // EnterpriseVC (EmployeeRole) is required
  if (!employeeRoleCred) {
    return {
      success: false,
      error: 'NoEmployeeRoleCredential',
      message: 'EmployeeRole credential is required'
    };
  }

  // Determine issuer / companyDID
  const issuerDID  = employeeRoleCred.claims?.issuerDID || employeeRoleCred.issuer;
  const companyDID = issuerDID;  // the company that issued the enterprise VC IS the companyDID

  // Verify issuer is trusted
  if (!acceptedIssuerDIDs.includes(issuerDID)) {
    console.error(`[VPVerificationService] Untrusted issuer: ${issuerDID}`);
    return {
      success: false,
      error: 'UntrustedIssuer',
      message: `Credential issuer is not in the trusted list`
    };
  }

  // Extract clearance level (already filtered to highest trusted level in the loop above)
  const clearanceLevel = securityClearanceCred?.claims.clearanceLevel || null;
  if (clearanceLevel) {
    console.log(`[VPVerificationService] Clearance level from VC: ${clearanceLevel}`);
  }

  // Build viewer name from EmployeeRole claims (always present)
  const viewerName = employeeRoleCred.claims.email
    || employeeRoleCred.claims.employeeId
    || null;

  return {
    success:              true,
    companyDID,
    clearanceLevel,
    issuerDID,
    viewerName,
    employeeRoleClaims:   employeeRoleCred.claims,
    credentialSubjectDID: sharedSubjectDID,
    credentialStatuses
  };
}

module.exports = { verifyVPAndExtractClaims, decodeCredentialJWT };
