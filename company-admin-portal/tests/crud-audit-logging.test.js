'use strict';

/**
 * crud-audit-logging.test.js
 *
 * Covers the "Document Access Logs merge in CREATE/UPDATE/DELETE" feature:
 *   1. lib/AccessGateLogEntry.js — real unit tests (pure functions, fake inputs) for the
 *      payload→log-line mapping used by (a) the two CREATE write sites in
 *      POST /api/classified-documents/upload and (b) the new inbound
 *      POST /api/audit/document-event receiver.
 *   2. A source-level regression test (same technique as
 *      tests/classified-upload-owner-company-did.test.js) confirming both
 *      DocumentRegistry.registerDocument(...) call sites in the classified-upload route
 *      are immediately followed by an fs.appendFile(ACCESS_GATE_LOG_PATH, ...) write
 *      containing eventType: 'CREATED'.
 *   3. A source-level check that POST /api/audit/document-event exists, is unauthenticated
 *      (matches the /api/enterprise-messages-webhook convention — no requireEmployeeSession/
 *      requireCompanyAdmin/etc. guard before it), validates `event`/`documentDID`, and maps
 *      eventType: event / companyDID: ownerCompanyDID via the shared helper.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK = 'crud-audit-logging';
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

const { buildLogEntry, buildLogEntryFromAuditWebhook, VALID_AUDIT_EVENT_TYPES } = require('../lib/AccessGateLogEntry');

// ── Part 1: real unit tests for the pure mapping functions ─────────────────────────────

test('buildLogEntry(): CREATED entry has the exact field shape used by the classified-upload write sites', () => {
  const entry = buildLogEntry({
    eventType: 'CREATED',
    viewerName: 'alice@techcorp.com',
    documentDID: 'did:prism:doc123',
    documentTitle: 'Q3 Report',
    clearanceLevel: 'CONFIDENTIAL',
    companyDID: 'did:prism:techcorp',
    accessGranted: true,
    clientIp: '10.0.0.5'
  });

  assert.strictEqual(entry.eventType, 'CREATED');
  assert.strictEqual(entry.viewerName, 'alice@techcorp.com');
  assert.strictEqual(entry.documentDID, 'did:prism:doc123');
  assert.strictEqual(entry.documentTitle, 'Q3 Report');
  assert.strictEqual(entry.clearanceLevel, 'CONFIDENTIAL');
  assert.strictEqual(entry.companyDID, 'did:prism:techcorp');
  assert.strictEqual(entry.accessGranted, true);
  assert.strictEqual(entry.denialReason, null);
  assert.strictEqual(entry.copyId, null);
  assert.strictEqual(entry.clientIp, '10.0.0.5');
  assert.ok(typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)),
    'expected a valid ISO timestamp');
});

test('buildLogEntry(): defaults viewerName/documentTitle/clearanceLevel/companyDID/denialReason/copyId/clientIp to null when omitted', () => {
  const entry = buildLogEntry({ eventType: 'DELETED', documentDID: 'did:prism:doc456', accessGranted: false });
  assert.strictEqual(entry.viewerName, null);
  assert.strictEqual(entry.documentTitle, null);
  assert.strictEqual(entry.clearanceLevel, null);
  assert.strictEqual(entry.companyDID, null);
  assert.strictEqual(entry.denialReason, null);
  assert.strictEqual(entry.copyId, null);
  assert.strictEqual(entry.clientIp, null);
});

test('buildLogEntryFromAuditWebhook(): maps event->eventType and ownerCompanyDID->companyDID', () => {
  const entry = buildLogEntryFromAuditWebhook({
    event: 'UPDATED',
    documentDID: 'did:prism:doc789',
    ownerCompanyDID: 'did:prism:acme',
    title: 'Policy v2',
    actorEmail: 'bob@acme.com',
    clearanceLevel: 'RESTRICTED',
    clientIp: '203.0.113.9'
  });

  assert.strictEqual(entry.eventType, 'UPDATED');
  assert.strictEqual(entry.companyDID, 'did:prism:acme');
  assert.strictEqual(entry.viewerName, 'bob@acme.com');
  assert.strictEqual(entry.documentTitle, 'Policy v2');
  assert.strictEqual(entry.clearanceLevel, 'RESTRICTED');
  assert.strictEqual(entry.clientIp, '203.0.113.9');
  assert.strictEqual(entry.accessGranted, true, 'UPDATED must map to accessGranted:true');
});

test('buildLogEntryFromAuditWebhook(): accessGranted is false for DELETED and ACCESS_DENIED, true otherwise', () => {
  for (const ev of ['CREATED', 'UPDATED', 'ACCESS_GRANTED']) {
    const entry = buildLogEntryFromAuditWebhook({ event: ev, documentDID: 'did:prism:x' });
    assert.strictEqual(entry.accessGranted, true, `expected accessGranted:true for ${ev}`);
  }
  for (const ev of ['DELETED', 'ACCESS_DENIED']) {
    const entry = buildLogEntryFromAuditWebhook({ event: ev, documentDID: 'did:prism:x' });
    assert.strictEqual(entry.accessGranted, false, `expected accessGranted:false for ${ev}`);
  }
});

test('buildLogEntryFromAuditWebhook(): missing actorEmail/title/clearanceLevel/ownerCompanyDID fall back to null', () => {
  const entry = buildLogEntryFromAuditWebhook({ event: 'CREATED', documentDID: 'did:prism:y' });
  assert.strictEqual(entry.viewerName, null);
  assert.strictEqual(entry.documentTitle, null);
  assert.strictEqual(entry.clearanceLevel, null);
  assert.strictEqual(entry.companyDID, null);
});

test('VALID_AUDIT_EVENT_TYPES contains exactly the five expected event types', () => {
  assert.deepStrictEqual(
    [...VALID_AUDIT_EVENT_TYPES].sort(),
    ['ACCESS_DENIED', 'ACCESS_GRANTED', 'CREATED', 'DELETED', 'UPDATED'].sort()
  );
});

// ── Part 2: source-level regression — both CREATE call sites log eventType: 'CREATED' ──

const SERVER_JS_PATH = path.join(__dirname, '..', 'server.js');
const SOURCE = fs.readFileSync(SERVER_JS_PATH, 'utf8');

function extractBalancedBlock(source, openIndex) {
  const openChar = source[openIndex];
  const closeChar = openChar === '{' ? '}' : ')';
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === openChar) depth++;
    else if (source[i] === closeChar) {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error(`No matching '${closeChar}' found for '${openChar}' at index ${openIndex}`);
}

test('preEncrypted branch: registerDocument(...) call is immediately followed by an eventType: \'CREATED\' log write', () => {
  const anchor = "iagonStorage: { fileId: iagonResult.fileId, nodeId: iagonResult.nodeId, filename: file.originalname, encryptionInfo: { algorithm: fileAlgorithm || 'AES-256-GCM', iv: fileIv, authTag: fileAuthTag } }";
  const anchorIndex = SOURCE.indexOf(anchor);
  assert.notStrictEqual(anchorIndex, -1, 'expected preEncrypted-branch iagonStorage anchor text not found — has the call site moved?');

  // Look at a window of source immediately after the registerDocument(...) call closes.
  const callMarker = 'await DocumentRegistry.registerDocument(';
  const callIndex = SOURCE.lastIndexOf(callMarker, anchorIndex);
  assert.notStrictEqual(callIndex, -1, 'could not find preceding DocumentRegistry.registerDocument( call');
  const openParenIndex = callIndex + callMarker.length - 1;
  const block = extractBalancedBlock(SOURCE, openParenIndex);
  const afterCall = SOURCE.slice(openParenIndex + block.length, openParenIndex + block.length + 600);

  assert.ok(afterCall.includes('fs.appendFile(ACCESS_GATE_LOG_PATH'),
    'expected an fs.appendFile(ACCESS_GATE_LOG_PATH, ...) write shortly after preEncrypted registerDocument(...)');
  assert.ok(afterCall.includes("eventType: 'CREATED'"),
    'expected the log write shortly after preEncrypted registerDocument(...) to have eventType: \'CREATED\'');
});

test('legacy branch: registerDocument(registryEntry) call is immediately followed by an eventType: \'CREATED\' log write', () => {
  const callMarker = 'await DocumentRegistry.registerDocument(registryEntry);';
  const callIndex = SOURCE.indexOf(callMarker);
  assert.notStrictEqual(callIndex, -1, 'expected "await DocumentRegistry.registerDocument(registryEntry);" not found — has the call site moved?');

  const afterCall = SOURCE.slice(callIndex + callMarker.length, callIndex + callMarker.length + 600);

  assert.ok(afterCall.includes('fs.appendFile(ACCESS_GATE_LOG_PATH'),
    'expected an fs.appendFile(ACCESS_GATE_LOG_PATH, ...) write shortly after legacy registerDocument(registryEntry)');
  assert.ok(afterCall.includes("eventType: 'CREATED'"),
    'expected the log write shortly after legacy registerDocument(registryEntry) to have eventType: \'CREATED\'');
});

// ── Part 3: source-level check for the new receiver route ──────────────────────────────

test('POST /api/audit/document-event route exists, is unauthenticated, and maps event->eventType / ownerCompanyDID->companyDID', () => {
  const routeMarker = "app.post('/api/audit/document-event', (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(routeIndex, -1, 'expected POST /api/audit/document-event route not found in server.js');

  // Unauthenticated convention check: no auth-middleware identifier between the app.post(
  // call and its handler function, mirroring /api/enterprise-messages-webhook's signature
  // (route, handler) rather than (route, someAuthMiddleware, handler).
  assert.ok(
    routeMarker.includes("(req, res) => {") ,
    'expected the route to be registered as app.post(path, (req, res) => {...}) with no auth middleware, matching the /api/enterprise-messages-webhook convention'
  );

  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  assert.ok(handlerBlock.includes('VALID_AUDIT_EVENT_TYPES.includes(event)'),
    'expected the handler to validate `event` against VALID_AUDIT_EVENT_TYPES');
  assert.ok(handlerBlock.includes('!documentDID'),
    'expected the handler to require documentDID');
  assert.ok(handlerBlock.includes('res.status(400)'),
    'expected a 400 response for invalid event/documentDID');
  assert.ok(handlerBlock.includes('buildLogEntryFromAuditWebhook('),
    'expected the handler to build its log entry via the shared buildLogEntryFromAuditWebhook() mapping');
  assert.ok(handlerBlock.includes('fs.appendFile(ACCESS_GATE_LOG_PATH'),
    'expected the handler to append to ACCESS_GATE_LOG_PATH');
});

// ── Runner (matches tests/classified-upload-owner-company-did.test.js convention) ──────

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

module.exports = { run, TESTS };

if (require.main === module) {
  (async () => {
    const results = await run();
    let failed = 0;
    for (const r of results) {
      if (r.pass) {
        console.log(`PASS: ${r.name}`);
      } else {
        failed++;
        console.log(`FAIL: ${r.name}`);
        console.log(`      ${r.error}`);
      }
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}
