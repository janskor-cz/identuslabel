#!/usr/bin/env node
'use strict';

/**
 * migrate-manifests.js
 *
 * One-shot migration: converts existing Iagon key manifests to DocumentKeyManifest VCs.
 *
 * For each document in DocumentRegistry that has iagonStorage.encryptionManifestId:
 *   1. Download the JSON manifest from Iagon
 *   2. Issue a DocumentKeyManifest VC with the same key material
 *   3. Push the VC to document-service (POST /vc/key-manifest)
 *   4. Record keyManifestVCId in registry
 *   5. --purge: delete the Iagon manifest file and clear encryptionManifestId from registry
 *
 * Flags:
 *   --dry-run   Print what would be done without making any changes
 *   --purge     After confirming VCs are in place, delete Iagon manifest files
 *   --doc <DID> Migrate only one specific document DID
 *
 * Usage:
 *   node scripts/migrate-manifests.js --dry-run
 *   node scripts/migrate-manifests.js
 *   node scripts/migrate-manifests.js --purge
 *
 * Run from the company-admin-portal directory.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');

// Load services
const cmkStore = require('../lib/ClassificationKeyManager');
const DocumentRegistry = require('../lib/DocumentRegistry');
const KeyManifestVCIssuer = require('../lib/KeyManifestVCIssuer');

const DRY_RUN = process.argv.includes('--dry-run');
const PURGE   = process.argv.includes('--purge');
const docArg  = process.argv.indexOf('--doc');
const ONLY_DID = docArg >= 0 ? process.argv[docArg + 1] : null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getIagonClient() {
  const { getIagonClient: _get } = require('../lib/IagonStorageClient');
  return _get();
}

function getCompanyByDID(ownerCompanyDID) {
  const { COMPANIES } = require('../lib/companies');
  if (!ownerCompanyDID) return null;
  return Object.values(COMPANIES || {}).find(c =>
    c.issuerDID === ownerCompanyDID || c.companyDID === ownerCompanyDID
  ) || null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('DocumentKeyManifest VC Migration');
  if (DRY_RUN) console.log('MODE: DRY RUN — no changes will be made');
  if (PURGE)   console.log('MODE: PURGE — Iagon manifests will be deleted after VC issuance');
  if (ONLY_DID) console.log(`SCOPE: single document — ${ONLY_DID}`);
  console.log('='.repeat(72));

  // Initialise CMK store (required for DEK verification only — we reuse existing wrapped keys)
  try {
    cmkStore.load();
  } catch (e) {
    console.error(`⚠️  CMK store load warning (non-fatal for migration): ${e.message}`);
  }

  // Load registry
  await DocumentRegistry.initialize();
  const iagonClient = getIagonClient();

  const adminKey  = process.env.DOCUMENT_SERVICE_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
  if (!adminKey) {
    console.error('❌ DOCUMENT_SERVICE_ADMIN_KEY (or ADMIN_API_KEY) is not set in .env');
    process.exit(1);
  }

  let migrated = 0, skipped = 0, failed = 0, alreadyDone = 0;
  const failures = [];

  for (const [documentDID, doc] of DocumentRegistry.documents.entries()) {
    // Scope filter
    if (ONLY_DID && documentDID !== ONLY_DID) continue;

    const manifestId = doc.iagonStorage?.encryptionManifestId;
    if (!manifestId) { skipped++; continue; }

    if (doc.iagonStorage?.keyManifestVCId) {
      console.log(`  ⏩ Already migrated: ${documentDID.substring(0, 55)}...`);
      alreadyDone++;
      continue;
    }

    const shortDID = documentDID.substring(0, 55) + '...';
    console.log(`\n→ Migrating: ${shortDID}`);
    console.log(`  Manifest ID: ${manifestId}`);

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would download manifest and issue VC');
      migrated++;
      continue;
    }

    try {
      // 1. Download manifest from Iagon
      const manifestBytes = await iagonClient.downloadFile(manifestId, { algorithm: 'none' });
      const manifest      = JSON.parse(manifestBytes.toString('utf8'));

      // 2. Determine document-service URL for this document's company
      const company   = getCompanyByDID(doc.ownerCompanyDID);
      const docSvcUrl = company?.documentServiceUrl;
      if (!docSvcUrl) {
        throw new Error(`No documentServiceUrl for ownerCompanyDID=${doc.ownerCompanyDID}`);
      }

      // 3. Build issuer and issue VC
      const issuer = new KeyManifestVCIssuer(docSvcUrl, adminKey);

      // The existing manifest may be CMK-wrapped (wrappingAlgorithm present) or legacy (raw key).
      // We reuse the wrapped form directly — no need to unwrap + re-wrap.
      let vcParams;
      if (manifest.wrappingAlgorithm) {
        vcParams = {
          issuerDID:           doc.ownerCompanyDID || 'unknown',
          documentDID,
          iagonFileId:         doc.iagonStorage.fileId,
          wrappedKey:          manifest.wrappedKey,
          iv:                  manifest.iv,
          authTag:             manifest.authTag,
          wrappingAlgorithm:   manifest.wrappingAlgorithm,
          classificationLevel: manifest.classificationLevel || doc.classificationLevel || 'INTERNAL',
          fileIv:              manifest.fileIv,
          fileAuthTag:         manifest.fileAuthTag,
          fileAlgorithm:       manifest.fileAlgorithm || 'AES-256-GCM',
          releasableTo:        manifest.releasableTo || doc.releasableTo || [],
          contentHash:         doc.iagonStorage.contentHash || null
        };
      } else {
        // Legacy manifest: raw key. Wrap it now.
        if (!manifest.key) throw new Error('Legacy manifest has no key field');
        const level   = doc.classificationLevel || 'INTERNAL';
        const rawDEK  = Buffer.from(manifest.key, 'base64');
        const wrapped = cmkStore.wrapDEK(rawDEK, level);
        rawDEK.fill(0);

        vcParams = {
          issuerDID:           doc.ownerCompanyDID || 'unknown',
          documentDID,
          iagonFileId:         doc.iagonStorage.fileId,
          wrappedKey:          wrapped.wrappedKey,
          iv:                  wrapped.iv,
          authTag:             wrapped.authTag,
          wrappingAlgorithm:   wrapped.wrappingAlgorithm,
          classificationLevel: wrapped.classificationLevel,
          fileIv:              manifest.iv     || manifest.fileIv,
          fileAuthTag:         manifest.authTag || manifest.fileAuthTag,
          fileAlgorithm:       manifest.algorithm || manifest.fileAlgorithm || 'AES-256-GCM',
          releasableTo:        doc.releasableTo || [],
          contentHash:         doc.iagonStorage.contentHash || null
        };
      }

      const vcResult = await issuer.issue(vcParams);
      console.log(`  ✅ VC issued: ${vcResult.vcId}`);

      // 4. Record VC ID in registry
      doc.iagonStorage.keyManifestVCId = vcResult.vcId;

      // 5. Purge: delete old Iagon manifest (best-effort) + clear field
      if (PURGE) {
        try {
          await iagonClient.deleteFile(doc.iagonStorage.nodeId || process.env.IAGON_NODE_ID, manifestId);
          console.log(`  🗑️  Iagon manifest deleted: ${manifestId}`);
        } catch (delErr) {
          console.warn(`  ⚠️  Could not delete Iagon manifest (non-fatal): ${delErr.message}`);
        }
        delete doc.iagonStorage.encryptionManifestId;
      }

      migrated++;
    } catch (err) {
      console.error(`  ❌ FAILED: ${err.message}`);
      failures.push({ documentDID: shortDID, error: err.message });
      failed++;
    }
  }

  // Persist updated registry
  if (!DRY_RUN && migrated > 0) {
    try {
      await DocumentRegistry.persistence.saveRegistry(
        DocumentRegistry.documents,
        DocumentRegistry.documentVersions
      );
      console.log('\n✅ Registry saved with updated VC IDs');
    } catch (saveErr) {
      console.error(`\n❌ Failed to save registry: ${saveErr.message}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(72));
  console.log('Migration summary');
  console.log(`  Migrated:     ${migrated}`);
  console.log(`  Already done: ${alreadyDone}`);
  console.log(`  Skipped:      ${skipped}  (no encryptionManifestId)`);
  console.log(`  Failed:       ${failed}`);
  if (failures.length) {
    console.log('\nFailed documents:');
    failures.forEach(f => console.log(`  • ${f.documentDID}: ${f.error}`));
  }
  console.log('='.repeat(72));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
