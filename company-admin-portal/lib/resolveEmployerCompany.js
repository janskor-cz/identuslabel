/**
 * Resolve Employer Company
 *
 * Employee-portal credential issuance (CIS Training certificates, SecurityClearanceGrant
 * VCs) must be issued from the employee's *own* employer's tenant wallet/apiKey on the
 * multitenancy Cloud Agent (port 8200) — each company has an isolated wallet/apiKey/DID
 * there (see lib/companies.js). Issuing with the wrong tenant's apiKey against a
 * connectionId that actually lives on a different tenant's wallet fails with
 * `Cloud Agent error (404): RecordIdNotFound`, because that connection simply doesn't
 * exist in the wrong tenant's view.
 *
 * Every employee session stores `issuerDID` — the employer's PRISM DID, captured either
 * by the DIDComm access-request flow or the legacy presentation-auth flow. This helper
 * maps that DID back to the owning company config, tolerant of long-form vs short-form
 * PRISM DID differences (see `prismDidsMatch` below).
 */

const { getAllCompanies, getCompany } = require('./companies');

// Compare PRISM DIDs tolerating long-form vs short-form differences.
// Short-form: did:prism:<hash>
// Long-form:  did:prism:<hash>:<base64-key-material>
// One of the two may be short-form; match if the hash segments are equal.
//
// Kept in sync with the equivalent `prismDidsMatch` defined in server.js — duplicated
// here (rather than imported) to avoid a require() cycle back into server.js.
function prismDidsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const hashOf = did => did.startsWith('did:prism:') ? did.split(':')[2] : null;
  const ha = hashOf(a), hb = hashOf(b);
  return ha && hb && ha === hb;
}

const DEFAULT_FALLBACK_COMPANY_ID = 'techcorp';

/**
 * Resolve the company that employs the holder of an employee session, based on the
 * session's `issuerDID` (the employer's PRISM DID).
 *
 * @param {string|null|undefined} issuerDID - session.issuerDID
 * @param {object} [options]
 * @param {string} [options.fallbackCompanyId='techcorp'] - company id to use when issuerDID
 *   is missing or matches no known company (legacy sessions predating issuerDID storage).
 * @param {Array<object>} [options.companies] - injectable company list, for testing without
 *   depending on the real lib/companies.js data. Defaults to getAllCompanies().
 * @returns {object|null} the matching company object, the fallback company object, or
 *   null if even the fallback company id doesn't exist.
 */
function resolveEmployerCompany(issuerDID, options = {}) {
  const fallbackCompanyId = options.fallbackCompanyId || DEFAULT_FALLBACK_COMPANY_ID;
  const companies = options.companies || getAllCompanies();
  const match = issuerDID
    ? companies.find(c => prismDidsMatch(c.did, issuerDID))
    : null;
  return match || companies.find(c => c.id === fallbackCompanyId) || getCompany(fallbackCompanyId);
}

module.exports = { resolveEmployerCompany, prismDidsMatch };
