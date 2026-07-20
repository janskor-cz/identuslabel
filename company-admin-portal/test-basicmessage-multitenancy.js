'use strict';

/**
 * Test: BasicMessage between two tenants on multi-tenant cloud agent (port 8200).
 *
 * Prerequisites:
 *   - Multi-tenant agent running at 91.99.4.54:8200 with basicmsg image
 *   - Agent configured: WEBHOOK_URL=http://91.99.4.54:3010/api/multitenancy-test-webhook
 *   - Company-admin portal running at port 3010 (with /api/multitenancy-test-webhook endpoints)
 *
 * Flow:
 *   1. Clear previous test events
 *   2. TechCorp creates an OOB connection invitation
 *   3. ACME accepts the invitation → connection established
 *   4. Poll until connection ACTIVE on both tenants
 *   5. TechCorp sends a BasicMessage to ACME
 *   6. Poll company-admin webhook store for BasicMessageReceived event
 *   7. Assert content matches → PASS or FAIL
 */

const http = require('http');
const crypto = require('crypto');

const AGENT   = 'http://91.99.4.54:8200';
const PORTAL  = 'http://localhost:3010';

const TECHCORP_KEY = 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const ACME_KEY     = 'a5b2c19cd9cfe9ff0b9f7bacfdc9d097ae02074b3ef7b03981a8d837c0d0a784';

// ─── Helpers ────────────────────────────────────────────────────────────────

function httpRequest(url, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body !== null ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${url} → ${res.statusCode}: ${data.slice(0, 300)}`));
        } else {
          resolve(data ? JSON.parse(data) : {});
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function agentRequest(apiKey, path, method = 'GET', body = null) {
  return httpRequest(`${AGENT}${path}`, method, { apikey: apiKey }, body);
}

function portalRequest(path, method = 'GET', body = null) {
  return httpRequest(`${PORTAL}${path}`, method, {}, body);
}

async function pollUntil(label, fn, check, timeoutMs = 40000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (check(result)) return result;
    process.stdout.write(`  ⏳ ${label} (${Math.ceil((deadline - Date.now()) / 1000)}s left)...\n`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪 BasicMessage multi-tenancy test\n');
  let passed = false;

  try {
    // 1. Clear previous test events
    await portalRequest('/api/multitenancy-test-webhook/events', 'DELETE');
    const startTime = Date.now();
    console.log('[1] Previous test events cleared');

    // 2. TechCorp creates OOB invitation
    const inv = await agentRequest(TECHCORP_KEY, '/connections', 'POST', { label: 'test-basicmsg' });
    const invitationUrl = inv.invitation?.invitationUrl || inv.invitationUrl;
    if (!invitationUrl) throw new Error(`No invitationUrl: ${JSON.stringify(inv).slice(0, 200)}`);
    const techCorpConnId = inv.connectionId;
    console.log(`[2] TechCorp invitation created (connectionId=${techCorpConnId})`);

    // 3. ACME accepts invitation — extract base64 _oob param from invitationUrl
    const oobParam = new URL(invitationUrl).searchParams.get('_oob');
    if (!oobParam) throw new Error(`No _oob param in invitationUrl: ${invitationUrl}`);
    const accepted = await agentRequest(ACME_KEY, '/connection-invitations', 'POST', { invitation: oobParam });
    const acmeConnId = accepted.connectionId;
    if (!acmeConnId) throw new Error(`No connectionId in acceptance: ${JSON.stringify(accepted).slice(0, 200)}`);
    console.log(`[3] ACME accepted invitation (connectionId=${acmeConnId})`);

    // 4a. Wait for ACME connection to be active
    const acmeConn = await pollUntil(
      'ACME connection active',
      () => agentRequest(ACME_KEY, `/connections/${acmeConnId}`),
      (c) => ['ConnectionResponseReceived', 'ACTIVE', 'active'].includes(c.state),
    );
    console.log(`[4a] ACME connection active (myDid=${acmeConn.myDid}, state=${acmeConn.state})`);

    // 4b. Wait for TechCorp's side to be active
    // Inviter final states: ConnectionResponseSent (they sent response after receiving request)
    // Invitee final states: ConnectionResponseReceived
    const techCorpConn = await pollUntil(
      'TechCorp connection active',
      () => agentRequest(TECHCORP_KEY, `/connections/${techCorpConnId}`),
      (c) => ['ConnectionResponseSent', 'ConnectionResponseReceived', 'ACTIVE', 'active'].includes(c.state),
    );
    console.log(`[4b] TechCorp connection active (theirDid=${techCorpConn.theirDid}, state=${techCorpConn.state})`);

    // 5. TechCorp sends BasicMessage
    const testContent = `hello-from-techcorp-${crypto.randomUUID()}`;
    await agentRequest(TECHCORP_KEY, `/connections/${techCorpConnId}/basic-messages`, 'POST', {
      content: testContent,
    });
    console.log(`[5] BasicMessage sent: "${testContent}"`);

    // 6. Poll company-admin portal webhook store for BasicMessageReceived event
    console.log('[6] Polling for webhook event on company-admin portal...');
    const eventsResponse = await pollUntil(
      'BasicMessageReceived event',
      async () => {
        const r = await portalRequest(`/api/multitenancy-test-webhook/events?since=${startTime}`);
        return r;
      },
      (r) => {
        const events = r.events || [];
        return events.some(e =>
          e.type === 'BasicMessageReceived' &&
          (e.data?.content?.includes(testContent) || JSON.stringify(e).includes(testContent))
        );
      },
      20000,
      1000,
    );

    const matchingEvent = (eventsResponse.events || []).find(e =>
      e.type === 'BasicMessageReceived' &&
      (e.data?.content?.includes(testContent) || JSON.stringify(e).includes(testContent))
    );

    console.log(`[6] Webhook event received!`);
    console.log(`    Event: ${JSON.stringify(matchingEvent).slice(0, 400)}`);

    console.log(`\n✅ PASS: BasicMessage successfully delivered via multi-tenant cloud agent`);
    console.log(`   Sent:     "${testContent}"`);
    console.log(`   walletId: ${matchingEvent?.walletId || 'n/a'}`);
    console.log(`   connId:   ${matchingEvent?.data?.connectionId || 'n/a'}\n`);
    passed = true;

  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message}\n`);
    process.exitCode = 1;
  }

  if (!passed && process.exitCode !== 1) process.exitCode = 1;
}

main();
