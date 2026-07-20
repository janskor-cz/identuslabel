'use strict';

/**
 * verifyPresentation.js — capability-agnostic VP verification primitive.
 *
 * Decodes and cryptographically verifies (ES256K) every VC-JWT in a presented VP, returning the
 * verified credentials' issuer + claims for the caller to classify/trust-check/extract from.
 * Does NOT decide "enterprise vs personal path" or any other business logic — that stays local
 * to whichever service consumes this (e.g. identus-document-service's companyDID/clearanceLevel
 * branching), since it isn't shared across services today.
 *
 * HOLDER BINDING (added — closes a gap where a copied/stolen VC-JWT could be replayed by a DID
 * other than its rightful subject): when the caller supplies `vp.rawVpJwt` — the actual compact
 * outer VP-JWT the presenter signed, not just the `verifiableCredential` array it decodes to —
 * this function additionally:
 *   1. Verifies the outer VP-JWT's own ES256K signature against its `iss` DID's `authentication`
 *      key (DID-Auth / holder binding — proves whoever presented this VP controls that DID's
 *      private key, not merely relaying a copy of someone else's already-signed VC-JWT).
 *   2. Rejects if any contained VC's subject DID does not match that same `iss` DID (proves the
 *      presenter IS the credential's rightful subject).
 * Mirrors company-admin-portal/server.js's `verifyAndExtractRealPersonClaims`, which already did
 * this correctly for its own RealPersonIdentity onboarding flow.
 *
 * `vp.rawVpJwt` is OPTIONAL on this generic primitive: company-admin-portal's onboarding gate
 * already performs the outer-signature + subject check itself (via `verifyES256KSignature(...,
 * 'authentication')` + its own `prismDidsMatch`) immediately before calling this function with
 * only the decoded `verifiableCredential` array, so re-deriving `rawVpJwt` there would only
 * duplicate work it has already done safely. Any OTHER caller that omits `rawVpJwt` gets NO
 * holder-binding protection from this function and must ensure it is enforced elsewhere — this is
 * logged (not silent) so that gap stays visible. `ServiceAccessService` (this package's own
 * primary consumer, and the caller this fix specifically targets) always supplies `rawVpJwt` and
 * additionally fails closed itself if it cannot recover one from the underlying transport — see
 * `ServiceAccessService.js`'s `_onProofVerified`. There is no configuration flag anywhere in this
 * package to skip holder-binding once `rawVpJwt` is available — it is not optional in that case.
 */

const { decodeJWT, verifyES256KSignature } = require('./jwtCrypto');
const { prismDidsMatch } = require('./didCompare');

/**
 * @param {{ verifiableCredential: string[], rawVpJwt?: string }} vp
 * @param {(did: string) => Promise<object>} resolveIssuerDID  also used to resolve the holder's
 *   own DID document when `vp.rawVpJwt` is supplied — it's the same generic
 *   `(did) => Promise<DIDDocument>` shape either way (see issuerResolver.js), just applied to a
 *   different DID.
 * @returns {Promise<
 *   { success: true, credentials: Array<{ issuerDID: string, claims: object, payload: object, subjectDID: string|null, credentialStatus: object|null }>,
 *     holderDID: string|null, holderBindingChecked: boolean }
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

  // ── Holder binding (outer VP-JWT) ──────────────────────────────────────────
  let holderDID = null;
  let holderBindingChecked = false;

  if (vp.rawVpJwt) {
    const outerDecoded = decodeJWT(vp.rawVpJwt);
    if (!outerDecoded) {
      return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Outer VP JWT is malformed' };
    }
    if (outerDecoded.header.alg !== 'ES256K') {
      return {
        success: false,
        error:   'UNSUPPORTED_SIGNATURE_ALG',
        message: `Outer VP JWT uses unsupported algorithm: ${outerDecoded.header.alg}`
      };
    }

    holderDID = outerDecoded.payload?.iss || null;
    if (!holderDID) {
      return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Outer VP JWT missing iss (holder DID) — cannot verify holder binding' };
    }

    const holderSigValid = await verifyES256KSignature(outerDecoded, holderDID, resolveIssuerDID, 'authentication');
    if (!holderSigValid) {
      return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Outer VP JWT signature verification failed (holder binding)' };
    }

    holderBindingChecked = true;
  } else {
    console.warn('[verifyPresentation] No rawVpJwt supplied — holder-binding (outer VP signature + subject-vs-presenter check) was NOT performed by this call. The caller must ensure this is enforced elsewhere.');
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

    const subjectDID = payload.sub || claims.id || null;

    // The presenter must BE the credential's own subject — otherwise a copied/stolen VC-JWT
    // (issuer signature still valid, since the issuer really did sign it for someone) could be
    // replayed by a different DID than the one it was issued to.
    if (holderBindingChecked && !prismDidsMatch(subjectDID, holderDID)) {
      return {
        success: false,
        error:   'HOLDER_BINDING_FAILED',
        message: `Credential at index ${i} subject (${subjectDID || 'none'}) does not match the presenting holder's verified DID — possible replay of a credential that is not the presenter's own`
      };
    }

    const cs = payload.vc?.credentialStatus || payload.credentialStatus || null;

    credentials.push({
      issuerDID,
      claims,
      payload,
      subjectDID,
      credentialStatus: cs && cs.statusListCredential && cs.statusListIndex != null
        ? { statusListCredential: cs.statusListCredential, statusListIndex: Number(cs.statusListIndex), statusPurpose: cs.statusPurpose || 'revocation' }
        : null
    });
  }

  return { success: true, credentials, holderDID, holderBindingChecked };
}

module.exports = { verifyPresentationCredentials };
