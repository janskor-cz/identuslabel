'use strict';

/**
 * resolveDocumentAccessTenant — regression test for the "document-access DIDComm gate hardcodes
 * TechCorp" bug pattern (same bug class as resolve-employer-company.test.js, different flow).
 *
 * Background: POST /api/document-access/initiate resolves a DIDComm connectionId for a personal
 * wallet via up to three strategies: (1) the in-memory employee-connection mapping file, which
 * carries a hand-maintained `company` label (e.g. "TechCorp") alongside the connectionId; (2/3)
 * a legacy single-tenant EmployeePortalDatabase lookup (`techcorp_connection_id` column) that
 * carries no company/tenant information at all. The route then unconditionally created the
 * Cloud Agent present-proof request with TechCorp's apiKey — wrong whenever the connection
 * actually lives on ACME's or EvilCorp's isolated tenant wallet on the shared multitenancy
 * Cloud Agent.
 *
 * lib/resolveDocumentAccessTenant.js fixes this with two pieces:
 *   - resolveCompanyByLabel: maps a Strategy-1 mapping-file `company` string back to a real
 *     company object (case-insensitive match against name or displayName).
 *   - findTenantForConnectionId: for Strategy 2/3 (no company info available), tries each
 *     company's apiKey against the Cloud Agent's connection-lookup endpoint in turn — mirroring
 *     the same "try each tenant until one matches" pattern already used by
 *     lib/companyPortalRegistry.js's consumeGrant/getToken.
 *
 * This test exercises both directly, plus the combined resolveDocumentAccessTenant, using fake
 * company lists and an injected fetch so it never touches the real multitenancy Cloud Agent.
 */

const assert = require('assert');

const TASK = 'resolveDocumentAccessTenant';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

const {
  resolveCompanyByLabel,
  findTenantForConnectionId,
  resolveDocumentAccessTenant,
} = require('../lib/resolveDocumentAccessTenant');

// ── Fake company list, structurally identical to lib/companies.js ──────────────────────────────
const FAKE_COMPANIES = [
  { id: 'techcorp', name: 'TechCorp', displayName: 'TechCorp Corporation', apiKey: 'key-techcorp' },
  { id: 'acme', name: 'ACME', displayName: 'ACME Corporation', apiKey: 'key-acme' },
  { id: 'evilcorp', name: 'EvilCorp', displayName: 'EvilCorp Industries', apiKey: 'key-evilcorp' },
];

// ── resolveCompanyByLabel ────────────────────────────────────────────────────────────────────

test('resolveCompanyByLabel: matches the exact mapping-file label ("TechCorp") to company.name', () => {
  const resolved = resolveCompanyByLabel('TechCorp', { companies: FAKE_COMPANIES });
  assert.strictEqual(resolved.id, 'techcorp');
});

test('resolveCompanyByLabel: matches case-insensitively against company.name', () => {
  const resolved = resolveCompanyByLabel('acme', { companies: FAKE_COMPANIES });
  assert.strictEqual(resolved.id, 'acme', 'lowercase label must still resolve to ACME, not fall back to techcorp');

  const resolvedUpper = resolveCompanyByLabel('EVILCORP', { companies: FAKE_COMPANIES });
  assert.strictEqual(resolvedUpper.id, 'evilcorp');
});

test('resolveCompanyByLabel: matches case-insensitively against company.displayName', () => {
  const resolved = resolveCompanyByLabel('acme corporation', { companies: FAKE_COMPANIES });
  assert.strictEqual(resolved.id, 'acme');
});

test('resolveCompanyByLabel: returns null for an unknown label (no silent techcorp default)', () => {
  const resolved = resolveCompanyByLabel('NotARealCompany', { companies: FAKE_COMPANIES });
  assert.strictEqual(resolved, null);
});

test('resolveCompanyByLabel: returns null for missing/empty label', () => {
  assert.strictEqual(resolveCompanyByLabel(null, { companies: FAKE_COMPANIES }), null);
  assert.strictEqual(resolveCompanyByLabel(undefined, { companies: FAKE_COMPANIES }), null);
  assert.strictEqual(resolveCompanyByLabel('', { companies: FAKE_COMPANIES }), null);
  assert.strictEqual(resolveCompanyByLabel('   ', { companies: FAKE_COMPANIES }), null);
});

// ── findTenantForConnectionId (fake fetch, no real network call) ───────────────────────────────

// Fake fetch: only the given company's apiKey gets a 200 for the given connectionId.
function makeFakeFetch({ okApiKey, callLog }) {
  return async (url, opts) => {
    const apiKey = opts && opts.headers && opts.headers.apikey;
    callLog.push({ url, apiKey });
    if (apiKey === okApiKey) {
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 404 };
  };
}

test('findTenantForConnectionId: tries each tenant in order and picks the one that returns ok', async () => {
  const callLog = [];
  const fetchImpl = makeFakeFetch({ okApiKey: 'key-acme', callLog });

  const resolved = await findTenantForConnectionId('conn-123', {
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved.id, 'acme');
  // Must have tried techcorp first (in list order) before finding acme.
  assert.strictEqual(callLog[0].apiKey, 'key-techcorp');
  assert.strictEqual(callLog[1].apiKey, 'key-acme');
  assert.strictEqual(callLog[0].url, 'http://fake-cloud-agent:8200/connections/conn-123');
});

test('findTenantForConnectionId: returns null when no tenant recognizes the connectionId (fail closed)', async () => {
  const callLog = [];
  const fetchImpl = makeFakeFetch({ okApiKey: 'key-does-not-exist', callLog });

  const resolved = await findTenantForConnectionId('conn-unknown', {
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved, null, 'must fail closed instead of defaulting to techcorp');
  assert.strictEqual(callLog.length, FAKE_COMPANIES.length, 'must have tried every tenant');
});

test('findTenantForConnectionId: a tenant whose fetch throws is skipped, not fatal', async () => {
  const callLog = [];
  const fetchImpl = async (url, opts) => {
    const apiKey = opts.headers.apikey;
    callLog.push(apiKey);
    if (apiKey === 'key-techcorp') throw new Error('network error');
    if (apiKey === 'key-acme') return { ok: true, status: 200 };
    return { ok: false, status: 404 };
  };

  const resolved = await findTenantForConnectionId('conn-456', {
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved.id, 'acme');
  assert.deepStrictEqual(callLog, ['key-techcorp', 'key-acme']);
});

test('findTenantForConnectionId: returns null for a missing connectionId without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true }; };
  const resolved = await findTenantForConnectionId(null, {
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });
  assert.strictEqual(resolved, null);
  assert.strictEqual(called, false);
});

// ── resolveDocumentAccessTenant (combined) ──────────────────────────────────────────────────────

test('resolveDocumentAccessTenant: Strategy-1 mapping label short-circuits without probing tenants', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { ok: true }; };

  const resolved = await resolveDocumentAccessTenant({
    connectionId: 'conn-789',
    mappingCompanyLabel: 'TechCorp',
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved.id, 'techcorp');
  assert.strictEqual(fetchCalled, false, 'a resolvable mapping label must not need a Cloud Agent probe');
});

test('resolveDocumentAccessTenant: no mapping label (DB path) falls back to the try-each-tenant probe', async () => {
  const callLog = [];
  const fetchImpl = makeFakeFetch({ okApiKey: 'key-evilcorp', callLog });

  const resolved = await resolveDocumentAccessTenant({
    connectionId: 'conn-db-1',
    mappingCompanyLabel: null,
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved.id, 'evilcorp');
  assert.ok(callLog.length > 0, 'must have probed tenants since no mapping label was available');
});

test('resolveDocumentAccessTenant: an unresolvable mapping label falls back to the probe rather than failing immediately', async () => {
  const callLog = [];
  const fetchImpl = makeFakeFetch({ okApiKey: 'key-acme', callLog });

  const resolved = await resolveDocumentAccessTenant({
    connectionId: 'conn-db-2',
    mappingCompanyLabel: 'SomeTypoedCompanyName',
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved.id, 'acme');
});

test('resolveDocumentAccessTenant: returns null (fail closed) when nothing resolves — never defaults to techcorp', async () => {
  const callLog = [];
  const fetchImpl = makeFakeFetch({ okApiKey: 'key-does-not-exist', callLog });

  const resolved = await resolveDocumentAccessTenant({
    connectionId: 'conn-nowhere',
    mappingCompanyLabel: null,
    companies: FAKE_COMPANIES,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    fetchImpl,
  });

  assert.strictEqual(resolved, null);
});

// ── Real lib/companies.js parity check ──────────────────────────────────────────────────────────

test('resolveCompanyByLabel: matches parity against the real lib/companies.js data ("TechCorp" label from the actual mapping file)', () => {
  const { COMPANIES } = require('../lib/companies');
  const resolved = resolveCompanyByLabel('TechCorp');
  assert.strictEqual(resolved.id, 'techcorp');
  assert.strictEqual(resolved.apiKey, COMPANIES.techcorp.apiKey);
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
