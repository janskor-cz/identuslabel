// Test full ephemeral access flow

const nacl = require('tweetnacl');
const crypto = require('crypto');

const documentDID = 'did:prism:672de2fad07e9b9beed280a3be9c253170bfcbfb97ccb75e64f119c243bae231:CsoBCscBEjsKB21hc3RlcjAQAUouCglzZWNwMjU2azESIQPJPr-m0RxNVZtJdxEoKSe_VhVqRi-ndFgfLYF_flAjKRqHAQoNaWFnb24tc3RvcmFnZRIMSWFnb25TdG9yYWdlGmhbImh0dHBzOi8vZ3cuaWFnb24uY29tL2FwaS92Mi9kb3dubG9hZD9maWxlSWQ9NjkzNzI3YzAwN2ViZjNkM2NjZDViM2FiJmZpbGVuYW1lPTQtVG9tbXklMjBIaWxmaWdlci5wZGYiXQ';
const issuerDID = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';
const requestorDID = 'did:prism:test-requestor';

// Generate ephemeral X25519 keypair (for client)
const ephemeralKeyPair = nacl.box.keyPair();
const ephemeralPublicKey = Buffer.from(ephemeralKeyPair.publicKey).toString('base64');
const ephemeralDID = 'did:key:z' + Buffer.from(ephemeralKeyPair.publicKey).toString('hex');

// Generate Ed25519 signature keypair (for signing the request)
const signKeyPair = nacl.sign.keyPair();

// Create access request
const timestamp = new Date().toISOString();
const nonce = crypto.randomUUID();

// Create payload to sign
const payload = JSON.stringify({
  documentDID,
  ephemeralDID,
  timestamp,
  nonce
});

// Sign with Ed25519
const signature = nacl.sign.detached(
  new Uint8Array(Buffer.from(payload)),
  signKeyPair.secretKey
);
const signatureBase64 = Buffer.from(signature).toString('base64');

console.log('=== Ephemeral Access Test ===');
console.log('Document DID:', documentDID.substring(0, 50) + '...');
console.log('Issuer DID:', issuerDID.substring(0, 50) + '...');
console.log('Ephemeral Public Key:', ephemeralPublicKey.substring(0, 40) + '...');
console.log('Signature length:', signature.length, 'bytes');
console.log('');

const accessRequest = {
  documentDID,
  requestorDID,
  issuerDID,
  clearanceLevel: 2, // CONFIDENTIAL
  ephemeralDID,
  ephemeralPublicKey,
  signature: signatureBase64,
  timestamp,
  nonce
};

console.log('Sending access request...');
console.log('');

fetch(`http://localhost:3010/api/ephemeral-documents/access`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(accessRequest)
})
  .then(res => res.json())
  .then(data => {
    console.log('=== Access Response ===');

    if (data.success) {
      console.log('✅ ACCESS GRANTED');
      console.log('Copy ID:', data.copyId);
      console.log('Copy Hash:', data.copyHash);
      console.log('Filename:', data.filename);
      console.log('Classification:', data.classificationLevel);
      console.log('Ciphertext length:', data.ciphertext ? data.ciphertext.length : 'N/A', 'chars');
      console.log('Server Public Key:', data.serverPublicKey ? data.serverPublicKey.substring(0, 30) + '...' : 'N/A');

      // Try to decrypt
      if (data.ciphertext && data.nonce && data.serverPublicKey) {
        try {
          const ciphertext = Buffer.from(data.ciphertext, 'base64');
          const decryptNonce = Buffer.from(data.nonce, 'base64');
          const serverPubKey = Buffer.from(data.serverPublicKey, 'base64');

          const decrypted = nacl.box.open(
            new Uint8Array(ciphertext),
            new Uint8Array(decryptNonce),
            new Uint8Array(serverPubKey),
            ephemeralKeyPair.secretKey
          );

          if (decrypted) {
            console.log('');
            console.log('✅ DECRYPTION SUCCESSFUL');
            console.log('Decrypted content length:', decrypted.length, 'bytes');

            // Show first 200 bytes
            const preview = Buffer.from(decrypted).toString('utf8', 0, 200);
            console.log('Content preview:', preview.substring(0, 100) + '...');
          } else {
            console.log('');
            console.log('❌ DECRYPTION FAILED - null result');
          }
        } catch (decErr) {
          console.log('');
          console.log('❌ DECRYPTION ERROR:', decErr.message);
        }
      }
    } else {
      console.log('❌ ACCESS DENIED');
      console.log('Error:', data.error);
      console.log('Message:', data.message);
    }
  })
  .catch(err => {
    console.error('❌ Request Error:', err.message);
  });
