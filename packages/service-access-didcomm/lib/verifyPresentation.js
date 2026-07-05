'use strict';

/**
 * verifyPresentation.js — capability-agnostic VP verification primitive.
 *
 * Decodes and cryptographically verifies (ES256K) every VC-JWT in a presented VP, returning the
 * verified credentials' issuer + claims for the caller to classify/trust-check/extract from.
 * Does NOT decide "enterprise vs personal path" or any other business logic — that stays local
 * to whichever service consumes this (e.g. identus-document-service's companyDID/clearanceLevel
 * branching), since it isn't shared across services today.
 */

const { decodeJWT, verifyES256KSignature } = require('./jwtCrypto');

/**
 * @param {{ verifiableCredential: string[] }} vp
 * @param {(did: string) => Promise<object>} resolveIssuerDID
 * @returns {Promise<
 *   { success: true, credentials: Array<{ issuerDID: string, claims: object, payload: object, credentialStatus: object|null }> }
 *   | { success: false, error: string, message: string }
 * >}
 */
async function verifyPresentationCredentials(vp, resolveIssuerDID) {
  if (!vp) {
    return { success: false, error: 'NoVP', message: 'No verifiable presentation provided' };
  }
  if (!Array.isArray(vp.verifiableCredential) || vp.verifiableCredential.length === 0) {
    return { success: false, error: 'NoCredentials', message: 'No verifiable credentials in presentation' };
  }

  const credentials = [];

  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const decoded = decodeJWT(vp.verifiableCredential[i]);
    if (!decoded) {
      return { success: false, error: 'MALFORMED_CREDENTIAL', message: `Credential at index ${i} is not a valid JWT` };
    }

    const { payload } = decoded;
    const claims    = payload.vc?.credentialSubject || {};
    const issuerDID = payload.iss;

    if (decoded.header.alg !== 'ES256K') {
      return {
        success: false,
        error:   'UNSUPPORTED_SIGNATURE_ALG',
        message: `Credential at index ${i} uses unsupported algorithm: ${decoded.header.alg}`
      };
    }

    const sigValid = await verifyES256KSignature(decoded, issuerDID, resolveIssuerDID);
    if (!sigValid) {
      return { success: false, error: 'INVALID_VC_SIGNATURE', message: `Credential at index ${i} failed signature verification` };
    }

    const cs = payload.vc?.credentialStatus || payload.credentialStatus || null;

    credentials.push({
      issuerDID,
      claims,
      payload,
      subjectDID: payload.sub || claims.id || null,
      credentialStatus: cs && cs.statusListCredential && cs.statusListIndex != null
        ? { statusListCredential: cs.statusListCredential, statusListIndex: Number(cs.statusListIndex), statusPurpose: cs.statusPurpose || 'revocation' }
        : null
    });
  }

  return { success: true, credentials };
}

module.exports = { verifyPresentationCredentials };
