'use strict';

const assert = require('assert');
const { createTrustRegistry } = require('../lib/TrustRegistry');

// Fails closed when no issuers configured at all
{
  const reg = createTrustRegistry([]);
  assert.strictEqual(reg.isTrustedIssuer('did:prism:anyone', 'SecurityClearanceGrant'), false,
    'unconfigured vcType must fail closed, not trust everyone');
  assert.deepStrictEqual(reg.getTrustedIssuers('SecurityClearanceGrant'), []);
}

// Trusts only DIDs explicitly configured for the matching vcType
{
  const reg = createTrustRegistry([
    { did: 'did:prism:ca', vcTypes: ['SecurityClearanceGrant', 'RealPerson'] },
    { did: 'did:prism:admin1', vcTypes: ['EmployeeRole'] },
    { did: 'did:prism:admin2', vcTypes: ['EmployeeRole'] },
  ]);

  assert.strictEqual(reg.isTrustedIssuer('did:prism:ca', 'SecurityClearanceGrant'), true);
  assert.strictEqual(reg.isTrustedIssuer('did:prism:ca', 'EmployeeRole'), false, 'CA DID not trusted for EmployeeRole');
  assert.strictEqual(reg.isTrustedIssuer('did:prism:admin1', 'EmployeeRole'), true);
  assert.strictEqual(reg.isTrustedIssuer('did:prism:attacker', 'EmployeeRole'), false);
  assert.strictEqual(reg.isTrustedIssuer(null, 'EmployeeRole'), false);
  assert.strictEqual(reg.isTrustedIssuer('did:prism:admin1', null), false);

  assert.deepStrictEqual(
    new Set(reg.getTrustedIssuers('EmployeeRole')),
    new Set(['did:prism:admin1', 'did:prism:admin2'])
  );
}

// Short-form (config) vs long-form (JWT `iss` claim) DID comparison — matches this codebase's
// documented prismDidsMatch convention (hash-segment-only comparison for did:prism DIDs).
{
  const shortForm = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';
  const longForm = shortForm + ':Co4CCosCEj4KCmF1dGgta2V5LTEQBEouCglzZWNwMjU2azESIQOtdk47gktIBvwPkAYQuTdyUHYIA0NWs9mYkoglI5yHwQ';

  const reg = createTrustRegistry([{ did: shortForm, vcTypes: ['EmployeeRole'] }]);
  assert.strictEqual(reg.isTrustedIssuer(longForm, 'EmployeeRole'), true,
    'long-form issuer DID (as typically seen in a JWT iss claim) must match a short-form config entry');
  assert.strictEqual(reg.isTrustedIssuer(shortForm, 'EmployeeRole'), true);

  // getTrustedIssuers returns the originally-configured form, not the normalized hash — this
  // feeds the Cloud Agent proof-request's trustIssuers field, which expects that form.
  assert.deepStrictEqual(reg.getTrustedIssuers('EmployeeRole'), [shortForm]);

  // Non-prism DIDs are compared as-is (no hash-segment split applies).
  const peerReg = createTrustRegistry([{ did: 'did:peer:2.abc', vcTypes: ['ServiceAccess'] }]);
  assert.strictEqual(peerReg.isTrustedIssuer('did:peer:2.abc', 'ServiceAccess'), true);
  assert.strictEqual(peerReg.isTrustedIssuer('did:peer:2.xyz', 'ServiceAccess'), false);
}

console.log('TrustRegistry: all tests passed');
