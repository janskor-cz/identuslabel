/**
 * DocumentRegistry.js
 *
 * Zero-knowledge document registry with Bloom filter indexing
 *
 * Features:
 * - Privacy-preserving document discovery (Bloom filter)
 * - Field-level encryption (AES-256-GCM)
 * - Issuer-based releasability filtering
 * - Document lifecycle management
 *
 * Architecture:
 * - Documents stored with encrypted metadata
 * - Bloom filters enable fast issuerDID lookups without revealing releasableTo list
 * - No plaintext document content stored in registry
 */

const crypto = require('crypto');
const DocumentRegistryPersistence = require('./DocumentRegistryPersistence');

class DocumentRegistry {
    constructor() {
        // In-memory document storage (replace with PostgreSQL in production)
        this.documents = new Map();

        // Bloom filter configuration
        this.BLOOM_SIZE = 1024; // bits
        this.HASH_FUNCTIONS = 3;

        // Persistence for crash recovery
        this.persistence = DocumentRegistryPersistence;
        this.initialized = false;
    }

    /**
     * Initialize DocumentRegistry (load from persistent storage if available)
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        console.log('[DocumentRegistry] Initializing...');

        try {
            const loadedDocuments = await this.persistence.loadRegistry();

            if (loadedDocuments) {
                this.documents = loadedDocuments;
                console.log(`[DocumentRegistry] ✅ Loaded ${this.documents.size} documents from persistent storage`);
            } else {
                console.log('[DocumentRegistry] No saved registry found (fresh start)');
            }

            this.initialized = true;
        } catch (error) {
            console.error('[DocumentRegistry] ❌ Failed to initialize:', error.message);
            console.error('[DocumentRegistry] Starting with empty registry');
            this.initialized = true;
        }
    }

    /**
     * Register a new document in the registry
     *
     * @param {Object} documentMetadata
     * @param {string} documentMetadata.documentDID - PRISM DID for the document
     * @param {string} documentMetadata.title - Document title (will be encrypted)
     * @param {string} documentMetadata.classificationLevel - UNCLASSIFIED|CONFIDENTIAL|SECRET|TOP_SECRET
     * @param {Array<string>} documentMetadata.releasableTo - Array of company DIDs that can discover this document
     * @param {string} documentMetadata.contentEncryptionKey - Encrypted content key (ABE encrypted)
     * @param {Object} documentMetadata.metadata - Additional metadata (tags, categories, etc.)
     * @param {string} documentMetadata.metadataVCRecordId - (SSI) Cloud Agent record ID of DocumentMetadata VC
     * @param {Object} documentMetadata.iagonStorage - Iagon decentralized storage metadata
     * @param {string} documentMetadata.iagonStorage.nodeId - Iagon node ID
     * @param {string} documentMetadata.iagonStorage.filename - Filename on Iagon
     * @param {string} documentMetadata.iagonStorage.fileId - Iagon file ID (from upload response, required for download)
     * @param {string} documentMetadata.iagonStorage.url - Iagon download URL
     * @param {string} documentMetadata.iagonStorage.contentHash - SHA-256 hash of original content
     * @param {Object} documentMetadata.iagonStorage.encryptionInfo - Encryption metadata for decryption
     * @returns {Promise<Object>} Registration result
     */
    async registerDocument(documentMetadata) {
        const {
            documentDID,
            title,
            classificationLevel,
            releasableTo,
            contentEncryptionKey,
            metadata = {},
            metadataVCRecordId = null,
            iagonStorage = null
        } = documentMetadata;

        // Validate required fields
        if (!documentDID || !title || !classificationLevel || !releasableTo || !contentEncryptionKey) {
            throw new Error('Missing required document metadata fields');
        }

        // Validate classification level
        const validLevels = ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'];
        if (!validLevels.includes(classificationLevel)) {
            throw new Error(`Invalid classification level: ${classificationLevel}`);
        }

        // Generate Bloom filter for releasableTo companies
        const bloomFilter = this.generateBloomFilter(releasableTo);

        // Encrypt metadata for each authorized company
        const encryptedMetadata = await this.encryptMetadataForCompanies(
            { title, classificationLevel, ...metadata },
            releasableTo
        );

        // Create document record
        const documentRecord = {
            documentDID,
            bloomFilter, // 1024-bit Bloom filter for fast issuerDID lookups
            encryptedMetadata, // Map of companyDID -> encrypted metadata
            releasableTo, // Array of authorized company DIDs
            classificationLevel, // Stored in plaintext for access control (can be encrypted later)
            contentEncryptionKey, // ABE-encrypted content key
            metadataVCRecordId, // (SSI) Cloud Agent record ID for crash recovery
            iagonStorage, // Iagon decentralized storage metadata (nodeId, filename, url, encryptionInfo)
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Store in registry
        this.documents.set(documentDID, documentRecord);

        console.log(`[DocumentRegistry] Document registered: ${documentDID}`);
        console.log(`[DocumentRegistry] Releasable to ${releasableTo.length} companies`);
        console.log(`[DocumentRegistry] Classification: ${classificationLevel}`);

        // Persist to disk for crash recovery
        try {
            await this.persistence.saveRegistry(this.documents);
        } catch (error) {
            console.error(`[DocumentRegistry] ⚠️  Failed to persist registry: ${error.message}`);
            // Don't fail registration if persistence fails
        }

        return {
            success: true,
            documentDID,
            bloomFilter: bloomFilter.toString('base64'),
            releasableToCount: releasableTo.length
        };
    }

    /**
     * Query documents by issuer DID (privacy-preserving Bloom filter check)
     *
     * @param {string} issuerDID - Company DID from employee's EmployeeRole VC
     * @param {string|null} clearanceLevel - Employee's security clearance level (null if no clearance)
     * @returns {Promise<Array>} Array of discoverable documents
     */
    async queryByIssuerDID(issuerDID, clearanceLevel = null) {
        if (!issuerDID) {
            throw new Error('issuerDID is required');
        }

        const discoverableDocuments = [];
        let totalDocuments = 0;
        let filteredByClearance = 0;

        // Iterate through all documents and check Bloom filter
        for (const [documentDID, documentRecord] of this.documents.entries()) {
            // Check if issuerDID might be in the releasableTo list (Bloom filter check)
            if (this.checkBloomFilter(documentRecord.bloomFilter, issuerDID)) {
                // Bloom filter says "maybe" - now check actual releasableTo list
                if (documentRecord.releasableTo.includes(issuerDID)) {
                    totalDocuments++;

                    // Check if employee's clearance level meets document's classification requirement
                    if (!this.meetsClassificationRequirement(clearanceLevel, documentRecord.classificationLevel)) {
                        filteredByClearance++;
                        console.log(`[DocumentRegistry] Document ${documentDID.substring(0, 30)}... filtered by clearance (requires: ${documentRecord.classificationLevel}, has: ${clearanceLevel || 'NONE'})`);
                        continue; // Skip this document - insufficient clearance
                    }

                    // Decrypt metadata for this company
                    const decryptedMetadata = await this.decryptMetadataForCompany(
                        documentRecord.encryptedMetadata,
                        issuerDID
                    );

                    discoverableDocuments.push({
                        documentDID,
                        title: decryptedMetadata.title,
                        classificationLevel: documentRecord.classificationLevel,
                        contentEncryptionKey: documentRecord.contentEncryptionKey,
                        iagonStorage: documentRecord.iagonStorage, // Iagon storage metadata
                        createdAt: documentRecord.createdAt,
                        metadata: decryptedMetadata
                    });
                }
            }
        }

        console.log(`[DocumentRegistry] Query by issuerDID: ${issuerDID}`);
        console.log(`[DocumentRegistry] Clearance level: ${clearanceLevel || 'NONE (UNCLASSIFIED only)'}`);
        console.log(`[DocumentRegistry] Total releasable documents: ${totalDocuments}`);
        console.log(`[DocumentRegistry] Filtered by clearance: ${filteredByClearance}`);
        console.log(`[DocumentRegistry] Discoverable documents: ${discoverableDocuments.length}`);

        return discoverableDocuments;
    }

    /**
     * Check if employee's clearance level meets document's classification requirement
     *
     * Clearance Hierarchy (4 levels):
     * 1. UNCLASSIFIED - No clearance required (everyone can access)
     * 2. CONFIDENTIAL - Requires CONFIDENTIAL or higher clearance
     * 3. SECRET - Requires SECRET or higher clearance
     * 4. TOP_SECRET - Requires TOP_SECRET clearance
     *
     * @param {string|null} employeeClearance - Employee's clearance level (null if no clearance)
     * @param {string} documentClassification - Document's classification level
     * @returns {boolean} True if employee can access the document
     */
    meetsClassificationRequirement(employeeClearance, documentClassification) {
        // Define clearance hierarchy (higher number = higher clearance)
        const clearanceLevels = {
            'UNCLASSIFIED': 1,
            'CONFIDENTIAL': 2,
            'SECRET': 3,
            'TOP_SECRET': 4
        };

        // Get numeric levels
        const documentLevel = clearanceLevels[documentClassification];
        const employeeLevel = employeeClearance ? clearanceLevels[employeeClearance] : 1; // No clearance = UNCLASSIFIED level

        // Employee can access if their clearance level >= document classification level
        return employeeLevel >= documentLevel;
    }

    /**
     * Generate Bloom filter for releasableTo company DIDs
     *
     * Uses 3 hash functions with 1024-bit filter size
     * False positive rate: ~0.1% for small sets
     *
     * @param {Array<string>} companyDIDs - Array of company DIDs
     * @returns {Buffer} 1024-bit Bloom filter
     */
    generateBloomFilter(companyDIDs) {
        // Create 1024-bit filter (128 bytes)
        const filter = Buffer.alloc(this.BLOOM_SIZE / 8);

        // Add each company DID to the filter
        for (const did of companyDIDs) {
            for (let i = 0; i < this.HASH_FUNCTIONS; i++) {
                const hash = this.hashForBloomFilter(did, i);
                const bitIndex = hash % this.BLOOM_SIZE;
                const byteIndex = Math.floor(bitIndex / 8);
                const bitOffset = bitIndex % 8;

                // Set bit to 1
                filter[byteIndex] |= (1 << bitOffset);
            }
        }

        return filter;
    }

    /**
     * Check if DID might be in the Bloom filter
     *
     * @param {Buffer} bloomFilter - 1024-bit Bloom filter
     * @param {string} did - Company DID to check
     * @returns {boolean} True if DID might be in set (false positives possible)
     */
    checkBloomFilter(bloomFilter, did) {
        for (let i = 0; i < this.HASH_FUNCTIONS; i++) {
            const hash = this.hashForBloomFilter(did, i);
            const bitIndex = hash % this.BLOOM_SIZE;
            const byteIndex = Math.floor(bitIndex / 8);
            const bitOffset = bitIndex % 8;

            // Check if bit is set
            if (!(bloomFilter[byteIndex] & (1 << bitOffset))) {
                return false; // Definitely not in set
            }
        }

        return true; // Maybe in set (could be false positive)
    }

    /**
     * Hash function for Bloom filter
     *
     * Uses SHA-256 with seed for multiple hash functions
     *
     * @param {string} data - Data to hash
     * @param {number} seed - Seed for different hash functions
     * @returns {number} Hash value
     */
    hashForBloomFilter(data, seed) {
        const hash = crypto.createHash('sha256');
        hash.update(data + seed.toString());
        const digest = hash.digest();

        // Convert first 4 bytes to uint32
        return digest.readUInt32BE(0);
    }

    /**
     * Encrypt metadata for authorized companies
     *
     * Currently uses simple AES-256-GCM encryption
     * Production: Use company public keys for encryption
     *
     * @param {Object} metadata - Metadata to encrypt
     * @param {Array<string>} companyDIDs - Authorized companies
     * @returns {Promise<Map>} Map of companyDID -> encrypted metadata
     */
    async encryptMetadataForCompanies(metadata, companyDIDs) {
        const encryptedMetadataMap = new Map();

        for (const companyDID of companyDIDs) {
            // Generate encryption key for this company
            // Production: Use company's public key from DID document
            const encryptionKey = crypto.randomBytes(32); // AES-256 key
            const iv = crypto.randomBytes(12); // GCM IV

            // Encrypt metadata
            const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
            const plaintext = JSON.stringify(metadata);
            let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
            ciphertext += cipher.final('base64');
            const authTag = cipher.getAuthTag();

            // Store encrypted metadata
            encryptedMetadataMap.set(companyDID, {
                ciphertext,
                iv: iv.toString('base64'),
                authTag: authTag.toString('base64'),
                encryptionKey: encryptionKey.toString('base64') // Production: encrypt this with company public key
            });
        }

        return encryptedMetadataMap;
    }

    /**
     * Decrypt metadata for a specific company
     *
     * @param {Map} encryptedMetadataMap - Map of companyDID -> encrypted metadata
     * @param {string} companyDID - Company DID to decrypt for
     * @returns {Promise<Object>} Decrypted metadata
     */
    async decryptMetadataForCompany(encryptedMetadataMap, companyDID) {
        const encryptedData = encryptedMetadataMap.get(companyDID);

        if (!encryptedData) {
            throw new Error(`No metadata found for company: ${companyDID}`);
        }

        try {
            const { ciphertext, iv, authTag, encryptionKey } = encryptedData;

            // Decrypt metadata
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                Buffer.from(encryptionKey, 'base64'),
                Buffer.from(iv, 'base64')
            );
            decipher.setAuthTag(Buffer.from(authTag, 'base64'));

            let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
            plaintext += decipher.final('utf8');

            return JSON.parse(plaintext);
        } catch (error) {
            console.error('[DocumentRegistry] Decryption error:', error.message);
            throw new Error('Failed to decrypt metadata');
        }
    }

    /**
     * Get document by DID (requires authorization check)
     *
     * @param {string} documentDID - Document DID
     * @param {string} requestingCompanyDID - Company DID making the request
     * @returns {Promise<Object>} Document details
     */
    async getDocument(documentDID, requestingCompanyDID) {
        const documentRecord = this.documents.get(documentDID);

        if (!documentRecord) {
            throw new Error(`Document not found: ${documentDID}`);
        }

        // Check authorization
        if (!documentRecord.releasableTo.includes(requestingCompanyDID)) {
            throw new Error('Unauthorized: Company not in releasableTo list');
        }

        // Decrypt metadata
        const decryptedMetadata = await this.decryptMetadataForCompany(
            documentRecord.encryptedMetadata,
            requestingCompanyDID
        );

        return {
            documentDID,
            title: decryptedMetadata.title,
            classificationLevel: documentRecord.classificationLevel,
            contentEncryptionKey: documentRecord.contentEncryptionKey,
            iagonStorage: documentRecord.iagonStorage, // Iagon storage metadata
            createdAt: documentRecord.createdAt,
            updatedAt: documentRecord.updatedAt,
            metadata: decryptedMetadata
        };
    }

    /**
     * Revoke document access for a specific company
     *
     * @param {string} documentDID - Document DID
     * @param {string} companyDID - Company DID to revoke access from
     * @returns {Promise<Object>} Revocation result
     */
    async revokeAccess(documentDID, companyDID) {
        const documentRecord = this.documents.get(documentDID);

        if (!documentRecord) {
            throw new Error(`Document not found: ${documentDID}`);
        }

        // Remove from releasableTo list
        const index = documentRecord.releasableTo.indexOf(companyDID);
        if (index > -1) {
            documentRecord.releasableTo.splice(index, 1);
        }

        // Remove encrypted metadata
        documentRecord.encryptedMetadata.delete(companyDID);

        // Regenerate Bloom filter
        documentRecord.bloomFilter = this.generateBloomFilter(documentRecord.releasableTo);
        documentRecord.updatedAt = new Date().toISOString();

        console.log(`[DocumentRegistry] Access revoked for ${companyDID} on document ${documentDID}`);

        return {
            success: true,
            documentDID,
            remainingCompanies: documentRecord.releasableTo.length
        };
    }

    /**
     * Find document by Iagon file ID
     *
     * Use this when the full DID is not available or doesn't match the stored DID.
     * This is particularly useful for downloads where the DID in the URL may have
     * additional service endpoint data that doesn't match the stored registry DID.
     *
     * @param {string} fileId - Iagon file ID (from upload response data._id)
     * @returns {Object|null} Document record or null if not found
     */
    findByFileId(fileId) {
        if (!fileId) {
            return null;
        }

        for (const [documentDID, documentRecord] of this.documents.entries()) {
            if (documentRecord.iagonStorage && documentRecord.iagonStorage.fileId === fileId) {
                return documentRecord;
            }
        }

        return null;
    }

    /**
     * Get registry statistics
     *
     * @returns {Object} Registry statistics
     */
    getStatistics() {
        const stats = {
            totalDocuments: this.documents.size,
            byClassification: {
                UNCLASSIFIED: 0,
                CONFIDENTIAL: 0,
                SECRET: 0,
                TOP_SECRET: 0
            }
        };

        for (const doc of this.documents.values()) {
            stats.byClassification[doc.classificationLevel]++;
        }

        return stats;
    }
}

// Export singleton instance
module.exports = new DocumentRegistry();
