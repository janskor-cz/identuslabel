'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { verifyPresentationCredentials } = require('../lib/verifyPresentation');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a real ES256K-signed JWT-VC using a freshly generated secp256k1 keypair, so this test
// exercises the actual DER-signature verification path (compactToDER + crypto.verify) without
// any network calls or fixture files — mirrors what a real Cloud Agent-issued JWT-VC looks like.
function makeSignedVcJwt({ issuerDID, credentialSubject, keyId }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });

  const header  = { alg: 'ES256K', typ: 'JWT' };
  const payload = { iss: issuerDID, vc: { credentialSubject } };

  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const derSig = crypto.sign('SHA256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'der' });

  // Convert DER back to compact r||s (32+32 bytes) the way a real JWT-VC signature is encoded.
  // Minimal DER parser sufficient for this test's own signatures.
  function derToCompact(der) {
    let offset = 2; // skip SEQUENCE tag+len
    function readInt() {
      offset += 1; // INTEGER tag
      let len = der[offset]; offset += 1;
      let bytes = der.slice(offset, offset + len); offset += len;
      if (bytes.length > 32) bytes = bytes.slice(bytes.length - 32); // strip leading 0x00 pad
      if (bytes.length < 32) bytes = Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
      return bytes;
    }
    const r = readInt();
    const s = readInt();
    return Buffer.concat([r, s]);
  }
  const compactSig = derToCompact(derSig);

  const jwt = `${signingInput}.${b64url(compactSig)}`;

  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  const verificationMethod = [{ id: keyId, publicKeyJwk: { ...publicKeyJwk, crv: 'secp256k1' } }];

  return { jwt, verificationMethod };
}

async function run() {
  const issuerDID = 'did:prism:issuer1';
  const { jwt, verificationMethod } = makeSignedVcJwt({
    issuerDID,
    credentialSubject: { role: 'engineer', department: 'R&D' },
    keyId: `${issuerDID}#key-1`
  });

  const resolveIssuerDID = async (did) => {
    assert.strictEqual(did, issuerDID);
    return { verificationMethod, assertionMethod: [verificationMethod[0].id] };
  };

  const result = await verifyPresentationCredentials({ verifiableCredential: [jwt] }, resolveIssuerDID);
  assert.strictEqual(result.success, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.credentials.length, 1);
  assert.strictEqual(result.credentials[0].issuerDID, issuerDID);
  assert.strictEqual(result.credentials[0].claims.role, 'engineer');

  // Tampering with the payload after signing must fail verification.
  const [h, p, s] = jwt.split('.');
  const tamperedPayload = b64url(Buffer.from(JSON.stringify({ iss: issuerDID, vc: { credentialSubject: { role: 'attacker' } } })));
  const tamperedJwt = `${h}.${tamperedPayload}.${s}`;
  const tamperedResult = await verifyPresentationCredentials({ verifiableCredential: [tamperedJwt] }, resolveIssuerDID);
  assert.strictEqual(tamperedResult.success, false, 'tampered payload must fail signature verification');
  assert.strictEqual(tamperedResult.error, 'INVALID_VC_SIGNATURE');

  // No credentials at all
  const empty = await verifyPresentationCredentials({ verifiableCredential: [] }, resolveIssuerDID);
  assert.strictEqual(empty.success, false);
  assert.strictEqual(empty.error, 'NoCredentials');

  // ── Holder binding (rawVpJwt supplied) ──────────────────────────────────────
  const holderDID = 'did:prism:holder-abc';
  const otherDID  = 'did:prism:someone-else';
  const { publicKey: holderPub, privateKey: holderPriv } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const holderPublicKeyJwk = { ...holderPub.export({ format: 'jwk' }), crv: 'secp256k1' };

  function makeSignedVpJwt({ issDID, vcJwts, signWith }) {
    const header  = { alg: 'ES256K', typ: 'JWT' };
    const payload = { iss: issDID, vp: { verifiableCredential: vcJwts } };
    const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
    const derSig = crypto.sign('SHA256', Buffer.from(signingInput), { key: signWith, dsaEncoding: 'der' });
    // reuse the same compact-signature conversion as makeSignedVcJwt via a tiny local copy
    function derToCompact(der) {
      let offset = 2;
      function readInt() {
        offset += 1;
        const len = der[offset]; offset += 1;
        let bytes = der.slice(offset, offset + len); offset += len;
        if (bytes.length > 32) bytes = bytes.slice(bytes.length - 32);
        if (bytes.length < 32) bytes = Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
        return bytes;
      }
      return Buffer.concat([readInt(), readInt()]);
    }
    return `${signingInput}.${b64url(derToCompact(derSig))}`;
  }

  // Success: VC subject === outer VP iss, outer signature verifies against holder's authentication key.
  // NOTE: `makeSignedVcJwt` generates a fresh keypair on every call, so each call's own returned
  // `verificationMethod` — not the top-of-file one bound to the very first `jwt` — is what a
  // resolver must hand back for `issuerDID` to successfully verify THIS particular VC-JWT.
  const { jwt: boundVcJwt, verificationMethod: boundVM } = makeSignedVcJwt({
    issuerDID,
    credentialSubject: { role: 'engineer', id: holderDID },
    keyId: `${issuerDID}#key-1`
  });
  const resolveForBound = async (did) => {
    if (did === issuerDID) return { verificationMethod: boundVM, assertionMethod: [boundVM[0].id] };
    if (did === holderDID) return { verificationMethod: [{ id: `${holderDID}#key-1`, publicKeyJwk: holderPublicKeyJwk }], authentication: [`${holderDID}#key-1`] };
    throw new Error(`unexpected DID resolution: ${did}`);
  };
  const goodVpJwt = makeSignedVpJwt({ issDID: holderDID, vcJwts: [boundVcJwt], signWith: holderPriv });
  const boundResult = await verifyPresentationCredentials({ verifiableCredential: [boundVcJwt], rawVpJwt: goodVpJwt }, resolveForBound);
  assert.strictEqual(boundResult.success, true, `expected holder-bound success, got: ${JSON.stringify(boundResult)}`);
  assert.strictEqual(boundResult.holderBindingChecked, true);
  assert.strictEqual(boundResult.holderDID, holderDID);

  // Failure: VC subject belongs to someone else — outer VP is validly signed by holderDID, but
  // the credential inside was issued to a different subject (the "stolen VC-JWT" scenario).
  const { jwt: stolenVcJwt, verificationMethod: stolenVM } = makeSignedVcJwt({
    issuerDID,
    credentialSubject: { role: 'engineer', id: otherDID },
    keyId: `${issuerDID}#key-1`
  });
  const resolveForStolen = async (did) => {
    if (did === issuerDID) return { verificationMethod: stolenVM, assertionMethod: [stolenVM[0].id] };
    if (did === holderDID) return { verificationMethod: [{ id: `${holderDID}#key-1`, publicKeyJwk: holderPublicKeyJwk }], authentication: [`${holderDID}#key-1`] };
    throw new Error(`unexpected DID resolution: ${did}`);
  };
  const replayVpJwt = makeSignedVpJwt({ issDID: holderDID, vcJwts: [stolenVcJwt], signWith: holderPriv });
  const replayResult = await verifyPresentationCredentials({ verifiableCredential: [stolenVcJwt], rawVpJwt: replayVpJwt }, resolveForStolen);
  assert.strictEqual(replayResult.success, false, 'a VC whose subject differs from the VP holder must be rejected');
  assert.strictEqual(replayResult.error, 'HOLDER_BINDING_FAILED');

  // Failure: outer VP JWT signed by a DIFFERENT key than the one its iss DID resolves to
  // (forged holder signature) — must not verify even though the inner VC signature is fine.
  const { privateKey: attackerPriv } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const forgedVpJwt = makeSignedVpJwt({ issDID: holderDID, vcJwts: [boundVcJwt], signWith: attackerPriv });
  const forgedResult = await verifyPresentationCredentials({ verifiableCredential: [boundVcJwt], rawVpJwt: forgedVpJwt }, resolveForBound);
  assert.strictEqual(forgedResult.success, false, 'outer VP JWT signed by a key not belonging to iss DID must be rejected');
  assert.strictEqual(forgedResult.error, 'HOLDER_BINDING_FAILED');

  // Backward compatibility: omitting rawVpJwt entirely (as company-admin-portal's
  // verifyAndExtractRealPersonClaims does — it performs holder binding itself beforehand) must
  // still succeed on issuer-signature verification alone, unchanged from before this fix.
  const noRawJwtResult = await verifyPresentationCredentials({ verifiableCredential: [boundVcJwt] }, resolveForBound);
  assert.strictEqual(noRawJwtResult.success, true);
  assert.strictEqual(noRawJwtResult.holderBindingChecked, false);

  console.log('verifyPresentation: all tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
