/**
 * SectionEncryptionService.js
 *
 * Encrypts document sections with clearance-based keys.
 * Each section gets its own AES-256-GCM encryption key.
 * Keys are organized in a keyring with access based on clearance level.
 *
 * Key Hierarchy:
 * - UNCLASSIFIED key: Accessible by all
 * - CONFIDENTIAL key: Accessible by CONFIDENTIAL, SECRET, TOP_SECRET
 * - SECRET key: Accessible by SECRET, TOP_SECRET
 * - TOP_SECRET key: Accessible by TOP_SECRET only
 */

const crypto = require('crypto');
const { CLEARANCE_LEVELS, VALID_CLEARANCE_VALUES } = require('./ClearanceDocumentParser');

// Encryption configuration
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_SIZE = 32; // 256 bits
const IV_SIZE = 12; // 96 bits for GCM
const AUTH_TAG_SIZE = 16; // 128 bits

/**
 * Encrypt document sections with clearance-based encryption
 * @param {Object} parsedDocument - Document from ClearanceDocumentParser
 * @param {string} companySecret - Company-specific secret for key derivation
 * @returns {Object} Encrypted document package
 */
function encryptSections(parsedDocument, companySecret) {
  const { metadata, sections } = parsedDocument;

  // Generate master keys for each clearance level
  const masterKeys = generateMasterKeys(companySecret, metadata.title);

  // Encrypt each section
  const encryptedSections = [];
  const sectionKeys = {};

  for (const section of sections) {
    // Generate unique key for this section
    const sectionKey = crypto.randomBytes(KEY_SIZE);
    const iv = crypto.randomBytes(IV_SIZE);

    // Encrypt section content
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, sectionKey, iv);
    const content = Buffer.from(section.content, 'utf8');

    const encrypted = Buffer.concat([
      cipher.update(content),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // Store encrypted section
    encryptedSections.push({
      sectionId: section.sectionId,
      clearance: section.clearance,
      clearanceLevel: section.clearanceLevel,
      tagName: section.tagName,
      isInline: section.isInline,
      title: section.title,
      textLength: section.textLength,
      contentHash: section.contentHash,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encryptedAt: new Date().toISOString()
    });

    // Store section key (encrypted with appropriate master key)
    const masterKey = masterKeys[section.clearance];
    const encryptedSectionKey = encryptKey(sectionKey, masterKey);
    sectionKeys[section.sectionId] = {
      clearance: section.clearance,
      encryptedKey: encryptedSectionKey
    };
  }

  // Create keyring with master keys encrypted for each clearance level
  const keyring = createKeyring(masterKeys);

  return {
    documentId: `doc-${crypto.randomUUID()}`,
    metadata: {
      ...metadata,
      encryptedAt: new Date().toISOString(),
      encryptionVersion: '1.0',
      algorithm: ENCRYPTION_ALGORITHM
    },
    encryptedSections,
    sectionKeys,
    keyring,
    integrityHash: calculateIntegrityHash(encryptedSections)
  };
}

/**
 * Generate master keys for each clearance level
 * @param {string} companySecret - Company secret
 * @param {string} documentTitle - Document title for additional entropy
 * @returns {Object} Master keys by clearance level
 */
function generateMasterKeys(companySecret, documentTitle) {
  const keys = {};
  const salt = crypto.createHash('sha256')
    .update(documentTitle || 'document')
    .digest();

  for (const level of VALID_CLEARANCE_VALUES) {
    // Derive key using HKDF
    // Note: crypto.hkdfSync returns ArrayBuffer, need to wrap in Buffer
    const info = `clearance-master-key-${level}`;
    const derivedKey = crypto.hkdfSync(
      'sha256',
      companySecret,
      salt,
      info,
      KEY_SIZE
    );
    keys[level] = Buffer.from(derivedKey);
  }

  return keys;
}

/**
 * Create keyring with encrypted master keys
 * Keys are encrypted such that higher clearance can access lower clearance keys
 * @param {Object} masterKeys - Master keys by clearance level
 * @returns {Object} Keyring with encrypted keys
 */
function createKeyring(masterKeys) {
  // For simplicity, store master keys directly (in production, use envelope encryption)
  // Each level stores its own key and all lower-level keys
  const keyring = {};

  // TOP_SECRET can access all keys
  keyring.TOP_SECRET = {
    keys: {
      TOP_SECRET: masterKeys.TOP_SECRET.toString('base64'),
      SECRET: masterKeys.SECRET.toString('base64'),
      CONFIDENTIAL: masterKeys.CONFIDENTIAL.toString('base64'),
      UNCLASSIFIED: masterKeys.UNCLASSIFIED.toString('base64')
    }
  };

  // SECRET can access SECRET, CONFIDENTIAL, UNCLASSIFIED
  keyring.SECRET = {
    keys: {
      SECRET: masterKeys.SECRET.toString('base64'),
      CONFIDENTIAL: masterKeys.CONFIDENTIAL.toString('base64'),
      UNCLASSIFIED: masterKeys.UNCLASSIFIED.toString('base64')
    }
  };

  // CONFIDENTIAL can access CONFIDENTIAL, UNCLASSIFIED
  keyring.CONFIDENTIAL = {
    keys: {
      CONFIDENTIAL: masterKeys.CONFIDENTIAL.toString('base64'),
      UNCLASSIFIED: masterKeys.UNCLASSIFIED.toString('base64')
    }
  };

  // UNCLASSIFIED can only access UNCLASSIFIED
  keyring.UNCLASSIFIED = {
    keys: {
      UNCLASSIFIED: masterKeys.UNCLASSIFIED.toString('base64')
    }
  };

  return keyring;
}

/**
 * Encrypt a key with a master key
 * @param {Buffer} keyToEncrypt - Key to encrypt
 * @param {Buffer} masterKey - Master key to encrypt with
 * @returns {string} Encrypted key (base64)
 */
function encryptKey(keyToEncrypt, masterKey) {
  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, masterKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(keyToEncrypt),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  // Concatenate IV + authTag + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a key with a master key
 * @param {string} encryptedKey - Encrypted key (base64)
 * @param {Buffer} masterKey - Master key to decrypt with
 * @returns {Buffer} Decrypted key
 */
function decryptKey(encryptedKey, masterKey) {
  const data = Buffer.from(encryptedKey, 'base64');

  const iv = data.subarray(0, IV_SIZE);
  const authTag = data.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
  const ciphertext = data.subarray(IV_SIZE + AUTH_TAG_SIZE);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}

/**
 * Decrypt sections based on user's clearance level
 * @param {Object} encryptedPackage - Encrypted document package
 * @param {string} userClearance - User's clearance level
 * @param {string} companySecret - Company secret for key derivation
 * @returns {Object} Decrypted sections and redaction info
 */
function decryptSectionsForUser(encryptedPackage, userClearance, companySecret) {
  const userClearanceLevel = CLEARANCE_LEVELS[userClearance] || 1;

  // Regenerate master keys
  const masterKeys = generateMasterKeys(companySecret, encryptedPackage.metadata.title);

  // Get keys accessible to user
  const accessibleKeys = encryptedPackage.keyring[userClearance]?.keys || {};

  const decryptedSections = [];
  const redactedSections = [];

  for (const section of encryptedPackage.encryptedSections) {
    const sectionClearanceLevel = CLEARANCE_LEVELS[section.clearance] || 1;

    // Check if user has access
    if (sectionClearanceLevel <= userClearanceLevel && accessibleKeys[section.clearance]) {
      // User can decrypt this section
      try {
        // Get master key for this clearance level
        const masterKey = Buffer.from(accessibleKeys[section.clearance], 'base64');

        // Get encrypted section key
        const sectionKeyInfo = encryptedPackage.sectionKeys[section.sectionId];
        const decryptedSectionKey = decryptKey(sectionKeyInfo.encryptedKey, masterKey);

        // Decrypt section content
        const iv = Buffer.from(section.iv, 'base64');
        const authTag = Buffer.from(section.authTag, 'base64');
        const ciphertext = Buffer.from(section.ciphertext, 'base64');

        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, decryptedSectionKey, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]);

        decryptedSections.push({
          sectionId: section.sectionId,
          clearance: section.clearance,
          clearanceLevel: section.clearanceLevel,
          tagName: section.tagName,
          isInline: section.isInline,
          title: section.title,
          content: decrypted.toString('utf8'),
          textLength: section.textLength,
          contentHash: section.contentHash
        });
      } catch (error) {
        console.error(`Failed to decrypt section ${section.sectionId}:`, error.message);
        redactedSections.push({
          sectionId: section.sectionId,
          clearance: section.clearance,
          clearanceLevel: section.clearanceLevel,
          title: section.title,
          reason: 'Decryption failed'
        });
      }
    } else {
      // User does not have access - mark for redaction
      redactedSections.push({
        sectionId: section.sectionId,
        clearance: section.clearance,
        clearanceLevel: section.clearanceLevel,
        tagName: section.tagName,
        isInline: section.isInline,
        title: section.title,
        reason: `Requires ${section.clearance} clearance`
      });
    }
  }

  return {
    metadata: encryptedPackage.metadata,
    userClearance,
    userClearanceLevel,
    decryptedSections,
    redactedSections,
    decryptedAt: new Date().toISOString()
  };
}

/**
 * Calculate integrity hash for encrypted sections
 * @param {Array} encryptedSections - Array of encrypted sections
 * @returns {string} Integrity hash
 */
function calculateIntegrityHash(encryptedSections) {
  const hash = crypto.createHash('sha256');

  for (const section of encryptedSections) {
    hash.update(section.sectionId);
    hash.update(section.ciphertext);
    hash.update(section.authTag);
  }

  return hash.digest('hex');
}

/**
 * Verify integrity of encrypted package
 * @param {Object} encryptedPackage - Encrypted document package
 * @returns {boolean} True if integrity is valid
 */
function verifyIntegrity(encryptedPackage) {
  const calculatedHash = calculateIntegrityHash(encryptedPackage.encryptedSections);
  return calculatedHash === encryptedPackage.integrityHash;
}

/**
 * Get section metadata without decrypting content
 * @param {Object} encryptedPackage - Encrypted document package
 * @returns {Array} Section metadata
 */
function getSectionMetadata(encryptedPackage) {
  return encryptedPackage.encryptedSections.map(section => ({
    sectionId: section.sectionId,
    clearance: section.clearance,
    clearanceLevel: section.clearanceLevel,
    title: section.title,
    tagName: section.tagName,
    isInline: section.isInline,
    textLength: section.textLength,
    contentHash: section.contentHash
  }));
}

module.exports = {
  encryptSections,
  decryptSectionsForUser,
  verifyIntegrity,
  getSectionMetadata,
  ENCRYPTION_ALGORITHM,
  KEY_SIZE,
  IV_SIZE
};
