/**
 * documentStorage.ts
 *
 * IndexedDB storage for classified documents received via DIDComm.
 * Documents are stored encrypted with time-limited access (TTL).
 *
 * Storage Structure:
 * - ephemeralDID: Primary key (unique identifier for each document copy)
 * - originalDocumentDID: Reference to source document
 * - encryptedContent: AES-256-GCM encrypted document bytes
 * - documentCopyVC: The DocumentCopy VC (JWT)
 * - metadata: Document metadata (title, classification, sections)
 * - receivedAt: Timestamp when document was received
 * - expiresAt: TTL expiration timestamp
 * - viewCount: Number of times document has been viewed
 * - maxViews: Maximum allowed views (-1 for unlimited)
 * - status: 'active' | 'expired' | 'revoked'
 *
 * @version 1.0.0
 * @date 2025-12-12
 */

// IndexedDB configuration
const DB_NAME = 'classified-documents-store';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

/**
 * Document status enum
 */
export type DocumentStatus = 'active' | 'expired' | 'revoked' | 'viewed';

/**
 * Stored document structure
 */
export interface StoredDocument {
  ephemeralDID: string;                // Primary key
  originalDocumentDID: string;         // Source document DID
  title: string;                       // Document title
  overallClassification: string;       // UNCLASSIFIED | CONFIDENTIAL | SECRET | TOP_SECRET
  encryptedContent: ArrayBuffer;       // Encrypted document bytes (empty if using serviceEndpoint)
  encryptionInfo: {                    // Decryption metadata
    serverPublicKey: string;           // Server's X25519 public key (base64)
    nonce: string;                     // Encryption nonce (base64)
    algorithm: string;                 // X25519-XSalsa20-Poly1305
  };
  documentCopyVC?: string;             // The DocumentCopy VC (JWT)
  serviceEndpoint?: string;            // SSI: URL to fetch encrypted content on demand
  isServiceEndpointMode?: boolean;     // If true, content must be fetched from serviceEndpoint
  sectionSummary: {                    // Section visibility info
    totalSections: number;
    visibleCount: number;
    redactedCount: number;
    clearanceLevelsUsed: string[];
    visibleSections: Array<{ sectionId: string; clearance: string; title?: string }>;
    redactedSections: Array<{ sectionId: string; clearance: string }>;
  };
  sourceInfo: {                        // Original document info
    filename: string;
    format: string;                    // 'html' | 'docx'
  };
  receivedAt: string;                  // ISO timestamp
  expiresAt: string;                   // ISO timestamp (TTL)
  viewCount: number;                   // Number of views
  maxViews: number;                    // Max views (-1 = unlimited)
  status: DocumentStatus;              // Current status
  lastViewedAt?: string;               // Last view timestamp
}

/**
 * Document summary for list display (without encrypted content)
 */
export interface DocumentSummary {
  ephemeralDID: string;
  originalDocumentDID: string;
  title: string;
  overallClassification: string;
  sectionSummary: StoredDocument['sectionSummary'];
  sourceInfo: StoredDocument['sourceInfo'];
  receivedAt: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number;
  status: DocumentStatus;
  lastViewedAt?: string;
  isExpired: boolean;                  // Computed field
  remainingTime: number;               // Milliseconds until expiry
  serviceEndpoint?: string;            // SSI: URL to fetch content
  isServiceEndpointMode?: boolean;     // If true, content fetched on demand
  remainingViews: number | 'unlimited'; // Views remaining
}

/**
 * Open the IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[DocumentStorage] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log('[DocumentStorage] Database opened successfully');
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      console.log('[DocumentStorage] Database upgrade needed');
      const db = (event.target as IDBOpenDBRequest).result;

      // Create documents object store
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'ephemeralDID' });

        // Create indexes for efficient queries
        store.createIndex('originalDocumentDID', 'originalDocumentDID', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
        store.createIndex('overallClassification', 'overallClassification', { unique: false });

        console.log('[DocumentStorage] Object store and indexes created');
      }
    };
  });
}

/**
 * Store a new document in IndexedDB
 *
 * @param document - Document to store
 * @returns Promise<void>
 */
export async function storeDocument(document: StoredDocument): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.put(document);

    request.onerror = () => {
      console.error('[DocumentStorage] Failed to store document:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log('[DocumentStorage] Document stored:', document.ephemeralDID);
      resolve();
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Get a document by ephemeral DID
 *
 * @param ephemeralDID - Document's ephemeral DID
 * @returns Promise<StoredDocument | null>
 */
export async function getDocument(ephemeralDID: string): Promise<StoredDocument | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.get(ephemeralDID);

    request.onerror = () => {
      console.error('[DocumentStorage] Failed to get document:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Get all stored documents
 *
 * @param includeExpired - Whether to include expired documents
 * @returns Promise<StoredDocument[]>
 */
export async function getAllDocuments(includeExpired: boolean = false): Promise<StoredDocument[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.getAll();

    request.onerror = () => {
      console.error('[DocumentStorage] Failed to get all documents:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      let documents = request.result || [];

      // Filter out expired documents if requested
      if (!includeExpired) {
        const now = new Date();
        documents = documents.filter((doc: StoredDocument) => {
          const expiresAt = new Date(doc.expiresAt);
          return expiresAt > now && doc.status === 'active';
        });
      }

      console.log(`[DocumentStorage] Retrieved ${documents.length} documents`);
      resolve(documents);
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Get document summaries for list display
 *
 * @param includeExpired - Whether to include expired documents
 * @returns Promise<DocumentSummary[]>
 */
export async function getDocumentSummaries(includeExpired: boolean = true): Promise<DocumentSummary[]> {
  const documents = await getAllDocuments(includeExpired);
  const now = new Date();

  return documents.map((doc): DocumentSummary => {
    const expiresAt = new Date(doc.expiresAt);
    const isExpired = expiresAt <= now || doc.status !== 'active';
    const remainingTime = Math.max(0, expiresAt.getTime() - now.getTime());
    const remainingViews = doc.maxViews === -1
      ? 'unlimited'
      : Math.max(0, doc.maxViews - doc.viewCount);

    return {
      ephemeralDID: doc.ephemeralDID,
      originalDocumentDID: doc.originalDocumentDID,
      title: doc.title,
      overallClassification: doc.overallClassification,
      sectionSummary: doc.sectionSummary,
      sourceInfo: doc.sourceInfo,
      receivedAt: doc.receivedAt,
      expiresAt: doc.expiresAt,
      viewCount: doc.viewCount,
      maxViews: doc.maxViews,
      status: isExpired ? 'expired' : doc.status,
      lastViewedAt: doc.lastViewedAt,
      isExpired,
      remainingTime,
      remainingViews
    };
  });
}

/**
 * Update document status
 *
 * @param ephemeralDID - Document's ephemeral DID
 * @param status - New status
 * @returns Promise<void>
 */
export async function updateDocumentStatus(
  ephemeralDID: string,
  status: DocumentStatus
): Promise<void> {
  const document = await getDocument(ephemeralDID);

  if (!document) {
    throw new Error(`Document not found: ${ephemeralDID}`);
  }

  document.status = status;

  await storeDocument(document);
  console.log(`[DocumentStorage] Status updated to '${status}' for: ${ephemeralDID}`);
}

/**
 * Increment view count for a document
 *
 * @param ephemeralDID - Document's ephemeral DID
 * @returns Promise<{ allowed: boolean; viewCount: number; remainingViews: number | 'unlimited' }>
 */
export async function incrementViewCount(ephemeralDID: string): Promise<{
  allowed: boolean;
  viewCount: number;
  remainingViews: number | 'unlimited';
}> {
  const document = await getDocument(ephemeralDID);

  if (!document) {
    throw new Error(`Document not found: ${ephemeralDID}`);
  }

  // Check if document is still valid
  const now = new Date();
  const expiresAt = new Date(document.expiresAt);

  if (expiresAt <= now) {
    document.status = 'expired';
    await storeDocument(document);
    return {
      allowed: false,
      viewCount: document.viewCount,
      remainingViews: 0
    };
  }

  // Check view limit
  if (document.maxViews !== -1 && document.viewCount >= document.maxViews) {
    document.status = 'viewed';
    await storeDocument(document);
    return {
      allowed: false,
      viewCount: document.viewCount,
      remainingViews: 0
    };
  }

  // Increment view count
  document.viewCount += 1;
  document.lastViewedAt = now.toISOString();

  await storeDocument(document);

  const remainingViews = document.maxViews === -1
    ? 'unlimited'
    : document.maxViews - document.viewCount;

  console.log(`[DocumentStorage] View count incremented to ${document.viewCount} for: ${ephemeralDID}`);

  return {
    allowed: true,
    viewCount: document.viewCount,
    remainingViews
  };
}

/**
 * Delete a document from storage
 *
 * @param ephemeralDID - Document's ephemeral DID
 * @returns Promise<void>
 */
export async function deleteDocument(ephemeralDID: string): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.delete(ephemeralDID);

    request.onerror = () => {
      console.error('[DocumentStorage] Failed to delete document:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log('[DocumentStorage] Document deleted:', ephemeralDID);
      resolve();
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Clean up expired documents
 *
 * @returns Promise<number> - Number of documents cleaned up
 */
export async function cleanupExpiredDocuments(): Promise<number> {
  const documents = await getAllDocuments(true);
  const now = new Date();
  let cleanedCount = 0;

  for (const doc of documents) {
    const expiresAt = new Date(doc.expiresAt);
    const isExpired = expiresAt <= now;
    const viewsExhausted = doc.maxViews !== -1 && doc.viewCount >= doc.maxViews;

    if (isExpired || viewsExhausted) {
      await deleteDocument(doc.ephemeralDID);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[DocumentStorage] Cleaned up ${cleanedCount} expired documents`);
  }

  return cleanedCount;
}

/**
 * Check if a document is still valid (not expired, views remaining)
 *
 * @param ephemeralDID - Document's ephemeral DID
 * @returns Promise<{ valid: boolean; reason?: string; document?: StoredDocument }>
 */
export async function checkDocumentValidity(ephemeralDID: string): Promise<{
  valid: boolean;
  reason?: string;
  document?: StoredDocument;
}> {
  const document = await getDocument(ephemeralDID);

  if (!document) {
    return { valid: false, reason: 'Document not found' };
  }

  const now = new Date();
  const expiresAt = new Date(document.expiresAt);

  // Check time expiration
  if (expiresAt <= now) {
    return {
      valid: false,
      reason: `Document expired at ${document.expiresAt}`,
      document
    };
  }

  // Check view count
  if (document.maxViews !== -1 && document.viewCount >= document.maxViews) {
    return {
      valid: false,
      reason: `Maximum views (${document.maxViews}) reached`,
      document
    };
  }

  // Check status
  if (document.status !== 'active') {
    return {
      valid: false,
      reason: `Document status: ${document.status}`,
      document
    };
  }

  // Calculate remaining info
  const remainingMs = expiresAt.getTime() - now.getTime();
  const remainingMinutes = Math.floor(remainingMs / (60 * 1000));

  return {
    valid: true,
    reason: `Valid for ${remainingMinutes} minutes`,
    document
  };
}

/**
 * Get storage statistics
 *
 * @returns Promise<{ totalDocuments: number; activeDocuments: number; expiredDocuments: number; byClassification: Record<string, number> }>
 */
export async function getStorageStats(): Promise<{
  totalDocuments: number;
  activeDocuments: number;
  expiredDocuments: number;
  byClassification: Record<string, number>;
}> {
  const documents = await getAllDocuments(true);
  const now = new Date();

  const stats = {
    totalDocuments: documents.length,
    activeDocuments: 0,
    expiredDocuments: 0,
    byClassification: {} as Record<string, number>
  };

  for (const doc of documents) {
    const expiresAt = new Date(doc.expiresAt);
    const isExpired = expiresAt <= now || doc.status !== 'active';

    if (isExpired) {
      stats.expiredDocuments++;
    } else {
      stats.activeDocuments++;
    }

    // Count by classification
    const classification = doc.overallClassification || 'UNKNOWN';
    stats.byClassification[classification] = (stats.byClassification[classification] || 0) + 1;
  }

  return stats;
}

/**
 * Format remaining time for display
 *
 * @param milliseconds - Remaining time in milliseconds
 * @returns Formatted string (e.g., "45 minutes", "2 hours", "3 days")
 */
export function formatRemainingTime(milliseconds: number): string {
  if (milliseconds <= 0) {
    return 'Expired';
  }

  const minutes = Math.floor(milliseconds / (60 * 1000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? '1 day' : `${days} days`;
  }

  if (hours > 0) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Fetch encrypted document content from service endpoint
 * Used for SSI-delivered documents where content is stored server-side
 *
 * @param serviceEndpoint - URL to fetch document from
 * @param sessionId - Optional session ID for authentication
 * @returns Promise with encrypted content and decryption metadata
 */
export async function fetchFromServiceEndpoint(
  serviceEndpoint: string,
  sessionId?: string
): Promise<{
  encryptedContent: string;  // base64 encoded
  nonce: string;             // base64 encoded
  serverPublicKey: string;   // base64 encoded
  contentType: string;
}> {
  console.log('[DocumentStorage] Fetching from service endpoint:', serviceEndpoint);

  const headers: Record<string, string> = {
    'Accept': 'application/json'
  };

  // Add session ID if provided (for authenticated endpoints)
  if (sessionId) {
    headers['X-Session-ID'] = sessionId;
  }

  const response = await fetch(serviceEndpoint, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Document not found on server');
    }
    if (response.status === 410) {
      throw new Error('Document has expired on server');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied - authentication required');
    }
    const errorText = await response.text();
    throw new Error(`Failed to fetch document: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  // Validate response structure
  if (!data.encryptedContent || !data.nonce || !data.serverPublicKey) {
    throw new Error('Invalid response from service endpoint - missing encryption data');
  }

  console.log('[DocumentStorage] Successfully fetched encrypted content from service endpoint');

  return {
    encryptedContent: data.encryptedContent,
    nonce: data.nonce,
    serverPublicKey: data.serverPublicKey,
    contentType: data.contentType || 'text/html'
  };
}

/**
 * Store a document received via SSI credential (service endpoint mode)
 * This stores the credential metadata without content - content is fetched on demand
 *
 * @param documentCopyInfo - Information from DocumentCopy credential
 * @param documentCopyVC - The raw VC JWT string
 * @returns Promise<void>
 */
export async function storeDocumentFromCredential(
  documentCopyInfo: {
    ephemeralDID: string;
    ephemeralServiceEndpoint: string;
    originalDocumentDID: string;
    title: string;
    classification: string;
    clearanceLevelGranted: string;
    redactedSectionCount: number;
    visibleSectionCount: number;
    expiresAt: string;
    viewsAllowed: number;
  },
  documentCopyVC?: string
): Promise<void> {
  const document: StoredDocument = {
    ephemeralDID: documentCopyInfo.ephemeralDID,
    originalDocumentDID: documentCopyInfo.originalDocumentDID,
    title: documentCopyInfo.title,
    overallClassification: documentCopyInfo.classification,
    encryptedContent: new ArrayBuffer(0), // Empty - content fetched from service endpoint
    encryptionInfo: {
      serverPublicKey: '', // Will be populated when fetched
      nonce: '',
      algorithm: 'X25519-XSalsa20-Poly1305'
    },
    documentCopyVC: documentCopyVC,
    serviceEndpoint: documentCopyInfo.ephemeralServiceEndpoint,
    isServiceEndpointMode: true,
    sectionSummary: {
      totalSections: documentCopyInfo.visibleSectionCount + documentCopyInfo.redactedSectionCount,
      visibleCount: documentCopyInfo.visibleSectionCount,
      redactedCount: documentCopyInfo.redactedSectionCount,
      clearanceLevelsUsed: [documentCopyInfo.clearanceLevelGranted],
      visibleSections: [],
      redactedSections: []
    },
    sourceInfo: {
      filename: documentCopyInfo.title,
      format: 'html'
    },
    receivedAt: new Date().toISOString(),
    expiresAt: documentCopyInfo.expiresAt,
    viewCount: 0,
    maxViews: documentCopyInfo.viewsAllowed,
    status: 'active'
  };

  await storeDocument(document);
  console.log('[DocumentStorage] Stored document from SSI credential:', documentCopyInfo.ephemeralDID);
}

export default {
  storeDocument,
  getDocument,
  getAllDocuments,
  getDocumentSummaries,
  updateDocumentStatus,
  incrementViewCount,
  deleteDocument,
  cleanupExpiredDocuments,
  checkDocumentValidity,
  getStorageStats,
  formatRemainingTime,
  fetchFromServiceEndpoint,
  storeDocumentFromCredential
};
