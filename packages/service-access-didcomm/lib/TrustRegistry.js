'use strict';

/**
 * TrustRegistry.js — DID-keyed, capability/VC-type-scoped issuer trust list.
 *
 * Generalizes identus-document-service/lib/TrustRegistry.js's two hardcoded env-var branches
 * (TRUSTED_CA_DID for SecurityClearanceGrant, TRUSTED_COMPANY_ADMIN_DIDS for EmployeeRole) into a
 * declarative { did, vcTypes[] } table, so a new service/vcType pair is data, not a code branch.
 *
 * SECURITY FIX vs. the code this replaces: the original returned `true` ("open") for a vcType
 * with no configured issuers. That is a fail-OPEN default — an unconfigured deployment silently
 * trusted every issuer. This version fails CLOSED: no configured issuers for a vcType means no
 * issuer is trusted for it, and a loud warning is logged so misconfiguration is visible rather
 * than silently permissive.
 */

/**
 * Normalize a did:prism DID to its hash segment so short-form (as typically stored in config)
 * and long-form (as typically carried in a JWT's `iss` claim) compare equal — matching this
 * codebase's own documented `prismDidsMatch` convention (see server.js files' `_prismDidsMatch`
 * and CLAUDE.md's "PRISM DID format" note). Non-prism DIDs (did:peer, did:key, ...) are returned
 * unchanged — they don't have this short/long-form split.
 */
function normalizeDid(did) {
  return typeof did === 'string' && did.startsWith('did:prism:') ? did.split(':')[2] : did;
}

function createTrustRegistry(issuers = []) {
  // Build vcType → Map<normalized-did, original-did-string> for O(1) trust lookups while still
  // being able to return the DID in its originally-configured form (see getTrustedIssuers).
  const byVcType = new Map();
  for (const entry of issuers) {
    if (!entry || !entry.did || !Array.isArray(entry.vcTypes)) continue;
    for (const vcType of entry.vcTypes) {
      if (!byVcType.has(vcType)) byVcType.set(vcType, new Map());
      byVcType.get(vcType).set(normalizeDid(entry.did), entry.did);
    }
  }

  const warnedEmpty = new Set();

  function isTrustedIssuer(issuerDID, vcType) {
    if (!issuerDID || !vcType) return false;

    const trustedDids = byVcType.get(vcType);
    if (!trustedDids || trustedDids.size === 0) {
      if (!warnedEmpty.has(vcType)) {
        warnedEmpty.add(vcType);
        console.warn(
          `[TrustRegistry] No trusted issuers configured for vcType "${vcType}" — ` +
          `failing CLOSED (rejecting all issuers) for this VC type. If this is unexpected, ` +
          `add an entry to the trust registry config for this deployment.`
        );
      }
      return false; // fail closed — never silently trust an unconfigured vcType
    }

    return trustedDids.has(normalizeDid(issuerDID));
  }

  function getTrustedIssuers(vcType) {
    // Returned in their originally-configured form (not normalized) — these feed the Cloud
    // Agent proof-request's `trustIssuers` field, which expects that form, not a bare hash segment.
    const map = byVcType.get(vcType);
    return map ? Array.from(map.values()) : [];
  }

  return { isTrustedIssuer, getTrustedIssuers };
}

module.exports = { createTrustRegistry };
