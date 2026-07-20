/**
 * Resolve Document Access Tenant
 *
 * Same bug class as lib/resolveEmployerCompany.js, in a different flow: the "document-access
 * DIDComm gate" (POST /api/document-access/initiate and /complete in server.js) hardcoded
 * TECHCORP_CLOUD_AGENT_URL/TECHCORP_API_KEY when creating and fetching a present-proof
 * presentation against a DIDComm connectionId — regardless of which company's tenant wallet
 * that connectionId actually lives on. Each company has an isolated wallet/apiKey on the shared
 * multitenancy Cloud Agent (see lib/companies.js), so a present-proof request created with the
 * wrong tenant's apiKey against a connectionId that belongs to a different tenant fails, since
 * each tenant only sees its own connections.
 *
 * /initiate resolves connectionId via up to three strategies (see server.js), only one of which
 * carries any tenant information:
 *   - Strategy 1 (in-memory mapping file, data/employee-connection-mappings.json): each entry
 *     carries a hand-maintained `company` display label (e.g. "TechCorp") alongside the
 *     connectionId. `resolveCompanyByLabel` maps that label back to a real company object.
 *   - Strategy 2/3 (EmployeePortalDatabase lookup by email/PRISM DID): the `techcorp_connection_id`
 *     column carries no tenant/company information at all (legacy single-tenant schema, never
 *     extended for multi-company use) — there is genuinely no way to know the tenant from the DB
 *     row alone. `findTenantForConnectionId` resolves it by trying each company's apiKey against
 *     the Cloud Agent's connection-lookup endpoint in turn, mirroring the same "try each tenant
 *     until one matches" pattern already used by lib/companyPortalRegistry.js's
 *     consumeGrant/getToken and server.js's resolveConnectionByDID.
 *
 * `resolveDocumentAccessTenant` ties both together: prefer the mapping-file label when present,
 * and fall back to the try-each-tenant probe (covering both the Strategy 2/3 case, and the case
 * where a mapping-file label fails to match any known company). If nothing resolves, callers
 * must fail closed (404) rather than defaulting to techcorp.
 */

const { getAllCompanies } = require('./companies');

/**
 * Resolve a company from a hand-maintained display label (e.g. the `company` field on a
 * data/employee-connection-mappings.json entry, such as "TechCorp"). Matches case-insensitively
 * against either `company.name` (short form, e.g. "TechCorp") or `company.displayName`
 * (long form, e.g. "TechCorp Corporation"), since the mapping file is hand-maintained and isn't
 * guaranteed to match either field verbatim.
 *
 * @param {string|null|undefined} label
 * @param {object} [options]
 * @param {Array<object>} [options.companies] - injectable company list; defaults to getAllCompanies()
 * @returns {object|null} matching company object, or null if no company matches
 */
function resolveCompanyByLabel(label, options = {}) {
  if (!label || typeof label !== 'string') return null;
  const companies = options.companies || getAllCompanies();
  const needle = label.trim().toLowerCase();
  if (!needle) return null;
  return (
    companies.find(
      (c) =>
        (c.name && c.name.toLowerCase() === needle) ||
        (c.displayName && c.displayName.toLowerCase() === needle)
    ) || null
  );
}

/**
 * Find which company's tenant wallet owns a given DIDComm connectionId, by trying each
 * company's apiKey against the Cloud Agent's connection-lookup endpoint until one succeeds.
 * Injectable `fetchImpl` so this is unit-testable without a real network call.
 *
 * @param {string} connectionId
 * @param {object} [options]
 * @param {Array<object>} [options.companies] - injectable company list; defaults to getAllCompanies()
 * @param {string} [options.cloudAgentUrl] - Cloud Agent base URL; defaults to MULTITENANCY_CLOUD_AGENT_URL
 * @param {Function} [options.fetchImpl] - fetch-compatible function; defaults to global fetch
 * @returns {Promise<object|null>} the owning company object, or null if no tenant recognizes it
 */
async function findTenantForConnectionId(connectionId, options = {}) {
  if (!connectionId) return null;
  const companies = options.companies || getAllCompanies();
  const cloudAgentUrl =
    options.cloudAgentUrl || require('./companies').MULTITENANCY_CLOUD_AGENT_URL;
  const fetchImpl = options.fetchImpl || global.fetch;

  for (const company of companies) {
    try {
      const resp = await fetchImpl(`${cloudAgentUrl}/connections/${connectionId}`, {
        headers: { apikey: company.apiKey },
      });
      if (resp && resp.ok) return company;
    } catch (e) {
      // Network/tenant error trying this company — keep trying the rest.
      continue;
    }
  }
  return null;
}

/**
 * Resolve the tenant company that owns a document-access DIDComm connection, given whatever
 * tenant hints are available. Prefers the mapping-file label (Strategy 1); falls back to
 * probing each tenant by connectionId (Strategy 2/3, or a Strategy-1 label that didn't match
 * any known company).
 *
 * @param {object} params
 * @param {string} params.connectionId
 * @param {string|null|undefined} [params.mappingCompanyLabel] - the `company` field from a
 *   Strategy-1 mapping-file entry, if that's how connectionId was found
 * @param {Array<object>} [params.companies]
 * @param {string} [params.cloudAgentUrl]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<object|null>} the resolved company object, or null if unresolved (caller
 *   must fail closed)
 */
async function resolveDocumentAccessTenant({
  connectionId,
  mappingCompanyLabel,
  companies,
  cloudAgentUrl,
  fetchImpl,
} = {}) {
  const byLabel = resolveCompanyByLabel(mappingCompanyLabel, { companies });
  if (byLabel) return byLabel;

  return findTenantForConnectionId(connectionId, { companies, cloudAgentUrl, fetchImpl });
}

module.exports = {
  resolveCompanyByLabel,
  findTenantForConnectionId,
  resolveDocumentAccessTenant,
};
