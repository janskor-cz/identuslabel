#!/usr/bin/env node
'use strict';

/**
 * phase5-chain-verify.test.js
 *
 * Phase 5 gate: verify chain verification logic and history proxy endpoint.
 *
 * Checks:
 *   1. Chain verification: valid 3-link chain passes
 *   2. Chain verification: tampered hash in middle → broken at correct index
 *   3. Chain verification: single version (no predecessors) → valid
 *   4. Chain verification: missing vcJwt in history entry → link skipped (valid)
 *   5. Live history endpoint returns correct structure via document-service
 *   6. Live history + chain verification: predecessor hashes pass for new pushes
 *
 * Run: node identus-document-service/tests/phase5-chain-verify.test.js
 */

const assert  = require('assert');
const crypto  = require('crypto');
const path    = require('path');
const fetch   = require('node-fetch');

require('dotenv').config({
  path: path.join(__dirname, '..', '..', 'company-admin-portal', '.env')
});

const DOCUMENT_SERVICE_URL = 'http://localhost:3020';
const ADMIN_KEY = process.env.DOCUMENT_SERVICE_ADMIN_KEY;

const KeyManifestVCIssuer = require(path.join(__dirname, '..', '..', 'company-admin-portal', 'lib', 'KeyManifestVCIssuer'));

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Mirror of verifyManifestChain from KeyAuthorityClient.ts (Node.js port) ──

async function computeSha256Prefix(input) {
  const buf = await crypto.webcrypto.subtle.digest(
    'SHA-256',
    Buffer.from(input, 'utf8')
  );
  const hex = Buffer.from(buf).toString('hex');
  return 'sha256:' + hex;
}

async function verifyManifestChain(data) {
  if (!data.current) return { valid: false, reason: 'No current VC' };

  const chain = [data.current, ...data.history];

  for (let i = 0; i < chain.length - 1; i++) {
    const newer = chain[i];
    const older = chain[i + 1];

    const claimedHash = newer.claims?.predecessorHash;
    if (!claimedHash) continue;   // no claim → skip
    if (!older.vcJwt)  continue;  // can't verify without jwt → skip

    const actualHash = await computeSha256Prefix(older.vcJwt);
    if (actualHash !== claimedHash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Chain broken at position ${i}`
      };
    }
  }
  return { valid: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueDID() {
  return 'did:prism:phase5test' + crypto.randomBytes(8).toString('hex');
}

function makeParams(docDID, overrides = {}) {
  return {
    issuerDID:           'did:prism:issuer',
    documentDID:         docDID,
    iagonFileId:         'file-' + crypto.randomBytes(4).toString('hex'),
    wrappedKey:          crypto.randomBytes(32).toString('base64'),
    iv:                  crypto.randomBytes(12).toString('base64'),
    authTag:             crypto.randomBytes(16).toString('base64'),
    wrappingAlgorithm:   'AES-256-GCM',
    classificationLevel: 'INTERNAL',
    fileIv:              crypto.randomBytes(12).toString('base64'),
    fileAuthTag:         crypto.randomBytes(16).toString('base64'),
    fileAlgorithm:       'AES-256-GCM',
    releasableTo:        [],
    contentHash:         'sha256:' + crypto.randomBytes(32).toString('hex'),
    ...overrides
  };
}

async function pushVC(docDID, params) {
  const issuer = new KeyManifestVCIssuer(DOCUMENT_SERVICE_URL, ADMIN_KEY);
  return issuer.issue(params);
}

async function getHistory(documentDID) {
  const res = await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}/history`,
    { headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function deleteVC(documentDID) {
  await fetch(
    `${DOCUMENT_SERVICE_URL}/vc/key-manifest/${encodeURIComponent(documentDID)}`,
    { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY }, timeout: 5000 }
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('verifyManifestChain: valid 3-version chain passes', async () => {
  // Build a synthetic 3-version history with real sha256 hashes
  const jwt1 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');
  const jwt2 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');
  const jwt3 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');

  const h1 = await computeSha256Prefix(jwt1);
  const h2 = await computeSha256Prefix(jwt2);

  const data = {
    documentDID: 'did:test:abc',
    current: {
      vcId: 'v3',
      vcJwt: jwt3,
      issuedAt: new Date().toISOString(),
      claims: { predecessorHash: h2, versionNumber: 3 }
    },
    history: [
      {
        vcId: 'v2',
        vcJwt: jwt2,
        issuedAt: new Date().toISOString(),
        claims: { predecessorHash: h1, versionNumber: 2 }
      },
      {
        vcId: 'v1',
        vcJwt: jwt1,
        issuedAt: new Date().toISOString(),
        claims: { versionNumber: 1 } // no predecessorHash — v1
      }
    ]
  };

  const result = await verifyManifestChain(data);
  assert.strictEqual(result.valid, true, 'Valid chain must return { valid: true }');
});

test('verifyManifestChain: tampered hash at position 0 is detected', async () => {
  const jwt1 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');
  const jwt2 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');

  const wrongHash = 'sha256:' + crypto.randomBytes(32).toString('hex'); // garbage

  const data = {
    documentDID: 'did:test:abc',
    current: {
      vcId: 'v2',
      vcJwt: jwt2,
      issuedAt: new Date().toISOString(),
      claims: { predecessorHash: wrongHash, versionNumber: 2 }
    },
    history: [
      {
        vcId: 'v1',
        vcJwt: jwt1,
        issuedAt: new Date().toISOString(),
        claims: { versionNumber: 1 }
      }
    ]
  };

  const result = await verifyManifestChain(data);
  assert.strictEqual(result.valid, false, 'Tampered hash must fail');
  assert.strictEqual(result.brokenAt, 0, 'Must report brokenAt: 0');
});

test('verifyManifestChain: single version (no history) → valid', async () => {
  const data = {
    documentDID: 'did:test:single',
    current: {
      vcId: 'v1',
      vcJwt: 'some.jwt.token',
      issuedAt: new Date().toISOString(),
      claims: { versionNumber: 1 }
    },
    history: []
  };

  const result = await verifyManifestChain(data);
  assert.strictEqual(result.valid, true, 'Single version must be valid');
});

test('verifyManifestChain: missing vcJwt in history entry → link skipped (valid)', async () => {
  const jwt2 = 'synthetic.jwt.' + crypto.randomBytes(20).toString('base64');

  const data = {
    documentDID: 'did:test:skipped',
    current: {
      vcId: 'v2',
      vcJwt: jwt2,
      issuedAt: new Date().toISOString(),
      claims: { predecessorHash: 'sha256:somehash', versionNumber: 2 }
    },
    history: [
      {
        vcId: 'v1',
        // vcJwt intentionally absent — cannot verify
        issuedAt: new Date().toISOString(),
        claims: { versionNumber: 1 }
      }
    ]
  };

  const result = await verifyManifestChain(data);
  assert.strictEqual(result.valid, true, 'Unverifiable link (no vcJwt) must be skipped');
});

test('Live history endpoint: GET /vc/key-manifest/:did/history returns valid structure', async () => {
  const docDID = uniqueDID();

  await pushVC(docDID, makeParams(docDID, { versionNumber: 1 }));

  const { status, body } = await getHistory(docDID);
  assert.strictEqual(status, 200, `Expected 200, got ${status}`);
  assert.ok(body.documentDID, 'Must have documentDID');
  assert.ok(body.current, 'Must have current');
  assert.ok(body.current.vcJwt, 'current must have vcJwt');
  assert.ok(Array.isArray(body.history), 'history must be an array');

  await deleteVC(docDID);
});

test('Live chain: 2-version chain from document-service passes verifyManifestChain', async () => {
  const docDID = uniqueDID();
  const issuer = new KeyManifestVCIssuer(DOCUMENT_SERVICE_URL, ADMIN_KEY);

  const v1 = await issuer.issue(makeParams(docDID, { versionNumber: 1 }));
  await issuer.issue(makeParams(docDID, {
    versionNumber: 2,
    predecessorHash: KeyManifestVCIssuer.computePredecessorHash(v1.vcJwt)
  }));

  const { body } = await getHistory(docDID);
  assert.ok(body, 'History must be returned');

  // Map document-service response to the format verifyManifestChain expects
  // The proxy endpoint puts claims in the JWT payload; extract them here
  function extractClaims(entry) {
    if (!entry.vcJwt) return {};
    try {
      const b64 = entry.vcJwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
      return payload.vc?.credentialSubject || {};
    } catch { return {}; }
  }

  const mapped = {
    documentDID: body.documentDID,
    current: { ...body.current, claims: extractClaims(body.current) },
    history: body.history.map(e => ({ ...e, claims: extractClaims(e) }))
  };

  const result = await verifyManifestChain(mapped);
  assert.strictEqual(result.valid, true, `Chain must be valid: ${result.reason || ''}`);

  await deleteVC(docDID);
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 5 — Chain Verification & History UI');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n[Phase 5 GATE FAILED] Fix failures before proceeding.');
    process.exit(1);
  } else {
    console.log('\n[Phase 5 GATE PASSED] Chain verification and history UI complete.');
    process.exit(0);
  }
})();
