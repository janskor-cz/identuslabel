'use strict';

/**
 * access-gate-log-dedup-and-update-event.test.js
 *
 * Covers two independent access-gate-log.jsonl audit-trail fixes:
 *
 * 1. POST /api/access-gate/notify dedup — the wallet calls /notify every time it decrypts a
 *    document via a cached ephemeral key, including the very first view immediately after a
 *    fresh grant (the grant flow — /api/access-gate/present, which /api/document-access/complete
 *    also delegates to via loopback — already writes a "Granted" row). That made every real
 *    access produce two rows: one useful, one viewerName:null noise duplicate. Fixed with an
 *    in-memory documentDID -> lastLoggedAt Map (`recentDocumentLogTimestamps` in server.js),
 *    checked/updated by both the grant write and /notify itself, and a pure decision function
 *    lib/AccessGateLogDedup.js#shouldSkipDuplicateLog — real unit tests here.
 *
 * 2. POST /api/document-update/submit's success path (after DocumentRegistry.addDocumentVersion)
 *    previously wrote an ad-hoc log entry with no `eventType` field (so the admin dashboard's
 *    eventType switch in public/app.js fell through to "✅ Granted" instead of "✏️ Updated"),
 *    and mixed companyDID precedence (`document.ownerCompanyDID || companyDID`) where companyDID
 *    was the *editor's* token claim. Fixed by replacing it with the shared buildLogEntry helper,
 *    eventType: 'UPDATED', and companyDID sourced strictly from document.ownerCompanyDID (the
 *    document's own owning company — NOT decoded.companyDID / the destructured token field,
 *    which reflects the presenting editor's employer and can legitimately differ under the
 *    Releasable-To-Partners cross-company edit feature) — source-level regression test here,
 *    following the same technique as tests/classified-upload-owner-company-did.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK = 'access-gate-log-dedup-and-update-event';
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Part 1: real unit tests for the dedup decision function ────────────────────────────────

const { shouldSkipDuplicateLog, DEDUP_WINDOW_MS } = require('../lib/AccessGateLogDedup');

test('shouldSkipDuplicateLog: returns false when nothing was ever logged for this documentDID', () => {
  assert.strictEqual(shouldSkipDuplicateLog(undefined, Date.now()), false);
  assert.strictEqual(shouldSkipDuplicateLog(null, Date.now()), false);
});

test('shouldSkipDuplicateLog: suppresses a repeat within the dedup window (e.g. 5s after a grant)', () => {
  const grantedAt = 1_000_000;
  const fiveSecondsLater = grantedAt + 5_000;
  assert.strictEqual(shouldSkipDuplicateLog(grantedAt, fiveSecondsLater), true,
    'a /notify call 5s after the grant write must be suppressed as a duplicate');
});

test('shouldSkipDuplicateLog: suppresses right up to (but not including) the window boundary', () => {
  const loggedAt = 1_000_000;
  assert.strictEqual(shouldSkipDuplicateLog(loggedAt, loggedAt + DEDUP_WINDOW_MS - 1), true);
});

test('shouldSkipDuplicateLog: does NOT suppress once the dedup window has elapsed (a genuine later reopen)', () => {
  const loggedAt = 1_000_000;
  assert.strictEqual(shouldSkipDuplicateLog(loggedAt, loggedAt + DEDUP_WINDOW_MS), false,
    'at exactly the window boundary, a reopen must be logged, not suppressed');
  assert.strictEqual(shouldSkipDuplicateLog(loggedAt, loggedAt + DEDUP_WINDOW_MS + 60_000), false,
    'a reopen well outside the window (e.g. +60s past the boundary) must be logged');
});

test('shouldSkipDuplicateLog: a different documentDID is unaffected (caller must key the Map per-document)', () => {
  // This models server.js's usage: recentDocumentLogTimestamps.get(documentDID) looked up per
  // document, so a lookup miss for a different/unseen documentDID always yields "don't skip".
  const mapLikeLookupForUnseenDoc = undefined;
  assert.strictEqual(shouldSkipDuplicateLog(mapLikeLookupForUnseenDoc, Date.now()), false);
});

test('shouldSkipDuplicateLog: default window is 60 seconds', () => {
  assert.strictEqual(DEDUP_WINDOW_MS, 60 * 1000);
});

// ── Part 2: source-level check — server.js wiring for the dedup Map ─────────────────────────

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

test('server.js requires shouldSkipDuplicateLog from lib/AccessGateLogDedup', () => {
  assert.ok(SOURCE.includes("require('./lib/AccessGateLogDedup')"),
    'expected server.js to require lib/AccessGateLogDedup');
});

test('POST /api/access-gate/notify checks shouldSkipDuplicateLog before appending to the log, and returns success without writing when true', () => {
  const routeMarker = "app.post('/api/access-gate/notify', async (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(routeIndex, -1, 'expected POST /api/access-gate/notify route not found — has it moved/been renamed?');

  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  assert.ok(handlerBlock.includes('shouldSkipDuplicateLog('),
    'expected the /notify handler to call shouldSkipDuplicateLog(...)');

  const skipCallIndex = handlerBlock.indexOf('shouldSkipDuplicateLog(');
  const appendCallIndex = handlerBlock.indexOf('fs.appendFile(ACCESS_GATE_LOG_PATH');
  assert.notStrictEqual(appendCallIndex, -1, 'expected an fs.appendFile(ACCESS_GATE_LOG_PATH, ...) write in the /notify handler');
  assert.ok(skipCallIndex < appendCallIndex,
    'expected the shouldSkipDuplicateLog(...) check to run before the fs.appendFile(...) write, so a dup can bail out first');

  // The early-return branch on a true dedup result must not fall through to the append call.
  const skipBranchStart = handlerBlock.indexOf('if (shouldSkipDuplicateLog(');
  assert.notStrictEqual(skipBranchStart, -1);
  const skipBranchBlock = handlerBlock.slice(skipBranchStart, appendCallIndex);
  assert.ok(/return res\.json\(\{\s*success:\s*true\s*\}\);/.test(skipBranchBlock),
    'expected the dedup branch to return res.json({ success: true }) without reaching the append call');
});

test('POST /api/access-gate/notify updates recentDocumentLogTimestamps after a real (non-suppressed) write', () => {
  const routeMarker = "app.post('/api/access-gate/notify', async (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  const appendCallIndex = handlerBlock.indexOf('fs.appendFile(ACCESS_GATE_LOG_PATH');
  const afterAppend = handlerBlock.slice(appendCallIndex, appendCallIndex + 700);
  assert.ok(afterAppend.includes('recentDocumentLogTimestamps.set(documentDID'),
    'expected recentDocumentLogTimestamps to be updated shortly after the real /notify write');
});

test('POST /api/access-gate/present (grant write) updates recentDocumentLogTimestamps so the wallet\'s immediate first /notify call gets deduped', () => {
  const routeMarker = "app.post('/api/access-gate/present', async (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(routeIndex, -1, 'expected POST /api/access-gate/present route not found — has it moved/been renamed?');
  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  // The grant write is the fs.appendFile(...) call with accessGranted: true and a real copyId
  // (as opposed to the releasability/clearance/revocation DENIED writes earlier in the same
  // handler) — anchor on "copyId," (no quotes, the variable) which only appears in the grant write.
  const grantWriteIndex = handlerBlock.indexOf('copyId,\n');
  assert.notStrictEqual(grantWriteIndex, -1, 'expected the grant-write fs.appendFile(...) block (with bare `copyId,`) not found');

  const afterGrantWrite = handlerBlock.slice(grantWriteIndex, grantWriteIndex + 400);
  assert.ok(afterGrantWrite.includes('recentDocumentLogTimestamps.set(documentDID'),
    'expected recentDocumentLogTimestamps to be updated shortly after the access-gate/present grant write');
});

// ── Part 3: source-level check — /api/document-update/submit logs eventType: 'UPDATED' ─────
// with companyDID from document.ownerCompanyDID, NOT decoded.companyDID/companyDID.

test("POST /api/document-update/submit's success path (after addDocumentVersion) logs eventType: 'UPDATED' via buildLogEntry, using document.ownerCompanyDID", () => {
  const routeMarker = "app.post('/api/document-update/submit', uploadDocx.single('file'), async (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(routeIndex, -1, 'expected POST /api/document-update/submit route not found — has it moved/been renamed?');
  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  const addVersionCallIndex = handlerBlock.indexOf('await DocumentRegistry.addDocumentVersion(');
  assert.notStrictEqual(addVersionCallIndex, -1, 'expected a DocumentRegistry.addDocumentVersion(...) call in the submit handler');

  // Look at everything from the addDocumentVersion call to the handler's success res.json(...),
  // i.e. the "succeeded" continuation — this is where the new log write must live.
  const afterAddVersion = handlerBlock.slice(addVersionCallIndex);

  assert.ok(afterAddVersion.includes('fs.appendFile(ACCESS_GATE_LOG_PATH'),
    'expected an fs.appendFile(ACCESS_GATE_LOG_PATH, ...) write after addDocumentVersion(...) succeeds');
  assert.ok(afterAddVersion.includes('buildLogEntry('),
    'expected the new log write to use the shared buildLogEntry(...) helper');
  assert.ok(afterAddVersion.includes("eventType:      'UPDATED'") || afterAddVersion.includes("eventType: 'UPDATED'"),
    "expected eventType: 'UPDATED' in the post-addDocumentVersion log write");

  // The specific, easy-to-get-wrong detail: companyDID must come from document.ownerCompanyDID,
  // not from the editor's own decoded edit-token companyDID (which can differ under
  // Releasable-To-Partners cross-company editing).
  const logWriteStart = afterAddVersion.indexOf('fs.appendFile(ACCESS_GATE_LOG_PATH');
  const logWriteBlock = extractBalancedBlock(afterAddVersion, afterAddVersion.indexOf('(', logWriteStart));
  assert.ok(logWriteBlock.includes('document.ownerCompanyDID'),
    'expected the UPDATED log write to read companyDID from document.ownerCompanyDID');
  assert.ok(!/companyDID:\s*(document\.ownerCompanyDID\s*\|\|\s*)?companyDID(?!\w)/.test(logWriteBlock) ,
    'the UPDATED log write must NOT fall back to the bare `companyDID` (the editor\'s own token claim) — use document.ownerCompanyDID only');
  assert.ok(!logWriteBlock.includes('decoded.companyDID'),
    'the UPDATED log write must NOT use decoded.companyDID');

  // documentTitle must come from document.title (top-level field, confirmed correct elsewhere
  // in this file — e.g. the CREATE-event write uses `title:` as a top-level registerDocument
  // field), not document.metadata.title.
  assert.ok(logWriteBlock.includes('document.title'),
    'expected the UPDATED log write to read documentTitle from document.title (top-level field)');
  assert.ok(!logWriteBlock.includes('document?.metadata?.title') && !logWriteBlock.includes('document.metadata.title') && !logWriteBlock.includes('document.metadata?.title'),
    'the UPDATED log write must NOT read documentTitle from document.metadata.title');

  // clearanceLevel must be the document's own classification, not the editor's clearance claim.
  assert.ok(logWriteBlock.includes('document.classificationLevel'),
    'expected the UPDATED log write to read clearanceLevel from document.classificationLevel (the document\'s own classification)');
});

test("sanity: exactly one eventType: 'UPDATED' log write exists in server.js (no accidental duplicate write)", () => {
  const matches = SOURCE.match(/eventType:\s*'UPDATED'/g) || [];
  assert.strictEqual(matches.length, 1, `expected exactly 1 occurrence of eventType: 'UPDATED', found ${matches.length}`);
});

// ── Runner (matches tests/crud-audit-logging.test.js convention) ───────────────────────────

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
