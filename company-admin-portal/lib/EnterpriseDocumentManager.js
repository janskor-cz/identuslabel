/**
 * EnterpriseDocumentManager.js
 *
 * Manages document DID creation and publication via Enterprise Cloud Agent.
 * Document DIDs are owned by the company's department wallet (HR/IT/Security)
 * and published to the blockchain for permanent record.
 *
 * Architecture:
 * - Employee creates document via Employee Portal
 * - Backend calls Enterprise Cloud Agent to create DID
 * - DID is published to blockchain (30-60 second operation)
 * - Document metadata stored in DocumentRegistry with Bloom filter
 * - File stored on Iagon decentralized storage with URL in DID service endpoint
 *
 * @module EnterpriseDocumentManager
 */

const { IagonStorageClient, getIagonClient } = require('./IagonStorageClient');

class EnterpriseDocumentManager {
  /**
   * Initialize the document manager
   * @param {string} enterpriseCloudAgentUrl - Base URL of Enterprise Cloud Agent
   * @param {string} apiKey - API key for authentication (optional, handled by Caddy)
   */
  constructor(enterpriseCloudAgentUrl, apiKey) {
    this.baseUrl = enterpriseCloudAgentUrl;
    this.apiKey = apiKey;
  }

  /**
   * Create and publish a document DID via Enterprise Cloud Agent
   *
   * This is a multi-step process:
   * 1. Create unpublished DID (long-form DID)
   * 2. Submit DID for publication to blockchain
   * 3. Poll for publication status (blockchain confirmation)
   *
   * @param {string} department - Employee's department (HR, IT, Security)
   * @param {object} metadata - Document metadata (title, description, classification)
   * @returns {Promise<string>} - Published DID (canonical form)
   * @throws {Error} - If DID creation or publication fails
   */
  async createDocumentDID(department, metadata) {
    console.log(`[EnterpriseDocManager] Creating document DID for department: ${department}`);
    console.log(`[EnterpriseDocManager] Metadata:`, JSON.stringify(metadata, null, 2));

    try {
      // Step 1: Create unpublished DID (long-form)
      console.log(`[EnterpriseDocManager] Step 1: Creating unpublished DID...`);

      const headers = {
        'Content-Type': 'application/json'
      };

      // Only add apikey header if API key is provided
      if (this.apiKey) {
        headers['apikey'] = this.apiKey;
      }

      const createResponse = await fetch(`${this.baseUrl}/did-registrar/dids`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documentTemplate: {
            publicKeys: [],
            services: []
          }
        })
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create DID (${createResponse.status}): ${errorText}`);
      }

      const createData = await createResponse.json();
      const longFormDid = createData.longFormDid;

      console.log(`[EnterpriseDocManager] Unpublished DID created: ${longFormDid.substring(0, 60)}...`);

      // Step 2: Publish DID to blockchain
      console.log(`[EnterpriseDocManager] Step 2: Publishing DID to blockchain...`);

      const publishHeaders = {
        'Content-Type': 'application/json'
      };

      if (this.apiKey) {
        publishHeaders['apikey'] = this.apiKey;
      }

      const publishResponse = await fetch(
        `${this.baseUrl}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`,
        {
          method: 'POST',
          headers: publishHeaders
        }
      );

      if (!publishResponse.ok) {
        const errorText = await publishResponse.text();
        throw new Error(`Failed to publish DID (${publishResponse.status}): ${errorText}`);
      }

      const publishData = await publishResponse.json();
      const operationId = publishData.scheduledOperation.id;

      console.log(`[EnterpriseDocManager] Publication scheduled: ${operationId}`);

      // Note: Long-form DID is immediately usable without waiting for blockchain publication
      // Blockchain publication happens asynchronously and can take 30-60 seconds
      console.log(`[EnterpriseDocManager] ✅ Document DID created: ${longFormDid.substring(0, 60)}...`);
      console.log(`[EnterpriseDocManager] Note: Blockchain publication in progress (operation ID: ${operationId})`);

      return longFormDid;

    } catch (error) {
      console.error(`[EnterpriseDocManager] ❌ Error creating document DID:`, error);
      throw error;
    }
  }

  /**
   * Wait for DID publication to complete
   *
   * Polls the Enterprise Cloud Agent for publication status.
   * Blockchain publication typically takes 30-60 seconds.
   *
   * @param {string} operationId - Publication operation ID
   * @param {number} maxAttempts - Maximum polling attempts (default: 60 = 120 seconds)
   * @returns {Promise<string>} - Published DID (canonical form)
   * @throws {Error} - If publication times out or fails
   */
  async waitForPublication(operationId, maxAttempts = 60) {
    const pollInterval = 2000; // 2 seconds

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const statusHeaders = {
          'Content-Type': 'application/json'
        };

        if (this.apiKey) {
          statusHeaders['apikey'] = this.apiKey;
        }

        const response = await fetch(
          `${this.baseUrl}/did-registrar/dids/publications/${operationId}`,
          {
            method: 'GET',
            headers: statusHeaders
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[EnterpriseDocManager] Publication status check failed (${response.status}): ${errorText}`);
          throw new Error(`Publication status check failed (${response.status}): ${errorText}`);
        }

        const status = await response.json();

        console.log(`[EnterpriseDocManager] Publication status (attempt ${attempt}/${maxAttempts}): ${status.didState}`);

        if (status.didState === 'PUBLISHED') {
          console.log(`[EnterpriseDocManager] ✅ DID published successfully: ${status.did}`);
          return status.did;
        }

        if (status.didState === 'PUBLICATION_FAILED') {
          throw new Error(`DID publication failed: ${JSON.stringify(status)}`);
        }

        // Still pending, wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));

      } catch (error) {
        console.error(`[EnterpriseDocManager] Error checking publication status (attempt ${attempt}):`, error);

        // If it's the last attempt, throw the error
        if (attempt === maxAttempts) {
          throw new Error(`DID publication timeout after ${maxAttempts * pollInterval / 1000} seconds`);
        }

        // Otherwise, wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`DID publication timeout after ${maxAttempts * pollInterval / 1000} seconds`);
  }

  /**
   * Create a document DID with Iagon service endpoint included BEFORE publication
   *
   * IMPORTANT: PRISM DIDs are immutable after blockchain publication.
   * The Iagon URL MUST be included in the DID document BEFORE publication.
   *
   * Flow:
   * 1. Receive Iagon file ID and URL (file already uploaded)
   * 2. Create unpublished DID with Iagon service endpoint
   * 3. Publish DID to blockchain
   *
   * @param {string} department - Employee's department (HR, IT, Security)
   * @param {object} metadata - Document metadata (title, description, classification)
   * @param {object} iagonInfo - Iagon storage info { fileId, downloadUrl }
   * @returns {Promise<object>} - Result with DID and operation details
   */
  async createDocumentDIDWithServiceEndpoint(department, metadata, iagonInfo) {
    console.log(`[EnterpriseDocManager] Creating document DID with Iagon service endpoint for department: ${department}`);
    console.log(`[EnterpriseDocManager] Iagon fileId: ${iagonInfo.fileId}`);
    console.log(`[EnterpriseDocManager] Classification: ${metadata.classificationLevel || 'UNCLASSIFIED'}`);

    try {
      // Build service endpoint for Iagon storage
      const serviceEndpoint = {
        id: 'iagon-storage',
        type: 'IagonStorage',
        serviceEndpoint: [iagonInfo.downloadUrl]
      };

      console.log(`[EnterpriseDocManager] Service endpoint:`, JSON.stringify(serviceEndpoint, null, 2));

      // Step 1: Create unpublished DID WITH service endpoint
      console.log(`[EnterpriseDocManager] Step 1: Creating unpublished DID with Iagon service endpoint...`);

      const headers = {
        'Content-Type': 'application/json'
      };

      if (this.apiKey) {
        headers['apikey'] = this.apiKey;
      }

      // Create DID with Iagon service endpoint included
      const createResponse = await fetch(`${this.baseUrl}/did-registrar/dids`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documentTemplate: {
            publicKeys: [],
            services: [serviceEndpoint]
          }
        })
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create DID with service endpoint (${createResponse.status}): ${errorText}`);
      }

      const createData = await createResponse.json();
      const longFormDid = createData.longFormDid;

      console.log(`[EnterpriseDocManager] Unpublished DID created with service endpoint: ${longFormDid.substring(0, 60)}...`);

      // Step 2: Publish DID to blockchain
      console.log(`[EnterpriseDocManager] Step 2: Publishing DID to blockchain...`);

      const publishHeaders = {
        'Content-Type': 'application/json'
      };

      if (this.apiKey) {
        publishHeaders['apikey'] = this.apiKey;
      }

      const publishResponse = await fetch(
        `${this.baseUrl}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`,
        {
          method: 'POST',
          headers: publishHeaders
        }
      );

      if (!publishResponse.ok) {
        const errorText = await publishResponse.text();
        throw new Error(`Failed to publish DID (${publishResponse.status}): ${errorText}`);
      }

      const publishData = await publishResponse.json();
      const operationId = publishData.scheduledOperation.id;

      console.log(`[EnterpriseDocManager] Publication scheduled: ${operationId}`);

      // Return comprehensive result
      const result = {
        documentDID: longFormDid,
        operationId: operationId,
        serviceEndpoint: serviceEndpoint,
        iagonFileId: iagonInfo.fileId,
        iagonDownloadUrl: iagonInfo.downloadUrl,
        metadata: {
          title: metadata.title,
          description: metadata.description,
          documentType: metadata.documentType,
          classificationLevel: metadata.classificationLevel || 'UNCLASSIFIED',
          releasableTo: metadata.releasableTo,
          department: department,
          createdAt: new Date().toISOString()
        }
      };

      console.log(`[EnterpriseDocManager] ✅ Document DID created with Iagon service endpoint`);
      console.log(`[EnterpriseDocManager] DID: ${longFormDid.substring(0, 60)}...`);
      console.log(`[EnterpriseDocManager] Service endpoint URL: ${iagonInfo.downloadUrl}`);
      console.log(`[EnterpriseDocManager] Blockchain publication in progress (operation ID: ${operationId})`);

      return result;

    } catch (error) {
      console.error(`[EnterpriseDocManager] ❌ Error creating document DID with service endpoint:`, error);
      throw error;
    }
  }

  /**
   * Create a document DID with Iagon storage integration
   *
   * This method:
   * 1. Uploads the file to Iagon decentralized storage
   * 2. Creates a DID with Iagon URL in service endpoint
   * 3. Returns both the DID and Iagon storage metadata
   *
   * @param {string} department - Employee's department (HR, IT, Security)
   * @param {object} metadata - Document metadata (title, description, classification)
   * @param {Buffer} fileContent - File content as Buffer
   * @param {string} originalFilename - Original filename for extension detection
   * @returns {Promise<object>} - Result with DID and Iagon metadata
   */
  async createDocumentDIDWithStorage(department, metadata, fileContent, originalFilename) {
    console.log(`[EnterpriseDocManager] Creating document DID with Iagon storage for department: ${department}`);
    console.log(`[EnterpriseDocManager] File size: ${fileContent.length} bytes`);
    console.log(`[EnterpriseDocManager] Classification: ${metadata.classificationLevel || 'UNCLASSIFIED'}`);

    // Get Iagon client
    const iagonClient = getIagonClient();

    // Check if Iagon is configured
    if (!iagonClient.isConfigured()) {
      console.warn('[EnterpriseDocManager] Iagon not configured - creating DID without storage');
      const did = await this.createDocumentDID(department, metadata);
      return {
        documentDID: did,
        iagonStorage: null,
        warning: 'Iagon storage not configured. Document DID created without file storage.'
      };
    }

    try {
      // Step 1: Create unpublished DID first to get the DID identifier
      console.log(`[EnterpriseDocManager] Step 1: Creating unpublished DID...`);

      const headers = {
        'Content-Type': 'application/json'
      };

      if (this.apiKey) {
        headers['apikey'] = this.apiKey;
      }

      // Create DID without services first (we'll update after knowing the Iagon URL)
      const createResponse = await fetch(`${this.baseUrl}/did-registrar/dids`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documentTemplate: {
            publicKeys: [],
            services: []
          }
        })
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create DID (${createResponse.status}): ${errorText}`);
      }

      const createData = await createResponse.json();
      const longFormDid = createData.longFormDid;

      console.log(`[EnterpriseDocManager] Unpublished DID created: ${longFormDid.substring(0, 60)}...`);

      // Step 2: Upload file to Iagon
      console.log(`[EnterpriseDocManager] Step 2: Uploading file to Iagon storage...`);

      // Generate filename using DID
      const extension = IagonStorageClient.getExtension(originalFilename);
      const contentHash = iagonClient.calculateContentHash(fileContent);
      const iagonFilename = iagonClient.generateFilename(longFormDid, contentHash.split(':')[1], 1, extension);

      const uploadResult = await iagonClient.uploadFile(fileContent, iagonFilename, {
        classificationLevel: metadata.classificationLevel || 'UNCLASSIFIED'
      });

      console.log(`[EnterpriseDocManager] ✅ File uploaded to Iagon: ${iagonFilename}`);
      console.log(`[EnterpriseDocManager] Iagon URL: ${uploadResult.iagonUrl}`);

      // Step 3: Publish DID to blockchain
      console.log(`[EnterpriseDocManager] Step 3: Publishing DID to blockchain...`);

      const publishHeaders = {
        'Content-Type': 'application/json'
      };

      if (this.apiKey) {
        publishHeaders['apikey'] = this.apiKey;
      }

      const publishResponse = await fetch(
        `${this.baseUrl}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`,
        {
          method: 'POST',
          headers: publishHeaders
        }
      );

      if (!publishResponse.ok) {
        const errorText = await publishResponse.text();
        throw new Error(`Failed to publish DID (${publishResponse.status}): ${errorText}`);
      }

      const publishData = await publishResponse.json();
      const operationId = publishData.scheduledOperation.id;

      console.log(`[EnterpriseDocManager] Publication scheduled: ${operationId}`);

      // Return comprehensive result
      const result = {
        documentDID: longFormDid,
        operationId: operationId,
        iagonStorage: {
          nodeId: uploadResult.nodeId,
          filename: uploadResult.filename,
          fileId: uploadResult.fileId,  // Iagon file ID for download API
          url: uploadResult.iagonUrl,
          contentHash: uploadResult.contentHash,
          encryptionInfo: uploadResult.encryptionInfo,
          uploadedAt: uploadResult.uploadedAt,
          fileSize: uploadResult.fileSize,
          originalSize: uploadResult.originalSize
        },
        metadata: {
          title: metadata.title,
          description: metadata.description,
          classificationLevel: metadata.classificationLevel || 'UNCLASSIFIED',
          department: department,
          createdAt: new Date().toISOString()
        }
      };

      console.log(`[EnterpriseDocManager] ✅ Document DID with Iagon storage created successfully`);
      console.log(`[EnterpriseDocManager] DID: ${longFormDid.substring(0, 60)}...`);
      console.log(`[EnterpriseDocManager] Iagon URL stored for document access`);

      return result;

    } catch (error) {
      console.error(`[EnterpriseDocManager] ❌ Error creating document DID with storage:`, error);
      throw error;
    }
  }

  /**
   * Update an existing DID with Iagon service endpoint
   *
   * Note: PRISM DIDs are immutable once published. This method is for
   * reference and may require re-publishing with a new DID in practice.
   *
   * @param {string} did - The document DID
   * @param {string} iagonUrl - The Iagon download URL
   * @returns {Promise<object>} - Update result
   */
  async addIagonServiceEndpoint(did, iagonUrl) {
    console.log(`[EnterpriseDocManager] Note: PRISM DIDs are immutable after publication.`);
    console.log(`[EnterpriseDocManager] Iagon URL should be stored in DocumentRegistry instead.`);

    // In practice, the Iagon URL is stored in the DocumentRegistry
    // alongside the DID, rather than in the DID document itself
    // (since PRISM DIDs are immutable after blockchain publication)

    return {
      did: did,
      iagonUrl: iagonUrl,
      note: 'Iagon URL stored in DocumentRegistry (DID document is immutable after publication)'
    };
  }

  /**
   * Download a document from Iagon storage
   *
   * @param {object} iagonStorage - Iagon storage metadata from DocumentRegistry
   * @returns {Promise<Buffer>} - Decrypted file content
   */
  async downloadDocument(iagonStorage) {
    const iagonClient = getIagonClient();

    if (!iagonClient.isConfigured()) {
      throw new Error('Iagon storage not configured');
    }

    const { fileId, filename, encryptionInfo } = iagonStorage;

    if (!fileId) {
      throw new Error('No Iagon file ID found - document may have been uploaded before fileId support was added');
    }

    console.log(`[EnterpriseDocManager] Downloading document from Iagon: ${filename} (fileId: ${fileId})`);

    const content = await iagonClient.downloadFile(fileId, encryptionInfo);

    console.log(`[EnterpriseDocManager] ✅ Document downloaded successfully (${content.length} bytes)`);

    return content;
  }

  /**
   * Check Iagon storage status
   *
   * @returns {Promise<object>} - Iagon configuration status
   */
  async checkIagonStatus() {
    const iagonClient = getIagonClient();
    return await iagonClient.testConnection();
  }
}

module.exports = EnterpriseDocumentManager;
