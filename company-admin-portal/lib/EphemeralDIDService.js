/**
 * EphemeralDIDService.js
 *
 * Creates and manages ephemeral DIDs for document copies.
 * Each document copy gets a unique ephemeral DID with time-limited access (TTL).
 *
 * Default TTL: 1 hour (high security)
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');

// Default TTL: 1 hour in milliseconds
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create an ephemeral DID for a document copy
 * @param {Object} options - Options for ephemeral DID creation
 * @returns {Object} Ephemeral DID document and metadata
 */
function createEphemeralDID(options = {}) {
  const {
    originalDocumentDID,
    recipientDID,
    recipientPublicKey,
    clearanceLevel,
    redactedSections = [],
    ttlMs = DEFAULT_TTL_MS,
    viewsAllowed = -1, // -1 = unlimited views
    issuerDID
  } = options;

  // Generate unique ephemeral DID identifier
  const ephemeralId = crypto.randomUUID();
  const ephemeralDID = `did:ephemeral:${ephemeralId}`;

  // Calculate expiration timestamp
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMs);

  // Generate X25519 keypair for encryption
  const keyPair = nacl.box.keyPair();
  const publicKey = Buffer.from(keyPair.publicKey).toString('base64');
  const secretKey = Buffer.from(keyPair.secretKey).toString('base64');

  // Create ephemeral DID document
  const didDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/v1'
    ],
    id: ephemeralDID,
    controller: issuerDID || ephemeralDID,
    verificationMethod: [
      {
        id: `${ephemeralDID}#key-1`,
        type: 'X25519KeyAgreementKey2020',
        controller: ephemeralDID,
        publicKeyBase64: publicKey
      }
    ],
    keyAgreement: [`${ephemeralDID}#key-1`],
    service: [
      {
        id: `${ephemeralDID}#document`,
        type: 'EncryptedDocument',
        serviceEndpoint: {
          documentDID: originalDocumentDID,
          clearanceLevel,
          expiresAt: expiresAt.toISOString(),
          viewsAllowed,
          redactedSectionIds: redactedSections.map(s => s.sectionId)
        }
      }
    ]
  };

  // Create metadata for storage
  const ephemeralMetadata = {
    ephemeralDID,
    originalDocumentDID,
    recipientDID,
    recipientPublicKey,
    clearanceLevel,
    redactedSections,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlMs,
    viewsAllowed,
    viewCount: 0,
    status: 'active',
    issuerDID,
    // Store keypair for server-side encryption
    keyPair: {
      publicKey,
      secretKey // Note: In production, use HSM or secure key storage
    }
  };

  return {
    didDocument,
    metadata: ephemeralMetadata
  };
}

/**
 * Check if an ephemeral DID is still valid (not expired, views remaining)
 * @param {Object} metadata - Ephemeral DID metadata
 * @returns {Object} Validity status
 */
function checkEphemeralDIDValidity(metadata) {
  const now = new Date();
  const expiresAt = new Date(metadata.expiresAt);

  // Check time expiration
  if (now > expiresAt) {
    return {
      valid: false,
      reason: 'expired',
      message: 'Document access has expired',
      expiresAt: metadata.expiresAt
    };
  }

  // Check view count (if limited)
  if (metadata.viewsAllowed !== -1 && metadata.viewCount >= metadata.viewsAllowed) {
    return {
      valid: false,
      reason: 'views_exhausted',
      message: 'Maximum number of views reached',
      viewsAllowed: metadata.viewsAllowed,
      viewCount: metadata.viewCount
    };
  }

  // Check status
  if (metadata.status !== 'active') {
    return {
      valid: false,
      reason: 'revoked',
      message: `Document access has been ${metadata.status}`,
      status: metadata.status
    };
  }

  // Calculate remaining time
  const remainingMs = expiresAt.getTime() - now.getTime();
  const remainingMinutes = Math.floor(remainingMs / (60 * 1000));
  const remainingViews = metadata.viewsAllowed === -1 ? 'unlimited' : metadata.viewsAllowed - metadata.viewCount;

  return {
    valid: true,
    expiresAt: metadata.expiresAt,
    remainingMs,
    remainingMinutes,
    viewsRemaining: remainingViews,
    viewCount: metadata.viewCount
  };
}

/**
 * Increment view count for an ephemeral DID
 * @param {Object} metadata - Ephemeral DID metadata
 * @returns {Object} Updated metadata
 */
function incrementViewCount(metadata) {
  return {
    ...metadata,
    viewCount: metadata.viewCount + 1,
    lastViewedAt: new Date().toISOString()
  };
}

/**
 * Revoke an ephemeral DID
 * @param {Object} metadata - Ephemeral DID metadata
 * @param {string} reason - Revocation reason
 * @returns {Object} Updated metadata
 */
function revokeEphemeralDID(metadata, reason = 'manual_revocation') {
  return {
    ...metadata,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
    revocationReason: reason
  };
}

/**
 * Extend TTL of an ephemeral DID
 * @param {Object} metadata - Ephemeral DID metadata
 * @param {number} additionalMs - Additional time in milliseconds
 * @returns {Object} Updated metadata
 */
function extendTTL(metadata, additionalMs) {
  const currentExpiry = new Date(metadata.expiresAt);
  const newExpiry = new Date(currentExpiry.getTime() + additionalMs);

  return {
    ...metadata,
    expiresAt: newExpiry.toISOString(),
    ttlExtendedAt: new Date().toISOString(),
    ttlExtensionMs: additionalMs
  };
}

/**
 * Create a minimal representation for transmission
 * @param {Object} metadata - Full ephemeral DID metadata
 * @returns {Object} Minimal representation
 */
function createTransmissionPayload(metadata) {
  return {
    ephemeralDID: metadata.ephemeralDID,
    originalDocumentDID: metadata.originalDocumentDID,
    clearanceLevel: metadata.clearanceLevel,
    expiresAt: metadata.expiresAt,
    viewsAllowed: metadata.viewsAllowed,
    redactedSectionCount: metadata.redactedSections?.length || 0,
    publicKey: metadata.keyPair.publicKey // Only public key for recipient
  };
}

/**
 * Encrypt document content for recipient
 * @param {Buffer} documentContent - Document content to encrypt
 * @param {Object} metadata - Ephemeral DID metadata
 * @param {string} recipientPublicKey - Recipient's X25519 public key (base64)
 * @returns {Object} Encrypted content with nonce
 */
function encryptForRecipient(documentContent, metadata, recipientPublicKey) {
  // Decode keys
  const serverSecretKey = Buffer.from(metadata.keyPair.secretKey, 'base64');
  const recipientPubKey = Buffer.from(recipientPublicKey, 'base64');

  // Generate random nonce
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  // Encrypt using NaCl box (X25519 + XSalsa20-Poly1305)
  const ciphertext = nacl.box(
    new Uint8Array(documentContent),
    nonce,
    recipientPubKey,
    serverSecretKey
  );

  return {
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
    serverPublicKey: metadata.keyPair.publicKey,
    algorithm: 'X25519-XSalsa20-Poly1305'
  };
}

/**
 * Generate ephemeral access token for document retrieval
 * @param {Object} metadata - Ephemeral DID metadata
 * @returns {string} Access token (JWT-like structure)
 */
function generateAccessToken(metadata) {
  const payload = {
    eph: metadata.ephemeralDID,
    doc: metadata.originalDocumentDID,
    clr: metadata.clearanceLevel,
    exp: new Date(metadata.expiresAt).getTime() / 1000,
    iat: Date.now() / 1000
  };

  // Create HMAC signature
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', metadata.keyPair.secretKey)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Verify access token
 * @param {string} token - Access token
 * @param {Object} metadata - Ephemeral DID metadata
 * @returns {Object} Verification result
 */
function verifyAccessToken(token, metadata) {
  try {
    const [payloadB64, signature] = token.split('.');

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', metadata.keyPair.secretKey)
      .update(payloadB64)
      .digest('base64url');

    if (signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // Parse payload
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    // Check expiration
    if (payload.exp * 1000 < Date.now()) {
      return { valid: false, reason: 'Token expired' };
    }

    // Verify ephemeral DID matches
    if (payload.eph !== metadata.ephemeralDID) {
      return { valid: false, reason: 'DID mismatch' };
    }

    return { valid: true, payload };
  } catch (error) {
    return { valid: false, reason: `Parse error: ${error.message}` };
  }
}

/**
 * Create DocumentCopy VC claims
 * @param {Object} metadata - Ephemeral DID metadata
 * @param {string} documentTitle - Title of the document
 * @returns {Object} VC credential subject claims
 */
function createDocumentCopyVCClaims(metadata, documentTitle) {
  return {
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
  };
}

module.exports = {
  createEphemeralDID,
  checkEphemeralDIDValidity,
  incrementViewCount,
  revokeEphemeralDID,
  extendTTL,
  createTransmissionPayload,
  encryptForRecipient,
  generateAccessToken,
  verifyAccessToken,
  createDocumentCopyVCClaims,
  DEFAULT_TTL_MS
};
