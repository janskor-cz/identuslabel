/**
 * My Documents Page
 *
 * Displays classified documents received via DIDComm with time-limited access (TTL).
 * Documents are stored in IndexedDB and expire based on server-defined TTL.
 *
 * Features:
 * - List of received classified documents
 * - TTL countdown and expiration indication
 * - Section visibility summary (visible vs redacted)
 * - Document viewer integration
 * - Request new copy for expired documents
 *
 * @version 1.0.0
 * @date 2025-12-12
 */

import React, { useState, useEffect, useCallback } from 'react';
import '../app/index.css';
import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector, useAppDispatch } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import {
  DocumentIcon,
  RefreshIcon,
  ClockIcon,
  ShieldCheckIcon,
  EyeIcon,
  TrashIcon,
  ExclamationIcon,
  LockClosedIcon,
  CheckCircleIcon,
  CloudDownloadIcon
} from '@heroicons/react/solid';
import nacl from 'tweetnacl';
import {
  loadDocuments,
  openDocument,
  removeDocument,
  cleanupDocuments,
  closeViewer,
  ClassifiedDocumentsState
} from "@/reducers/classifiedDocuments";
import { DocumentSummary, formatRemainingTime, getDocument, fetchFromServiceEndpoint } from "@/utils/documentStorage";
import { getItem, getKeysByPattern } from "@/utils/prefixedStorage";
import { ClassifiedDocumentViewer } from "@/components/ClassifiedDocumentViewer";

/**
 * Classification badge configuration
 */
const getClassificationBadge = (level: string) => {
  switch (level?.toUpperCase()) {
    case 'UNCLASSIFIED':
      return { color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', label: 'UNCLASSIFIED' };
    case 'CONFIDENTIAL':
      return { color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', label: 'CONFIDENTIAL' };
    case 'SECRET':
      return { color: 'bg-red-500/20 text-red-400 border-red-500/30', label: 'SECRET' };
    case 'TOP_SECRET':
      return { color: 'bg-red-700/20 text-red-300 border-red-700/30', label: 'TOP SECRET' };
    default:
      return { color: 'bg-slate-500/20 text-slate-400 border-slate-500/30', label: level || 'UNKNOWN' };
  }
};

/**
 * Document Card Component
 */
const DocumentCard: React.FC<{
  document: DocumentSummary;
  onView: (ephemeralDID: string) => void;
  onDownload: (ephemeralDID: string) => void;
  onRemove: (ephemeralDID: string) => void;
  onRequestNew: (originalDID: string) => void;
}> = ({ document, onView, onDownload, onRemove, onRequestNew }) => {
  const badge = getClassificationBadge(document.overallClassification);
  const [timeLeft, setTimeLeft] = useState(formatRemainingTime(document.remainingTime));

  // Update countdown every minute
  useEffect(() => {
    if (document.isExpired) return;

    const interval = setInterval(() => {
      const now = new Date();
      const expiresAt = new Date(document.expiresAt);
      const remaining = Math.max(0, expiresAt.getTime() - now.getTime());
      setTimeLeft(formatRemainingTime(remaining));
    }, 60000);

    return () => clearInterval(interval);
  }, [document.expiresAt, document.isExpired]);

  return (
    <div className={`border-2 rounded-2xl overflow-hidden transition-shadow ${
      document.isExpired
        ? 'border-slate-700/30 bg-slate-800/20 opacity-75'
        : 'border-slate-700/50 hover:shadow-lg bg-slate-800/30 backdrop-blur-sm'
    }`}>
      {/* Classification Banner */}
      <div className={`px-4 py-2 ${badge.color} border-b-2 flex items-center justify-between`}>
        <span className="font-bold text-sm">{badge.label}</span>
        {document.isExpired && (
          <span className="bg-red-600 text-white px-2 py-0.5 rounded text-xs font-bold">
            EXPIRED
          </span>
        )}
      </div>

      {/* Document Content */}
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h3 className="text-lg font-bold text-white">{document.title}</h3>

            {/* Source Info */}
            <div className="flex items-center gap-4 mt-2 text-sm text-slate-400">
              <span className="flex items-center gap-1">
                <DocumentIcon className="w-4 h-4" />
                {document.sourceInfo?.filename || 'document'}
              </span>
              <span className="uppercase text-xs">
                {document.sourceInfo?.format || 'html'}
              </span>
            </div>

            {/* Section Summary */}
            <div className="mt-3 flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircleIcon className="w-4 h-4" />
                {document.sectionSummary?.visibleCount || 0} visible
              </span>
              {(document.sectionSummary?.redactedCount || 0) > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <LockClosedIcon className="w-4 h-4" />
                  {document.sectionSummary.redactedCount} redacted
                </span>
              )}
            </div>

            {/* Dates and TTL */}
            <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
              <span>Received: {new Date(document.receivedAt).toLocaleDateString()}</span>
              {!document.isExpired && (
                <span className="flex items-center gap-1 text-amber-400 font-medium">
                  <ClockIcon className="w-3 h-3" />
                  Expires in: {timeLeft}
                </span>
              )}
            </div>

            {/* View Count */}
            {document.maxViews !== -1 && (
              <div className="mt-2 text-xs text-slate-500">
                Views: {document.viewCount} / {document.maxViews}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 ml-4">
            {!document.isExpired ? (
              <>
                <button
                  onClick={() => onView(document.ephemeralDID)}
                  className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl hover:opacity-90 flex items-center gap-2 text-sm"
                >
                  <EyeIcon className="w-4 h-4" />
                  View
                </button>
                <button
                  onClick={() => onDownload(document.ephemeralDID)}
                  className="px-4 py-2 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 flex items-center gap-2 text-sm"
                >
                  <CloudDownloadIcon className="w-4 h-4" />
                  Download
                </button>
                <button
                  onClick={() => onRemove(document.ephemeralDID)}
                  className="px-4 py-2 bg-slate-800/50 text-slate-300 rounded-xl hover:bg-slate-700/50 border border-slate-700/50 flex items-center gap-2 text-sm"
                >
                  <TrashIcon className="w-4 h-4" />
                  Remove
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onRequestNew(document.originalDocumentDID)}
                  className="px-4 py-2 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 flex items-center gap-2 text-sm"
                >
                  <RefreshIcon className="w-4 h-4" />
                  Request New
                </button>
                <button
                  onClick={() => onRemove(document.ephemeralDID)}
                  className="px-4 py-2 bg-red-500/20 text-red-300 rounded-xl hover:bg-red-500/30 border border-red-500/30 flex items-center gap-2 text-sm"
                >
                  <TrashIcon className="w-4 h-4" />
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * My Documents Page Component
 */
export default function MyDocumentsPage() {
  const app = useMountedApp();
  const dispatch = useAppDispatch();
  const classifiedDocuments = useAppSelector(state => state.classifiedDocuments);

  const [showExpired, setShowExpired] = useState(true);

  // Load documents on mount
  useEffect(() => {
    dispatch(loadDocuments(true));
  }, [dispatch]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      dispatch(loadDocuments(showExpired));
    }, 30000);

    return () => clearInterval(interval);
  }, [dispatch, showExpired]);

  // Handle view document
  const handleView = useCallback((ephemeralDID: string) => {
    dispatch(openDocument(ephemeralDID));
  }, [dispatch]);

  // Handle remove document
  const handleRemove = useCallback((ephemeralDID: string) => {
    if (confirm('Are you sure you want to remove this document?')) {
      dispatch(removeDocument(ephemeralDID));
    }
  }, [dispatch]);

  // Handle request new copy
  const handleRequestNew = useCallback((originalDID: string) => {
    // Navigate to Employee Portal to request new copy
    window.open(`https://identuslabel.cz/company-admin/employee-portal-dashboard.html?requestDocument=${encodeURIComponent(originalDID)}`, '_blank');
  }, []);

  // Handle download document
  const handleDownload = useCallback(async (ephemeralDID: string) => {
    try {
      console.log('[MyDocuments] ====== DOWNLOAD START ======');
      console.log('[MyDocuments] Downloading document with ephemeralDID:', ephemeralDID);
      console.log('[MyDocuments] DID length:', ephemeralDID?.length);

      // Get full document from IndexedDB
      const doc = await getDocument(ephemeralDID);
      if (!doc) {
        console.error('[MyDocuments] Document not found in IndexedDB for DID:', ephemeralDID);
        alert('Document not found');
        return;
      }
      console.log('[MyDocuments] Document found in IndexedDB:', doc.title);

      // Get ephemeral key from localStorage using prefixedStorage
      let secretKey: Uint8Array | null = null;
      console.log('[MyDocuments] Searching for key...');
      console.log('[MyDocuments] Expected key name: ephemeral-key-' + ephemeralDID);

      // Method 1: Direct lookup by ephemeralDID
      console.log('[MyDocuments] Method 1: Direct lookup...');
      const directKey = getItem(`ephemeral-key-${ephemeralDID}`);
      console.log('[MyDocuments] Method 1 result:', directKey ? 'FOUND' : 'NOT FOUND');
      if (directKey && directKey.secretKey) {
        console.log('[MyDocuments] ✓ Found key by direct lookup');
        const binary = atob(directKey.secretKey);
        secretKey = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) {
          secretKey[j] = binary.charCodeAt(j);
        }
      }

      // Method 2: Search all ephemeral keys for matching DID
      if (!secretKey) {
        console.log('[MyDocuments] Method 2: Pattern search...');
        const ephemeralKeys = getKeysByPattern('ephemeral-key-');
        console.log('[MyDocuments] Method 2 found keys:', ephemeralKeys.length, ephemeralKeys);

        for (const keyName of ephemeralKeys) {
          const data = getItem(keyName);
          console.log('[MyDocuments] Checking key:', keyName, '-> ephemeralDID:', data?.ephemeralDID);
          if (data && data.ephemeralDID === ephemeralDID && data.secretKey) {
            console.log('[MyDocuments] ✓ Found key by pattern match:', keyName);
            const binary = atob(data.secretKey);
            secretKey = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) {
              secretKey[j] = binary.charCodeAt(j);
            }
            break;
          }
        }
      }

      // Method 3: Raw localStorage search (fallback)
      if (!secretKey) {
        console.log('[MyDocuments] Method 3: Raw localStorage search...');
        const rawMatches: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('ephemeral')) {
            rawMatches.push(key);
            try {
              const data = JSON.parse(localStorage.getItem(key) || '{}');
              const keyMatchesDID = key.includes(ephemeralDID);
              const dataMatchesDID = data.ephemeralDID === ephemeralDID;
              console.log('[MyDocuments] Raw key:', key, '| keyMatchesDID:', keyMatchesDID, '| dataMatchesDID:', dataMatchesDID, '| hasSecret:', !!data.secretKey);
              if (data.secretKey && (keyMatchesDID || dataMatchesDID)) {
                console.log('[MyDocuments] ✓ Match found in raw search!');
                const binary = atob(data.secretKey);
                secretKey = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) {
                  secretKey[j] = binary.charCodeAt(j);
                }
                break;
              }
            } catch (e) {
              console.log('[MyDocuments] Parse error for key:', key, e);
            }
          }
        }
        console.log('[MyDocuments] Method 3 raw matches:', rawMatches.length, rawMatches);
      }

      if (!secretKey) {
        console.error('[MyDocuments] ✗ KEY NOT FOUND for DID:', ephemeralDID);
        // Show all localStorage keys for debugging
        const allKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) allKeys.push(k);
        }
        const relevantKeys = allKeys.filter(k => k.includes('ephemeral') || k.includes('wallet-idl'));
        console.error('[MyDocuments] Relevant localStorage keys:', relevantKeys);
        console.error('[MyDocuments] Looking for DID:', ephemeralDID);
        alert('Decryption key not found. Please check browser console (F12) for debug info. The key may have been lost. Try requesting a new document from Employee Portal.');
        return;
      }
      console.log('[MyDocuments] ✓ Key found, proceeding with decryption...');

      // Fetch encrypted content from service endpoint if needed
      let encryptedContent = new Uint8Array(doc.encryptedContent);
      let serverPublicKey = doc.encryptionInfo.serverPublicKey;
      let nonce = doc.encryptionInfo.nonce;

      if (doc.isServiceEndpointMode && doc.serviceEndpoint) {
        console.log('[MyDocuments] Fetching from service endpoint...');
        const fetchedData = await fetchFromServiceEndpoint(doc.serviceEndpoint);

        // Decode base64 encrypted content
        const binary = atob(fetchedData.encryptedContent);
        encryptedContent = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          encryptedContent[i] = binary.charCodeAt(i);
        }
        serverPublicKey = fetchedData.serverPublicKey;
        nonce = fetchedData.nonce;
      }

      // Decode encryption parameters
      const serverPubKeyBytes = (() => {
        const binary = atob(serverPublicKey);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      })();

      const nonceBytes = (() => {
        const binary = atob(nonce);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      })();

      // Decrypt
      const decrypted = nacl.box.open(encryptedContent, nonceBytes, serverPubKeyBytes, secretKey);
      if (!decrypted) {
        alert('Decryption failed');
        return;
      }

      // Determine file type and extension
      console.log('[MyDocuments] Document sourceInfo:', doc.sourceInfo);
      console.log('[MyDocuments] Document format from sourceInfo:', doc.sourceInfo?.format);
      const format = doc.sourceInfo?.format?.toLowerCase() || 'html';
      console.log('[MyDocuments] Detected format:', format);
      let mimeType = 'text/html';
      let extension = '.html';
      if (format === 'docx') {
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        extension = '.docx';
        console.log('[MyDocuments] Using DOCX format');
      } else if (format === 'pdf') {
        mimeType = 'application/pdf';
        extension = '.pdf';
        console.log('[MyDocuments] Using PDF format');
      } else {
        console.log('[MyDocuments] Using HTML format (default)');
      }

      // Create download
      const filename = (doc.title || 'document').replace(/[^a-zA-Z0-9-_]/g, '_') + extension;
      const blob = new Blob([decrypted], { type: mimeType });
      const url = URL.createObjectURL(blob);

      const a = window.document.createElement('a');
      a.href = url;
      a.download = filename;
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);

      console.log('[MyDocuments] Downloaded:', filename);
    } catch (error: any) {
      console.error('[MyDocuments] Download failed:', error);
      alert('Download failed: ' + (error.message || error));
    }
  }, []);

  // Handle cleanup
  const handleCleanup = useCallback(() => {
    if (confirm('Remove all expired documents?')) {
      dispatch(cleanupDocuments());
    }
  }, [dispatch]);

  // Handle refresh
  const handleRefresh = useCallback(() => {
    dispatch(loadDocuments(showExpired));
  }, [dispatch, showExpired]);

  // Close viewer
  const handleCloseViewer = useCallback(() => {
    dispatch(closeViewer());
    dispatch(loadDocuments(showExpired)); // Refresh to update view count
  }, [dispatch, showExpired]);

  // Filter documents
  const filteredDocuments = showExpired
    ? classifiedDocuments.documents
    : classifiedDocuments.documents.filter(d => !d.isExpired);

  // Count stats
  const activeCount = classifiedDocuments.documents.filter(d => !d.isExpired).length;
  const expiredCount = classifiedDocuments.documents.filter(d => d.isExpired).length;

  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <DocumentIcon className="w-8 h-8 text-purple-400" />
          <h2 className="text-2xl font-bold text-white">My Documents</h2>
        </div>
        <p className="text-slate-400 text-sm">Your received classified documents with time-limited access</p>
      </header>

      <DBConnect>
        <Box>
            {/* Stats Bar */}
            <div className="mb-6 p-4 bg-slate-800/30 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-white">{activeCount}</div>
                    <div className="text-sm text-slate-400">Active</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-slate-500">{expiredCount}</div>
                    <div className="text-sm text-slate-400">Expired</div>
                  </div>
                  {classifiedDocuments.stats && (
                    <div className="border-l border-slate-700/50 pl-6">
                      <div className="text-sm text-slate-400">By Classification:</div>
                      <div className="flex gap-2 mt-1">
                        {Object.entries(classifiedDocuments.stats.byClassification || {}).map(([level, count]) => (
                          <span key={level} className={`px-2 py-0.5 rounded text-xs font-bold ${getClassificationBadge(level).color}`}>
                            {level}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {classifiedDocuments.lastRefresh && (
                  <div className="text-xs text-slate-500">
                    Last refresh: {new Date(classifiedDocuments.lastRefresh).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="mb-6 flex items-center gap-4">
              {/* Refresh Button */}
              <button
                onClick={handleRefresh}
                disabled={classifiedDocuments.isLoading}
                className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-xl ${
                  classifiedDocuments.isLoading
                    ? 'bg-slate-700/50 cursor-not-allowed'
                    : 'bg-gradient-to-r from-cyan-500 to-purple-500 hover:opacity-90'
                }`}
              >
                <RefreshIcon className={`w-4 h-4 ${classifiedDocuments.isLoading ? 'animate-spin' : ''}`} />
                {classifiedDocuments.isLoading ? 'Loading...' : 'Refresh'}
              </button>

              {/* Show Expired Toggle */}
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={showExpired}
                  onChange={(e) => setShowExpired(e.target.checked)}
                  className="rounded border-slate-700/50 text-cyan-500 focus:ring-cyan-500/50 bg-slate-800/50"
                />
                Show expired documents
              </label>

              {/* Cleanup Button */}
              {expiredCount > 0 && (
                <button
                  onClick={handleCleanup}
                  className="ml-auto px-4 py-2 text-sm font-medium text-red-300 bg-red-500/20 rounded-xl hover:bg-red-500/30 border border-red-500/30 flex items-center gap-2"
                >
                  <TrashIcon className="w-4 h-4" />
                  Clean up ({expiredCount})
                </button>
              )}
            </div>

            {/* Error Message */}
            {classifiedDocuments.error && (
              <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-2xl text-red-300 flex items-center gap-2">
                <ExclamationIcon className="w-5 h-5" />
                <span>{classifiedDocuments.error}</span>
              </div>
            )}

            {/* Documents List */}
            {!classifiedDocuments.isLoading && filteredDocuments.length === 0 && (
              <div className="text-center py-12">
                <DocumentIcon className="w-16 h-16 mx-auto text-slate-600 mb-4" />
                <p className="text-lg text-slate-400">No documents found</p>
                <p className="text-sm text-slate-500 mt-2">
                  Documents you receive via the Employee Portal will appear here.
                </p>
              </div>
            )}

            {filteredDocuments.length > 0 && (
              <div className="space-y-4">
                {filteredDocuments.map((doc) => (
                  <DocumentCard
                    key={doc.ephemeralDID}
                    document={doc}
                    onView={handleView}
                    onDownload={handleDownload}
                    onRemove={handleRemove}
                    onRequestNew={handleRequestNew}
                  />
                ))}
              </div>
            )}

            {/* Document Count */}
            {filteredDocuments.length > 0 && (
              <div className="mt-6 text-sm text-slate-500 text-center">
                Showing {filteredDocuments.length} of {classifiedDocuments.documents.length} documents
              </div>
            )}

            {/* TTL Notice */}
            <div className="mt-8 p-4 bg-amber-500/20 border border-amber-500/30 rounded-2xl backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <ClockIcon className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-amber-300">Time-Limited Access</div>
                  <p className="text-sm text-amber-400/80 mt-1">
                    Documents have a server-defined expiration time (TTL). Once expired, the document
                    content is automatically deleted from your wallet. You can request a new copy
                    from the Employee Portal, which will verify your current security clearance.
                  </p>
                </div>
              </div>
            </div>

            {/* Redaction Notice */}
            <div className="mt-4 p-4 bg-purple-500/20 border border-purple-500/30 rounded-2xl backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <ShieldCheckIcon className="w-6 h-6 text-purple-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-purple-300">Section-Level Redaction</div>
                  <p className="text-sm text-purple-400/80 mt-1">
                    Documents may contain sections with different security classifications.
                    Sections above your clearance level are redacted (blacked out) and cannot
                    be viewed without the appropriate security clearance credential.
                  </p>
                </div>
              </div>
            </div>
        </Box>
      </DBConnect>

      {/* Document Viewer Modal */}
      {classifiedDocuments.isViewing && classifiedDocuments.selectedDocument && (
        <ClassifiedDocumentViewer
          document={classifiedDocuments.selectedDocument}
          onClose={handleCloseViewer}
        />
      )}
    </div>
  );
}
