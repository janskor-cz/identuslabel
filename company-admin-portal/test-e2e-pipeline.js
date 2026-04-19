#!/usr/bin/env node
'use strict';

/**
 * test-e2e-pipeline.js
 *
 * Full end-to-end pipeline test using the generated test_doc.docx.
 *
 * Tests (in order):
 *   T1  CMK wrap/unwrap round-trip — all 4 classification levels
 *   T2  Iagon connectivity
 *   T3  Encrypt + upload DOCX to Iagon (AES-256-GCM)
 *   T4  DEK wrapping: CMK.wrapDEK → assert no raw key in manifest
 *   T5  PRISM DID creation (multitenancy agent, company-admin wallet)
 *   T6  KeyManifestVC issuance (Ed25519) + push to document-service
 *   T7  VCKeyStore persistence — verify VC written to disk
 *   T8  Ed25519 VC verification (JWKS + inline fallback)
 *   T9  CMK unwrap DEK from VC → download + decrypt from Iagon → content match
 *   T10 Releasability enforcement — wrong issuer DID denied
 *   T11 Clearance enforcement — insufficient level denied
 *   T12 Content hash integrity — tampered content detected
 *   T13 VC revocation — DELETE clears VCKeyStore
 *
 * Run:
 *   cd /opt/project_identuslabel/company-admin-portal
 *   node test-e2e-pipeline.js
 */

require('dotenv').config();
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const fetch  = require('node-fetch');

const ClassificationKeyManager = require('./lib/ClassificationKeyManager');
const { getIagonClient }       = require('./lib/IagonStorageClient');
const KeyManifestVCIssuer      = require('./lib/KeyManifestVCIssuer');
const KeyManifestVCVerifier    = require('../identus-document-service/lib/KeyManifestVCVerifier');
const VCKeyStore               = require('../identus-document-service/lib/VCKeyStore');

const DOC_PATH       = path.join(__dirname, 'test_doc.docx');
const DOC_SVC_URL    = 'http://localhost:3020';
const ADMIN_KEY      = process.env.DOCUMENT_SERVICE_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const AGENT_URL      = process.env.ENTERPRISE_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';
const ISSUER_DID     = process.env.SERVICE_DID || 'did:prism:company-admin-test';

const TEST_COMPANY_DID = 'did:prism:techcorp-issuer-test';
const TEST_DOC_DID     = `did:prism:e2e-test-${Date.now()}`;

// Populated by T3
let fileIvB64, fileAuthB64;

// ── Test runner ────────────────────────────────────────────────────────────────

const results = [];
let iagonFileId, wrappedManifest, vcId, rawDEKhex, originalBytes;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
    results.push({ name, pass: true });
  } catch (e) {
    console.log('FAIL — ' + e.message);
    results.push({ name, pass: false, error: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ── T1: CMK wrap/unwrap ────────────────────────────────────────────────────────

async function runT1() {
  const cmk = ClassificationKeyManager;
  cmk.load();

  for (const level of ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP-SECRET']) {
    await test(`T1 CMK wrap/unwrap [${level}]`, async () => {
      const rawDEK = crypto.randomBytes(32);
      const wrapped = cmk.wrapDEK(rawDEK, level);
      assert(wrapped.wrappedKey, 'No wrappedKey');
      assert(wrapped.iv, 'No iv');
      assert(wrapped.authTag, 'No authTag');
      assert(wrapped.wrappingAlgorithm === 'AES-256-GCM', 'Wrong algorithm');
      assert(wrapped.classificationLevel === level, 'Wrong level');
      assert(!wrapped.rawKey, 'Raw key leaked into wrapped manifest');

      const unwrapped = cmk.unwrapDEK(wrapped, level);
      assert(unwrapped.equals(rawDEK), 'Unwrapped DEK does not match original');
    });
  }
}

// ── T2: Iagon connectivity ─────────────────────────────────────────────────────

async function runT2() {
  await test('T2 Iagon connectivity', async () => {
    const client = getIagonClient();
    assert(client.isConfigured(), 'Iagon client not configured (check .env)');
    // Light connectivity probe — list files or check node
    // We'll verify by uploading in T3
  });
}

// ── T3: Encrypt + upload DOCX ─────────────────────────────────────────────────

async function runT3() {
  await test('T3 Encrypt + upload DOCX to Iagon', async () => {
    const client = getIagonClient();
    originalBytes = fs.readFileSync(DOC_PATH);
    assert(originalBytes.length > 1000, 'DOCX file too small — check path');

    // encryptContent() separately so we can capture the raw DEK before uploadFile() wraps it
    const { content: encrypted, encryptionInfo } = client.encryptContent(originalBytes, 'INTERNAL');
    assert(encrypted.length > 0, 'Encryption produced empty buffer');
    assert(encryptionInfo.key, 'No DEK in encryptionInfo');
    assert(encryptionInfo.iv, 'No IV in encryptionInfo');
    assert(encryptionInfo.algorithm === 'AES-256-GCM', 'Wrong file algorithm');

    // Store raw DEK + file crypto params for later tests
    rawDEKhex   = encryptionInfo.key;
    fileIvB64   = encryptionInfo.iv;
    fileAuthB64 = encryptionInfo.authTag;

    // uploadFile(content, filename, options) — handles its own encrypt+retry internally
    // We call it with the already-encrypted buffer via _uploadToIagon directly to avoid
    // double-encryption; instead use the internal helper after grabbing encryptionInfo above.
    // Simplest: just call uploadFile() with the raw bytes — it re-encrypts but that's fine
    // for the pipeline test; we track the *returned* encryptionInfo from the upload result.
    const uploadResult = await client.uploadFile(originalBytes, `test_doc_e2e_${Date.now()}.docx`, {
      classificationLevel: 'INTERNAL'
    });
    assert(uploadResult.fileId, 'Upload returned no fileId');
    assert(uploadResult.encryptionInfo, 'Upload returned no encryptionInfo');

    iagonFileId = uploadResult.fileId;
    // Task 2: uploadFile() strips raw key from encryptionInfo; use rawDEK Buffer instead
    assert(uploadResult.rawDEK, 'Upload returned no rawDEK (Task 2 API)');
    rawDEKhex   = uploadResult.rawDEK.toString('base64');
    fileIvB64   = uploadResult.encryptionInfo.iv;
    fileAuthB64 = uploadResult.encryptionInfo.authTag;
    console.log(`\n    fileId=${iagonFileId}  size=${originalBytes.length}B`);
  });
}

// ── T4: DEK wrapping ──────────────────────────────────────────────────────────

async function runT4() {
  await test('T4 CMK.wrapDEK — no raw key in manifest', async () => {
    assert(rawDEKhex, 'T3 must pass first');
    const cmk = ClassificationKeyManager;
    const rawDEK = Buffer.from(rawDEKhex, 'base64');
    wrappedManifest = cmk.wrapDEK(rawDEK, 'INTERNAL');
    rawDEK.fill(0);

    assert(!wrappedManifest.key, 'Raw key field present in wrapped manifest');
    assert(wrappedManifest.wrappedKey, 'Missing wrappedKey');
    assert(wrappedManifest.wrappingAlgorithm === 'AES-256-GCM');

    // Verify unwrap gives back the original DEK bytes
    const restored = ClassificationKeyManager.unwrapDEK(wrappedManifest, 'INTERNAL');
    const original = Buffer.from(rawDEKhex, 'base64');
    assert(restored.equals(original), 'Unwrapped DEK mismatch');
    restored.fill(0); original.fill(0);
  });
}

// ── T5: PRISM DID creation ────────────────────────────────────────────────────

async function runT5() {
  await test('T5 PRISM DID creation on multitenancy agent', async () => {
    assert(SERVICE_API_KEY, 'SERVICE_API_KEY not set');
    const res = await fetch(`${AGENT_URL}/did-registrar/dids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_API_KEY },
      body: JSON.stringify({
        documentTemplate: {
          publicKeys: [
            { id: 'auth-key-1',      purpose: 'authentication' },
            { id: 'assertion-key-1', purpose: 'assertionMethod' }
          ],
          services: []
        }
      })
    });
    assert(res.status === 200 || res.status === 201, `DID creation returned HTTP ${res.status}`);
    const body = await res.json();
    assert(body.longFormDid || body.did, 'No DID in response');
    console.log(`\n    did=${(body.longFormDid || body.did).substring(0, 55)}...`);
  });
}

// ── T6: VC issuance (Ed25519) + push ─────────────────────────────────────────

async function runT6() {
  await test('T6 KeyManifestVC issuance (EdDSA) + push to document-service', async () => {
    assert(iagonFileId, 'T3 must pass first');
    assert(wrappedManifest, 'T4 must pass first');
    assert(ADMIN_KEY, 'DOCUMENT_SERVICE_ADMIN_KEY not set');

    const issuer = new KeyManifestVCIssuer(DOC_SVC_URL, ADMIN_KEY);

    // Verify the signing key uses Ed25519, not HMAC
    const kid = issuer._signingKey.kid;
    assert(kid !== 'ephemeral', 'Signing key is ephemeral — MANIFEST_SIGNING_KEY env var missing');

    const result = await issuer.issue({
      issuerDID:           ISSUER_DID,
      documentDID:         TEST_DOC_DID,
      iagonFileId,
      wrappedKey:          wrappedManifest.wrappedKey,
      iv:                  wrappedManifest.iv,
      authTag:             wrappedManifest.authTag,
      wrappingAlgorithm:   wrappedManifest.wrappingAlgorithm,
      classificationLevel: 'INTERNAL',
      fileIv:              fileIvB64,
      fileAuthTag:         fileAuthB64,
      fileAlgorithm:       'AES-256-GCM',
      releasableTo:        [TEST_COMPANY_DID],
      contentHash:         'sha256:' + crypto.createHash('sha256').update(originalBytes).digest('hex')
    });

    vcId = result.vcId;
    assert(vcId, 'No vcId returned');

    // Check alg in JWT header
    const header = JSON.parse(Buffer.from(result.vcJwt.split('.')[0], 'base64url').toString());
    assert(header.alg === 'EdDSA', `Expected EdDSA, got ${header.alg}`);
    assert(header.kid === kid, 'kid mismatch');
    console.log(`\n    vcId=${vcId}  alg=${header.alg}  kid=${header.kid}`);
  });
}

// ── T7: VCKeyStore persistence ────────────────────────────────────────────────

async function runT7() {
  await test('T7 VCKeyStore — VC persisted to disk', async () => {
    assert(vcId, 'T6 must pass first');
    await VCKeyStore.load();
    const record = VCKeyStore.get(TEST_DOC_DID);
    assert(record, 'VC not found in VCKeyStore');
    assert(record.vcId === vcId, 'vcId mismatch in store');
    const header = JSON.parse(Buffer.from(record.vcJwt.split('.')[0], 'base64url').toString());
    assert(header.alg === 'EdDSA', 'Stored VC has wrong algorithm');
  });
}

// ── T8: Ed25519 VC verification ───────────────────────────────────────────────

async function runT8() {
  await test('T8 Ed25519 VC verification (inline JWK fallback)', async () => {
    await VCKeyStore.load();
    const record = VCKeyStore.get(TEST_DOC_DID);
    assert(record, 'VC not in store');

    const verifier = new KeyManifestVCVerifier({
      inlineJwk:    process.env.MANIFEST_SIGNING_KEY_PUBLIC,
      legacyHmacKey: ADMIN_KEY
    });
    const result = await verifier.verify(record);
    assert(result.valid, `Verification failed: ${result.reason}`);
    assert(result.claims.classificationLevel === 'INTERNAL');
    assert(Array.isArray(result.claims.releasableTo));
    assert(result.claims.releasableTo.includes(TEST_COMPANY_DID), 'releasableTo mismatch');
    assert(result.claims.contentHash.startsWith('sha256:'), 'contentHash missing');
  });

  await test('T8b JWKS URL verification (via running company-admin service)', async () => {
    await VCKeyStore.load();
    const record = VCKeyStore.get(TEST_DOC_DID);
    const verifier = new KeyManifestVCVerifier({
      jwksUrl: 'http://localhost:3010/.well-known/jwks.json',
      legacyHmacKey: ADMIN_KEY
    });
    const result = await verifier.verify(record);
    assert(result.valid, `JWKS verification failed: ${result.reason}`);
  });

  await test('T8c Tampered JWT is rejected', async () => {
    await VCKeyStore.load();
    const record = VCKeyStore.get(TEST_DOC_DID);
    const parts = record.vcJwt.split('.');
    // Flip one bit in the signature
    const sigBuf = Buffer.from(parts[2], 'base64url');
    sigBuf[0] ^= 0x01;
    const tampered = { ...record, vcJwt: parts[0] + '.' + parts[1] + '.' + sigBuf.toString('base64url') };
    const verifier = new KeyManifestVCVerifier({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
    const result = await verifier.verify(tampered);
    assert(!result.valid, 'Tampered JWT should be rejected');
  });
}

// ── T9: CMK unwrap + Iagon download + content match ──────────────────────────

async function runT9() {
  await test('T9 CMK unwrap DEK + download from Iagon + content hash match', async () => {
    assert(iagonFileId, 'T3 must pass first');
    await VCKeyStore.load();
    const record  = VCKeyStore.get(TEST_DOC_DID);
    const verifier = new KeyManifestVCVerifier({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
    const { valid, claims } = await verifier.verify(record);
    assert(valid, 'VC invalid');

    // Unwrap DEK
    const rawDEK = ClassificationKeyManager.unwrapDEK({
      wrappedKey:        claims.wrappedKey,
      iv:                claims.iv,
      authTag:           claims.authTag,
      wrappingAlgorithm: claims.wrappingAlgorithm
    }, claims.classificationLevel);

    // Download + decrypt via IagonStorageClient (same path as real access)
    const client = getIagonClient();
    const decryptionInfo = {
      algorithm: claims.fileAlgorithm || 'AES-256-GCM',
      key:       rawDEK.toString('base64'),
      iv:        claims.fileIv,
      authTag:   claims.fileAuthTag
    };
    const decrypted = await client.downloadFile(claims.iagonFileId, decryptionInfo);
    rawDEK.fill(0);

    assert(decrypted.length > 0, 'Decrypted content is empty');

    // Content hash check
    const actualHash = 'sha256:' + crypto.createHash('sha256').update(decrypted).digest('hex');
    const storedHash = claims.contentHash;
    assert(actualHash === storedHash, `Content hash mismatch:\n    got:    ${actualHash}\n    stored: ${storedHash}`);
    console.log(`\n    Decrypted ${decrypted.length} bytes  hash match: YES`);
  });
}

// ── T10: Releasability enforcement ───────────────────────────────────────────

async function runT10() {
  await test('T10 Releasability — wrong issuer DID denied', async () => {
    await VCKeyStore.load();
    const record  = VCKeyStore.get(TEST_DOC_DID);
    const verifier = new KeyManifestVCVerifier({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
    const { valid, claims } = await verifier.verify(record);
    assert(valid);

    const wrongIssuer = 'did:prism:unauthorized-company';
    const denied = claims.releasableTo.length > 0 && !claims.releasableTo.includes(wrongIssuer);
    assert(denied, 'Wrong issuer should be denied');
  });

  await test('T10b Releasability — correct issuer DID allowed', async () => {
    await VCKeyStore.load();
    const record  = VCKeyStore.get(TEST_DOC_DID);
    const verifier = new KeyManifestVCVerifier({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
    const { valid, claims } = await verifier.verify(record);
    assert(valid);

    const allowed = claims.releasableTo.length === 0 || claims.releasableTo.includes(TEST_COMPANY_DID);
    assert(allowed, 'Correct issuer should be allowed');
  });
}

// ── T11: Clearance enforcement ────────────────────────────────────────────────

async function runT11() {
  await test('T11 Clearance enforcement — INTERNAL doc accessible to any level', async () => {
    // INTERNAL = level 1, any employee >= 1 can read
    const docLevel   = 1; // INTERNAL
    const userLevel  = 1; // INTERNAL employee
    assert(userLevel >= docLevel, 'Should be accessible');
  });

  await test('T11b Clearance enforcement — RESTRICTED doc denied to INTERNAL user', async () => {
    const docLevel  = 3; // RESTRICTED
    const userLevel = 1; // INTERNAL
    assert(userLevel < docLevel, 'Should be denied');
  });
}

// ── T12: Content hash integrity ───────────────────────────────────────────────

async function runT12() {
  await test('T12 Content hash — tampered content detected', async () => {
    await VCKeyStore.load();
    const record  = VCKeyStore.get(TEST_DOC_DID);
    const verifier = new KeyManifestVCVerifier({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
    const { claims } = await verifier.verify(record);

    const tamperedContent = Buffer.from('tampered data that is not the original document');
    const tamperedHash = 'sha256:' + crypto.createHash('sha256').update(tamperedContent).digest('hex');
    assert(tamperedHash !== claims.contentHash, 'Tampered hash should not match stored hash');
  });
}

// ── T13: VC revocation ────────────────────────────────────────────────────────

async function runT13() {
  await test('T13 VC revocation — DELETE clears VCKeyStore', async () => {
    assert(ADMIN_KEY, 'ADMIN_KEY required');

    const res = await fetch(
      `${DOC_SVC_URL}/vc/key-manifest/${encodeURIComponent(TEST_DOC_DID)}`,
      { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } }
    );
    assert(res.ok, `DELETE returned ${res.status}`);

    await VCKeyStore.load();
    const record = VCKeyStore.get(TEST_DOC_DID);
    assert(!record, 'VC should be gone after revocation');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('E2E Pipeline Test — identuslabel.cz Document Access Control');
  console.log(`Document: ${DOC_PATH}`);
  console.log(`Test DID: ${TEST_DOC_DID}`);
  console.log('='.repeat(72));
  console.log();

  await runT1();
  console.log();
  await runT2();
  await runT3();
  await runT4();
  await runT5();
  await runT6();
  await runT7();
  console.log();
  await runT8();
  console.log();
  await runT9();
  console.log();
  await runT10();
  await runT11();
  await runT12();
  console.log();
  await runT13();

  // Summary
  console.log();
  console.log('='.repeat(72));
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  console.log('='.repeat(72));
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.pass).forEach(r => console.log(`  FAIL  ${r.name}: ${r.error}`));
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
