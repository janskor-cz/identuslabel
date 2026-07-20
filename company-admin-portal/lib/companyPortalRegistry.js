/**
 * Company Portal Registry
 *
 * Config-driven replacement for the old per-company hardcoded `techcorpDIDComm` /
 * `acmeDIDComm` constants in server.js. Building a new tenant's employee-portal DIDComm
 * access-request wiring used to require touching 6 separate call sites in server.js by hand
 * (trust registry, ServiceAccessService construction, webhook mount, grant-status polling,
 * access-token redemption, boot-time webhook registration) — miss any one of them (as happened
 * with `evilcorp`, defined in lib/companies.js but never wired up) and that company's employee
 * portal login silently does nothing: the wallet sends an access-request, nothing ever answers
 * it, and the wallet's grant-poller times out after 2 minutes with no error.
 *
 * This module builds one `ServiceAccessService` per company from `getAllCompanies()` and
 * exposes a small registry object so adding (or fixing) a tenant is a `lib/companies.js`-only
 * change — zero further server.js edits required.
 *
 * Collaborators (ServiceAccessService, createTrustRegistry, resolveConnectionByDID,
 * createIssuerResolver, makeEmployeePortalProofSpec) are injected rather than required directly
 * by this module, so it can be unit-tested with fakes and never has to touch the real
 * multitenancy Cloud Agent.
 */

/**
 * @param {Object} opts
 * @param {Array}  opts.companies - array of company objects (id, name, displayName, apiKey, did, logo, ...)
 * @param {string} opts.cloudAgentUrl - multitenancy Cloud Agent base URL
 * @param {string} opts.publicBaseUrl - this service's own public base URL (for access links)
 * @param {Function} opts.resolveConnectionByDID - (agentUrl, apiKey, fromDid) => Promise<connectionId|null>
 * @param {Function} opts.createIssuerResolver - ({ cloudAgentUrl, apiKey }) => resolveIssuerDID fn
 * @param {Function} opts.makeEmployeePortalProofSpec - (companyLabel, issuerDid) => proofSpec
 * @param {Function} opts.ServiceAccessService - the ServiceAccessService class/constructor
 * @param {Function} opts.createTrustRegistry - (entries) => trustRegistry
 * @param {string}  [opts.accessPath] - defaults to '/api/access'
 * @param {number}  [opts.tokenTTLMs] - defaults to 5 minutes
 * @param {string}  [opts.redirectPath] - defaults to '/company-admin/employee-portal-dashboard.html'
 * @returns {{
 *   entries: Array<{ id: string, company: Object, service: Object, capabilityKey: string }>,
 *   getService: (id: string) => Object|undefined,
 *   consumeGrant: (key: any) => any,
 *   getToken: (token: string) => { entry: any, companyId: string } | null,
 *   registerAllWebhooks: (basePathBuilder: (id: string) => string) => void,
 *   mountAllWebhooks: (app: Object, handlerFactory: (service: Object, label: string) => Function) => void,
 * }}
 */
function buildCompanyPortalRegistry({
  companies,
  cloudAgentUrl,
  publicBaseUrl,
  resolveConnectionByDID,
  createIssuerResolver,
  makeEmployeePortalProofSpec,
  ServiceAccessService,
  createTrustRegistry,
  accessPath = '/api/access',
  tokenTTLMs = 5 * 60 * 1000,
  redirectPath = '/company-admin/employee-portal-dashboard.html',
}) {
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new Error('buildCompanyPortalRegistry: companies must be a non-empty array');
  }

  // One shared trust registry entry per company — every company's EmployeeRole issuer DID is
  // trusted for its own EmployeeRole VCs (mirrors the original hand-written
  // employeeRoleTrustRegistry in server.js).
  const employeeRoleTrustRegistry = createTrustRegistry(
    companies.map((company) => ({ did: company.did, vcTypes: ['EmployeeRole'] }))
  );

  const entries = companies.map((company) => {
    const capabilityKey = `${company.id}-employee-portal`;
    // NOTE: `company.name` (short form: 'TechCorp', 'ACME'), not `company.displayName`
    // ('TechCorp Corporation', 'ACME Corporation') — this is what reproduces the original
    // hardcoded labels ('TechCorp Employee Portal', 'ACME Employee Portal') exactly.
    const label = `${company.name} Employee Portal`;

    const service = new ServiceAccessService({
      cloudAgentUrl,
      apiKey: company.apiKey,
      publicBaseUrl,
      accessPath,
      tokenTTLMs,
      verifiedEventAdapter: 'polling', // no PresentationVerified webhook wired for this Cloud Agent yet
      async resolveConnection(fromDid) {
        return resolveConnectionByDID(cloudAgentUrl, company.apiKey, fromDid);
      },
      resolveIssuerDID: createIssuerResolver({ cloudAgentUrl, apiKey: company.apiKey }),
      trustRegistry: employeeRoleTrustRegistry,
      capabilities: {
        [capabilityKey]: {
          label,
          icon: company.logo,
          mode: 'redirect',
          redirectPath,
          trustedIssuerVcType: 'EmployeeRole',
          proofSpec: makeEmployeePortalProofSpec(company.name, company.did),
        },
      },
    });

    return { id: company.id, company, service, capabilityKey };
  });

  const byId = new Map(entries.map((e) => [e.id, e]));

  function getService(id) {
    return byId.get(id)?.service;
  }

  // Tries each company's service in turn until one returns a truthy result — mirrors the
  // original `techcorpDIDComm.consumeGrant(key) ?? acmeDIDComm.consumeGrant(key)` chain, but
  // generalized to any number of companies.
  function consumeGrant(key) {
    for (const { service } of entries) {
      const result = service.consumeGrant(key);
      if (result) return result;
    }
    return null;
  }

  // Finds whichever company's service owns this access token — mirrors the original
  // `techcorpEntry = techcorpDIDComm.getToken(token); acmeEntry = ...` short-circuit chain.
  function getToken(token) {
    for (const { id, service } of entries) {
      const entry = service.getToken(token);
      if (entry) return { entry, companyId: id };
    }
    return null;
  }

  // Registers the DIDComm webhook for every company's service. Preserves the original boot-code
  // property that one company's registration failure doesn't abort the others (each call is
  // wrapped in its own catch, matching the `.catch(e => console.error(...))` pattern already
  // used for techcorpDIDComm/acmeDIDComm at server.js's boot sequence).
  function registerAllWebhooks(webhookUrlBuilder) {
    for (const { id, service } of entries) {
      const webhookUrl = webhookUrlBuilder(id);
      Promise.resolve()
        .then(() => service.registerWebhook(webhookUrl))
        .catch((e) => {
          console.error(`[DIDCommAccess] ${id} webhook registration error:`, e.message);
        });
    }
  }

  // Mounts one Express route per company's webhook handler, using the caller-supplied handler
  // factory (server.js's own `handleDIDCommWebhook(service, label)`). Label matches the original
  // hardcoded call sites, which passed the short company name ('TechCorp', 'ACME'), not the
  // longer displayName ('TechCorp Corporation').
  function mountAllWebhooks(app, handlerFactory) {
    for (const { id, company, service } of entries) {
      app.use(`/api/didcomm-webhook/${id}`, handlerFactory(service, company.name));
    }
  }

  return {
    entries,
    getService,
    consumeGrant,
    getToken,
    registerAllWebhooks,
    mountAllWebhooks,
  };
}

module.exports = { buildCompanyPortalRegistry };
