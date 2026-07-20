'use strict';

/**
 * ReleasablePartnersRegistry — unit tests.
 *
 * Background: the employee document-upload modal's "Releasable To" checkbox list used to be
 * hardcoded HTML (only TechCorp + ACME, never EvilCorp, never reflecting the uploading
 * employee's own company). ReleasablePartnersRegistry (lib/ReleasablePartnersRegistry.js)
 * makes this admin-manageable: each company's admin adds/removes partner entries (Name + DID)
 * from their own admin portal, persisted as an HMAC-SHA256-signed JSON file, mirroring
 * lib/FolderRegistry.js's pattern.
 *
 * These tests construct independent instances via the exported `ReleasablePartnersRegistry`
 * class (attached to the singleton export) pointed at a temp file path under the OS temp
 * directory — never the real `data/releasable-partners.json` used by the singleton required
 * elsewhere in server.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK = 'ReleasablePartnersRegistry';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

const { ReleasablePartnersRegistry } = require('../lib/ReleasablePartnersRegistry');

function makeTestRegistry() {
  const registry = new ReleasablePartnersRegistry();
  registry.storagePath = path.join(
    os.tmpdir(),
    `releasable-partners-test-${crypto_randomSuffix()}.json`
  );
  return registry;
}

// Small local helper (avoid pulling in node's crypto just for a random suffix — Math.random
// is fine here, this is only a throwaway test file path, not anything security-sensitive).
function crypto_randomSuffix() {
  return Date.now() + '-' + Math.random().toString(36).slice(2);
}

async function cleanup(registry) {
  try { await fs.promises.unlink(registry.storagePath); } catch { /* ignore */ }
}

// ── Test 1: addPartner rejects empty/whitespace-only name ──────────────────────────────────
test('addPartner rejects empty and whitespace-only name', async () => {
  const registry = makeTestRegistry();
  try {
    await assert.rejects(
      () => registry.addPartner('techcorp', { name: '', did: 'did:prism:abc' }),
      /name/i
    );
    await assert.rejects(
      () => registry.addPartner('techcorp', { name: '   ', did: 'did:prism:abc' }),
      /name/i
    );
  } finally {
    await cleanup(registry);
  }
});

// ── Test 2: addPartner rejects a did not starting with 'did:' ──────────────────────────────
test('addPartner rejects a did that does not start with "did:"', async () => {
  const registry = makeTestRegistry();
  try {
    await assert.rejects(
      () => registry.addPartner('techcorp', { name: 'ACME', did: 'not-a-did' }),
      /did/i
    );
  } finally {
    await cleanup(registry);
  }
});

// ── Test 2b: addPartner rejects a did containing HTML/attribute-breaking characters ────────
// Regression test for a stored-XSS finding from security review: the employee-facing upload
// modal renders partner.did inside a double-quoted HTML attribute
// (value="${escapeAttr(partner.did)}" in employee-portal-dashboard.js). Rejecting quotes,
// angle brackets, and whitespace here — in addition to the client-side escapeAttr() fix — is
// defense-in-depth so a malicious admin can never persist a did value shaped to break out of
// that attribute (e.g. `did:x" autofocus onfocus="...`).
test('addPartner rejects a did containing whitespace or HTML-significant characters', async () => {
  const registry = makeTestRegistry();
  try {
    const maliciousPayload = 'did:x" autofocus onfocus="fetch(1)';
    await assert.rejects(
      () => registry.addPartner('techcorp', { name: 'Evil', did: maliciousPayload }),
      /whitespace|html/i
    );
    // A handful of other HTML-significant characters, each on its own.
    for (const bad of ['did:a"b', "did:a'b", 'did:a<b', 'did:a>b', 'did:a`b', 'did:a b']) {
      await assert.rejects(() => registry.addPartner('techcorp', { name: 'X', did: bad }));
    }
    // Sanity: a normal DID with no such characters must still be accepted.
    const entry = await registry.addPartner('techcorp', { name: 'ACME', did: 'did:prism:acme-hash-123' });
    assert.strictEqual(entry.did, 'did:prism:acme-hash-123');
  } finally {
    await cleanup(registry);
  }
});

// ── Test 3: addPartner then getPartnersForCompany returns the new entry with id + addedAt ──
test('addPartner then getPartnersForCompany returns the new entry with generated id and addedAt', async () => {
  const registry = makeTestRegistry();
  try {
    const entry = await registry.addPartner('techcorp', { name: 'ACME Corporation', did: 'did:prism:acme-hash' });

    assert.ok(entry.id, 'entry should have a generated id');
    assert.strictEqual(entry.name, 'ACME Corporation');
    assert.strictEqual(entry.did, 'did:prism:acme-hash');
    assert.ok(entry.addedAt, 'entry should have an addedAt timestamp');
    assert.ok(!Number.isNaN(new Date(entry.addedAt).getTime()), 'addedAt should be a valid ISO date string');

    const partners = registry.getPartnersForCompany('techcorp');
    assert.strictEqual(partners.length, 1);
    assert.strictEqual(partners[0].id, entry.id);
    assert.strictEqual(partners[0].name, 'ACME Corporation');
    assert.strictEqual(partners[0].did, 'did:prism:acme-hash');
  } finally {
    await cleanup(registry);
  }
});

// ── Test 3b: name is trimmed ─────────────────────────────────────────────────────────────
test('addPartner trims the name before storing', async () => {
  const registry = makeTestRegistry();
  try {
    const entry = await registry.addPartner('techcorp', { name: '  EvilCorp Industries  ', did: 'did:prism:evilcorp-hash' });
    assert.strictEqual(entry.name, 'EvilCorp Industries');
  } finally {
    await cleanup(registry);
  }
});

// ── Test 4: getPartnersForCompany returns [] (never undefined) for an unknown company ──────
test('getPartnersForCompany returns an empty array (never undefined) for a company with no partners yet', () => {
  const registry = makeTestRegistry();
  const partners = registry.getPartnersForCompany('nonexistent-company');
  assert.deepStrictEqual(partners, []);
});

// ── Test 5: removePartner removes the right entry, leaves others for the same company ─────
test('removePartner removes the right entry and leaves others for the same company untouched', async () => {
  const registry = makeTestRegistry();
  try {
    const e1 = await registry.addPartner('techcorp', { name: 'ACME', did: 'did:prism:acme-hash' });
    const e2 = await registry.addPartner('techcorp', { name: 'EvilCorp', did: 'did:prism:evilcorp-hash' });

    await registry.removePartner('techcorp', e1.id);

    const remaining = registry.getPartnersForCompany('techcorp');
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, e2.id);
    assert.strictEqual(remaining[0].name, 'EvilCorp');
  } finally {
    await cleanup(registry);
  }
});

// ── Test 6: removePartner on a nonexistent id is a safe no-op (doesn't throw) ───────────────
test('removePartner on a nonexistent partner id is a safe no-op', async () => {
  const registry = makeTestRegistry();
  try {
    await registry.addPartner('techcorp', { name: 'ACME', did: 'did:prism:acme-hash' });
    await assert.doesNotReject(() => registry.removePartner('techcorp', 'nonexistent-id'));

    // The real entry must still be there, untouched.
    const partners = registry.getPartnersForCompany('techcorp');
    assert.strictEqual(partners.length, 1);
    assert.strictEqual(partners[0].name, 'ACME');
  } finally {
    await cleanup(registry);
  }
});

test('removePartner on a company with no partners at all is a safe no-op', async () => {
  const registry = makeTestRegistry();
  try {
    await assert.doesNotReject(() => registry.removePartner('never-added-anything', 'some-id'));
    assert.deepStrictEqual(registry.getPartnersForCompany('never-added-anything'), []);
  } finally {
    await cleanup(registry);
  }
});

// ── Test 7: persistence round-trip — save, fresh instance at same path, initialize(), survives ──
test('persistence round-trip: data survives save + fresh instance + initialize()', async () => {
  const storagePath = path.join(os.tmpdir(), `releasable-partners-test-roundtrip-${crypto_randomSuffix()}.json`);

  const registry1 = new ReleasablePartnersRegistry();
  registry1.storagePath = storagePath;

  try {
    const entry = await registry1.addPartner('techcorp', { name: 'ACME Corporation', did: 'did:prism:acme-hash' });

    const registry2 = new ReleasablePartnersRegistry();
    registry2.storagePath = storagePath;
    await registry2.initialize();

    const partners = registry2.getPartnersForCompany('techcorp');
    assert.strictEqual(partners.length, 1);
    assert.strictEqual(partners[0].id, entry.id);
    assert.strictEqual(partners[0].name, 'ACME Corporation');
    assert.strictEqual(partners[0].did, 'did:prism:acme-hash');
    assert.strictEqual(partners[0].addedAt, entry.addedAt);
  } finally {
    try { await fs.promises.unlink(storagePath); } catch { /* ignore */ }
  }
});

// ── Test 8: two different companies' partner lists don't leak into each other ──────────────
test("two different companies' partner lists don't leak into each other", async () => {
  const registry = makeTestRegistry();
  try {
    await registry.addPartner('techcorp', { name: 'ACME Corporation', did: 'did:prism:acme-hash' });
    await registry.addPartner('acme', { name: 'TechCorp Corporation', did: 'did:prism:techcorp-hash' });
    await registry.addPartner('acme', { name: 'EvilCorp Industries', did: 'did:prism:evilcorp-hash' });

    const techcorpPartners = registry.getPartnersForCompany('techcorp');
    const acmePartners = registry.getPartnersForCompany('acme');
    const evilcorpPartners = registry.getPartnersForCompany('evilcorp');

    assert.strictEqual(techcorpPartners.length, 1);
    assert.strictEqual(techcorpPartners[0].name, 'ACME Corporation');

    assert.strictEqual(acmePartners.length, 2);
    assert.deepStrictEqual(acmePartners.map(p => p.name).sort(), ['EvilCorp Industries', 'TechCorp Corporation']);

    assert.deepStrictEqual(evilcorpPartners, []);

    // Removing from one company must not affect the other's list.
    await registry.removePartner('techcorp', techcorpPartners[0].id);
    assert.deepStrictEqual(registry.getPartnersForCompany('techcorp'), []);
    assert.strictEqual(registry.getPartnersForCompany('acme').length, 2, 'acme partners must be untouched');
  } finally {
    await cleanup(registry);
  }
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
