/**
 * Task 3 — Registry cleanup: no raw keys in DocumentRegistry or persistence
 */

const assert = require('assert');
const crypto = require('crypto');

const TASK = 'Task 3: Registry Cleanup (no raw keys)';
const TESTS = [];

function test(name, fn) { TESTS.push({ task: TASK, name, fn }); }

const DocumentRegistry = require('../lib/DocumentRegistry');
const persistence = require('../lib/DocumentRegistryPersistence');

test('DocumentRegistry.registerDocument strips raw key from iagonStorage', async () => {
  // Build a minimal fake document record with a raw key
  const testDID = `did:prism:test-task3-${crypto.randomBytes(4).toString('hex')}`;
  const rawKey = crypto.randomBytes(32).toString('base64');

  const iagonStorageWithKey = {
    fileId: 'fake-file-id',
    encryptionInfo: {
      algorithm: 'AES-256-GCM',
      key: rawKey,
      iv: crypto.randomBytes(12).toString('base64'),
      authTag: crypto.randomBytes(16).toString('base64')
    },
    encryptionManifestId: 'fake-manifest-id'
  };

  // Register document (async — must await)
  await DocumentRegistry.registerDocument({
    documentDID: testDID,
    title: 'Task 3 Test Document',
    classificationLevel: 'INTERNAL',
    releasableTo: ['did:prism:company1'],
    iagonStorage: iagonStorageWithKey,
    ownerCompanyDID: 'did:prism:owner',
    ownerDepartment: 'TEST'
  });

  // Retrieve directly from internal Map (avoids auth check in getDocument())
  const stored = DocumentRegistry.documents.get(testDID);
  assert.ok(stored, 'Document should be in registry');
  assert.ok(
    !stored.iagonStorage?.encryptionInfo?.key,
    'Raw encryption key should not be stored in registry'
  );
  assert.ok(
    !stored.contentEncryptionKey,
    'contentEncryptionKey should not be stored in registry'
  );

  // Cleanup
  DocumentRegistry.documents.delete(testDID);
});

test('DocumentRegistry.registerDocument does not require contentEncryptionKey param', async () => {
  const testDID = `did:prism:test-task3-nokey-${crypto.randomBytes(4).toString('hex')}`;

  // Should not throw when called without contentEncryptionKey
  let threw = false;
  try {
    await DocumentRegistry.registerDocument({
      documentDID: testDID,
      title: 'Task 3 Test No Key',
      classificationLevel: 'INTERNAL',
      releasableTo: [],
      iagonStorage: { fileId: 'x', encryptionManifestId: 'y' },
      ownerCompanyDID: 'did:prism:owner',
      ownerDepartment: 'TEST'
    });
  } catch (e) {
    threw = true;
  }
  assert.ok(!threw, 'registerDocument should not throw when contentEncryptionKey is absent');
  DocumentRegistry.documents.delete(testDID);
});

test('Registry persistence migration strips legacy raw keys on load', async () => {
  const exists = await persistence.registryExists();
  if (!exists) {
    // Nothing to migrate, consider it a pass
    return;
  }

  const state = await persistence.loadRegistry();
  if (!state) return;

  // After load, no document should have a raw key
  for (const [did, doc] of state.documents.entries()) {
    const hasRawKey =
      (doc.contentEncryptionKey && doc.contentEncryptionKey !== '[WRAPPED-BY-CMK]') ||
      (doc.iagonStorage?.encryptionInfo?.key && doc.iagonStorage.encryptionInfo.key !== '[WRAPPED-BY-CMK]');

    assert.ok(!hasRawKey, `Document ${did.substring(0, 40)}... still has raw key after migration`);
  }
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
