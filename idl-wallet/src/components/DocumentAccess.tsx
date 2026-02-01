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

  /** Callback to close the modal/component */
  onClose?: () => void;
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
      return { color: 'bg-red-100 text-red-800 border-red-300', label: 'TOP SECRET' };
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
export function DocumentAccess({
  document,
  requestorDID,
  issuerDID,
  clearanceLevel,
  ed25519PrivateKey,
  apiBaseUrl = 'https://identuslabel.cz/company-admin/api',
  onAccessComplete,
  onClose
}: DocumentAccessProps) {
  // State
  const [accessState, setAccessState] = useState<AccessState>('idle');
  const [decryptedContent, setDecryptedContent] = useState<Uint8Array | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState<string | null>(null);

  // Ephemeral keypair (stored temporarily during access flow)
  const [ephemeralKeyPair, setEphemeralKeyPair] = useState<EphemeralKeyPair | null>(null);

  // Classification badge
  const classificationBadge = getClassificationBadge(document.classificationLevel);
  const progress = getProgressStep(accessState);

  /**
   * Request document access
   */
  const requestAccess = useCallback(async () => {
    console.log('[DocumentAccess] Starting access request for document:', document.id);

    setAccessState('generating_keys');
    setErrorMessage(null);
    setDenialReason(null);

    try {
      // Step 1: Build access request (generates ephemeral keypair + signs)
      console.log('[DocumentAccess] Building access request...');
      const { ephemeralKeyPair, requestPayload } = buildAccessRequest(
        document.id,
        requestorDID,
        issuerDID,
        clearanceLevel,
        ed25519PrivateKey
      );

      setEphemeralKeyPair(ephemeralKeyPair);

      // Step 2: Send access request to server
      setAccessState('requesting_access');
      console.log('[DocumentAccess] Sending access request to server...');

      const response = await fetch(`${apiBaseUrl}/ephemeral-documents/${document.id}/access`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload)
      });

      const result: AccessResult = await response.json();

      if (!result.granted) {
        // Access denied
        console.log('[DocumentAccess] Access denied:', result.reason);
        setAccessState('denied');
        setDenialReason(result.reason || 'Access denied by server');
        onAccessComplete?.(false);
        return;
      }

      if (!result.encryptedDocument) {
        throw new Error('Server response missing encrypted document');
      }

      // Step 3: Decrypt document and DESTROY ephemeral key
      setAccessState('decrypting');
      console.log('[DocumentAccess] Decrypting document with PFS...');

      const decryptionResult = decryptAndDestroy(result.encryptedDocument, ephemeralKeyPair);

      // Step 4: Success!
      setDecryptedContent(decryptionResult.plaintext);
      setCopyId(decryptionResult.copyId);
      setAccessState('success');

      console.log('[DocumentAccess] Document accessed successfully:', {
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

      // Ensure ephemeral key is destroyed even on error
      if (ephemeralKeyPair && !ephemeralKeyPair.destroyed) {
        console.log('[DocumentAccess] Destroying ephemeral key after error...');
        for (let i = 0; i < ephemeralKeyPair.secretKey.length; i++) {
          ephemeralKeyPair.secretKey[i] = 0;
        }
        ephemeralKeyPair.destroyed = true;
      }
    }
  }, [document, requestorDID, issuerDID, clearanceLevel, ed25519PrivateKey, apiBaseUrl, onAccessComplete]);

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

    // Try to display as text
    try {
      const text = new TextDecoder().decode(decryptedContent);
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

      {/* Progress Indicator */}
      {accessState !== 'idle' && accessState !== 'success' && accessState !== 'denied' && accessState !== 'error' && (
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
              onClick={requestAccess}
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
