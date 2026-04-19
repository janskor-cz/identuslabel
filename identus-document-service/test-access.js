'use strict';
/**
 * test-access.js
 *
 * End-to-end test: POST /documents/:did/access with a crafted VP,
 * decrypt the response, and save the file to disk.
 *
 * Usage:
 *   node test-access.js [documentDID]
 *
 * Uses ACME's company DID as the VP issuer (must be in releasableTo).
 */

const nacl   = require('tweetnacl');
const crypto = require('crypto');
const fs     = require('fs');
const fetch  = require('node-fetch');

const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3020';

const DOCUMENT_DID = process.argv[2] ||
  'did:prism:b7addd91e17fb0fb74500b51e1c40d3435e7e15cd0338e2846c4df3dc3e9bca3:CvMCCvACEjsKB21hc3RlcjAQAUouCglzZWNwMjU2azESIQIwYz95KwrjV6SnAHfbkW4YRqRwsyGhf4m8sD-Ytm0d5hrhAQoIbWV0YWRhdGESEERvY3VtZW50TWV0YWRhdGEawgF7ImlhZ29uRmlsZUlkIjoiNjljMDI1OTY2OTNlYzAzOTI0YjI0NWI2IiwiY2xlYXJhbmNlTGV2ZWwiOiJVTkNMQVNTSUZJRUQiLCJyZWxlYXNhYmxlVG8iOlsiZGlkOnByaXNtOjQ3NGM5MTUxNmE4NzViYTlhZjlmMzlhM2I5NzQ3Y2I3MGFkNzY4NGYwYjNmYjhlZTJiN2IxNDVlZmFjMjg2YjkiXSwiaWFnb25FbmNNYW5pZmVzdElkIjpudWxsfRpNCgZhY2Nlc3MSEkRvY3VtZW50QWNjZXNzR2F0ZRovaHR0cHM6Ly9pZGVudHVzbGFiZWwuY3ovZG9jdW1lbnQtc2VydmljZS9hY2Nlc3M';

// ACME's company DID — must be in the document's releasableTo
const ACME_DID = 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9';

// ── Build a minimal unsigned JWT ────────────────────────────────────────────
function buildFakeJWT(payload) {
  const header  = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = Buffer.alloc(64).toString('base64url'); // null signature — service has fallback
  return `${header}.${body}.${sig}`;
}

// EmployeeRole VC — the only required credential
function buildEmployeeRoleJWT(issuerDID) {
  return buildFakeJWT({
    iss: issuerDID,
    sub: 'did:key:test-employee',
    iat: Math.floor(Date.now() / 1000),
    vc: {
      '@context':        ['https://www.w3.org/2018/credentials/v1'],
      type:              ['VerifiableCredential', 'EmployeeRoleCredential'],
      credentialSubject: {
        issuerDID,
        employeeId: 'test-employee-001',
        role:       'Engineer',
        department: 'Technology',
        email:      'test@acme.example.com'
      }
    }
  });
}

// SecurityClearance VC — optional but sets clearanceLevel
function buildClearanceJWT(issuerDID, clearanceLevel) {
  return buildFakeJWT({
    iss: issuerDID,
    sub: 'did:key:test-employee',
    iat: Math.floor(Date.now() / 1000),
    vc: {
      '@context':        ['https://www.w3.org/2018/credentials/v1'],
      type:              ['VerifiableCredential', 'SecurityClearanceCredential'],
      credentialSubject: { clearanceLevel }
    }
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('Document Access Test');
  console.log('='.repeat(60));
  console.log(`Service:  ${DOCUMENT_SERVICE_URL}`);
  console.log(`DID:      ${DOCUMENT_DID.substring(0, 60)}...`);
  console.log(`IssuerDID: ${ACME_DID.substring(0, 50)}...`);
  console.log();

  // Generate ephemeral X25519 keypair
  const ephemeralKeyPair = nacl.box.keyPair();
  const ephemeralPublicKeyB64 = Buffer.from(ephemeralKeyPair.publicKey).toString('base64');
  console.log(`Ephemeral public key: ${ephemeralPublicKeyB64.substring(0, 20)}...`);

  // Build VP
  const vp = {
    '@context':            ['https://www.w3.org/2018/credentials/v1'],
    type:                  ['VerifiablePresentation'],
    verifiableCredential:  [
      buildEmployeeRoleJWT(ACME_DID),
      buildClearanceJWT(ACME_DID, 'UNCLASSIFIED')
    ]
  };

  const body = {
    documentDID:       DOCUMENT_DID,
    ephemeralPublicKey: ephemeralPublicKeyB64,
    vp,
    timestamp:  new Date().toISOString(),
    nonce:      crypto.randomUUID(),
    ephemeralDID: `did:key:ephemeral-${crypto.randomUUID()}`
  };

  console.log(`\nPOST ${DOCUMENT_SERVICE_URL}/documents/...did.../access`);
  const res = await fetch(
    `${DOCUMENT_SERVICE_URL}/documents/${encodeURIComponent(DOCUMENT_DID)}/access`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    }
  );

  console.log(`HTTP ${res.status}`);
  const json = await res.json();

  if (!res.ok || !json.success) {
    console.error('Access DENIED:', JSON.stringify(json, null, 2));
    process.exit(1);
  }

  console.log(`\nAccess GRANTED`);
  console.log(`  copyId:        ${json.copyId}`);
  console.log(`  copyHash:      ${json.copyHash}`);
  console.log(`  filename:      ${json.filename}`);
  console.log(`  mimeType:      ${json.mimeType}`);
  console.log(`  clearanceLevel: ${json.clearanceLevel}`);
  console.log(`  accessedAt:    ${json.accessedAt}`);

  // Decrypt
  const { ciphertext, nonce: encNonce, senderPublicKey } = json.encryptedDocument;

  const decrypted = nacl.box.open(
    new Uint8Array(Buffer.from(ciphertext,      'base64')),
    new Uint8Array(Buffer.from(encNonce,        'base64')),
    new Uint8Array(Buffer.from(senderPublicKey, 'base64')),
    ephemeralKeyPair.secretKey
  );

  if (!decrypted) {
    console.error('\nDecryption FAILED — ciphertext could not be opened');
    process.exit(1);
  }

  const outFile = `/tmp/test-doc-${json.copyId}.bin`;
  fs.writeFileSync(outFile, Buffer.from(decrypted));
  console.log(`\nDecrypted ${decrypted.length} bytes → ${outFile}`);
  console.log(`  (rename to .${(json.filename || 'file').split('.').pop()} to open)`);
  console.log('\nTest PASSED ✓');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
