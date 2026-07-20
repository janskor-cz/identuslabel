'use strict';

/**
 * resolveEmployerCompany — regression test for the "training/complete 404s for EvilCorp"
 * bug pattern.
 *
 * Background: several server.js route handlers that issue credentials to an already-logged-in
 * employee (CIS Training certificate completion/status, SecurityClearanceGrant issuance) used
 * to unconditionally call `getCompany('techcorp')` and issue against TechCorp's apiKey/DID —
 * regardless of which company the employee actually works for. Since each company has an
 * isolated wallet/apiKey on the multitenancy Cloud Agent, and the employee's DIDComm
 * `connectionId` (stored in their session) lives on their *own* employer's tenant wallet,
 * issuing with TechCorp's apiKey against a non-TechCorp connectionId 404s with
 * `RecordIdNotFound` — this reproduced for EvilCorp and would reproduce identically for ACME.
 *
 * lib/resolveEmployerCompany.js replaces the hardcoded `getCompany('techcorp')` at all 4 call
 * sites in server.js with a lookup keyed on the employee session's `issuerDID` (the employer's
 * PRISM DID, already stored on every session), tolerant of long-form vs short-form PRISM DID
 * differences via the same DID-hash-matching logic as server.js's own `prismDidsMatch`.
 *
 * This test exercises `resolveEmployerCompany` directly, using its injectable `options.companies`
 * to supply fake company lists/DIDs — so it never depends on real lib/companies.js secrets/env
 * or touches the multitenancy Cloud Agent — plus one test against the real lib/companies.js
 * module to prove parity with the actual hardcoded TechCorp DID used elsewhere in server.js.
 */

const assert = require('assert');

const TASK = 'resolveEmployerCompany';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

const { resolveEmployerCompany, prismDidsMatch } = require('../lib/resolveEmployerCompany');

// ── Fake company list, structurally identical to lib/companies.js ──────────────────────────────
const FAKE_COMPANIES = [
  { id: 'techcorp', name: 'TechCorp', apiKey: 'key-techcorp', did: 'did:prism:techcorp-hash-aaa' },
  { id: 'acme', name: 'ACME', apiKey: 'key-acme', did: 'did:prism:acme-hash-bbb' },
  { id: 'evilcorp', name: 'EvilCorp', apiKey: 'key-evilcorp', did: 'did:prism:evilcorp-hash-ccc' },
];

// ── Test 1: exact DID match resolves each of techcorp/acme/evilcorp ────────────────────────────
test('resolves the correct company for an exact issuerDID match (techcorp/acme/evilcorp)', () => {
  const techcorp = resolveEmployerCompany('did:prism:techcorp-hash-aaa', { companies: FAKE_COMPANIES });
  assert.strictEqual(techcorp.id, 'techcorp');

  const acme = resolveEmployerCompany('did:prism:acme-hash-bbb', { companies: FAKE_COMPANIES });
  assert.strictEqual(acme.id, 'acme');

  const evilcorp = resolveEmployerCompany('did:prism:evilcorp-hash-ccc', { companies: FAKE_COMPANIES });
  assert.strictEqual(evilcorp.id, 'evilcorp', 'EvilCorp employees must resolve to evilcorp, not fall back to techcorp');
});

// ── Test 2: long-form vs short-form PRISM DID still matches (prismDidsMatch tolerance) ──────────
test('resolves correctly when issuerDID is long-form but company.did is short-form, and vice versa', () => {
  // Session issuerDID captured as long-form (hash + key material), company.did stored short-form.
  const longFormIssuerDID = 'did:prism:evilcorp-hash-ccc:Co4CCosCEj4KCmF1dGgta2V5LTEQBEouCg';
  const resolved = resolveEmployerCompany(longFormIssuerDID, { companies: FAKE_COMPANIES });
  assert.strictEqual(resolved.id, 'evilcorp', 'must match evilcorp via hash segment despite long-form vs short-form difference');

  // And the reverse: company list with a long-form did, issuerDID short-form.
  const longFormCompanies = FAKE_COMPANIES.map((c) =>
    c.id === 'acme' ? { ...c, did: `${c.did}:extraKeyMaterialBase64` } : c
  );
  const resolvedAcme = resolveEmployerCompany('did:prism:acme-hash-bbb', { companies: longFormCompanies });
  assert.strictEqual(resolvedAcme.id, 'acme');
});

// ── Test 3: no match / missing issuerDID falls back to techcorp ────────────────────────────────
test('falls back to techcorp when issuerDID matches no known company', () => {
  const unknown = resolveEmployerCompany('did:prism:some-unrelated-hash-zzz', { companies: FAKE_COMPANIES });
  assert.strictEqual(unknown.id, 'techcorp', 'unmatched issuerDID must fall back to techcorp');
});

test('falls back to techcorp when issuerDID is missing (legacy sessions predating issuerDID storage)', () => {
  assert.strictEqual(resolveEmployerCompany(undefined, { companies: FAKE_COMPANIES }).id, 'techcorp');
  assert.strictEqual(resolveEmployerCompany(null, { companies: FAKE_COMPANIES }).id, 'techcorp');
  assert.strictEqual(resolveEmployerCompany('', { companies: FAKE_COMPANIES }).id, 'techcorp');
});

// ── Test 4: parity with the actual hardcoded techcorp DID used elsewhere in server.js ───────────
test('matches the real hardcoded TechCorp DID string used elsewhere in server.js (parity check)', () => {
  // Load the REAL lib/companies.js (no injected fake list) — proves resolveEmployerCompany's
  // default (no `options.companies`) path also works against production data, and that a
  // TechCorp employee's session.issuerDID (as actually stored, per server.js's TECHCORP_DID /
  // COMPANIES.techcorp.did) still resolves to techcorp — behavior-preserving for the existing
  // production tenant.
  const { COMPANIES } = require('../lib/companies');
  const realTechCorpDid = COMPANIES.techcorp.did;

  const resolved = resolveEmployerCompany(realTechCorpDid);
  assert.strictEqual(resolved.id, 'techcorp');
  assert.strictEqual(resolved.did, realTechCorpDid);

  // Same for ACME, which is the "first time this actually gets exercised correctly" behavior
  // change called out in the fix.
  const resolvedAcme = resolveEmployerCompany(COMPANIES.acme.did);
  assert.strictEqual(resolvedAcme.id, 'acme');

  // And EvilCorp, the tenant that originally 404'd.
  const resolvedEvilcorp = resolveEmployerCompany(COMPANIES.evilcorp.did);
  assert.strictEqual(resolvedEvilcorp.id, 'evilcorp');
});

// ── Test 5: prismDidsMatch itself — sanity-check the exported comparator ───────────────────────
test('exported prismDidsMatch: hash-segment tolerant, false for null/undefined/unrelated', () => {
  assert.strictEqual(prismDidsMatch('did:prism:abc', 'did:prism:abc'), true);
  assert.strictEqual(prismDidsMatch('did:prism:abc', 'did:prism:abc:keymaterial'), true);
  assert.strictEqual(prismDidsMatch('did:prism:abc:keymaterial', 'did:prism:abc'), true);
  assert.strictEqual(prismDidsMatch('did:prism:abc', 'did:prism:xyz'), false);
  assert.strictEqual(prismDidsMatch(null, 'did:prism:abc'), false);
  assert.strictEqual(prismDidsMatch(undefined, undefined), false);
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
