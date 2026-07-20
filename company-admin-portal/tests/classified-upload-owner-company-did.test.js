'use strict';

/**
 * classified-upload ownerCompanyDID — regression test for the "Access Logs dashboard is
 * permanently empty for every admin" bug.
 *
 * Background: GET /api/admin/access-logs filters the access-gate audit log by
 * `e.companyDID === req.company.did` (server-side, session-derived — correct, untouched).
 * Every log-writing call site in the /api/access-gate/challenge -> /api/access-gate/present
 * flow writes `companyDID: document.ownerCompanyDID || null`. The live registry showed
 * `document.ownerCompanyDID` was always null because the ONLY live upload route,
 * POST /api/classified-documents/upload, never set `ownerCompanyDID` when calling
 * DocumentRegistry.registerDocument(...) — in EITHER of its two branches (preEncrypted
 * and legacy/non-preEncrypted). This made the log invisible to every admin regardless
 * of real activity.
 *
 * Fix: both branches now pass `ownerCompanyDID: session.issuerDID || null` into the
 * registration call/object, matching the convention already used correctly at the two
 * other (dead/less-used) document routes in this file (server.js:5106, 5512).
 *
 * server.js is deeply embedded in Express and not easily unit-testable in isolation, so
 * this is a source-level regression test: it locates each registration call site by
 * anchoring on nearby unique surrounding text, and asserts `ownerCompanyDID` appears
 * within that call's/object's source text before its closing bracket. This catches the
 * exact "field silently missing" bug class if it recurs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TASK = 'classified-upload-ownerCompanyDID';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

const SERVER_JS_PATH = path.join(__dirname, '..', 'server.js');
const SOURCE = fs.readFileSync(SERVER_JS_PATH, 'utf8');

// Extracts the source text of a balanced-brace block starting at `openBraceIndex`
// (which must point at a '{' or '(' character), returning the substring up to and
// including its matching closing bracket.
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

// ── Branch 1: preEncrypted (server.js ~9697) ────────────────────────────────────────────────

test('preEncrypted branch: DocumentRegistry.registerDocument({...}) call includes ownerCompanyDID: session.issuerDID', () => {
  // Anchor on text unique to this specific call site (the iagonStorage line with fileAlgorithm
  // fallback and inline encryptionInfo object — appears exactly once in the file).
  const anchor = "iagonStorage: { fileId: iagonResult.fileId, nodeId: iagonResult.nodeId, filename: file.originalname, encryptionInfo: { algorithm: fileAlgorithm || 'AES-256-GCM', iv: fileIv, authTag: fileAuthTag } }";
  const anchorIndex = SOURCE.indexOf(anchor);
  assert.notStrictEqual(anchorIndex, -1, 'expected preEncrypted-branch iagonStorage anchor text not found in server.js — has the call site moved/changed?');
  assert.strictEqual(SOURCE.indexOf(anchor, anchorIndex + 1), -1, 'anchor text must be unique in server.js');

  // Walk backwards from the anchor to the nearest `DocumentRegistry.registerDocument(` call
  // whose opening paren precedes it, then extract the full call's argument object.
  const callMarker = 'await DocumentRegistry.registerDocument(';
  const callIndex = SOURCE.lastIndexOf(callMarker, anchorIndex);
  assert.notStrictEqual(callIndex, -1, 'could not find preceding DocumentRegistry.registerDocument( call for the preEncrypted branch');

  const openParenIndex = callIndex + callMarker.length - 1;
  const block = extractBalancedBlock(SOURCE, openParenIndex);

  assert.ok(block.includes(anchor), 'sanity check: extracted call block must contain the anchor text');
  assert.ok(
    block.includes('ownerCompanyDID: session.issuerDID || null'),
    'preEncrypted-branch DocumentRegistry.registerDocument(...) call is missing ownerCompanyDID: session.issuerDID || null'
  );
});

// ── Branch 2: legacy/non-preEncrypted (server.js ~9989 registryEntry) ──────────────────────────

test('legacy/non-preEncrypted branch: registryEntry object literal includes ownerCompanyDID: session.issuerDID', () => {
  // Anchor on text unique to this specific object literal (the contentEncryptionKey line with
  // its distinctive comment — appears exactly once in the file).
  const anchor = "contentEncryptionKey: encryptedPackage.keyring?.INTERNAL || 'classified-section-keys', // Required by registry";
  const anchorIndex = SOURCE.indexOf(anchor);
  assert.notStrictEqual(anchorIndex, -1, 'expected registryEntry contentEncryptionKey anchor text not found in server.js — has the call site moved/changed?');
  assert.strictEqual(SOURCE.indexOf(anchor, anchorIndex + 1), -1, 'anchor text must be unique in server.js');

  // Walk backwards from the anchor to the nearest `const registryEntry = {` and extract the
  // full object literal.
  const declMarker = 'const registryEntry = {';
  const declIndex = SOURCE.lastIndexOf(declMarker, anchorIndex);
  assert.notStrictEqual(declIndex, -1, 'could not find preceding "const registryEntry = {" declaration');

  const openBraceIndex = declIndex + declMarker.length - 1;
  const block = extractBalancedBlock(SOURCE, openBraceIndex);

  assert.ok(block.includes(anchor), 'sanity check: extracted registryEntry block must contain the anchor text');
  assert.ok(
    block.includes('ownerCompanyDID: session.issuerDID || null'),
    'registryEntry object literal is missing ownerCompanyDID: session.issuerDID || null'
  );

  // Also confirm this registryEntry is actually the object later passed to
  // DocumentRegistry.registerDocument(registryEntry) — i.e. we anchored on the right object.
  const afterBlockEnd = openBraceIndex + block.length;
  const tail = SOURCE.slice(afterBlockEnd, afterBlockEnd + 1000);
  assert.ok(
    tail.includes('DocumentRegistry.registerDocument(registryEntry)'),
    'expected DocumentRegistry.registerDocument(registryEntry) call shortly after the registryEntry object literal'
  );
});

// ── Guard: don't accidentally touch the two already-correct call sites ────────────────────────

test('sanity: exactly four ownerCompanyDID: session.issuerDID || null occurrences exist (2 pre-existing + 2 new)', () => {
  const matches = SOURCE.match(/ownerCompanyDID: session\.issuerDID \|\| null/g) || [];
  assert.strictEqual(matches.length, 4, `expected 4 occurrences of "ownerCompanyDID: session.issuerDID || null", found ${matches.length}`);
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
