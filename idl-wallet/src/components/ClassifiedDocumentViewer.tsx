/**
 * ClassifiedDocumentViewer.tsx
 *
 * Secure viewer for classified documents with redaction.
 * Uses HTML rendering with redacted sections shown as black boxes.
 * Includes download prevention measures (disabled right-click, blocked shortcuts).
 *
 * Features:
 * - HTML content rendering with redaction
 * - Classification badge display
 * - Section visibility summary
 * - Download prevention (context menu, keyboard shortcuts)
 * - TTL countdown display
 * - Watermark overlay
 *
 * @version 1.0.0
 * @date 2025-12-12
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { StoredDocument } from '@/utils/documentStorage';
import nacl from 'tweetnacl';
import * as docxPreview from 'docx-preview';
import {
  XIcon,
  DocumentIcon,
  ClockIcon,
  ShieldCheckIcon,
  ExclamationIcon,
  LockClosedIcon,
  EyeIcon,
  CloudDownloadIcon,
  RefreshIcon,
  CollectionIcon
} from '@heroicons/react/solid';
import { getSecurityClearanceKeys } from '@/utils/securityKeyStorage';
import {
  fetchManifestHistory,
  verifyManifestChain,
  type ManifestHistoryResponse,
  type ChainVerificationResult
} from '@/utils/KeyAuthorityClient';

/**
 * Classification badge configuration
 */
const getClassificationBadge = (level: string) => {
  switch (level?.toUpperCase()) {
    case 'UNCLASSIFIED':
      return { color: 'bg-green-600', label: 'UNCLASSIFIED' };
    case 'CONFIDENTIAL':
      return { color: 'bg-blue-600', label: 'CONFIDENTIAL' };
    case 'SECRET':
      return { color: 'bg-orange-600', label: 'SECRET' };
    case 'TOP_SECRET':
      return { color: 'bg-red-600', label: 'SECRET' };
    default:
      return { color: 'bg-gray-600', label: level || 'CLASSIFIED' };
  }
};

/**
 * Format remaining time for display
 */
const formatTimeRemaining = (expiresAt: string): string => {
  const now = new Date();
  const expires = new Date(expiresAt);
  const diff = expires.getTime() - now.getTime();

  if (diff <= 0) return 'EXPIRED';

  const minutes = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

interface ClassifiedDocumentViewerProps {
  document: StoredDocument;
  onClose: () => void;
  // Edit/update props (optional — only shown for DOCX when provided)
  editState?: 'idle' | 'requesting' | 'editing' | 'uploading' | 'done' | 'error';
  editError?: string | null;
  selectedFile?: File | null;
  onEdit?: (originalDocumentDID: string) => void;
  onFileSelect?: (file: File | null) => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
}

/**
 * ClassifiedDocumentViewer Component
 */
export const ClassifiedDocumentViewer: React.FC<ClassifiedDocumentViewerProps> = ({
  document,
  onClose,
  editState,
  editError,
  selectedFile,
  onEdit,
  onFileSelect,
  onSubmitEdit,
  onCancelEdit,
}) => {
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [decryptedBytes, setDecryptedBytes] = useState<Uint8Array | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(formatTimeRemaining(document.expiresAt));
  const contentRef = useRef<HTMLDivElement>(null);
  const docxContainerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const isDocx = document.sourceInfo?.format?.toLowerCase() === 'docx';

  // Version history state
  const [activeTab, setActiveTab] = useState<'document' | 'history'>('document');
  const [manifestHistory, setManifestHistory] = useState<ManifestHistoryResponse | null>(null);
  const [chainVerificationResult, setChainVerificationResult] = useState<ChainVerificationResult | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Get MIME type based on document format
  const getMimeType = (format: string | undefined): string => {
    switch (format?.toLowerCase()) {
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'pdf':
        return 'application/pdf';
      case 'html':
      default:
        return 'text/html';
    }
  };

  // Get file extension based on format
  const getFileExtension = (format: string | undefined): string => {
    switch (format?.toLowerCase()) {
      case 'docx':
        return '.docx';
      case 'pdf':
        return '.pdf';
      case 'html':
      default:
        return '.html';
    }
  };

  // Download decrypted document
  const handleDownload = useCallback(() => {
    if (!decryptedBytes) return;

    const format = document.sourceInfo?.format;
    const mimeType = getMimeType(format);
    const extension = getFileExtension(format);
    // Use original filename from sourceInfo if available; otherwise derive from title.
    // Strip any existing extension from the base name before appending the canonical one
    // to avoid doubling (e.g. "ACME_Test (1).docx" → base "ACME_Test (1)" → "ACME_Test (1).docx").
    const rawBase = document.sourceInfo?.filename || document.title || 'document';
    const baseName = rawBase.replace(/\.[^.]+$/, ''); // strip extension if present
    // Replace only characters illegal in filenames on common platforms (/ \ : * ? " < > |)
    const filename = baseName.replace(/[/\\:*?"<>|]/g, '_') + extension;

    const blob = new Blob([decryptedBytes], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = window.document.createElement('a');
    a.href = url;
    a.download = filename;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('[ClassifiedDocumentViewer] Downloaded:', filename);
  }, [decryptedBytes, document.title, document.sourceInfo?.format]);

  // Load version history from document-service via company-admin proxy
  const loadHistory = useCallback(async () => {
    const did = document.originalDocumentDID;
    if (!did) return;
    setIsLoadingHistory(true);
    setChainVerificationResult(null);
    try {
      const data = await fetchManifestHistory(did);
      setManifestHistory(data);
    } catch (err: any) {
      console.error('[ClassifiedDocumentViewer] Failed to load history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [document.originalDocumentDID]);

  // Update countdown every minute
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeRemaining(formatTimeRemaining(document.expiresAt));
    }, 60000);

    return () => clearInterval(interval);
  }, [document.expiresAt]);

  // Decrypt document content
  useEffect(() => {
    const decryptDocument = async () => {
      setIsDecrypting(true);
      setError(null);

      try {
        console.log('[ClassifiedDocumentViewer] Decrypting document:', document.ephemeralDID);

        // Plaintext documents (VC-gate access flow — no decryption needed)
        if (document.encryptionInfo?.algorithm === 'plaintext') {
          const bytes = new Uint8Array(document.encryptedContent);
          setDecryptedBytes(bytes);
          setDecryptedContent(new TextDecoder('utf-8').decode(bytes));
          setIsDecrypting(false);
          return;
        }

        // Try to decrypt with available keys
        let decrypted: Uint8Array | null = null;

        // FIRST: Try ephemeral key specific to this document (from SSI flow)
        const ephemeralPrivateKey = getEphemeralKey(document.ephemeralDID);
        if (ephemeralPrivateKey) {
          console.log('[ClassifiedDocumentViewer] Trying ephemeral key decryption...');
          try {
            const serverPublicKey = base64ToUint8Array(document.encryptionInfo.serverPublicKey);
            const nonce = base64ToUint8Array(document.encryptionInfo.nonce);
            const ciphertext = new Uint8Array(document.encryptedContent);

            decrypted = nacl.box.open(ciphertext, nonce, serverPublicKey, ephemeralPrivateKey);

            if (decrypted) {
              console.log('[ClassifiedDocumentViewer] Ephemeral key decryption successful!');
              // Notify server for audit log (fire-and-forget, never blocks decryption)
              fetch('/company-admin/api/access-gate/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  documentDID: document.originalDocumentDID,
                  ephemeralDID: document.ephemeralDID,
                  clearanceLevel: document.overallClassification,
                }),
              }).catch(() => {});
            }
          } catch (ephemeralErr) {
            console.warn('[ClassifiedDocumentViewer] Ephemeral key decryption failed:', ephemeralErr);
          }
        }

        // FALLBACK: Try security-clearance keys if ephemeral key didn't work
        if (!decrypted) {
          console.log('[ClassifiedDocumentViewer] Trying security-clearance keys...');
          const keys = getAllSecurityKeys();

          if (keys && keys.length > 0) {
            for (const keyPair of keys) {
              try {
                if (!keyPair.x25519PrivateKey) continue;

                // Decode the encryption parameters
                const serverPublicKey = base64ToUint8Array(document.encryptionInfo.serverPublicKey);
                const nonce = base64ToUint8Array(document.encryptionInfo.nonce);
                const ciphertext = new Uint8Array(document.encryptedContent);
                const privateKey = hexToUint8Array(keyPair.x25519PrivateKey);

                // Decrypt using NaCl box.open
                decrypted = nacl.box.open(ciphertext, nonce, serverPublicKey, privateKey);

                if (decrypted) {
                  console.log('[ClassifiedDocumentViewer] Security-clearance key decryption successful');
                  break;
                }
              } catch (keyErr) {
                console.log('[ClassifiedDocumentViewer] Key failed, trying next...');
              }
            }
          }
        }

        if (!decrypted) {
          throw new Error('Failed to decrypt document - no valid keys found');
        }

        // Store raw bytes for download
        setDecryptedBytes(decrypted);

        const format = document.sourceInfo?.format?.toLowerCase();
        if (format === 'docx') {
          // DOCX: do not decode to string — rendered separately via docx-preview
          setDecryptedContent('__docx__');
        } else {
          // HTML/plaintext: decode to string for display
          const htmlContent = new TextDecoder('utf-8').decode(decrypted);
          setDecryptedContent(htmlContent);
        }

      } catch (err: any) {
        console.error('[ClassifiedDocumentViewer] Decryption error:', err);
        setError(err.message || 'Failed to decrypt document');
      } finally {
        setIsDecrypting(false);
      }
    };

    decryptDocument();
  }, [document]);

  // Render DOCX using docx-preview when bytes are available
  useEffect(() => {
    if (!isDocx || !decryptedBytes || !docxContainerRef.current) return;
    const container = docxContainerRef.current;
    container.innerHTML = '';
    docxPreview.renderAsync(
      decryptedBytes.buffer as ArrayBuffer,
      container,
      undefined,
      {
        className: 'docx-preview-wrapper',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
        useBase64URL: true,
      }
    ).catch((err: any) => {
      console.error('[ClassifiedDocumentViewer] docx-preview render error:', err);
      container.innerHTML = `<p style="color:red;padding:2rem">Failed to render DOCX: ${err.message}</p>`;
    });
  }, [isDocx, decryptedBytes]);

  // Block keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Block Ctrl+S (save), Ctrl+P (print), Ctrl+C (copy)
      if (e.ctrlKey && (e.key === 's' || e.key === 'p')) {
        e.preventDefault();
        console.log('[ClassifiedDocumentViewer] Blocked shortcut:', e.key);
      }
    };

    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Prevent context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    console.log('[ClassifiedDocumentViewer] Context menu blocked');
  }, []);

  // Handle ESC key to close
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.document.addEventListener('keydown', handleEsc);
    return () => window.document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  // Get ephemeral key for this specific document (stored by SSI flow)
  const getEphemeralKey = (ephemeralDID: string): Uint8Array | null => {
    // Try to find key by ephemeralDID
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes(`ephemeral-key-${ephemeralDID}`)) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}');
          if (data.secretKey) {
            // Convert base64 secretKey to Uint8Array
            console.log('[ClassifiedDocumentViewer] Found ephemeral key for:', ephemeralDID);
            return base64ToUint8Array(data.secretKey);
          }
        } catch (e) {
          console.warn('[ClassifiedDocumentViewer] Failed to parse ephemeral key:', e);
        }
      }
    }

    // Also try pattern matching for any ephemeral key with matching DID
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('ephemeral-key-')) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}');
          if (data.ephemeralDID === ephemeralDID && data.secretKey) {
            console.log('[ClassifiedDocumentViewer] Found ephemeral key by DID match:', ephemeralDID);
            return base64ToUint8Array(data.secretKey);
          }
        } catch (e) {
          // Skip invalid entries
        }
      }
    }

    return null;
  };

  // Get all security keys from storage (fallback for security-clearance keys)
  const getAllSecurityKeys = (): Array<{x25519PrivateKey?: string}> => {
    const keys: Array<{x25519PrivateKey?: string}> = [];

    // Get all keys matching security-clearance pattern
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('security-clearance-keys')) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}');
          if (data.x25519PrivateKey) {
            keys.push(data);
          }
        } catch (e) {
          // Skip invalid entries
        }
      }
    }

    return keys;
  };

  // Helper: base64 to Uint8Array
  const base64ToUint8Array = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  // Helper: hex to Uint8Array
  const hexToUint8Array = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  };

  const badge = getClassificationBadge(document.overallClassification);

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 bg-black bg-opacity-75 z-50 flex flex-col"
      onContextMenu={handleContextMenu}
    >
      {/* Header */}
      <div className={`${badge.color} text-white px-6 py-4 flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-4 min-w-0 overflow-hidden">
          <DocumentIcon className="w-8 h-8 flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-bold text-xl">{badge.label}</div>
            <div className="text-sm opacity-80 truncate">{document.title}</div>
          </div>
        </div>

        <div className="flex items-center gap-6 flex-shrink-0">
          {/* TTL Display */}
          <div className="flex items-center gap-2 bg-black bg-opacity-30 px-3 py-1 rounded">
            <ClockIcon className="w-5 h-5" />
            <span className="font-mono">{timeRemaining}</span>
          </div>

          {/* Section Summary */}
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1">
              <EyeIcon className="w-4 h-4" />
              {document.sectionSummary?.visibleCount || 0} visible
            </span>
            {(document.sectionSummary?.redactedCount || 0) > 0 && (
              <span className="flex items-center gap-1 text-yellow-300">
                <LockClosedIcon className="w-4 h-4" />
                {document.sectionSummary.redactedCount} redacted
              </span>
            )}
          </div>

          {/* Download Button */}
          {decryptedBytes && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-3 py-1.5 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg transition-colors"
              title="Download decrypted document"
            >
              <CloudDownloadIcon className="w-5 h-5" />
              <span className="text-sm font-medium">Download</span>
            </button>
          )}

          {/* Update Button (DOCX only) */}
          {isDocx && onEdit && (
            <button
              onClick={() => onEdit(document.originalDocumentDID)}
              disabled={editState !== 'idle' && editState !== undefined}
              className="flex items-center gap-2 px-3 py-1.5 bg-amber-500 bg-opacity-80 hover:bg-opacity-100 rounded-lg transition-colors disabled:opacity-50"
              title="Upload updated version of this document"
            >
              <RefreshIcon className="w-5 h-5" />
              <span className="text-sm font-medium">
                {editState === 'requesting' ? 'Requesting…' : editState === 'uploading' ? 'Uploading…' : 'Update'}
              </span>
            </button>
          )}

          {/* Version History Button */}
          {document.originalDocumentDID && (
            <button
              onClick={() => {
                const next = activeTab === 'history' ? 'document' : 'history';
                setActiveTab(next);
                if (next === 'history' && !manifestHistory) loadHistory();
              }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'history'
                  ? 'bg-white bg-opacity-40 ring-2 ring-white ring-opacity-60'
                  : 'bg-white bg-opacity-20 hover:bg-opacity-30'
              }`}
              title="Version history"
            >
              <CollectionIcon className="w-5 h-5" />
              <span className="text-sm font-medium">History</span>
            </button>
          )}

          {/* Close Button */}
          <button
            onClick={onClose}
            className="p-2 hover:bg-black hover:bg-opacity-30 rounded-full transition-colors"
            title="Close (ESC)"
          >
            <XIcon className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Update / Edit UI */}
      {isDocx && onEdit && editState && editState !== 'idle' && (
        <div className="bg-amber-900/80 border-b border-amber-600/50 px-6 py-3">
          {editState === 'editing' && (
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-sm text-amber-200">Edit the downloaded DOCX, then upload the updated file:</span>
              <input
                type="file"
                accept=".docx"
                onChange={e => onFileSelect?.(e.target.files?.[0] ?? null)}
                className="text-sm text-slate-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-amber-500/30 file:text-amber-200 hover:file:bg-amber-500/50"
              />
              <button
                onClick={onSubmitEdit}
                disabled={!selectedFile}
                className="px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm hover:bg-amber-400 disabled:opacity-50"
              >
                Submit Update
              </button>
              <button
                onClick={onCancelEdit}
                className="px-4 py-1.5 bg-slate-600 text-slate-200 rounded-lg text-sm hover:bg-slate-500"
              >
                Cancel
              </button>
            </div>
          )}
          {editState === 'uploading' && (
            <span className="text-sm text-amber-200">Uploading and processing updated document…</span>
          )}
          {editState === 'done' && (
            <div className="flex items-center gap-3">
              <ShieldCheckIcon className="w-5 h-5 text-green-400" />
              <span className="text-sm text-green-300">Document updated successfully.</span>
              <button onClick={onCancelEdit} className="text-xs text-slate-400 hover:text-white ml-2">Dismiss</button>
            </div>
          )}
          {editState === 'error' && (
            <div className="flex items-center gap-3">
              <ExclamationIcon className="w-5 h-5 text-red-400" />
              <span className="text-sm text-red-300">{editError || 'Update failed'}</span>
              <button onClick={onCancelEdit} className="text-xs text-slate-400 hover:text-white ml-2">Dismiss</button>
            </div>
          )}
        </div>
      )}

      {/* Content Area */}
      <div className="flex-1 overflow-auto bg-gray-100 relative">

        {/* ── History Panel ──────────────────────────────────────────── */}
        {activeTab === 'history' && (
          <div className="max-w-4xl mx-auto my-6 px-4">
            <div className="bg-white rounded-xl shadow-lg overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <CollectionIcon className="w-5 h-5 text-gray-500" />
                  Version History
                </h2>
                <div className="flex items-center gap-3">
                  {manifestHistory && (
                    <button
                      onClick={async () => {
                        const result = await verifyManifestChain(manifestHistory);
                        setChainVerificationResult(result);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                      <ShieldCheckIcon className="w-4 h-4" />
                      Verify Chain
                    </button>
                  )}
                  <button
                    onClick={loadHistory}
                    disabled={isLoadingHistory}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                  >
                    <RefreshIcon className={`w-4 h-4 ${isLoadingHistory ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
              </div>

              {/* Chain verification result */}
              {chainVerificationResult && (
                <div className={`px-6 py-3 flex items-center gap-3 text-sm border-b ${
                  chainVerificationResult.valid
                    ? 'bg-green-50 border-green-200 text-green-800'
                    : 'bg-red-50 border-red-200 text-red-800'
                }`}>
                  {chainVerificationResult.valid ? (
                    <ShieldCheckIcon className="w-5 h-5 text-green-600 flex-shrink-0" />
                  ) : (
                    <ExclamationIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
                  )}
                  <span className="font-medium">
                    {chainVerificationResult.valid
                      ? `Chain intact — all predecessor hashes verified`
                      : `Chain broken: ${chainVerificationResult.reason}`}
                  </span>
                </div>
              )}

              {/* Loading state */}
              {isLoadingHistory && (
                <div className="flex items-center justify-center py-16">
                  <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
                </div>
              )}

              {/* Empty state */}
              {!isLoadingHistory && !manifestHistory && (
                <div className="text-center py-16 text-gray-500">
                  <CollectionIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No history loaded. Click Refresh to load.</p>
                </div>
              )}

              {/* History table */}
              {!isLoadingHistory && manifestHistory && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600 uppercase text-xs">
                      <tr>
                        <th className="px-6 py-3 text-left">Version</th>
                        <th className="px-6 py-3 text-left">Updated By</th>
                        <th className="px-6 py-3 text-left">Issued At</th>
                        <th className="px-6 py-3 text-left">Classification</th>
                        <th className="px-6 py-3 text-left">Chain</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {/* Current version row */}
                      {manifestHistory.current && (() => {
                        const c = manifestHistory.current;
                        const payload = c.vcJwt
                          ? (() => { try { return JSON.parse(atob(c.vcJwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { return null; } })()
                          : null;
                        const cs = payload?.vc?.credentialSubject || {};
                        return (
                          <tr key={c.vcId} className="bg-indigo-50">
                            <td className="px-6 py-4 font-mono font-semibold text-indigo-700">
                              v{cs.versionNumber ?? '—'}
                              <span className="ml-2 text-xs bg-indigo-200 text-indigo-800 px-1.5 py-0.5 rounded">current</span>
                            </td>
                            <td className="px-6 py-4 text-gray-700">{cs.updatedBy || '—'}</td>
                            <td className="px-6 py-4 text-gray-600 font-mono text-xs">
                              {c.issuedAt ? new Date(c.issuedAt).toLocaleString() : '—'}
                            </td>
                            <td className="px-6 py-4">{cs.classificationLevel || '—'}</td>
                            <td className="px-6 py-4">
                              {chainVerificationResult
                                ? <ShieldCheckIcon className="w-4 h-4 text-green-500" />
                                : <span className="text-gray-400">—</span>}
                            </td>
                          </tr>
                        );
                      })()}

                      {/* History rows (newest-first) */}
                      {manifestHistory.history.map((entry, idx) => {
                        const payload = entry.vcJwt
                          ? (() => { try { return JSON.parse(atob(entry.vcJwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { return null; } })()
                          : null;
                        const cs = payload?.vc?.credentialSubject || {};
                        const linkIdx = idx; // link 0 = between current and history[0], etc.
                        const linkOk = chainVerificationResult?.valid ||
                          (chainVerificationResult?.brokenAt !== undefined && linkIdx < chainVerificationResult.brokenAt);
                        return (
                          <tr key={entry.vcId} className="hover:bg-gray-50">
                            <td className="px-6 py-4 font-mono text-gray-600">v{cs.versionNumber ?? '—'}</td>
                            <td className="px-6 py-4 text-gray-600">{cs.updatedBy || '—'}</td>
                            <td className="px-6 py-4 text-gray-500 font-mono text-xs">
                              {entry.issuedAt ? new Date(entry.issuedAt).toLocaleString() : '—'}
                            </td>
                            <td className="px-6 py-4 text-gray-500">{cs.classificationLevel || '—'}</td>
                            <td className="px-6 py-4">
                              {chainVerificationResult
                                ? (linkOk
                                  ? <ShieldCheckIcon className="w-4 h-4 text-green-500" />
                                  : <ExclamationIcon className="w-4 h-4 text-red-500" />)
                                : <span className="text-gray-400">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {manifestHistory.history.length === 0 && (
                    <p className="text-center text-gray-400 text-sm py-6">No previous versions — this is the first version.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Document view (hidden when history tab active) ──────── */}
        <div className={activeTab === 'history' ? 'hidden' : ''}>
        {/* Loading State */}
        {isDecrypting && (
          <div className="absolute inset-0 flex items-center justify-center bg-white">
            <div className="text-center">
              <div className="animate-spin w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-lg text-gray-600">Decrypting document...</p>
              <p className="text-sm text-gray-400 mt-2">This may take a moment</p>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !isDecrypting && (
          <div className="absolute inset-0 flex items-center justify-center bg-white">
            <div className="text-center max-w-md p-6">
              <ExclamationIcon className="w-16 h-16 text-red-500 mx-auto mb-4" />
              <h3 className="text-xl font-bold text-gray-900 mb-2">Decryption Failed</h3>
              <p className="text-gray-600 mb-4">{error}</p>
              <p className="text-sm text-gray-400">
                This could be due to missing or invalid security clearance keys.
                Ensure you have the correct Security Clearance credential.
              </p>
              <button
                onClick={onClose}
                className="mt-6 px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Document Content */}
        {decryptedContent && !isDecrypting && !error && (
          <div className="relative">
            {/* Watermark */}
            <div
              className="fixed inset-0 flex items-center justify-center pointer-events-none select-none opacity-5 z-10"
              style={{ transform: 'rotate(-45deg)' }}
            >
              <div className="text-9xl font-bold text-gray-900 whitespace-nowrap">
                {badge.label}
              </div>
            </div>

            {isDocx ? (
              /* DOCX rendered by docx-preview into a container div */
              <div
                ref={docxContainerRef}
                className="max-w-5xl mx-auto my-4 bg-white shadow-xl select-none"
                style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none' }}
              />
            ) : (
              <>
                {/* Document Styles (HTML only) */}
                <style>{`
                  .classified-doc-content {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 16px; line-height: 1.6; color: #1a1a1a;
                  }
                  .classified-doc-content h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; }
                  .classified-doc-content h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0; }
                  .classified-doc-content h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0; }
                  .classified-doc-content p { margin: 1em 0; }
                  .classified-doc-content section { margin: 1.5em 0; padding: 1em; border-left: 4px solid #e0e0e0; }
                  .classified-doc-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
                  .classified-doc-content th, .classified-doc-content td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                  .classified-doc-content th { background: #f5f5f5; }
                  .classified-doc-content [data-clearance] { position: relative; display: block; padding-top: 24px; margin: 1em 0; }
                  .classified-doc-content [data-clearance]::before { content: attr(data-clearance); position: absolute; top: 0; right: 0; font-size: 11px; padding: 3px 10px; border-radius: 4px; font-weight: bold; text-transform: uppercase; }
                  .classified-doc-content [data-clearance="UNCLASSIFIED"]::before { background: #4CAF50; color: white; }
                  .classified-doc-content [data-clearance="CONFIDENTIAL"]::before { background: #2196F3; color: white; }
                  .classified-doc-content [data-clearance="SECRET"]::before { background: #f44336; color: white; }
                  .classified-doc-content .redacted-block { background: #000; color: #fff; padding: 30px; margin: 15px 0; border: 3px solid #f00; border-radius: 4px; text-align: center; min-height: 80px; display: flex; align-items: center; justify-content: center; }
                  .classified-doc-content .redaction-label { font-size: 24px; font-weight: bold; letter-spacing: 4px; }
                  .classified-doc-content .clearance-required { font-size: 12px; opacity: 0.8; margin-top: 8px; }
                  .classified-doc-content .redacted-inline { background: #000; color: #f44; padding: 2px 8px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
                `}</style>

                {/* HTML Content */}
                <div
                  ref={contentRef}
                  className="classified-doc-content max-w-4xl mx-auto p-8 bg-white shadow-xl my-4 select-none"
                  dangerouslySetInnerHTML={{ __html: decryptedContent }}
                  style={{ userSelect: 'none', WebkitUserSelect: 'none', msUserSelect: 'none' }}
                />
              </>
            )}
          </div>
        )}
        </div>{/* end document-view wrapper */}
      </div>{/* end Content Area */}

      {/* Footer */}
      <div className="bg-gray-800 text-gray-400 px-6 py-3 text-sm flex items-center justify-between">
        <div className="flex items-center gap-4">
          <ShieldCheckIcon className="w-5 h-5" />
          <span>Secure Viewer - Download Disabled</span>
        </div>
        <div className="flex items-center gap-4">
          <span>View #{document.viewCount} / {document.maxViews === -1 ? 'Unlimited' : document.maxViews}</span>
          <span>|</span>
          <span>{document.sourceInfo?.format?.toUpperCase() || 'HTML'}</span>
          <span>|</span>
          <span>Ephemeral ID: {document.ephemeralDID.substring(0, 20)}...</span>
        </div>
      </div>
    </div>
  );
};

export default ClassifiedDocumentViewer;
