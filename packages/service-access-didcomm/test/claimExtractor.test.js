'use strict';

const assert = require('assert');
const { extractClaims } = require('../lib/ClaimExtractor');

// EmployeeRole present → base claims + null clearance/cisTraining
{
  const result = extractClaims([
    { claims: { role: 'engineer', department: 'R&D', email: 'a@example.com', prismDid: 'did:prism:abc' } }
  ]);
  assert.deepStrictEqual(result, {
    role: 'engineer', department: 'R&D', email: 'a@example.com', prismDid: 'did:prism:abc',
    clearance: null, cisTraining: null
  });
}

// RealPerson fallback used when no EmployeeRole present — this is the exact branch
// company-admin-portal's forked _extractClaims silently dropped.
{
  const result = extractClaims([
    { claims: { uniqueId: 'u1', firstName: 'Ada', lastName: 'Lovelace' } }
  ]);
  assert.strictEqual(result.firstName, 'Ada');
  assert.strictEqual(result.lastName, 'Lovelace');
}

// EmployeeRole takes priority over RealPerson when both present in the same VP
{
  const result = extractClaims([
    { claims: { uniqueId: 'u1', firstName: 'Ada', lastName: 'Lovelace' } },
    { claims: { role: 'engineer', department: 'R&D' } }
  ]);
  assert.strictEqual(result.role, 'engineer', 'EmployeeRole (priority 0) must win over RealPerson (priority 1)');
}

// SecurityClearanceGrant → clearance bucket transform
{
  const result = extractClaims([
    { claims: { role: 'engineer', department: 'R&D' } },
    { claims: { clearanceLevel: 'SECRET' } }
  ]);
  assert.deepStrictEqual(result.clearance, { hasClearanceVC: true, level: 'SECRET' });
}

// CISTraining → derived hasValidTraining
{
  const future = new Date(Date.now() + 86400_000).toISOString();
  const result = extractClaims([
    { claims: { role: 'engineer', department: 'R&D' } },
    { claims: { trainingYear: 2026, certificateNumber: 'C-1', expiryDate: future } }
  ]);
  assert.strictEqual(result.cisTraining.hasValidTraining, true);

  const past = new Date(Date.now() - 86400_000).toISOString();
  const expired = extractClaims([
    { claims: { role: 'engineer', department: 'R&D' } },
    { claims: { trainingYear: 2020, certificateNumber: 'C-2', expiryDate: past } }
  ]);
  assert.strictEqual(expired.cisTraining.hasValidTraining, false);
}

// No base-eligible credential at all → null
{
  const result = extractClaims([{ claims: { clearanceLevel: 'SECRET' } }]);
  assert.strictEqual(result, null);
}

console.log('ClaimExtractor: all tests passed');
