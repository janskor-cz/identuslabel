/**
 * Documents Page
 *
 * Combined view for:
 * - Available Documents: Ephemeral documents from server based on clearance level
 * - My Documents: Received documents stored locally with TTL
 *
 * @version 2.0.0
 * @date 2026-01-03
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import '../app/index.css';
import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector, useAppDispatch } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { DocumentDIDAccess } from "@/components/DocumentDIDAccess";
import { getCredentialSubject, getCredentialType } from "@/utils/credentialTypeDetector";
import {
  LockClosedIcon,
  DocumentIcon,
  RefreshIcon,
  ShieldCheckIcon,
  ClockIcon,
  EyeIcon,
  TrashIcon,
  ExclamationIcon,
  CheckCircleIcon,
  CloudDownloadIcon
} from '@heroicons/react/solid';
import nacl from 'tweetnacl';
import {
  loadDocuments as loadMyDocuments,
  openDocument,
  removeDocument,
  cleanupDocuments,
  closeViewer
} from "@/reducers/classifiedDocuments";
import { selectEnterpriseCredentials, selectEnterpriseDIDs, selectIsEnterpriseConfigured, selectActiveConfiguration } from '@/reducers/enterpriseAgent';
import { refreshEnterpriseCredentials } from '@/actions/enterpriseAgentActions';
import { DocumentSummary, formatRemainingTime, getDocument, fetchFromServiceEndpoint } from "@/utils/documentStorage";
import { getItem, getKeysByPattern } from "@/utils/prefixedStorage";
import {
  WalletFolder,
  getFolders, createFolder as createWalletFolder, deleteFolder as deleteWalletFolder,
  renameFolder as renameWalletFolder, getDocFolderMap, setDocFolder, removeDocFromFolders
} from '@/utils/walletFolderStorage';
import { ClassifiedDocumentViewer } from "@/components/ClassifiedDocumentViewer";
import { requestEditAccess } from "@/utils/KeyAuthorityClient";

/**
 * Classification badge configuration (string)
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
      return { color: 'bg-red-700/20 text-red-300 border-red-700/30', label: 'SECRET' };
    default:
      return { color: 'bg-slate-500/20 text-slate-400 border-slate-500/30', label: level || 'UNKNOWN' };
  }
};

/**
 * My Document Card Component (for received documents)
 */
const MyDocumentCard: React.FC<{
  document: DocumentSummary;
  onView: (ephemeralDID: string) => void;
  onDownload: (ephemeralDID: string) => void;
  onRemove: (ephemeralDID: string, originalDocumentDID: string) => void;
  onRequestNew: (originalDID: string) => void;
  onEdit?: (ephemeralDID: string, originalDocumentDID: string) => void;
  editState?: 'idle' | 'requesting' | 'editing' | 'uploading' | 'done' | 'error';
  editDocDID?: string | null;
  selectedFile?: File | null;
  onFileSelect?: (file: File | null) => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
  editError?: string | null;
}> = ({ document, onView, onDownload, onRemove, onRequestNew, onEdit, editState, editDocDID, selectedFile, onFileSelect, onSubmitEdit, onCancelEdit, editError }) => {
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
                {document.sourceInfo?.format === 'docx' && onEdit && (
                  <button
                    onClick={() => onEdit(document.ephemeralDID, document.originalDocumentDID)}
                    disabled={editState !== 'idle' && editState !== undefined}
                    className="px-4 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    <DocumentIcon className="w-4 h-4" />
                    {editState === 'requesting' && editDocDID === document.originalDocumentDID ? 'Requesting…' : 'Edit'}
                  </button>
                )}
                <button
                  onClick={() => onRemove(document.ephemeralDID, document.originalDocumentDID)}
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
                  onClick={() => onRemove(document.ephemeralDID, document.originalDocumentDID)}
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

      {/* Edit upload UI — shown when this card is in editing state */}
      {editState === 'editing' && editDocDID === document.originalDocumentDID && (
        <div className="mx-4 mb-4 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <p className="text-sm text-amber-300 mb-3">Edit the downloaded DOCX, then upload the updated file:</p>
          <input
            type="file"
            accept=".docx"
            onChange={e => onFileSelect?.(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-300 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-amber-500/20 file:text-amber-300 hover:file:bg-amber-500/30 mb-3"
          />
          <div className="flex gap-2">
            <button
              onClick={onSubmitEdit}
              disabled={!selectedFile || editState === 'uploading'}
              className="px-4 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 text-sm disabled:opacity-50"
            >
              Submit Updated Version
            </button>
            <button
              onClick={onCancelEdit}
              className="px-4 py-2 bg-slate-700 text-slate-300 rounded-xl hover:bg-slate-600 text-sm"
            >
              Cancel
            </button>
          </div>
          {editError && <p className="mt-2 text-sm text-red-400">{editError}</p>}
        </div>
      )}
      {editState === 'uploading' && editDocDID === document.originalDocumentDID && (
        <div className="mx-4 mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-sm text-amber-300">
          Uploading and merging…
        </div>
      )}
      {editState === 'done' && editDocDID === document.originalDocumentDID && (
        <div className="mx-4 mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-sm text-emerald-300">
          Document updated successfully.
        </div>
      )}
      {editState === 'error' && editDocDID === document.originalDocumentDID && (
        <div className="mx-4 mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-2">
          <ExclamationIcon className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-400">{editError || 'Edit request failed'}</p>
            <button onClick={onCancelEdit} className="mt-2 text-xs text-slate-400 hover:text-slate-200 underline">
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Documents Page Component
 */
export default function DocumentsPage() {
  const app = useMountedApp();
  const dispatch = useAppDispatch();
  const enterpriseCredentials = useAppSelector(selectEnterpriseCredentials);
  const enterpriseDIDs = useAppSelector(selectEnterpriseDIDs);
  const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
  const enterpriseConfig = useAppSelector(selectActiveConfiguration);
  const classifiedDocuments = useAppSelector(state => state.classifiedDocuments);

  // Deep-link: ?did=<documentDID> from employee portal "View" button
  const deepLinkDID = typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search)).get('did') || undefined
    : undefined;

  // My Documents state
  const [showExpired, setShowExpired] = useState(true);

  // Edit / versioning state (memory only — never persisted)
  const [editState, setEditState] = useState<'idle' | 'requesting' | 'editing' | 'uploading' | 'done' | 'error'>('idle');
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editDocDID, setEditDocDID] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // File explorer state
  const [folderPath, setFolderPath] = useState<Array<{id: string; name: string}>>([]);
  const [folders, setFolders] = useState<WalletFolder[]>([]);
  const [docFolderMap, setDocFolderMap] = useState<Record<string, string | null>>({});
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [showDIDPanel, setShowDIDPanel] = useState(!!deepLinkDID);
  const [panelDID, setPanelDID] = useState(deepLinkDID || '');
  const [panelAutoTrigger, setPanelAutoTrigger] = useState(!!deepLinkDID);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    type: 'folder' | 'doc';
    id: string;
    name?: string;
  } | null>(null);

  // API configuration (used by edit handlers)
  const apiBaseUrl = 'https://identuslabel.cz/company-admin/api';

  // Load enterprise credentials on mount
  useEffect(() => {
    if (isEnterpriseConfigured && enterpriseCredentials.length === 0) {
      dispatch(refreshEnterpriseCredentials());
    }
  }, [isEnterpriseConfigured]);

  // Load my documents on mount and when showExpired changes
  useEffect(() => {
    dispatch(loadMyDocuments(showExpired));
  }, [dispatch, showExpired]);

  // Auto-refresh my documents every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      dispatch(loadMyDocuments(showExpired));
    }, 30000);
    return () => clearInterval(interval);
  }, [dispatch, showExpired]);

  // My Documents handlers
  const handleView = useCallback((ephemeralDID: string) => {
    dispatch(openDocument(ephemeralDID));
  }, [dispatch]);

  const handleRemove = useCallback(async (ephemeralDID: string, originalDocumentDID: string) => {
    if (!confirm('Remove this document?\n\nThis will delete your local copy and, if you are the document owner, also purge it from the server (Iagon files + DID tombstone).')) {
      return;
    }

    // 1. Remove local copy from IndexedDB
    dispatch(removeDocument(ephemeralDID));

    // 2. Attempt server-side deletion via company-admin (requires employee portal session cookie)
    if (originalDocumentDID && originalDocumentDID.startsWith('did:')) {
      try {
        const resp = await fetch(
          `https://identuslabel.cz/company-admin/api/employee-portal/documents/${encodeURIComponent(originalDocumentDID)}`,
          { method: 'DELETE', credentials: 'include' }
        );
        if (resp.ok) {
          console.log('[DocumentRemove] Server-side deletion succeeded for', originalDocumentDID);
        } else if (resp.status === 401 || resp.status === 403) {
          console.info('[DocumentRemove] Server deletion skipped — no employee session or not document owner');
        } else {
          const body = await resp.json().catch(() => ({}));
          console.warn('[DocumentRemove] Server deletion failed:', body.message || resp.status);
        }
      } catch (err: any) {
        console.warn('[DocumentRemove] Server deletion request failed (non-fatal):', err.message);
      }
    }
  }, [dispatch]);

  const handleRequestNew = useCallback((originalDID: string) => {
    window.open(`https://identuslabel.cz/company-admin/employee-portal-dashboard.html?requestDocument=${encodeURIComponent(originalDID)}`, '_blank');
  }, []);

  const handleDownload = useCallback(async (ephemeralDID: string) => {
    try {
      const doc = await getDocument(ephemeralDID);
      if (!doc) {
        alert('Document not found');
        return;
      }

      // Get ephemeral key from localStorage
      let secretKey: Uint8Array | null = null;

      const directKey = getItem(`ephemeral-key-${ephemeralDID}`);
      if (directKey && directKey.secretKey) {
        const binary = atob(directKey.secretKey);
        secretKey = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) secretKey[j] = binary.charCodeAt(j);
      }

      if (!secretKey) {
        const ephemeralKeys = getKeysByPattern('ephemeral-key-');
        for (const keyName of ephemeralKeys) {
          const data = getItem(keyName);
          if (data && data.ephemeralDID === ephemeralDID && data.secretKey) {
            const binary = atob(data.secretKey);
            secretKey = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) secretKey[j] = binary.charCodeAt(j);
            break;
          }
        }
      }

      if (!secretKey) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('ephemeral')) {
            try {
              const data = JSON.parse(localStorage.getItem(key) || '{}');
              if (data.secretKey && (key.includes(ephemeralDID) || data.ephemeralDID === ephemeralDID)) {
                const binary = atob(data.secretKey);
                secretKey = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) secretKey[j] = binary.charCodeAt(j);
                break;
              }
            } catch (e) { /* ignore */ }
          }
        }
      }

      if (!secretKey) {
        alert('Decryption key not found. Please request a new document from Employee Portal.');
        return;
      }

      let encryptedContent = new Uint8Array(doc.encryptedContent);
      let serverPublicKey = doc.encryptionInfo.serverPublicKey;
      let nonce = doc.encryptionInfo.nonce;

      if (doc.isServiceEndpointMode && doc.serviceEndpoint) {
        const fetchedData = await fetchFromServiceEndpoint(doc.serviceEndpoint);
        const binary = atob(fetchedData.encryptedContent);
        encryptedContent = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) encryptedContent[i] = binary.charCodeAt(i);
        serverPublicKey = fetchedData.serverPublicKey;
        nonce = fetchedData.nonce;
      }

      const serverPubKeyBytes = (() => {
        const binary = atob(serverPublicKey);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      })();

      const nonceBytes = (() => {
        const binary = atob(nonce);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      })();

      const decrypted = nacl.box.open(encryptedContent, nonceBytes, serverPubKeyBytes, secretKey);
      if (!decrypted) {
        alert('Decryption failed');
        return;
      }

      const format = doc.sourceInfo?.format?.toLowerCase() || 'html';
      let mimeType = 'text/html';
      let extension = '.html';
      if (format === 'docx') {
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        extension = '.docx';
      } else if (format === 'pdf') {
        mimeType = 'application/pdf';
        extension = '.pdf';
      }

      // Prefer original filename from sourceInfo; fall back to title + extension
      const rawFilename = doc.sourceInfo?.filename || '';
      const hasExtension = rawFilename.includes('.');
      const filename = hasExtension
        ? rawFilename
        : (doc.title || 'document').replace(/[^a-zA-Z0-9.\-_ ]/g, '_') + extension;
      const blob = new Blob([decrypted], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = filename;
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert('Download failed: ' + (error.message || error));
    }
  }, []);

  const handleCleanup = useCallback(() => {
    if (confirm('Remove all expired documents?')) {
      dispatch(cleanupDocuments());
    }
  }, [dispatch]);

  const handleEdit = useCallback(async (_ephemeralDID: string, documentDID: string) => {
    console.log('[Documents] Edit button clicked for document:', documentDID);
    setEditState('requesting');
    setEditDocDID(documentDID);
    setEditToken(null);
    setSelectedFile(null);
    setEditError(null);

    try {
      const allCreds = [
        ...(app.credentials || []),
        ...(enterpriseCredentials || []).map((ec: any) => ec.credential || ec).filter(Boolean)
      ];

      const editData = await requestEditAccess(documentDID, allCreds);

      setEditToken(editData.editToken);
      setEditState('editing');
    } catch (err: any) {
      console.error('[Documents] Edit request failed:', err);
      setEditState('error');
      setEditError(err.message || 'Edit request failed');
    }
  }, [app.credentials, enterpriseCredentials]);

  const handleSubmitEdit = useCallback(async () => {
    if (!selectedFile || !editToken) return;
    setEditState('uploading');
    setEditError(null);
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('editToken', editToken);
      const resp = await fetch(`${apiBaseUrl}/document-update/submit`, { method: 'POST', body: fd });
      const data = await resp.json();
      if (!data.success) throw new Error(data.message || 'Submit failed');
      setEditState('done');
      setEditToken(null);
      setSelectedFile(null);
    } catch (err: any) {
      setEditState('error');
      setEditError(err.message || 'Submit failed');
    }
  }, [selectedFile, editToken, apiBaseUrl]);

  const handleCancelEdit = useCallback(() => {
    setEditState('idle');
    setEditToken(null);
    setSelectedFile(null);
    setEditError(null);
    setEditDocDID(null);
  }, []);

  const handleRefreshMyDocs = useCallback(() => {
    dispatch(loadMyDocuments(showExpired));
  }, [dispatch, showExpired]);

  const handleCloseViewer = useCallback(() => {
    dispatch(closeViewer());
    dispatch(loadMyDocuments(showExpired));
  }, [dispatch, showExpired]);

  // Load folders from localStorage whenever folderRefresh increments
  useEffect(() => {
    setFolders(getFolders());
    setDocFolderMap(getDocFolderMap());
  }, [folderRefresh]);

  // File explorer computed values
  const currentFolderId = folderPath.length > 0 ? folderPath[folderPath.length - 1].id : null;

  const foldersInView = useMemo(
    () => folders.filter(f => f.parentId === currentFolderId),
    [folders, currentFolderId]
  );

  const docsInView = useMemo(() => {
    const byOriginal = new Map<string, DocumentSummary>();
    const displayDocs = showExpired
      ? classifiedDocuments.documents
      : classifiedDocuments.documents.filter(d => !d.isExpired);
    for (const doc of displayDocs) {
      const folderId = docFolderMap[doc.originalDocumentDID] ?? null;
      if (folderId !== currentFolderId) continue;
      const existing = byOriginal.get(doc.originalDocumentDID);
      if (
        !existing ||
        (!doc.isExpired && existing.isExpired) ||
        (doc.isExpired === existing.isExpired && new Date(doc.receivedAt) > new Date(existing.receivedAt))
      ) {
        byOriginal.set(doc.originalDocumentDID, doc);
      }
    }
    return Array.from(byOriginal.values());
  }, [classifiedDocuments.documents, docFolderMap, currentFolderId, showExpired]);

  // Scroll DID panel into view whenever it opens or switches to a new document
  useEffect(() => {
    if (showDIDPanel && panelDID) {
      setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }, [showDIDPanel, panelDID]);

  // File explorer handlers
  // Always re-trigger VP flow so the viewer gets the latest server version.
  // The cache (IndexedDB) is only used for icon metadata; opening always re-fetches.
  const openDocumentCard = useCallback((originalDocumentDID: string) => {
    setPanelDID(originalDocumentDID);
    setPanelAutoTrigger(true);
    setShowDIDPanel(true);
  }, []);

  const handleCreateFolder = useCallback(() => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    createWalletFolder(name.trim(), currentFolderId);
    setFolderRefresh(r => r + 1);
  }, [currentFolderId]);

  const handleRenameFolder = useCallback((id: string, currentName: string) => {
    const name = prompt('New name:', currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    renameWalletFolder(id, name.trim());
    setFolderRefresh(r => r + 1);
  }, []);

  const handleDeleteFolder = useCallback((id: string) => {
    if (!confirm('Delete this folder? Documents inside will be moved to the parent folder.')) return;
    deleteWalletFolder(id);
    setFolderRefresh(r => r + 1);
  }, []);

  const handleRemoveDocFromExplorer = useCallback(async (originalDocumentDID: string) => {
    if (!confirm('Remove this document? All local cached copies will be deleted.')) return;
    const copies = classifiedDocuments.documents.filter(d => d.originalDocumentDID === originalDocumentDID);
    for (const copy of copies) {
      dispatch(removeDocument(copy.ephemeralDID));
    }
    removeDocFromFolders(originalDocumentDID);
    setFolderRefresh(r => r + 1);
  }, [dispatch, classifiedDocuments.documents]);

  const activeCount = classifiedDocuments.documents.filter(d => !d.isExpired).length;
  const expiredCount = classifiedDocuments.documents.filter(d => d.isExpired).length;

  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <LockClosedIcon className="w-8 h-8 text-cyan-400" />
          <h2 className="text-2xl font-bold text-white">Secure Documents</h2>
        </div>
        <p className="text-slate-400 text-sm">Access and manage classified documents with Perfect Forward Secrecy</p>
      </header>

      <DBConnect>
        <Box>

          {/* DID Access Panel — shown when adding or re-triggering an expired doc */}
          {showDIDPanel && (
            <div ref={panelRef} className="mb-6 p-4 bg-slate-800/40 border border-slate-700/50 rounded-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-white">Add Document by DID</h3>
                <button
                  onClick={() => { setShowDIDPanel(false); setPanelDID(''); setPanelAutoTrigger(false); }}
                  className="text-slate-400 hover:text-white text-2xl leading-none"
                >
                  ×
                </button>
              </div>
              <DocumentDIDAccess
                key={panelDID}
                credentials={[
                  ...(app.credentials || []),
                  ...(enterpriseCredentials || []).map((ec: any) => ec.credential || ec).filter(Boolean)
                ]}
                enterpriseDIDs={(enterpriseDIDs || []).map((d: any) => d.did).filter(Boolean)}
                initialDID={panelDID}
                autoTrigger={panelAutoTrigger}
                onDocumentSaved={(ephemeralDID) => {
                  if (panelDID) {
                    setDocFolder(panelDID, currentFolderId);
                    setFolderRefresh(r => r + 1);
                  }
                  setShowDIDPanel(false);
                  setPanelDID('');
                  setPanelAutoTrigger(false);
                  handleRefreshMyDocs();
                  if (ephemeralDID) dispatch(openDocument(ephemeralDID));
                }}
              />
            </div>
          )}

          {/* File Explorer */}
          <div>
            {/* Toolbar: breadcrumb + controls + ADD */}
            <div className="flex items-center gap-2 mb-5 flex-wrap">
              <span className="text-xl">📁</span>
              <button
                onClick={() => setFolderPath([])}
                className="text-sm font-semibold text-cyan-400 hover:text-cyan-300"
              >
                My Files
              </button>
              {folderPath.map((seg, i) => (
                <React.Fragment key={seg.id}>
                  <span className="text-slate-500 select-none">/</span>
                  <button
                    onClick={() => setFolderPath(folderPath.slice(0, i + 1))}
                    className="text-sm font-semibold text-cyan-400 hover:text-cyan-300"
                  >
                    {seg.name}
                  </button>
                </React.Fragment>
              ))}

              <div className="flex items-center gap-2 ml-2">
                {activeCount > 0 && (
                  <span className="px-2 py-0.5 text-xs bg-emerald-500/20 text-emerald-400 rounded-full border border-emerald-500/30">
                    {activeCount} active
                  </span>
                )}
                {expiredCount > 0 && (
                  <span className="px-2 py-0.5 text-xs bg-slate-700 text-slate-400 rounded-full">
                    {expiredCount} expired
                  </span>
                )}
              </div>

              <label className="flex items-center gap-1.5 text-xs text-slate-400 ml-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showExpired}
                  onChange={(e) => setShowExpired(e.target.checked)}
                  className="rounded border-slate-700/50 text-cyan-500 bg-slate-800/50"
                />
                Show expired
              </label>

              <button
                onClick={handleRefreshMyDocs}
                disabled={classifiedDocuments.isLoading}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 disabled:opacity-50"
                title="Refresh"
              >
                <RefreshIcon className={`w-4 h-4 ${classifiedDocuments.isLoading ? 'animate-spin' : ''}`} />
              </button>

              {expiredCount > 0 && (
                <button
                  onClick={handleCleanup}
                  className="px-3 py-1.5 text-xs font-medium text-red-300 bg-red-500/20 rounded-lg hover:bg-red-500/30 border border-red-500/30 flex items-center gap-1"
                >
                  <TrashIcon className="w-3 h-3" />
                  Clean up ({expiredCount})
                </button>
              )}

              {/* ADD dropdown */}
              <div className="relative ml-auto">
                <button
                  onClick={() => setAddMenuOpen(!addMenuOpen)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-sm font-semibold rounded-xl hover:opacity-90"
                >
                  + ADD
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
                {addMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                    <div className="absolute right-0 mt-1 w-52 bg-slate-800 border border-slate-700/60 rounded-xl shadow-2xl z-20 overflow-hidden">
                      <button
                        onClick={() => { setAddMenuOpen(false); setShowDIDPanel(true); setPanelAutoTrigger(false); setPanelDID(''); }}
                        className="w-full px-4 py-3 text-sm text-left text-slate-200 hover:bg-slate-700/60 flex items-center gap-3"
                      >
                        <span className="text-lg">📄</span>
                        <span>Add Document DID</span>
                      </button>
                      <button
                        onClick={() => { setAddMenuOpen(false); handleCreateFolder(); }}
                        className="w-full px-4 py-3 text-sm text-left text-slate-200 hover:bg-slate-700/60 flex items-center gap-3 border-t border-slate-700/50"
                      >
                        <span className="text-lg">📁</span>
                        <span>New Folder</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Error */}
            {classifiedDocuments.error && (
              <div className="mb-4 p-3 bg-red-500/20 border border-red-500/30 rounded-xl text-red-300 flex items-center gap-2 text-sm">
                <ExclamationIcon className="w-4 h-4 flex-shrink-0" />
                <span>{classifiedDocuments.error}</span>
              </div>
            )}

            {/* Icon Grid */}
            {foldersInView.length === 0 && docsInView.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-5xl mb-4">📂</div>
                <p className="text-slate-400">This folder is empty</p>
                <p className="text-slate-500 text-sm mt-1">
                  Click <strong className="text-slate-400">+ ADD</strong> to add a document DID or create a folder.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-4">
                {/* Folder cards */}
                {foldersInView.map(folder => (
                  <div
                    key={folder.id}
                    className="relative w-32 flex flex-col items-center p-3 rounded-2xl border border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40 cursor-pointer transition-all select-none"
                    onClick={() => setFolderPath([...folderPath, { id: folder.id, name: folder.name }])}
                    onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'folder', id: folder.id, name: folder.name }); }}
                  >
                    <span className="text-5xl mb-2">📁</span>
                    <span className="text-xs text-center text-slate-300 font-medium break-all leading-tight max-w-full" style={{display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'}}>
                      {folder.name}
                    </span>
                  </div>
                ))}

                {/* Document cards */}
                {docsInView.map(doc => {
                  const badge = getClassificationBadge(doc.overallClassification);
                  const isExpired = doc.isExpired;
                  const expiryClass = isExpired
                    ? 'text-red-400'
                    : doc.remainingTime < 86400000
                    ? 'text-amber-400'
                    : 'text-emerald-400';
                  const icon = doc.sourceInfo?.format === 'docx' ? '📝' : '📄';
                  return (
                    <div
                      key={doc.originalDocumentDID}
                      className={`relative w-32 flex flex-col items-center p-3 rounded-2xl border-2 cursor-pointer transition-all select-none ${
                        isExpired
                          ? 'border-slate-700/30 bg-slate-800/20 opacity-60 hover:opacity-80'
                          : `${badge.color} bg-slate-800/30 hover:bg-slate-700/40`
                      }`}
                      onClick={() => openDocumentCard(doc.originalDocumentDID)}
                      onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'doc', id: doc.originalDocumentDID, name: doc.title || 'Document' }); }}
                      title={doc.originalDocumentDID}
                    >
                      <span className={`text-5xl mb-2${isExpired ? ' grayscale opacity-60' : ''}`}>{icon}</span>
                      <span
                        className="text-xs text-center text-slate-300 font-medium break-all leading-tight max-w-full mb-1"
                        style={{display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'}}
                      >
                        {doc.title || 'Document'}
                      </span>
                      <span className={`text-xs font-medium ${expiryClass}`}>
                        {isExpired ? 'Expired' : formatRemainingTime(doc.remainingTime)}
                      </span>
                    </div>
                  );
                })}
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
                    content is automatically deleted. You can request a new copy via the Employee Portal.
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
                    Sections above your clearance level are redacted and cannot be viewed.
                  </p>
                </div>
              </div>
            </div>
          </div>

        </Box>
      </DBConnect>

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null); }} />
          <div
            className="fixed z-50 min-w-40 bg-slate-800 border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {contextMenu.type === 'folder' ? (
              <>
                <button
                  onClick={() => { setContextMenu(null); handleRenameFolder(contextMenu.id, contextMenu.name || ''); }}
                  className="w-full px-4 py-2.5 text-sm text-left text-slate-200 hover:bg-slate-700/60 flex items-center gap-3"
                >
                  ✏️ <span>Rename</span>
                </button>
                <button
                  onClick={() => { setContextMenu(null); handleDeleteFolder(contextMenu.id); }}
                  className="w-full px-4 py-2.5 text-sm text-left text-red-400 hover:bg-slate-700/60 flex items-center gap-3 border-t border-slate-700/50"
                >
                  <TrashIcon className="w-4 h-4" /> <span>Delete folder</span>
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { setContextMenu(null); openDocumentCard(contextMenu.id); }}
                  className="w-full px-4 py-2.5 text-sm text-left text-slate-200 hover:bg-slate-700/60 flex items-center gap-3"
                >
                  <EyeIcon className="w-4 h-4" /> <span>Open</span>
                </button>
                <button
                  onClick={() => { setContextMenu(null); handleRemoveDocFromExplorer(contextMenu.id); }}
                  className="w-full px-4 py-2.5 text-sm text-left text-red-400 hover:bg-slate-700/60 flex items-center gap-3 border-t border-slate-700/50"
                >
                  <TrashIcon className="w-4 h-4" /> <span>Remove</span>
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Document Viewer Modal */}
      {classifiedDocuments.isViewing && classifiedDocuments.selectedDocument && (
        <ClassifiedDocumentViewer
          document={classifiedDocuments.selectedDocument}
          onClose={handleCloseViewer}
          editState={editState}
          editError={editError}
          selectedFile={selectedFile}
          onEdit={(originalDocumentDID) => handleEdit('', originalDocumentDID)}
          onFileSelect={setSelectedFile}
          onSubmitEdit={handleSubmitEdit}
          onCancelEdit={handleCancelEdit}
        />
      )}
    </div>
  );
}
