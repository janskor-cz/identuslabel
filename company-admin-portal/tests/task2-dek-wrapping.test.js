/**
 * Task 2 — DEK wrapping in upload path
 * Tests that after upload, the key manifest stored on Iagon contains
 * wrappingAlgorithm and no raw 'key' field.
 *
 * Strategy: inspects DocumentRegistry in-memory state via the /api/health or
 * internal module import since we can't do a real upload without full auth.
 * Integration test calls the registry persistence file and verifies no raw key.
 */

const assert = require('assert');
const crypto = require('crypto');

const TASK = 'Task 2: DEK Wrapping in Upload Path';
const TESTS = [];

function test(name, fn) { TESTS.push({ task: TASK, name, fn }); }

// Load DocumentRegistryPersistence to inspect persisted state
const persistence = require('../lib/DocumentRegistryPersistence');
const cmkStore = require('../lib/ClassificationKeyManager');

// Ensure CMK is loaded
try { cmkStore.load(); } catch (_) {}

test('wrapDEK output has no raw "key" field', async () => {
  const rawDEK = crypto.randomBytes(32);
  const manifest = cmkStore.wrapDEK(rawDEK, 'INTERNAL');

  assert.ok(!('key' in manifest), 'Wrapped manifest must NOT contain raw "key" field');
  assert.ok(manifest.wrappedKey, 'Must have wrappedKey');
  assert.ok(manifest.wrappingAlgorithm, 'Must have wrappingAlgorithm');
});

test('wrapDEK output has required fields for manifest upload', async () => {
  const rawDEK = crypto.randomBytes(32);
  const manifest = cmkStore.wrapDEK(rawDEK, 'CONFIDENTIAL');

  const required = ['wrappedKey', 'iv', 'authTag', 'wrappingAlgorithm', 'classificationLevel'];
  for (const field of required) {
    assert.ok(field in manifest, `Manifest missing required field: ${field}`);
  }
});

test('persisted registry has no raw contentEncryptionKey', async () => {
  const exists = await persistence.registryExists();
  if (!exists) {
    // No registry yet — pass (no legacy entries to worry about)
    return;
  }

  const state = await persistence.loadRegistry();
  if (!state || !state.documents) return;

  let rawKeyFound = false;
  for (const [did, doc] of state.documents.entries()) {
    if (doc.contentEncryptionKey &&
        doc.contentEncryptionKey !== '[WRAPPED-BY-CMK]' &&
        doc.contentEncryptionKey !== null) {
      rawKeyFound = true;
      break;
    }
  }
  assert.ok(!rawKeyFound, 'Found raw contentEncryptionKey in persisted registry (Task 3 migration should strip it)');
});

test('persisted registry has no raw iagonStorage.encryptionInfo.key', async () => {
  const exists = await persistence.registryExists();
  if (!exists) return;

  const state = await persistence.loadRegistry();
  if (!state || !state.documents) return;

  let rawKeyFound = false;
  for (const [did, doc] of state.documents.entries()) {
    const key = doc.iagonStorage?.encryptionInfo?.key;
    if (key && key !== '[WRAPPED-BY-CMK]') {
      rawKeyFound = true;
      break;
    }
  }
  assert.ok(!rawKeyFound, 'Found raw iagonStorage.encryptionInfo.key in registry — should be stripped by Task 3 migration');
});

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

module.exports = { run };
