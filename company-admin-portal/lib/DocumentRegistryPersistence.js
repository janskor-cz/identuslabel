/**
 * DocumentRegistryPersistence.js
 *
 * Handles persistence and crash recovery for DocumentRegistry
 *
 * Architecture:
 * - Stores DocumentRegistry state in JSON file
 * - Cryptographic signature for data integrity
 * - Automatic recovery on server startup
 *
 * SSI Principle: "Verifiable data should be recoverable from verifiable sources"
 * - Registry state is cryptographically signed
 * - Signature verified on recovery
 * - Tamper detection through signature validation
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

class DocumentRegistryPersistence {
  constructor() {
    this.storagePath = path.join(__dirname, '..', 'data', 'document-registry.json');
    this.signatureKey = 'document-registry-integrity-key'; // TODO: Use proper key management
  }

  /**
   * Save DocumentRegistry state to persistent storage
   *
   * @param {Map} documentsMap - DocumentRegistry.documents Map
   * @param {Map} [documentVersionsMap] - DocumentRegistry.documentVersions Map
   * @returns {Promise<void>}
   */
  async saveRegistry(documentsMap, documentVersionsMap = new Map()) {
    console.log('[RegistryPersistence] Saving DocumentRegistry to disk...');

    try {
      // Convert Map to serializable array
      const documentsArray = Array.from(documentsMap.entries()).map(([did, record]) => ({
        documentDID: did,
        ...record,
        // Convert nested Maps to plain objects
        encryptedMetadata: Array.from(record.encryptedMetadata.entries()).map(([companyDID, data]) => ({
          companyDID,
          ...data
        })),
        // Convert Buffer to base64 string
        bloomFilter: record.bloomFilter.toString('base64')
      }));

      // Serialize documentVersions Map to array-of-arrays
      const documentVersionsArray = Array.from(documentVersionsMap.entries()).map(([did, versions]) => ({
        documentDID: did,
        versions
      }));

      const registryState = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        documentCount: documentsArray.length,
        documents: documentsArray,
        documentVersions: documentVersionsArray
      };

      // Generate signature for integrity verification
      const dataStr = JSON.stringify(registryState);
      const signature = crypto
        .createHmac('sha256', this.signatureKey)
        .update(dataStr)
        .digest('hex');

      const persistedData = {
        registryState,
        signature,
        signedAt: new Date().toISOString()
      };

      // Ensure data directory exists
      const dataDir = path.dirname(this.storagePath);
      await fs.mkdir(dataDir, { recursive: true });

      // Write to file
      await fs.writeFile(
        this.storagePath,
        JSON.stringify(persistedData, null, 2),
        'utf8'
      );

      console.log(`[RegistryPersistence] ✅ Saved ${documentsArray.length} documents to ${this.storagePath}`);
      console.log(`[RegistryPersistence] Signature: ${signature.substring(0, 16)}...`);

    } catch (error) {
      console.error('[RegistryPersistence] ❌ Failed to save registry:', error.message);
      throw error;
    }
  }

  /**
   * Load DocumentRegistry state from persistent storage
   *
   * @returns {Promise<{documents: Map, documentVersions: Map}|null>}
   */
  async loadRegistry() {
    console.log('[RegistryPersistence] Loading DocumentRegistry from disk...');

    try {
      // Check if file exists
      try {
        await fs.access(this.storagePath);
      } catch {
        console.log('[RegistryPersistence] No saved registry found (first run)');
        return null;
      }

      // Read file
      const fileContent = await fs.readFile(this.storagePath, 'utf8');
      const persistedData = JSON.parse(fileContent);

      // Verify signature
      const dataStr = JSON.stringify(persistedData.registryState);
      const expectedSignature = crypto
        .createHmac('sha256', this.signatureKey)
        .update(dataStr)
        .digest('hex');

      if (persistedData.signature !== expectedSignature) {
        throw new Error('Signature verification failed - registry data may be tampered');
      }

      console.log('[RegistryPersistence] ✅ Signature verified');

      const { registryState } = persistedData;

      // Convert array back to Map
      const documentsMap = new Map();
      let migrationPerformed = false;

      for (const doc of registryState.documents) {
        // Task 3 migration: strip legacy raw key material from persisted documents
        if (doc.contentEncryptionKey) {
          delete doc.contentEncryptionKey;
          migrationPerformed = true;
        }
        if (doc.iagonStorage?.encryptionInfo?.key) {
          delete doc.iagonStorage.encryptionInfo.key;
          migrationPerformed = true;
        }
        // Also strip from originalDocxEncryptionInfo if present
        if (doc.iagonStorage?.originalDocxEncryptionInfo?.key) {
          delete doc.iagonStorage.originalDocxEncryptionInfo.key;
          migrationPerformed = true;
        }

        // Reconstruct encryptedMetadata Map
        const encryptedMetadata = new Map();
        for (const entry of doc.encryptedMetadata) {
          const { companyDID, ...data } = entry;
          encryptedMetadata.set(companyDID, data);
        }

        // Reconstruct Bloom filter Buffer
        const bloomFilter = Buffer.from(doc.bloomFilter, 'base64');

        // Add to Map (contentEncryptionKey intentionally omitted — Task 3)
        documentsMap.set(doc.documentDID, {
          documentDID: doc.documentDID,
          bloomFilter,
          encryptedMetadata,
          releasableTo: doc.releasableTo,
          classificationLevel: doc.classificationLevel,
          metadataVCRecordId: doc.metadataVCRecordId || null,
          iagonStorage: doc.iagonStorage || null, // Iagon storage metadata (fileId, encryptionManifestId — no raw key)
          sectionMetadata: doc.sectionMetadata || null,
          sourceInfo: doc.sourceInfo || null,
          documentType: doc.documentType || null,
          ownerCompanyDID: doc.ownerCompanyDID || null,
          accessLog: doc.accessLog || null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt
        });
      }

      // Restore documentVersions Map
      const documentVersionsMap = new Map();
      if (registryState.documentVersions && Array.isArray(registryState.documentVersions)) {
        for (const entry of registryState.documentVersions) {
          documentVersionsMap.set(entry.documentDID, entry.versions || []);
        }
      }

      console.log(`[RegistryPersistence] ✅ Loaded ${documentsMap.size} documents from ${registryState.savedAt}`);
      console.log(`[RegistryPersistence] ✅ Loaded version history for ${documentVersionsMap.size} documents`);

      // Task 3 migration: persist the cleaned state back to disk so raw keys are removed on-disk
      if (migrationPerformed) {
        console.log('[RegistryPersistence] 🔑 Task 3 migration: raw keys stripped — saving cleaned registry to disk...');
        try {
          await this.saveRegistry(documentsMap, documentVersionsMap);
          console.log('[RegistryPersistence] ✅ Task 3 migration: cleaned registry persisted');
        } catch (saveError) {
          console.error('[RegistryPersistence] ⚠️  Task 3 migration: failed to persist cleaned registry:', saveError.message);
          // Don't fail the load — in-memory state is already clean
        }
      }

      return { documents: documentsMap, documentVersions: documentVersionsMap };

    } catch (error) {
      console.error('[RegistryPersistence] ❌ Failed to load registry:', error.message);
      throw error;
    }
  }

  /**
   * Check if saved registry exists
   *
   * @returns {Promise<boolean>}
   */
  async registryExists() {
    try {
      await fs.access(this.storagePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get storage file path
   *
   * @returns {string}
   */
  getStoragePath() {
    return this.storagePath;
  }
}

module.exports = new DocumentRegistryPersistence();
