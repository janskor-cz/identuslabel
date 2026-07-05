'use strict';

/**
 * issuerResolver.js — resolves a PRISM DID's verification methods (public keys) for JWT-VC
 * signature verification.
 *
 * Extracted from identus-document-service/lib/DIDDocumentResolver.js's resolveIssuerDID —
 * that file mixed a document-specific resolver (resolveDocumentDID, reading DocumentMetadata/
 * DocumentAccessGate/IagonStorage service entries) with this generic one. Only the generic half
 * is shared here; document-service keeps resolveDocumentDID local to itself.
 *
 * Each service configures its own instance via createIssuerResolver({ cloudAgentUrl, apiKey }) —
 * this is deliberately NOT a singleton reading from one service's config module, since CA,
 * company-admin, and document-service each talk to their own Cloud Agent deployment.
 */

const fetch = require('node-fetch');

/**
 * @param {object} opts
 * @param {string} opts.cloudAgentUrl
 * @param {string} [opts.apiKey]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.cacheTtlMs]  default 60s, matches prior behavior
 * @returns {(issuerDID: string) => Promise<{verificationMethod: object[], assertionMethod: (string|object)[], authentication: (string|object)[]}>}
 */
function createIssuerResolver({ cloudAgentUrl, apiKey, timeoutMs = 15000, cacheTtlMs = 60_000 }) {
  const cache = new Map(); // issuerDID → { verificationMethod, assertionMethod, authentication, cachedAt }

  return async function resolveIssuerDID(issuerDID) {
    const now = Date.now();
    const cached = cache.get(issuerDID);
    if (cached && now - cached.cachedAt < cacheTtlMs) {
      return cached;
    }

    const url = `${cloudAgentUrl}/dids/${encodeURIComponent(issuerDID)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['apikey'] = apiKey;

    const response = await fetch(url, { method: 'GET', headers, timeout: timeoutMs });
    if (!response.ok) {
      throw new Error(`Issuer DID resolution failed (${response.status}) for: ${issuerDID}`);
    }

    const data   = await response.json();
    const didDoc = data.didDocument || data.did || data;

    const result = {
      verificationMethod: didDoc.verificationMethod || [],
      assertionMethod:    didDoc.assertionMethod    || [],
      authentication:     didDoc.authentication     || [],
      cachedAt: now
    };

    cache.set(issuerDID, result);
    return result;
  };
}

module.exports = { createIssuerResolver };
