/**
 * DocumentAccess Component
 *
 * Handles secure document access with Perfect Forward Secrecy (PFS):
 * 1. Generates ephemeral X25519 keypair for single-use document access
 * 2. Signs access request with Ed25519 for non-repudiation
 * 3. Requests encrypted document from server
 * 4. Decrypts document and DESTROYS ephemeral key immediately
 *
 * Security Model:
 * - Each access generates fresh ephemeral keys
 * - Private key destroyed after decryption (PFS guarantee)
 * - Server never sees ephemeral private key
 * - Even if server compromised later, past sessions remain secure
 *
 * @version 1.0.0
 * @date 2025-12-07
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  generateEphemeralKeyPair,
  buildAccessRequest,
  decryptAndDestroy,
  getClassificationLabel,
  EphemeralKeyPair,
  EncryptedDocumentResponse
} from '@/utils/EphemeralDIDCrypto';
import { LockClosedIcon, DocumentIcon, ShieldCheckIcon, ExclamationIcon } from '@heroicons/react/solid';
import { getCredentialType } from '@/utils/credentialTypeDetector';

/**
 * Document metadata from server
 */
export interface EphemeralDocument {
  id: string;
  title: string;
  filename: string;
  description?: string;
  classificationLevel: number;
  classificationLabel: string;
  fileSize: number;
  createdAt: string;
  createdByDID: string;
}

/**
 * Access result from server
 */
export interface AccessResult {
  granted: boolean;
  reason?: string;
  encryptedDocument?: EncryptedDocumentResponse;
  accessLog?: {
    copyId: string;
    timestamp: string;
  };
}

/**
 * Access workflow state
 */
type AccessState =
  | 'idle'
  | 'awaiting_consent'
  | 'generating_keys'
  | 'requesting_access'
  | 'decrypting'
  | 'success'
  | 'denied'
  | 'error';

interface DocumentAccessProps {
  /** Document to access */
  document: EphemeralDocument;

  /** User's PRISM DID */
  requestorDID: string;

  /** Issuer DID (from user's credential) */
  issuerDID: string;

  /** User's clearance level (1-4) */
  clearanceLevel: number;

  /** User's Ed25519 private key (64 bytes) for signing */
  ed25519PrivateKey: Uint8Array;

  /** API base URL for document access */
  apiBaseUrl?: string;

  /** Callback when access is complete */
  onAccessComplete?: (success: boolean, copyId?: string) => void;

  /**
   * Called after successful VC-gate access with the decrypted document data.
   * Use this to save the document to "My Documents".
   */
  onDocumentAccessed?: (data: {
    plaintext: Uint8Array;
    ephemeralDID: string;
    title: string;
    classification: string;
    filename: string;
    mimeType: string;
  }) => void;

  /** Callback to close the modal/component */
  onClose?: () => void;

  /**
   * Raw credential objects from the wallet store.
   * When provided, the component uses the VC-based access gate
   * (POST /api/access-gate/present) instead of the session-based
   * endpoint. The raw JWT string is extracted from each credential.
   */
  credentials?: any[];
}

/**
 * Try to extract the raw JWT string from an Identus SDK credential object.
 *
 * The SDK stores credentials as JWTCredential objects. We probe multiple
 * known properties/methods to find the JWT string.
 */
function extractCredentialJWT(cred: any): string | null {
  if (!cred) return null;

  // Helper: a string with exactly 3 dot-separated segments is likely a JWT
  const isJWT = (s: any): s is string =>
    typeof s === 'string' && s.split('.').length === 3;

  if (isJWT(cred.id)) return cred.id;
  if (isJWT(cred.jwt)) return cred.jwt;
  if (isJWT(cred.string)) return cred.string;
  if (isJWT(cred.rawJWT)) return cred.rawJWT;
  if (isJWT(cred.token)) return cred.token;

  // Object with .base64 property (Identus multitenancy agent format)
  if (cred.base64 && typeof cred.base64 === 'string') {
    try {
      const decoded = atob(cred.base64);
      if (isJWT(decoded)) return decoded;
    } catch (_) { /* ignore */ }
  }

  // Base64-encoded JWT string (Identus agent stores credential as base64(JWT))
  if (typeof cred === 'string') {
    try {
      const decoded = atob(cred);
      if (isJWT(decoded)) return decoded;
    } catch (_) { /* ignore */ }
  }

  // Try toString()
  try {
    const str = cred.toString?.();
    if (isJWT(str)) return str;
  } catch (_) { /* ignore */ }

  return null;
}

/**
 * Classification level badge colors
 */
const getClassificationBadge = (level: number) => {
  switch (level) {
    case 1:
      return { color: 'bg-green-100 text-green-800 border-green-300', label: 'UNCLASSIFIED' };
    case 2:
      return { color: 'bg-blue-100 text-blue-800 border-blue-300', label: 'CONFIDENTIAL' };
    case 3:
      return { color: 'bg-orange-100 text-orange-800 border-orange-300', label: 'SECRET' };
    case 4:
      return { color: 'bg-red-100 text-red-800 border-red-300', label: 'SECRET' };
    default:
      return { color: 'bg-gray-100 text-gray-800 border-gray-300', label: 'UNKNOWN' };
  }
};

/**
 * Access state progress indicator
 */
const getProgressStep = (state: AccessState) => {
  switch (state) {
    case 'idle':
      return { step: 0, label: 'Ready to request access' };
    case 'generating_keys':
      return { step: 1, label: 'Generating ephemeral keys...' };
    case 'requesting_access':
      return { step: 2, label: 'Requesting access...' };
    case 'decrypting':
      return { step: 3, label: 'Decrypting document...' };
    case 'success':
      return { step: 4, label: 'Access granted' };
    case 'denied':
      return { step: 4, label: 'Access denied' };
    case 'error':
      return { step: 4, label: 'Error occurred' };
    default:
      return { step: 0, label: 'Unknown state' };
  }
};

/**
 * DocumentAccess Component
 *
 * Main component for secure ephemeral document access
 */
/** Decode a JWT string into a synthetic credential object, then delegate to getCredentialType. */
function getJWTCredentialType(jwt: string): string {
  try {
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    // Wrap payload so getCredentialType can read vc.credentialSubject as-is
    const syntheticCred = { vc: payload.vc, credentialSubject: payload.vc?.credentialSubject };
    const t = getCredentialType(syntheticCred);
    return t === 'Unknown' ? 'Credential' : t;
  } catch {
    return 'Credential';
  }
}

export function DocumentAccess({
  document,
  requestorDID,
  issuerDID,
  clearanceLevel,
  ed25519PrivateKey,
  apiBaseUrl = 'https://identuslabel.cz/company-admin/api',
  onAccessComplete,
  onDocumentAccessed,
  onClose,
  credentials
}: DocumentAccessProps) {
  // State
  const [accessState, setAccessState] = useState<AccessState>('idle');
  const [decryptedContent, setDecryptedContent] = useState<Uint8Array | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState<string | null>(null);
  // Each item: the raw JWT, decoded type label, and whether user has selected it
  const [consentCredentials, setConsentCredentials] = useState<Array<{jwt: string; type: string; selected: boolean}>>([]);

  // Ephemeral keypair (stored temporarily during access flow)
  const [ephemeralKeyPair, setEphemeralKeyPair] = useState<EphemeralKeyPair | null>(null);

  // Classification badge
  const classificationBadge = getClassificationBadge(document.classificationLevel);
  const progress = getProgressStep(accessState);

  /**
   * Request document access.
   *
   * When `credentials` are provided the component uses the VC-based access gate:
   *   1. GET /api/access-gate/challenge   → receive challenge + presentationDefinition
   *   2. Build VP from held credential JWTs
   *   3. POST /api/access-gate/present    → receive encrypted document
   *   4. Decrypt with ephemeral X25519 key, destroy key (PFS unchanged)
   *
   * Falls back to the legacy session-based endpoint when no credentials are
   * available or when no JWT can be extracted from the credential objects.
   */
  const requestAccess = useCallback(async () => {
    console.log('[DocumentAccess] Starting access request for document:', document.id);

    setAccessState('generating_keys');
    setErrorMessage(null);
    setDenialReason(null);

    // Generate ephemeral X25519 keypair (PFS — always needed regardless of auth path)
    const { ephemeralKeyPair, requestPayload } = buildAccessRequest(
      document.id,
      requestorDID,
      issuerDID,
      clearanceLevel,
      ed25519PrivateKey
    );
    setEphemeralKeyPair(ephemeralKeyPair);

    // Ephemeral public key as base64 (matches server's Buffer.from(..., 'base64'))
    const ephemeralPublicKeyB64 = ephemeralKeyPair.publicKey; // base64url from generateEphemeralKeyPair

    try {
      // -----------------------------------------------------------------------
      // VC-BASED ACCESS GATE (preferred — inline VC verification)
      // -----------------------------------------------------------------------
      // Use only the credentials the user selected in the consent step (if any),
      // otherwise fall back to extracting all available JWTs.
      const credentialJWTs: string[] = consentCredentials.length > 0
        ? consentCredentials.filter(c => c.selected).map(c => c.jwt)
        : (() => {
            const jwts: string[] = [];
            for (const cred of (credentials || [])) {
              const jwt = extractCredentialJWT(cred);
              if (jwt) jwts.push(jwt);
            }
            return jwts;
          })();

      if (credentialJWTs.length > 0) {
        console.log('[DocumentAccess] Using VC-based access gate with', credentialJWTs.length, 'credential(s)');
        setAccessState('requesting_access');

        // Step A: Get challenge from server
        const challengeResponse = await fetch(
          `${apiBaseUrl}/access-gate/challenge?documentDID=${encodeURIComponent(document.id)}`
        );
        if (!challengeResponse.ok) {
          const err = await challengeResponse.json().catch(() => ({}));
          throw new Error(err.message || `Challenge request failed: ${challengeResponse.status}`);
        }
        const { challenge } = await challengeResponse.json();
        console.log('[DocumentAccess] Challenge received:', challenge?.substring(0, 12), '...');

        // Step B: Build VP (flat structure the server expects)
        const vp = {
          '@context': ['https://www.w3.org/2018/credentials/v1'],
          type: ['VerifiablePresentation'],
          verifiableCredential: credentialJWTs,
          proof: {
            type: 'Ed25519Signature2018',
            challenge,
            proofPurpose: 'authentication'
          }
        };

        // Step C: POST VP to present endpoint
        const presentResponse = await fetch(`${apiBaseUrl}/access-gate/present`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentDID: document.id,
            vp,
            challenge,
            ephemeralPublicKey: ephemeralPublicKeyB64
          })
        });

        const presentResult = await presentResponse.json();

        if (!presentResult.success && !presentResult.granted) {
          console.log('[DocumentAccess] VC access gate denied:', presentResult.error);
          setAccessState('denied');
          setDenialReason(presentResult.message || 'Access denied by server');
          onAccessComplete?.(false);
          return;
        }

        // Step D: Decrypt and destroy ephemeral key (PFS — unchanged)
        setAccessState('decrypting');
        const encDoc = presentResult.encryptedDocument || presentResult;
        const decryptionResult = decryptAndDestroy(encDoc, ephemeralKeyPair);

        setDecryptedContent(decryptionResult.plaintext);
        setCopyId(decryptionResult.copyId);
        setAccessState('success');

        console.log('[DocumentAccess] VC-based access granted:', {
          copyId: decryptionResult.copyId,
          keyDestroyed: decryptionResult.keyDestroyed,
          contentLength: decryptionResult.plaintext.length
        });

        onDocumentAccessed?.({
          plaintext: decryptionResult.plaintext,
          ephemeralDID: presentResult.ephemeralDID || decryptionResult.copyId,
          title: document.title,
          classification: presentResult.classificationLevel || document.classificationLabel,
          filename: presentResult.filename || document.filename,
          mimeType: presentResult.mimeType || 'text/html',
        });

        onAccessComplete?.(true, decryptionResult.copyId);
        return;
      }

      // -----------------------------------------------------------------------
      // LEGACY SESSION-BASED FALLBACK
      // (no credentials available — trust session clearance as before)
      // -----------------------------------------------------------------------
      console.log('[DocumentAccess] No credential JWTs available — falling back to session-based access');
      setAccessState('requesting_access');

      const response = await fetch(`${apiBaseUrl}/ephemeral-documents/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, documentDID: document.id })
      });

      const result: AccessResult = await response.json();

      if (!result.granted) {
        console.log('[DocumentAccess] Access denied:', result.reason);
        setAccessState('denied');
        setDenialReason(result.reason || 'Access denied by server');
        onAccessComplete?.(false);
        return;
      }

      if (!result.encryptedDocument) {
        throw new Error('Server response missing encrypted document');
      }

      setAccessState('decrypting');
      const decryptionResult = decryptAndDestroy(result.encryptedDocument, ephemeralKeyPair);

      setDecryptedContent(decryptionResult.plaintext);
      setCopyId(decryptionResult.copyId);
      setAccessState('success');

      console.log('[DocumentAccess] Session-based access granted:', {
        copyId: decryptionResult.copyId,
        keyDestroyed: decryptionResult.keyDestroyed,
        contentLength: decryptionResult.plaintext.length
      });

      onAccessComplete?.(true, decryptionResult.copyId);

    } catch (error: any) {
      console.error('[DocumentAccess] Access error:', error);
      setAccessState('error');
      setErrorMessage(error.message || 'Failed to access document');
      onAccessComplete?.(false);

      // Ensure ephemeral key is destroyed even on error (PFS)
      if (ephemeralKeyPair && !ephemeralKeyPair.destroyed) {
        console.log('[DocumentAccess] Destroying ephemeral key after error...');
        for (let i = 0; i < ephemeralKeyPair.secretKey.length; i++) {
          ephemeralKeyPair.secretKey[i] = 0;
        }
        ephemeralKeyPair.destroyed = true;
      }
    }
  }, [document, requestorDID, issuerDID, clearanceLevel, ed25519PrivateKey, apiBaseUrl, onAccessComplete, onDocumentAccessed, credentials, consentCredentials]);

  /**
   * Handle "Request Access" button click.
   * If VC credentials are available, show consent screen first.
   * Otherwise, go straight to the legacy flow.
   */
  const handleRequestClick = useCallback(() => {
    const jwtList: string[] = [];
    if (credentials && credentials.length > 0) {
      for (const cred of credentials) {
        const jwt = extractCredentialJWT(cred);
        if (jwt) jwtList.push(jwt);
      }
    }
    if (jwtList.length > 0) {
      // Build items pairing the extracted JWT with the type read directly from
      // the SDK credential object (properties Map) — same path used by the rest of the app
      const jwtToType = new Map<string, string>();
      for (const cred of (credentials || [])) {
        const jwt = extractCredentialJWT(cred);
        if (jwt) {
          // Try SDK object path first (local wallet credentials)
          const sdkType = getCredentialType(cred);
          // If that failed, decode the JWT directly (enterprise agent credentials are base64 JWT strings)
          const t = sdkType !== 'Unknown' ? sdkType : getJWTCredentialType(jwt);
          jwtToType.set(jwt, t === 'Unknown' ? 'Credential' : t);
        }
      }
      const items = jwtList.map(jwt => ({ jwt, type: jwtToType.get(jwt) || 'Credential', selected: true }));
      setConsentCredentials(items);
      setAccessState('awaiting_consent');
    } else {
      requestAccess();
    }
  }, [credentials, requestAccess]);

  /**
   * Reset state for new access attempt
   */
  const resetAccess = useCallback(() => {
    setAccessState('idle');
    setDecryptedContent(null);
    setCopyId(null);
    setErrorMessage(null);
    setDenialReason(null);
    setEphemeralKeyPair(null);
    setConsentCredentials([]);
  }, []);

  /**
   * Cleanup on unmount - ensure any ephemeral keys are destroyed
   */
  useEffect(() => {
    return () => {
      if (ephemeralKeyPair && !ephemeralKeyPair.destroyed) {
        console.log('[DocumentAccess] Cleanup: Destroying ephemeral key on unmount');
        for (let i = 0; i < ephemeralKeyPair.secretKey.length; i++) {
          ephemeralKeyPair.secretKey[i] = 0;
        }
        ephemeralKeyPair.destroyed = true;
      }
    };
  }, [ephemeralKeyPair]);

  /**
   * Convert decrypted content to displayable format
   */
  const getContentDisplay = () => {
    if (!decryptedContent) return null;

    // Check if it's a PDF (starts with %PDF)
    if (decryptedContent.length > 4 &&
        decryptedContent[0] === 0x25 &&
        decryptedContent[1] === 0x50 &&
        decryptedContent[2] === 0x44 &&
        decryptedContent[3] === 0x46) {
      // Create blob URL for PDF
      const blob = new Blob([decryptedContent], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      return (
        <iframe
          src={url}
          className="w-full h-96 border-2 border-gray-300 rounded-lg"
          title={document.title}
        />
      );
    }

    // Try to display as HTML or text
    try {
      const text = new TextDecoder().decode(decryptedContent);
      const trimmed = text.trimStart();
      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div')) {
        const blob = new Blob([decryptedContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        return (
          <iframe
            src={url}
            className="w-full h-[32rem] border-2 border-gray-300 rounded-lg"
            title={document.title}
            sandbox="allow-same-origin"
          />
        );
      }
      return (
        <pre className="w-full h-96 p-4 bg-gray-50 border-2 border-gray-300 rounded-lg overflow-auto text-sm font-mono">
          {text}
        </pre>
      );
    } catch {
      // Binary content - show download link
      const blob = new Blob([decryptedContent]);
      const url = URL.createObjectURL(blob);
      return (
        <div className="p-4 bg-gray-50 border-2 border-gray-300 rounded-lg text-center">
          <DocumentIcon className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <p className="text-gray-600 mb-4">Binary content - click to download</p>
          <a
            href={url}
            download={document.filename}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Download {document.filename}
          </a>
        </div>
      );
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-xl overflow-hidden max-w-2xl w-full">
      {/* Header with classification */}
      <div className={`px-6 py-4 ${classificationBadge.color} border-b-2`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <LockClosedIcon className="w-6 h-6" />
            <span className="font-bold text-lg">SECURE DOCUMENT ACCESS</span>
          </div>
          <span className={`px-3 py-1 rounded-full text-sm font-bold border ${classificationBadge.color}`}>
            {classificationBadge.label}
          </span>
        </div>
      </div>

      {/* Document Info */}
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-xl font-bold text-gray-900">{document.title}</h2>
        {document.description && (
          <p className="text-gray-600 mt-1">{document.description}</p>
        )}
        <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
          <span>File: {document.filename}</span>
          <span>Size: {(document.fileSize / 1024).toFixed(1)} KB</span>
        </div>
      </div>

      {/* Consent Step */}
      {accessState === 'awaiting_consent' && (
        <div className="px-6 py-6">
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheckIcon className="w-5 h-5 text-blue-600" />
              <span className="text-blue-800 font-semibold">Select credentials to present</span>
            </div>
            <p className="text-sm text-blue-700 mb-3">
              Choose which credentials to include in the Verifiable Presentation:
            </p>
            <ul className="space-y-2">
              {consentCredentials.map((item, i) => (
                <li key={i} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id={`cred-${i}`}
                    checked={item.selected}
                    onChange={() =>
                      setConsentCredentials(prev =>
                        prev.map((c, idx) => idx === i ? { ...c, selected: !c.selected } : c)
                      )
                    }
                    className="w-4 h-4 text-blue-600 rounded"
                  />
                  <label htmlFor={`cred-${i}`} className="text-sm text-blue-800 cursor-pointer select-none">
                    {item.type}
                  </label>
                </li>
              ))}
            </ul>
            {consentCredentials.every(c => !c.selected) && (
              <p className="mt-3 text-xs text-red-600">Select at least one credential to proceed.</p>
            )}
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={resetAccess}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={requestAccess}
              disabled={consentCredentials.every(c => !c.selected)}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <ShieldCheckIcon className="w-5 h-5" />
              Confirm & Present
            </button>
          </div>
        </div>
      )}

      {/* Progress Indicator */}
      {accessState !== 'idle' && accessState !== 'awaiting_consent' && accessState !== 'success' && accessState !== 'denied' && accessState !== 'error' && (
        <div className="px-6 py-4 bg-blue-50 border-b border-blue-200">
          <div className="flex items-center gap-3">
            <svg className="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span className="text-blue-700 font-medium">{progress.label}</span>
          </div>
          {/* Progress bar */}
          <div className="mt-3 h-2 bg-blue-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-500"
              style={{ width: `${(progress.step / 4) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Success State - Document Content */}
      {accessState === 'success' && decryptedContent && (
        <div className="px-6 py-4">
          {/* Security Notice */}
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2">
              <ShieldCheckIcon className="w-5 h-5 text-green-600" />
              <span className="text-green-700 font-medium">Perfect Forward Secrecy Active</span>
            </div>
            <p className="text-sm text-green-600 mt-1">
              Ephemeral key destroyed. This session cannot be decrypted even if the server is compromised.
            </p>
          </div>

          {/* Copy ID for accountability */}
          <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
            <div className="text-sm text-gray-600">
              <span className="font-semibold">Copy ID:</span>{' '}
              <code className="font-mono text-xs">{copyId}</code>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              This unique identifier is embedded in the document for accountability tracking.
            </p>
          </div>

          {/* Document Content */}
          {getContentDisplay()}
        </div>
      )}

      {/* Denied State */}
      {accessState === 'denied' && (
        <div className="px-6 py-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
            <ExclamationIcon className="w-10 h-10 text-red-600" />
          </div>
          <h3 className="text-xl font-bold text-red-700 mb-2">Access Denied</h3>
          <p className="text-gray-600 mb-4">{denialReason}</p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
          >
            Close
          </button>
        </div>
      )}

      {/* Error State */}
      {accessState === 'error' && (
        <div className="px-6 py-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-yellow-100 rounded-full flex items-center justify-center">
            <ExclamationIcon className="w-10 h-10 text-yellow-600" />
          </div>
          <h3 className="text-xl font-bold text-yellow-700 mb-2">Error</h3>
          <p className="text-gray-600 mb-4">{errorMessage}</p>
          <div className="flex justify-center gap-3">
            <button
              onClick={resetAccess}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Try Again
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Idle State - Request Button */}
      {accessState === 'idle' && (
        <div className="px-6 py-6">
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex items-center gap-2">
              <ShieldCheckIcon className="w-5 h-5 text-yellow-600" />
              <span className="text-yellow-700 font-medium">Perfect Forward Secrecy</span>
            </div>
            <p className="text-sm text-yellow-600 mt-1">
              A unique ephemeral key will be generated for this access. The key is destroyed immediately after decryption, ensuring this session remains secure even if the server is later compromised.
            </p>
          </div>

          <div className="flex justify-end gap-3">
            {onClose && (
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleRequestClick}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
            >
              <LockClosedIcon className="w-5 h-5" />
              Request Access
            </button>
          </div>
        </div>
      )}

      {/* Success State - Actions */}
      {accessState === 'success' && (
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

export default DocumentAccess;
