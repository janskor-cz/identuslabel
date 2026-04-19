#!/usr/bin/env node
/**
 * Task 7 — Harden Signature Verification Fallback
 * Integration tests using the REAL ReEncryptionService module.
 *
 * Tests call verifySignature() directly (no mocks).
 * Tests that exercise the DID-resolution fallback deliberately use a fake DID
 * (did:prism:fakefakefake) which will produce a network/HTTP error — that is
 * the expected trigger for the fallback path.
 *
 * Run:
 *   node tests/task7-signature-fallback.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Set up CMK env vars required by ClassificationKeyManager (loaded transitively)
// ---------------------------------------------------------------------------
const CMK_LEVELS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP_SECRET'];
for (const level of CMK_LEVELS) {
  if (!process.env[`CMK_${level}`]) {
    process.env[`CMK_${level}`] = crypto.randomBytes(32).toString('base64');
  }
}

const ReEncryptionService = require('../lib/ReEncryptionService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid-format 64-byte signature (random bytes, correct length). */
function makeValidFormatSig() {
  return crypto.randomBytes(64).toString('base64');
}

/** ISO-8601 timestamp within the 5-minute window. */
function recentTimestamp() {
  return new Date().toISOString();
}

/** ISO-8601 timestamp 10 minutes in the past (outside the 5-minute window). */
function staleTimestamp() {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
}

/** A nonce that is unlikely to collide with any cached nonce. */
function freshNonce() {
  return crypto.randomUUID();
}

const FAKE_DID     = 'did:prism:fakefakefake000000000000000000000000000000000000000000000000000';
const FAKE_DOC_DID = 'did:prism:fakedocument0000000000000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TESTS = [];

function test(name, fn) {
  TESTS.push({ name, fn });
}

/**
 * Test 1: Valid format + recent timestamp — function can be called with new param.
 * The 64-byte signature passes format checks; DID resolution will fail for a
 * fake DID, but for INTERNAL level the fallback allows access.
 */
test('Test 1: valid-format sig + recent timestamp passes format validation (INTERNAL doc)', async () => {
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   recentTimestamp(),
    nonce:                       freshNonce(),
    signature:                   makeValidFormatSig(),
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'INTERNAL'
  });
  // INTERNAL doc with unresolvable DID — format check passes, fallback returns true
  assert.strictEqual(result, true, 'Expected true: INTERNAL fallback should be allowed');
});

/**
 * Test 2: INTERNAL doc with short signature (< 64 bytes) — format check fails → false.
 */
test('Test 2: INTERNAL doc with short signature returns false (format check)', async () => {
  const shortSig = crypto.randomBytes(32).toString('base64'); // only 32 bytes
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   recentTimestamp(),
    nonce:                       freshNonce(),
    signature:                   shortSig,
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'INTERNAL'
  });
  assert.strictEqual(result, false, 'Expected false: short sig must fail format check');
});

/**
 * Test 3: INTERNAL doc with stale timestamp (> 5 min ago) — timestamp check fails → false.
 */
test('Test 3: INTERNAL doc with outdated timestamp returns false', async () => {
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   staleTimestamp(),
    nonce:                       freshNonce(),
    signature:                   makeValidFormatSig(),
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'INTERNAL'
  });
  assert.strictEqual(result, false, 'Expected false: stale timestamp must be rejected');
});

/**
 * Test 4: INTERNAL level + unresolvable DID → true (fallback allowed).
 * Makes a real HTTP attempt that will fail, triggering the fallback path.
 */
test('Test 4: INTERNAL level + unresolvable DID returns true (fallback allowed)', async () => {
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   recentTimestamp(),
    nonce:                       freshNonce(),
    signature:                   makeValidFormatSig(),
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'INTERNAL'
  });
  assert.strictEqual(result, true, 'Expected true: INTERNAL fallback must be permitted when DID unresolvable');
});

/**
 * Test 5: CONFIDENTIAL level + unresolvable DID → false (fallback denied).
 */
test('Test 5: CONFIDENTIAL level + unresolvable DID returns false (fallback denied)', async () => {
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   recentTimestamp(),
    nonce:                       freshNonce(),
    signature:                   makeValidFormatSig(),
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'CONFIDENTIAL'
  });
  assert.strictEqual(result, false, 'Expected false: CONFIDENTIAL fallback must be denied when DID unresolvable');
});

/**
 * Test 6: SECRET level + unresolvable DID → false (fallback denied).
 */
test('Test 6: SECRET level + unresolvable DID returns false (fallback denied)', async () => {
  const result = await ReEncryptionService.verifySignature({
    documentDID:                 FAKE_DOC_DID,
    ephemeralDID:                FAKE_DID,
    timestamp:                   recentTimestamp(),
    nonce:                       freshNonce(),
    signature:                   makeValidFormatSig(),
    requestorDID:                FAKE_DID,
    documentClassificationLevel: 'SECRET'
  });
  assert.strictEqual(result, false, 'Expected false: SECRET fallback must be denied when DID unresolvable');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let passed = 0;
  let failed = 0;

  console.log('\n=== Task 7 — Signature Verification Fallback (Integration) ===\n');

  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  PASS: ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL: ${t.name}`);
      console.log(`        ${e.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

// Support both: direct run and require + run()
if (require.main === module) {
  run().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
