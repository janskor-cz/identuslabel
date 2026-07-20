#!/usr/bin/env node
'use strict';

/**
 * audit-owner-company-did.test.js
 *
 * Unit test — fully offline, no live Iagon/Cloud Agent/network calls — confirming:
 *
 *   1. DocumentService.createDocument() accepts an `ownerCompanyDID` param and persists
 *      it into the Iagon-backed document index entry (the index has no owner-company
 *      concept of its own today — see PROJECT context; this is the fix under test).
 *   2. createDocument() fires a CREATED audit event (via lib/AuditEmitter#fireAudit)
 *      carrying ownerCompanyDID/title/clearanceLevel.
 *   3. updateDocument() reads ownerCompanyDID back from the OLD index entry (not the
 *      DID document, which never carries it), carries it into the new version's index
 *      entry, and fires exactly one UPDATED event — NOT an extra CREATED, even though
 *      updateDocument() creates a new version DID internally via createDocument().
 *   4. deleteDocument() reads ownerCompanyDID/title back from the index entry and fires
 *      exactly one DELETED event.
 *
 * Unlike this repo's other tests/*.test.js (which intentionally hit live services —
 * see phase0-baseline.test.js), this one stubs all I/O because DocumentService's
 * create/update/delete paths reach Iagon and the Cloud Agent — real calls would make
 * this test slow, flaky, and dependent on live infra just to check field plumbing.
 * Stubbing is done two ways:
 *   - lib/AuditEmitter#fireAudit and lib/DIDDocumentResolver#resolveDocumentDID are
 *     swapped BEFORE requiring DocumentService, so the references DocumentService.js
 *     destructures at its own require-time resolve to our stubs (Node module caching:
 *     both requires point at the same cached exports object).
 *   - Iagon calls and Cloud Agent calls (`_agentFetch`) are stubbed per-instance on
 *     `docSvc.iagon.*` / `docSvc._agentFetch`, since those are ordinary instance methods.
 *
 * Run standalone: node identus-document-service/tests/audit-owner-company-did.test.js
 */

const assert = require('assert');
const path = require('path');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Stub lib/AuditEmitter#fireAudit — capture events instead of POSTing/Slack/local-log ──
const AuditEmitterModule = require(path.join(__dirname, '..', 'lib', 'AuditEmitter'));
const firedEvents = [];
AuditEmitterModule.fireAudit = (url, event) => { firedEvents.push({ url, event }); };

// ── Stub lib/DIDDocumentResolver#resolveDocumentDID — used by update/delete to read the
//    OLD DID's DID-document metadata (clearanceLevel/releasableTo defaults). It never
//    carries ownerCompanyDID — that only lives in the Iagon-backed index, which is
//    exactly the gap this fix closes. ──
const DIDResolverModule = require(path.join(__dirname, '..', 'lib', 'DIDDocumentResolver'));
DIDResolverModule.resolveDocumentDID = async () => ({
  iagonFileId: 'fake-iagon-file',
  iagonFilename: 'fake.bin',
  clearanceLevel: 'INTERNAL',
  releasableTo: ['did:prism:someissuer'],
  auditEndpoint: null,
  verificationMethods: []
});

const { DocumentService } = require(path.join(__dirname, '..', 'lib', 'DocumentService'));

let _didCounter = 0;

function makeService() {
  const docSvc = new DocumentService({
    IAGON_ACCESS_TOKEN: 'fake-token',
    IAGON_NODE_ID: 'fake-node',
    IAGON_DOWNLOAD_BASE_URL: 'https://example.invalid',
    ENTERPRISE_CLOUD_AGENT_URL: 'https://example.invalid',
    ENTERPRISE_CLOUD_AGENT_API_KEY: null,
    REQUEST_TIMEOUT_MS: 5000,
    AUDIT_FALLBACK_URL: null,
    DOCUMENT_SERVICE_URL: '',
    COMPANY_ADMIN_PUBLIC_URL: ''
  });

  // In-memory fake Iagon-backed index, scoped to this one docSvc instance.
  let fakeIndexStore = { documents: [] };

  docSvc.iagon.isConfigured = () => true;
  docSvc.iagon.uploadFile = async (buf, filename) => {
    if (filename === 'document-index.json') {
      fakeIndexStore = JSON.parse(buf.toString('utf8'));
      return { fileId: 'fake-index-file', filename, nodeId: 'fake-node', encryptionInfo: { algorithm: 'none' } };
    }
    return { fileId: `fake-file-${++_didCounter}`, filename, nodeId: 'fake-node', encryptionInfo: { algorithm: 'none' } };
  };
  docSvc.iagon.downloadFile = async () => Buffer.from(JSON.stringify(fakeIndexStore), 'utf8');
  docSvc.iagon.deleteFile = async () => {};

  // Stub Cloud Agent calls (DID create/publish/patch) — no real network.
  docSvc._agentFetch = async (p, opts = {}) => {
    if (p === '/did-registrar/dids' && opts.method === 'POST') {
      return { longFormDid: `did:prism:test-doc-${++_didCounter}`, scheduledOperation: { id: `op-${_didCounter}` } };
    }
    if (p.includes('/publications')) {
      return { scheduledOperation: { id: `pub-${_didCounter}` } };
    }
    return {}; // PATCH (tombstone) and anything else
  };

  return docSvc;
}

// ── Test 1: createDocument persists ownerCompanyDID into the index entry ───────────────

test('createDocument() persists ownerCompanyDID into the Iagon-backed index entry', async () => {
  const docSvc = makeService();
  const result = await docSvc.createDocument({
    fileBuffer: Buffer.from('hello'),
    originalFilename: 'a.txt',
    mimeType: 'text/plain',
    title: 'Doc A',
    clearanceLevel: 'INTERNAL',
    releasableTo: ['did:prism:someissuer'],
    ownerCompanyDID: 'did:prism:companyA'
  });

  assert.ok(result.documentDID.startsWith('did:prism:'));
  assert.strictEqual(result.ownerCompanyDID, 'did:prism:companyA');

  const index = await docSvc._loadIndex();
  const entry = index.documents.find(d => d.documentDID === result.documentDID);
  assert.ok(entry, 'expected an index entry for the created document');
  assert.strictEqual(entry.ownerCompanyDID, 'did:prism:companyA');
});

// ── Test 2: createDocument fires a CREATED audit event with the right fields ───────────

test('createDocument() fires a CREATED audit event with ownerCompanyDID/title/clearanceLevel', async () => {
  firedEvents.length = 0;
  const docSvc = makeService();
  const result = await docSvc.createDocument({
    fileBuffer: Buffer.from('hello'),
    originalFilename: 'b.txt',
    mimeType: 'text/plain',
    title: 'Doc B',
    clearanceLevel: 'CONFIDENTIAL',
    releasableTo: ['did:prism:someissuer'],
    ownerCompanyDID: 'did:prism:companyB'
  });

  const created = firedEvents.find(e => e.event.event === 'CREATED' && e.event.documentDID === result.documentDID);
  assert.ok(created, 'expected a CREATED audit event to be fired');
  assert.strictEqual(created.event.ownerCompanyDID, 'did:prism:companyB');
  assert.strictEqual(created.event.title, 'Doc B');
  assert.strictEqual(created.event.clearanceLevel, 'CONFIDENTIAL');
});

// ── Test 3: updateDocument reads ownerCompanyDID back, carries it forward, fires UPDATED

test('updateDocument() reads ownerCompanyDID back from the old index entry and fires UPDATED only (no extra CREATED)', async () => {
  const docSvc = makeService();
  const created = await docSvc.createDocument({
    fileBuffer: Buffer.from('v1'),
    originalFilename: 'c.txt',
    mimeType: 'text/plain',
    title: 'Doc C',
    clearanceLevel: 'INTERNAL',
    releasableTo: ['did:prism:someissuer'],
    ownerCompanyDID: 'did:prism:companyC'
  });

  firedEvents.length = 0;

  const updated = await docSvc.updateDocument(created.documentDID, {
    fileBuffer: Buffer.from('v2'),
    originalFilename: 'c.txt',
    mimeType: 'text/plain',
    title: 'Doc C v2',
    clearanceLevel: 'INTERNAL'
  });

  const index = await docSvc._loadIndex();
  const newEntry = index.documents.find(d => d.documentDID === updated.newDocumentDID);
  assert.ok(newEntry, 'expected a new index entry for the updated version');
  assert.strictEqual(newEntry.ownerCompanyDID, 'did:prism:companyC',
    'ownerCompanyDID should carry forward from the parent version, read back from the index (not the DID document)');

  const createdEvents = firedEvents.filter(e => e.event.event === 'CREATED');
  assert.strictEqual(createdEvents.length, 0,
    'the internal version-bump createDocument() call must NOT also fire a CREATED event for a PUT');

  const updatedEvents = firedEvents.filter(e => e.event.event === 'UPDATED');
  assert.strictEqual(updatedEvents.length, 1, 'expected exactly one UPDATED audit event');
  assert.strictEqual(updatedEvents[0].event.ownerCompanyDID, 'did:prism:companyC');
  assert.strictEqual(updatedEvents[0].event.documentDID, updated.newDocumentDID);
});

// ── Test 4: deleteDocument reads ownerCompanyDID/title back, fires DELETED ─────────────

test('deleteDocument() reads ownerCompanyDID/title back from the index entry and fires DELETED', async () => {
  const docSvc = makeService();
  const created = await docSvc.createDocument({
    fileBuffer: Buffer.from('v1'),
    originalFilename: 'd.txt',
    mimeType: 'text/plain',
    title: 'Doc D',
    clearanceLevel: 'INTERNAL',
    releasableTo: ['did:prism:someissuer'],
    ownerCompanyDID: 'did:prism:companyD'
  });

  firedEvents.length = 0;

  await docSvc.deleteDocument(created.documentDID, { purge: false });

  const deletedEvents = firedEvents.filter(e => e.event.event === 'DELETED');
  assert.strictEqual(deletedEvents.length, 1, 'expected exactly one DELETED audit event');
  assert.strictEqual(deletedEvents[0].event.ownerCompanyDID, 'did:prism:companyD');
  assert.strictEqual(deletedEvents[0].event.documentDID, created.documentDID);
  assert.strictEqual(deletedEvents[0].event.title, 'Doc D');
});

// ── Runner (matches this repo's tests/*.test.js IIFE convention, e.g. phase0-baseline.test.js) ──

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('CRUD Audit Logging — ownerCompanyDID plumbing (offline unit test)');
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
  process.exit(failed > 0 ? 1 : 0);
})();
