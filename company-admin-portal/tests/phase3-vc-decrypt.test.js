#!/usr/bin/env node
'use strict';

/**
 * phase3-vc-decrypt.test.js
 *
 * Phase 3 gate: verify the VC-first decryptFromIagon logic.
 *
 * Checks (local module tests — no live Iagon calls):
 *   1. VC-first path: valid VC → correct plaintext decrypted
 *   2. VC-first path: tampered VC signature → ManifestVCInvalid thrown
 *   3. Iagon manifest fallback: no VC → encryptionManifestId path used
 *   4. Legacy path: no VC, no manifest, encryptionInfo.key present → decrypts
 *   5. Legacy path: no VC, no manifest, missing key → DocumentKeyUnavailable error
 *
 * These tests exercise the decryptFromIagon logic directly through mocked
 * iagonClient and VCVerifier, without hitting live services.
 *
 * Run: node company-admin-portal/tests/phase3-vc-decrypt.test.js
 */

const assert  = require('assert');
const path    = require('path');
const crypto  = require('crypto');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});

const KeyManifestVCIssuer   = require('../lib/KeyManifestVCIssuer');
const KeyManifestVCVerifier = require(path.join(__dirname, '..', '..', 'identus-document-service', 'lib', 'KeyManifestVCVerifier'));
const ClassificationKeyManager = require('../lib/ClassificationKeyManager');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIssuer() {
  const issuer = new KeyManifestVCIssuer(null, 'test');
  issuer._push = async () => {};
  return issuer;
}

ClassificationKeyManager.load(); // load CMK from env

/**
 * Build a minimal decryptFromIagon function that mirrors the server's implementation
 * but uses injectable dependencies (iagonClient, vcStore, verifier, cmk).
 */
function buildDecryptFromIagon({ iagonClient, vcStore, cmk }) {
  const verifier = new KeyManifestVCVerifier({
    inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
  });

  class ManifestVCInvalid extends Error {
    constructor(reason) { super(`ManifestVCInvalid: ${reason}`); this.name = 'ManifestVCInvalid'; }
  }

  async function fetchVC(docDID) {
    return vcStore.get(docDID) || null;
  }

  async function decryptFromIagon(storage, classLevel, docDIDForVC = null) {
    // ── VC-first path ─────────────────────────────────────────────────────
    if (docDIDForVC) {
      const vcRecord = await fetchVC(docDIDForVC);
      if (vcRecord) {
        const result = await verifier.verify(vcRecord);
        if (!result.valid) throw new ManifestVCInvalid(result.reason);
        const { claims } = result;
        const rawDEK = cmk.unwrapDEK(claims, classLevel);
        const fullEncInfo = {
          algorithm: claims.fileAlgorithm || 'AES-256-GCM',
          iv:        claims.fileIv,
          authTag:   claims.fileAuthTag,
          key:       rawDEK.toString('base64')
        };
        const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
        rawDEK.fill(0);
        return content;
      }
    }
    // ── Iagon manifest path ────────────────────────────────────────────────
    if (storage.encryptionManifestId) {
      const wrappedManifest = await iagonClient.downloadKeyManifest(storage.encryptionManifestId);
      const rawDEK = cmk.unwrapDEK(wrappedManifest, classLevel);
      const fullEncInfo = { ...storage.encryptionInfo, key: rawDEK.toString('base64') };
      const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
      rawDEK.fill(0);
      return content;
    }
    // ── Legacy path ────────────────────────────────────────────────────────
    if (storage.encryptionInfo && !storage.encryptionInfo.key) {
      throw new Error('DocumentKeyUnavailable: encryption key missing from registry — document must be re-uploaded');
    }
    return iagonClient.downloadFile(storage.fileId, storage.encryptionInfo || null);
  }

  return { decryptFromIagon, ManifestVCInvalid };
}

/**
 * Encrypt plaintext with AES-256-GCM using a raw DEK.
 * Returns { ciphertext, iv, authTag }.
 */
function aesEncrypt(plaintext, rawDEK) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawDEK, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

// ── Test 1: valid VC → correct plaintext ──────────────────────────────────────

test('VC-first path: valid VC yields correct decrypted plaintext', async () => {
  const docDID  = 'did:prism:phase3test' + crypto.randomBytes(4).toString('hex');
  const plaintext = Buffer.from('Hello from Phase 3 test!', 'utf8');

  // Generate a fresh DEK and encrypt
  const rawDEK = crypto.randomBytes(32);
  const encrypted = aesEncrypt(plaintext, rawDEK);

  // Wrap DEK with INTERNAL CMK
  const wrappedManifest = ClassificationKeyManager.wrapDEK(rawDEK, 'INTERNAL');

  // Issue a VC for this document
  const issuer = makeIssuer();
  const { vcJwt } = await issuer.issue({
    issuerDID:           'did:prism:issuer',
    documentDID:         docDID,
    iagonFileId:         'file-test',
    wrappedKey:          wrappedManifest.wrappedKey,
    iv:                  wrappedManifest.iv,
    authTag:             wrappedManifest.authTag,
    wrappingAlgorithm:   'AES-256-GCM',
    classificationLevel: 'INTERNAL',
    fileIv:              encrypted.iv,
    fileAuthTag:         encrypted.authTag,
    fileAlgorithm:       'AES-256-GCM',
    releasableTo:        []
  });

  // Mock iagonClient — returns ciphertext for fileId, never called for manifest
  const mockIagon = {
    downloadFile: async (fileId, encInfo) => {
      // Decrypt with provided key
      const key = Buffer.from(encInfo.key, 'base64');
      const iv  = Buffer.from(encInfo.iv, 'base64');
      const tag = Buffer.from(encInfo.authTag, 'base64');
      const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(tag);
      return Buffer.concat([dec.update(encrypted.ciphertext), dec.final()]);
    },
    downloadKeyManifest: async () => { throw new Error('Should not hit Iagon manifest path'); }
  };

  const vcStore = new Map([[docDID, { vcJwt, documentDID: docDID }]]);
  const { decryptFromIagon } = buildDecryptFromIagon({
    iagonClient: mockIagon,
    vcStore,
    cmk: ClassificationKeyManager
  });

  const result = await decryptFromIagon({ fileId: 'file-test' }, 'INTERNAL', docDID);
  assert.ok(Buffer.isBuffer(result), 'Result must be a Buffer');
  assert.strictEqual(result.toString('utf8'), 'Hello from Phase 3 test!');
});

// ── Test 2: tampered VC → ManifestVCInvalid ───────────────────────────────────

test('VC-first path: tampered VC signature throws ManifestVCInvalid', async () => {
  const docDID  = 'did:prism:phase3test' + crypto.randomBytes(4).toString('hex');
  const issuer  = makeIssuer();
  const { vcJwt } = await issuer.issue({
    issuerDID:           'did:prism:issuer',
    documentDID:         docDID,
    iagonFileId:         'f',
    wrappedKey:          crypto.randomBytes(32).toString('base64'),
    iv:                  crypto.randomBytes(12).toString('base64'),
    authTag:             crypto.randomBytes(16).toString('base64'),
    wrappingAlgorithm:   'AES-256-GCM',
    classificationLevel: 'INTERNAL',
    fileIv:              crypto.randomBytes(12).toString('base64'),
    fileAuthTag:         crypto.randomBytes(16).toString('base64'),
    fileAlgorithm:       'AES-256-GCM',
    releasableTo:        []
  });

  // Tamper: flip last char of signature
  const parts = vcJwt.split('.');
  const sig = parts[2];
  parts[2] = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const tamperedVcJwt = parts.join('.');

  const vcStore = new Map([[docDID, { vcJwt: tamperedVcJwt, documentDID: docDID }]]);
  const { decryptFromIagon, ManifestVCInvalid } = buildDecryptFromIagon({
    iagonClient: { downloadFile: async () => Buffer.alloc(0), downloadKeyManifest: async () => ({}) },
    vcStore,
    cmk: ClassificationKeyManager
  });

  let thrown = null;
  try {
    await decryptFromIagon({ fileId: 'f' }, 'INTERNAL', docDID);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'Must throw an error for tampered VC');
  assert.ok(
    thrown.name === 'ManifestVCInvalid' || thrown.message.includes('ManifestVCInvalid'),
    `Expected ManifestVCInvalid, got: ${thrown.message}`
  );
});

// ── Test 3: no VC → Iagon manifest path used ──────────────────────────────────

test('No VC for docDID → falls through to Iagon manifest path', async () => {
  const docDID = 'did:prism:phase3test' + crypto.randomBytes(4).toString('hex');
  const rawDEK = crypto.randomBytes(32);
  const plaintext = Buffer.from('manifest path test', 'utf8');
  const encrypted = aesEncrypt(plaintext, rawDEK);

  const wrappedManifest = ClassificationKeyManager.wrapDEK(rawDEK, 'INTERNAL');

  let iagonManifestCalled = false;
  const mockIagon = {
    downloadFile: async (fileId, encInfo) => {
      const key = Buffer.from(encInfo.key, 'base64');
      const iv  = Buffer.from(encInfo.iv, 'base64');
      const tag = Buffer.from(encInfo.authTag, 'base64');
      const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(tag);
      return Buffer.concat([dec.update(encrypted.ciphertext), dec.final()]);
    },
    downloadKeyManifest: async (manifestId) => {
      iagonManifestCalled = true;
      return wrappedManifest;
    }
  };

  const vcStore = new Map(); // empty — no VC
  const { decryptFromIagon } = buildDecryptFromIagon({
    iagonClient: mockIagon,
    vcStore,
    cmk: ClassificationKeyManager
  });

  const storage = {
    fileId: 'file-123',
    encryptionManifestId: 'manifest-abc',
    encryptionInfo: { algorithm: 'AES-256-GCM', iv: encrypted.iv, authTag: encrypted.authTag }
  };

  const result = await decryptFromIagon(storage, 'INTERNAL', docDID);
  assert.ok(iagonManifestCalled, 'Iagon manifest must have been fetched');
  assert.strictEqual(result.toString('utf8'), 'manifest path test');
});

// ── Test 4: legacy path with raw key ─────────────────────────────────────────

test('Legacy path: raw key in encryptionInfo → decrypts successfully', async () => {
  const rawDEK = crypto.randomBytes(32);
  const plaintext = Buffer.from('legacy path', 'utf8');
  const encrypted = aesEncrypt(plaintext, rawDEK);

  const mockIagon = {
    downloadFile: async (fileId, encInfo) => {
      const key = Buffer.from(encInfo.key, 'base64');
      const iv  = Buffer.from(encInfo.iv, 'base64');
      const tag = Buffer.from(encInfo.authTag, 'base64');
      const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(tag);
      return Buffer.concat([dec.update(encrypted.ciphertext), dec.final()]);
    },
    downloadKeyManifest: async () => { throw new Error('Should not be called'); }
  };

  const vcStore = new Map(); // empty
  const { decryptFromIagon } = buildDecryptFromIagon({
    iagonClient: mockIagon,
    vcStore,
    cmk: ClassificationKeyManager
  });

  const storage = {
    fileId: 'f',
    encryptionInfo: {
      algorithm: 'AES-256-GCM',
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      key: rawDEK.toString('base64') // legacy raw key
    }
  };

  const result = await decryptFromIagon(storage, 'INTERNAL'); // no docDIDForVC
  assert.strictEqual(result.toString('utf8'), 'legacy path');
});

// ── Test 5: missing key in legacy path ───────────────────────────────────────

test('Legacy path: encryptionInfo without key throws DocumentKeyUnavailable', async () => {
  const vcStore = new Map();
  const { decryptFromIagon } = buildDecryptFromIagon({
    iagonClient: { downloadFile: async () => {}, downloadKeyManifest: async () => {} },
    vcStore,
    cmk: ClassificationKeyManager
  });

  const storage = {
    fileId: 'f',
    encryptionInfo: { algorithm: 'AES-256-GCM', iv: 'iv', authTag: 'tag' } // no key!
  };

  let thrown = null;
  try {
    await decryptFromIagon(storage, 'INTERNAL'); // no docDIDForVC
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'Must throw for missing key');
  assert.ok(
    thrown.message.includes('DocumentKeyUnavailable'),
    `Expected DocumentKeyUnavailable, got: ${thrown.message}`
  );
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 3 — VC-first decryptFromIagon');
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
    console.log('\n[Phase 3 GATE FAILED] Fix failures before proceeding to Phase 4.');
    process.exit(1);
  } else {
    console.log('\n[Phase 3 GATE PASSED] VC-first decryption logic correct.');
    process.exit(0);
  }
})();
