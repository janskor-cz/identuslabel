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

import React, { useState, useEffect, useCallback } from 'react';
import '../app/index.css';
import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector, useAppDispatch } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { DocumentAccess, EphemeralDocument } from "@/components/DocumentAccess";
import { getClassificationLabel } from "@/utils/EphemeralDIDCrypto";
import { getCredentialSubject, getCredentialType } from "@/utils/credentialTypeDetector";
import {
  LockClosedIcon,
  DocumentIcon,
  RefreshIcon,
  FilterIcon,
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
  addDocument,
  openDocument,
  removeDocument,
  cleanupDocuments,
  closeViewer
} from "@/reducers/classifiedDocuments";
import { StoredDocument } from "@/utils/documentStorage";
import { selectEnterpriseCredentials } from '@/reducers/enterpriseAgent';
import { DocumentSummary, formatRemainingTime, getDocument, fetchFromServiceEndpoint } from "@/utils/documentStorage";
import { getItem, setItem, getKeysByPattern } from "@/utils/prefixedStorage";
import { extractKeysFromPrismDID, extractEd25519FromPeerDIDs } from "@/utils/plutoKeyExtractor";
import { base64url } from "jose";
import { ClassifiedDocumentViewer } from "@/components/ClassifiedDocumentViewer";

/**
 * Classification level badge configuration (numeric)
 */
const getClassificationBadgeNumeric = (level: number) => {
  switch (level) {
    case 1:
      return { color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', label: 'UNCLASSIFIED' };
    case 2:
      return { color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', label: 'CONFIDENTIAL' };
    case 3:
      return { color: 'bg-red-500/20 text-red-400 border-red-500/30', label: 'SECRET' };
    case 4:
      return { color: 'bg-red-700/20 text-red-300 border-red-700/30', label: 'SECRET' };
    default:
      return { color: 'bg-slate-500/20 text-slate-400 border-slate-500/30', label: 'UNKNOWN' };
  }
};

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
  onRemove: (ephemeralDID: string) => void;
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
  const classifiedDocuments = useAppSelector(state => state.classifiedDocuments);

  // Tab state
  const [activeTab, setActiveTab] = useState<'available' | 'my'>('available');

  // Available Documents state
  const [documents, setDocuments] = useState<EphemeralDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<EphemeralDocument | null>(null);
  const [filterLevel, setFilterLevel] = useState<number | null>(null);
  const [userClearanceLevel, setUserClearanceLevel] = useState<number>(1);
  const [userPrismDID, setUserPrismDID] = useState<string | null>(null);
  const [issuerDID, setIssuerDID] = useState<string | null>(null);
  const [ed25519PrivateKey, setEd25519PrivateKey] = useState<Uint8Array | null>(null);

  // My Documents state
  const [showExpired, setShowExpired] = useState(true);

  // Edit / versioning state (memory only — never persisted)
  const [editState, setEditState] = useState<'idle' | 'requesting' | 'editing' | 'uploading' | 'done' | 'error'>('idle');
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editDocDID, setEditDocDID] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // API configuration
  const apiBaseUrl = 'https://identuslabel.cz/company-admin/api';

  /**
   * Extract user's security clearance and company info from credentials
   * Uses getCredentialType and getCredentialSubject helpers to handle SDK's Map format
   */
  useEffect(() => {
    const extractUserInfo = async () => {
      if (!app.credentials || app.credentials.length === 0) {
        console.log('[Documents] No credentials found');
        return;
      }

      console.log('[Documents] Processing', app.credentials.length, 'credentials');

      // Find credentials by type using helper that handles SDK Map format
      let clearanceVC: any = null;
      let employeeRoleVC: any = null;
      let serviceConfigVC: any = null;

      for (const cred of app.credentials) {
        const credType = getCredentialType(cred);
        console.log('[Documents] Credential type:', credType);

        if (credType === 'SecurityClearance') {
          clearanceVC = cred;
        } else if (credType === 'EmployeeRole') {
          employeeRoleVC = cred;
        } else if (credType === 'ServiceConfiguration') {
          serviceConfigVC = cred;
        }
      }

      // Extract clearance level from Security Clearance VC
      if (clearanceVC) {
        console.log('[Documents] Found Security Clearance VC');
        const subject = getCredentialSubject(clearanceVC) || {};
        const level = subject.clearanceLevel || subject.securityLevel || 'INTERNAL';

        // Map clearance level strings to numeric levels (CA Portal standard)
        // INTERNAL (1) → CONFIDENTIAL (2) → RESTRICTED (3) → SECRET (4)
        const levelMap: { [key: string]: number } = {
          'INTERNAL': 1,
          'UNCLASSIFIED': 1,    // Legacy: map to INTERNAL
          'CONFIDENTIAL': 2,
          'RESTRICTED': 3,
          'SECRET': 4,
          'TOP-SECRET': 4,      // Legacy: map to SECRET
          'TOP_SECRET': 4,      // Legacy: map to SECRET
          'TOPSECRET': 4        // Legacy: map to SECRET
        };
        const numLevel = levelMap[level.toUpperCase()] || 1;
        console.log('[Documents] Mapped clearance:', level, '→', numLevel);
        setUserClearanceLevel(numLevel);

        // Extract holder DID from Security Clearance VC
        if (subject.id) {
          setUserPrismDID(subject.id);
        }

        console.log('[Documents] User clearance level:', numLevel, '/', level);
      } else {
        console.log('[Documents] No Security Clearance VC found, defaulting to UNCLASSIFIED');
        setUserClearanceLevel(1);
      }

      // Priority for issuerDID extraction:
      // 1. EmployeeRole VC's credentialSubject.issuerDID (company DID)
      // 2. ServiceConfiguration VC's issuer
      // 3. Security Clearance VC's issuer
      let foundIssuerDID: string | null = null;

      if (employeeRoleVC) {
        const subject = getCredentialSubject(employeeRoleVC) || {};
        if (subject.issuerDID) {
          foundIssuerDID = subject.issuerDID;
          console.log('[Documents] Found issuerDID from EmployeeRole VC');
        }
      }

      if (!foundIssuerDID && serviceConfigVC) {
        // Use the issuer of the ServiceConfiguration VC (the company that issued it)
        if (serviceConfigVC.issuer) {
          foundIssuerDID = typeof serviceConfigVC.issuer === 'string'
            ? serviceConfigVC.issuer
            : serviceConfigVC.issuer.id || serviceConfigVC.issuer;
          console.log('[Documents] Found issuerDID from ServiceConfiguration VC issuer');
        }
      }

      if (!foundIssuerDID && clearanceVC?.issuer) {
        foundIssuerDID = typeof clearanceVC.issuer === 'string'
          ? clearanceVC.issuer
          : clearanceVC.issuer.id || clearanceVC.issuer;
        console.log('[Documents] Found issuerDID from Security Clearance VC issuer');
      }

      if (foundIssuerDID) {
        setIssuerDID(foundIssuerDID);
        console.log('[Documents] Using issuerDID:', foundIssuerDID.substring(0, 50) + '...');
      } else {
        console.log('[Documents] No issuerDID found in any credential');
      }

      // Try to find PRISM DID from any credential if not found
      if (!userPrismDID) {
        for (const cred of app.credentials) {
          const subject = getCredentialSubject(cred);
          if (subject?.id && subject.id.startsWith('did:prism:')) {
            setUserPrismDID(subject.id);
            break;
          }
        }
      }
    };

    extractUserInfo();
  }, [app.credentials]);

  /**
   * Load Ed25519 private key for document request signing.
   * Pass 1: localStorage security-clearance-keys
   * Pass 2: Pluto PRISM DID keys (via agent)
   */
  useEffect(() => {
    const loadEd25519Key = async () => {
      // Pass 1: localStorage
      const securityKeysData = getItem('security-clearance-keys');
      if (securityKeysData && typeof securityKeysData === 'object') {
        try {
          const activeKeyId = securityKeysData.activeKeyId;
          const keys = securityKeysData.keys || [];
          const activeKey = keys.find((k: any) => k.keyId === activeKeyId);
          if (activeKey?.ed25519?.privateKeyBytes) {
            setEd25519PrivateKey(base64url.decode(activeKey.ed25519.privateKeyBytes));
            console.log('[Documents] Ed25519 key loaded from localStorage');
            return;
          }
          for (const key of keys) {
            if (key?.ed25519?.privateKeyBytes) {
              setEd25519PrivateKey(base64url.decode(key.ed25519.privateKeyBytes));
              console.log('[Documents] Ed25519 key loaded from localStorage (fallback)');
              return;
            }
          }
        } catch (e) {
          console.warn('[Documents] Failed to parse localStorage Ed25519 keys:', e);
        }
      }

      // Pass 2: Pluto DID keys (PRISM first, then Peer)
      if (app.agent.instance) {
        try {
          const prismDIDs = await app.agent.instance.pluto.getAllPrismDIDs();
          for (const prismDID of prismDIDs || []) {
            const plutoKeys = await extractKeysFromPrismDID(app.agent.instance, prismDID.did.toString());
            if (plutoKeys?.ed25519?.privateKeyBytes) {
              setEd25519PrivateKey(base64url.decode(plutoKeys.ed25519.privateKeyBytes));
              console.log('[Documents] Ed25519 key loaded from Pluto PRISM DID');
              return;
            }
          }
        } catch (e) {
          console.warn('[Documents] Pluto PRISM DID Ed25519 key lookup failed:', e);
        }

        // Pass 2b: Peer DID Ed25519 keys (stored in Pluto by createNewPeerDID)
        try {
          const peerDIDKey = await extractEd25519FromPeerDIDs(app.agent.instance);
          if (peerDIDKey) {
            // NaCl expects 64-byte secret key (32 private + 32 public concatenated)
            const naclPrivateKey = new Uint8Array(64);
            naclPrivateKey.set(peerDIDKey.privateKeyBytes.slice(0, 32), 0);
            naclPrivateKey.set(peerDIDKey.publicKeyBytes.slice(0, 32), 32);
            setEd25519PrivateKey(naclPrivateKey);
            console.log('[Documents] Ed25519 key loaded from Pluto peer DID');
            return;
          }
        } catch (e) {
          console.warn('[Documents] Pluto peer DID Ed25519 key lookup failed:', e);
        }
      }

      // Pass 3: Generate and persist a local signing keypair
      // Server only validates signature format (MVP), not DID-key binding
      const stored = getItem('document-signing-key');
      if (stored?.privateKeyBytes) {
        setEd25519PrivateKey(base64url.decode(stored.privateKeyBytes));
        console.log('[Documents] Ed25519 key loaded from persisted local keypair');
        return;
      }
      const keypair = nacl.sign.keyPair();
      setItem('document-signing-key', {
        privateKeyBytes: base64url.encode(keypair.secretKey),
        publicKeyBytes: base64url.encode(keypair.publicKey),
      });
      setEd25519PrivateKey(keypair.secretKey);
      console.log('[Documents] Generated new local Ed25519 signing keypair');
    };

    loadEd25519Key();
  }, [app.agent.instance, app.credentials]);

  /**
   * Fetch available documents from server
   * Uses /api/documents/discover endpoint which requires issuerDID
   */
  const fetchDocuments = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Need issuerDID to query documents - this comes from the Security Clearance VC or EmployeeRole VC
      if (!issuerDID) {
        console.log('[Documents] No issuerDID available, cannot fetch documents');
        setDocuments([]);
        setIsLoading(false);
        return;
      }

      const params = new URLSearchParams();
      params.set('issuerDID', issuerDID);

      // Filter level overrides user clearance if set
      if (filterLevel) {
        params.set('clearanceLevel', filterLevel.toString());
      } else {
        params.set('clearanceLevel', userClearanceLevel.toString());
      }

      console.log('[Documents] Fetching documents with params:', {
        issuerDID: issuerDID.substring(0, 40) + '...',
        clearanceLevel: filterLevel || userClearanceLevel
      });

      const response = await fetch(`${apiBaseUrl}/documents/discover?${params}`);

      if (!response.ok) {
        // Try to get detailed error from response body
        let errorMessage = response.statusText || `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
        throw new Error(`Failed to fetch documents: ${errorMessage}`);
      }

      const data = await response.json();
      // Server returns 'documentDID' as the ID field; normalize to 'id' for EphemeralDocument
      const normalized = (data.documents || []).map((d: any) => ({
        ...d,
        id: d.id ?? d.documentDID,
      }));
      setDocuments(normalized);

      console.log('[Documents] Fetched', normalized.length, 'documents; first doc id=', normalized[0]?.id, 'documentDID=', normalized[0]?.documentDID);
    } catch (err: any) {
      console.error('[Documents] Fetch error:', err);
      setError(err.message || 'Failed to fetch documents');
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, filterLevel, userClearanceLevel, issuerDID]);

  /**
   * Fetch documents on mount and when filter changes
   */
  useEffect(() => {
    if (activeTab === 'available') {
      fetchDocuments();
    }
  }, [fetchDocuments, activeTab]);

  /**
   * Load my documents on tab change
   */
  useEffect(() => {
    if (activeTab === 'my') {
      dispatch(loadMyDocuments(showExpired));
    }
  }, [dispatch, activeTab, showExpired]);

  // Auto-refresh my documents every 30 seconds
  useEffect(() => {
    if (activeTab !== 'my') return;

    const interval = setInterval(() => {
      dispatch(loadMyDocuments(showExpired));
    }, 30000);

    return () => clearInterval(interval);
  }, [dispatch, activeTab, showExpired]);

  /**
   * Handle document access request
   */
  const handleRequestAccess = (document: EphemeralDocument) => {
    console.log('[Documents] handleRequestAccess: doc.id=', document.id, 'doc.documentDID=', (document as any).documentDID);
    setSelectedDocument(document);
  };

  /**
   * Handle access modal close
   */
  const handleCloseAccess = () => {
    setSelectedDocument(null);
  };

  /**
   * Handle access complete
   */
  const handleAccessComplete = (success: boolean, copyId?: string) => {
    if (success) {
      console.log('[Documents] Access granted, copy ID:', copyId);
    } else {
      console.log('[Documents] Access denied or failed');
    }
  };

  /**
   * Save VC-gate accessed document to "My Documents" (IndexedDB).
   * Stores the plaintext directly with algorithm:'plaintext' so the viewer
   * can display it without needing a decryption key.
   */
  const handleDocumentAccessed = useCallback((data: {
    plaintext: Uint8Array;
    ephemeralDID: string;
    title: string;
    classification: string;
    filename: string;
    mimeType: string;
  }) => {
    if (!selectedDocument) return;
    const format = data.mimeType.includes('docx') ? 'docx'
      : data.mimeType.includes('pdf') ? 'pdf' : 'html';
    const doc: StoredDocument = {
      ephemeralDID: data.ephemeralDID,
      originalDocumentDID: selectedDocument.id,
      title: data.title,
      overallClassification: data.classification || 'UNCLASSIFIED',
      encryptedContent: data.plaintext.buffer as ArrayBuffer,
      encryptionInfo: {
        serverPublicKey: '',
        nonce: '',
        algorithm: 'plaintext',
      },
      sectionSummary: {
        totalSections: 1,
        visibleCount: 1,
        redactedCount: 0,
        clearanceLevelsUsed: [data.classification || 'UNCLASSIFIED'],
        visibleSections: [{ sectionId: 'all', clearance: data.classification || 'UNCLASSIFIED' }],
        redactedSections: [],
      },
      sourceInfo: { filename: data.filename, format },
      receivedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      viewCount: 0,
      maxViews: -1,
      status: 'active',
    };
    dispatch(addDocument(doc));
    console.log('[Documents] Saved accessed document to My Documents:', data.title);
  }, [dispatch, selectedDocument]);

  // My Documents handlers
  const handleView = useCallback((ephemeralDID: string) => {
    dispatch(openDocument(ephemeralDID));
  }, [dispatch]);

  const handleRemove = useCallback((ephemeralDID: string) => {
    if (confirm('Are you sure you want to remove this document?')) {
      dispatch(removeDocument(ephemeralDID));
    }
  }, [dispatch]);

  const handleRequestNew = useCallback((originalDID: string) => {
    window.open(`https://identuslabel.cz/company-admin/employee-portal-dashboard.html?requestDocument=${encodeURIComponent(originalDID)}`, '_blank');
  }, []);

  const handleDownload = useCallback(async (ephemeralDID: string) => {
    try {
      console.log('[Documents] ====== DOWNLOAD START ======');
      console.log('[Documents] Downloading document with ephemeralDID:', ephemeralDID);

      const doc = await getDocument(ephemeralDID);
      if (!doc) {
        console.error('[Documents] Document not found in IndexedDB for DID:', ephemeralDID);
        alert('Document not found');
        return;
      }

      // Get ephemeral key from localStorage
      let secretKey: Uint8Array | null = null;

      // Method 1: Direct lookup
      const directKey = getItem(`ephemeral-key-${ephemeralDID}`);
      if (directKey && directKey.secretKey) {
        const binary = atob(directKey.secretKey);
        secretKey = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) {
          secretKey[j] = binary.charCodeAt(j);
        }
      }

      // Method 2: Pattern search
      if (!secretKey) {
        const ephemeralKeys = getKeysByPattern('ephemeral-key-');
        for (const keyName of ephemeralKeys) {
          const data = getItem(keyName);
          if (data && data.ephemeralDID === ephemeralDID && data.secretKey) {
            const binary = atob(data.secretKey);
            secretKey = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) {
              secretKey[j] = binary.charCodeAt(j);
            }
            break;
          }
        }
      }

      // Method 3: Raw localStorage search
      if (!secretKey) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes('ephemeral')) {
            try {
              const data = JSON.parse(localStorage.getItem(key) || '{}');
              const keyMatchesDID = key.includes(ephemeralDID);
              const dataMatchesDID = data.ephemeralDID === ephemeralDID;
              if (data.secretKey && (keyMatchesDID || dataMatchesDID)) {
                const binary = atob(data.secretKey);
                secretKey = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) {
                  secretKey[j] = binary.charCodeAt(j);
                }
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

      // Fetch encrypted content from service endpoint if needed
      let encryptedContent = new Uint8Array(doc.encryptedContent);
      let serverPublicKey = doc.encryptionInfo.serverPublicKey;
      let nonce = doc.encryptionInfo.nonce;

      if (doc.isServiceEndpointMode && doc.serviceEndpoint) {
        const fetchedData = await fetchFromServiceEndpoint(doc.serviceEndpoint);
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

      console.log('[Documents] Downloaded:', filename);
    } catch (error: any) {
      console.error('[Documents] Download failed:', error);
      alert('Download failed: ' + (error.message || error));
    }
  }, []);

  const handleCleanup = useCallback(() => {
    if (confirm('Remove all expired documents?')) {
      dispatch(cleanupDocuments());
    }
  }, [dispatch]);

  /**
   * Handle Edit button click on a MyDocumentCard (DOCX documents only).
   * Requests a redacted editable copy via the document-update/request-edit endpoint.
   */
  const handleEdit = useCallback(async (ephemeralDID: string, documentDID: string) => {
    setEditState('requesting');
    setEditDocDID(documentDID);
    setEditToken(null);
    setSelectedFile(null);
    setEditError(null);

    try {
      // 1. Build VP credentials list
      const credentialJWTs: string[] = [];
      const allCreds = [
        ...(app.credentials || []),
        ...(enterpriseCredentials || []).map((ec: any) => ec.credential || ec).filter(Boolean)
      ];
      for (const cred of allCreds) {
        // Extract JWT (same logic as DocumentAccess component)
        const isJWT = (s: any): s is string => typeof s === 'string' && s.split('.').length === 3;
        let jwt: string | null = null;
        if (isJWT(cred?.id)) jwt = cred.id;
        else if (isJWT(cred?.jwt)) jwt = cred.jwt;
        else if (isJWT(cred?.string)) jwt = cred.string;
        else if (isJWT(cred?.rawJWT)) jwt = cred.rawJWT;
        else if (isJWT(cred?.token)) jwt = cred.token;
        if (!jwt && typeof cred === 'string') {
          try { const d = atob(cred); if (isJWT(d)) jwt = d; } catch (_) {}
        }
        if (jwt) credentialJWTs.push(jwt);
      }

      if (credentialJWTs.length === 0) {
        throw new Error('No credentials available for VP presentation');
      }

      // 2. Generate ephemeral X25519 keypair
      const { generateEphemeralKeyPair } = await import('@/utils/EphemeralDIDCrypto');
      const ephemeralKeyPair = generateEphemeralKeyPair();

      // 3. Get challenge
      const challengeResp = await fetch(`${apiBaseUrl}/access-gate/challenge?documentDID=${encodeURIComponent(documentDID)}`);
      if (!challengeResp.ok) throw new Error(`Challenge request failed: ${challengeResp.status}`);
      const { challenge } = await challengeResp.json();

      // 4. Build VP
      const vp = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiablePresentation'],
        verifiableCredential: credentialJWTs,
        proof: { type: 'Ed25519Signature2018', challenge, proofPurpose: 'authentication' }
      };

      // 5. Call request-edit
      const editResp = await fetch(`${apiBaseUrl}/document-update/request-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentDID, vp, challenge, ephemeralPublicKey: ephemeralKeyPair.publicKey })
      });
      const editData = await editResp.json();
      if (!editData.success) throw new Error(editData.message || 'Edit request denied');

      // 6. Decrypt the editable DOCX using ephemeral key
      const { base64url } = await import('jose');
      const serverPubKey = base64url.decode(editData.encryptedEditableDocument.serverPublicKey);
      const ciphertext = base64url.decode(editData.encryptedEditableDocument.ciphertext);
      const nonce = base64url.decode(editData.encryptedEditableDocument.nonce);
      const decrypted = nacl.box.open(ciphertext, nonce, serverPubKey, ephemeralKeyPair.secretKey);
      // Destroy ephemeral key
      for (let i = 0; i < ephemeralKeyPair.secretKey.length; i++) ephemeralKeyPair.secretKey[i] = 0;
      ephemeralKeyPair.destroyed = true;

      if (!decrypted) throw new Error('Failed to decrypt editable document');

      // 7. Trigger download of editable DOCX
      const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const blob = new Blob([decrypted], { type: DOCX_MIME });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = editData.filename || 'editable-document.docx';
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // 8. Store edit token and transition to editing state
      setEditToken(editData.editToken);
      setEditState('editing');

    } catch (err: any) {
      console.error('[Documents] Edit request failed:', err);
      setEditState('error');
      setEditError(err.message || 'Edit request failed');
    }
  }, [app.credentials, enterpriseCredentials, apiBaseUrl]);

  /**
   * Submit the user's edited DOCX for merging and versioning.
   */
  const handleSubmitEdit = useCallback(async () => {
    if (!selectedFile || !editToken) return;

    setEditState('uploading');
    setEditError(null);

    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('editToken', editToken);

      const resp = await fetch(`${apiBaseUrl}/document-update/submit`, {
        method: 'POST',
        body: fd
      });
      const data = await resp.json();

      if (!data.success) throw new Error(data.message || 'Submit failed');

      setEditState('done');
      setEditToken(null);
      setSelectedFile(null);

    } catch (err: any) {
      console.error('[Documents] Edit submit failed:', err);
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

  /**
   * Filter documents by classification level
   */
  const filteredDocuments = filterLevel
    ? documents.filter(doc => doc.classificationLevel === filterLevel)
    : documents;

  // My documents filtering
  const filteredMyDocuments = showExpired
    ? classifiedDocuments.documents
    : classifiedDocuments.documents.filter(d => !d.isExpired);

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
          {/* Tab Navigation */}
          <div className="mb-6 flex space-x-1 bg-slate-800/50 p-1 rounded-xl border border-slate-700/50">
            <button
              onClick={() => setActiveTab('available')}
              className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                activeTab === 'available'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-white border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <DocumentIcon className="w-4 h-4" />
                Available Documents
                {documents.length > 0 && (
                  <span className="px-2 py-0.5 text-xs bg-cyan-500/30 rounded-full">{documents.length}</span>
                )}
              </div>
            </button>
            <button
              onClick={() => setActiveTab('my')}
              className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                activeTab === 'my'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-white border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <EyeIcon className="w-4 h-4" />
                My Documents
                {activeCount > 0 && (
                  <span className="px-2 py-0.5 text-xs bg-purple-500/30 rounded-full">{activeCount}</span>
                )}
              </div>
            </button>
          </div>

          {/* ======== AVAILABLE DOCUMENTS TAB ======== */}
          {activeTab === 'available' && (
            <>
              {/* User Clearance Info */}
              <div className="mb-6 p-4 bg-slate-800/30 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ShieldCheckIcon className="w-6 h-6 text-purple-400" />
                    <div>
                      <div className="text-sm text-slate-400">Your Security Clearance</div>
                      <div className={`inline-flex px-3 py-1 rounded-full text-sm font-bold border ${getClassificationBadgeNumeric(userClearanceLevel).color}`}>
                        {getClassificationBadgeNumeric(userClearanceLevel).label}
                      </div>
                    </div>
                  </div>
                  {userPrismDID && (
                    <div className="text-right">
                      <div className="text-sm text-slate-400">Your DID</div>
                      <div className="text-xs font-mono text-slate-300 truncate max-w-xs">
                        {userPrismDID.substring(0, 40)}...
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Controls */}
              <div className="mb-6 flex items-center gap-4">
                <button
                  onClick={fetchDocuments}
                  disabled={isLoading}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-xl ${
                    isLoading
                      ? 'bg-slate-700/50 cursor-not-allowed'
                      : 'bg-gradient-to-r from-cyan-500 to-purple-500 hover:opacity-90'
                  }`}
                >
                  <RefreshIcon className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                  {isLoading ? 'Loading...' : 'Refresh'}
                </button>

                <div className="flex items-center gap-2">
                  <FilterIcon className="w-5 h-5 text-slate-400" />
                  <select
                    value={filterLevel || ''}
                    onChange={(e) => setFilterLevel(e.target.value ? Number(e.target.value) : null)}
                    className="px-3 py-2 border border-slate-700/50 bg-slate-800/50 text-white rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  >
                    <option value="">All Classifications</option>
                    <option value="1">UNCLASSIFIED</option>
                    <option value="2">CONFIDENTIAL</option>
                    {userClearanceLevel >= 3 && <option value="3">SECRET</option>}
                    {userClearanceLevel >= 4 && <option value="4">SECRET</option>}
                  </select>
                </div>
              </div>

              {/* Error Message */}
              {error && (
                <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-2xl text-red-300">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {/* Documents List */}
              {!isLoading && filteredDocuments.length === 0 && (
                <div className="text-center py-12">
                  <DocumentIcon className="w-16 h-16 mx-auto text-slate-600 mb-4" />
                  <p className="text-lg text-slate-400">No documents available</p>
                  <p className="text-sm text-slate-500 mt-2">
                    Documents matching your clearance level will appear here.
                  </p>
                </div>
              )}

              {filteredDocuments.length > 0 && (
                <div className="space-y-4">
                  {filteredDocuments.map((doc) => {
                    const badge = getClassificationBadgeNumeric(doc.classificationLevel);
                    return (
                      <div
                        key={doc.id}
                        className="border-2 border-slate-700/50 rounded-2xl overflow-hidden hover:shadow-lg transition-shadow bg-slate-800/30 backdrop-blur-sm"
                      >
                        <div className={`px-4 py-2 ${badge.color} border-b-2`}>
                          <span className="font-bold text-sm">{badge.label}</span>
                        </div>
                        <div className="p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <h3 className="text-lg font-bold text-white">{doc.title}</h3>
                              {doc.description && (
                                <p className="text-slate-300 mt-1 text-sm">{doc.description}</p>
                              )}
                              <div className="flex items-center gap-4 mt-3 text-sm text-slate-400">
                                <span className="flex items-center gap-1">
                                  <DocumentIcon className="w-4 h-4" />
                                  {doc.filename}
                                </span>
                                <span>{(doc.fileSize / 1024).toFixed(1)} KB</span>
                                <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
                              </div>
                            </div>
                            <button
                              onClick={() => handleRequestAccess(doc)}
                              className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl hover:opacity-90 flex items-center gap-2"
                            >
                              <LockClosedIcon className="w-4 h-4" />
                              Request Access
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {filteredDocuments.length > 0 && (
                <div className="mt-6 text-sm text-slate-500 text-center">
                  Showing {filteredDocuments.length} of {documents.length} documents
                </div>
              )}

              {/* Security Notice */}
              <div className="mt-8 p-4 bg-amber-500/20 border border-amber-500/30 rounded-2xl backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <ShieldCheckIcon className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-amber-300">Perfect Forward Secrecy</div>
                    <p className="text-sm text-amber-400/80 mt-1">
                      Each document access generates a unique ephemeral key that is destroyed immediately after decryption.
                      This ensures that even if the server is compromised in the future, your past sessions remain secure.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ======== MY DOCUMENTS TAB ======== */}
          {activeTab === 'my' && (
            <>
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
                              {level}: {count as number}
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
                <button
                  onClick={handleRefreshMyDocs}
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

                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={showExpired}
                    onChange={(e) => setShowExpired(e.target.checked)}
                    className="rounded border-slate-700/50 text-cyan-500 focus:ring-cyan-500/50 bg-slate-800/50"
                  />
                  Show expired documents
                </label>

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

              {/* My Documents List */}
              {!classifiedDocuments.isLoading && filteredMyDocuments.length === 0 && (
                <div className="text-center py-12">
                  <DocumentIcon className="w-16 h-16 mx-auto text-slate-600 mb-4" />
                  <p className="text-lg text-slate-400">No documents found</p>
                  <p className="text-sm text-slate-500 mt-2">
                    Documents you receive via the Employee Portal will appear here.
                  </p>
                </div>
              )}

              {filteredMyDocuments.length > 0 && (
                <div className="space-y-4">
                  {filteredMyDocuments.map((doc) => (
                    <MyDocumentCard
                      key={doc.ephemeralDID}
                      document={doc}
                      onView={handleView}
                      onDownload={handleDownload}
                      onRemove={handleRemove}
                      onRequestNew={handleRequestNew}
                      onEdit={handleEdit}
                      editState={editDocDID === doc.originalDocumentDID ? editState : 'idle'}
                      editDocDID={editDocDID}
                      selectedFile={editDocDID === doc.originalDocumentDID ? selectedFile : null}
                      onFileSelect={setSelectedFile}
                      onSubmitEdit={handleSubmitEdit}
                      onCancelEdit={handleCancelEdit}
                      editError={editDocDID === doc.originalDocumentDID ? editError : null}
                    />
                  ))}
                </div>
              )}

              {filteredMyDocuments.length > 0 && (
                <div className="mt-6 text-sm text-slate-500 text-center">
                  Showing {filteredMyDocuments.length} of {classifiedDocuments.documents.length} documents
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
                      content is automatically deleted. You can request a new copy from the Employee Portal.
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
            </>
          )}
        </Box>
      </DBConnect>

      {/* Document Access Modal (Available Documents) */}
      {selectedDocument && userPrismDID && issuerDID && ed25519PrivateKey && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <DocumentAccess
            document={selectedDocument}
            requestorDID={userPrismDID}
            issuerDID={issuerDID}
            clearanceLevel={userClearanceLevel}
            ed25519PrivateKey={ed25519PrivateKey}
            apiBaseUrl={apiBaseUrl}
            onAccessComplete={handleAccessComplete}
            onDocumentAccessed={handleDocumentAccessed}
            onClose={handleCloseAccess}
            credentials={[
              ...(app.credentials || []),
              ...(enterpriseCredentials || []).map(ec => ec.credential || ec).filter(Boolean)
            ]}
          />
        </div>
      )}

      {/* Access Modal (Missing Keys Warning) */}
      {selectedDocument && (!userPrismDID || !issuerDID || !ed25519PrivateKey) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-xl max-w-md w-full p-6 border border-slate-700/50">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-amber-500/20 rounded-full flex items-center justify-center">
                <ShieldCheckIcon className="w-10 h-10 text-amber-400" />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">Security Clearance Required</h3>
              <p className="text-slate-400 mb-4">
                To access classified documents, you need a valid Security Clearance credential
                with associated cryptographic keys.
              </p>
              <ul className="text-left text-sm text-slate-500 mb-6 space-y-2">
                {!userPrismDID && (
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">*</span> PRISM DID not found
                  </li>
                )}
                {!issuerDID && (
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">*</span> Issuer DID not found
                  </li>
                )}
                {!ed25519PrivateKey && (
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">*</span> Ed25519 signing key not available
                  </li>
                )}
              </ul>
              <button
                onClick={handleCloseAccess}
                className="px-6 py-2 bg-slate-700 text-white rounded-xl hover:bg-slate-600"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document Viewer Modal (My Documents) */}
      {classifiedDocuments.isViewing && classifiedDocuments.selectedDocument && (
        <ClassifiedDocumentViewer
          document={classifiedDocuments.selectedDocument}
          onClose={handleCloseViewer}
        />
      )}
    </div>
  );
}
