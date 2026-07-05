'use strict';

/**
 * ClaimExtractor.js — declarative VC-claim extraction, replacing the hand-duplicated
 * field-shape sniffing that existed independently in:
 *   - certification-authority/lib/DIDCommCommandService.js `_extractClaims`
 *   - identus-document-service/lib/VPVerificationService.js `isEmployeeRoleCred`/`isSecurityClearanceCred`
 *
 * Both did the same kind of "does this credentialSubject have these fields" matching, by hand,
 * with independent copies drifting apart (company-admin-portal's fork of the CA version silently
 * dropped the RealPerson fallback branch entirely). One rule table now drives both.
 */

// Default rule set, reproducing the union of what both prior implementations recognized.
// A service may pass its own subset/superset via the capability descriptor's `claimRules`.
const DEFAULT_CLAIM_RULES = [
  { vcType: 'EmployeeRole',          match: ['role', 'department'],                bucket: 'base', priority: 0 },
  { vcType: 'RealPerson',            match: ['uniqueId', 'firstName', 'lastName'], bucket: 'base', priority: 1 },
  { vcType: 'SecurityClearanceGrant', match: ['clearanceLevel'],                   bucket: 'clearance', transform: 'clearanceGrant' },
  { vcType: 'CISTraining',           match: ['trainingYear', 'certificateNumber'], bucket: 'cisTraining', transform: 'trainingStatus' },
];

// Named transforms for the few places the prior code computed a derived field rather than
// passing claims through raw (e.g. CISTraining's expiry check,
// DIDCommCommandService.js's original `_extractClaims`).
const TRANSFORMS = {
  clearanceGrant(claims) {
    return { hasClearanceVC: true, level: claims.clearanceLevel };
  },
  trainingStatus(claims) {
    const expiry = claims.expiryDate ? new Date(claims.expiryDate) : null;
    return {
      hasValidTraining: expiry ? expiry > new Date() : true,
      expiryDate:       claims.expiryDate || null,
      completionDate:   claims.completionDate || null,
      certificateNumber: claims.certificateNumber || null
    };
  }
};

function matchesRule(claims, rule) {
  return rule.match.every(field => claims[field] !== undefined);
}

/**
 * Classify a single credential's claims against the rule table, returning the first matching
 * rule (or null). Used to find which verified credential's issuer corresponds to a capability's
 * `trustedIssuerVcType`, since trust must be checked against the specific credential that
 * asserted that vcType — not the merged claims object.
 */
function classifyCredential(claims, rules = DEFAULT_CLAIM_RULES) {
  if (!claims) return null;
  for (const rule of rules) {
    if (matchesRule(claims, rule)) return rule;
  }
  return null;
}

/**
 * @param {Array<{ claims: object }>} credentials  verified credentials (see verifyPresentation.js)
 * @param {Array} [rules]  defaults to DEFAULT_CLAIM_RULES
 * @returns {object|null}  merged claims object, or null if no `base` bucket rule matched (i.e.
 *                          no EmployeeRole/RealPerson-equivalent credential was present)
 */
function extractClaims(credentials, rules = DEFAULT_CLAIM_RULES) {
  let baseMatch = null; // { claims, priority }
  // Default every non-base bucket to null so the shape is stable regardless of which
  // credentials were actually presented — matches the original _extractClaims's
  // `{ ...base, cisTraining: cisTraining ?? null, clearance: clearance ?? null }`.
  const buckets = {};
  for (const rule of rules) {
    if (rule.bucket !== 'base') buckets[rule.bucket] = null;
  }

  for (const { claims } of credentials) {
    if (!claims) continue;

    for (const rule of rules) {
      if (!matchesRule(claims, rule)) continue;

      const value = rule.transform ? TRANSFORMS[rule.transform](claims) : claims;

      if (rule.bucket === 'base') {
        const priority = rule.priority ?? 0;
        if (!baseMatch || priority < baseMatch.priority) {
          baseMatch = { claims: value, priority };
        }
      } else {
        buckets[rule.bucket] = value;
      }
      break; // first matching rule per credential wins — same as prior hand-written if/else chain
    }
  }

  if (!baseMatch) return null;

  return { ...baseMatch.claims, ...buckets };
}

module.exports = { extractClaims, classifyCredential, DEFAULT_CLAIM_RULES, TRANSFORMS };
