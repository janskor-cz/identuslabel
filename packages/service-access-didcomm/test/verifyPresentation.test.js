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

  console.log('verifyPresentation: all tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
