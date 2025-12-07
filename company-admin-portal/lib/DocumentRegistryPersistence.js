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
   * @returns {Promise<void>}
   */
  async saveRegistry(documentsMap) {
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

      const registryState = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        documentCount: documentsArray.length,
        documents: documentsArray
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
   * @returns {Promise<Map|null>} - Restored documents Map, or null if no saved state
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

      for (const doc of registryState.documents) {
        // Reconstruct encryptedMetadata Map
        const encryptedMetadata = new Map();
        for (const entry of doc.encryptedMetadata) {
          const { companyDID, ...data } = entry;
          encryptedMetadata.set(companyDID, data);
        }

        // Reconstruct Bloom filter Buffer
        const bloomFilter = Buffer.from(doc.bloomFilter, 'base64');

        // Add to Map
        documentsMap.set(doc.documentDID, {
          documentDID: doc.documentDID,
          bloomFilter,
          encryptedMetadata,
          releasableTo: doc.releasableTo,
          classificationLevel: doc.classificationLevel,
          contentEncryptionKey: doc.contentEncryptionKey,
          metadataVCRecordId: doc.metadataVCRecordId || null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt
        });
      }

      console.log(`[RegistryPersistence] ✅ Loaded ${documentsMap.size} documents from ${registryState.savedAt}`);

      return documentsMap;

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
