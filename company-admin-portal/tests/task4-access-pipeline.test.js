'use strict';

/**
 * Task 4 — Update Access Pipeline to Unwrap CMK-Protected Key Manifests
 *
 * Tests:
 * 1. IagonStorageClient.downloadKeyManifest method exists
 * 2. ClassificationKeyManager.unwrapDEK method exists
 * 3. Full round-trip crypto: wrap DEK → encrypt → unwrap DEK → decrypt
 * 4. Legacy path: decryptContent works with direct encryptionInfo.key
 * 5. ReEncryptionService.processAccessRequest function exists
 * 6. server.js contains 'encryptionManifestId' (access pipeline updated)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TASK = 'Task 4: CMK Unwrap in Access Pipeline';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

// ── Load modules ──────────────────────────────────────────────────────────────

const { IagonStorageClient } = require('../lib/IagonStorageClient');
const cmk = require('../lib/ClassificationKeyManager');
const ReEncryptionService = require('../lib/ReEncryptionService');

// Initialise CMK store from env vars (needs CMK_* vars to be set)
try { cmk.load(); } catch (_) {}

// ── Test 1: IagonStorageClient.downloadKeyManifest exists ────────────────────
test('IagonStorageClient.downloadKeyManifest method exists', async () => {
  assert.strictEqual(
    typeof IagonStorageClient.prototype.downloadKeyManifest,
    'function',
    'IagonStorageClient must have a downloadKeyManifest() method'
  );
});

// ── Test 2: ClassificationKeyManager.unwrapDEK exists ────────────────────────
test('ClassificationKeyManager.unwrapDEK method exists', async () => {
  assert.strictEqual(
    typeof cmk.unwrapDEK,
    'function',
    'ClassificationKeyManager singleton must expose unwrapDEK()'
  );
  assert.strictEqual(
    typeof cmk.wrapDEK,
    'function',
    'ClassificationKeyManager singleton must expose wrapDEK()'
  );
});

// ── Test 3: Full round-trip crypto (no network) ───────────────────────────────
test('Full round-trip: wrapDEK → AES-encrypt → unwrapDEK → AES-decrypt', async () => {
  // 3a. Generate a random 32-byte DEK
  const originalDEK = crypto.randomBytes(32);

  // 3b. Encrypt some content with AES-256-GCM using the DEK
  const originalContent = Buffer.from('Top-secret document content — classified CONFIDENTIAL');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', originalDEK, iv);
  const ciphertext = Buffer.concat([cipher.update(originalContent), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // encryptionInfo that would be stored in iagonStorage (no key field — Task 3 removed it)
  const storedEncInfo = {
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };

  // 3c. Wrap DEK with CMK
  const wrappedManifest = cmk.wrapDEK(originalDEK, 'CONFIDENTIAL');
  assert.ok(wrappedManifest.wrappedKey, 'wrapDEK must return wrappedKey');
  assert.ok(wrappedManifest.iv, 'wrapDEK must return iv');
  assert.ok(wrappedManifest.authTag, 'wrapDEK must return authTag');
  assert.strictEqual(wrappedManifest.wrappingAlgorithm, 'AES-256-GCM');
  assert.ok(wrappedManifest.classificationLevel, 'wrapDEK must include classificationLevel');

  // 3d. Zero original DEK (simulate what upload path does)
  originalDEK.fill(0);
  assert.ok(originalDEK.every(b => b === 0), 'originalDEK should be zeroed');

  // 3e. Unwrap with CMK (simulates access pipeline)
  const recoveredDEK = cmk.unwrapDEK(wrappedManifest, 'CONFIDENTIAL');
  assert.ok(Buffer.isBuffer(recoveredDEK), 'unwrapDEK must return a Buffer');
  assert.strictEqual(recoveredDEK.length, 32, 'Recovered DEK must be 32 bytes');

  // 3f. Reconstruct full encryptionInfo (as decryptFromIagon does in server.js)
  const fullEncInfo = { ...storedEncInfo, key: recoveredDEK.toString('base64') };

  // 3g. Decrypt content using recovered DEK
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(fullEncInfo.key, 'base64'),
    Buffer.from(fullEncInfo.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(fullEncInfo.authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // 3h. Verify content matches original
  assert.ok(decrypted.equals(originalContent), 'Decrypted content must match original');

  // 3i. Zero recovered DEK
  recoveredDEK.fill(0);
  assert.ok(recoveredDEK.every(b => b === 0), 'recoveredDEK should be zeroed after use');
});

// ── Test 4: Legacy path — decryptContent with direct encryptionInfo.key ───────
test('Legacy path: decryptContent works with direct encryptionInfo.key', async () => {
  const iagonClient = new IagonStorageClient({
    accessToken: 'dummy',
    nodeId: 'dummy'
  });

  // Encrypt some bytes using Node's crypto directly
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const plaintext = Buffer.from('Legacy document content without CMK wrapping');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Legacy encryptionInfo includes the raw key in base64
  const encryptionInfo = {
    algorithm: 'AES-256-GCM',
    key: dek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };

  // IagonStorageClient.decryptContent should work with this legacy format
  const decrypted = iagonClient.decryptContent(ciphertext, encryptionInfo);
  assert.ok(Buffer.isBuffer(decrypted), 'decryptContent must return a Buffer');
  assert.ok(decrypted.equals(plaintext), 'Legacy decrypt must recover original plaintext');
});

// ── Test 5: ReEncryptionService.processAccessRequest exists ──────────────────
test('ReEncryptionService.processAccessRequest function exists', async () => {
  assert.strictEqual(
    typeof ReEncryptionService.processAccessRequest,
    'function',
    'ReEncryptionService must expose a processAccessRequest static method'
  );
});

// ── Test 6: server.js contains encryptionManifestId in access pipeline ───────
test('server.js /api/access-gate/present contains encryptionManifestId', async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const serverSource = fs.readFileSync(serverPath, 'utf8');

  // Verify the new CMK-unwrap helper is present
  assert.ok(
    serverSource.includes('encryptionManifestId'),
    'server.js must reference encryptionManifestId in the access pipeline'
  );
  assert.ok(
    serverSource.includes('downloadKeyManifest'),
    'server.js must call iagonClient.downloadKeyManifest() in the access pipeline'
  );
  assert.ok(
    serverSource.includes('cmk.unwrapDEK'),
    'server.js must call cmk.unwrapDEK() in the access pipeline'
  );

  // Verify the access-gate/present endpoint specifically contains the new code
  const accessGateIdx = serverSource.indexOf("app.post('/api/access-gate/present'");
  assert.ok(accessGateIdx !== -1, '/api/access-gate/present endpoint must exist');

  // The chars after the endpoint start should contain the new helper (endpoint is ~7000 chars)
  const endpointSection = serverSource.slice(accessGateIdx, accessGateIdx + 8000);
  assert.ok(
    endpointSection.includes('decryptFromIagon'),
    '/api/access-gate/present must define the decryptFromIagon helper (Task 4)'
  );
});

// ── Test 7: ReEncryptionService uses CMK unwrap path ─────────────────────────
test('ReEncryptionService.js source contains CMK-unwrap code', async () => {
  const reSvcPath = path.join(__dirname, '..', 'lib', 'ReEncryptionService.js');
  const source = fs.readFileSync(reSvcPath, 'utf8');

  assert.ok(
    source.includes('encryptionManifestId'),
    'ReEncryptionService.js must check encryptionManifestId in Step 7'
  );
  assert.ok(
    source.includes('downloadKeyManifest'),
    'ReEncryptionService.js must call iagonClient.downloadKeyManifest()'
  );
  assert.ok(
    source.includes('cmk.unwrapDEK'),
    'ReEncryptionService.js must call cmk.unwrapDEK()'
  );
  assert.ok(
    source.includes("require('./ClassificationKeyManager')"),
    'ReEncryptionService.js must require ClassificationKeyManager'
  );
});

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  const results = [];
  for (const t of TESTS) {
    try {
      await t.fn();
      results.push({ task: TASK, name: t.name, pass: true });
    } catch (e) {
      results.push({ task: TASK, name: t.name, pass: false, error: e.message });
    }
  }
  return results;
}

// Allow direct execution
if (require.main === module) {
  (async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(TASK);
    console.log('='.repeat(60));

    const results = await run();
    let passed = 0;
    let failed = 0;

    for (const r of results) {
      if (r.pass) {
        console.log(`  PASS  ${r.name}`);
        passed++;
      } else {
        console.log(`  FAIL  ${r.name}`);
        console.log(`        ${r.error}`);
        failed++;
      }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}

module.exports = { run };
