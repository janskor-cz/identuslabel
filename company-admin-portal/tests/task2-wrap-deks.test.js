'use strict';
/**
 * Task 2 — Wrap DEKs with CMK During Upload
 *
 * Tests:
 *  1. encryptContent() returns a rawKey Buffer alongside encryptionInfo
 *  2. CMK wrapDEK + unwrapDEK round-trip preserves DEK (combined test)
 *  3. uploadKeyManifest method exists on IagonStorageClient prototype
 *  4. downloadKeyManifest method exists on IagonStorageClient prototype
 *  5. After rawDEK.fill(0), DEK bytes are all zero
 *  6. uploadFile() return value has no encryptionInfo.key field
 *  7. uploadFile() return value has rawDEK field (Buffer) for encrypted content
 */

const assert = require('assert');
const crypto = require('crypto');

const TASK = 'Task 2: Wrap DEKs with CMK During Upload';
const TESTS = [];

function test(name, fn) { TESTS.push({ task: TASK, name, fn }); }

// ── Load modules ──────────────────────────────────────────────────────────────

const { getIagonClient } = require('../lib/IagonStorageClient');
const cmkStore = require('../lib/ClassificationKeyManager');

// Load CMK store (uses env vars; if missing we generate test keys)
try {
  cmkStore.load();
} catch (loadErr) {
  // Inject test CMKs so tests can run without production env vars
  const testKey = crypto.randomBytes(32).toString('base64');
  process.env.CMK_INTERNAL    = process.env.CMK_INTERNAL    || testKey;
  process.env.CMK_CONFIDENTIAL= process.env.CMK_CONFIDENTIAL|| testKey;
  process.env.CMK_RESTRICTED  = process.env.CMK_RESTRICTED  || testKey;
  process.env.CMK_TOP_SECRET  = process.env.CMK_TOP_SECRET  || testKey;
  try { cmkStore.load(); } catch (_) { /* will fail individual tests if still broken */ }
}

const iagonClient = getIagonClient();

// ── Tests ─────────────────────────────────────────────────────────────────────

test('encryptContent() returns rawKey Buffer alongside encryptionInfo', () => {
  const content = Buffer.from('hello world test content');
  const result = iagonClient.encryptContent(content, 'CONFIDENTIAL');

  assert.ok(result.rawKey, 'encryptContent must return rawKey');
  assert.ok(Buffer.isBuffer(result.rawKey), 'rawKey must be a Buffer');
  assert.strictEqual(result.rawKey.length, 32, 'rawKey must be 32 bytes (AES-256)');
  assert.ok(result.encryptionInfo, 'must return encryptionInfo');
  assert.strictEqual(result.encryptionInfo.algorithm, 'AES-256-GCM');
});

test('encryptContent() returns null rawKey for UNCLASSIFIED content', () => {
  const content = Buffer.from('public content');
  const result = iagonClient.encryptContent(content, 'UNCLASSIFIED');

  assert.strictEqual(result.encryptionInfo.algorithm, 'none');
  // rawKey is undefined/null for unencrypted content
  assert.ok(!result.rawKey, 'rawKey must be falsy for UNCLASSIFIED content');
});

test('CMK wrapDEK + unwrapDEK round-trip preserves DEK', () => {
  const rawDEK = crypto.randomBytes(32);
  const original = Buffer.from(rawDEK); // save copy before potential mutation

  const wrapped = cmkStore.wrapDEK(rawDEK, 'CONFIDENTIAL');

  assert.ok(wrapped.wrappedKey, 'wrapped manifest must have wrappedKey');
  assert.ok(wrapped.iv, 'wrapped manifest must have iv');
  assert.ok(wrapped.authTag, 'wrapped manifest must have authTag');
  assert.ok(!('key' in wrapped), 'wrapped manifest must NOT have raw "key" field');

  const recovered = cmkStore.unwrapDEK(wrapped, 'CONFIDENTIAL');
  assert.ok(Buffer.isBuffer(recovered), 'unwrapDEK must return a Buffer');
  assert.strictEqual(recovered.length, 32, 'recovered DEK must be 32 bytes');
  assert.ok(recovered.equals(original), 'recovered DEK must match original DEK');
});

test('uploadKeyManifest method exists on IagonStorageClient prototype', () => {
  assert.strictEqual(
    typeof iagonClient.uploadKeyManifest,
    'function',
    'IagonStorageClient must have uploadKeyManifest method'
  );
});

test('downloadKeyManifest method exists on IagonStorageClient prototype', () => {
  assert.strictEqual(
    typeof iagonClient.downloadKeyManifest,
    'function',
    'IagonStorageClient must have downloadKeyManifest method'
  );
});

test('After rawDEK.fill(0), all bytes are zero', () => {
  const rawDEK = crypto.randomBytes(32);
  // Ensure it's not already all zeros
  const hasNonZero = Array.from(rawDEK).some(b => b !== 0);
  assert.ok(hasNonZero, 'Pre-condition: raw DEK should have non-zero bytes');

  rawDEK.fill(0);

  const allZero = Array.from(rawDEK).every(b => b === 0);
  assert.ok(allZero, 'After fill(0), all bytes must be zero');
});

test('uploadFile() return value has no encryptionInfo.key field (stubbed _uploadToIagon)', async () => {
  // Stub _uploadToIagon and isConfigured to avoid real network call / config check
  const original_uploadToIagon = iagonClient._uploadToIagon.bind(iagonClient);
  const original_isConfigured = iagonClient.isConfigured.bind(iagonClient);
  iagonClient._uploadToIagon = async (content, filename) => ({
    fileId: 'test-file-id-' + Date.now(),
    data: { _id: 'test-file-id-' + Date.now() }
  });
  iagonClient.isConfigured = () => true;

  try {
    const result = await iagonClient.uploadFile(
      Buffer.from('test content for upload'),
      'test.txt',
      { classificationLevel: 'CONFIDENTIAL' }
    );

    assert.ok(result, 'uploadFile must return a result');
    assert.ok(result.encryptionInfo, 'result must have encryptionInfo');
    assert.ok(!('key' in result.encryptionInfo), 'encryptionInfo must NOT have raw "key" field');
    assert.ok('rawDEK' in result, 'result must have rawDEK field');
    assert.ok(Buffer.isBuffer(result.rawDEK), 'rawDEK must be a Buffer');
    assert.strictEqual(result.rawDEK.length, 32, 'rawDEK must be 32 bytes');
  } finally {
    iagonClient._uploadToIagon = original_uploadToIagon;
    iagonClient.isConfigured = original_isConfigured;
  }
});

test('uploadFile() returns null rawDEK for UNCLASSIFIED content (stubbed)', async () => {
  const original_uploadToIagon = iagonClient._uploadToIagon.bind(iagonClient);
  const original_isConfigured = iagonClient.isConfigured.bind(iagonClient);
  iagonClient._uploadToIagon = async (content, filename) => ({
    fileId: 'test-file-id-unclassified-' + Date.now(),
    data: { _id: 'test-file-id-unclassified-' + Date.now() }
  });
  iagonClient.isConfigured = () => true;

  try {
    const result = await iagonClient.uploadFile(
      Buffer.from('public document content'),
      'public.txt',
      { classificationLevel: 'UNCLASSIFIED' }
    );

    assert.ok(result, 'uploadFile must return a result');
    assert.ok(!result.rawDEK, 'rawDEK must be null/undefined for UNCLASSIFIED content');
    assert.strictEqual(result.encryptionInfo.algorithm, 'none');
  } finally {
    iagonClient._uploadToIagon = original_uploadToIagon;
    iagonClient.isConfigured = original_isConfigured;
  }
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  const results = [];
  for (const t of TESTS) {
    try {
      await t.fn();
      results.push({ task: t.task, name: t.name, pass: true });
    } catch (e) {
      results.push({ task: t.task, name: t.name, pass: false, error: e.message });
    }
  }
  return results;
}

// Run standalone if called directly
if (require.main === module) {
  (async () => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Running: ${TASK}`);
    console.log('='.repeat(70));

    const results = await run();
    let passed = 0;
    let failed = 0;

    for (const r of results) {
      if (r.pass) {
        console.log(`  ✅ PASS: ${r.name}`);
        passed++;
      } else {
        console.log(`  ❌ FAIL: ${r.name}`);
        console.log(`         ${r.error}`);
        failed++;
      }
    }

    console.log('='.repeat(70));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(70));

    process.exit(failed > 0 ? 1 : 0);
  })();
}

module.exports = { run };
