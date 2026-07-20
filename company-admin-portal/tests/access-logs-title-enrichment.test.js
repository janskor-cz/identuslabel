'use strict';

/**
 * access-logs-title-enrichment.test.js
 *
 * Covers the "Document Access Logs table shows a null/blank title" fix:
 *
 * 1. The 5 original ACCESS_GRANTED/ACCESS_DENIED write sites in POST /api/access-gate/present
 *    and POST /api/access-gate/notify read `document?.metadata?.title` when building their log
 *    entry, but classified documents store their display title as a *top-level* `document.title`
 *    field (see lib/DocumentRegistry.js — `title: title || null, // Plaintext title for
 *    display`), not nested under `metadata`. That left `documentTitle: null` on every one of
 *    those rows. Those write sites now read `document?.title` (matching the CREATE/UPDATED
 *    write sites' existing convention) — source-level regression tests here, same technique as
 *    tests/access-gate-log-dedup-and-update-event.test.js.
 *
 * 2. GET /api/admin/access-logs now enriches each returned row at *read* time via
 *    lib/AccessGateLogEntry.js#enrichLogEntryTitle — backfilling documentTitle from the live
 *    DocumentRegistry when the entry's own documentTitle is falsy. This is what actually fixes
 *    the many already-existing historical rows (written before the write-site fix above), since
 *    a write-site-only fix could never retroactively repair rows already on disk. Real unit
 *    tests for the pure enrichment function here, plus a source-level check that the route
 *    wires it up.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK = 'access-logs-title-enrichment';
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Part 1: real unit tests for the pure enrichment function ───────────────────────────────

const { enrichLogEntryTitle } = require('../lib/AccessGateLogEntry');

test('enrichLogEntryTitle: backfills documentTitle from the registry lookup when the entry has none', () => {
  const registry = new Map([
    ['did:prism:doc123', { title: 'Q3 Financial Report' }]
  ]);
  const entry = {
    timestamp: '2026-07-18T00:00:00.000Z',
    eventType: 'ACCESS_GRANTED',
    documentDID: 'did:prism:doc123',
    documentTitle: null,
    accessGranted: true
  };

  const result = enrichLogEntryTitle(entry, (did) => registry.get(did));
  assert.strictEqual(result.documentTitle, 'Q3 Financial Report',
    'expected documentTitle to be backfilled from the live registry');
  // All other fields must be preserved untouched.
  assert.strictEqual(result.eventType, 'ACCESS_GRANTED');
  assert.strictEqual(result.documentDID, 'did:prism:doc123');
  assert.strictEqual(result.accessGranted, true);
});

test('enrichLogEntryTitle: does NOT overwrite an already-populated documentTitle (e.g. from a CREATED/UPDATED entry)', () => {
  const registry = new Map([
    ['did:prism:doc456', { title: 'Some Other Title From Registry' }]
  ]);
  const entry = {
    eventType: 'CREATED',
    documentDID: 'did:prism:doc456',
    documentTitle: 'Original Onboarding Policy'
  };

  const result = enrichLogEntryTitle(entry, (did) => registry.get(did));
  assert.strictEqual(result.documentTitle, 'Original Onboarding Policy',
    'expected the entry\'s own documentTitle to win over the registry lookup');
});

test('enrichLogEntryTitle: leaves documentTitle null when the document is no longer in the registry (deleted/unknown)', () => {
  const emptyRegistry = new Map();
  const entry = { documentDID: 'did:prism:gone', documentTitle: null };

  const result = enrichLogEntryTitle(entry, (did) => emptyRegistry.get(did));
  assert.strictEqual(result.documentTitle, null);
});

test('enrichLogEntryTitle: leaves documentTitle null when the registry has the document but its title is itself falsy', () => {
  const registry = new Map([['did:prism:notitle', { title: null }]]);
  const entry = { documentDID: 'did:prism:notitle', documentTitle: null };

  const result = enrichLogEntryTitle(entry, (did) => registry.get(did));
  assert.strictEqual(result.documentTitle, null);
});

test('enrichLogEntryTitle: does not call the lookup at all (and returns entry unchanged) when documentTitle is already set', () => {
  let lookupCalled = false;
  const entry = { documentDID: 'did:prism:x', documentTitle: 'Already Set' };

  const result = enrichLogEntryTitle(entry, () => { lookupCalled = true; return { title: 'ignored' }; });
  assert.strictEqual(lookupCalled, false, 'lookup should be skipped entirely when documentTitle is already truthy');
  assert.strictEqual(result.documentTitle, 'Already Set');
});

test('enrichLogEntryTitle: handles a missing/undefined documentDID gracefully (no lookup, no throw)', () => {
  const entry = { documentTitle: null };
  const result = enrichLogEntryTitle(entry, () => { throw new Error('should not be called'); });
  assert.strictEqual(result.documentTitle, null);
});

test('enrichLogEntryTitle: an empty-string documentTitle is treated as falsy and gets backfilled', () => {
  const registry = new Map([['did:prism:empty', { title: 'Backfilled Title' }]]);
  const entry = { documentDID: 'did:prism:empty', documentTitle: '' };
  const result = enrichLogEntryTitle(entry, (did) => registry.get(did));
  assert.strictEqual(result.documentTitle, 'Backfilled Title');
});

// ── Part 2: source-level regression — write sites read document?.title, not document?.metadata?.title ──

const SERVER_JS_PATH = path.join(__dirname, '..', 'server.js');
const SOURCE = fs.readFileSync(SERVER_JS_PATH, 'utf8');

test('server.js has no remaining ACCESS-event write sites reading documentTitle from document?.metadata?.title', () => {
  assert.ok(!SOURCE.includes('documentTitle: document?.metadata?.title'),
    'expected all ACCESS_GRANTED/ACCESS_DENIED write sites to read documentTitle from the top-level document.title field, not document.metadata.title');
});

test('server.js has exactly 5 ACCESS-event write sites reading documentTitle from the corrected document?.title field', () => {
  const matches = SOURCE.match(/documentTitle: document\?\.title \|\| null,/g) || [];
  assert.strictEqual(matches.length, 5,
    `expected exactly 5 occurrences of the corrected "documentTitle: document?.title || null," write, found ${matches.length}`);
});

// ── Part 3: source-level check — GET /api/admin/access-logs wires up read-time enrichment ──

test('server.js requires enrichLogEntryTitle from lib/AccessGateLogEntry', () => {
  assert.ok(SOURCE.includes('enrichLogEntryTitle'),
    'expected server.js to import/use enrichLogEntryTitle from lib/AccessGateLogEntry');
});

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

test("GET /api/admin/access-logs applies enrichLogEntryTitle to the returned page before responding", () => {
  const routeMarker = "app.get('/api/admin/access-logs', requireCompany, async (req, res) => {";
  const routeIndex = SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(routeIndex, -1, 'expected GET /api/admin/access-logs route not found — has it moved/been renamed?');

  const openBraceIndex = routeIndex + routeMarker.length - 1;
  const handlerBlock = extractBalancedBlock(SOURCE, openBraceIndex);

  assert.ok(handlerBlock.includes('enrichLogEntryTitle('),
    'expected the handler to call enrichLogEntryTitle(...)');
  assert.ok(handlerBlock.includes('DocumentRegistry.documents.get'),
    'expected the handler to pass a DocumentRegistry.documents.get(...) lookup into enrichLogEntryTitle');

  const enrichCallIndex = handlerBlock.indexOf('enrichLogEntryTitle(');
  const responseIndex = handlerBlock.indexOf('res.json({ success: true, total:');
  assert.notStrictEqual(responseIndex, -1, 'expected the success res.json(...) response not found');
  assert.ok(enrichCallIndex < responseIndex,
    'expected enrichLogEntryTitle(...) to run before the response is sent');
});

// ── Runner (matches tests/access-gate-log-dedup-and-update-event.test.js convention) ───────

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
