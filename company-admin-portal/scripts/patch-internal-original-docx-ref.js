#!/usr/bin/env node
'use strict';

/**
 * patch-internal-original-docx-ref.js
 *
 * Corrects the INTERNAL document's originalDocxFileId and
 * originalDocxEncryptionInfo to match the actual file that
 * originalDocxManifestId (69efa8ab…) was created for.
 *
 * The manifest 69efa8ab wraps the DEK for file 69e4d66e (the unredacted
 * original DOCX, also referenced by the CONFIDENTIAL document).  The
 * registry currently has the wrong fileId (69efb594) and mismatched
 * encryptionInfo, causing AES-GCM auth-tag failures on every access.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DocumentRegistry = require('../lib/DocumentRegistry');

const INTERNAL_DID_PREFIX = 'did:prism:708499d0';

// Correct values — same file used by CONFIDENTIAL document's originalDocxFileId
const CORRECT_ORIGINAL_DOCX_FILE_ID = '69e4d66e46753944bcf8cb57';
const CORRECT_ORIGINAL_DOCX_ENC_INFO = {
  algorithm: 'AES-256-GCM',
  keyId:     '8ec56731157aba71',
  iv:        '4G4npeVSuNqfVNPb',
  authTag:   'pap8NcP1Nz4QSX0xQHKGCA=='
};

async function main() {
  await DocumentRegistry.initialize();

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
    console.error('INTERNAL document not found');
    process.exit(1);
  }

  const stor = internalDoc.iagonStorage;
  console.log('Current originalDocxFileId      :', stor.originalDocxFileId);
  console.log('Current originalDocxManifestId  :', stor.originalDocxManifestId);
  console.log('Current originalDocxEncInfo.iv  :', stor.originalDocxEncryptionInfo?.iv);
  console.log('');
  console.log('Setting originalDocxFileId →', CORRECT_ORIGINAL_DOCX_FILE_ID);

  const patched = {
    ...internalDoc,
    iagonStorage: {
      ...stor,
      originalDocxFileId:          CORRECT_ORIGINAL_DOCX_FILE_ID,
      originalDocxEncryptionInfo:  CORRECT_ORIGINAL_DOCX_ENC_INFO
      // originalDocxManifestId stays as-is (69efa8ab… — already correct)
    },
    updatedAt: new Date().toISOString()
  };

  DocumentRegistry.documents.set(internalDID, patched);
  await DocumentRegistry.persistence.saveRegistry(
    DocumentRegistry.documents,
    DocumentRegistry.documentVersions
  );

  console.log('Registry saved.');
  console.log('New originalDocxFileId           :', patched.iagonStorage.originalDocxFileId);
  console.log('New originalDocxManifestId       :', patched.iagonStorage.originalDocxManifestId);
  console.log('New originalDocxEncInfo.iv       :', patched.iagonStorage.originalDocxEncryptionInfo.iv);
}

main().catch(err => { console.error(err); process.exit(1); });
