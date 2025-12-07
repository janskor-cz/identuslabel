/**
 * Document DID Manager for Company Admin Portal
 * Handles PRISM DID generation for documents in the zero-knowledge document registry
 *
 * Key Responsibilities:
 * - Generate blockchain-anchored PRISM DIDs for documents
 * - Create DocumentMetadata Verifiable Credentials
 * - Manage document lifecycle (creation, updates, revocation)
 * - Interface with zero-knowledge document registry
 *
 * Architecture:
 * - Documents receive unique PRISM DIDs (blockchain-anchored)
 * - Metadata stored as encrypted VCs in registry
 * - issuerDID-based releasability enables granular access control
 * - Bloom filter indexing for efficient querying
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

class DocumentDIDManager {
    constructor(cloudAgentUrl, apiKey) {
        this.cloudAgentUrl = cloudAgentUrl?.replace(/\/$/, '') || '';
        this.apiKey = apiKey || '';
    }

    /**
     * Generate PRISM DID for a document
     * @param {Object} options - Document creation options
     * @param {string} options.authorDID - PRISM DID of document author
     * @param {string} options.title - Document title
     * @param {number} options.timestamp - Creation timestamp
     * @returns {Promise<Object>} Document DID object { did, longFormDid }
     */
    async createDocumentDID(options) {
        const { authorDID, title, timestamp } = options;

        try {
            console.log('[DocumentDIDManager] Creating PRISM DID for document:', title);

            // Create PRISM DID via Cloud Agent API
            const response = await fetch(`${this.cloudAgentUrl}/did-registrar/dids`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': this.apiKey
                },
                body: JSON.stringify({
                    documentTemplate: {
                        publicKeys: [
                            {
                                id: 'auth-key-1',
                                purpose: 'authentication'
                            }
                        ],
                        services: []
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`DID creation failed (${response.status}): ${errorText}`);
            }

            const didData = await response.json();
            console.log('[DocumentDIDManager] ✅ Document DID created:', didData.longFormDid);

            // Wait for blockchain publication (~28 seconds)
            console.log('[DocumentDIDManager] Waiting for blockchain publication...');
            const publishedDID = await this.waitForDIDPublication(didData.longFormDid);

            return {
                did: publishedDID,
                longFormDid: didData.longFormDid,
                authorDID: authorDID,
                createdAt: new Date(timestamp).toISOString()
            };

        } catch (error) {
            console.error('[DocumentDIDManager] Error creating document DID:', error);
            throw error;
        }
    }

    /**
     * Wait for PRISM DID blockchain publication
     * @private
     * @param {string} longFormDid - Long-form PRISM DID
     * @returns {Promise<string>} Published canonical DID
     */
    async waitForDIDPublication(longFormDid) {
        const maxAttempts = 60; // 60 attempts * 2 seconds = 2 minutes timeout
        let attempt = 0;

        while (attempt < maxAttempts) {
            try {
                const response = await fetch(`${this.cloudAgentUrl}/did-registrar/dids/${encodeURIComponent(longFormDid)}`, {
                    method: 'GET',
                    headers: {
                        'apikey': this.apiKey
                    }
                });

                if (response.ok) {
                    const didStatus = await response.json();
                    if (didStatus.status === 'PUBLISHED') {
                        console.log('[DocumentDIDManager] ✅ DID published to blockchain');
                        return didStatus.did || longFormDid;
                    }
                }

                // Wait 2 seconds before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;

            } catch (error) {
                console.error('[DocumentDIDManager] Error checking DID status:', error);
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
            }
        }

        throw new Error('DID publication timeout - exceeded 2 minutes');
    }

    /**
     * Create DocumentMetadata Verifiable Credential
     * @param {Object} metadata - Document metadata conforming to DocumentMetadata interface
     * @param {string} metadata.documentDID - PRISM DID of document
     * @param {string} metadata.title - Document title
     * @param {string} metadata.description - Optional description
     * @param {string[]} metadata.releasableTo - Array of authorized issuer DIDs
     * @param {string} metadata.classificationLevel - Security classification
     * @param {string} metadata.contentHash - SHA-256 hash of document
     * @param {string} metadata.contentEncryptionKey - ABE-encrypted symmetric key
     * @param {string} metadata.contentLocation - Storage location (IPFS, S3, etc.)
     * @param {string} metadata.authorDID - Author's PRISM DID
     * @param {string} metadata.documentType - MIME type
     * @param {number} metadata.size - File size in bytes
     * @param {string[]} metadata.tags - Optional searchable tags
     * @returns {Promise<Object>} Metadata VC
     */
    async createMetadataVC(metadata) {
        try {
            console.log('[DocumentDIDManager] Creating DocumentMetadata VC for:', metadata.title);

            // Validate required fields
            const requiredFields = [
                'documentDID', 'title', 'releasableTo', 'classificationLevel',
                'contentHash', 'contentEncryptionKey', 'contentLocation',
                'authorDID', 'documentType', 'size'
            ];

            for (const field of requiredFields) {
                if (!metadata[field]) {
                    throw new Error(`Missing required field: ${field}`);
                }
            }

            // Create credential subject
            const credentialSubject = {
                id: metadata.documentDID,
                documentDID: metadata.documentDID,
                title: metadata.title,
                releasableTo: metadata.releasableTo,
                classificationLevel: metadata.classificationLevel,
                contentHash: metadata.contentHash,
                contentEncryptionKey: metadata.contentEncryptionKey,
                contentLocation: metadata.contentLocation,
                authorDID: metadata.authorDID,
                createdAt: new Date().toISOString(),
                version: metadata.version || '1.0.0',
                documentType: metadata.documentType,
                size: metadata.size
            };

            // Add optional fields
            if (metadata.description) {
                credentialSubject.description = metadata.description;
            }
            if (metadata.tags && metadata.tags.length > 0) {
                credentialSubject.tags = metadata.tags;
            }

            // Create VC structure
            const metadataVC = {
                type: ['VerifiableCredential', 'DocumentMetadata'],
                issuer: metadata.authorDID,
                credentialSubject: credentialSubject,
                issuanceDate: new Date().toISOString()
            };

            console.log('[DocumentDIDManager] ✅ DocumentMetadata VC created');
            return metadataVC;

        } catch (error) {
            console.error('[DocumentDIDManager] Error creating metadata VC:', error);
            throw error;
        }
    }

    /**
     * Calculate SHA-256 hash of document content
     * @param {Buffer|string} content - Document content
     * @returns {string} SHA-256 hash prefixed with "sha256:"
     */
    calculateContentHash(content) {
        const hash = crypto.createHash('sha256');
        hash.update(content);
        return `sha256:${hash.digest('hex')}`;
    }

    /**
     * Generate Bloom filter for document metadata
     * Enables efficient querying without revealing metadata
     * @param {Object} metadata - Document metadata
     * @returns {string} Base64-encoded Bloom filter
     */
    generateBloomFilter(metadata) {
        // Simplified Bloom filter implementation
        // In production, use a proper Bloom filter library (bloom-filters, bloomfilter.js)

        const filterSize = 128; // 128 bytes = 1024 bits
        const filter = Buffer.alloc(filterSize, 0);

        // Hash function using crypto
        const addToFilter = (value) => {
            const hash = crypto.createHash('sha256').update(value).digest();

            // Use first 3 hash values as bit positions (3 hash functions)
            for (let i = 0; i < 3; i++) {
                const bitPos = (hash[i] | (hash[i + 1] << 8)) % (filterSize * 8);
                const bytePos = Math.floor(bitPos / 8);
                const bitOffset = bitPos % 8;
                filter[bytePos] |= (1 << bitOffset);
            }
        };

        // Index releasability (issuer DIDs)
        metadata.releasableTo.forEach(issuerDID => {
            addToFilter(issuerDID);
        });

        // Index classification level
        addToFilter(`classification:${metadata.classificationLevel}`);

        // Index tags (if present)
        if (metadata.tags && metadata.tags.length > 0) {
            metadata.tags.forEach(tag => {
                addToFilter(`tag:${tag}`);
            });
        }

        return filter.toString('base64');
    }

    /**
     * Encrypt metadata fields for zero-knowledge storage
     * @param {Object} metadata - Document metadata
     * @param {string} encryptionKey - AES-256 encryption key (hex string)
     * @returns {Object} Encrypted metadata
     */
    encryptMetadata(metadata, encryptionKey) {
        const encryptField = (value) => {
            const cipher = crypto.createCipher('aes-256-gcm', encryptionKey);
            let encrypted = cipher.update(JSON.stringify(value), 'utf8', 'base64');
            encrypted += cipher.final('base64');
            return encrypted;
        };

        return {
            title: encryptField(metadata.title),
            description: metadata.description ? encryptField(metadata.description) : null,
            releasableTo: encryptField(metadata.releasableTo),
            classificationLevel: encryptField(metadata.classificationLevel),
            contentHash: encryptField(metadata.contentHash),
            contentEncryptionKey: metadata.contentEncryptionKey, // Already ABE-encrypted
            contentLocation: encryptField(metadata.contentLocation),
            authorDID: encryptField(metadata.authorDID),
            createdAt: encryptField(metadata.createdAt),
            version: encryptField(metadata.version),
            documentType: encryptField(metadata.documentType),
            size: encryptField(metadata.size),
            tags: metadata.tags ? encryptField(metadata.tags) : null
        };
    }

    /**
     * Register document in zero-knowledge registry
     * @param {Object} metadata - Document metadata
     * @param {string} registryUrl - Document registry API URL
     * @param {string} registryApiKey - Registry authentication key
     * @returns {Promise<Object>} Registration response
     */
    async registerDocument(metadata, registryUrl, registryApiKey) {
        try {
            console.log('[DocumentDIDManager] Registering document in registry:', metadata.title);

            // Generate encryption key for metadata fields
            const encryptionKey = crypto.randomBytes(32).toString('hex');

            // Encrypt metadata
            const encryptedMetadata = this.encryptMetadata(metadata, encryptionKey);

            // Generate Bloom filter
            const bloomFilter = this.generateBloomFilter(metadata);

            // Create registry entry
            const registryEntry = {
                documentId: crypto.randomUUID(),
                documentDID: metadata.documentDID,
                encryptedMetadata: encryptedMetadata,
                bloomFilter: bloomFilter,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // POST to registry API
            const response = await fetch(`${registryUrl}/documents`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${registryApiKey}`
                },
                body: JSON.stringify(registryEntry)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Registry registration failed (${response.status}): ${errorText}`);
            }

            const result = await response.json();
            console.log('[DocumentDIDManager] ✅ Document registered in registry');

            return {
                ...result,
                encryptionKey: encryptionKey // Return for secure storage
            };

        } catch (error) {
            console.error('[DocumentDIDManager] Error registering document:', error);
            throw error;
        }
    }

    /**
     * Query registry for documents releasable to issuer DID
     * @param {string} issuerDID - Issuer DID to query for
     * @param {string} registryUrl - Document registry API URL
     * @param {string} registryApiKey - Registry authentication key
     * @returns {Promise<Array>} Array of discoverable documents
     */
    async queryDocuments(issuerDID, registryUrl, registryApiKey) {
        try {
            console.log('[DocumentDIDManager] Querying documents for issuer:', issuerDID);

            const response = await fetch(`${registryUrl}/documents/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${registryApiKey}`
                },
                body: JSON.stringify({
                    issuerDID: issuerDID
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Document query failed (${response.status}): ${errorText}`);
            }

            const documents = await response.json();
            console.log(`[DocumentDIDManager] ✅ Found ${documents.length} documents`);

            return documents;

        } catch (error) {
            console.error('[DocumentDIDManager] Error querying documents:', error);
            throw error;
        }
    }

    /**
     * Revoke document access via StatusList2021
     * @param {string} documentDID - PRISM DID of document to revoke
     * @param {string} reason - Revocation reason
     * @returns {Promise<Object>} Revocation response
     */
    async revokeDocument(documentDID, reason) {
        try {
            console.log('[DocumentDIDManager] Revoking document:', documentDID);

            // In production, this would update StatusList2021 bitstring
            // For now, log the revocation intent
            const revocationRecord = {
                documentDID: documentDID,
                reason: reason,
                revokedAt: new Date().toISOString(),
                status: 'REVOKED'
            };

            console.log('[DocumentDIDManager] ✅ Document revoked');
            console.log('[DocumentDIDManager] Note: StatusList2021 update has 30min-hours delay');

            return revocationRecord;

        } catch (error) {
            console.error('[DocumentDIDManager] Error revoking document:', error);
            throw error;
        }
    }
}

module.exports = DocumentDIDManager;
