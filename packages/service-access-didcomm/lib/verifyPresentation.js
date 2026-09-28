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

const crypto = require('crypto');
const { decodeJWT, verifyES256KSignature, b64urlToBuffer } = require('./jwtCrypto');
const { prismDidsMatch } = require('./didCompare');
const { splitSDJWT, decodeSDJWTPart, verifyEdDSASignature, resolveVerifiedDisclosures } = require('./sdJwtCrypto');

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

    // `exp` is a registered top-level JWT claim, not a `credentialSubject` field — it is never
    // behind selective disclosure, so this applies regardless of which (if any) subject claims
    // the holder chose to reveal. Missing `exp` means the issuer set no expiration, not "expired"
    // — only reject when the field is present AND has passed.
    if (typeof payload.exp === 'number' && Date.now() >= payload.exp * 1000) {
      return { success: false, error: 'CREDENTIAL_EXPIRED', message: `Credential at index ${i} expired at ${new Date(payload.exp * 1000).toISOString()}` };
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

/**
 * SD-JWT counterpart to verifyPresentationCredentials. One SD-JWT compact string IS both the
 * credential and (with a Key-Binding JWT appended) the presentation — there is no separate outer
 * VP-JWT to unwrap the way there is for a JWT-VP, so this has its own holder-binding mechanism:
 * a KB-JWT signed by the credential subject's own `cnf.jwk` (embedded directly in the credential
 * at issuance — no DID resolution needed for this signature, unlike the issuer signature check).
 *
 * Same fail-closed posture as the JWT-VP path's `!vp.rawVpJwt` case, but enforced HERE rather
 * than left to the caller: a missing KB-JWT means holder binding cannot be proven at all for this
 * format (there is nothing else that could carry it), so `success: false, HOLDER_BINDING_FAILED`
 * is returned rather than a soft warning — ServiceAccessService.js is this function's only
 * caller today and already requires holder binding unconditionally for the JWT-VP path; this
 * keeps that requirement equally strict for SD-JWT rather than accidentally weakening it because
 * SD-JWT's binding mechanism happens to live at a different layer.
 *
 * @param {{ compact: string, expectedNonce?: string, expectedAud?: string }} vp
 * @param {(did: string) => Promise<object>} resolveIssuerDID
 * @returns {Promise<
 *   { success: true, credentials: Array<{ issuerDID: string, claims: object, payload: object, subjectDID: string|null, credentialStatus: null }>,
 *     holderDID: string|null, holderBindingChecked: true }
 *   | { success: false, error: string, message: string }
 * >}
 */
async function verifySDJWTPresentationCredentials(vp, resolveIssuerDID) {
  if (!vp || typeof vp.compact !== 'string') {
    return { success: false, error: 'NoVP', message: 'No SD-JWT presentation provided' };
  }

  const { jwtPart, disclosures, kbJwt } = splitSDJWT(vp.compact);
  const decoded = decodeSDJWTPart(jwtPart);
  if (!decoded) {
    return { success: false, error: 'MALFORMED_CREDENTIAL', message: 'SD-JWT header.payload.signature part is malformed' };
  }

  const issuerDID = decoded.payload.iss;
  const sigValid = await verifyEdDSASignature(decoded, issuerDID, resolveIssuerDID);
  if (!sigValid) {
    return { success: false, error: 'INVALID_VC_SIGNATURE', message: 'SD-JWT issuer signature verification failed' };
  }

  // Same as the JWT-VP path's check: `exp` is a top-level signed claim, always visible regardless
  // of which fields were selectively disclosed. Missing `exp` means no expiration was set.
  if (typeof decoded.payload.exp === 'number' && Date.now() >= decoded.payload.exp * 1000) {
    return { success: false, error: 'CREDENTIAL_EXPIRED', message: `SD-JWT credential expired at ${new Date(decoded.payload.exp * 1000).toISOString()}` };
  }

  let claims;
  try {
    claims = resolveVerifiedDisclosures(decoded.payload, disclosures);
  } catch (err) {
    return { success: false, error: 'UNSUPPORTED_DIGEST_ALG', message: err.message };
  }

  const subjectDID = decoded.payload.sub || null;

  // ── Holder binding (Key-Binding JWT) ────────────────────────────────────────
  if (!kbJwt) {
    console.warn(`[verifyPresentation] SD-JWT presentation from issuer=${issuerDID} has no Key-Binding JWT — cannot prove the presenter is this credential's rightful subject. Rejecting (fail closed), same posture as the missing-rawVpJwt case for JWT-VP.`);
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'SD-JWT presentation has no Key-Binding JWT — holder binding cannot be verified.' };
  }

  const cnfJwk = decoded.payload.cnf?.jwk;
  if (!cnfJwk) {
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Credential has no cnf.jwk — cannot verify Key-Binding JWT against it.' };
  }

  const kbDecoded = decodeSDJWTPart(kbJwt); // KB-JWT is itself header.payload.signature — same shape
  if (!kbDecoded) {
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Key-Binding JWT is malformed.' };
  }
  if (kbDecoded.header.alg !== 'EdDSA' || kbDecoded.header.typ !== 'kb+jwt') {
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: `Key-Binding JWT has unexpected header (alg=${kbDecoded.header.alg}, typ=${kbDecoded.header.typ}).` };
  }
  if (vp.expectedNonce && kbDecoded.payload.nonce !== vp.expectedNonce) {
    return { success: false, error: 'CHALLENGE_MISMATCH', message: 'Key-Binding JWT nonce does not match the request challenge.' };
  }
  if (vp.expectedAud && kbDecoded.payload.aud !== vp.expectedAud) {
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Key-Binding JWT aud does not match this verifier.' };
  }

  let kbSigValid = false;
  try {
    const pubKey = crypto.createPublicKey({ key: cnfJwk, format: 'jwk' });
    kbSigValid = crypto.verify(null, kbDecoded.signingInput, pubKey, kbDecoded.signature);
  } catch (err) {
    console.error(`[verifyPresentation] Key-Binding JWT signature check threw: ${err.message}`);
  }
  if (!kbSigValid) {
    return { success: false, error: 'HOLDER_BINDING_FAILED', message: 'Key-Binding JWT signature verification failed against the credential\'s cnf.jwk.' };
  }

  const holderDID = subjectDID; // SD-JWT VCs bind the holder via cnf.jwk, not a separate holder DID iss

  return {
    success: true,
    credentials: [{ issuerDID, claims, payload: decoded.payload, subjectDID, credentialStatus: null }],
    holderDID,
    holderBindingChecked: true
  };
}

module.exports = { verifyPresentationCredentials, verifySDJWTPresentationCredentials };
