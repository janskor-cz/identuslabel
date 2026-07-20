#!/usr/bin/env node
'use strict';
/**
 * test-alice-vp-access.js
 * End-to-end VP presentation flow:
 *   1. Upload a doc to document-service (INTERNAL)
 *   2. Alice presents her EmployeeRole VC as a VP
 *   3. Document-service verifies VP, decrypts, returns content
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = require('./node_modules/node-fetch');
const FormData = require('./node_modules/form-data');

const DOC_SERVICE_URL  = 'http://localhost:3020';
const DOC_SERVICE_KEY  = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
const ALICE_API_KEY    = '2d0ffe4eed0d756af972e8f8260c2c8a5f3efc2d64cbdd71ac02426682fe7d63';
const ALICE_VC_RECORD       = 'a9d0833a-e468-4634-bd33-99c45dfc5925'; // EmployeeRole
const ALICE_CLEARANCE_RECORD = 'afbe6b9b-1d14-4233-94bb-4e6e185b0a2c'; // SecurityClearance (INTERNAL)
const MULTITENANCY_URL = 'http://91.99.4.54:8200';
const COMPANY_DID      = process.env.SERVICE_DID;
const DOC_PATH         = path.join(__dirname, 'test_doc.docx');

let pass = 0, fail = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
    pass++;
  } catch(e) {
    console.log(`FAIL — ${e.message}`);
    fail++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── Step 1: Get Alice's VC JWTs ───────────────────────────────────────────────
async function getVCJwt(recordId) {
  const res = await fetch(`${MULTITENANCY_URL}/issue-credentials/records/${recordId}`, {
    headers: { 'apiKey': ALICE_API_KEY }
  });
  const d = await res.json();
  if (!d.credential) throw new Error('No credential in record — state: ' + d.protocolState);
  return Buffer.from(d.credential, 'base64').toString('utf-8');
}

// ── Step 2: Upload a document to document-service ─────────────────────────────
async function uploadDocument() {
  const fileContent = fs.readFileSync(DOC_PATH);
  const form = new FormData();
  form.append('file', fileContent, { filename: `alice-test-${Date.now()}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  form.append('title', 'Alice Access Test Document');
  form.append('clearanceLevel', 'INTERNAL');
  form.append('releasableTo', JSON.stringify([COMPANY_DID]));
  form.append('department', 'Engineering');

  const res = await fetch(`${DOC_SERVICE_URL}/documents`, {
    method: 'POST',
    headers: { ...form.getHeaders(), 'x-admin-key': DOC_SERVICE_KEY },
    body: form
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${JSON.stringify(d)}`);
  return d;
}

// ── Step 3: Build VP from Alice's VC ─────────────────────────────────────────
function buildVP(vcJwt) {
  return {
    '@context':            ['https://www.w3.org/2018/credentials/v1'],
    type:                  ['VerifiablePresentation'],
    verifiableCredential:  Array.isArray(vcJwt) ? vcJwt : [vcJwt]
  };
}

// ── Step 4: Request document access with VP ───────────────────────────────────
async function requestAccess(documentDID, vp) {
  // TweetNaCl expects raw 32-byte X25519 key — generate via nacl
  const nacl = require('/opt/project_identuslabel/identus-document-service/node_modules/tweetnacl');
  const ephemeralKeyPair = nacl.box.keyPair();
  const ephemeralPublicKey = Buffer.from(ephemeralKeyPair.publicKey).toString('base64');

  const body = JSON.stringify({ documentDID, ephemeralPublicKey, vp });
  const res = await fetch(`${DOC_SERVICE_URL}/documents/${encodeURIComponent(documentDID)}/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  return { status: res.status, data: await res.json() };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n====================================================');
  console.log('Alice VP Access Flow Test');
  console.log('====================================================\n');

  let employeeRoleJwt, clearanceJwt, documentDID, vp;

  await test('Get Alice VC JWTs from cloud agent', async () => {
    employeeRoleJwt = await getVCJwt(ALICE_VC_RECORD);
    clearanceJwt    = await getVCJwt(ALICE_CLEARANCE_RECORD);
    assert(employeeRoleJwt.startsWith('eyJ'), 'EmployeeRole not a JWT');
    assert(clearanceJwt.startsWith('eyJ'), 'SecurityClearance not a JWT');
    const p1 = JSON.parse(Buffer.from(employeeRoleJwt.split('.')[1], 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(clearanceJwt.split('.')[1], 'base64url').toString());
    const cs1 = p1.vc?.credentialSubject || {};
    const cs2 = p2.vc?.credentialSubject || {};
    assert(cs1.role, 'No role in EmployeeRole VC');
    assert(cs2.clearanceLevel, 'No clearanceLevel in SecurityClearance VC');
    console.log(`\n    EmployeeRole: role=${cs1.role}  SecurityClearance: level=${cs2.clearanceLevel}`);
  });

  await test('Upload INTERNAL doc to document-service', async () => {
    const result = await uploadDocument();
    assert(result.documentDID, 'No documentDID in response');
    documentDID = result.documentDID;
    console.log(`\n    documentDID=${documentDID.slice(0,60)}...`);
  });

  await test('Build VP with both VCs', async () => {
    assert(employeeRoleJwt && clearanceJwt, 'Need both VCs');
    vp = buildVP([employeeRoleJwt, clearanceJwt]);
    assert(vp.verifiableCredential.length === 2, 'VP should have 2 credentials');
  });

  await test('Request document access with Alice VP (INTERNAL clearance)', async () => {
    assert(documentDID, 'Need documentDID from step 2');
    const { status, data } = await requestAccess(documentDID, vp);
    console.log(`\n    HTTP ${status} — ${JSON.stringify(data).slice(0,200)}`);
    assert(status === 200 || status === 206, `Expected 200/206, got ${status}: ${JSON.stringify(data)}`);
    assert(data.success, 'Response not success: ' + JSON.stringify(data));
  });

  await test('Wrong clearance level is denied (INTERNAL user → RESTRICTED doc)', async () => {
    // Upload a RESTRICTED doc
    const fileContent = fs.readFileSync(DOC_PATH);
    const form = new FormData();
    form.append('file', fileContent, { filename: `restricted-test-${Date.now()}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    form.append('title', 'Restricted Test Doc');
    form.append('clearanceLevel', 'RESTRICTED');
    form.append('releasableTo', JSON.stringify([COMPANY_DID]));
    form.append('department', 'Legal');
    const upRes = await fetch(`${DOC_SERVICE_URL}/documents`, {
      method: 'POST',
      headers: { ...form.getHeaders(), 'x-admin-key': DOC_SERVICE_KEY },
      body: form
    });
    const upData = await upRes.json();
    assert(upData.documentDID, 'Upload failed: ' + JSON.stringify(upData));
    const restrictedDID = upData.documentDID;

    // Alice only has INTERNAL clearance — should be denied RESTRICTED
    const { status, data } = await requestAccess(restrictedDID, vp);
    console.log(`\n    HTTP ${status} — ${data.error || data.message || ''}`);
    assert(status === 403, `Expected 403, got ${status}`);
  });

  console.log('\n====================================================');
  console.log(`Results: ${pass} passed, ${fail} failed out of ${pass+fail} tests`);
  console.log('====================================================\n');
  process.exit(fail > 0 ? 1 : 0);
})();
