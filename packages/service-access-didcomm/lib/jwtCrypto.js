'use strict';

/**
 * jwtCrypto.js — JWT-VC decoding and ES256K signature verification.
 *
 * Extracted from identus-document-service/lib/VPVerificationService.js (the only place in this
 * codebase that actually verified VC-JWT signatures cryptographically, rather than trusting
 * Cloud Agent's internal presentation-verified state alone). Made dependency-injected here
 * (resolveIssuerDID is passed in per call) so this module has no hard dependency on any one
 * service's config/DID-resolution setup.
 */

const crypto = require('crypto');

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
  const rPad = (r[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), r]) : r;
  const sPad = (s[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), s]) : s;
  const body = Buffer.concat([
    Buffer.from([0x02, rPad.length]), rPad,
    Buffer.from([0x02, sPad.length]), sPad
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Decode a JWT string into { header, payload, signingInput, signature }.
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
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
      signature: b64urlToBuffer(parts[2])
    };
  } catch (_) {
    return null;
  }
}

/**
 * Verify an ES256K JWT signature.
 *
 * @param {object} decoded         — output of decodeJWT()
 * @param {string} issuerDID
 * @param {(did: string) => Promise<{verificationMethod: object[], assertionMethod: (string|object)[], authentication: (string|object)[]}>} resolveIssuerDID
 * @param {'assertionMethod'|'authentication'} [keyPurpose='assertionMethod'] — which DID Document
 *   verification relationship to prefer. VC-JWTs (an issuer asserting a claim) are conventionally
 *   signed with an `assertionMethod` key — the default, matching every existing caller of this
 *   function. An outer VP-JWT (a holder proving control of their own DID — DID Auth / holder
 *   binding) is conventionally signed with an `authentication` key instead; pass
 *   `'authentication'` for that case. Either way, if the DID document has no keys under the
 *   requested purpose, this still falls back to trying every secp256k1 verificationMethod.
 * @returns {Promise<boolean>}
 */
async function verifyES256KSignature(decoded, issuerDID, resolveIssuerDID, keyPurpose = 'assertionMethod') {
  if (!issuerDID) {
    console.warn('[jwtCrypto] No issuer DID in JWT — cannot verify signature');
    return false;
  }

  let issuerDoc;
  try {
    issuerDoc = await resolveIssuerDID(issuerDID);
  } catch (err) {
    console.error(`[jwtCrypto] DID resolution failed for ${issuerDID}: ${err.message}`);
    return false;
  }

  const purposeRefs = issuerDoc[keyPurpose] || [];
  const allVMs       = issuerDoc.verificationMethod || [];

  // SECURITY: only keys referenced by the required verification relationship (assertionMethod for
  // credential-issuance signatures, per the W3C VC Data Model) may verify the signature. We MUST
  // NOT fall back to trying every secp256k1 key in `verificationMethod`: PRISM DID documents
  // routinely carry additional secp256k1 keys under OTHER relationships (e.g. an `#auth-key-1`
  // for `authentication`), and accepting a signature from one of those would let a key that is
  // NOT authorized for assertions issue credentials. Fail closed when no assertionMethod key
  // matches. (Verified live: legitimate issuers reference their assertion key under
  // assertionMethod, so this path is unaffected.)
  const keysToTry = purposeRefs
    .map(ref => typeof ref === 'object' ? ref : allVMs.find(vm => vm.id === ref) || null)
    .filter(k => k && k.publicKeyJwk && k.publicKeyJwk.crv === 'secp256k1');

  if (keysToTry.length === 0) {
    console.warn(`[jwtCrypto] No secp256k1 ${keyPurpose} key for issuer ${issuerDID} — rejecting (fail closed)`);
    return false;
  }

  let sigDER;
  try {
    sigDER = compactToDER(decoded.signature);
  } catch (err) {
    console.error(`[jwtCrypto] Invalid signature encoding: ${err.message}`);
    return false;
  }

  for (const vm of keysToTry) {
    try {
      const jwk    = { ...vm.publicKeyJwk, kty: 'EC' };
      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const valid  = crypto.verify('SHA256', decoded.signingInput, { key: pubKey, dsaEncoding: 'der' }, sigDER);
      if (valid) {
        console.log(`[jwtCrypto] ✅ ES256K signature verified with key ${vm.id}`);
        return true;
      }
    } catch (err) {
      console.debug(`[jwtCrypto] Key ${vm.id} failed: ${err.message}`);
    }
  }

  console.warn(`[jwtCrypto] ❌ No key matched signature for issuer ${issuerDID}`);
  return false;
}

module.exports = { b64urlToBuffer, compactToDER, decodeJWT, verifyES256KSignature };
