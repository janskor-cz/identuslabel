/**
 * Task 5 — VC schema: encryptionManifestId in DocumentMetadata VC
 * Tests that DocumentMetadataVC.issueDocumentMetadataVCToEmployee()
 * accepts and forwards encryptionManifestId, and does not include raw key.
 */

const assert = require('assert');
const crypto = require('crypto');

const TASK = 'Task 5: VC Schema — encryptionManifestId';
const TESTS = [];

function test(name, fn) { TESTS.push({ task: TASK, name, fn }); }

// Test the VC builder directly (unit test — no live agent needed)
const DocumentMetadataVC = require('../lib/DocumentMetadataVC');

test('issueDocumentMetadataVCToEmployee accepts encryptionManifestId param', async () => {
  // Create a VC builder with a mock endpoint that never gets called
  const vcBuilder = new DocumentMetadataVC('http://mock-agent', 'mock-key');

  // We test the claim-building logic by overriding the fetch call
  let capturedPayload = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ recordId: 'test-record-id', thid: 'test-thid' })
    };
  };

  try {
    const manifestId = `iagon-manifest-${crypto.randomBytes(8).toString('hex')}`;
    await vcBuilder.issueDocumentMetadataVCToEmployee({
      connectionId: 'test-connection',
      issuerDID: 'did:prism:issuer',
      documentDID: 'did:prism:doc:' + 'a'.repeat(50),
      documentTitle: 'Test Document',
      documentType: 'Report',
      classificationLevel: 'INTERNAL',
      releasableTo: 'did:prism:company1',
      createdBy: 'Test User',
      createdByDID: 'did:prism:user',
      encryptionManifestId: manifestId
    });

    assert.ok(capturedPayload, 'Fetch should have been called');
    assert.ok(capturedPayload.claims, 'Payload should have claims');
    assert.strictEqual(
      capturedPayload.claims.encryptionManifestId,
      manifestId,
      'encryptionManifestId should be in VC claims'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('VC claims do not include raw encryption key', async () => {
  const vcBuilder = new DocumentMetadataVC('http://mock-agent', 'mock-key');
  let capturedClaims = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedClaims = JSON.parse(opts.body).claims;
    return {
      ok: true,
      json: async () => ({ recordId: 'test-record-id', thid: 'test-thid' })
    };
  };

  try {
    await vcBuilder.issueDocumentMetadataVCToEmployee({
      connectionId: 'test-connection',
      issuerDID: 'did:prism:issuer',
      documentDID: 'did:prism:doc:' + 'b'.repeat(50),
      documentTitle: 'Secret Doc',
      documentType: 'Policy',
      classificationLevel: 'CONFIDENTIAL',
      encryptionManifestId: 'iagon-manifest-abc123'
    });

    assert.ok(!capturedClaims.key, 'VC claims must not contain a raw "key" field');
    assert.ok(!capturedClaims.contentEncryptionKey, 'VC claims must not contain contentEncryptionKey');
  } finally {
    global.fetch = originalFetch;
  }
});

test('VC claims include encryptionManifestId when provided', async () => {
  const vcBuilder = new DocumentMetadataVC('http://mock-agent', 'mock-key');
  let capturedClaims = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedClaims = JSON.parse(opts.body).claims;
    return { ok: true, json: async () => ({ recordId: 'r1', thid: 't1' }) };
  };

  const manifestId = 'iagon-manifest-xyz999';
  try {
    await vcBuilder.issueDocumentMetadataVCToEmployee({
      connectionId: 'conn1',
      issuerDID: 'did:prism:issuer',
      documentDID: 'did:prism:doc:' + 'c'.repeat(50),
      documentTitle: 'Doc',
      documentType: 'Report',
      classificationLevel: 'INTERNAL',
      encryptionManifestId: manifestId
    });

    assert.strictEqual(capturedClaims.encryptionManifestId, manifestId);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VC claims omit encryptionManifestId when not provided', async () => {
  const vcBuilder = new DocumentMetadataVC('http://mock-agent', 'mock-key');
  let capturedClaims = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedClaims = JSON.parse(opts.body).claims;
    return { ok: true, json: async () => ({ recordId: 'r2', thid: 't2' }) };
  };

  try {
    await vcBuilder.issueDocumentMetadataVCToEmployee({
      connectionId: 'conn2',
      issuerDID: 'did:prism:issuer',
      documentDID: 'did:prism:doc:' + 'd'.repeat(50),
      documentTitle: 'Doc 2',
      documentType: 'Contract',
      classificationLevel: 'INTERNAL'
      // no encryptionManifestId
    });

    assert.ok(
      !capturedClaims.encryptionManifestId,
      'encryptionManifestId should be absent when not provided'
    );
  } finally {
    global.fetch = originalFetch;
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
