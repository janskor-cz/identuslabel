#!/usr/bin/env node
'use strict';

/**
 * link-internal-original-docx.js
 *
 * One-shot fix: the INTERNAL document (did:prism:708499d0...) has no
 * originalDocxFileId, so CONFIDENTIAL users see pre-redacted text
 * [REDACTED - REQUIRES CONFIDENTIAL CLEARANCE] instead of real content.
 *
 * Root cause:
 *   The repair script (repair-internal-doc-key.js) stored a pre-redacted
 *   (INTERNAL-level) DOCX as the main file but never set originalDocxFileId.
 *   When a CONFIDENTIAL user accesses the document, the server falls back to
 *   the main file (pre-redacted), so they see the redaction markers.
 *
 * What this script does:
 *   1. Downloads the original DOCX manifest from Iagon (CONFIDENTIAL-wrapped).
 *   2. Unwraps the DEK with CONFIDENTIAL CMK.
 *   3. Re-wraps the DEK with INTERNAL CMK and uploads a new manifest.
 *   4. Patches the INTERNAL document registry entry with:
 *        originalDocxFileId       = '69e4d66e46753944bcf8cb57'
 *        originalDocxManifestId   = <new manifest ID>
 *        originalDocxEncryptionInfo = { algorithm, keyId, iv, authTag }
 *   5. Persists the registry.
 *
 * After this fix, the server will:
 *   - Detect originalDocxFileId → download original DOCX using INTERNAL CMK
 *   - Apply the user's clearance-level redaction dynamically
 *   => A CONFIDENTIAL user sees CONFIDENTIAL content; RESTRICTED+ is hidden.
 *
 * Usage:
 *   node scripts/link-internal-original-docx.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

const cmk              = require('../lib/ClassificationKeyManager');
const DocumentRegistry = require('../lib/DocumentRegistry');
const { getIagonClient } = require('../lib/IagonStorageClient');

// ── Constants ────────────────────────────────────────────────────────────────

// INTERNAL document — the one that needs the fix
const INTERNAL_DID_PREFIX = 'did:prism:708499d0';

// Original unredacted DOCX (same file used by the CONFIDENTIAL document)
const ORIGINAL_DOCX_FILE_ID     = '69e4d66e46753944bcf8cb57';
const ORIGINAL_DOCX_MANIFEST_ID = '69e4d68546753944bcf8d2d5'; // CONFIDENTIAL-wrapped
const ORIGINAL_DOCX_ENC_INFO    = {
  algorithm: 'AES-256-GCM',
  keyId:     '8ec56731157aba71',
  iv:        '4G4npeVSuNqfVNPb',
  authTag:   'pap8NcP1Nz4QSX0xQHKGCA=='
};
const ORIGINAL_DOCX_CLASSIFICATION = 'CONFIDENTIAL';

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('link-internal-original-docx.js');
  console.log(DRY_RUN ? '  MODE: DRY RUN (no changes)' : '  MODE: LIVE');
  console.log('='.repeat(72));

  // 1. Load CMK and registry
  cmk.load();
  console.log('[CMK] Loaded');

  await DocumentRegistry.initialize();
  console.log('[Registry] Loaded');

  // 2. Find the INTERNAL document
  let internalDID = null;
  let internalDoc = null;
  for (const [did, doc] of DocumentRegistry.documents.entries()) {
    if (did.startsWith(INTERNAL_DID_PREFIX) && doc.classificationLevel === 'INTERNAL') {
      internalDID = did;
      internalDoc = doc;
      break;
    }
  }

  if (!internalDoc) {
    console.error(`[ERROR] Could not find INTERNAL document with DID starting with ${INTERNAL_DID_PREFIX}`);
    process.exit(1);
  }

  console.log('[Registry] Found INTERNAL document:', internalDID.substring(0, 60) + '...');
  console.log('           Current originalDocxFileId:', internalDoc.iagonStorage?.originalDocxFileId || 'MISSING');

  if (internalDoc.iagonStorage?.originalDocxFileId) {
    console.log('[INFO] originalDocxFileId already set — nothing to do.');
    if (!DRY_RUN) process.exit(0);
  }

  const iagon = getIagonClient();

  // 3. Download the CONFIDENTIAL-wrapped manifest for the original DOCX
  console.log('\n[Step 1] Downloading CONFIDENTIAL manifest for original DOCX...');
  console.log('         manifestId:', ORIGINAL_DOCX_MANIFEST_ID);

  const confManifest = await iagon.downloadKeyManifest(ORIGINAL_DOCX_MANIFEST_ID);
  console.log('[Step 1] Manifest downloaded:', JSON.stringify({
    classificationLevel: confManifest.classificationLevel,
    hasWrappedKey: !!confManifest.wrappedKey
  }));

  // 4. Unwrap DEK with CONFIDENTIAL CMK
  console.log('\n[Step 2] Unwrapping DEK with CONFIDENTIAL CMK...');
  const rawDEK = cmk.unwrapDEK(confManifest, ORIGINAL_DOCX_CLASSIFICATION);
  console.log('[Step 2] DEK unwrapped successfully');

  // 5. Re-wrap DEK with INTERNAL CMK
  console.log('\n[Step 3] Re-wrapping DEK with INTERNAL CMK...');
  const internalManifest = cmk.wrapDEK(rawDEK, 'INTERNAL');
  rawDEK.fill(0); // zero raw DEK from memory immediately
  console.log('[Step 3] INTERNAL manifest created');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upload INTERNAL manifest and patch registry.');
    console.log('[DRY RUN] Done — no changes made.');
    return;
  }

  // 6. Upload new INTERNAL-wrapped manifest to Iagon
  console.log('\n[Step 4] Uploading INTERNAL manifest to Iagon...');
  const { manifestFileId } = await iagon.uploadKeyManifest(
    internalManifest,
    `original-docx-internal-${Date.now()}`
  );
  console.log('[Step 4] Manifest uploaded — manifestFileId:', manifestFileId);

  // 7. Patch registry entry
  console.log('\n[Step 5] Patching INTERNAL document registry entry...');
  const patched = {
    ...internalDoc,
    iagonStorage: {
      ...internalDoc.iagonStorage,
      originalDocxFileId:       ORIGINAL_DOCX_FILE_ID,
      originalDocxManifestId:   manifestFileId,
      originalDocxEncryptionInfo: ORIGINAL_DOCX_ENC_INFO
    },
    updatedAt: new Date().toISOString()
  };

  DocumentRegistry.documents.set(internalDID, patched);

  await DocumentRegistry.persistence.saveRegistry(
    DocumentRegistry.documents,
    DocumentRegistry.documentVersions
  );
  console.log('[Step 5] Registry patched and persisted.');

  console.log('\n' + '='.repeat(72));
  console.log('DONE');
  console.log('  INTERNAL document now has originalDocxFileId pointing to the');
  console.log('  original unredacted DOCX, with a manifest wrapped by INTERNAL CMK.');
  console.log('  CONFIDENTIAL users accessing the INTERNAL document will now');
  console.log('  receive the original DOCX with only RESTRICTED+ content redacted.');
  console.log('  New originalDocxManifestId:', manifestFileId);
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
