/**
 * classifiedDocuments.ts
 *
 * Redux reducer for managing classified documents with TTL.
 * Documents are received via DIDComm and stored in IndexedDB.
 *
 * @version 1.0.0
 * @date 2025-12-12
 */

import { PayloadAction, createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import {
  StoredDocument,
  DocumentSummary,
  DocumentStatus,
  getDocumentSummaries,
  storeDocument,
  getDocument,
  deleteDocument,
  incrementViewCount,
  updateDocumentStatus,
  cleanupExpiredDocuments,
  checkDocumentValidity,
  getStorageStats,
  fetchFromServiceEndpoint,
  storeDocumentFromCredential
} from "@/utils/documentStorage";
import { getDocumentCopyInfo, getCredentialType } from "@/utils/credentialTypeDetector";

/**
 * Classified documents state structure
 */
export interface ClassifiedDocumentsState {
  documents: DocumentSummary[];        // Document list for display
  selectedDocument: StoredDocument | null;  // Currently selected document
  isLoading: boolean;                  // Loading state
  isViewing: boolean;                  // Document viewer open
  error: string | null;                // Error message
  lastRefresh: string | null;          // Last refresh timestamp
  stats: {
    totalDocuments: number;
    activeDocuments: number;
    expiredDocuments: number;
    byClassification: Record<string, number>;
  } | null;
}

/**
 * Initial state
 */
const initialState: ClassifiedDocumentsState = {
  documents: [],
  selectedDocument: null,
  isLoading: false,
  isViewing: false,
  error: null,
  lastRefresh: null,
  stats: null
};

/**
 * Async thunk: Load all documents from IndexedDB
 */
export const loadDocuments = createAsyncThunk(
  'classifiedDocuments/loadDocuments',
  async (includeExpired: boolean = true, { rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Loading documents from IndexedDB...');
      const summaries = await getDocumentSummaries(includeExpired);
      const stats = await getStorageStats();

      console.log(`[ClassifiedDocuments] Loaded ${summaries.length} documents`);
      return { summaries, stats };
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to load documents:', error);
      return rejectWithValue(error.message || 'Failed to load documents');
    }
  }
);

/**
 * Async thunk: Store a new document
 */
export const addDocument = createAsyncThunk(
  'classifiedDocuments/addDocument',
  async (document: StoredDocument, { dispatch, rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Storing new document:', document.ephemeralDID);
      await storeDocument(document);

      // Refresh the document list
      dispatch(loadDocuments(true));

      return document;
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to store document:', error);
      return rejectWithValue(error.message || 'Failed to store document');
    }
  }
);

/**
 * Async thunk: Handle received DocumentCopy credential
 * Stores document metadata from SSI credential (content fetched on-demand from service endpoint)
 */
export const handleDocumentCopyCredential = createAsyncThunk(
  'classifiedDocuments/handleDocumentCopyCredential',
  async (credential: any, { dispatch, rejectWithValue }) => {
    try {
      // Check if this is a DocumentCopy credential
      const credType = getCredentialType(credential);
      if (credType !== 'DocumentCopy') {
        console.log('[ClassifiedDocuments] Not a DocumentCopy credential, skipping');
        return null;
      }

      // Extract document info from credential
      const docInfo = getDocumentCopyInfo(credential);
      if (!docInfo) {
        console.warn('[ClassifiedDocuments] Could not extract DocumentCopy info');
        return rejectWithValue('Invalid DocumentCopy credential');
      }

      console.log('[ClassifiedDocuments] Received DocumentCopy credential:', docInfo.ephemeralDID);
      console.log('[ClassifiedDocuments] Document title:', docInfo.title);
      console.log('[ClassifiedDocuments] Service endpoint:', docInfo.ephemeralServiceEndpoint);

      // Get the JWT string from credential (for storage)
      const vcJwt = typeof credential === 'string'
        ? credential
        : credential.id || JSON.stringify(credential);

      // Store document metadata (content will be fetched from service endpoint on-demand)
      await storeDocumentFromCredential({
        ephemeralDID: docInfo.ephemeralDID,
        ephemeralServiceEndpoint: docInfo.ephemeralServiceEndpoint,
        originalDocumentDID: docInfo.originalDocumentDID,
        title: docInfo.title,
        classification: docInfo.classification,
        clearanceLevelGranted: docInfo.clearanceLevelGranted,
        redactedSectionCount: docInfo.redactedSectionCount,
        visibleSectionCount: docInfo.visibleSectionCount,
        expiresAt: docInfo.expiresAt,
        viewsAllowed: docInfo.viewsAllowed
      }, vcJwt);

      // Refresh the document list
      dispatch(loadDocuments(true));

      console.log('[ClassifiedDocuments] DocumentCopy credential processed and stored');
      return docInfo;
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to process DocumentCopy credential:', error);
      return rejectWithValue(error.message || 'Failed to process DocumentCopy credential');
    }
  }
);

/**
 * Async thunk: Open document for viewing
 * Handles both local content and service endpoint mode
 */
export const openDocument = createAsyncThunk(
  'classifiedDocuments/openDocument',
  async (ephemeralDID: string, { rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Opening document:', ephemeralDID);

      // Check validity first
      const validity = await checkDocumentValidity(ephemeralDID);

      if (!validity.valid) {
        console.warn('[ClassifiedDocuments] Document not valid:', validity.reason);
        return rejectWithValue(validity.reason || 'Document not valid');
      }

      // Increment view count
      const viewResult = await incrementViewCount(ephemeralDID);

      if (!viewResult.allowed) {
        console.warn('[ClassifiedDocuments] View not allowed');
        return rejectWithValue('Maximum views reached or document expired');
      }

      // Get full document
      const document = await getDocument(ephemeralDID);

      if (!document) {
        return rejectWithValue('Document not found');
      }

      // If document is in service endpoint mode, fetch content from server
      if (document.isServiceEndpointMode && document.serviceEndpoint) {
        console.log('[ClassifiedDocuments] Fetching content from service endpoint:', document.serviceEndpoint);

        try {
          // Fetch encrypted content from service endpoint
          const fetchedData = await fetchFromServiceEndpoint(document.serviceEndpoint);

          console.log('[ClassifiedDocuments] Successfully fetched content from service endpoint');

          // Update document with fetched encryption info
          // Convert base64 to ArrayBuffer for encryptedContent
          const binaryString = atob(fetchedData.encryptedContent);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // Return document with fetched content
          return {
            ...document,
            encryptedContent: bytes.buffer,
            encryptionInfo: {
              serverPublicKey: fetchedData.serverPublicKey,
              nonce: fetchedData.nonce,
              algorithm: 'X25519-XSalsa20-Poly1305'
            },
            sourceInfo: {
              ...document.sourceInfo,
              format: fetchedData.contentType === 'application/pdf' ? 'pdf' : 'html'
            }
          };
        } catch (fetchError: any) {
          console.error('[ClassifiedDocuments] Failed to fetch from service endpoint:', fetchError);

          // If 410 Gone, mark as expired
          if (fetchError.message?.includes('expired')) {
            await updateDocumentStatus(ephemeralDID, 'expired');
            return rejectWithValue('Document has expired on server. Request a new copy.');
          }

          return rejectWithValue(fetchError.message || 'Failed to fetch document content');
        }
      }

      console.log('[ClassifiedDocuments] Document opened, view count:', viewResult.viewCount);
      return document;
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to open document:', error);
      return rejectWithValue(error.message || 'Failed to open document');
    }
  }
);

/**
 * Async thunk: Remove document
 */
export const removeDocument = createAsyncThunk(
  'classifiedDocuments/removeDocument',
  async (ephemeralDID: string, { dispatch, rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Removing document:', ephemeralDID);
      await deleteDocument(ephemeralDID);

      // Refresh the document list
      dispatch(loadDocuments(true));

      return ephemeralDID;
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to remove document:', error);
      return rejectWithValue(error.message || 'Failed to remove document');
    }
  }
);

/**
 * Async thunk: Clean up expired documents
 */
export const cleanupDocuments = createAsyncThunk(
  'classifiedDocuments/cleanupDocuments',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Cleaning up expired documents...');
      const count = await cleanupExpiredDocuments();

      // Refresh the document list
      dispatch(loadDocuments(true));

      return count;
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to cleanup documents:', error);
      return rejectWithValue(error.message || 'Failed to cleanup documents');
    }
  }
);

/**
 * Async thunk: Update document status
 */
export const setDocumentStatus = createAsyncThunk(
  'classifiedDocuments/setDocumentStatus',
  async ({ ephemeralDID, status }: { ephemeralDID: string; status: DocumentStatus }, { dispatch, rejectWithValue }) => {
    try {
      console.log('[ClassifiedDocuments] Updating status to', status, 'for:', ephemeralDID);
      await updateDocumentStatus(ephemeralDID, status);

      // Refresh the document list
      dispatch(loadDocuments(true));

      return { ephemeralDID, status };
    } catch (error: any) {
      console.error('[ClassifiedDocuments] Failed to update status:', error);
      return rejectWithValue(error.message || 'Failed to update status');
    }
  }
);

/**
 * Classified documents slice
 */
const classifiedDocumentsSlice = createSlice({
  name: 'classifiedDocuments',
  initialState,
  reducers: {
    // Close document viewer
    closeViewer: (state) => {
      state.isViewing = false;
      state.selectedDocument = null;
    },

    // Clear error
    clearError: (state) => {
      state.error = null;
    },

    // Direct document received (from DIDComm handler)
    documentReceived: (state, action: PayloadAction<DocumentSummary>) => {
      // Add to documents list, avoiding duplicates
      const existingIndex = state.documents.findIndex(
        d => d.ephemeralDID === action.payload.ephemeralDID
      );

      if (existingIndex >= 0) {
        state.documents[existingIndex] = action.payload;
      } else {
        state.documents.unshift(action.payload); // Add to beginning
      }

      console.log('[ClassifiedDocuments] Document received:', action.payload.ephemeralDID);
    },

    // Mark document as expired (local state update)
    markExpired: (state, action: PayloadAction<string>) => {
      const doc = state.documents.find(d => d.ephemeralDID === action.payload);
      if (doc) {
        doc.status = 'expired';
        doc.isExpired = true;
      }
    }
  },
  extraReducers: (builder) => {
    // Load documents
    builder.addCase(loadDocuments.pending, (state) => {
      state.isLoading = true;
      state.error = null;
    });
    builder.addCase(loadDocuments.fulfilled, (state, action) => {
      state.isLoading = false;
      state.documents = action.payload.summaries;
      state.stats = action.payload.stats;
      state.lastRefresh = new Date().toISOString();
    });
    builder.addCase(loadDocuments.rejected, (state, action) => {
      state.isLoading = false;
      state.error = action.payload as string;
    });

    // Add document
    builder.addCase(addDocument.pending, (state) => {
      state.isLoading = true;
      state.error = null;
    });
    builder.addCase(addDocument.fulfilled, (state) => {
      state.isLoading = false;
    });
    builder.addCase(addDocument.rejected, (state, action) => {
      state.isLoading = false;
      state.error = action.payload as string;
    });

    // Open document
    builder.addCase(openDocument.pending, (state) => {
      state.isLoading = true;
      state.error = null;
    });
    builder.addCase(openDocument.fulfilled, (state, action) => {
      state.isLoading = false;
      state.selectedDocument = action.payload;
      state.isViewing = true;
    });
    builder.addCase(openDocument.rejected, (state, action) => {
      state.isLoading = false;
      state.error = action.payload as string;
      state.isViewing = false;
      state.selectedDocument = null;
    });

    // Remove document
    builder.addCase(removeDocument.fulfilled, (state, action) => {
      state.documents = state.documents.filter(
        d => d.ephemeralDID !== action.payload
      );
      if (state.selectedDocument?.ephemeralDID === action.payload) {
        state.selectedDocument = null;
        state.isViewing = false;
      }
    });

    // Cleanup documents
    builder.addCase(cleanupDocuments.fulfilled, (state, action) => {
      console.log(`[ClassifiedDocuments] Cleaned up ${action.payload} documents`);
    });

    // Update status
    builder.addCase(setDocumentStatus.fulfilled, (state, action) => {
      const doc = state.documents.find(d => d.ephemeralDID === action.payload.ephemeralDID);
      if (doc) {
        doc.status = action.payload.status;
      }
    });

    // Handle DocumentCopy credential
    builder.addCase(handleDocumentCopyCredential.fulfilled, (state, action) => {
      if (action.payload) {
        console.log('[ClassifiedDocuments] DocumentCopy credential processed:', action.payload.ephemeralDID);
      }
    });
    builder.addCase(handleDocumentCopyCredential.rejected, (state, action) => {
      console.error('[ClassifiedDocuments] DocumentCopy credential failed:', action.payload);
      state.error = action.payload as string;
    });
  }
});

export const {
  closeViewer,
  clearError,
  documentReceived,
  markExpired
} = classifiedDocumentsSlice.actions;

export default classifiedDocumentsSlice.reducer;
