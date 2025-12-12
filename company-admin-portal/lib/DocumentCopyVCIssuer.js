/**
 * DocumentCopyVCIssuer.js
 *
 * Issues DocumentCopy Verifiable Credentials via DIDComm.
 * These VCs attest to a user's time-limited access to a classified document copy.
 *
 * The DocumentCopy VC contains:
 * - Original document DID
 * - Ephemeral DID (for this copy)
 * - Clearance level granted
 * - Redacted sections list
 * - Access rights (TTL, view limits)
 * - Content hash for integrity verification
 *
 * @version 1.0.0
 * @date 2025-12-12
 */

const crypto = require('crypto');

// Cloud Agent configuration
const CLOUD_AGENT_URL = process.env.ENTERPRISE_AGENT_URL || 'http://91.99.4.54:8200';

/**
 * Create DocumentCopy VC credential offer
 *
 * @param {Object} options - VC options
 * @param {string} options.holderDID - Recipient's PRISM DID
 * @param {string} options.connectionId - DIDComm connection ID
 * @param {Object} options.documentCopyData - Document copy metadata
 * @param {string} options.apiKey - Cloud Agent API key
 * @returns {Promise<Object>} Credential offer result
 */
async function createDocumentCopyCredentialOffer(options) {
  const {
    holderDID,
    connectionId,
    documentCopyData,
    apiKey
  } = options;

  const {
    originalDocumentDID,
    ephemeralDID,
    title,
    clearanceLevelGranted,
    redactedSections,
    accessRights,
    contentHash,
    encryptionKeyId
  } = documentCopyData;

  // Create credential subject claims
  const credentialSubject = {
    id: holderDID,
    documentCopy: {
      originalDocumentDID,
      ephemeralDID,
      title,
      clearanceLevelGranted,
      redactedSections: redactedSections.map(s => ({
        sectionId: s.sectionId,
        clearance: s.clearance
      })),
      accessRights: {
        expiresAt: accessRights.expiresAt,
        viewsAllowed: accessRights.viewsAllowed,
        downloadAllowed: false,
        printAllowed: false
      },
      contentHash,
      encryptionKeyId,
      issuedAt: new Date().toISOString()
    }
  };

  // Create credential offer request
  const credentialOfferRequest = {
    validityPeriod: calculateValidityPeriod(accessRights.expiresAt),
    schemaId: null, // Use dynamic schema for DocumentCopy
    claims: credentialSubject,
    automaticIssuance: true, // Auto-issue when holder accepts
    connectionId,
    issuingDID: null // Will use default issuing DID
  };

  console.log('[DocumentCopyVCIssuer] Creating credential offer for:', holderDID);
  console.log('[DocumentCopyVCIssuer] Document:', title);
  console.log('[DocumentCopyVCIssuer] Clearance granted:', clearanceLevelGranted);
  console.log('[DocumentCopyVCIssuer] Expires:', accessRights.expiresAt);

  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/cloud-agent/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify(credentialOfferRequest)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud Agent error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('[DocumentCopyVCIssuer] Credential offer created:', result.recordId);

    return {
      success: true,
      recordId: result.recordId,
      thid: result.thid,
      state: result.protocolState,
      holderDID,
      ephemeralDID
    };

  } catch (error) {
    console.error('[DocumentCopyVCIssuer] Failed to create credential offer:', error);
    throw error;
  }
}

/**
 * Calculate validity period in seconds from expiration date
 *
 * @param {string} expiresAt - ISO timestamp
 * @returns {number} Validity period in seconds
 */
function calculateValidityPeriod(expiresAt) {
  const now = new Date();
  const expires = new Date(expiresAt);
  const diffMs = expires.getTime() - now.getTime();

  // Ensure at least 1 hour validity
  const minValidity = 3600;
  const calculatedValidity = Math.floor(diffMs / 1000);

  return Math.max(minValidity, calculatedValidity);
}

/**
 * Create DocumentCopy VC claims for direct issuance (without Cloud Agent)
 *
 * @param {Object} metadata - Ephemeral DID metadata from EphemeralDIDService
 * @param {string} documentTitle - Title of the document
 * @returns {Object} VC claims object
 */
function createDocumentCopyVCClaims(metadata, documentTitle) {
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://identuslabel.cz/schemas/document-copy/v1'
    ],
    type: ['VerifiableCredential', 'DocumentCopyCredential'],
    credentialSubject: {
      documentCopy: {
        originalDocumentDID: metadata.originalDocumentDID,
        ephemeralDID: metadata.ephemeralDID,
        title: documentTitle,
        clearanceLevelGranted: metadata.clearanceLevel,
        redactedSections: metadata.redactedSections.map(s => ({
          sectionId: s.sectionId,
          clearance: s.clearance
        })),
        accessRights: {
          expiresAt: metadata.expiresAt,
          viewsAllowed: metadata.viewsAllowed,
          downloadAllowed: false,
          printAllowed: false
        },
        encryptionKeyId: `${metadata.ephemeralDID}#key-1`
      }
    }
  };
}

/**
 * Send document via DIDComm attachment
 *
 * This sends the encrypted document content as a DIDComm attachment,
 * along with the DocumentCopy VC claims in the message body.
 *
 * @param {Object} options - Send options
 * @param {string} options.connectionId - DIDComm connection ID
 * @param {Buffer} options.encryptedContent - Encrypted document content
 * @param {Object} options.encryptionInfo - Encryption metadata (nonce, serverPublicKey)
 * @param {Object} options.documentCopyData - Document copy metadata
 * @param {string} options.apiKey - Cloud Agent API key
 * @returns {Promise<Object>} Send result
 */
async function sendDocumentViaDIDComm(options) {
  const {
    connectionId,
    encryptedContent,
    encryptionInfo,
    documentCopyData,
    apiKey
  } = options;

  // Create message body
  const messageBody = {
    type: 'https://identuslabel.cz/protocols/document-copy/1.0/deliver',
    documentCopy: {
      originalDocumentDID: documentCopyData.originalDocumentDID,
      ephemeralDID: documentCopyData.ephemeralDID,
      title: documentCopyData.title,
      overallClassification: documentCopyData.overallClassification,
      clearanceLevelGranted: documentCopyData.clearanceLevelGranted,
      sectionSummary: documentCopyData.sectionSummary,
      sourceInfo: documentCopyData.sourceInfo,
      accessRights: documentCopyData.accessRights,
      contentHash: documentCopyData.contentHash
    },
    encryption: {
      algorithm: encryptionInfo.algorithm,
      serverPublicKey: encryptionInfo.serverPublicKey,
      nonce: encryptionInfo.nonce
    }
  };

  // Create attachment with encrypted content
  const attachment = {
    id: `document-${documentCopyData.ephemeralDID}`,
    description: `Encrypted classified document: ${documentCopyData.title}`,
    mediaType: 'application/octet-stream',
    data: {
      base64: encryptedContent.toString('base64')
    }
  };

  console.log('[DocumentCopyVCIssuer] Sending document via DIDComm');
  console.log('[DocumentCopyVCIssuer] Document size:', encryptedContent.length, 'bytes');
  console.log('[DocumentCopyVCIssuer] Connection:', connectionId);

  try {
    // Send via Cloud Agent basic message API
    const response = await fetch(`${CLOUD_AGENT_URL}/cloud-agent/connections/${connectionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify({
        content: JSON.stringify(messageBody),
        attachments: [attachment]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud Agent error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('[DocumentCopyVCIssuer] Document sent successfully');

    return {
      success: true,
      messageId: result.id || result.messageId,
      ephemeralDID: documentCopyData.ephemeralDID,
      sentAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('[DocumentCopyVCIssuer] Failed to send document:', error);
    throw error;
  }
}

/**
 * Issue DocumentCopy VC and send document in one operation
 *
 * @param {Object} options - Combined options
 * @returns {Promise<Object>} Combined result
 */
async function issueAndSendDocument(options) {
  const {
    holderDID,
    connectionId,
    encryptedContent,
    encryptionInfo,
    documentCopyData,
    apiKey,
    skipVC = false // Option to skip VC issuance for testing
  } = options;

  const results = {
    vcIssued: false,
    documentSent: false,
    errors: []
  };

  // Step 1: Issue DocumentCopy VC (optional)
  if (!skipVC) {
    try {
      const vcResult = await createDocumentCopyCredentialOffer({
        holderDID,
        connectionId,
        documentCopyData,
        apiKey
      });
      results.vcIssued = true;
      results.vcRecordId = vcResult.recordId;
    } catch (error) {
      console.warn('[DocumentCopyVCIssuer] VC issuance failed, continuing with document send:', error.message);
      results.errors.push({ stage: 'vcIssuance', error: error.message });
    }
  }

  // Step 2: Send encrypted document via DIDComm
  try {
    const sendResult = await sendDocumentViaDIDComm({
      connectionId,
      encryptedContent,
      encryptionInfo,
      documentCopyData,
      apiKey
    });
    results.documentSent = true;
    results.messageId = sendResult.messageId;
  } catch (error) {
    console.error('[DocumentCopyVCIssuer] Document send failed:', error);
    results.errors.push({ stage: 'documentSend', error: error.message });
    throw error;
  }

  return results;
}

/**
 * Generate content hash for document integrity
 *
 * @param {Buffer} content - Document content
 * @returns {string} SHA-256 hash in hex format
 */
function generateContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
  createDocumentCopyCredentialOffer,
  createDocumentCopyVCClaims,
  sendDocumentViaDIDComm,
  issueAndSendDocument,
  generateContentHash,
  calculateValidityPeriod
};
