#!/usr/bin/env node
'use strict';

/**
 * register-service-tenants.js
 *
 * Phase 1 — Service Tenant Registration
 *
 * Creates or verifies a wallet + entity + API key + PRISM DID on the
 * multitenancy cloud agent for each internal service. This gives every
 * service its own SSI identity, which is the foundation for:
 *   Phase 2 — Asymmetric VC issuance (replace HMAC JWTs with Ed25519 VCs)
 *   Phase 3 — DIDComm service endpoints
 *   Phase 4 — Service-to-service DIDComm
 *
 * Usage:
 *   node scripts/register-service-tenants.js            # register all
 *   node scripts/register-service-tenants.js --verify   # verify existing
 *   node scripts/register-service-tenants.js --service document-service
 *
 * Prerequisites:
 *   MULTITENANCY_ADMIN_TOKEN env var (or edit ADMIN_TOKEN below).
 *   node-fetch v2: cd /opt/project_identuslabel && npm install node-fetch@2
 *
 * Run from repo root:
 *   node scripts/register-service-tenants.js
 */

const { default: fetch } = require('/opt/project_identuslabel/node_modules/node-fetch');
const crypto = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────────
const AGENT_URL    = process.env.MULTITENANCY_AGENT_URL || 'http://91.99.4.54:8200';
const ADMIN_TOKEN  = process.env.MULTITENANCY_ADMIN_TOKEN || 'N9TEJXrZlIX4Qg8R1RSlJwC820QZKwXb';
const ONLY_SERVICE = (() => {
  const idx = process.argv.indexOf('--service');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const VERIFY_ONLY = process.argv.includes('--verify');

// ── Already-registered identities (Phase 1, 2026-04-05) ───────────────────────
// If a service already has these credentials they are SKIPPED (idempotent).
// Update this table when re-running after a reset.
const EXISTING = {
  'document-service': {
    walletId:  '0f81c57d-bd64-4133-be53-3aaebe6137d9',
    entityId:  '87f8ae1d-9604-43cb-8ade-804723d52e74',
    apiKey:    '03b7ca7ae01e3c8439f0c37d8b6e37339227cdbd30b2aaa4676eacc55f95fabf',
    did:       'did:prism:19d62c0b38a3ecf011fc637acd6decbdf3e579a34087d0a2151de3cc1968455d',
  },
  'certification-authority': {
    walletId:  '20c400c0-f5a8-4b8b-b43c-a92f237730b3',
    entityId:  '7b70df78-0558-4db0-af37-5107174bc999',
    apiKey:    'de2360b873a9a04e4e6e60d185e10b659b0d4786cc3ffb5e134ed7aadeb87317',
    did:       'did:prism:929f673c458da7e3dd18170df30abf721887cad9bea4ccde6d16c680afc2278c',
  },
  'company-admin-portal': {
    walletId:  '9fca9469-f508-45e4-80e0-b187cee31d53',
    entityId:  '991f02fc-4bb7-4802-bf16-bab74df57631',
    apiKey:    'b926dde98ccecaa12096b9bee7d128433bd147b8f830bb825ec9929b80afb10e',
    did:       'did:prism:32751bea5985532bc17b0516c2a958c80107079a3fe8b834560cad693b79d108',
  },
};

// ── Service definitions ────────────────────────────────────────────────────────
const SERVICES = [
  {
    name:            'document-service',
    serviceEndpoint: 'https://identuslabel.cz/document-service',
  },
  {
    name:            'certification-authority',
    serviceEndpoint: 'https://identuslabel.cz/ca',
  },
  {
    name:            'company-admin-portal',
    serviceEndpoint: 'https://identuslabel.cz/company-admin',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────
function adminHeaders() {
  return { 'Content-Type': 'application/json', 'x-admin-api-key': ADMIN_TOKEN };
}
function serviceHeaders(apiKey) {
  return { 'Content-Type': 'application/json', 'apikey': apiKey };
}

async function apiCall(method, path, body, headers) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    method,
    headers: headers || adminHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}

async function createWallet(name) {
  const r = await apiCall('POST', '/wallets', { name });
  if (r.status !== 201 && r.status !== 200) throw new Error(`createWallet: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

async function createEntity(name, walletId) {
  const r = await apiCall('POST', '/iam/entities', { name, walletId });
  if (r.status !== 201 && r.status !== 200) throw new Error(`createEntity: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

async function registerApiKey(entityId, apiKey) {
  const r = await apiCall('POST', '/iam/apikey-authentication', { entityId, apiKey });
  if (r.status !== 201 && r.status !== 200) throw new Error(`registerApiKey: ${r.status} ${JSON.stringify(r.body)}`);
}

async function createDID(apiKey, serviceEndpoint, serviceName) {
  const r = await apiCall('POST', '/did-registrar/dids', {
    documentTemplate: {
      publicKeys: [
        { id: 'auth-key-1',      purpose: 'authentication' },
        { id: 'assertion-key-1', purpose: 'assertionMethod' },
      ],
      services: [
        {
          id:              `${serviceName}-endpoint`,
          type:            'LinkedDomains',
          serviceEndpoint: [serviceEndpoint],
        },
      ],
    },
  }, serviceHeaders(apiKey));
  if (r.status !== 201 && r.status !== 200) throw new Error(`createDID: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.longFormDid;
}

async function publishDID(apiKey, longFormDid) {
  const encoded = encodeURIComponent(longFormDid);
  const r = await apiCall('POST', `/did-registrar/dids/${encoded}/publications`, null, serviceHeaders(apiKey));
  if (r.status !== 202 && r.status !== 200 && r.status !== 201)
    throw new Error(`publishDID: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.scheduledOperation?.id;
}

async function verifyWallet(walletId) {
  const r = await apiCall('GET', `/wallets/${walletId}`);
  return r.status === 200;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(72));
  console.log('Service Tenant Registration — Multitenancy Cloud Agent');
  console.log(`Agent: ${AGENT_URL}`);
  if (VERIFY_ONLY) console.log('MODE: VERIFY ONLY');
  if (ONLY_SERVICE) console.log(`SCOPE: ${ONLY_SERVICE}`);
  console.log('='.repeat(72));

  const results = [];

  for (const svc of SERVICES) {
    if (ONLY_SERVICE && svc.name !== ONLY_SERVICE) continue;

    console.log(`\n── ${svc.name} ─────────────────────────────────────────────────`);

    const existing = EXISTING[svc.name];

    if (existing) {
      // Verify mode: just confirm wallet exists
      const ok = await verifyWallet(existing.walletId);
      console.log(`  Wallet ${existing.walletId}: ${ok ? '✅ OK' : '❌ NOT FOUND'}`);
      console.log(`  Entity: ${existing.entityId}`);
      console.log(`  DID:    ${existing.did}`);
      results.push({ service: svc.name, status: ok ? 'verified' : 'wallet-missing', ...existing });
      continue;
    }

    if (VERIFY_ONLY) {
      console.log('  ⏩ No existing credentials — skipping in verify mode');
      continue;
    }

    try {
      // 1. Wallet
      console.log('  Creating wallet...');
      const walletId = await createWallet(svc.name);
      console.log(`  Wallet ID: ${walletId}`);

      // 2. Entity
      console.log('  Creating entity...');
      const entityId = await createEntity(svc.name, walletId);
      console.log(`  Entity ID: ${entityId}`);

      // 3. API key
      const apiKey = crypto.randomBytes(32).toString('hex');
      console.log('  Registering API key...');
      await registerApiKey(entityId, apiKey);
      console.log(`  API Key: ${apiKey}`);

      // 4. DID
      console.log('  Creating DID...');
      const longFormDid = await createDID(apiKey, svc.serviceEndpoint, svc.name);
      const shortDid = longFormDid.split(':').slice(0, 3).join(':');
      console.log(`  DID (short): ${shortDid}`);
      console.log(`  DID (long):  ${longFormDid}`);

      // 5. Publish
      console.log('  Publishing DID...');
      const opId = await publishDID(apiKey, longFormDid);
      console.log(`  Publication op: ${opId}`);

      const creds = { walletId, entityId, apiKey, did: shortDid, longFormDid };
      results.push({ service: svc.name, status: 'created', ...creds });

      // Print env block
      console.log('\n  ── .env snippet ──────────────────────────────────────────');
      console.log(`  SERVICE_WALLET_ID=${walletId}`);
      console.log(`  SERVICE_ENTITY_ID=${entityId}`);
      console.log(`  SERVICE_API_KEY=${apiKey}`);
      console.log(`  SERVICE_DID=${shortDid}`);
      console.log(`  SERVICE_DID_LONG=${longFormDid}`);
    } catch (err) {
      console.error(`  ❌ FAILED: ${err.message}`);
      results.push({ service: svc.name, status: 'failed', error: err.message });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(72));
  console.log('Summary');
  for (const r of results) {
    const icon = r.status === 'created' ? '✅' : r.status === 'verified' ? '✅' : r.status === 'wallet-missing' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${r.service}: ${r.status}`);
  }
  console.log('='.repeat(72));

  const hasFailed = results.some(r => r.status === 'failed' || r.status === 'wallet-missing');
  if (hasFailed) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
