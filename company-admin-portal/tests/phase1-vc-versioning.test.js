#!/usr/bin/env node
'use strict';

/**
 * phase1-vc-versioning.test.js
 *
 * Phase 1 gate: verify KeyManifestVCIssuer versioning fields work correctly.
 *
 * Checks:
 *   1. issue() with versionNumber/updatedBy/predecessorHash embeds those in credentialSubject
 *   2. computePredecessorHash(vcJwt) returns 'sha256:<hex>'
 *   3. A second VC with predecessorHash = computePredecessorHash(firstVcJwt) passes verification
 *   4. Backward compat: VCs without versioning fields still pass verification
 *   5. computePredecessorHash produces a deterministic, stable hash
 *
 * All tests are local (no live service calls) — uses real Ed25519 key from env.
 */

const assert = require('assert');
const path   = require('path');
const crypto = require('crypto');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});

const KeyManifestVCIssuer   = require('../lib/KeyManifestVCIssuer');
const KeyManifestVCVerifier = require(path.join(__dirname, '..', '..', 'identus-document-service', 'lib', 'KeyManifestVCVerifier'));

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeIssuer() {
  const issuer = new KeyManifestVCIssuer(null, 'test-key');
  issuer._push = async () => {}; // suppress HTTP push
  return issuer;
}

function makeVerifier() {
  return new KeyManifestVCVerifier({
    inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
  });
}

function makeBaseParams(overrides = {}) {
  return {
    issuerDID:           'did:prism:issuer',
    documentDID:         'did:prism:doc' + crypto.randomBytes(6).toString('hex'),
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

// ── Test 1: versioning fields appear in credentialSubject ─────────────────────

test('issue() embeds versionNumber, updatedBy, predecessorHash in credentialSubject', async () => {
  const issuer   = makeIssuer();
  const verifier = makeVerifier();

  const { vcJwt } = await issuer.issue(makeBaseParams({
    versionNumber:   1,
    updatedBy:       'did:prism:editor-abc',
    predecessorHash: null
  }));

  const result = await verifier.verify({ vcJwt });
  assert.strictEqual(result.valid, true, `Verification failed: ${result.reason}`);
  assert.strictEqual(result.claims.versionNumber, 1, 'versionNumber must be 1');
  assert.strictEqual(result.claims.updatedBy, 'did:prism:editor-abc', 'updatedBy must be preserved');
  assert.strictEqual(result.claims.predecessorHash, undefined, 'null predecessorHash must not appear in claims');
});

// ── Test 2: computePredecessorHash returns 'sha256:<hex>' ────────────────────

test('computePredecessorHash returns sha256:<hex> string', async () => {
  const issuer = makeIssuer();
  const { vcJwt } = await issuer.issue(makeBaseParams());

  const hash = KeyManifestVCIssuer.computePredecessorHash(vcJwt);
  assert.ok(typeof hash === 'string', 'hash must be a string');
  assert.ok(hash.startsWith('sha256:'), `hash must start with 'sha256:' — got: ${hash.substring(0, 20)}`);
  const hex = hash.slice('sha256:'.length);
  assert.strictEqual(hex.length, 64, `hex part must be 64 chars — got ${hex.length}`);
  assert.ok(/^[0-9a-f]+$/.test(hex), 'hex part must be lowercase hex');
});

// ── Test 3: v2 VC with predecessorHash passes verification ───────────────────

test('v2 VC with predecessorHash = computePredecessorHash(v1) passes verification', async () => {
  const issuer   = makeIssuer();
  const verifier = makeVerifier();
  const docDID   = 'did:prism:chaintest' + crypto.randomBytes(6).toString('hex');

  // Issue v1
  const v1 = await issuer.issue(makeBaseParams({
    documentDID:    docDID,
    versionNumber:  1,
    updatedBy:      'did:prism:alice',
    predecessorHash: null
  }));

  // Issue v2 referencing v1
  const v2Params = makeBaseParams({
    documentDID:     docDID,
    versionNumber:   2,
    updatedBy:       'did:prism:bob',
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  });
  const v2 = await issuer.issue(v2Params);

  const result = await verifier.verify({ vcJwt: v2.vcJwt });
  assert.strictEqual(result.valid, true, `v2 verification failed: ${result.reason}`);
  assert.strictEqual(result.claims.versionNumber, 2);
  assert.strictEqual(result.claims.updatedBy, 'did:prism:bob');

  // predecessorHash must match
  const expectedHash = KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt);
  assert.strictEqual(result.claims.predecessorHash, expectedHash,
    'predecessorHash in v2 claims must equal sha256 of v1 vcJwt');
});

// ── Test 4: backward compat — VC without versioning fields still verifies ─────

test('VC without versioning fields still passes verification (backward compat)', async () => {
  const issuer   = makeIssuer();
  const verifier = makeVerifier();

  // issue() without any versioning params
  const { vcJwt } = await issuer.issue(makeBaseParams());

  const result = await verifier.verify({ vcJwt });
  assert.strictEqual(result.valid, true, `Non-versioned VC failed: ${result.reason}`);
  assert.strictEqual(result.claims.versionNumber, undefined, 'versionNumber must be absent');
  assert.strictEqual(result.claims.updatedBy, undefined, 'updatedBy must be absent');
  assert.strictEqual(result.claims.predecessorHash, undefined, 'predecessorHash must be absent');
});

// ── Test 5: computePredecessorHash is deterministic ───────────────────────────

test('computePredecessorHash produces same hash for same JWT input', async () => {
  const issuer = makeIssuer();
  const { vcJwt } = await issuer.issue(makeBaseParams());

  const h1 = KeyManifestVCIssuer.computePredecessorHash(vcJwt);
  const h2 = KeyManifestVCIssuer.computePredecessorHash(vcJwt);
  assert.strictEqual(h1, h2, 'Same JWT must produce same hash');

  // Different JWT must produce different hash
  const { vcJwt: vcJwt2 } = await issuer.issue(makeBaseParams());
  const h3 = KeyManifestVCIssuer.computePredecessorHash(vcJwt2);
  assert.notStrictEqual(h1, h3, 'Different JWT must produce different hash');
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 1 — VC Versioning Fields');
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
    console.log('\n[Phase 1 GATE FAILED] Fix failures before proceeding to Phase 2.');
    process.exit(1);
  } else {
    console.log('\n[Phase 1 GATE PASSED] Versioning fields work correctly.');
    process.exit(0);
  }
})();
