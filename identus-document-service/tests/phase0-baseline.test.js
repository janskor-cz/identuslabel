#!/usr/bin/env node
'use strict';

/**
 * phase0-baseline.test.js
 *
 * Phase 0 gate: verify the current state is healthy before any code changes.
 *
 * Checks:
 *   1. company-admin health endpoint responds 200
 *   2. document-service health endpoint responds 200 with iagonConnected: true
 *   3. GET /vc/key-manifests returns stored VCs (live store has at least one)
 *   4. KeyManifestVCIssuer + KeyManifestVCVerifier local round-trip (EdDSA, no live services)
 *   5. An existing VC from the live VCKeyStore passes KeyManifestVCVerifier.verify()
 *
 * All checks hit real services (no mocks).
 * Run from repo root: node identus-document-service/tests/phase0-baseline.test.js
 */

const assert  = require('assert');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

// ── Service URLs ─────────────────────────────────────────────────────────────

const COMPANY_ADMIN_URL   = 'http://localhost:3010';
const DOCUMENT_SERVICE_URL = 'http://localhost:3020';

// Load env from company-admin so we get MANIFEST_SIGNING_KEY etc.
require('dotenv').config({
  path: path.join(__dirname, '..', '..', 'company-admin-portal', '.env')
});

// ── Modules under test ───────────────────────────────────────────────────────

const KeyManifestVCIssuer   = require(path.join(__dirname, '..', '..', 'company-admin-portal', 'lib', 'KeyManifestVCIssuer'));
const KeyManifestVCVerifier = require(path.join(__dirname, '..', 'lib', 'KeyManifestVCVerifier'));

// ── Test harness ─────────────────────────────────────────────────────────────

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Test 1: company-admin health ─────────────────────────────────────────────

test('company-admin /api/health returns 200 with success:true', async () => {
  const res = await fetch(`${COMPANY_ADMIN_URL}/api/health`, { timeout: 5000 });
  assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.success, true, `Expected success:true, got: ${JSON.stringify(body)}`);
});

// ── Test 2: document-service health ─────────────────────────────────────────

test('document-service /health returns 200 with iagonConnected:true', async () => {
  const res = await fetch(`${DOCUMENT_SERVICE_URL}/health`, { timeout: 5000 });
  assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.config?.iagonConnected, true,
    `Expected iagonConnected:true, got: ${JSON.stringify(body.config)}`);
});

// ── Test 3: live VCKeyStore has entries ──────────────────────────────────────

test('GET /vc/key-manifests returns at least one stored VC summary', async () => {
  const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
  assert.ok(adminKey, 'DOCUMENT_SERVICE_ADMIN_KEY must be set in env');

  const res = await fetch(`${DOCUMENT_SERVICE_URL}/vc/key-manifests`, {
    headers: { 'x-admin-key': adminKey },
    timeout: 5000
  });
  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.ok(Array.isArray(body), `Expected array, got ${typeof body}`);
  assert.ok(body.length > 0, `Expected at least one VC in store, got 0`);

  // Summary list has documentDID and vcId (vcJwt is intentionally omitted from list)
  for (const entry of body) {
    assert.ok(entry.documentDID, `Entry missing documentDID: ${JSON.stringify(Object.keys(entry))}`);
    assert.ok(entry.vcId, `Entry missing vcId: ${JSON.stringify(Object.keys(entry))}`);
  }
});

// ── Test 4: KeyManifestVCIssuer + Verifier local round-trip ─────────────────

test('KeyManifestVCIssuer signs VC and KeyManifestVCVerifier verifies it (EdDSA)', async () => {
  // Issuer uses MANIFEST_SIGNING_KEY from env (real key)
  const issuer = new KeyManifestVCIssuer(
    null,  // no push — we test locally
    'local-test'
  );
  // Monkey-patch _push to skip HTTP call
  issuer._push = async () => {};

  const fakeDocumentDID = 'did:prism:phase0test' + crypto.randomBytes(8).toString('hex');

  const { vcJwt } = await issuer.issue({
    issuerDID:           'did:prism:issuer-test',
    documentDID:         fakeDocumentDID,
    iagonFileId:         'test-file-id-' + crypto.randomBytes(4).toString('hex'),
    wrappedKey:          crypto.randomBytes(32).toString('base64'),
    iv:                  crypto.randomBytes(12).toString('base64'),
    authTag:             crypto.randomBytes(16).toString('base64'),
    wrappingAlgorithm:   'AES-256-GCM',
    classificationLevel: 'INTERNAL',
    fileIv:              crypto.randomBytes(12).toString('base64'),
    fileAuthTag:         crypto.randomBytes(16).toString('base64'),
    fileAlgorithm:       'AES-256-GCM',
    releasableTo:        [],
    contentHash:         'sha256:' + crypto.randomBytes(32).toString('hex')
  });

  assert.ok(vcJwt, 'issue() must return vcJwt');
  assert.strictEqual(vcJwt.split('.').length, 3, 'vcJwt must be a 3-part JWT');

  // Verify using inline public key from env (same key pair)
  const verifier = new KeyManifestVCVerifier({
    inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
  });
  const result = await verifier.verify({ vcJwt });
  assert.strictEqual(result.valid, true, `Verification failed: ${result.reason}`);
  assert.strictEqual(result.claims.documentDID, fakeDocumentDID);
  assert.strictEqual(result.claims.classificationLevel, 'INTERNAL');
});

// ── Test 5: an existing live VC passes verification ──────────────────────────

test('An existing VC from live VCKeyStore passes KeyManifestVCVerifier', async () => {
  const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
  assert.ok(adminKey, 'DOCUMENT_SERVICE_ADMIN_KEY must be set in env');

  // Fetch summary list to get a vcId
  const listRes = await fetch(`${DOCUMENT_SERVICE_URL}/vc/key-manifests`, {
    headers: { 'x-admin-key': adminKey },
    timeout: 5000
  });
  const list = await listRes.json();
  assert.ok(list.length > 0, 'Need at least one VC to run this test');

  const firstVcId = list[0].vcId;

  // Fetch the full VC record by vcId (includes vcJwt)
  const detailRes = await fetch(`${DOCUMENT_SERVICE_URL}/vc/key-manifests?vcId=${firstVcId}`, {
    headers: { 'x-admin-key': adminKey },
    timeout: 5000
  });
  assert.strictEqual(detailRes.status, 200, `Failed to fetch VC by vcId: ${detailRes.status}`);
  const vcRecord = await detailRes.json();
  assert.ok(vcRecord.vcJwt, 'Full VC record must include vcJwt');

  // Verify with the known public key
  const verifier = new KeyManifestVCVerifier({
    inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
  });
  const result = await verifier.verify(vcRecord);

  assert.strictEqual(result.valid, true,
    `Live VC failed verification: ${result.reason}\n` +
    `VC header kid: ${JSON.parse(Buffer.from(vcRecord.vcJwt.split('.')[0], 'base64url').toString()).kid}`
  );
  assert.ok(result.claims.documentDID, 'Verified VC must have documentDID claim');
  assert.ok(result.claims.classificationLevel, 'Verified VC must have classificationLevel claim');
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 0 — Baseline Health Check');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n[Phase 0 GATE FAILED] Fix the failing checks before proceeding to Phase 1.');
    process.exit(1);
  } else {
    console.log('\n[Phase 0 GATE PASSED] All baseline checks green. Safe to proceed to Phase 1.');
    process.exit(0);
  }
})();
