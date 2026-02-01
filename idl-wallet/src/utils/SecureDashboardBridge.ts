/**
 * Secure Dashboard Bridge - window.postMessage Integration
 *
 * Enables zero-network-traffic decryption of secure dashboard content:
 * - Dashboard opens wallet in new window
 * - Dashboard sends encrypted content via window.postMessage
 * - Wallet decrypts locally using X25519 keys from Security Clearance VC
 * - Wallet sends plaintext back via window.postMessage
 * - 100% local decryption - no server involved in decrypt phase
 *
 * Architecture:
 * 1. Dashboard opens wallet: window.open('http://91.99.4.54:3001')
 * 2. Wallet detects opener and sends ready signal
 * 3. Dashboard sends DECRYPT_REQUEST via postMessage
 * 4. Wallet receives request, decrypts using stored X25519 keys
 * 5. Wallet sends DECRYPT_RESPONSE with plaintext
 * 6. Dashboard updates DOM with decrypted content
 *
 * Version: 2.0.0 (Migrated from BroadcastChannel to postMessage)
 * Updated: October 31, 2025
 */

import { base64url } from 'jose';
import { decryptMessage, EncryptedMessageBody } from './messageEncryption';
import { getItem } from './prefixedStorage';
import { findKeyByFingerprintInPluto, extractKeysFromPrismDID } from './plutoKeyExtractor';
import { storeDocument, StoredDocument, DocumentStatus } from './documentStorage';

// Module-level agent reference for Pluto fallback
let _sdkAgent: any = null;

// Store walletId for deferred WALLET_READY signal
let _walletId: string | null = null;

/**
 * Set the SDK agent for Pluto fallback key lookup
 * Call this after agent is initialized to enable PRISM DID key fallback
 *
 * CRITICAL: This is when WALLET_READY is sent to opener (not at init time)
 * This ensures the agent is available before dashboard sends DECRYPT_REQUEST
 */
export function setSecureDashboardAgent(agent: any): void {
  _sdkAgent = agent;
  console.log('🔐 [SecureDashboardBridge] Agent set for Pluto fallback');

  // NOW send WALLET_READY signal to opener (if this is a popup)
  // Previously this was done in initSecureDashboardBridge() BEFORE agent was set
  if (typeof window !== 'undefined' && window.opener && !window.opener.closed && _walletId) {
    console.log('🔗 [SecureDashboardBridge] Agent ready - NOW sending WALLET_READY to opener');

    ALLOWED_ORIGINS.forEach(origin => {
      try {
        window.opener.postMessage({
          type: 'WALLET_READY',
          walletId: _walletId,
          timestamp: Date.now()
        }, origin);
        console.log(`✅ [SecureDashboardBridge] WALLET_READY sent to ${origin}`);
      } catch (error) {
        console.warn(`⚠️ [SecureDashboardBridge] Failed to send WALLET_READY to ${origin}:`, error);
      }
    });
  }
}

/**
 * Message types for postMessage communication
 */
export type DashboardMessage =
  | {
      type: 'PING';
      source: string;
      timestamp: number;
    }
  | {
      type: 'DECRYPT_REQUEST';
      requestId: string;
      sectionId: string;
      encryptedContent: EncryptedMessageBody;
      timestamp: number;
    }
  | {
      type: 'DOCUMENT_ACCESS_REQUEST';
      requestId: string;
      documentDID: string;
      clearanceLevel: number;
      timestamp: number;
    }
  | {
      type: 'DOCUMENT_STORAGE_REQUEST';
      requestId: string;
      ephemeralDID: string;
      originalDocumentDID: string;
      title: string;
      overallClassification: string;
      encryptedContent: string; // Base64-encoded encrypted document
      encryptionInfo: {
        algorithm: string;
        serverPublicKey: string;
        nonce: string;
      };
      sectionSummary: {
        total: number;
        visible: number;
        redacted: number;
      };
      expiresAt: string;
      accessRights: {
        expiresAt: string;
        viewsAllowed: number;
        downloadAllowed: boolean;
        printAllowed: boolean;
      };
      sourceInfo: {
        filename: string;
        format: string;
        contentType: string;
        originalSize: number;
      };
      timestamp: number;
    }
  | {
      type: 'OPEN_DOCUMENT';
      requestId: string;
      ephemeralDID: string;
      title: string;
      sourceInfo: {
        filename: string;
        format: string;
        contentType: string;
      };
      timestamp: number;
    }
  | {
      type: 'SSI_DOCUMENT_DOWNLOAD_REQUEST';
      requestId: string;
      documentDID: string;
      title: string;
      sessionId: string;
      serverBaseUrl: string;
      timestamp: number;
    };

// Allowed dashboard origins
const ALLOWED_ORIGINS = [
  'http://91.99.4.54:3005',     // CA Server (IP access)
  'http://localhost:3005',      // Local development
  'https://identuslabel.cz',    // CA Server (domain access via HTTPS)
  'http://91.99.4.54:3010',     // Company Admin Portal (IP access)
  'http://localhost:3010',      // Company Admin Portal (local development)
];

/**
 * Initialize Secure Dashboard Bridge
 * Sets up postMessage listener for dashboard communication
 *
 * @param walletId - Unique wallet identifier ('alice' or 'bob')
 */
export function initSecureDashboardBridge(walletId: string): void {
  try {
    console.log(`🔐 [SecureDashboardBridge] Initializing for wallet: ${walletId}`);

    // Set up postMessage listener
    const messageHandler = async (event: MessageEvent) => {
      // EARLY EXIT: Ignore messages from self (prevents log spam)
      if (event.source === window) {
        return;
      }

      // EARLY EXIT: Ignore messages without valid type (non-dashboard messages)
      if (!event.data?.type) {
        return;
      }

      // Security: Validate origin
      if (!ALLOWED_ORIGINS.includes(event.origin)) {
        console.warn(`⚠️ [SecureDashboardBridge] Rejected message from unauthorized origin: ${event.origin}`);
        return;
      }

      const message: DashboardMessage = event.data;

      console.log(`📨 [SecureDashboardBridge] Received message:`, message.type);

      switch (message.type) {
        case 'PING':
          handlePing(event.source as Window, event.origin, walletId);
          break;

        case 'DECRYPT_REQUEST':
          await handleDecryptRequest(event.source as Window, event.origin, message);
          break;

        case 'DOCUMENT_ACCESS_REQUEST':
          await handleDocumentAccessRequest(event.source as Window, event.origin, message);
          break;

        case 'DOCUMENT_STORAGE_REQUEST':
          await handleDocumentStorageRequest(event.source as Window, event.origin, message);
          break;

        case 'OPEN_DOCUMENT':
          await handleOpenDocumentRequest(event.source as Window, event.origin, message);
          break;

        case 'SSI_DOCUMENT_DOWNLOAD_REQUEST':
          await handleSSIDocumentDownloadRequest(event.source as Window, event.origin, message);
          break;

        default:
          console.warn(`⚠️ [SecureDashboardBridge] Unknown message type:`, message);
      }
    };

    window.addEventListener('message', messageHandler);

    console.log('✅ [SecureDashboardBridge] postMessage listener initialized');

    // Store handler reference for cleanup
    (window as any).__secureDashboardMessageHandler = messageHandler;

    // Store walletId for deferred WALLET_READY signal (sent when agent is set)
    _walletId = walletId;

    // NOTE: WALLET_READY is now sent LATER in setSecureDashboardAgent() after agent is available
    // This fixes the race condition where dashboard sends DECRYPT_REQUEST before agent is ready
    if (window.opener && !window.opener.closed) {
      console.log('🔗 [SecureDashboardBridge] Detected opener window - WALLET_READY will be sent when agent is ready');
    }

    console.log('✅ [SecureDashboardBridge] Initialized successfully (waiting for agent to send WALLET_READY)');
  } catch (error) {
    console.error('❌ [SecureDashboardBridge] Initialization failed:', error);
  }
}

/**
 * Handle PING request from dashboard
 * Responds with PONG to indicate wallet is active
 */
function handlePing(source: Window, origin: string, walletId: string): void {
  console.log('🏓 [SecureDashboardBridge] PING received, sending PONG');

  try {
    source.postMessage({
      type: 'PONG',
      walletId: walletId,
      timestamp: Date.now()
    }, origin);
  } catch (error) {
    console.error('❌ [SecureDashboardBridge] Failed to send PONG:', error);
  }
}

/**
 * Handle DECRYPT_REQUEST from dashboard
 * Decrypts content using X25519 keys and sends back plaintext
 *
 * Two-pass key lookup:
 * 1. Fast path: localStorage (manually generated keys)
 * 2. Fallback: Pluto (PRISM DID keys) - if agent is available
 */
async function handleDecryptRequest(
  source: Window,
  origin: string,
  message: Extract<DashboardMessage, { type: 'DECRYPT_REQUEST' }>
): Promise<void> {
  const { requestId, sectionId, encryptedContent } = message;

  console.log(`🔓 [SecureDashboardBridge] Decrypt request for section: ${sectionId}`);
  console.log(`🔓 [SecureDashboardBridge] Agent available: ${_sdkAgent ? 'YES' : 'NO (Pluto fallback disabled)'}`);

  // Collect ALL available key pairs to try for decryption
  const keyPairsToTry: Array<{
    privateKeyBytes: Uint8Array;
    publicKeyBytes: Uint8Array;
    source: string;
  }> = [];

  // ============================================================
  // PASS 1: Collect localStorage keys
  // ============================================================
  const securityKeysData = getItem('security-clearance-keys');

  if (securityKeysData && typeof securityKeysData === 'object') {
    try {
      const keys = securityKeysData.keys || [];
      console.log(`🔑 [SecureDashboardBridge] Found ${keys.length} keys in localStorage`);

      for (const key of keys) {
        if (key?.x25519?.privateKeyBytes && key?.x25519?.publicKeyBytes) {
          keyPairsToTry.push({
            privateKeyBytes: base64url.decode(key.x25519.privateKeyBytes),
            publicKeyBytes: base64url.decode(key.x25519.publicKeyBytes),
            source: `localStorage:${key.keyId} (pubKey: ${key.x25519.publicKeyBytes.substring(0, 12)}...)`
          });
        }
      }
    } catch (parseError) {
      console.warn('⚠️ [SecureDashboardBridge] Failed to access localStorage keys:', parseError);
    }
  }

  // ============================================================
  // PASS 2: Collect Pluto keys (PRISM DIDs)
  // ============================================================
  if (_sdkAgent) {
    try {
      const prismDIDs = await _sdkAgent.pluto.getAllPrismDIDs();

      if (prismDIDs && prismDIDs.length > 0) {
        console.log(`📦 [SecureDashboardBridge] Found ${prismDIDs.length} PRISM DIDs in Pluto`);

        for (const prismDID of prismDIDs) {
          const didString = prismDID.did.toString();
          const plutoKeys = await extractKeysFromPrismDID(_sdkAgent, didString);

          if (plutoKeys?.x25519?.privateKeyBytes && plutoKeys?.x25519?.publicKeyBytes) {
            keyPairsToTry.push({
              privateKeyBytes: base64url.decode(plutoKeys.x25519.privateKeyBytes),
              publicKeyBytes: base64url.decode(plutoKeys.x25519.publicKeyBytes),
              source: `Pluto:${didString.substring(0, 30)}...`
            });
          }
        }
      }
    } catch (plutoError) {
      console.warn('⚠️ [SecureDashboardBridge] Pluto key collection failed:', plutoError);
    }
  }

  // ============================================================
  // Check if we found any keys
  // ============================================================
  if (keyPairsToTry.length === 0) {
    const errorMsg = _sdkAgent
      ? 'No X25519 keys found in localStorage or Pluto. Please generate Security Clearance credential first.'
      : 'Security clearance keys not found. Please generate Security Clearance credential first.';

    console.error(`❌ [SecureDashboardBridge] ${errorMsg}`);

    source.postMessage({
      type: 'DECRYPT_ERROR',
      requestId,
      sectionId,
      error: errorMsg,
      timestamp: Date.now()
    }, origin);
    return;
  }

  console.log(`🔑 [SecureDashboardBridge] Collected ${keyPairsToTry.length} key pairs to try`);

  // ============================================================
  // Try each key pair until one succeeds
  // ============================================================
  let lastError: Error | null = null;

  for (let i = 0; i < keyPairsToTry.length; i++) {
    const keyPair = keyPairsToTry[i];
    console.log(`🔧 [SecureDashboardBridge] Trying key ${i + 1}/${keyPairsToTry.length}: ${keyPair.source}`);

    try {
      const plaintext = await decryptMessage(
        encryptedContent,
        keyPair.privateKeyBytes,
        keyPair.publicKeyBytes
      );

      console.log(`✅ [SecureDashboardBridge] Decryption successful with key: ${keyPair.source}`);

      // Send decrypted plaintext back to dashboard
      source.postMessage({
        type: 'DECRYPT_RESPONSE',
        requestId,
        sectionId,
        plaintext,
        timestamp: Date.now()
      }, origin);

      console.log(`📤 [SecureDashboardBridge] DECRYPT_RESPONSE sent for section: ${sectionId}`);
      return; // Success! Exit the function

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`⚠️ [SecureDashboardBridge] Key ${i + 1} failed: ${lastError.message.substring(0, 50)}...`);
      // Continue to next key
    }
  }

  // All keys failed
  console.error(`❌ [SecureDashboardBridge] All ${keyPairsToTry.length} keys failed for section ${sectionId}`);
  console.error(`❌ [SecureDashboardBridge] This means NONE of your wallet keys match the key used for encryption`);
  console.error(`❌ [SecureDashboardBridge] The Security Clearance VC may have different keys than what's in your wallet`);

  source.postMessage({
    type: 'DECRYPT_ERROR',
    requestId,
    sectionId,
    error: `Decryption failed - none of your ${keyPairsToTry.length} wallet keys match the encryption key. Your Security Clearance VC may have been issued with different keys than what's stored in your wallet.`,
    timestamp: Date.now()
  }, origin);
}

/**
 * Wait for the SDK agent to be set (with timeout)
 * Used for DOCUMENT_ACCESS_REQUEST which requires Pluto access for signing keys
 */
async function waitForAgent(timeoutMs: number = 10000): Promise<boolean> {
  if (_sdkAgent) return true;

  const startTime = Date.now();
  const pollInterval = 200; // Check every 200ms

  return new Promise((resolve) => {
    const checkAgent = () => {
      if (_sdkAgent) {
        console.log('✅ [SecureDashboardBridge] Agent is now available');
        resolve(true);
        return;
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.warn(`⏱️ [SecureDashboardBridge] Agent not available after ${timeoutMs}ms timeout`);
        resolve(false);
        return;
      }

      setTimeout(checkAgent, pollInterval);
    };

    console.log('⏳ [SecureDashboardBridge] Waiting for agent to be available...');
    checkAgent();
  });
}

/**
 * Get Ed25519 signing key from localStorage or Pluto fallback
 * Two-pass lookup: localStorage (fast) → Pluto (PRISM DID keys)
 */
async function getEd25519KeyFromPluto(): Promise<Uint8Array | null> {
  // ============================================================
  // PASS 1: Try localStorage (fast path - manually generated keys)
  // ============================================================
  const securityKeysData = getItem('security-clearance-keys');

  if (securityKeysData && typeof securityKeysData === 'object') {
    try {
      // getItem() already parses JSON - no need to JSON.parse again!
      const activeKeyId = securityKeysData.activeKeyId;
      const keys = securityKeysData.keys || [];
      const activeKey = keys.find((k: any) => k.keyId === activeKeyId);

      if (activeKey?.ed25519?.privateKeyBytes) {
        console.log('🔑 [SecureDashboardBridge] Using localStorage Ed25519 key');
        return base64url.decode(activeKey.ed25519.privateKeyBytes);
      }

      // If active key doesn't have Ed25519, try all keys
      for (const key of keys) {
        if (key?.ed25519?.privateKeyBytes) {
          console.log('🔑 [SecureDashboardBridge] Using fallback localStorage Ed25519 key:', key.keyId);
          return base64url.decode(key.ed25519.privateKeyBytes);
        }
      }
    } catch (parseError) {
      console.warn('⚠️ [SecureDashboardBridge] Failed to access localStorage Ed25519 keys:', parseError);
    }
  }

  // ============================================================
  // PASS 2: Try Pluto fallback (PRISM DID keys)
  // ============================================================
  if (_sdkAgent) {
    try {
      const prismDIDs = await _sdkAgent.pluto.getAllPrismDIDs();

      if (prismDIDs && prismDIDs.length > 0) {
        for (const prismDID of prismDIDs) {
          const didString = prismDID.did.toString();
          const plutoKeys = await extractKeysFromPrismDID(_sdkAgent, didString);

          if (plutoKeys?.ed25519?.privateKeyBytes) {
            console.log('🔑 [SecureDashboardBridge] Using Pluto Ed25519 key from PRISM DID');
            return base64url.decode(plutoKeys.ed25519.privateKeyBytes);
          }
        }
      }
    } catch (plutoError) {
      console.warn('⚠️ [SecureDashboardBridge] Pluto Ed25519 fallback failed:', plutoError);
    }
  }

  return null;
}

/**
 * Handle DOCUMENT_ACCESS_REQUEST from Employee Portal Dashboard
 *
 * Flow:
 * 1. Generate ephemeral X25519 keypair (perfect forward secrecy)
 * 2. Get Ed25519 key from Pluto for request signing
 * 3. Sign access request payload
 * 4. POST to Company Admin Portal /api/ephemeral-documents/{documentDID}/access
 * 5. Decrypt response with ephemeral key
 * 6. Send decrypted document back to Employee Portal
 */
async function handleDocumentAccessRequest(
  source: Window,
  origin: string,
  message: Extract<DashboardMessage, { type: 'DOCUMENT_ACCESS_REQUEST' }>
): Promise<void> {
  const { requestId, documentDID, clearanceLevel, sessionToken } = message;

  console.log(`📄 [SecureDashboardBridge] Document access request for: ${documentDID.substring(0, 50)}...`);
  console.log(`📄 [SecureDashboardBridge] Clearance level: ${clearanceLevel}`);
  console.log(`📄 [SecureDashboardBridge] Session token: ${sessionToken ? 'present' : 'MISSING'}`);
  console.log(`📄 [SecureDashboardBridge] Agent available: ${_sdkAgent ? 'YES' : 'NO'}`);

  try {
    // CRITICAL: Wait for agent to be ready (needed for Pluto key lookup)
    // The request may arrive before agent initialization completes
    if (!_sdkAgent) {
      console.log('⏳ [SecureDashboardBridge] Agent not ready, waiting up to 15 seconds...');
      const agentReady = await waitForAgent(15000);
      if (!agentReady) {
        throw new Error('Wallet agent not ready. Please wait for the wallet to fully load and try again.');
      }
    }

    // Dynamic import of tweetnacl for NaCl cryptography
    const nacl = await import('tweetnacl');

    // 1. Generate ephemeral X25519 keypair (perfect forward secrecy)
    const ephemeralKeyPair = nacl.box.keyPair();
    const ephemeralPublicKey = base64url.encode(ephemeralKeyPair.publicKey);
    console.log('🔐 [SecureDashboardBridge] Generated ephemeral X25519 keypair');

    // 2. Get Ed25519 signing key from Pluto (agent is now guaranteed available)
    const ed25519PrivateKey = await getEd25519KeyFromPluto();
    if (!ed25519PrivateKey) {
      throw new Error('No Ed25519 signing key found. Please ensure you have a PRISM DID (connect to CA first).');
    }

    // 3. Create and sign access request payload
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const payload = JSON.stringify({
      documentDID,
      ephemeralPublicKey,
      timestamp,
      nonce
    });

    const signature = nacl.sign.detached(
      new Uint8Array(new TextEncoder().encode(payload)),
      ed25519PrivateKey
    );
    const signatureBase64 = base64url.encode(signature);
    console.log('✍️ [SecureDashboardBridge] Signed access request payload');

    // 4. POST to Company Admin Portal
    // Determine the Company Admin Portal base URL
    // The origin from postMessage is the Employee Portal Dashboard,
    // but we need to POST to the Company Admin Portal server
    const companyAdminPortalUrl = origin.includes('localhost')
      ? 'http://localhost:3010'
      : 'https://identuslabel.cz/company-admin';

    const accessEndpoint = `${companyAdminPortalUrl}/api/ephemeral-documents/access`;

    console.log(`📤 [SecureDashboardBridge] Posting to: ${accessEndpoint}`);

    // Create ephemeralDID from the ephemeral public key (did:key format with multibase z prefix)
    const ephemeralPublicKeyBytes = Buffer.from(ephemeralKeyPair.publicKey);
    const ephemeralDID = 'did:key:z' + ephemeralPublicKeyBytes.toString('hex');

    // Use the CA's issuer DID (this is the trusted issuer for Security Clearance VCs)
    // In production, this would be extracted from the user's Security Clearance VC
    const issuerDID = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';

    console.log(`🔑 [SecureDashboardBridge] Ephemeral DID: ${ephemeralDID.substring(0, 50)}...`);

    // Get user's PRISM DID from Pluto for unique user identification
    let requestorDID = 'did:prism:wallet-user'; // Fallback if no PRISM DID found
    try {
      const prismDIDs = await _sdkAgent!.pluto.getAllPrismDIDs();
      if (prismDIDs && prismDIDs.length > 0) {
        // Use the first PRISM DID (most likely the one created during CA connection)
        requestorDID = prismDIDs[0].did.toString();
        console.log(`🆔 [SecureDashboardBridge] Using PRISM DID for requestorDID: ${requestorDID.substring(0, 50)}...`);
      } else {
        console.warn('⚠️ [SecureDashboardBridge] No PRISM DID found, using fallback identifier');
      }
    } catch (prismError) {
      console.warn('⚠️ [SecureDashboardBridge] Failed to get PRISM DID:', prismError);
    }

    // Build headers - include session token if provided for server authentication
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sessionToken) {
      headers['X-Session-ID'] = sessionToken;
      console.log('🔑 [SecureDashboardBridge] Including X-Session-ID header for authentication');
    } else {
      console.warn('⚠️ [SecureDashboardBridge] No session token provided - request may be rejected');
    }

    const response = await fetch(accessEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        documentDID,
        requestorDID, // User's actual PRISM DID from Pluto
        issuerDID,
        clearanceLevel,
        ephemeralDID,
        ephemeralPublicKey,
        signature: signatureBase64,
        timestamp,
        nonce
      })
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || data.message || 'Document access denied');
    }

    console.log(`✅ [SecureDashboardBridge] Access granted for document`);

    // 5. Decrypt response with ephemeral key
    if (data.ciphertext && data.nonce && data.serverPublicKey) {
      const ciphertext = base64url.decode(data.ciphertext);
      const decryptNonce = base64url.decode(data.nonce);
      const serverPubKey = base64url.decode(data.serverPublicKey);

      const decrypted = nacl.box.open(
        ciphertext,
        decryptNonce,
        serverPubKey,
        ephemeralKeyPair.secretKey
      );

      if (!decrypted) {
        throw new Error('Failed to decrypt document content');
      }

      console.log(`🔓 [SecureDashboardBridge] Decrypted ${decrypted.length} bytes`);

      // 6. Send decrypted document back to Employee Portal
      source.postMessage({
        type: 'DOCUMENT_ACCESS_RESPONSE',
        requestId,
        success: true, // Explicit success flag for Employee Portal
        documentBlob: Array.from(decrypted), // Convert Uint8Array for postMessage
        filename: data.filename,
        mimeType: data.mimeType || 'application/pdf',
        copyId: data.copyId,
        timestamp: Date.now()
      }, origin);

      console.log(`📤 [SecureDashboardBridge] DOCUMENT_ACCESS_RESPONSE sent`);
    } else {
      throw new Error('Invalid response format - missing encrypted content');
    }

  } catch (error) {
    console.error(`❌ [SecureDashboardBridge] Document access failed:`, error);

    // Send error response to Employee Portal
    try {
      source.postMessage({
        type: 'DOCUMENT_ACCESS_ERROR',
        requestId,
        error: error instanceof Error ? error.message : 'Unknown document access error',
        timestamp: Date.now()
      }, origin);
    } catch (postError) {
      console.error('❌ [SecureDashboardBridge] Failed to send error response:', postError);
    }
  }
}

/**
 * Handle DOCUMENT_STORAGE_REQUEST from dashboard
 * Stores encrypted document for later viewing in IndexedDB
 */
async function handleDocumentStorageRequest(
  source: Window,
  origin: string,
  message: Extract<DashboardMessage, { type: 'DOCUMENT_STORAGE_REQUEST' }>
): Promise<void> {
  const {
    requestId,
    ephemeralDID,
    originalDocumentDID,
    title,
    overallClassification,
    encryptedContent,
    encryptionInfo,
    sectionSummary,
    expiresAt,
    accessRights,
    sourceInfo
  } = message;

  console.log(`📦 [SecureDashboardBridge] Document storage request: ${title}`);
  console.log(`   Ephemeral DID: ${ephemeralDID.substring(0, 50)}...`);
  console.log(`   Format: ${sourceInfo.format}`);
  console.log(`   Expires: ${expiresAt}`);

  try {
    // Import documentStorage to store in IndexedDB
    const { storeDocument } = await import('./documentStorage');

    // Convert base64 encrypted content to ArrayBuffer
    const binaryString = atob(encryptedContent);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const encryptedBuffer = bytes.buffer;

    // Map section summary to expected format
    const mappedSectionSummary = {
      totalSections: sectionSummary.total,
      visibleCount: sectionSummary.visible,
      redactedCount: sectionSummary.redacted,
      clearanceLevelsUsed: [overallClassification], // Simplified
      visibleSections: [],  // Dashboard doesn't send detailed section info
      redactedSections: []  // Dashboard doesn't send detailed section info
    };

    // Build StoredDocument for IndexedDB
    const storedDocument = {
      ephemeralDID,
      originalDocumentDID,
      title,
      overallClassification,
      encryptedContent: encryptedBuffer,
      encryptionInfo: {
        serverPublicKey: encryptionInfo.serverPublicKey,
        nonce: encryptionInfo.nonce,
        algorithm: encryptionInfo.algorithm
      },
      sectionSummary: mappedSectionSummary,
      sourceInfo: {
        filename: sourceInfo.filename,
        format: sourceInfo.format
      },
      receivedAt: new Date().toISOString(),
      expiresAt,
      viewCount: 0,
      maxViews: accessRights.viewsAllowed,
      status: 'active' as const
    };

    // Store in IndexedDB using documentStorage
    await storeDocument(storedDocument);

    console.log(`✅ [SecureDashboardBridge] Document stored in IndexedDB: ${ephemeralDID}`);

    // Send success response
    source.postMessage({
      type: 'DOCUMENT_STORAGE_RESPONSE',
      requestId,
      success: true,
      ephemeralDID,
      message: 'Document stored successfully',
      timestamp: Date.now()
    }, origin);

  } catch (error) {
    console.error(`❌ [SecureDashboardBridge] Document storage failed:`, error);

    source.postMessage({
      type: 'DOCUMENT_STORAGE_ERROR',
      requestId,
      error: error instanceof Error ? error.message : 'Failed to store document',
      timestamp: Date.now()
    }, origin);
  }
}

/**
 * Handle OPEN_DOCUMENT request from dashboard
 * Opens the document viewer for a stored document
 */
async function handleOpenDocumentRequest(
  source: Window,
  origin: string,
  message: Extract<DashboardMessage, { type: 'OPEN_DOCUMENT' }>
): Promise<void> {
  const { requestId, ephemeralDID, title, sourceInfo } = message;

  console.log(`📖 [SecureDashboardBridge] Open document request: ${title}`);
  console.log(`   Ephemeral DID: ${ephemeralDID.substring(0, 50)}...`);
  console.log(`   Format: ${sourceInfo.format}`);

  try {
    // Store the document to open in a global variable
    // (The document viewer page will read this)
    (window as any).__documentToOpen = {
      ephemeralDID,
      title,
      sourceInfo,
      openedAt: Date.now()
    };

    // Navigate to the document viewer page
    // Using hash-based routing to not reload the app
    const viewerUrl = `/my-documents?view=${encodeURIComponent(ephemeralDID)}`;

    // If we're in a popup, navigate there
    // If we're the main window, open a new viewer
    if (window.location.pathname.includes('dashboard-decrypt') ||
        window.opener) {
      // This is a popup window - navigate within it
      window.location.href = viewerUrl;
    } else {
      // Main window - open viewer
      window.location.href = viewerUrl;
    }

    // Send acknowledgment
    source.postMessage({
      type: 'DOCUMENT_VIEWER_OPENED',
      requestId,
      success: true,
      viewerUrl,
      timestamp: Date.now()
    }, origin);

  } catch (error) {
    console.error(`❌ [SecureDashboardBridge] Open document failed:`, error);

    source.postMessage({
      type: 'DOCUMENT_VIEWER_ERROR',
      requestId,
      error: error instanceof Error ? error.message : 'Failed to open document viewer',
      timestamp: Date.now()
    }, origin);
  }
}

/**
 * Handle SSI_DOCUMENT_DOWNLOAD_REQUEST from Employee Portal Dashboard
 *
 * SSI-compliant document download flow (SIMPLIFIED Dec 13, 2025):
 * 1. Call prepare-download endpoint (server creates ephemeral DID)
 * 2. Generate wallet's own X25519 keypair for decryption
 * 3. Call complete-download with wallet's public key
 * 4. Server encrypts document and issues DocumentCopy VC via DIDComm
 *
 * NOTE: Server now creates the ephemeral DID because:
 * - Wallet's ServiceConfiguration VC points to Enterprise Agent (8200)
 * - 8200 is for company wallets (issues credentials FROM)
 * - Server has access to Employee Agent (8300) for employee DIDs
 */
async function handleSSIDocumentDownloadRequest(
  source: Window,
  origin: string,
  message: Extract<DashboardMessage, { type: 'SSI_DOCUMENT_DOWNLOAD_REQUEST' }>
): Promise<void> {
  const { requestId, documentDID, title, sessionId, serverBaseUrl } = message;

  console.log(`📥 [SecureDashboardBridge] SSI Document Download request for: ${documentDID.substring(0, 50)}...`);
  console.log(`📥 [SecureDashboardBridge] Server base URL: ${serverBaseUrl}`);

  try {
    // Step 1: Call prepare-download endpoint (server creates ephemeral DID now)
    console.log('📥 [SecureDashboardBridge] Step 1: Calling prepare-download endpoint...');
    const prepareResponse = await fetch(
      `${serverBaseUrl}/api/employee-portal/documents/prepare-download/${encodeURIComponent(documentDID)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        }
      }
    );

    if (!prepareResponse.ok) {
      const errorData = await prepareResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Prepare download failed: ${prepareResponse.status}`);
    }

    const prepareData = await prepareResponse.json();
    console.log('📥 [SecureDashboardBridge] Server prepared download:', {
      storageId: prepareData.storageId,
      ephemeralDID: prepareData.ephemeralDID?.substring(0, 50) + '...',
      expiresAt: prepareData.expiresAt
    });

    // Server now provides ephemeral DID - no wallet-side creation needed!
    const ephemeralDID = prepareData.ephemeralDID;
    if (!ephemeralDID) {
      throw new Error('Server did not return ephemeral DID. Please check server logs.');
    }

    // Step 2: Generate wallet's own X25519 keypair for decryption
    console.log('📥 [SecureDashboardBridge] Step 2: Generating wallet X25519 keypair...');

    // Dynamic import of tweetnacl for key generation
    const nacl = await import('tweetnacl');
    const walletKeyPair = nacl.box.keyPair();
    const walletPublicKey = Buffer.from(walletKeyPair.publicKey).toString('base64');

    console.log('📥 [SecureDashboardBridge] Wallet X25519 keypair generated');

    // Store wallet's private key for later decryption (using ephemeralDID as key)
    const { setItem, getItem } = await import('./prefixedStorage');

    const keyName1 = `ephemeral-key-${ephemeralDID}`;
    const keyName2 = `ephemeral-key-${prepareData.storageId}`;
    console.log('📥 [SecureDashboardBridge] Storing key with name:', keyName1);
    console.log('📥 [SecureDashboardBridge] Storing key with name:', keyName2);

    // Store by ephemeralDID so viewer can look it up
    setItem(keyName1, {
      secretKey: Buffer.from(walletKeyPair.secretKey).toString('base64'),
      publicKey: walletPublicKey,
      ephemeralDID,
      storageId: prepareData.storageId,
      createdAt: Date.now()
    });
    // Also store by storageId for backward compatibility
    setItem(keyName2, {
      secretKey: Buffer.from(walletKeyPair.secretKey).toString('base64'),
      publicKey: walletPublicKey,
      ephemeralDID,
      storageId: prepareData.storageId,
      createdAt: Date.now()
    });

    // Verify keys were stored correctly
    const verify1 = getItem(keyName1);
    const verify2 = getItem(keyName2);
    console.log('📥 [SecureDashboardBridge] Verification - key1 stored:', !!verify1?.secretKey);
    console.log('📥 [SecureDashboardBridge] Verification - key2 stored:', !!verify2?.secretKey);
    console.log('📥 [SecureDashboardBridge] Wallet keypair stored for later decryption (by ephemeralDID and storageId)');

    // Store document metadata in IndexedDB for "My Documents" page
    const storedDoc: StoredDocument = {
      ephemeralDID,
      originalDocumentDID: documentDID,
      title: title || 'Untitled Document',
      overallClassification: prepareData.documentMetadata?.classification || 'UNCLASSIFIED',
      encryptedContent: new ArrayBuffer(0), // Content fetched on-demand from service endpoint
      encryptionInfo: {
        serverPublicKey: prepareData.ephemeralX25519PublicKey || '',
        nonce: '', // Populated when fetching from service endpoint
        algorithm: 'X25519-XSalsa20-Poly1305'
      },
      serviceEndpoint: prepareData.serviceEndpointUrl,
      isServiceEndpointMode: true, // Content must be fetched from serviceEndpoint
      sectionSummary: {
        totalSections: prepareData.documentMetadata?.sectionSummary?.totalSections || 0,
        visibleCount: prepareData.documentMetadata?.sectionSummary?.visibleCount || 0,
        redactedCount: prepareData.documentMetadata?.sectionSummary?.redactedCount || 0,
        clearanceLevelsUsed: [],
        visibleSections: [],
        redactedSections: []
      },
      sourceInfo: {
        filename: title || 'document',
        format: prepareData.documentMetadata?.format || 'html'
      },
      receivedAt: new Date().toISOString(),
      expiresAt: prepareData.expiresAt,
      viewCount: 0,
      maxViews: -1, // Unlimited views (time-based TTL only)
      status: 'active' as DocumentStatus
    };

    console.log('📥 [SecureDashboardBridge] Document format from server:', prepareData.documentMetadata?.format);
    console.log('📥 [SecureDashboardBridge] Stored format:', storedDoc.sourceInfo.format);

    await storeDocument(storedDoc);
    console.log('📥 [SecureDashboardBridge] Document stored in IndexedDB for My Documents page');

    // Step 3: Complete download - send wallet's public key to server
    console.log('📥 [SecureDashboardBridge] Step 3: Completing download...');
    const completeResponse = await fetch(
      `${serverBaseUrl}/api/employee-portal/documents/complete-download/${prepareData.storageId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId
        },
        body: JSON.stringify({
          x25519PublicKey: walletPublicKey // Wallet's key for encryption
        })
      }
    );

    if (!completeResponse.ok) {
      const errorData = await completeResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Complete download failed: ${completeResponse.status}`);
    }

    const completeData = await completeResponse.json();
    console.log('📥 [SecureDashboardBridge] Document download completed:', {
      ephemeralDID: ephemeralDID?.substring(0, 50) + '...',
      credentialOfferId: completeData.credentialOfferId
    });

    // Send success response back to dashboard
    source.postMessage({
      type: 'SSI_DOCUMENT_DOWNLOAD_RESPONSE',
      requestId,
      success: true,
      ephemeralDID,
      storageId: prepareData.storageId, // Include for document retrieval
      credentialOfferId: completeData.credentialOfferId,
      expiresAt: prepareData.expiresAt,
      message: completeData.message || 'DocumentCopy VC will be delivered via DIDComm',
      timestamp: Date.now()
    }, origin);

    console.log('✅ [SecureDashboardBridge] SSI Document Download completed successfully');

  } catch (error) {
    console.error('❌ [SecureDashboardBridge] SSI Document Download failed:', error);

    source.postMessage({
      type: 'SSI_DOCUMENT_DOWNLOAD_RESPONSE',
      requestId,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during document download',
      timestamp: Date.now()
    }, origin);
  }
}

/**
 * Get stored classified documents
 * @returns Array of document metadata
 */
export function getStoredClassifiedDocuments(): any[] {
  try {
    const indexKey = 'classified-documents-index';
    const indexStr = getItem(indexKey);

    if (!indexStr) {
      return [];
    }

    const index = JSON.parse(indexStr);
    const documents: any[] = [];

    for (const ephemeralDID of index) {
      const storageKey = `classified-document-${ephemeralDID}`;
      const docStr = getItem(storageKey);

      if (docStr) {
        const doc = JSON.parse(docStr);

        // Check if expired
        const now = new Date();
        const expiresAt = new Date(doc.expiresAt);

        if (expiresAt > now) {
          documents.push(doc);
        } else {
          // Document expired - mark as expired but still include
          doc.status = 'expired';
          documents.push(doc);
        }
      }
    }

    return documents;
  } catch (error) {
    console.error('[SecureDashboardBridge] Failed to get stored documents:', error);
    return [];
  }
}

/**
 * Get a single stored classified document by ephemeral DID
 * @param ephemeralDID - The document's ephemeral DID
 * @returns Document data or null if not found
 */
export function getStoredClassifiedDocument(ephemeralDID: string): any | null {
  try {
    const storageKey = `classified-document-${ephemeralDID}`;
    const docStr = getItem(storageKey);

    if (!docStr) {
      return null;
    }

    return JSON.parse(docStr);
  } catch (error) {
    console.error('[SecureDashboardBridge] Failed to get stored document:', error);
    return null;
  }
}

/**
 * Remove an expired or viewed document
 * @param ephemeralDID - The document's ephemeral DID
 */
export function removeStoredDocument(ephemeralDID: string): void {
  try {
    const { removeItem, setItem } = require('./prefixedStorage');

    // Remove document
    const storageKey = `classified-document-${ephemeralDID}`;
    removeItem(storageKey);

    // Update index
    const indexKey = 'classified-documents-index';
    const indexStr = getItem(indexKey);

    if (indexStr) {
      const index = JSON.parse(indexStr);
      const newIndex = index.filter((id: string) => id !== ephemeralDID);
      setItem(indexKey, JSON.stringify(newIndex));
    }

    console.log(`🗑️ [SecureDashboardBridge] Removed document: ${ephemeralDID}`);
  } catch (error) {
    console.error('[SecureDashboardBridge] Failed to remove document:', error);
  }
}

/**
 * Cleanup function to remove postMessage listener
 * Call this when wallet is unmounted/closed
 */
export function cleanupSecureDashboardBridge(): void {
  const handler = (window as any).__secureDashboardMessageHandler;

  if (handler) {
    console.log('🧹 [SecureDashboardBridge] Removing postMessage listener');
    window.removeEventListener('message', handler);
    delete (window as any).__secureDashboardMessageHandler;
  }
}
