#!/usr/bin/env node
'use strict';

/**
 * phase4-history.test.js
 *
 * Phase 4 gate: verify VCKeyStore history schema and history endpoint.
 *
 * Checks (live document-service + local module tests):
 *   1. VCKeyStore.put() pushes previous current to history
 *   2. VCKeyStore.get() always returns the latest current
 *   3. VCKeyStore.getHistory() returns { current, history }
 *   4. GET /vc/key-manifest/:did/history returns correct structure
 *   5. After 3 pushes: history has 2 entries, newest-first ordering
 *   6. VCKeyStore.list() returns only current records (backward compat)
 *
 * Run: node identus-document-service/tests/phase4-history.test.js
 */

const assert  = require('assert');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

require('dotenv').config({
  path: path.join(__dirname, '..', '..', 'company-admin-portal', '.env')
});

const DOCUMENT_SERVICE_URL = 'http://localhost:3020';
const ADMIN_KEY = process.env.DOCUMENT_SERVICE_ADMIN_KEY;

const KeyManifestVCIssuer = require(path.join(__dirname, '..', '..', 'company-admin-portal', 'lib', 'KeyManifestVCIssuer'));

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssuer() {
  // Push directly to live document-service
  return new KeyManifestVCIssuer(DOCUMENT_SERVICE_URL, ADMIN_KEY);
}

function uniqueDID() {
  return 'did:prism:phase4test' + crypto.randomBytes(8).toString('hex');
}

function makeParams(docDID, overrides = {}) {
  return {
    issuerDID:           'did:prism:issuer',
    documentDID:         docDID,
    iagonFileId:         'file-' + crypto.randomBytes(4).toString('hex'),
    wrappedKey:          crypto.randomBytes(32).toString('base64'),
    iv:                  crypto.randomBytes(12).toString('base64'),
    authTag:             crypto.randomBytes(16).toString('base64'),
    wrappingAlgorithm:   'AES-256-GCM',
    classificationLevel: 'INTERNAL',
    fileIv:              crypto.randomBytes(12).toString('base64'),
    fileAuthTag:         crypto.randomBytes(16).toString('base64'),
    fileAlgorithm:       'AES-256-GCM',
    releasableTo:        [],
    contentHash:         'sha256:' + crypto.randomBytes(32).toString('hex'),
    ...overrides
  };
}

async function getVC(documentDID) {
  const res = await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}`,
    { headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function getHistory(documentDID) {
  const res = await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}/history`,
    { headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function deleteVC(documentDID) {
  await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}`,
    { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
}

// ── Test 1: VCKeyStore module put/get/getHistory (local) ─────────────────────

test('VCKeyStore: put() moves previous current to history', async () => {
  // Test VCKeyStore module directly by pushing 2 VCs via live endpoint and
  // then checking history endpoint.
  const docDID  = uniqueDID();
  const issuer  = makeIssuer();

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  const v2 = await issuer.issue(makeParams(docDID, {
    versionNumber: 2,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  }));

  const { status, body } = await getHistory(docDID);
  assert.strictEqual(status, 200, `Expected 200, got ${status}`);
  assert.ok(body.current, 'Must have current');
  assert.strictEqual(body.current.vcId, v2.vcId, 'current must be v2');
  assert.ok(Array.isArray(body.history), 'history must be an array');
  assert.strictEqual(body.history.length, 1, 'history must have 1 entry (v1)');
  assert.strictEqual(body.history[0].vcId, v1.vcId, 'history[0] must be v1');

  await deleteVC(docDID);
});

// ── Test 2: GET always returns latest current ─────────────────────────────────

test('GET /vc/key-manifest/:did returns latest (current) VC after multiple pushes', async () => {
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  const v2 = await issuer.issue(makeParams(docDID, {
    versionNumber: 2,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  }));

  const { status, body } = await getVC(docDID);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.vcId, v2.vcId, 'GET must return v2, not v1');

  await deleteVC(docDID);
});

// ── Test 3: GET /history returns {current, history} structure ─────────────────

test('GET /vc/key-manifest/:did/history returns {documentDID, current, history}', async () => {
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  await issuer.issue(makeParams(docDID, { versionNumber: 1 }));

  const { status, body } = await getHistory(docDID);
  assert.strictEqual(status, 200);
  assert.ok(body.documentDID, 'Must include documentDID');
  assert.ok(body.current, 'Must include current');
  assert.ok(body.current.vcJwt, 'current must have vcJwt');
  assert.ok(Array.isArray(body.history), 'history must be an array');
  assert.strictEqual(body.history.length, 0, 'v1 has no predecessors');

  await deleteVC(docDID);
});

// ── Test 4: 3 pushes → history length = 2, newest-first ──────────────────────

test('3 pushes: history has 2 entries in newest-first order', async () => {
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  const v2 = await issuer.issue(makeParams(docDID, {
    versionNumber:   2,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  }));
  const v3 = await issuer.issue(makeParams(docDID, {
    versionNumber:   3,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v2.vcJwt)
  }));

  const { body } = await getHistory(docDID);
  assert.strictEqual(body.current.vcId, v3.vcId, 'current = v3');
  assert.strictEqual(body.history.length, 2, 'history must have 2 entries');
  assert.strictEqual(body.history[0].vcId, v2.vcId, 'history[0] = v2 (newest-first)');
  assert.strictEqual(body.history[1].vcId, v1.vcId, 'history[1] = v1');

  await deleteVC(docDID);
});

// ── Test 5: predecessor hash chain integrity ──────────────────────────────────

test('predecessorHash of current equals sha256(history[0].vcJwt)', async () => {
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  const v1Stored = (await getVC(docDID)).body;

  const v2Hash = KeyManifestVCIssuer.computePredecessorHash(v1Stored.vcJwt);
  await issuer.issue(makeParams(docDID, {
    versionNumber:   2,
    predecessorHash: v2Hash
  }));

  const { body } = await getHistory(docDID);

  // Decode v2 JWT to read predecessorHash claim
  const payload = JSON.parse(Buffer.from(body.current.vcJwt.split('.')[1], 'base64url').toString());
  const predecessorHashInVC = payload.vc?.credentialSubject?.predecessorHash;

  const expectedHash = KeyManifestVCIssuer.computePredecessorHash(body.history[0].vcJwt);
  assert.strictEqual(predecessorHashInVC, expectedHash,
    'predecessorHash in v2 must equal sha256(v1.vcJwt)');

  await deleteVC(docDID);
});

// ── Test 6: list() backward compat ───────────────────────────────────────────

test('GET /vc/key-manifests list still returns current records only', async () => {
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  const v2 = await issuer.issue(makeParams(docDID, {
    versionNumber: 2,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  }));

  const res = await fetch(`${DOCUMENT_SERVICE_URL}/vc/key-manifests`, {
    headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000
  });
  const list = await res.json();

  // Find our test document in the list
  const entry = list.find(e => e.documentDID === docDID);
  assert.ok(entry, `Test document not found in list`);
  assert.strictEqual(entry.vcId, v2.vcId, 'list() must return v2 vcId (current), not v1');

  await deleteVC(docDID);
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 4 — VCKeyStore History');
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
    console.log('\n[Phase 4 GATE FAILED] Fix failures before proceeding to Phase 5.');
    process.exit(1);
  } else {
    console.log('\n[Phase 4 GATE PASSED] VCKeyStore history working correctly.');
    process.exit(0);
  }
})();
