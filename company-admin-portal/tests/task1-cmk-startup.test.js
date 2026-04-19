/**
 * task1-cmk-startup.test.js
 *
 * Unit tests for Task 1: CMK Store Initialization
 * Tests the real ClassificationKeyManager singleton — no mocks.
 *
 * Run: node tests/task1-cmk-startup.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// Set CMK env vars before loading the singleton so load() succeeds.
// In production these come from the .env file loaded by server.js.
const CMK_LEVELS = ['CMK_INTERNAL', 'CMK_CONFIDENTIAL', 'CMK_RESTRICTED', 'CMK_TOP_SECRET'];
for (const envVar of CMK_LEVELS) {
  if (!process.env[envVar]) {
    process.env[envVar] = crypto.randomBytes(32).toString('base64');
  }
}

const cmk = require('../lib/ClassificationKeyManager');

// Ensure loaded (idempotent if already loaded)
try { cmk.load(); } catch (_) {}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\nTask 1 — CMK Store Initialization\n');

// Test 1: isLoaded is true after load()
test('cmk.isLoaded is true after load()', () => {
  assert.strictEqual(cmk.isLoaded, true, 'Expected cmk.isLoaded to be true after load()');
});

// Test 2: wrapDEK returns correct shape with no raw key field
test('wrapDEK returns { wrappedKey, iv, authTag, wrappingAlgorithm, classificationLevel } — no key field', () => {
  const rawDEK = Buffer.alloc(32);
  const wrapped = cmk.wrapDEK(rawDEK, 'INTERNAL');

  assert.ok(wrapped.wrappedKey,         'Missing wrappedKey');
  assert.ok(wrapped.iv,                 'Missing iv');
  assert.ok(wrapped.authTag,            'Missing authTag');
  assert.strictEqual(wrapped.wrappingAlgorithm,   'AES-256-GCM', 'Wrong wrappingAlgorithm');
  assert.strictEqual(wrapped.classificationLevel, 'INTERNAL',    'Wrong classificationLevel');
  assert.strictEqual(wrapped.key, undefined, 'Raw key must NOT be present in wrapped manifest');
});

// Test 3: wrapDEK → unwrapDEK round-trip returns original DEK
test('wrapDEK / unwrapDEK round-trip returns original DEK (real AES-256-GCM crypto)', () => {
  const rawDEK = crypto.randomBytes(32);
  const wrapped = cmk.wrapDEK(rawDEK, 'CONFIDENTIAL');
  const unwrapped = cmk.unwrapDEK(wrapped, 'CONFIDENTIAL');
  assert.ok(rawDEK.equals(unwrapped), 'Unwrapped DEK does not match original');
});

// Test 4: unwrapDEK with wrong classification level throws
test('unwrapDEK with wrong classification level throws (CONFIDENTIAL-wrapped, try INTERNAL)', () => {
  const rawDEK = crypto.randomBytes(32);
  const wrapped = cmk.wrapDEK(rawDEK, 'CONFIDENTIAL');

  let threw = false;
  try {
    // manifest.classificationLevel === 'CONFIDENTIAL', but we pass 'INTERNAL'
    // → ClassificationKeyManager._normalise check triggers mismatch error
    cmk.unwrapDEK(wrapped, 'INTERNAL');
  } catch (err) {
    threw = true;
  }
  assert.ok(threw, 'Expected unwrapDEK to throw when classificationLevel mismatches');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests total: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
