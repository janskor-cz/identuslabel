/**
 * ReEncryptionService.js — Stateless version
 *
 * Performs the cryptographic core of the document access gate:
 *   1. Verify Ed25519 signature on the access request (DID resolution)
 *   2. Replay-attack detection via in-memory nonce cache
 *   3. Clearance level comparison
 *   4. Download document from Iagon (fileId from DID metadata)
 *   5. Re-encrypt for the client's ephemeral X25519 key (NaCl box)
 *
 * Unlike the company-admin-portal version this module is fully stateless:
 *   - No file I/O
 *   - No DocumentRegistry dependency
 *   - Document metadata is passed in (already resolved from the DID document)
 *   - Audit logging is handled externally by AuditEmitter
 */

'use strict';

const crypto = require('crypto');
const zlib   = require('zlib');

/**
 * Check a single bit in a StatusList2021 credential bitstring.
 * Returns 'revoked' | 'valid' | 'check-failed'.
 * Callers treat 'check-failed' as fail-closed (deny access).
 */
async function checkStatusListBit(statusListCredentialUrl, index) {
  try {
    const res  = await fetch(statusListCredentialUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[ReEncryptionService] StatusList fetch returned HTTP ${res.status}`);
      return 'check-failed';
    }
    const data = await res.json();
    const encoded = data.vc?.credentialSubject?.encodedList
                 || data.credentialSubject?.encodedList
                 || data.encodedList;
    if (!encoded) {
      console.warn('[ReEncryptionService] StatusList credential missing encodedList field');
      return 'check-failed';
    }
    const bitstring = zlib.gunzipSync(Buffer.from(encoded, 'base64'));
    const byteIndex = Math.floor(index / 8);
    const bitIndex  = 7 - (index % 8);
    const revoked   = byteIndex < bitstring.length && !!(bitstring[byteIndex] & (1 << bitIndex));
    return revoked ? 'revoked' : 'valid';
  } catch (err) {
    console.warn('[ReEncryptionService] checkStatusListBit failed (fail-closed):', err.message);
    return 'check-failed';
  }
}
const nacl   = require('tweetnacl');
const fetch  = require('node-fetch');

const { IagonStorageClient } = require('./IagonStorageClient');
const cmkStore              = require('./ClassificationKeyManager'); // Task 4: CMK unwrap
const vcStore               = require('./VCKeyStore');               // VC key-manifest store
const KeyManifestVCVerifier = require('./KeyManifestVCVerifier');
const config                = require('../config');

// Singleton verifier — shared across all access requests
const keyManifestVerifier = new KeyManifestVCVerifier({
  legacyHmacKey: config.ADMIN_API_KEY  // backward compat for pre-Phase-2 HS256 VCs
});

// ---------------------------------------------------------------------------
// Replay-attack prevention — in-memory nonce cache (per process)
// In a multi-instance deployment use a shared Redis cache instead.
// ---------------------------------------------------------------------------
const nonceCache   = new Map();
const NONCE_EXPIRY = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Iagon client (singleton)
// ---------------------------------------------------------------------------
const iagonClient = new IagonStorageClient({
  accessToken:     config.IAGON_ACCESS_TOKEN,
  nodeId:          config.IAGON_NODE_ID,
  downloadBaseUrl: config.IAGON_DOWNLOAD_BASE_URL
});

// ---------------------------------------------------------------------------
// Classification level helpers
// ---------------------------------------------------------------------------
const LEVEL_NUMBERS = {
  'UNCLASSIFIED': 0,
  'INTERNAL':     1,
  'CONFIDENTIAL': 2,
  'RESTRICTED':   3,
  'SECRET':       4,
  'TOP-SECRET':   4   // legacy alias
};

const LEVEL_LABELS = {
  0: 'UNCLASSIFIED',
  1: 'INTERNAL',
  2: 'CONFIDENTIAL',
  3: 'RESTRICTED',
  4: 'SECRET'
};

function getLevelNumber(label) {
  return LEVEL_NUMBERS[label] ?? 0;
}

function getLevelLabel(level) {
  return LEVEL_LABELS[level] || 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Replay detection
// ---------------------------------------------------------------------------
function checkReplay(nonce) {
  const now = Date.now();

  // Purge expired nonces
  for (const [n, t] of nonceCache.entries()) {
    if (now - t > NONCE_EXPIRY) nonceCache.delete(n);
  }

  if (nonceCache.has(nonce)) return true;   // replay detected
  nonceCache.set(nonce, now);
  return false;
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification
// ---------------------------------------------------------------------------
/**
 * Verify an Ed25519 signature over the access request payload.
 *
 * Resolves the requestor DID via the Cloud Agent to obtain the authentication
 * public key.  Falls back to format-only validation if DID resolution fails
 * so that newly created DIDs (not yet published) can still access INTERNAL
 * documents during onboarding.
 */
async function verifySignature({ documentDID, ephemeralDID, timestamp, nonce, signature, requestorDID, documentClassificationLevel = 'INTERNAL' }) {
  try {
    const sigBytes = Buffer.from(signature, 'base64');

    if (sigBytes.length !== 64) {
      console.warn('[ReEncryptionService] Invalid signature length:', sigBytes.length);
      return false;
    }

    // Reject stale requests (> 5 minutes)
    const requestTime = new Date(timestamp).getTime();
    if (Math.abs(Date.now() - requestTime) > 5 * 60 * 1000) {
      console.warn('[ReEncryptionService] Timestamp out of window');
      return false;
    }

    // Canonical payload (must match EphemeralDIDCrypto.ts signAccessRequest)
    const payload      = JSON.stringify({ documentId: documentDID, ephemeralDID, timestamp, nonce, requestorDID });
    const messageBytes = new Uint8Array(Buffer.from(payload));

    // Resolve DID to get verification keys
    const resolveUrl = `${config.ENTERPRISE_CLOUD_AGENT_URL}/dids/${encodeURIComponent(requestorDID)}`;
    const headers    = { 'Content-Type': 'application/json' };
    if (config.ENTERPRISE_CLOUD_AGENT_API_KEY) headers['apikey'] = config.ENTERPRISE_CLOUD_AGENT_API_KEY;

    try {
      const res = await fetch(resolveUrl, { method: 'GET', headers, timeout: config.REQUEST_TIMEOUT_MS });

      if (!res.ok) {
        console.warn(`[ReEncryptionService] DID resolution failed (HTTP ${res.status}) for ${requestorDID} — denying (fail-closed)`);
        return false;
      }

      const data   = await res.json();
      const didDoc = data.did || data.document || data;
      const vms    = didDoc.verificationMethods || didDoc.authentication || [];

      if (vms.length === 0) {
        console.warn('[ReEncryptionService] No verification methods found — denying (fail-closed)');
        return false;
      }

      for (const vm of vms) {
        let pubKeyBytes = null;

        if (vm.publicKeyBase64) {
          pubKeyBytes = new Uint8Array(Buffer.from(vm.publicKeyBase64, 'base64'));
        } else if (vm.publicKeyJwk && vm.publicKeyJwk.x) {
          const x       = vm.publicKeyJwk.x.replace(/-/g, '+').replace(/_/g, '/');
          const xPadded = x + '='.repeat((4 - x.length % 4) % 4);
          pubKeyBytes   = new Uint8Array(Buffer.from(xPadded, 'base64'));
        }

        if (!pubKeyBytes || pubKeyBytes.length !== 32) continue;

        try {
          const verified = nacl.sign.detached.verify(messageBytes, new Uint8Array(sigBytes), pubKeyBytes);
          if (verified) {
            console.log(`[ReEncryptionService] Ed25519 signature verified with key: ${vm.id || vm.type}`);
            return true;
          }
        } catch (_) {
          // key type mismatch — try next vm
        }
      }

      console.warn('[ReEncryptionService] Signature did not verify against any key in DID document');
      return false;

    } catch (resolveErr) {
      console.warn('[ReEncryptionService] DID resolution error — denying all levels (fail-closed):', resolveErr.message);
      return false;
    }

  } catch (err) {
    console.error('[ReEncryptionService] Signature verification error:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// XSalsa20-Poly1305 re-encryption
// ---------------------------------------------------------------------------
/**
 * Encrypt plaintext for the client's ephemeral X25519 public key.
 * Returns { ciphertext, nonce, serverPublicKey } — all base64-encoded.
 */
function encryptForEphemeralKey(content, ephemeralPublicKeyBase64) {
  const clientPubKey  = new Uint8Array(Buffer.from(ephemeralPublicKeyBase64, 'base64'));
  const serverKeyPair = nacl.box.keyPair();
  const nonce         = nacl.randomBytes(nacl.box.nonceLength);

  const ciphertext = nacl.box(
    new Uint8Array(content),
    nonce,
    clientPubKey,
    serverKeyPair.secretKey
  );

  return {
    ciphertext:      Buffer.from(ciphertext).toString('base64'),
    nonce:           Buffer.from(nonce).toString('base64'),
    serverPublicKey: Buffer.from(serverKeyPair.publicKey).toString('base64')
  };
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt:  'application/vnd.ms-powerpoint',
  txt:  'text/plain',
  json: 'application/json',
  xml:  'application/xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  html: 'text/html',
  htm:  'text/html'
};

function getMimeType(metadata) {
  if (metadata.mimeType) return metadata.mimeType;
  const filename = metadata.originalFilename || metadata.filename || metadata.iagonFilename || '';
  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && MIME_TYPES[ext]) || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Main: process an access request
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string}  opts.documentDID        — document DID being accessed
 * @param {string}  opts.requestorDID       — holder's DID (from VP)
 * @param {string}  opts.issuerDID          — company DID that issued the VC
 * @param {number}  opts.clearanceLevelNum  — numeric clearance (getLevelNumber)
 * @param {string}  opts.clearanceLevelStr  — string clearance label
 * @param {string}  opts.ephemeralPublicKey — client's X25519 key (base64)
 * @param {string}  opts.signature          — Ed25519 sig over payload (base64)
 * @param {string}  opts.ephemeralDID       — client's ephemeral DID
 * @param {string}  opts.timestamp          — ISO8601 request timestamp
 * @param {string}  opts.nonce              — unique nonce (UUIDv4)
 * @param {object}  opts.docMeta            — resolved DID metadata (from DIDDocumentResolver)
 * @param {string}  [opts.clientIp]
 * @returns {Promise<object>}
 */
async function processAccessRequest(opts) {
  const {
    documentDID, requestorDID, issuerDID, companyDID,
    clearanceLevelNum, clearanceLevelStr,
    ephemeralPublicKey,
    signature, ephemeralDID, timestamp, nonce,
    credentialStatuses,
    docMeta,
    clientIp,
    // Set true only for trusted server-to-server calls (e.g. DIDComm two-step via company-admin).
    // The calling server must authenticate itself via x-ds-key; signature verification is skipped.
    trustedDelegation = false
  } = opts;

  // Step 1: Verify Ed25519 signature (skipped for trusted server-to-server delegation)
  if (!trustedDelegation) {
    const sigValid = await verifySignature({
      documentDID, ephemeralDID, timestamp, nonce, signature, requestorDID,
      documentClassificationLevel: docMeta.clearanceLevel || 'INTERNAL'
    });
    if (!sigValid) {
      return { success: false, error: 'INVALID_SIGNATURE', message: 'Access request signature verification failed' };
    }
  } else {
    console.log('[ReEncryptionService] Signature check skipped — trusted server delegation (company-admin)');
  }

  // Step 2: Replay detection
  if (checkReplay(nonce)) {
    return { success: false, error: 'REPLAY_DETECTED', message: 'Request nonce has already been used' };
  }

  // Step 3: Releasability — issuer DID must be in releasableTo (when the list is non-empty).
  // Skip for personal wallet path (companyDID === null = SecurityClearance-only VP).
  // Also skip when releasableTo is [] — this means the DID was created without an issuer
  // allowlist (new format that avoids PRISM's service-endpoint size limit); clearance
  // level alone governs access in that case.
  if (companyDID !== null && docMeta.releasableTo.length > 0 && !docMeta.releasableTo.includes(companyDID)) {
    console.warn(`[ReEncryptionService] Releasability denied. companyDID=${companyDID}`);
    return { success: false, error: 'RELEASABILITY_DENIED', message: 'Your credential issuer is not authorized for this document' };
  }

  // Step 4: Clearance level
  const requiredLevel = getLevelNumber(docMeta.clearanceLevel);
  if (clearanceLevelNum < requiredLevel) {
    return {
      success: false,
      error:   'CLEARANCE_DENIED',
      message: `Document requires ${docMeta.clearanceLevel}, you have ${clearanceLevelStr}`
    };
  }

  // Step 5: Revocation check via StatusList2021 bitstring (fail-closed — deny on error).
  // Uses the statusListCredential URL embedded in each VC — no agent API key needed.
  for (const cs of (credentialStatuses || [])) {
    if (cs?.statusListCredential && cs?.statusListIndex != null) {
      const result = await checkStatusListBit(cs.statusListCredential, Number(cs.statusListIndex));
      if (result === 'revoked') {
        console.warn(`[ReEncryptionService] Credential revoked at statusListIndex=${cs.statusListIndex}`);
        return { success: false, error: 'CREDENTIAL_REVOKED', message: 'Your security clearance credential has been revoked' };
      }
      if (result === 'check-failed') {
        console.warn(`[ReEncryptionService] Revocation check inconclusive — denying access (fail-closed)`);
        return { success: false, error: 'REVOCATION_CHECK_FAILED', message: 'Could not verify credential revocation status — try again later' };
      }
    }
  }

  // Step 6: Load DocumentKeyManifest VC from local store, verify, unwrap DEK.
  // SSI-ALIGNED: server unwraps DEK for re-encryption to client only (32 bytes).
  // The server NEVER decrypts the file — encryptedBlob is returned raw to the wallet.
  let fileEncMeta  = { algorithm: 'AES-256-GCM', iv: null, authTag: null }; // file encryption params (no key — client decrypts)
  let vcContentHash  = null;
  let rawDEKForClient = null; // will be nacl.box'd for client, then zeroed immediately

  const vcRecord = vcStore.get(documentDID);

  if (vcRecord) {
    // ── New path: VC key store ────────────────────────────────────────────
    const verification = await keyManifestVerifier.verify(vcRecord);
    if (!verification.valid) {
      console.error(`[ReEncryptionService] DocumentKeyManifest VC invalid: ${verification.reason}`);
      return {
        success: false,
        error:   'MANIFEST_VC_INVALID',
        message: `Key manifest credential is invalid: ${verification.reason}`
      };
    }

    const claims = verification.claims;

    // Releasability enforced from VC — single authoritative source.
    if (companyDID !== null &&
        Array.isArray(claims.releasableTo) && claims.releasableTo.length > 0 &&
        !claims.releasableTo.includes(companyDID)) {
      console.warn(`[ReEncryptionService] Releasability denied (from VC manifest). companyDID=${companyDID}`);
      return {
        success: false,
        error:   'RELEASABILITY_DENIED',
        message: 'Your credential issuer is not authorized for this document'
      };
    }

    // CMK-unwrap DEK — kept in scope only for nacl.box re-encryption below
    rawDEKForClient = cmkStore.unwrapDEK({
      wrappedKey:        claims.wrappedKey,
      iv:                claims.iv,
      authTag:           claims.authTag,
      wrappingAlgorithm: claims.wrappingAlgorithm
    }, claims.classificationLevel);

    // File encryption metadata — client uses these to decrypt encryptedBlob
    fileEncMeta = {
      algorithm: claims.fileAlgorithm || 'AES-256-GCM',
      iv:        claims.fileIv,
      authTag:   claims.fileAuthTag
    };
    vcContentHash = claims.contentHash || null;
    console.log(`[ReEncryptionService] Key manifest loaded from VC store (level=${claims.classificationLevel})`);

  } else if (docMeta.iagonEncManifestId) {
    // ── Legacy path: Iagon manifest (backward compat — pre-migration docs) ─
    console.warn(`[ReEncryptionService] No VC in store for ${documentDID.substring(0, 40)}... — falling back to Iagon manifest`);
    try {
      const manifestBytes = await iagonClient.downloadFile(docMeta.iagonEncManifestId, { algorithm: 'none' });
      const manifest      = JSON.parse(manifestBytes.toString('utf8'));

      const manifestReleasableTo = Array.isArray(manifest.releasableTo) && manifest.releasableTo.length > 0
        ? manifest.releasableTo : null;

      if (companyDID !== null && docMeta.releasableTo.length === 0 && manifestReleasableTo) {
        if (!manifestReleasableTo.includes(issuerDID)) {
          console.warn(`[ReEncryptionService] Releasability denied (legacy manifest). issuerDID=${issuerDID}`);
          return { success: false, error: 'RELEASABILITY_DENIED', message: 'Your credential issuer is not authorized for this document' };
        }
      }

      if (manifest.wrappingAlgorithm) {
        const level = docMeta.clearanceLevel || 'INTERNAL';
        rawDEKForClient = cmkStore.unwrapDEK(manifest, level);
        fileEncMeta = {
          algorithm: manifest.fileAlgorithm || 'AES-256-GCM',
          iv:        manifest.fileIv,
          authTag:   manifest.fileAuthTag
        };
        console.log(`[ReEncryptionService] Legacy key manifest loaded (CMK-wrapped, level=${level})`);
      } else {
        // Plain legacy — DEK stored directly in manifest (oldest docs)
        rawDEKForClient = Buffer.from(manifest.key, 'base64');
        fileEncMeta = {
          algorithm: manifest.algorithm || 'AES-256-GCM',
          iv:        manifest.iv,
          authTag:   manifest.authTag
        };
        console.log(`[ReEncryptionService] Legacy key manifest loaded (plain)`);
      }
    } catch (manifestErr) {
      console.error('[ReEncryptionService] Legacy manifest download/unwrap failed:', manifestErr.message);
      return { success: false, error: 'STORAGE_ERROR', message: 'Failed to retrieve encryption key manifest' };
    }
  }

  // Step 7: Re-encrypt DEK (32 bytes) for client's ephemeral X25519 key.
  // SSI principle: server re-encrypts the KEY, never the file content.
  let encrypted = null;
  if (rawDEKForClient) {
    encrypted = encryptForEphemeralKey(rawDEKForClient, ephemeralPublicKey);
    rawDEKForClient.fill(0); // zero DEK immediately after nacl.box
    rawDEKForClient = null;
  }

  // Step 8: Download raw encrypted blob from Iagon — NO decryption.
  // The wallet decrypts this using the DEK it received above.
  let encryptedBlob;
  try {
    encryptedBlob = await iagonClient.downloadFile(docMeta.iagonFileId, { algorithm: 'none' });
  } catch (dlErr) {
    console.error('[ReEncryptionService] Iagon download failed:', dlErr.message);
    return { success: false, error: 'STORAGE_ERROR', message: 'Failed to retrieve document from storage' };
  }

  // Step 9: Generate copy ID for accountability audit trail
  const copyId   = crypto.randomUUID();
  const copyHash = crypto.createHash('sha256').update(encryptedBlob).update(copyId).digest('hex');

  console.log(`[ReEncryptionService] Access GRANTED for ${documentDID.substring(0, 40)}... copyId=${copyId}`);
  console.log(`[ReEncryptionService] Returning encrypted DEK + raw blob (${encryptedBlob.length} bytes) — wallet decrypts`);

  // Content integrity check is performed CLIENT-SIDE after decryption.
  // Server passes contentHash so wallet can verify: sha256(plaintext) === contentHash.
  return {
    success:          true,
    documentDID,
    copyId,
    copyHash,
    filename:         docMeta.originalFilename || docMeta.iagonFilename || 'document',
    mimeType:         getMimeType(docMeta),
    clearanceLevel:   docMeta.clearanceLevel,
    // DEK re-encrypted for client's ephemeral X25519 key (nacl.box)
    ciphertext:       encrypted?.ciphertext      || null,
    nonce:            encrypted?.nonce           || null,
    serverPublicKey:  encrypted?.serverPublicKey || null,
    // Raw encrypted file blob — client decrypts with DEK + fileIv + fileAuthTag
    encryptedBlob:    encryptedBlob.toString('base64'),
    fileIv:           fileEncMeta.iv,
    fileAuthTag:      fileEncMeta.authTag,
    fileAlgorithm:    fileEncMeta.algorithm,
    // Hash for client-side integrity check after decryption
    contentHash:      vcContentHash || docMeta.contentHash || null,
    accessedAt:       new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// resolveDocumentDEK — for DIDComm access flow (DIDComm E2E handles key protection)
// ---------------------------------------------------------------------------
/**
 * Validate access rights and return the raw DEK (base64) + file encryption params.
 * Used by DocumentDIDCommService: DIDComm transport provides E2E encryption so no
 * additional NaCl box wrapping is needed.
 *
 * @param {object} opts  Same keys as processAccessRequest minus ephemeralPublicKey/signature
 * @returns {Promise<{ success: true, dek: string, fileIv, fileAuthTag, fileAlgorithm, contentHash, iagonFileId }
 *                 | { success: false, error, message }>}
 */
async function resolveDocumentDEK(opts) {
  const { documentDID, companyDID, clearanceLevelNum, credentialStatuses, docMeta } = opts;

  // Clearance check
  const requiredLevel = getLevelNumber(docMeta.clearanceLevel);
  if (clearanceLevelNum < requiredLevel) {
    return { success: false, error: 'CLEARANCE_DENIED',
      message: `Document requires ${docMeta.clearanceLevel}` };
  }

  // Releasability from DID metadata
  if (companyDID !== null && docMeta.releasableTo?.length > 0 &&
      !docMeta.releasableTo.includes(companyDID)) {
    return { success: false, error: 'RELEASABILITY_DENIED',
      message: 'Your credential issuer is not authorized for this document' };
  }

  // Revocation check (fail-closed)
  for (const cs of (credentialStatuses || [])) {
    if (cs?.statusListCredential && cs?.statusListIndex != null) {
      const result = await checkStatusListBit(cs.statusListCredential, Number(cs.statusListIndex));
      if (result === 'revoked')      return { success: false, error: 'CREDENTIAL_REVOKED', message: 'Credential revoked' };
      if (result === 'check-failed') return { success: false, error: 'REVOCATION_CHECK_FAILED', message: 'Revocation check failed' };
    }
  }

  // Unwrap DEK from VC store
  const vcRecord = vcStore.get(documentDID);
  if (!vcRecord) {
    return { success: false, error: 'MANIFEST_NOT_FOUND', message: 'No key manifest found for this document' };
  }

  const verification = await keyManifestVerifier.verify(vcRecord);
  if (!verification.valid) {
    return { success: false, error: 'MANIFEST_VC_INVALID', message: verification.reason };
  }

  const claims = verification.claims;

  if (companyDID !== null && Array.isArray(claims.releasableTo) && claims.releasableTo.length > 0
      && !claims.releasableTo.includes(companyDID)) {
    return { success: false, error: 'RELEASABILITY_DENIED', message: 'Your credential issuer is not authorized' };
  }

  const rawDEK = cmkStore.unwrapDEK({
    wrappedKey: claims.wrappedKey, iv: claims.iv, authTag: claims.authTag,
    wrappingAlgorithm: claims.wrappingAlgorithm
  }, claims.classificationLevel);

  const dek = rawDEK.toString('base64');
  rawDEK.fill(0);

  return {
    success:       true,
    dek,
    fileIv:        claims.fileIv,
    fileAuthTag:   claims.fileAuthTag,
    fileAlgorithm: claims.fileAlgorithm || 'AES-256-GCM',
    contentHash:   claims.contentHash || null,
    iagonFileId:   docMeta.iagonFileId
  };
}

// ---------------------------------------------------------------------------
module.exports = { processAccessRequest, resolveDocumentDEK, getLevelNumber, getLevelLabel };
