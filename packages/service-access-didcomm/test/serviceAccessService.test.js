'use strict';

/**
 * Integration test for ServiceAccessService against a tiny in-process fake Cloud Agent
 * (real HTTP server, no mocking of node-fetch) — exercises the full request → proof →
 * poll → verify → grant round trip for both `mode: redirect` and `mode: payload` capabilities,
 * plus the untrusted-issuer rejection path.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { ServiceAccessService, CapabilityError } = require('../lib/ServiceAccessService');
const { createTrustRegistry } = require('../lib/TrustRegistry');
const { createIssuerResolver } = require('../lib/issuerResolver');

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** Poll `predicate` until it returns truthy or `timeoutMs` elapses (default 3s) — avoids
 *  flaky fixed-delay waits for the async request→proof→poll→verify→grant chain, whose timing
 *  depends on real (if fast, in-process) HTTP round trips and isn't guaranteed by a fixed sleep
 *  under system load. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

function derToCompact(der) {
  let offset = 2;
  function readInt() {
    offset += 1;
    const len = der[offset]; offset += 1;
    let bytes = der.slice(offset, offset + len); offset += len;
    if (bytes.length > 32) bytes = bytes.slice(bytes.length - 32);
    if (bytes.length < 32) bytes = Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
    return bytes;
  }
  return Buffer.concat([readInt(), readInt()]);
}

function signCompact(payloadObj, privateKey) {
  const header = { alg: 'ES256K', typ: 'JWT' };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payloadObj)))}`;
  const der = crypto.sign('SHA256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'der' });
  return `${signingInput}.${b64url(derToCompact(der))}`;
}

async function run() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const trustedIssuerDID   = 'did:prism:trusted-issuer';
  const untrustedIssuerDID = 'did:prism:untrusted-issuer';
  const publicKeyJwk = { ...publicKey.export({ format: 'jwk' }), crv: 'secp256k1' };

  const vcJwt = signCompact({ iss: trustedIssuerDID, vc: { credentialSubject: { role: 'engineer', department: 'R&D' } } }, privateKey);
  const vpJwt = signCompact({ vp: { verifiableCredential: [vcJwt] } }, privateKey); // outer VP signature not checked by this library

  const untrustedVcJwt = signCompact({ iss: untrustedIssuerDID, vc: { credentialSubject: { role: 'engineer', department: 'R&D' } } }, privateKey);
  const untrustedVpJwt = signCompact({ vp: { verifiableCredential: [untrustedVcJwt] } }, privateKey);

  const sentMessages = []; // { connectionId, content }
  let proofCounter = 0;
  const proofStates = new Map(); // proofId → { state, vpJwt }
  let nextVpJwt = null; // set by the test right before each handleIncomingMessage call
  let nextProofState = 'PresentationVerified'; // override to simulate e.g. a Cloud Agent schema-mismatch rejection

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url;
      if (req.method === 'GET' && url.startsWith('/dids/')) {
        const did = decodeURIComponent(url.replace('/dids/', ''));
        const isTrusted = did === trustedIssuerDID;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          didDocument: {
            verificationMethod: [{ id: `${did}#key-1`, publicKeyJwk }],
            assertionMethod: isTrusted || did === untrustedIssuerDID ? [`${did}#key-1`] : []
          }
        }));
        return;
      }
      if (req.method === 'POST' && url === '/present-proof/presentations') {
        proofCounter += 1;
        const proofId = `proof-${proofCounter}`;
        // Simulate the wallet having already approved by the time the first poll lands —
        // this test exercises the verify→grant core, not the pending/poll-timing behavior.
        proofStates.set(proofId, { state: nextProofState, vpJwt: nextVpJwt });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ presentationId: proofId }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/present-proof/presentations/')) {
        const proofId = url.split('/').pop();
        const entry = proofStates.get(proofId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: entry.state, data: [entry.vpJwt] }));
        return;
      }
      if (req.method === 'PATCH' && url.startsWith('/present-proof/presentations/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        return;
      }
      if (req.method === 'POST' && /\/connections\/.+\/basic-messages/.test(url)) {
        const connectionId = url.split('/')[2];
        sentMessages.push({ connectionId, content: JSON.parse(body).content });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        return;
      }
      res.writeHead(404); res.end();
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const cloudAgentUrl = `http://127.0.0.1:${port}`;

  const trustRegistry = createTrustRegistry([{ did: trustedIssuerDID, vcTypes: ['EmployeeRole'] }]);
  const resolveIssuerDID = createIssuerResolver({ cloudAgentUrl });

  const svc = new ServiceAccessService({
    cloudAgentUrl,
    apiKey: 'test-key',
    publicBaseUrl: 'https://service.example',
    resolveConnection: async () => 'conn-1',
    resolveIssuerDID,
    trustRegistry,
    pollIntervalMs: 20,
    pollTimeoutMs: 2000,
    capabilities: {
      portal: {
        label: 'Portal', icon: '🏛️', mode: 'redirect', redirectPath: '/dashboard',
        proofSpec: { proofs: [{ schemaId: 'EmployeeRole-v1', trustIssuers: [] }], goalCode: 'g', goal: 'Please prove', claims: {}, domain: 'test' },
        trustedIssuerVcType: 'EmployeeRole'
      },
      docAccess: {
        label: 'Document Access', icon: '📄', mode: 'payload',
        proofSpec: { proofs: [{ schemaId: 'EmployeeRole-v1', trustIssuers: [] }], goalCode: 'g', goal: 'Please prove', claims: {}, domain: 'test' },
        trustedIssuerVcType: 'EmployeeRole',
        buildResult: async ({ claims, requestBody }) => {
          if (requestBody?.documentDID === 'did:doc:missing') {
            throw new CapabilityError('DOCUMENT_NOT_FOUND', 'No such document');
          }
          return { dek: 'fake-dek-for-' + claims.role, forDocument: requestBody?.documentDID };
        }
      }
    }
  });

  // --- Test 1: redirect-mode capability, trusted issuer → grant with accessUrl ---
  nextVpJwt = vpJwt;
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-1', body: { capability: 'portal' }
  }));
  const grant1 = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).type.endsWith('/grant')));
  const grant1Body = JSON.parse(grant1.content).body;
  assert.strictEqual(grant1Body.mode, 'redirect');
  assert.ok(grant1Body.accessUrl.startsWith('https://service.example/api/access?token='));
  assert.strictEqual(JSON.parse(grant1.content).thid, 'req-1');

  const token = new URL(grant1Body.accessUrl).searchParams.get('token');
  const tokenEntry = svc.getToken(token);
  assert.strictEqual(tokenEntry.userClaims.role, 'engineer');

  // consumeGrant mirrors the same grant via the HTTP-pollable transport, keyed by the
  // original request id, and is one-time (deletes on read).
  const consumed = svc.consumeGrant('req-1');
  assert.ok(consumed?.grant, 'expected consumeGrant to return the same grant for req-1');
  assert.strictEqual(consumed.grant.capability, 'portal');
  assert.strictEqual(svc.consumeGrant('req-1'), null, 'consumeGrant must be one-time');

  // --- Test 2: payload-mode capability, trusted issuer → grant with result ---
  sentMessages.length = 0;
  nextVpJwt = vpJwt;
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-2', body: { capability: 'docAccess', documentDID: 'did:doc:abc' }
  }));
  const grant2 = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).type.endsWith('/grant')));
  const grant2Body = JSON.parse(grant2.content).body;
  assert.strictEqual(grant2Body.mode, 'payload');
  assert.strictEqual(grant2Body.result.dek, 'fake-dek-for-engineer');
  assert.strictEqual(grant2Body.result.forDocument, 'did:doc:abc', 'requestBody must thread through to buildResult');

  // --- Test 2b: buildResult throws CapabilityError → proper error, no grant ---
  sentMessages.length = 0;
  nextVpJwt = vpJwt;
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-2b', body: { capability: 'docAccess', documentDID: 'did:doc:missing' }
  }));
  const msg2b = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).thid === 'req-2b'));
  const parsed2b = JSON.parse(msg2b.content);
  assert.ok(parsed2b.type.endsWith('/error'), 'CapabilityError must produce a protocol error, not a grant');
  assert.strictEqual(parsed2b.body.error, 'DOCUMENT_NOT_FOUND');

  // --- Test 3: untrusted issuer → error, no grant ---
  sentMessages.length = 0;
  nextVpJwt = untrustedVpJwt;
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-3', body: { capability: 'portal' }
  }));
  const msg3 = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).thid === 'req-3'));
  const parsed3 = JSON.parse(msg3.content);
  assert.ok(parsed3.type.endsWith('/error'), 'untrusted issuer must produce an error, not a grant');
  assert.strictEqual(parsed3.body.error, 'UNTRUSTED_ISSUER');

  // --- Test 3b: Cloud Agent PresentationVerificationFailed (e.g. schema mismatch) → fast
  // PROOF_REJECTED error, not a silent hang until pollTimeoutMs (2s here) ---
  sentMessages.length = 0;
  nextVpJwt = vpJwt;
  nextProofState = 'PresentationVerificationFailed';
  const startedAt = Date.now();
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-3b', body: { capability: 'portal' }
  }));
  const msg3b = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).thid === 'req-3b'));
  assert.ok(Date.now() - startedAt < 1000, 'PresentationVerificationFailed must be detected on the next poll tick, not after the 2s timeout');
  const parsed3b = JSON.parse(msg3b.content);
  assert.ok(parsed3b.type.endsWith('/error'));
  assert.strictEqual(parsed3b.body.error, 'PROOF_REJECTED');
  nextProofState = 'PresentationVerified';

  // --- Test 4: unknown capability → UNKNOWN_CAPABILITY error, no proof request made ---
  sentMessages.length = 0;
  await svc.handleIncomingMessage('did:peer:holder', JSON.stringify({
    type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
    id: 'req-4', body: { capability: 'does-not-exist' }
  }));
  const msg4 = await waitFor(() => sentMessages.find(m => JSON.parse(m.content).thid === 'req-4'));
  assert.strictEqual(JSON.parse(msg4.content).body.error, 'UNKNOWN_CAPABILITY');
  // Errors are consumable via the HTTP transport too, not just successful grants.
  assert.strictEqual(svc.consumeGrant('req-4').error, 'UNKNOWN_CAPABILITY');

  server.close();
  console.log('ServiceAccessService: all tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
