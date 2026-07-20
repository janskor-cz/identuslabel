'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { decodeJWT, verifyES256KSignature } = require('../lib/jwtCrypto');

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function run() {
  const issuerDID = 'did:prism:keypurpose-test';

  // Two distinct keypairs: one referenced only under `authentication`, one only under
  // `assertionMethod` — mirrors a real DID document where a holder's DID-Auth key (used to
  // sign an outer VP-JWT) differs from their VC-assertion key.
  const authKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const assertionKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });

  const didDoc = {
    verificationMethod: [
      { id: `${issuerDID}#auth-key-1`, publicKeyJwk: { ...authKeyPair.publicKey.export({ format: 'jwk' }), crv: 'secp256k1' } },
      { id: `${issuerDID}#assertion-key-1`, publicKeyJwk: { ...assertionKeyPair.publicKey.export({ format: 'jwk' }), crv: 'secp256k1' } },
    ],
    assertionMethod: [`${issuerDID}#assertion-key-1`],
    authentication: [`${issuerDID}#auth-key-1`],
  };
  const resolveIssuerDID = async () => didDoc;

  // Sign a JWT with the AUTH key (as a real outer VP-JWT / DID-Auth presentation would be).
  const jwt = signCompactWithDerToCompact({ iss: issuerDID }, authKeyPair.privateKey);
  const decoded = decodeJWT(jwt);

  // Default purpose ('assertionMethod') exists and is non-empty on this DID (assertion-key-1 is
  // registered there) — so per the documented fallback rule ("only falls back when the
  // requested purpose has NO keys"), it must NOT fall back to authentication, and verification
  // against the wrong key must fail.
  const wrongPurpose = await verifyES256KSignature(decoded, issuerDID, resolveIssuerDID);
  assert.strictEqual(wrongPurpose, false, 'must not verify against assertionMethod when signed with an authentication-only key present in a non-empty assertionMethod');

  // Explicitly requesting 'authentication' must find and verify against auth-key-1.
  const rightPurpose = await verifyES256KSignature(decoded, issuerDID, resolveIssuerDID, 'authentication');
  assert.strictEqual(rightPurpose, true, 'must verify against the authentication key when keyPurpose="authentication" is requested');

  // Fail closed: if the DID document has NO keys at all under the requested purpose,
  // verification must NOT fall back to trying every secp256k1 verificationMethod (that would let
  // a key authorized for a DIFFERENT purpose, e.g. assertionMethod, verify a signature that
  // requires authentication, or vice versa) — it must simply reject.
  const docWithEmptyAuth = { ...didDoc, authentication: [] };
  const fallbackResult = await verifyES256KSignature(decoded, issuerDID, async () => docWithEmptyAuth, 'authentication');
  assert.strictEqual(fallbackResult, false, 'must NOT fall back to other secp256k1 VMs when the requested purpose array is empty — fail closed instead');

  console.log('jwtCrypto: all tests passed');
}

// Local helper: sign and emit a JWT with a COMPACT (not DER) signature, matching real JWT-VC
// wire format — mirrors the same conversion used in the other test files in this package.
function signCompactWithDerToCompact(payloadObj, privateKey) {
  const header = { alg: 'ES256K', typ: 'JWT' };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payloadObj)))}`;
  const der = crypto.sign('SHA256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'der' });
  // DER -> compact (r||s), reversing jwtCrypto's own compactToDER for this synthetic test JWT.
  let offset = 2;
  function readInt() {
    offset += 1;
    const len = der[offset]; offset += 1;
    let bytes = der.slice(offset, offset + len); offset += len;
    if (bytes.length > 32) bytes = bytes.slice(bytes.length - 32);
    if (bytes.length < 32) bytes = Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
    return bytes;
  }
  const compact = Buffer.concat([readInt(), readInt()]);
  return `${signingInput}.${b64url(compact)}`;
}

run().catch(err => { console.error(err); process.exit(1); });
