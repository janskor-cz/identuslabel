/**
 * EphemeralDocumentStore.js
 *
 * Server-side storage for encrypted documents indexed by ephemeral DID ID.
 * Documents are stored temporarily and automatically expired based on TTL.
 *
 * Storage Architecture:
 * - In-memory store with persistence to disk for crash recovery
 * - Documents indexed by ephemeral ID (UUID portion of did:ephemeral:{uuid})
 * - Automatic cleanup of expired documents every 5 minutes
 *
 * @version 1.0.0
 * @date 2025-12-13
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Storage directory for persistence
const STORAGE_DIR = path.join(__dirname, '..', 'data', 'ephemeral-documents');
const INDEX_FILE = path.join(STORAGE_DIR, 'index.json');

// In-memory store
const documentStore = new Map();

// Cleanup interval (5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Initialize the storage directory and load persisted data
 */
function initialize() {
  // Ensure storage directory exists
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    console.log('[EphemeralDocumentStore] Created storage directory:', STORAGE_DIR);
  }

  // Load index if exists
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      let loadedCount = 0;
      let expiredCount = 0;

      for (const [ephemeralId, metadata] of Object.entries(indexData)) {
        // Check if document has expired
        if (new Date(metadata.expiresAt) < new Date()) {
          // Clean up expired document file
          const docFile = path.join(STORAGE_DIR, `${ephemeralId}.enc`);
          if (fs.existsSync(docFile)) {
            fs.unlinkSync(docFile);
          }
          expiredCount++;
        } else {
          // Load document into memory
          const docFile = path.join(STORAGE_DIR, `${ephemeralId}.enc`);
          if (fs.existsSync(docFile)) {
            const encryptedContent = fs.readFileSync(docFile, 'utf8');
            documentStore.set(ephemeralId, {
              ...metadata,
              encryptedContent
            });
            loadedCount++;
          }
        }
      }

      console.log(`[EphemeralDocumentStore] Loaded ${loadedCount} documents, cleaned up ${expiredCount} expired`);
    } catch (error) {
      console.error('[EphemeralDocumentStore] Error loading index:', error);
    }
  }

  // Start cleanup interval
  setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
  console.log('[EphemeralDocumentStore] Initialized with cleanup interval every 5 minutes');
}

/**
 * Save an encrypted document
 *
 * @param {string} ephemeralId - UUID portion of ephemeral DID
 * @param {Object} document - Document data
 * @param {string} document.encryptedContent - Base64 encoded encrypted content
 * @param {string} document.nonce - Base64 encoded nonce
 * @param {string} document.serverPublicKey - Base64 encoded server X25519 public key
 * @param {string} document.expiresAt - ISO timestamp for expiration
 * @param {string} document.walletDID - Recipient wallet's PRISM DID
 * @param {string} document.documentDID - Original document DID
 * @param {string} [document.contentType] - MIME type (default: text/html)
 * @returns {Promise<Object>} Saved document metadata
 */
async function save(ephemeralId, document) {
  const {
    encryptedContent,
    nonce,
    serverPublicKey,
    expiresAt,
    walletDID,
    documentDID,
    contentType = 'text/html'
  } = document;

  // Validate required fields
  if (!ephemeralId || !encryptedContent || !nonce || !serverPublicKey || !expiresAt) {
    throw new Error('Missing required fields for document storage');
  }

  const metadata = {
    ephemeralId,
    nonce,
    serverPublicKey,
    expiresAt,
    walletDID,
    documentDID,
    contentType,
    createdAt: new Date().toISOString(),
    contentSize: encryptedContent.length
  };

  // Store in memory
  documentStore.set(ephemeralId, {
    ...metadata,
    encryptedContent
  });

  // Persist to disk
  try {
    // Save encrypted content to separate file
    const docFile = path.join(STORAGE_DIR, `${ephemeralId}.enc`);
    fs.writeFileSync(docFile, encryptedContent, 'utf8');

    // Update index
    await updateIndex();

    console.log(`[EphemeralDocumentStore] Saved document: ${ephemeralId}`);
    console.log(`[EphemeralDocumentStore] Size: ${encryptedContent.length} bytes, expires: ${expiresAt}`);
  } catch (error) {
    console.error('[EphemeralDocumentStore] Error persisting document:', error);
    // Document is still in memory, just log the persistence error
  }

  return metadata;
}

/**
 * Get an encrypted document by ephemeral ID
 *
 * @param {string} ephemeralId - UUID portion of ephemeral DID
 * @returns {Promise<Object|null>} Document data or null if not found/expired
 */
async function get(ephemeralId) {
  const document = documentStore.get(ephemeralId);

  if (!document) {
    console.log(`[EphemeralDocumentStore] Document not found: ${ephemeralId}`);
    return null;
  }

  // Check expiry
  if (new Date(document.expiresAt) < new Date()) {
    console.log(`[EphemeralDocumentStore] Document expired: ${ephemeralId}`);
    await deleteDocument(ephemeralId);
    return null;
  }

  console.log(`[EphemeralDocumentStore] Retrieved document: ${ephemeralId}`);
  return document;
}

/**
 * Delete an expired or consumed document
 *
 * @param {string} ephemeralId - UUID portion of ephemeral DID
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
async function deleteDocument(ephemeralId) {
  const existed = documentStore.has(ephemeralId);

  // Remove from memory
  documentStore.delete(ephemeralId);

  // Remove from disk
  try {
    const docFile = path.join(STORAGE_DIR, `${ephemeralId}.enc`);
    if (fs.existsSync(docFile)) {
      fs.unlinkSync(docFile);
    }
    await updateIndex();
    console.log(`[EphemeralDocumentStore] Deleted document: ${ephemeralId}`);
  } catch (error) {
    console.error('[EphemeralDocumentStore] Error deleting document:', error);
  }

  return existed;
}

/**
 * Clean up all expired documents
 */
async function cleanupExpired() {
  const now = new Date();
  let cleanedCount = 0;

  for (const [ephemeralId, document] of documentStore.entries()) {
    if (new Date(document.expiresAt) < now) {
      await deleteDocument(ephemeralId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[EphemeralDocumentStore] Cleaned up ${cleanedCount} expired documents`);
  }
}

/**
 * Update the index file with current document metadata
 */
async function updateIndex() {
  const index = {};

  for (const [ephemeralId, document] of documentStore.entries()) {
    // Don't include encryptedContent in index (it's in separate files)
    const { encryptedContent, ...metadata } = document;
    index[ephemeralId] = metadata;
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Get statistics about stored documents
 *
 * @returns {Object} Statistics
 */
function getStats() {
  const now = new Date();
  let totalSize = 0;
  let activeCount = 0;
  let expiredCount = 0;

  for (const document of documentStore.values()) {
    totalSize += document.contentSize || 0;
    if (new Date(document.expiresAt) < now) {
      expiredCount++;
    } else {
      activeCount++;
    }
  }

  return {
    totalDocuments: documentStore.size,
    activeDocuments: activeCount,
    expiredDocuments: expiredCount,
    totalSizeBytes: totalSize,
    totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
  };
}

/**
 * Check if a document exists and is not expired
 *
 * @param {string} ephemeralId - UUID portion of ephemeral DID
 * @returns {boolean} True if document exists and is valid
 */
function exists(ephemeralId) {
  const document = documentStore.get(ephemeralId);
  if (!document) return false;
  return new Date(document.expiresAt) >= new Date();
}

// Initialize on module load
initialize();

module.exports = {
  save,
  get,
  delete: deleteDocument,
  exists,
  cleanupExpired,
  getStats
};
