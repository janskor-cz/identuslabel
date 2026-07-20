#!/usr/bin/env node
'use strict';
/**
 * test-ssi-webcrypto-upload.js
 *
 * Puppeteer (headless Chromium) tests for the SSI-aligned encryption flows.
 *
 * Tests:
 *  1. Browser WebCrypto: AES-256-GCM encrypt + decrypt round-trip (pure browser)
 *  2. wrap-dek endpoint: server wraps 32-byte DEK, returns wrappedKey + iv + authTag
 *  3. Pre-encrypted upload: browser encrypts file, server wraps DEK, upload succeeds
 *     with preEncrypted=true path (verifies server never receives plaintext)
 *  4. Access response shape: POST /access returns encryptedDEK + encryptedBlob fields
 *     (not encryptedDocument containing plaintext)
 *  5. Wallet-side decrypt: browser nacl.box.open(DEK) + AES-GCM.decrypt(blob) = original
 *
 * Requires:
 *   - Company Admin running on port 3010
 *   - Document Service running on port 3020
 *   - TEST_BYPASS_KEY env var set on the company-admin process
 *   - Alice VC records available (from alice-employee.env)
 */

const puppeteer = require('puppeteer');
const fetch     = require('node-fetch');
const crypto    = require('crypto');

const COMPANY_URL    = 'http://localhost:3010';
const DOC_SVC_URL    = 'http://localhost:3020';
const TEST_KEY       = process.env.TEST_BYPASS_KEY || 'test-bypass-key-dev';

// Alice's credentials for access test
const MULTITENANCY_URL       = 'http://91.99.4.54:8200';
const ALICE_API_KEY          = '2d0ffe4eed0d756af972e8f8260c2c8a5f3efc2d64cbdd71ac02426682fe7d63';
const ALICE_VC_RECORD        = 'a9d0833a-e468-4634-bd33-99c45dfc5925';
const ALICE_CLEARANCE_RECORD = 'afbe6b9b-1d14-4233-94bb-4e6e185b0a2c';

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const BLUE  = '\x1b[34m';
const NC    = '\x1b[0m';

let pass = 0, fail = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log(`${GREEN}PASS${NC}`);
    pass++;
  } catch (e) {
    console.log(`${RED}FAIL${NC} — ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    fail++;
  }
}

// ── Helper: inject a synthetic employee session ───────────────────────────────
async function createTestSession(overrides = {}) {
  const res = await fetch(`${COMPANY_URL}/api/test/create-session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Key': TEST_KEY },
    body:    JSON.stringify({
      clearanceLevel: 'TOP-SECRET',
      hasClearanceVC: true,
      ...overrides
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Session injection failed ${res.status}: ${body}`);
  }
  const d = await res.json();
  return d.sessionToken;
}

// ── Helper: get Alice's VC JWTs ───────────────────────────────────────────────
async function getAliceVCJwt(recordId) {
  const res = await fetch(`${MULTITENANCY_URL}/issue-credentials/records/${recordId}`, {
    headers: { apiKey: ALICE_API_KEY }
  });
  const d = await res.json();
  if (!d.credential) throw new Error('No credential in record — state: ' + d.protocolState);
  return Buffer.from(d.credential, 'base64').toString('utf-8');
}

// ── Helper: upload a plain doc to document-service (for access test) ──────────
async function uploadPlainDoc(adminKey) {
  const FormData = require('form-data');
  const form = new FormData();
  const content = Buffer.from(`SSI test document — ${Date.now()}`);
  form.append('file', content, { filename: 'ssi-test.txt', contentType: 'text/plain' });
  form.append('title', 'SSI WebCrypto Test Doc');
  form.append('clearanceLevel', 'INTERNAL');
  form.append('releasableTo', JSON.stringify([process.env.SERVICE_DID || 'did:prism:servicedid']));
  form.append('department', 'Engineering');

  const res = await fetch(`${DOC_SVC_URL}/documents`, {
    method:  'POST',
    headers: { ...form.getHeaders(), 'x-admin-key': adminKey },
    body:    form
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BLUE}${'═'.repeat(70)}${NC}`);
  console.log(`${BLUE}  SSI WebCrypto Upload — Puppeteer Tests${NC}`);
  console.log(`${BLUE}${'═'.repeat(70)}${NC}\n`);

  // ── Launch headless Chromium ─────────────────────────────────────────────────
  // Use the raw snap Chromium binary directly (snap wrapper fails outside root's HOME)
  const CHROME_BIN = process.env.CHROME_BIN ||
    '/snap/chromium/current/usr/lib/chromium-browser/chrome';
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_BIN,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    env: { ...process.env, HOME: '/tmp/chrome-home' }
  });

  try {
    const page = await browser.newPage();
    // Suppress console noise from page
    page.on('console', msg => {
      if (process.env.DEBUG) console.log('[page]', msg.text());
    });

    // ── Test 1: Browser WebCrypto AES-256-GCM round-trip ────────────────────────
    await test('Browser crypto.subtle AES-256-GCM encrypt/decrypt round-trip', async () => {
      // Navigate to localhost (secure context required for crypto.subtle)
      await page.goto('http://localhost:3010/');
      const result = await page.evaluate(async () => {
        const plaintext = new TextEncoder().encode('Hello SSI World — secret document content!');

        // Encrypt
        const dekRaw      = crypto.getRandomValues(new Uint8Array(32));
        const fileIvBytes = crypto.getRandomValues(new Uint8Array(12));
        const dekKey      = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        const encWithTag  = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIvBytes }, dekKey, plaintext));

        // Separate ciphertext and authTag (WebCrypto appends 16-byte authTag)
        const ciphertext  = encWithTag.slice(0, -16);
        const authTag     = encWithTag.slice(-16);

        // Reconstruct for decryption (ciphertext || authTag)
        const combined = new Uint8Array(ciphertext.length + authTag.length);
        combined.set(ciphertext);
        combined.set(authTag, ciphertext.length);

        const dekKey2   = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
        const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fileIvBytes }, dekKey2, combined));
        const matches   = JSON.stringify(Array.from(plaintext)) === JSON.stringify(Array.from(decrypted));

        return { matches, ciphertextLen: ciphertext.length, authTagLen: authTag.length, plaintextLen: plaintext.length };
      });

      if (!result.matches)     throw new Error('Decrypted bytes do not match original');
      if (result.authTagLen !== 16) throw new Error(`Expected 16-byte authTag, got ${result.authTagLen}`);
      if (result.ciphertextLen !== result.plaintextLen) throw new Error('Ciphertext length should equal plaintext length for GCM');
    });

    // ── Test 2: Browser sends ephemeral pub key; nacl.box round-trip ────────────
    await test('Browser tweetnacl box DEK (32 bytes) round-trip', async () => {
      await page.goto('http://localhost:3010/');
      // Inject tweetnacl into the page
      const naclSrc = require('fs').readFileSync(
        require.resolve('tweetnacl/nacl-fast.js'), 'utf8'
      );
      await page.addScriptTag({ content: naclSrc });

      const result = await page.evaluate(() => {
        const nacl = window.nacl;
        const serverKP = nacl.box.keyPair();
        const clientKP = nacl.box.keyPair();
        const rawDEK   = crypto.getRandomValues(new Uint8Array(32));
        const nonce    = nacl.randomBytes(nacl.box.nonceLength);

        // Server boxes DEK to client
        const boxed = nacl.box(rawDEK, nonce, clientKP.publicKey, serverKP.secretKey);
        // Client opens it
        const opened = nacl.box.open(boxed, nonce, serverKP.publicKey, clientKP.secretKey);

        const matches = opened && Array.from(opened).every((b, i) => b === rawDEK[i]);
        return {
          boxedLen:   boxed.length,   // 32 + 16 overhead = 48
          dekLen:     rawDEK.length,
          matches
        };
      });

      if (!result.matches)           throw new Error('nacl.box DEK round-trip failed');
      if (result.boxedLen !== 48)    throw new Error(`Expected boxedLen=48, got ${result.boxedLen}`);
      if (result.dekLen  !== 32)     throw new Error(`Expected dekLen=32, got ${result.dekLen}`);
    });

    // ── Test 3: wrap-dek endpoint wraps 32-byte DEK, returns correct fields ──────
    await test('POST /api/employee-portal/wrap-dek wraps DEK correctly', async () => {
      const sessionToken = await createTestSession();
      const rawDEK = crypto.randomBytes(32);
      const rawDEKb64 = rawDEK.toString('base64');

      const res = await fetch(`${COMPANY_URL}/api/employee-portal/wrap-dek`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionToken },
        body:    JSON.stringify({ rawDEK: rawDEKb64, classificationLevel: 'RESTRICTED' })
      });

      if (!res.ok) throw new Error(`wrap-dek returned ${res.status}: ${await res.text()}`);
      const d = await res.json();
      if (!d.wrappedKey)        throw new Error('Missing wrappedKey in response');
      if (!d.iv)                throw new Error('Missing iv in response');
      if (!d.authTag)           throw new Error('Missing authTag in response');
      if (!d.wrappingAlgorithm) throw new Error('Missing wrappingAlgorithm in response');

      // Verify wrapped key is base64 and not equal to rawDEK (actually wrapped)
      const wrappedBuf = Buffer.from(d.wrappedKey, 'base64');
      if (wrappedBuf.equals(rawDEK)) throw new Error('wrappedKey must differ from rawDEK — wrapping not applied');
    });

    // ── Test 4: wrap-dek rejects non-32-byte DEK ─────────────────────────────────
    await test('POST /wrap-dek rejects DEK that is not 32 bytes', async () => {
      const sessionToken = await createTestSession();
      const shortDEK = crypto.randomBytes(16).toString('base64'); // 16 bytes — wrong

      const res = await fetch(`${COMPANY_URL}/api/employee-portal/wrap-dek`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionToken },
        body:    JSON.stringify({ rawDEK: shortDEK, classificationLevel: 'INTERNAL' })
      });

      if (res.ok) throw new Error('Expected 400 for non-32-byte DEK, got 200');
      const d = await res.json();
      if (d.error !== 'INVALID_DEK') throw new Error(`Expected INVALID_DEK error, got: ${d.error}`);
    });

    // ── Test 5: wrap-dek requires session token ──────────────────────────────────
    await test('POST /wrap-dek returns 401 without session token', async () => {
      const rawDEK = crypto.randomBytes(32).toString('base64');
      const res = await fetch(`${COMPANY_URL}/api/employee-portal/wrap-dek`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rawDEK, classificationLevel: 'INTERNAL' })
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    // ── Test 6: browser full upload flow — WebCrypto → wrap-dek → preEncrypted ──
    await test('Browser: WebCrypto encrypt → wrap-dek → preEncrypted upload (shape check)', async () => {
      const sessionToken = await createTestSession({ clearanceLevel: 'TOP-SECRET' });

      // Inject tweetnacl (already done in page from test 2, but re-navigate)
      await page.goto('http://localhost:3010/');

      // Set session cookie in page context
      const result = await page.evaluate(async ({ companyUrl, sessionToken }) => {
        // Use a sufficiently large plaintext (Iagon requires minimum file size > ~100 bytes)
        const PLAINTEXT = 'Confidential: Operation Aurora details — for TOP-SECRET only.\n' +
          'This document describes the project architecture and security clearance requirements.\n' +
          'All personnel accessing this document must hold a valid TOP-SECRET clearance.\n' +
          'Unauthorized disclosure is subject to prosecution under applicable law.\n' +
          'Document classification: TOP-SECRET // NOFORN // ORCON\n'.repeat(5);
        const encoder   = new TextEncoder();
        const plaintextBytes = encoder.encode(PLAINTEXT);

        // 1. Content hash
        const hashBuf   = await crypto.subtle.digest('SHA-256', plaintextBytes);
        const contentHash = 'sha256:' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');

        // 2. Generate DEK + IV
        const dekRaw      = crypto.getRandomValues(new Uint8Array(32));
        const fileIvBytes = crypto.getRandomValues(new Uint8Array(12));
        const dekKey      = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['encrypt']);

        // 3. Encrypt
        const encWithTag   = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIvBytes }, dekKey, plaintextBytes));
        const ciphertext   = encWithTag.slice(0, -16);
        const fileAuthTag  = encWithTag.slice(-16);

        const b64 = buf => btoa(String.fromCharCode(...buf));

        // 4. Wrap DEK
        const wrapRes = await fetch(`${companyUrl}/api/employee-portal/wrap-dek`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionToken },
          body:    JSON.stringify({ rawDEK: b64(dekRaw), classificationLevel: 'TOP-SECRET' })
        });
        if (!wrapRes.ok) return { error: `wrap-dek ${wrapRes.status}: ${await wrapRes.text()}` };
        const wrap = await wrapRes.json();
        dekRaw.fill(0);

        // 5. Build FormData with pre-encrypted file
        const form = new FormData();
        form.append('file',             new Blob([ciphertext], {type:'application/octet-stream'}), `test-classified-${Date.now()}.bin`);
        form.append('title',            'SSI Browser Upload Test');
        form.append('description',      'Puppeteer test document');
        form.append('documentType',     'Report');
        form.append('classificationLevel', 'TOP-SECRET');
        form.append('preEncrypted',     'true');
        form.append('fileIv',           b64(fileIvBytes));
        form.append('fileAuthTag',      b64(fileAuthTag));
        form.append('fileAlgorithm',    'AES-256-GCM');
        form.append('wrappedKey',       wrap.wrappedKey);
        form.append('wrapIv',           wrap.iv);
        form.append('wrapAuthTag',      wrap.authTag);
        form.append('wrappingAlgorithm', wrap.wrappingAlgorithm);
        form.append('contentHash',      contentHash);

        const uploadRes = await fetch(`${companyUrl}/api/classified-documents/upload`, {
          method:  'POST',
          headers: { 'X-Session-ID': sessionToken },
          body:    form
        });
        const uploadBody = await uploadRes.json();
        return {
          status:   uploadRes.status,
          success:  uploadBody.success,
          hasDocumentDID: !!uploadBody.documentDID,
          hasKeyManifestVCId: !!uploadBody.keyManifestVCId,
          error:    uploadBody.error || null
        };
      }, { companyUrl: COMPANY_URL, sessionToken });

      if (result.error && !result.success) throw new Error(`Upload error: ${result.error}`);
      if (!result.success) throw new Error(`Upload failed (status ${result.status}): ${JSON.stringify(result)}`);
      if (!result.hasDocumentDID) throw new Error('No documentDID in upload response');
      if (!result.hasKeyManifestVCId) throw new Error('No keyManifestVCId in upload response — KeyManifest VC not pushed');
    });

    // ── Test 7: access response has encryptedDEK + encryptedBlob, NOT plaintext ──
    // ── Tests 7 & 8 share a setup: upload doc via admin + inject CMK-wrapped DEK ──
    //
    // Strategy:
    //  - Upload plaintext via admin endpoint (doc-service stores encrypted on Iagon)
    //  - The doc-service encrypts with its own DEK; we cannot retrieve it
    //  - Instead: use wrap-dek + test inject to simulate a classified upload
    //    (browser-encrypted file stored directly on Iagon, VCKeyStore entry injected)
    //  This tests the SSI-aligned path end-to-end without needing DIDComm.
    //
    // Build a synthetic test document: encrypt in Node (same crypto as browser),
    // upload the ciphertext to Iagon via admin endpoint, inject VCKeyStore entry.

    let sharedDocDID = null;
    let sharedKnownContent = null;
    let sharedVp = null;

    const setupTestDoc = async () => {
      const employeeJwt  = await getAliceVCJwt(ALICE_VC_RECORD);
      const clearanceJwt = await getAliceVCJwt(ALICE_CLEARANCE_RECORD);

      sharedKnownContent = `SSI wallet decrypt test content — ${Date.now()}`;
      const plainBuf = Buffer.from(sharedKnownContent);

      // ── Encrypt with Node's crypto (same AES-256-GCM as WebCrypto) ──────────
      const dekRaw    = crypto.randomBytes(32);
      const fileIv    = crypto.randomBytes(12);
      const cipher    = crypto.createCipheriv('aes-256-gcm', dekRaw, fileIv);
      const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
      const fileAuthTag = cipher.getAuthTag();
      const contentHash = 'sha256:' + crypto.createHash('sha256').update(plainBuf).digest('hex');

      // ── Wrap DEK via company-admin ───────────────────────────────────────────
      const sessionToken = await createTestSession({ clearanceLevel: 'TOP-SECRET', hasClearanceVC: true });
      const wrapRes = await fetch(`${COMPANY_URL}/api/employee-portal/wrap-dek`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionToken },
        body:    JSON.stringify({ rawDEK: dekRaw.toString('base64'), classificationLevel: 'INTERNAL' })
      });
      if (!wrapRes.ok) throw new Error('wrap-dek failed: ' + await wrapRes.text());
      const wrap = await wrapRes.json();
      dekRaw.fill(0);

      // ── Upload via company-admin preEncrypted path ────────────────────────────
      // This uses company-admin's IagonStorageClient (has UNCLASSIFIED bypass — no re-encryption)
      // and also pushes the VCKeyStore entry to doc-service automatically.
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', ciphertext, { filename: `ssi-setup-${Date.now()}.bin`, contentType: 'application/octet-stream' });
      form.append('title', 'SSI Decrypt Round-Trip Test');
      form.append('description', 'Setup document for Puppeteer test 7+8');
      form.append('documentType', 'Report');
      form.append('classificationLevel', 'INTERNAL');
      form.append('preEncrypted', 'true');
      form.append('fileIv',           fileIv.toString('base64'));
      form.append('fileAuthTag',      fileAuthTag.toString('base64'));
      form.append('fileAlgorithm',    'AES-256-GCM');
      form.append('wrappedKey',       wrap.wrappedKey);
      form.append('wrapIv',           wrap.iv);
      form.append('wrapAuthTag',      wrap.authTag);
      form.append('wrappingAlgorithm', wrap.wrappingAlgorithm);
      form.append('contentHash',      contentHash);

      const uploadRes = await fetch(`${COMPANY_URL}/api/classified-documents/upload`, {
        method:  'POST',
        headers: { ...form.getHeaders(), 'X-Session-ID': sessionToken },
        body:    form
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error('Upload failed: ' + JSON.stringify(uploadData));

      sharedDocDID = uploadData.documentDID;
      if (!sharedDocDID) throw new Error('No DID in upload response: ' + JSON.stringify(uploadData));
      // VCKeyStore entry is pushed automatically by the preEncrypted upload path

      sharedVp = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type:       ['VerifiablePresentation'],
        verifiableCredential: [employeeJwt, clearanceJwt]
      };
    };

    await setupTestDoc();

    await test('POST /access response shape: encryptedDEK + encryptedBlob (no plaintext file)', async () => {
      if (!sharedDocDID) throw new Error('Setup failed — no docDID');

      const nacl = require('tweetnacl');
      const kp   = nacl.box.keyPair();
      const ephemeralPublicKey = Buffer.from(kp.publicKey).toString('base64');

      const res = await fetch(`${DOC_SVC_URL}/access`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ documentDID: sharedDocDID, vp: sharedVp, ephemeralPublicKey })
      });

      if (!res.ok) throw new Error(`/access returned ${res.status}: ${await res.text()}`);
      const d = await res.json();

      // Must have encryptedDEK (nacl.box of 32-byte DEK)
      if (!d.encryptedDEK)                  throw new Error('Missing encryptedDEK in access response');
      if (!d.encryptedDEK.ciphertext)        throw new Error('Missing encryptedDEK.ciphertext');
      if (!d.encryptedDEK.nonce)             throw new Error('Missing encryptedDEK.nonce');
      if (!d.encryptedDEK.senderPublicKey)   throw new Error('Missing encryptedDEK.senderPublicKey');

      // Must have raw encrypted blob + IV
      if (!d.encryptedBlob)  throw new Error('Missing encryptedBlob in access response');
      if (!d.fileIv)         throw new Error('Missing fileIv in access response');
      if (!d.fileAuthTag)    throw new Error('Missing fileAuthTag in access response');

      // Must NOT contain plaintext
      if (d.plaintext)         throw new Error('Server returned plaintext — SSI violation!');
      if (d.decryptedContent)  throw new Error('Server returned decryptedContent — SSI violation!');
      if (d.encryptedDocument) throw new Error('Server returned old encryptedDocument shape — not updated!');

      // encryptedDEK.ciphertext = nacl.box(32-byte DEK) = 48 bytes
      const dekBoxed = Buffer.from(d.encryptedDEK.ciphertext, 'base64');
      if (dekBoxed.length !== 48) throw new Error(`encryptedDEK.ciphertext should be 48 bytes, got ${dekBoxed.length}`);
    });

    // ── Test 8: wallet two-step decrypt — nacl.box DEK + AES-GCM file ───────────
    await test('Browser: nacl.box.open(DEK) + AES-GCM.decrypt(blob) = original plaintext', async () => {
      if (!sharedDocDID || !sharedVp) throw new Error('Setup failed — no docDID or VP');

      // Load from doc-service origin to avoid CORS for the /access fetch
      await page.goto('http://localhost:3020/health');
      const naclSrc = require('fs').readFileSync(require.resolve('tweetnacl/nacl-fast.js'), 'utf8');
      await page.addScriptTag({ content: naclSrc });

      const result = await page.evaluate(async ({ docSvcUrl, docDID, vp }) => {
        const nacl   = window.nacl;
        const b64    = buf => btoa(String.fromCharCode(...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
        const from64 = s   => new Uint8Array(atob(s).split('').map(c => c.charCodeAt(0)));

        // Generate ephemeral keypair (mimics wallet)
        const kp = nacl.box.keyPair();
        const ephemeralPublicKey = b64(kp.publicKey);

        const res = await fetch(`${docSvcUrl}/access`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ documentDID: docDID, vp, ephemeralPublicKey })
        });
        if (!res.ok) return { error: `access ${res.status}: ${await res.text()}` };
        const d = await res.json();

        if (!d.encryptedDEK?.ciphertext) return { error: 'Missing encryptedDEK: ' + JSON.stringify(d.encryptedDEK) };
        if (!d.encryptedBlob)            return { error: 'Missing encryptedBlob' };

        // Step 1: Decrypt DEK via nacl.box.open
        const dek = nacl.box.open(
          from64(d.encryptedDEK.ciphertext),
          from64(d.encryptedDEK.nonce),
          from64(d.encryptedDEK.senderPublicKey),
          kp.secretKey
        );
        kp.secretKey.fill(0);
        if (!dek)          return { error: 'nacl.box.open failed — wrong key or corrupted DEK' };
        if (dek.length !== 32) return { error: `DEK length ${dek.length}, expected 32` };

        // Step 2: AES-256-GCM decrypt the Iagon blob
        // encryptedBlob = pure ciphertext (no authTag appended by Iagon)
        // fileAuthTag   = separate 16-byte tag
        const encryptedBytes   = from64(d.encryptedBlob);
        const fileAuthTagBytes = from64(d.fileAuthTag);
        const combined = new Uint8Array(encryptedBytes.length + fileAuthTagBytes.length);
        combined.set(encryptedBytes);
        combined.set(fileAuthTagBytes, encryptedBytes.length);

        const dekKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['decrypt']);
        let plaintext;
        try {
          plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(d.fileIv) }, dekKey, combined);
        } catch (e) {
          return { error: 'AES-GCM decrypt failed: ' + e.message };
        }
        dek.fill(0);

        // Step 3: Verify content hash
        if (d.contentHash) {
          const hashBuf = await crypto.subtle.digest('SHA-256', plaintext);
          const computed = 'sha256:' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
          if (computed !== d.contentHash) return { error: `Hash mismatch: computed=${computed} expected=${d.contentHash}` };
        }

        return { decoded: new TextDecoder().decode(plaintext), success: true };
      }, { docSvcUrl: DOC_SVC_URL, docDID: sharedDocDID, vp: sharedVp });

      if (result.error)   throw new Error(result.error);
      if (!result.success) throw new Error('Decrypt did not succeed');
      if (!result.decoded.includes('SSI wallet decrypt test content')) {
        throw new Error(`Content mismatch. Got: "${result.decoded.substring(0, 80)}"`);
      }
    });

  } finally {
    await browser.close();
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  const total = pass + fail;
  if (fail === 0) {
    console.log(`${GREEN}Results: ${pass} passed, 0 failed out of ${total} tests${NC}`);
  } else {
    console.log(`${RED}Results: ${pass} passed, ${fail} failed out of ${total} tests${NC}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal:${NC}`, err.message);
  process.exit(1);
});
