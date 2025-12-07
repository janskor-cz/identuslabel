/**
 * DocumentMetadata Verifiable Credential Issuer
 *
 * Issues W3C Verifiable Credentials containing document metadata.
 * This enables SSI-compliant crash recovery by storing metadata
 * in verifiable, cryptographically-signed credentials.
 *
 * SSI Principle: "Verifiable data should be recoverable from verifiable sources"
 */

class DocumentMetadataVC {
  /**
   * @param {string} cloudAgentUrl - Enterprise Cloud Agent URL
   * @param {string} apiKey - Department API key for authentication
   */
  constructor(cloudAgentUrl, apiKey) {
    this.baseUrl = cloudAgentUrl;
    this.apiKey = apiKey;
  }

  /**
   * Issue a DocumentMetadata Verifiable Credential
   *
   * @param {Object} params - VC parameters
   * @param {string} params.issuerDID - Company's issuer DID (holder of the VC)
   * @param {string} params.documentDID - Document's DID (credentialSubject.id)
   * @param {string} params.title - Document title
   * @param {string} params.description - Document description (optional)
   * @param {string} params.classificationLevel - UNCLASSIFIED/CONFIDENTIAL/SECRET/TOP_SECRET
   * @param {Array<string>} params.releasableTo - Array of company issuer DIDs
   * @param {string} params.contentEncryptionKey - ABE-encrypted content key
   * @param {Object} params.metadata - Additional metadata (department, author, etc.)
   * @returns {Promise<Object>} - { recordId, credentialId, credential }
   */
  async issueDocumentMetadataVC(params) {
    const {
      issuerDID,
      documentDID,
      title,
      description,
      classificationLevel,
      releasableTo,
      contentEncryptionKey,
      metadata = {}
    } = params;

    console.log('[DocumentMetadataVC] Issuing VC for document:', documentDID.substring(0, 60) + '...');
    console.log('[DocumentMetadataVC] Classification:', classificationLevel);
    console.log('[DocumentMetadataVC] Releasable to:', releasableTo.length, 'companies');

    // Build W3C Verifiable Credential claims
    const vcClaims = {
      documentDID,
      title,
      classificationLevel,
      releasableTo: releasableTo.join(','), // Join array for JWT compatibility
      contentEncryptionKey,
      createdAt: new Date().toISOString(),
      // Include optional fields if present
      ...(description && { description }),
      ...(metadata.department && { department: metadata.department }),
      ...(metadata.author && { author: metadata.author }),
      ...(metadata.category && { category: metadata.category }),
      ...(metadata.version && { version: metadata.version }),
      ...(metadata.createdBy && { createdBy: metadata.createdBy }),
      ...(metadata.createdByDID && { createdByDID: metadata.createdByDID })
    };

    // Create credential offer via Enterprise Cloud Agent
    const credentialOfferPayload = {
      claims: vcClaims,
      credentialFormat: 'JWT', // Use JWT for broad compatibility
      issuingDID: issuerDID,
      automaticIssuance: true, // Issue immediately without holder acceptance
      connectionId: null // No specific connection - stored in issuer's wallet
    };

    try {
      console.log('[DocumentMetadataVC] Calling Enterprise Cloud Agent...');
      const response = await fetch(`${this.baseUrl}/issue-credentials/credential-offers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiKey
        },
        body: JSON.stringify(credentialOfferPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to issue DocumentMetadata VC: ${response.status} ${errorText}`);
      }

      const vcOffer = await response.json();

      console.log('[DocumentMetadataVC] ✅ VC issued successfully');
      console.log('[DocumentMetadataVC] Record ID:', vcOffer.recordId);

      return {
        recordId: vcOffer.recordId,
        credentialId: vcOffer.credentialId || vcOffer.recordId,
        credential: vcOffer.credential,
        issuedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('[DocumentMetadataVC] ❌ Failed to issue VC:', error.message);
      throw error;
    }
  }

  /**
   * Issue a DocumentMetadata VC to an employee via DIDComm connection
   *
   * This method issues the VC to the employee's wallet via their
   * existing DIDComm connection (session.connectionId).
   *
   * @param {Object} params - VC parameters
   * @param {string} params.connectionId - Employee's DIDComm connection ID
   * @param {string} params.issuerDID - Company's issuer DID
   * @param {string} params.documentDID - Document's DID (contains Iagon URL in service endpoint)
   * @param {string} params.documentTitle - Document title
   * @param {string} params.documentType - Document type (Report, Contract, Policy, etc.)
   * @param {string} params.classificationLevel - UNCLASSIFIED/CONFIDENTIAL/SECRET/TOP_SECRET
   * @param {string} params.documentDescription - Document description (optional)
   * @param {string} params.releasableTo - Comma-separated organizations authorized to receive
   * @param {string} params.createdBy - Name of the employee who created the document
   * @param {string} params.createdByDID - PRISM DID of the employee who created the document
   * @returns {Promise<Object>} - { recordId, credentialId, thid }
   */
  async issueDocumentMetadataVCToEmployee(params) {
    const {
      connectionId,
      issuerDID,
      documentDID,
      documentTitle,
      documentType,
      classificationLevel,
      documentDescription,
      releasableTo,
      createdBy,
      createdByDID
    } = params;

    console.log('[DocumentMetadataVC] Issuing VC via DIDComm to connection:', connectionId);
    console.log('[DocumentMetadataVC] Document DID:', documentDID.substring(0, 60) + '...');
    console.log('[DocumentMetadataVC] Document Type:', documentType);
    console.log('[DocumentMetadataVC] Classification:', classificationLevel);

    // Build W3C Verifiable Credential claims matching the schema
    const vcClaims = {
      documentDID,
      documentTitle,
      documentType,
      classificationLevel,
      createdAt: new Date().toISOString()
    };

    // Add optional fields if present
    if (documentDescription) {
      vcClaims.documentDescription = documentDescription;
    }
    if (releasableTo) {
      vcClaims.releasableTo = releasableTo;
    }
    if (createdBy) {
      vcClaims.createdBy = createdBy;
    }
    if (createdByDID) {
      vcClaims.createdByDID = createdByDID;
    }

    // Create credential offer via Enterprise Cloud Agent
    // Using connectionId to send via DIDComm
    const credentialOfferPayload = {
      claims: vcClaims,
      credentialFormat: 'JWT',
      issuingDID: issuerDID,
      connectionId: connectionId,
      automaticIssuance: true // Auto-issue to employee's wallet
    };

    try {
      console.log('[DocumentMetadataVC] Calling Enterprise Cloud Agent to create offer...');
      const response = await fetch(`${this.baseUrl}/issue-credentials/credential-offers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiKey
        },
        body: JSON.stringify(credentialOfferPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create DocumentMetadata VC offer: ${response.status} ${errorText}`);
      }

      const vcOffer = await response.json();

      console.log('[DocumentMetadataVC] ✅ VC offer created successfully');
      console.log('[DocumentMetadataVC] Record ID:', vcOffer.recordId);
      console.log('[DocumentMetadataVC] Thread ID:', vcOffer.thid);

      return {
        recordId: vcOffer.recordId,
        credentialId: vcOffer.credentialId || vcOffer.recordId,
        thid: vcOffer.thid,
        connectionId: connectionId,
        issuedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('[DocumentMetadataVC] ❌ Failed to create VC offer:', error.message);
      throw error;
    }
  }

  /**
   * Query all DocumentMetadata VCs from Enterprise Cloud Agent
   *
   * This method retrieves all issued DocumentMetadata VCs,
   * enabling crash recovery by reconstructing the DocumentRegistry
   * from verifiable credentials.
   *
   * @returns {Promise<Array>} - Array of DocumentMetadata VCs
   */
  async queryAllDocumentMetadataVCs() {
    console.log('[DocumentMetadataVC] Querying all DocumentMetadata VCs from Cloud Agent...');

    try {
      // Query issued credentials (these are VCs stored in issuer's wallet)
      const response = await fetch(`${this.baseUrl}/issue-credentials/records`, {
        method: 'GET',
        headers: {
          'apikey': this.apiKey
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to query VCs: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const allRecords = result.contents || result.items || [];

      console.log('[DocumentMetadataVC] Retrieved', allRecords.length, 'credential records');

      // Filter for DocumentMetadata VCs by checking if claims contain documentDID
      const documentMetadataVCs = allRecords.filter(record => {
        // Check if this record contains document metadata
        const claims = record.claims || {};
        return claims.documentDID !== undefined;
      });

      console.log('[DocumentMetadataVC] Found', documentMetadataVCs.length, 'DocumentMetadata VCs');

      return documentMetadataVCs;

    } catch (error) {
      console.error('[DocumentMetadataVC] ❌ Failed to query VCs:', error.message);
      throw error;
    }
  }

  /**
   * Parse a DocumentMetadata VC record into registry-compatible format
   *
   * @param {Object} vcRecord - VC record from Cloud Agent
   * @returns {Object} - Parsed document metadata
   */
  parseDocumentMetadataVC(vcRecord) {
    const claims = vcRecord.claims || {};

    // Parse releasableTo back into array
    const releasableTo = claims.releasableTo
      ? claims.releasableTo.split(',').map(did => did.trim())
      : [];

    return {
      documentDID: claims.documentDID,
      title: claims.title,
      description: claims.description,
      classificationLevel: claims.classificationLevel,
      releasableTo,
      contentEncryptionKey: claims.contentEncryptionKey,
      metadataVCRecordId: vcRecord.recordId,
      metadata: {
        department: claims.department,
        author: claims.author,
        category: claims.category,
        version: claims.version,
        createdBy: claims.createdBy,
        createdByDID: claims.createdByDID,
        createdAt: claims.createdAt || vcRecord.createdAt
      }
    };
  }
}

module.exports = DocumentMetadataVC;
