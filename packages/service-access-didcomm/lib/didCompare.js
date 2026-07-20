'use strict';

/**
 * didCompare.js — DID comparison helpers shared by this package's holder-binding checks.
 *
 * `prismDidsMatch` mirrors the hash-segment-only comparison this codebase already uses in
 * company-admin-portal/server.js (`prismDidsMatch`), identus-document-service/lib/
 * DocumentDIDCommService.js and identus-document-service/server.js's `/access` handler (both as
 * local `hashOf`/`prismHash` helpers) — short-form (`did:prism:<hash>`) and long-form
 * (`did:prism:<hash>:<key-material>`) DIDs for the same identity must compare equal (see
 * CLAUDE.md's "PRISM DID format" note: DBs store short-form, JWT `sub`/`iss` carry long-form).
 * Factored here so this package's own `verifyPresentation.js` doesn't need to inline yet another
 * copy of the same string comparison.
 *
 * Two non-`did:prism:` DIDs only match via the `a === b` exact-string fast path above — the
 * hash-segment tolerance below is did:prism-specific (long-form vs short-form only exists for
 * that method), so genuinely different DIDs of any other method never match, by design. In
 * practice this package's holder-binding check always compares a VC's `credentialSubject.id`/
 * `sub` against a VP's `iss`, and both are did:prism DIDs in every issuance/presentation path
 * verified in this deployment (see clean-identus-wallet/sdk-v6-test/sdk-ts's
 * CreatePresentation.ts — the wallet always signs a JWT-VP presentation with the credential
 * SUBJECT's DID, i.e. `Domain.DID.from(credential.subject)`, which is did:prism — never with the
 * DIDComm connection's own did:peer:2 peer DID; confirmed empirically for the enterprise/
 * multitenancy-agent-issued credential path too — every sampled issued JWT-VC's `sub` equals its
 * own `credentialSubject.id`, both real did:prism DIDs, regardless of credential type).
 */
function prismDidsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const hashOf = did => (typeof did === 'string' && did.startsWith('did:prism:')) ? did.split(':')[2] : null;
  const ha = hashOf(a);
  const hb = hashOf(b);
  return !!(ha && hb && ha === hb);
}

module.exports = { prismDidsMatch };
