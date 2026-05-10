#!/usr/bin/env node
'use strict';

/**
 * phase2-vc-upload.test.js
 *
 * Phase 2 gate: verify the VC pipeline wiring is correct.
 *
 * Checks (live services, no mocks):
 *   1. GET /vc/key-manifest/:did returns 404 for unknown DID
 *   2. POST /vc/key-manifest stores a VC; GET /vc/key-manifest/:did returns it
 *   3. GET /vc/key-manifest/:did returns the same VC that was stored
 *   4. Pushing a second VC (v2) with predecessorHash makes GET return the new VC
 *   5. addDocumentVersion() (via DocumentRegistry) stores manifestVcId in version record
 *
 * Tests 1-4 hit the live document-service at localhost:3020.
 * Test 5 exercises DocumentRegistry directly (local module test).
 *
 * Run: node company-admin-portal/tests/phase2-vc-upload.test.js
 */

const assert  = require('assert');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});

const DOCUMENT_SERVICE_URL = 'http://localhost:3020';
const ADMIN_KEY = process.env.DOCUMENT_SERVICE_ADMIN_KEY;

const KeyManifestVCIssuer   = require('../lib/KeyManifestVCIssuer');
const KeyManifestVCVerifier = require(path.join(__dirname, '..', '..', 'identus-document-service', 'lib', 'KeyManifestVCVerifier'));

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssuer() {
  // Use real document-service URL so the VC actually gets pushed
  return new KeyManifestVCIssuer(DOCUMENT_SERVICE_URL, ADMIN_KEY);
}

function makeVerifier() {
  return new KeyManifestVCVerifier({
    inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
  });
}

function uniqueDID() {
  return 'did:prism:phase2test' + crypto.randomBytes(8).toString('hex');
}

function makeIssueParams(docDID, overrides = {}) {
  return {
    issuerDID:           'did:prism:issuer-test',
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

async function deleteVC(documentDID) {
  await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}`,
    { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
}

// ── Test 1: 404 for unknown DID ───────────────────────────────────────────────

test('GET /vc/key-manifest/:did returns 404 for unknown DID', async () => {
  assert.ok(ADMIN_KEY, 'DOCUMENT_SERVICE_ADMIN_KEY must be set');
  const { status } = await getVC('did:prism:definitely-does-not-exist-' + crypto.randomBytes(4).toString('hex'));
  assert.strictEqual(status, 404, `Expected 404, got ${status}`);
});

// ── Test 2: Push v1 VC and retrieve it ───────────────────────────────────────

test('POST /vc/key-manifest stores VC; GET retrieves it with vcJwt', async () => {
  assert.ok(ADMIN_KEY, 'DOCUMENT_SERVICE_ADMIN_KEY must be set');
  const docDID = uniqueDID();
  const issuer = makeIssuer();

  const { vcId, vcJwt } = await issuer.issue(makeIssueParams(docDID, {
    versionNumber: 1,
    updatedBy: 'did:prism:editor1',
    predecessorHash: null
  }));

  assert.ok(vcId, 'issue() must return vcId');
  assert.ok(vcJwt, 'issue() must return vcJwt');

  const { status, body } = await getVC(docDID);
  assert.strictEqual(status, 200, `GET returned ${status}`);
  assert.ok(body.vcJwt, 'GET response must include vcJwt');
  assert.strictEqual(body.vcId, vcId, 'vcId must match');

  // Cleanup
  await deleteVC(docDID);
});

// ── Test 3: Retrieved VC passes verification ──────────────────────────────────

test('VC retrieved from document-service passes KeyManifestVCVerifier', async () => {
  const docDID = uniqueDID();
  const issuer   = makeIssuer();
  const verifier = makeVerifier();

  await issuer.issue(makeIssueParams(docDID, { versionNumber: 1 }));

  const { body } = await getVC(docDID);
  assert.ok(body?.vcJwt, 'GET must return vcJwt');

  const result = await verifier.verify(body);
  assert.strictEqual(result.valid, true, `Verification failed: ${result.reason}`);
  assert.strictEqual(result.claims.classificationLevel, 'INTERNAL');
  assert.strictEqual(result.claims.versionNumber, 1);

  await deleteVC(docDID);
});

// ── Test 4: v2 VC with predecessorHash replaces v1 ───────────────────────────

test('v2 VC with predecessorHash replaces v1 in document-service store', async () => {
  const docDID   = uniqueDID();
  const issuer   = makeIssuer();
  const verifier = makeVerifier();

  // Issue v1
  const v1 = await issuer.issue(makeIssueParams(docDID, {
    versionNumber: 1, updatedBy: 'did:prism:alice'
  }));

  // Fetch v1 from store to compute predecessor hash
  const v1Stored = (await getVC(docDID)).body;
  assert.strictEqual(v1Stored.vcId, v1.vcId, 'Stored v1 must match issued v1');

  // Issue v2 with predecessor hash
  const v2 = await issuer.issue(makeIssueParams(docDID, {
    versionNumber:  2,
    updatedBy:      'did:prism:bob',
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1Stored.vcJwt)
  }));

  // GET should now return v2
  const { body: v2Stored } = await getVC(docDID);
  assert.strictEqual(v2Stored.vcId, v2.vcId, 'Store must hold v2 after push');

  // Verify v2
  const result = await verifier.verify(v2Stored);
  assert.strictEqual(result.valid, true, `v2 verification failed: ${result.reason}`);
  assert.strictEqual(result.claims.versionNumber, 2);
  assert.strictEqual(result.claims.predecessorHash,
    KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt),
    'predecessorHash must equal sha256(v1.vcJwt)');

  await deleteVC(docDID);
});

// ── Test 5: DocumentRegistry.addDocumentVersion stores manifestVcId ───────────

test('DocumentRegistry.addDocumentVersion() stores manifestVcId in version record', async () => {
  // Set up env required by DocumentRegistry (CMK keys + no real Iagon)
  process.env.CMK_INTERNAL     = process.env.CMK_INTERNAL     || crypto.randomBytes(32).toString('base64');
  process.env.CMK_CONFIDENTIAL = process.env.CMK_CONFIDENTIAL || crypto.randomBytes(32).toString('base64');
  process.env.CMK_RESTRICTED   = process.env.CMK_RESTRICTED   || crypto.randomBytes(32).toString('base64');
  process.env.CMK_TOP_SECRET   = process.env.CMK_TOP_SECRET   || crypto.randomBytes(32).toString('base64');

  const DocumentRegistry = require('../lib/DocumentRegistry');
  await DocumentRegistry.initialize();

  // Find any existing document to test version on (or use first available)
  const docs = Array.from(DocumentRegistry.documents.entries());
  if (docs.length === 0) {
    console.log('  (skipping: no documents in registry)');
    return;
  }
  const [docDID, docRecord] = docs[0];

  const fakeVcId = 'test-vc-' + crypto.randomBytes(6).toString('hex');
  const version = await DocumentRegistry.addDocumentVersion(docDID, {
    newDocxFileId:   docRecord.iagonStorage?.fileId || ('file-' + crypto.randomBytes(4).toString('hex')),
    encryptionInfo:  docRecord.iagonStorage?.encryptionInfo || null,
    contentHash:     'sha256:' + crypto.randomBytes(32).toString('hex'),
    editorDID:       'did:prism:test-editor',
    clearanceLevel:  docRecord.classificationLevel || 'INTERNAL',
    manifestVcId:    fakeVcId
  });

  assert.strictEqual(version.manifestVcId, fakeVcId,
    `manifestVcId not stored in version record: ${JSON.stringify(version)}`);

  // Verify it persists in getDocumentVersions
  const versions = DocumentRegistry.getDocumentVersions(docDID);
  const latest = versions[versions.length - 1];
  assert.strictEqual(latest.manifestVcId, fakeVcId, 'manifestVcId must be in persisted version');
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 2 — VC Upload Pipeline');
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
    console.log('\n[Phase 2 GATE FAILED] Fix failures before proceeding to Phase 3.');
    process.exit(1);
  } else {
    console.log('\n[Phase 2 GATE PASSED] VC pipeline wired correctly.');
    process.exit(0);
  }
})();
