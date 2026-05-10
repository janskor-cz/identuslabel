#!/usr/bin/env node
'use strict';

/**
 * repair-internal-doc-key.js
 *
 * One-shot repair: re-uploads the INTERNAL document whose encryption key was
 * lost during initial upload, replacing the broken registry entry with a fresh
 * CMK-wrapped file+manifest on Iagon.
 *
 * What it does:
 *   1. Download the CONFIDENTIAL document's original DOCX (originalDocxFileId)
 *      using its manifest (originalDocxManifestId) — this is the same source
 *      DOCX that the INTERNAL version was derived from.
 *   2. Apply INTERNAL-level redaction via DocxRedactionService.
 *   3. Re-upload the redacted DOCX to Iagon with a fresh AES-256-GCM key.
 *   4. Wrap the DEK with the INTERNAL CMK and upload the manifest.
 *   5. Patch the INTERNAL document's registry entry with the new fileId +
 *      encryptionManifestId + encryptionInfo (keyless — CMK path).
 *   6. Persist the registry to disk.
 *
 * Usage (from company-admin-portal directory):
 *   node scripts/repair-internal-doc-key.js [--dry-run]
 *
 * --dry-run: prints what would happen without uploading or modifying the registry.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path    = require('path');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Load services ─────────────────────────────────────────────────────────────
const cmk              = require('../lib/ClassificationKeyManager');
const DocumentRegistry = require('../lib/DocumentRegistry');
const DocxRedactionService = require('../lib/DocxRedactionService');
const { getIagonClient } = require('../lib/IagonStorageClient');

// ── Constants: registry DIDs ──────────────────────────────────────────────────

// INTERNAL document — broken: missing key (long-form DID as stored in registry)
const INTERNAL_DID = 'did:prism:708499d0cef173967c99b8eee56df0cd2f45982e506816b687c6930dcad6b99f:CrUECrIEEjsKB21hc3RlcjAQAUouCglzZWNwMjU2azESIQMRoNaVfS6kBWu3oDOq8Vr95yY0CfVYIZu-T71t-1oBtBqJAQoNaWFnb24tc3RvcmFnZRIMSWFnb25TdG9yYWdlGmpbImh0dHBzOi8vZ3cuaWFnb24uY29tL2FwaS92Mi9kb3dubG9hZD9maWxlSWQ9NjllN2RhMmI0Njc1Mzk0NGJjMDNjNzIxJmZpbGVuYW1lPUFDTUVfVGVzdCUyMCUyODElMjkuZG9jeCJdGr0BCghtZXRhZGF0YRIQRG9jdW1lbnRNZXRhZGF0YRqeAXsiaWFnb25GaWxlSWQiOiI2OWU3ZGEyYjQ2NzUzOTQ0YmMwM2M3MjEiLCJjbGVhcmFuY2VMZXZlbCI6IklOVEVSTkFMIiwiY29udGVudEhhc2giOiJzaGEyNTY6YTIyNTVhYWFjZmQwYzQ0NWMyZWU1MGZjZTE3ZWJiNGZlNzNlZWNlNDY3OTRjZmFlNjE5NzE2MmFmZDFlNTdlMSJ9GjoKBmFjY2VzcxISRG9jdW1lbnRBY2Nlc3NHYXRlGhxodHRwOi8vbG9jYWxob3N0OjMwMjAvYWNjZXNzGmsKFGRvY3VtZW50LWFjY2Vzcy1nYXRlEhJEb2N1bWVudEFjY2Vzc0dhdGUaP2h0dHBzOi8vaWRlbnR1c2xhYmVsLmN6L2NvbXBhbnktYWRtaW4vYXBpL2FjY2Vzcy1nYXRlL2NoYWxsZW5nZQ';

// CONFIDENTIAL document used as DOCX source (first one — has originalDocxFileId)
const CONFIDENTIAL_ORIGINAL_DOCX_FILE_ID     = '69e4d66e46753944bcf8cb57';
const CONFIDENTIAL_ORIGINAL_DOCX_MANIFEST_ID = '69e4d68546753944bcf8d2d5';
const CONFIDENTIAL_CLASSIFICATION            = 'CONFIDENTIAL';

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('repair-internal-doc-key.js');
  console.log(DRY_RUN ? '  MODE: DRY RUN (no changes)' : '  MODE: LIVE');
  console.log('='.repeat(72));

  // 1. Initialise CMK
  cmk.load();
  console.log('[CMK] Loaded');

  // 2. Load registry
  await DocumentRegistry.initialize();
  console.log('[Registry] Loaded');

  // Check the INTERNAL doc exists
  const internalRaw = DocumentRegistry.documents.get(INTERNAL_DID);
  if (!internalRaw) {
    console.error(`[ERROR] INTERNAL document not found in registry: ${INTERNAL_DID}`);
    process.exit(1);
  }
  console.log('[Registry] INTERNAL document found — classificationLevel:', internalRaw.classificationLevel);
  console.log('           Current fileId:', internalRaw.iagonStorage?.fileId);
  console.log('           Has key:', !!internalRaw.iagonStorage?.encryptionInfo?.key);
  console.log('           Has manifest:', !!internalRaw.iagonStorage?.encryptionManifestId);

  const iagon = getIagonClient();

  // 3. Download original DOCX from CONFIDENTIAL document's originalDocxFileId
  console.log('\n[Step 1] Downloading CONFIDENTIAL original DOCX from Iagon...');
  console.log('         fileId:', CONFIDENTIAL_ORIGINAL_DOCX_FILE_ID);
  console.log('         manifestId:', CONFIDENTIAL_ORIGINAL_DOCX_MANIFEST_ID);

  const docxManifest = await iagon.downloadKeyManifest(CONFIDENTIAL_ORIGINAL_DOCX_MANIFEST_ID);
  const docxDEK      = cmk.unwrapDEK(docxManifest, CONFIDENTIAL_CLASSIFICATION);
  const docxEncInfo  = {
    algorithm: 'AES-256-GCM',
    key: docxDEK.toString('base64'),
    iv: docxManifest.iv || null,
    authTag: docxManifest.authTag || null
  };

  // Try to get iv/authTag from the registry entry if not in manifest
  const confDoc = [...DocumentRegistry.documents.values()].find(d =>
    d.iagonStorage?.originalDocxFileId === CONFIDENTIAL_ORIGINAL_DOCX_FILE_ID
  );
  if (confDoc?.iagonStorage?.originalDocxEncryptionInfo) {
    docxEncInfo.iv      = confDoc.iagonStorage.originalDocxEncryptionInfo.iv;
    docxEncInfo.authTag = confDoc.iagonStorage.originalDocxEncryptionInfo.authTag;
  }

  const originalDocxBuffer = await iagon.downloadFile(
    CONFIDENTIAL_ORIGINAL_DOCX_FILE_ID,
    docxEncInfo
  );
  docxDEK.fill(0);
  console.log('[Step 1] Downloaded DOCX —', originalDocxBuffer.length, 'bytes');

  // 4. Apply INTERNAL-level redaction
  console.log('\n[Step 2] Applying INTERNAL-level redaction...');
  const redactedDocx = await DocxRedactionService.applyRedactions(
    originalDocxBuffer,
    'INTERNAL',
    []
  );
  console.log('[Step 2] Redacted DOCX —', redactedDocx.length, 'bytes');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upload redacted DOCX and manifest to Iagon then patch registry.');
    console.log('[DRY RUN] Done — no changes made.');
    return;
  }

  // 5. Upload redacted DOCX to Iagon (encrypted with fresh DEK)
  // Use a unique filename to avoid Iagon's "file with same path already exists" error.
  const uploadFilename = `ACME_Test_internal_${Date.now()}.docx`;
  console.log('\n[Step 3] Uploading redacted DOCX to Iagon as:', uploadFilename);
  const uploadResult = await iagon.uploadFile(
    Buffer.isBuffer(redactedDocx) ? redactedDocx : Buffer.from(redactedDocx),
    uploadFilename
  );
  console.log('[Step 3] Uploaded — fileId:', uploadResult.fileId);
  console.log('          encryptionInfo:', JSON.stringify({
    algorithm: uploadResult.encryptionInfo.algorithm,
    keyId: uploadResult.encryptionInfo.keyId,
    iv: uploadResult.encryptionInfo.iv,
    authTag: uploadResult.encryptionInfo.authTag
  }));

  // 6. Wrap DEK with INTERNAL CMK and upload manifest
  console.log('\n[Step 4] Wrapping DEK with INTERNAL CMK and uploading manifest...');
  const rawDEK         = uploadResult.rawDEK;
  const wrappedManifest = cmk.wrapDEK(rawDEK, 'INTERNAL');
  rawDEK.fill(0);

  const { manifestFileId } = await iagon.uploadKeyManifest(
    wrappedManifest,
    `internal-${Date.now()}`
  );
  console.log('[Step 4] Manifest uploaded — manifestFileId:', manifestFileId);

  // 7. Patch registry entry
  console.log('\n[Step 5] Patching registry entry...');
  const patchedStorage = {
    ...internalRaw.iagonStorage,
    fileId: uploadResult.fileId,
    filename: internalRaw.iagonStorage?.filename || 'ACME_Test (1).docx', // keep original display name
    encryptionManifestId: manifestFileId,
    encryptionInfo: {
      algorithm: uploadResult.encryptionInfo.algorithm,
      keyId: uploadResult.encryptionInfo.keyId,
      iv: uploadResult.encryptionInfo.iv,
      authTag: uploadResult.encryptionInfo.authTag
      // NOTE: no 'key' field — CMK path, key is in manifest
    }
  };

  const patchedRecord = {
    ...internalRaw,
    iagonStorage: patchedStorage,
    updatedAt: new Date().toISOString()
  };

  DocumentRegistry.documents.set(INTERNAL_DID, patchedRecord);

  // Persist
  await DocumentRegistry.persistence.saveRegistry(
    DocumentRegistry.documents,
    DocumentRegistry.documentVersions
  );
  console.log('[Step 5] Registry patched and persisted.');

  console.log('\n' + '='.repeat(72));
  console.log('DONE — INTERNAL document repaired.');
  console.log('  New fileId:      ', uploadResult.fileId);
  console.log('  New manifestId:  ', manifestFileId);
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
