/**
 * Test: Company-Agnostic Employee Onboarding
 *
 * Verifies that EmployeeWalletManager creates enterprise connections
 * under the correct company's API key (not hardcoded TechCorp).
 *
 * Tests:
 * 1. ACME employee wallet creation → connection owned by ACME at 8200
 * 2. Connection routes to 8300 enterprise endpoint
 * 3. SecurityClearanceGrant issuable via ACME's connection
 * 4. Credential accepted and stored in 8300
 *
 * Usage: node test-company-agnostic-onboarding.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const EmployeeWalletManager = require('./lib/EmployeeWalletManager');
const { COMPANIES } = require('./lib/companies');

const MULTITENANCY_URL = 'http://91.99.4.54:8200';
const ENTERPRISE_URL   = 'http://91.99.4.54:8300';
const ENTERPRISE_ADMIN = process.env.ENTERPRISE_ADMIN_TOKEN || '3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu';
const DB_PASS          = process.env.ENTERPRISE_DB_PASSWORD;

const ACME = COMPANIES.acme;
const TEST_EMAIL = `test.acme.${Date.now()}@acme.test`;

let pass = 0, fail = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    pass++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    fail++;
  }
}

async function cleanup(connectionId, entityId) {
  console.log('\n🧹 Cleaning up...');
  try {
    const pool = new Pool({ host: '91.99.4.54', port: 5434, database: 'pollux_enterprise', user: 'identus_enterprise', password: DB_PASS });
    const r = await pool.query('DELETE FROM employee_portal_accounts WHERE email=$1 RETURNING email', [TEST_EMAIL]);
    if (r.rows[0]) console.log(`  ✅ Removed DB record: ${r.rows[0].email}`);
    await pool.end();
  } catch (e) {
    console.warn(`  ⚠️  DB cleanup failed: ${e.message}`);
  }
}

async function run() {
  if (!DB_PASS) {
    console.error('ERROR: ENTERPRISE_DB_PASSWORD not set');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Test: Company-Agnostic Employee Onboarding');
  console.log(`  Company: ${ACME.displayName}`);
  console.log(`  Test email: ${TEST_EMAIL}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let wallet = null;

  // ── TEST 1: Create ACME employee wallet ──────────────────────────────
  console.log('Test 1: Create ACME employee wallet');
  try {
    wallet = await EmployeeWalletManager.createEmployeeWallet(
      { email: TEST_EMAIL, name: 'Test ACME Employee', department: 'Engineering' },
      ACME
    );
    assert(!!wallet.walletId,  'Wallet created with walletId');
    assert(!!wallet.entityId,  'Entity created with entityId');
    assert(!!wallet.prismDid,  'PRISM DID created');
    assert(!!wallet.techCorpConnectionId, 'Enterprise connection ID returned');
    console.log(`  Connection ID: ${wallet.techCorpConnectionId}`);
  } catch (e) {
    console.error(`  ❌ Wallet creation failed: ${e.message}`);
    fail++;
    await cleanup();
    process.exit(1);
  }

  // ── TEST 2: Connection exists under ACME's key (not TechCorp's) ──────
  console.log('\nTest 2: Connection owned by ACME at 8200');
  const connId = wallet.techCorpConnectionId;

  const acmeCheck = await fetch(`${MULTITENANCY_URL}/connections/${connId}`, {
    headers: { 'apikey': ACME.apiKey }
  });
  assert(acmeCheck.ok, `Connection ${connId} exists under ACME's key`);

  const techcorpCheck = await fetch(`${MULTITENANCY_URL}/connections/${connId}`, {
    headers: { 'apikey': COMPANIES.techcorp.apiKey }
  });
  assert(!techcorpCheck.ok, 'Connection NOT visible under TechCorp key');

  // ── TEST 3: Connection routes to 8300 enterprise endpoint ────────────
  console.log('\nTest 3: Connection routes to enterprise/didcomm (8300)');
  if (acmeCheck.ok) {
    const connData = await acmeCheck.json();
    const theirDid = connData.theirDid || '';
    // Decode service endpoint from peer DID
    let serviceUri = '';
    for (const part of theirDid.split('.')) {
      if (part.startsWith('S')) {
        try {
          const enc = part.slice(1) + '==';
          const decoded = JSON.parse(Buffer.from(enc, 'base64').toString());
          serviceUri = decoded?.s?.uri || decoded?.serviceEndpoint || '';
        } catch (_) {}
        break;
      }
    }
    assert(
      serviceUri.includes('enterprise/didcomm') || serviceUri.includes(':8300'),
      `theirDid routes to enterprise endpoint (got: ${serviceUri || 'unknown'})`
    );
    assert(connData.state === 'ConnectionResponseSent', `Connection state is ConnectionResponseSent (got: ${connData.state})`);
  }

  // ── TEST 4: Issue SecurityClearanceGrant via ACME's connection ────────
  console.log('\nTest 4: Issue SecurityClearanceGrant via ACME connection');

  // Get ACME's SecurityClearanceGrant schema
  const schemasResp = await fetch(`${MULTITENANCY_URL}/schema-registry/schemas?limit=100`, {
    headers: { 'apikey': ACME.apiKey }
  });
  let grantSchemaId = null;
  if (schemasResp.ok) {
    const schemas = await schemasResp.json();
    const grantSchema = (schemas.contents || []).find(s =>
      (s.name || s.id || '').includes('SecurityClearanceGrant')
    );
    if (grantSchema) grantSchemaId = `${MULTITENANCY_URL}/schema-registry/schemas/${grantSchema.guid}`;
  }
  assert(!!grantSchemaId, `SecurityClearanceGrant schema found for ACME (${grantSchemaId?.slice(-20)})`);

  let offerCreated = false;
  if (grantSchemaId) {
    const offerResp = await fetch(`${MULTITENANCY_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: { 'apikey': ACME.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: connId,
        credentialFormat: 'JWT',
        schemaId: grantSchemaId,
        issuingDID: ACME.did,
        automaticIssuance: true,
        claims: {
          credentialType: 'SecurityClearanceGrant',
          clearanceLevel: 'CONFIDENTIAL',
          holderDID: wallet.prismDid,
          issuerDID: ACME.did,
          grantedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 365*24*60*60*1000).toISOString()
        }
      })
    });
    offerCreated = offerResp.ok;
    assert(offerCreated, `Credential offer created via ACME key (status: ${offerResp.status})`);
    if (!offerCreated) console.error('  Offer error:', await offerResp.text());
  }

  // ── TEST 5: Credential arrives and is accepted at 8300 ─────────────
  console.log('\nTest 5: Credential accepted at 8300 enterprise wallet');
  if (offerCreated && wallet.entityId) {
    // Register temp key
    const tempKey = require('crypto').randomBytes(32).toString('hex');
    const regResp = await fetch(`${ENTERPRISE_URL}/iam/apikey-authentication`, {
      method: 'POST',
      headers: { 'x-admin-api-key': ENTERPRISE_ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId: wallet.entityId, apiKey: tempKey })
    });
    assert(regResp.ok, `Temp API key registered at 8300 (status: ${regResp.status})`);

    if (regResp.ok) {
      // Poll for OfferReceived
      let offerRecordId = null;
      console.log('  Polling for OfferReceived at 8300 (up to 20s)...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const recs = await fetch(`${ENTERPRISE_URL}/issue-credentials/records?limit=50`, {
          headers: { 'apikey': tempKey }
        });
        if (!recs.ok) continue;
        const data = await recs.json();
        const offer = (data.contents || []).find(r => r.protocolState === 'OfferReceived');
        if (offer) { offerRecordId = offer.recordId; break; }
      }
      assert(!!offerRecordId, `OfferReceived found at 8300 (recordId: ${offerRecordId})`);

      if (offerRecordId) {
        const acceptResp = await fetch(`${ENTERPRISE_URL}/issue-credentials/records/${offerRecordId}/accept-offer`, {
          method: 'POST',
          headers: { 'apikey': tempKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ subjectId: wallet.prismDid })
        });
        assert(acceptResp.ok, `accept-offer succeeded at 8300 (status: ${acceptResp.status})`);

        // Verify final state
        if (acceptResp.ok) {
          let finalState = null;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const rec = await fetch(`${ENTERPRISE_URL}/issue-credentials/records/${offerRecordId}`, {
              headers: { 'apikey': tempKey }
            });
            if (!rec.ok) continue;
            finalState = (await rec.json()).protocolState;
            if (finalState === 'CredentialReceived') break;
          }
          assert(finalState === 'CredentialReceived', `Final state is CredentialReceived (got: ${finalState})`);
        }
      }
    }
  } else if (!offerCreated) {
    console.log('  ⏭️  Skipped (offer not created)');
  }

  // ── Cleanup & Results ────────────────────────────────────────────────
  await cleanup(connId, wallet?.entityId);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
