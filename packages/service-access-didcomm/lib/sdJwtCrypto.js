'use strict';

/**
 * sdJwtCrypto.js — SD-JWT VC decoding, disclosure-digest verification, and EdDSA signature
 * verification. Sibling to jwtCrypto.js (same style, same dependency-injected resolveIssuerDID),
 * added because SD-JWT presentations reach this codebase two ways that both need it:
 *   - ServiceAccessService.js's present-proof/3.0 verification (this file's original consumer —
 *     see its own comment on why the Cloud Agent's OWN post-hoc verification can't be trusted for
 *     SD-JWT: its present-proof presentation handler routes everything through a JWT-only path
 *     regardless of the request's declared credentialFormat, confirmed live by its log line
 *     "o.h.i.a.s.j.P.V.P.handleJWT" appearing even for an SD-JWT-format request/response).
 *   - RealPerson issuance has been SD-JWT-exclusive since 2026-08-07 (vcValidation.ts's
 *     TRUSTED_REALPERSON_SCHEMA_ID comment), so any capability gated on a RealPerson-derived
 *     credential needs this, not just jwtCrypto.js's ES256K path.
 *
 * Algorithm mirrors idl-wallet-v2's utils/sdJwtClaims.ts exactly (verifySDJWTIssuerSignature /
 * resolveVerifiedSDJWTClaims) — that file already solved this correctly for a different purpose
 * (a wallet validating a credential it holds); this is the same math, ported to Node's built-in
 * `crypto` (no Web Crypto / SDK dependency available server-side) for the verifier side.
 */

const crypto = require('crypto');
const { b64urlToBuffer } = require('./jwtCrypto');

const SUPPORTED_SD_HASH_ALG = 'sha-256';

/** True iff `jws` is SD-JWT (header.payload.signature~disclosure~...~[kb-jwt]) rather than a
 *  plain JWT — `~` never appears in the base64url alphabet used by the JWS segments themselves,
 *  so this can't false-positive on a plain JWT. Mirrors sdJwtClaims.ts's isSDJWT exactly. */
function isSDJWT(compact) {
  return typeof compact === 'string' && compact.includes('~');
}

/**
 * Split an SD-JWT compact string into its signed JWT part, disclosure strings, and optional
 * trailing Key-Binding JWT. Per the spec: `<jwt>~<d1>~<d2>~...~<dn>~[<kb-jwt>]` — a trailing `~`
 * with nothing after it means no KB-JWT; a non-empty final segment (that isn't itself consumed as
 * a disclosure — disclosures never contain a bare trailing segment ambiguity here since the
 * format is unambiguous by position) is the KB-JWT.
 */
function splitSDJWT(compact) {
  const parts = compact.split('~');
  const jwtPart = parts[0];
  const last = parts[parts.length - 1];
  const kbJwt = last && last.length > 0 ? last : null;
  const disclosures = parts.slice(1, kbJwt ? parts.length - 1 : parts.length).filter(d => d.length > 0);
  return { jwtPart, disclosures, kbJwt };
}

function decodeSDJWTPart(jwtPart) {
  const segments = jwtPart.split('.');
  if (segments.length !== 3) return null;
  try {
    const header  = JSON.parse(b64urlToBuffer(segments[0]).toString('utf8'));
    const payload = JSON.parse(b64urlToBuffer(segments[1]).toString('utf8'));
    return {
      header,
      payload,
      signingInput: Buffer.from(`${segments[0]}.${segments[1]}`),
      signature: b64urlToBuffer(segments[2])
    };
  } catch (_) {
    return null;
  }
}

/**
 * Verify an SD-JWT's header.payload.signature against `issuerDID`'s DID document. EdDSA
 * counterpart to jwtCrypto.js's verifyES256KSignature — same fail-closed-on-no-match posture, but
 * tries every verification-method list the document exposes (not just assertionMethod): this
 * deployment's CA signs RealPersonIdentity SD-JWTs with a key that isn't necessarily
 * assertionMethod-tagged (confirmed against idl-wallet-v2's sdJwtClaims.ts, which had to do the
 * same broadening on the wallet-verification side of this exact interop gap).
 */
async function verifyEdDSASignature(decoded, issuerDID, resolveIssuerDID) {
  if (decoded.header.alg !== 'EdDSA') {
    console.warn(`[sdJwtCrypto] Unsupported SD-JWT signature algorithm: ${decoded.header.alg}`);
    return false;
  }
  if (!issuerDID) {
    console.warn('[sdJwtCrypto] No issuer DID in SD-JWT — cannot verify signature');
    return false;
  }

  let issuerDoc;
  try {
    issuerDoc = await resolveIssuerDID(issuerDID);
  } catch (err) {
    console.error(`[sdJwtCrypto] DID resolution failed for ${issuerDID}: ${err.message}`);
    return false;
  }

  const candidateVMs = [
    ...(issuerDoc.verificationMethod || []),
    ...(issuerDoc.authentication || []),
    ...(issuerDoc.assertionMethod || []),
    ...(issuerDoc.keyAgreement || []),
    ...(issuerDoc.capabilityInvocation || []),
    ...(issuerDoc.capabilityDelegation || [])
  ].map(ref => (typeof ref === 'object' ? ref : (issuerDoc.verificationMethod || []).find(vm => vm.id === ref) || null))
   .filter(vm => vm && vm.publicKeyJwk && vm.publicKeyJwk.kty === 'OKP' && vm.publicKeyJwk.crv === 'Ed25519');

  if (candidateVMs.length === 0) {
    console.warn(`[sdJwtCrypto] No Ed25519 verification method for issuer ${issuerDID} — rejecting (fail closed)`);
    return false;
  }

  for (const vm of candidateVMs) {
    try {
      const pubKey = crypto.createPublicKey({ key: vm.publicKeyJwk, format: 'jwk' });
      const valid = crypto.verify(null, decoded.signingInput, pubKey, decoded.signature);
      if (valid) {
        console.log(`[sdJwtCrypto] ✅ EdDSA signature verified with key ${vm.id}`);
        return true;
      }
    } catch (err) {
      console.debug(`[sdJwtCrypto] Key ${vm.id} failed: ${err.message}`);
    }
  }

  console.warn(`[sdJwtCrypto] ❌ No key matched SD-JWT signature for issuer ${issuerDID}`);
  return false;
}

/**
 * Recompute each disclosure's digest and merge `{ [claimName]: claimValue }` into the result ONLY
 * when that digest is actually listed in the signed payload's top-level `_sd` array — an
 * unmatched (forged/substituted/unlisted) disclosure is silently dropped, never merged in. This
 * is the entire trust boundary for disclosed values: the SD-JWT's signature covers only
 * header+payload, never the `~`-appended disclosures themselves, so this digest check is what
 * binds a disclosed value back to the signed credential. Flat claims only (this deployment's
 * RealPersonIdentity SD-JWTs have no nested `_sd` arrays — see sdJwtClaims.ts's own comment on
 * this codebase's SD-JWT VC payloads being flat).
 */
function resolveVerifiedDisclosures(payload, disclosures) {
  if (payload._sd_alg && payload._sd_alg.toLowerCase() !== SUPPORTED_SD_HASH_ALG) {
    throw new Error(`Unsupported SD-JWT digest algorithm: ${payload._sd_alg}`);
  }
  const sdDigests = new Set(Array.isArray(payload._sd) ? payload._sd : []);
  // DIAGNOSTIC (2026-09-13, chasing CA Portal's "UNTRUSTED_ISSUER" / classifyCredential returning
  // "?" for a presentation whose wallet-side disclosure frame was confirmed to include every
  // claim, including firstName/lastName/uniqueId). Logs every disclosure's computed digest and
  // whether it matched something in the signed payload's `_sd` set, so a genuine digest/encoding
  // mismatch is visible instead of silently dropping the claim. Remove once root-caused.
  console.log(`[sdJwtCrypto-DIAG] payload._sd (${sdDigests.size}):`, Array.from(sdDigests));
  console.log(`[sdJwtCrypto-DIAG] disclosures received (${disclosures.length})`);
  const claims = {};
  for (const disclosure of disclosures) {
    const digest = crypto.createHash('sha256').update(disclosure).digest('base64url');
    let claimNamePreview = '<undecodable>';
    try {
      const d = JSON.parse(b64urlToBuffer(disclosure).toString('utf8'));
      if (Array.isArray(d) && d.length === 3) claimNamePreview = d[1];
    } catch (_) { /* leave preview as-is */ }
    console.log(`[sdJwtCrypto-DIAG] disclosure claim="${claimNamePreview}" digest=${digest} matched=${sdDigests.has(digest)}`);
    if (!sdDigests.has(digest)) continue; // not referenced by the signed payload — drop, don't trust
    try {
      const decodedArr = JSON.parse(b64urlToBuffer(disclosure).toString('utf8'));
      if (Array.isArray(decodedArr) && decodedArr.length === 3) {
        const [, claimName, claimValue] = decodedArr;
        claims[claimName] = claimValue;
      }
    } catch (_) {
      // Malformed disclosure that happened to hash-match is not possible (digest is over the
      // disclosure's own text) — this branch is unreachable in practice, kept defensive only.
    }
  }
  console.log('[sdJwtCrypto-DIAG] final claims:', claims);
  return claims;
}

/**
 * Full verify: signature + disclosure integrity. Does NOT check holder binding (no KB-JWT
 * concept lives at this layer — see ServiceAccessService.js's own holder-binding gate, which
 * requires a KB-JWT to be present for an SD-JWT presentation exactly as strictly as it already
 * requires rawVpJwt for a JWT-VP one).
 *
 * @returns {Promise<{ success: true, issuerDID: string, subjectDID: string|null, claims: object,
 *   payload: object, kbJwt: string|null } | { success: false, error: string, message: string }>}
 */
async function verifySDJWTCredential(compact, resolveIssuerDID) {
  const { jwtPart, disclosures, kbJwt } = splitSDJWT(compact);
  const decoded = decodeSDJWTPart(jwtPart);
  if (!decoded) {
    return { success: false, error: 'MALFORMED_CREDENTIAL', message: 'SD-JWT header.payload.signature part is malformed' };
  }

  const issuerDID = decoded.payload.iss;
  const sigValid = await verifyEdDSASignature(decoded, issuerDID, resolveIssuerDID);
  if (!sigValid) {
    return { success: false, error: 'INVALID_VC_SIGNATURE', message: 'SD-JWT signature verification failed' };
  }

  let claims;
  try {
    claims = resolveVerifiedDisclosures(decoded.payload, disclosures);
  } catch (err) {
    return { success: false, error: 'UNSUPPORTED_DIGEST_ALG', message: err.message };
  }

  const subjectDID = decoded.payload.sub || null;

  return { success: true, issuerDID, subjectDID, claims, payload: decoded.payload, kbJwt };
}

module.exports = { isSDJWT, splitSDJWT, decodeSDJWTPart, verifyEdDSASignature, resolveVerifiedDisclosures, verifySDJWTCredential };
