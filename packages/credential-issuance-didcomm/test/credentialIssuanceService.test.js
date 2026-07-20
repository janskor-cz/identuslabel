'use strict';

/**
 * Integration test for CredentialIssuanceService against a tiny in-process fake Cloud Agent
 * (real HTTP server, no mocking of node-fetch) — exercises the request → fields-required →
 * data-submit → issue round trip, plus the error paths (unknown capability, validation failure,
 * duplicate submit, issuance failure, redelivered message id).
 */

const assert = require('assert');
const http = require('http');

const { CredentialIssuanceService, PROTOCOL_PREFIX } = require('../lib/CredentialIssuanceService');

async function run() {
  const sentMessages = []; // { connectionId, envelope }

  const fakeAgent = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const match = req.url.match(/^\/connections\/([^/]+)\/basic-messages$/);
      if (req.method === 'POST' && match) {
        const parsed = JSON.parse(body);
        sentMessages.push({ connectionId: match[1], envelope: JSON.parse(parsed.content) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise(resolve => fakeAgent.listen(0, resolve));
  const port = fakeAgent.address().port;

  const connectionId = 'conn-holder-1';
  const holderDid = 'did:peer:2.holder';

  let issueCalls = [];
  const service = new CredentialIssuanceService({
    cloudAgentUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    resolveConnection: async (fromDid) => (fromDid === holderDid ? connectionId : null),
    capabilities: {
      realperson: {
        schemaName: 'RealPerson',
        schemaVersion: '4.0.0',
        fields: [
          { key: 'firstName', label: 'First name', type: 'string', required: true },
          { key: 'lastName', label: 'Last name', type: 'string', required: true },
          { key: 'dateOfBirth', label: 'Date of birth', type: 'date', required: true },
        ],
        issue: async ({ connectionId, values }) => {
          issueCalls.push({ connectionId, values });
          if (values.firstName === 'Boom') throw new Error('simulated issuance failure');
          return { recordId: 'rec-1' };
        },
      },
    },
  });

  // ── 1. Happy path: request → fields-required → data-submit → issue() called, no error sent ──
  const reqId1 = 'req-1';
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: reqId1, body: { capability: 'realperson' }
  }));

  assert.strictEqual(sentMessages.length, 1, 'fields-required should have been sent');
  const fieldsMsg = sentMessages[0].envelope;
  assert.strictEqual(fieldsMsg.type, `${PROTOCOL_PREFIX}/fields-required`);
  assert.strictEqual(fieldsMsg.thid, reqId1);
  assert.strictEqual(fieldsMsg.body.schemaName, 'RealPerson');
  assert.strictEqual(fieldsMsg.body.fields.length, 3);

  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-1', thid: reqId1,
    body: { capability: 'realperson', values: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' } }
  }));

  assert.strictEqual(issueCalls.length, 1, 'issue() should have been called once');
  assert.strictEqual(issueCalls[0].values.firstName, 'Ada');
  assert.strictEqual(sentMessages.length, 1, 'no error message should be sent on success');
  console.log('✓ happy path issues via issue() and sends no error');

  // ── 2. Duplicate data-submit for the same thid ──────────────────────────────────────────────
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-1-retry', thid: reqId1,
    body: { capability: 'realperson', values: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' } }
  }));
  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[1].envelope.body.error, 'DUPLICATE_REQUEST');
  assert.strictEqual(issueCalls.length, 1, 'issue() should not be called again');
  console.log('✓ duplicate data-submit rejected without re-issuing');

  // ── 3. Unknown capability ────────────────────────────────────────────────────────────────────
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: 'req-unknown', body: { capability: 'nope' }
  }));
  assert.strictEqual(sentMessages.length, 3);
  assert.strictEqual(sentMessages[2].envelope.body.error, 'UNKNOWN_CAPABILITY');
  console.log('✓ unknown capability rejected');

  // ── 4. Missing required field ────────────────────────────────────────────────────────────────
  const reqId2 = 'req-2';
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: reqId2, body: { capability: 'realperson' }
  }));
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-2', thid: reqId2,
    body: { capability: 'realperson', values: { firstName: 'Ada' } } // missing lastName, dateOfBirth
  }));
  const lastMsg = sentMessages[sentMessages.length - 1].envelope;
  assert.strictEqual(lastMsg.body.error, 'VALIDATION_FAILED');
  assert.ok(lastMsg.body.message.includes('lastName'), 'error message should name the missing field');
  assert.strictEqual(issueCalls.length, 1, 'issue() should not be called on validation failure');
  console.log('✓ missing required field rejected before issue() is called');

  // ── 5. Malformed date ────────────────────────────────────────────────────────────────────────
  const reqId3 = 'req-3';
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: reqId3, body: { capability: 'realperson' }
  }));
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-3', thid: reqId3,
    body: { capability: 'realperson', values: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: 'not-a-date' } }
  }));
  const dateMsg = sentMessages[sentMessages.length - 1].envelope;
  assert.strictEqual(dateMsg.body.error, 'VALIDATION_FAILED');
  console.log('✓ malformed date rejected');

  // ── 6. issue() throws → ISSUANCE_FAILED ──────────────────────────────────────────────────────
  const reqId4 = 'req-4';
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: reqId4, body: { capability: 'realperson' }
  }));
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-4', thid: reqId4,
    body: { capability: 'realperson', values: { firstName: 'Boom', lastName: 'Test', dateOfBirth: '2000-01-01' } }
  }));
  const failMsg = sentMessages[sentMessages.length - 1].envelope;
  assert.strictEqual(failMsg.body.error, 'ISSUANCE_FAILED');
  console.log('✓ issue() throwing surfaces as ISSUANCE_FAILED');

  // ── 7. Redelivered request id is ignored (webhook redelivery guard) ────────────────────────
  const countBefore = sentMessages.length;
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/request`, id: reqId4, body: { capability: 'realperson' }
  }));
  assert.strictEqual(sentMessages.length, countBefore, 'redelivered message id should be a no-op');
  console.log('✓ redelivered message id ignored');

  // ── 8. data-submit against an unknown/expired thid ──────────────────────────────────────────
  await service.handleIncomingMessage(holderDid, JSON.stringify({
    type: `${PROTOCOL_PREFIX}/data-submit`, id: 'sub-ghost', thid: 'never-requested',
    body: { capability: 'realperson', values: { firstName: 'X', lastName: 'Y', dateOfBirth: '2000-01-01' } }
  }));
  const ghostMsg = sentMessages[sentMessages.length - 1].envelope;
  assert.strictEqual(ghostMsg.body.error, 'UNKNOWN_REQUEST');
  console.log('✓ data-submit against unknown thid rejected');

  fakeAgent.close();
  console.log('\nAll CredentialIssuanceService tests passed.');
}

run().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
