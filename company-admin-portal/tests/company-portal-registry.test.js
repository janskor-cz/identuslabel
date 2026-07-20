'use strict';

/**
 * Company Portal Registry — regression test for the evilcorp employee-portal-login bug
 *
 * Background: server.js used to hand-wire exactly two ServiceAccessService instances
 * (`techcorpDIDComm`, `acmeDIDComm`) across 6 separate call sites. `evilcorp` is fully defined
 * in lib/companies.js but was never wired up at any of those sites, so its employee-portal
 * login silently did nothing (wallet sends access-request, nothing ever answers, grant-poller
 * times out after 2 minutes with no error).
 *
 * lib/companyPortalRegistry.js replaces all 6 hand-wired sites with a single config-driven
 * registry built from `getAllCompanies()`. This test proves the registry is generic — it must
 * treat every company identically, with no hardcoded 'techcorp'/'acme' special-casing — using
 * fully injected fakes for ServiceAccessService, createTrustRegistry, createIssuerResolver, and
 * resolveConnectionByDID, so it never touches the real multitenancy Cloud Agent.
 *
 * Tests:
 * 1. buildCompanyPortalRegistry produces one entry per input company (3, including an
 *    evilcorp-shaped one), each structurally identical in shape.
 * 2. Each entry's capability key is `${id}-employee-portal` and its capability config
 *    (redirectPath, trustedIssuerVcType, icon, label) is populated correctly per company.
 * 3. consumeGrant/getToken dispatch correctly across multiple companies' services.
 * 4. registerAllWebhooks calls every company's registerWebhook independently — one company's
 *    rejection does not stop the others (and does not crash the process via unhandled rejection).
 */

const assert = require('assert');

const TASK = 'Company Portal Registry';
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

const { buildCompanyPortalRegistry } = require('../lib/companyPortalRegistry');

// ── Fakes / injected collaborators ───────────────────────────────────────────────────────────

class FakeServiceAccessService {
  constructor(config) {
    this.config = config;
    this._grants = new Map();
    this._tokens = new Map();
    this.registeredUrls = [];
    this.throwOnRegister = false;
  }
  consumeGrant(key) {
    return this._grants.get(key) || null;
  }
  getToken(token) {
    return this._tokens.get(token) || null;
  }
  async registerWebhook(url) {
    this.registeredUrls.push(url);
    if (this.throwOnRegister) throw new Error(`boom-${url}`);
    return true;
  }
}

function fakeCreateTrustRegistry(entries) {
  return { __fake: true, entries };
}

const issuerResolverCalls = [];
function fakeCreateIssuerResolver({ cloudAgentUrl, apiKey }) {
  issuerResolverCalls.push({ cloudAgentUrl, apiKey });
  return async () => `resolved-issuer-for-${apiKey}`;
}

const resolveConnectionCalls = [];
async function fakeResolveConnectionByDID(agentUrl, apiKey, fromDid) {
  resolveConnectionCalls.push({ agentUrl, apiKey, fromDid });
  return `conn-${apiKey}-${fromDid}`;
}

function fakeMakeEmployeePortalProofSpec(companyLabel, issuerDid) {
  return { proofFor: companyLabel, issuerDid };
}

// A 3-company sample, structurally identical to lib/companies.js, including an
// evilcorp-shaped 3rd entry — the exact shape of the real bug.
function sampleCompanies() {
  return [
    {
      id: 'techcorp', name: 'TechCorp', displayName: 'TechCorp Corporation',
      apiKey: 'key-techcorp', did: 'did:prism:techcorp-fake', logo: '🏢',
    },
    {
      id: 'acme', name: 'ACME', displayName: 'ACME Corporation',
      apiKey: 'key-acme', did: 'did:prism:acme-fake', logo: '🔨',
    },
    {
      id: 'evilcorp', name: 'EvilCorp', displayName: 'EvilCorp Industries',
      apiKey: 'key-evilcorp', did: 'did:prism:evilcorp-fake', logo: '🏴',
    },
  ];
}

function buildTestRegistry(companies) {
  return buildCompanyPortalRegistry({
    companies,
    cloudAgentUrl: 'http://fake-cloud-agent:8200',
    publicBaseUrl: 'https://fake.example.com/company-admin',
    resolveConnectionByDID: fakeResolveConnectionByDID,
    createIssuerResolver: fakeCreateIssuerResolver,
    makeEmployeePortalProofSpec: fakeMakeEmployeePortalProofSpec,
    ServiceAccessService: FakeServiceAccessService,
    createTrustRegistry: fakeCreateTrustRegistry,
    accessPath: '/api/access',
    tokenTTLMs: 5 * 60 * 1000,
    redirectPath: '/company-admin/employee-portal-dashboard.html',
  });
}

// ── Test 1: one entry per company, including an evilcorp-shaped 3rd/nth company ──────────────
test('registry produces one entry per company, no hardcoded name checks', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  assert.strictEqual(registry.entries.length, companies.length, 'must produce one entry per input company');

  const idsSeen = registry.entries.map((e) => e.id).sort();
  assert.deepStrictEqual(idsSeen, ['acme', 'evilcorp', 'techcorp'], 'every company id must be represented');

  // Every entry must be structurally identical in shape — same keys, same types — regardless
  // of company id. This is the actual regression check: nothing here may be special-cased to
  // 'techcorp'/'acme' such that a 3rd company gets a different (or missing) shape.
  for (const entry of registry.entries) {
    assert.strictEqual(typeof entry.id, 'string');
    assert.ok(entry.company, `entry.company must be set for ${entry.id}`);
    assert.ok(entry.service instanceof FakeServiceAccessService, `entry.service must be a ServiceAccessService for ${entry.id}`);
    assert.strictEqual(typeof entry.capabilityKey, 'string');
    assert.strictEqual(entry.capabilityKey, `${entry.id}-employee-portal`);
  }

  // getService() must resolve every company by id, including evilcorp.
  for (const company of companies) {
    const service = registry.getService(company.id);
    assert.ok(service instanceof FakeServiceAccessService, `getService('${company.id}') must return a service`);
  }
});

// ── Test 2: capability config populated correctly per company ────────────────────────────────
test('each entry\'s capability config is populated correctly per company', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  for (const entry of registry.entries) {
    const { company, capabilityKey, service } = entry;
    const capConfig = service.config.capabilities[capabilityKey];
    assert.ok(capConfig, `capability config for '${capabilityKey}' must exist on the service`);

    assert.strictEqual(capConfig.mode, 'redirect');
    assert.strictEqual(capConfig.redirectPath, '/company-admin/employee-portal-dashboard.html');
    assert.strictEqual(capConfig.trustedIssuerVcType, 'EmployeeRole');
    assert.strictEqual(capConfig.icon, company.logo, `icon must reuse company.logo for ${company.id}`);
    assert.strictEqual(capConfig.label, `${company.name} Employee Portal`, `label must match '<name> Employee Portal' style for ${company.id}`);

    // proofSpec must have been built via the injected makeEmployeePortalProofSpec, per-company.
    assert.deepStrictEqual(capConfig.proofSpec, { proofFor: company.name, issuerDid: company.did });

    // apiKey / cloudAgentUrl / publicBaseUrl must be per-company / shared config, not hardcoded.
    assert.strictEqual(service.config.apiKey, company.apiKey);
    assert.strictEqual(service.config.cloudAgentUrl, 'http://fake-cloud-agent:8200');
    assert.strictEqual(service.config.publicBaseUrl, 'https://fake.example.com/company-admin');
  }

  // Verify TechCorp/ACME specifically preserve their known-good original labels exactly
  // (behavior preservation for the two production tenants, not just evilcorp).
  const techcorp = registry.getService('techcorp');
  const acme = registry.getService('acme');
  assert.strictEqual(techcorp.config.capabilities['techcorp-employee-portal'].label, 'TechCorp Employee Portal');
  assert.strictEqual(acme.config.capabilities['acme-employee-portal'].label, 'ACME Employee Portal');

  // All companies must share one trust registry object (matches original behavior where
  // employeeRoleTrustRegistry was built once and reused across both services).
  const trustRegistries = new Set(registry.entries.map((e) => e.service.config.trustRegistry));
  assert.strictEqual(trustRegistries.size, 1, 'all companies must share a single trust registry instance');
  const [sharedRegistry] = trustRegistries;
  assert.strictEqual(sharedRegistry.entries.length, companies.length, 'trust registry must contain one entry per company');
});

// ── Test 3: consumeGrant / getToken dispatch correctly across companies ──────────────────────
test('consumeGrant dispatches to whichever company\'s service holds the key', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  // Nothing seeded yet — must return null/falsy, not throw.
  assert.ok(!registry.consumeGrant('nonexistent-key'));

  // Seed a grant on 'acme' (not the first company in the list) — proves dispatch isn't just
  // "always check index 0".
  const acmeService = registry.getService('acme');
  acmeService._grants.set('req-42', { grant: { accessUrl: 'https://fake.example.com/api/access?token=t1' } });

  const result = registry.consumeGrant('req-42');
  assert.ok(result, 'consumeGrant must find the grant even though techcorp (checked first) has nothing');
  assert.strictEqual(result.grant.accessUrl, 'https://fake.example.com/api/access?token=t1');

  // Seed a different grant on evilcorp (the 3rd/last company) too.
  const evilcorpService = registry.getService('evilcorp');
  evilcorpService._grants.set('req-99', { grant: { accessUrl: 'https://fake.example.com/api/access?token=t2' } });
  const result2 = registry.consumeGrant('req-99');
  assert.ok(result2, 'consumeGrant must find grants on the last company in the list too');
  assert.strictEqual(result2.grant.accessUrl, 'https://fake.example.com/api/access?token=t2');
});

test('getToken finds which company owns a token, across multiple companies', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  assert.strictEqual(registry.getToken('no-such-token'), null);

  const acmeService = registry.getService('acme');
  acmeService._tokens.set('tok-acme-1', { used: false, expiresAt: Date.now() + 60000, redirectPath: '/company-admin/employee-portal-dashboard.html' });

  const found = registry.getToken('tok-acme-1');
  assert.ok(found, 'getToken must find the token');
  assert.strictEqual(found.companyId, 'acme', 'getToken must report the correct owning companyId');
  assert.strictEqual(found.entry.used, false);

  // A token registered on evilcorp must resolve to companyId 'evilcorp', not 'techcorp'/'acme'.
  const evilcorpService = registry.getService('evilcorp');
  evilcorpService._tokens.set('tok-evilcorp-1', { used: false, expiresAt: Date.now() + 60000 });
  const foundEvil = registry.getToken('tok-evilcorp-1');
  assert.ok(foundEvil);
  assert.strictEqual(foundEvil.companyId, 'evilcorp');
});

// ── Test 4: registerAllWebhooks isolates per-company failures ────────────────────────────────
test('registerAllWebhooks calls every company independently; one failure does not block others', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  // Make techcorp's registration reject, to prove the others still run.
  registry.getService('techcorp').throwOnRegister = true;

  registry.registerAllWebhooks((id) => `https://fake.example.com/company-admin/api/didcomm-webhook/${id}`);

  // Flush pending microtasks/timers so the fire-and-forget promises resolve/reject.
  await new Promise((resolve) => setTimeout(resolve, 20));

  for (const company of companies) {
    const service = registry.getService(company.id);
    assert.strictEqual(
      service.registeredUrls[0],
      `https://fake.example.com/company-admin/api/didcomm-webhook/${company.id}`,
      `registerWebhook must have been invoked for ${company.id} regardless of other companies' outcomes`
    );
  }
});

// ── Test 5: mountAllWebhooks mounts a route per company using the caller's handler factory ───
test('mountAllWebhooks mounts one route per company via the injected handler factory', async () => {
  const companies = sampleCompanies();
  const registry = buildTestRegistry(companies);

  const mountedRoutes = [];
  const fakeApp = {
    use(path, handler) {
      mountedRoutes.push({ path, handler });
    },
  };
  const handlerFactory = (service, label) => ({ __service: service, __label: label });

  registry.mountAllWebhooks(fakeApp, handlerFactory);

  assert.strictEqual(mountedRoutes.length, companies.length);
  const paths = mountedRoutes.map((r) => r.path).sort();
  assert.deepStrictEqual(paths, [
    '/api/didcomm-webhook/acme',
    '/api/didcomm-webhook/evilcorp',
    '/api/didcomm-webhook/techcorp',
  ]);

  // Label passed to the handler factory must be company.name ('TechCorp'/'ACME'), matching the
  // original hardcoded call sites exactly (not company.displayName).
  const techcorpRoute = mountedRoutes.find((r) => r.path === '/api/didcomm-webhook/techcorp');
  assert.strictEqual(techcorpRoute.handler.__label, 'TechCorp');
  const acmeRoute = mountedRoutes.find((r) => r.path === '/api/didcomm-webhook/acme');
  assert.strictEqual(acmeRoute.handler.__label, 'ACME');
});

// ── Test 6: throws on empty company list rather than silently building nothing ───────────────
test('buildCompanyPortalRegistry rejects an empty company list', async () => {
  assert.throws(() => buildTestRegistry([]), /non-empty array/);
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
