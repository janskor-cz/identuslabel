/**
 * Ephemeral DID Crypto Utility
 *
 * Implements ephemeral X25519 keypair generation and destruction for Perfect Forward Secrecy (PFS)
 * in the Ephemeral Document Access Control system.
 *
 * Key Features:
 * - Generate ephemeral X25519 keypairs for single-use document access
 * - Sign access requests with Ed25519 for non-repudiation
 * - Decrypt document content with immediate key destruction (PFS)
 * - Memory-safe key handling to prevent key material leakage
 *
 * Security Model:
 * - Each document access generates a fresh X25519 keypair
 * - Private key is destroyed immediately after decryption
 * - Server never sees the ephemeral private key
 * - Even if server is compromised later, past sessions remain secure
 *
 * @version 1.0.0
 * @date 2025-12-07
 */

import * as nacl from 'tweetnacl';
import { base64url } from 'jose';

/**
 * Ephemeral X25519 keypair for document access
 */
export interface EphemeralKeyPair {
  /** X25519 public key (32 bytes, base64url encoded) */
  publicKey: string;

  /** X25519 private key (32 bytes) - destroyed after use */
  secretKey: Uint8Array;

  /** Unique ephemeral DID identifier */
  ephemeralDID: string;

  /** Creation timestamp for replay prevention */
  createdAt: number;

  /** Flag indicating if key has been destroyed */
  destroyed: boolean;
}

/**
 * Access request signature payload
 */
export interface AccessRequestPayload {
  /** Document ID being accessed */
  documentId: string;

  /** Ephemeral DID for this request */
  ephemeralDID: string;

  /** Request timestamp (milliseconds) */
  timestamp: number;

  /** Random nonce for replay prevention */
  nonce: string;

  /** Requestor's PRISM DID */
  requestorDID: string;
}

/**
 * Encrypted document response from server
 */
export interface EncryptedDocumentResponse {
  /** Encrypted document content (base64url encoded) */
  ciphertext: string;

  /** XSalsa20-Poly1305 nonce (24 bytes, base64url encoded) */
  nonce: string;

  /** Server's ephemeral X25519 public key (base64url encoded) */
  serverPublicKey: string;

  /** Unique copy ID for this access */
  copyId: string;
}

/**
 * Decryption result with Perfect Forward Secrecy guarantee
 */
export interface DecryptionResult {
  /** Decrypted document content */
  plaintext: Uint8Array;

  /** Copy ID for accountability tracking */
  copyId: string;

  /** Confirmation that ephemeral key was destroyed */
  keyDestroyed: boolean;
}

/**
 * Generate an ephemeral X25519 keypair for document access
 *
 * Creates a fresh keypair with a unique ephemeral DID identifier.
 * The private key should be destroyed immediately after decryption.
 *
 * @returns EphemeralKeyPair with public key, secret key, and ephemeral DID
 *
 * @example
 * const keyPair = generateEphemeralKeyPair();
 * console.log('Ephemeral DID:', keyPair.ephemeralDID);
 * console.log('Public Key:', keyPair.publicKey);
 * // Use for access request, then destroy after decryption
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  console.log('[EphemeralDIDCrypto] Generating ephemeral X25519 keypair...');

  // Generate X25519 keypair using NaCl box
  const keyPair = nacl.box.keyPair();

  // Create unique ephemeral DID identifier
  // Format: did:ephemeral:<random-hex>
  const randomId = Array.from(nacl.randomBytes(16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const ephemeralDID = `did:ephemeral:${randomId}`;

  const result: EphemeralKeyPair = {
    publicKey: base64url.encode(keyPair.publicKey),
    secretKey: keyPair.secretKey,
    ephemeralDID: ephemeralDID,
    createdAt: Date.now(),
    destroyed: false
  };

  console.log('[EphemeralDIDCrypto] Ephemeral keypair generated:', {
    ephemeralDID: ephemeralDID,
    publicKeyLength: keyPair.publicKey.length,
    createdAt: new Date(result.createdAt).toISOString()
  });

  return result;
}

/**
 * Generate a random nonce for replay attack prevention
 *
 * @returns 32-character hex string nonce
 */
export function generateNonce(): string {
  const randomBytes = nacl.randomBytes(16);
  return Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign an access request payload with Ed25519 for non-repudiation
 *
 * The signature proves:
 * 1. The requestor controls the private key for their PRISM DID
 * 2. The request was made at a specific time
 * 3. The nonce prevents replay attacks
 *
 * @param payload - Access request payload to sign
 * @param ed25519PrivateKey - Requestor's Ed25519 private key (64 bytes)
 * @returns Base64url encoded Ed25519 signature
 *
 * @example
 * const payload: AccessRequestPayload = {
 *   documentId: 'doc-123',
 *   ephemeralDID: 'did:ephemeral:abc123',
 *   timestamp: Date.now(),
 *   nonce: generateNonce(),
 *   requestorDID: 'did:prism:xyz789'
 * };
 * const signature = signAccessRequest(payload, myEd25519PrivateKey);
 */
export function signAccessRequest(
  payload: AccessRequestPayload,
  ed25519PrivateKey: Uint8Array
): string {
  console.log('[EphemeralDIDCrypto] Signing access request...', {
    documentId: payload.documentId,
    ephemeralDID: payload.ephemeralDID,
    timestamp: payload.timestamp
  });

  // Validate Ed25519 private key length (64 bytes for NaCl format)
  if (ed25519PrivateKey.length !== 64) {
    throw new Error(`[EphemeralDIDCrypto] Invalid Ed25519 private key length: ${ed25519PrivateKey.length} (expected 64)`);
  }

  // Serialize payload to canonical JSON
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    documentId: payload.documentId,
    ephemeralDID: payload.ephemeralDID,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    requestorDID: payload.requestorDID
  }));

  // Sign with Ed25519
  const signature = nacl.sign.detached(payloadBytes, ed25519PrivateKey);

  console.log('[EphemeralDIDCrypto] Access request signed:', {
    signatureLength: signature.length,
    payloadSize: payloadBytes.length
  });

  return base64url.encode(signature);
}

/**
 * Decrypt document content and DESTROY the ephemeral key (Perfect Forward Secrecy)
 *
 * This is the critical PFS operation:
 * 1. Perform X25519 key exchange with server's ephemeral public key
 * 2. Decrypt the document using XSalsa20-Poly1305
 * 3. Securely destroy the ephemeral private key
 * 4. Return decrypted content with confirmation of key destruction
 *
 * IMPORTANT: After this function returns, the ephemeral private key no longer exists.
 * Even if an attacker compromises the system later, they cannot decrypt this session.
 *
 * @param encryptedResponse - Server's encrypted document response
 * @param ephemeralKeyPair - Our ephemeral X25519 keypair (will be destroyed)
 * @returns DecryptionResult with plaintext and key destruction confirmation
 * @throws Error if decryption fails or key already destroyed
 *
 * @example
 * const keyPair = generateEphemeralKeyPair();
 * // ... send access request to server ...
 * const result = decryptAndDestroy(serverResponse, keyPair);
 * console.log('Decrypted:', result.plaintext.length, 'bytes');
 * console.log('Key destroyed:', result.keyDestroyed); // Always true
 */
export function decryptAndDestroy(
  encryptedResponse: EncryptedDocumentResponse,
  ephemeralKeyPair: EphemeralKeyPair
): DecryptionResult {
  console.log('[EphemeralDIDCrypto] Decrypting document with PFS...');

  // SECURITY CHECK: Ensure key hasn't already been used
  if (ephemeralKeyPair.destroyed) {
    throw new Error('[EphemeralDIDCrypto] SECURITY ERROR: Ephemeral key already destroyed - cannot reuse');
  }

  try {
    // Decode server's public key and encrypted data
    const serverPublicKey = base64url.decode(encryptedResponse.serverPublicKey);
    const ciphertext = base64url.decode(encryptedResponse.ciphertext);
    const nonce = base64url.decode(encryptedResponse.nonce);

    // Validate key lengths
    if (serverPublicKey.length !== 32) {
      throw new Error(`[EphemeralDIDCrypto] Invalid server public key length: ${serverPublicKey.length}`);
    }
    if (nonce.length !== 24) {
      throw new Error(`[EphemeralDIDCrypto] Invalid nonce length: ${nonce.length}`);
    }

    console.log('[EphemeralDIDCrypto] Decryption parameters:', {
      ciphertextLength: ciphertext.length,
      nonceLength: nonce.length,
      serverKeyLength: serverPublicKey.length
    });

    // Perform X25519+XSalsa20-Poly1305 decryption
    const plaintext = nacl.box.open(
      ciphertext,
      nonce,
      serverPublicKey,
      ephemeralKeyPair.secretKey
    );

    if (!plaintext) {
      throw new Error('[EphemeralDIDCrypto] Decryption failed - authentication tag mismatch');
    }

    console.log('[EphemeralDIDCrypto] Decryption successful:', {
      plaintextLength: plaintext.length,
      copyId: encryptedResponse.copyId
    });

    return {
      plaintext: plaintext,
      copyId: encryptedResponse.copyId,
      keyDestroyed: true  // Key will be destroyed in finally block
    };

  } finally {
    // CRITICAL: Always destroy the ephemeral private key
    destroyKey(ephemeralKeyPair);
  }
}

/**
 * Securely destroy an ephemeral keypair
 *
 * Overwrites the private key memory with zeros to prevent recovery.
 * Marks the keypair as destroyed to prevent reuse.
 *
 * @param keyPair - Ephemeral keypair to destroy
 */
export function destroyKey(keyPair: EphemeralKeyPair): void {
  if (keyPair.destroyed) {
    console.log('[EphemeralDIDCrypto] Key already destroyed, skipping');
    return;
  }

  console.log('[EphemeralDIDCrypto] DESTROYING ephemeral key:', keyPair.ephemeralDID);

  // Overwrite private key with zeros
  for (let i = 0; i < keyPair.secretKey.length; i++) {
    keyPair.secretKey[i] = 0;
  }

  // Mark as destroyed
  keyPair.destroyed = true;

  console.log('[EphemeralDIDCrypto] Ephemeral key destroyed - PFS guaranteed');
}

/**
 * Build a complete access request for the server
 *
 * Convenience function that generates all required fields for an access request.
 *
 * @param documentId - Document to access
 * @param requestorDID - Requestor's PRISM DID
 * @param issuerDID - DID of the entity that issued requestor's credential
 * @param clearanceLevel - Requestor's clearance level (1-4)
 * @param ed25519PrivateKey - Requestor's Ed25519 signing key
 * @returns Complete access request ready for submission
 *
 * @example
 * const request = buildAccessRequest(
 *   'doc-123',
 *   'did:prism:myDID',
 *   'did:prism:issuerDID',
 *   3, // SECRET clearance
 *   myEd25519PrivateKey
 * );
 * const response = await fetch('/api/ephemeral-documents/doc-123/access', {
 *   method: 'POST',
 *   body: JSON.stringify(request)
 * });
 */
export function buildAccessRequest(
  documentId: string,
  requestorDID: string,
  issuerDID: string,
  clearanceLevel: number,
  ed25519PrivateKey: Uint8Array
): {
  ephemeralKeyPair: EphemeralKeyPair;
  requestPayload: {
    requestorDID: string;
    issuerDID: string;
    clearanceLevel: number;
    ephemeralDID: string;
    ephemeralPublicKey: string;
    signature: string;
    timestamp: number;
    nonce: string;
  };
} {
  console.log('[EphemeralDIDCrypto] Building access request for document:', documentId);

  // Generate ephemeral keypair for this request
  const ephemeralKeyPair = generateEphemeralKeyPair();

  // Generate timestamp and nonce
  const timestamp = Date.now();
  const nonce = generateNonce();

  // Create and sign the access request payload
  const payload: AccessRequestPayload = {
    documentId,
    ephemeralDID: ephemeralKeyPair.ephemeralDID,
    timestamp,
    nonce,
    requestorDID
  };

  const signature = signAccessRequest(payload, ed25519PrivateKey);

  return {
    ephemeralKeyPair,
    requestPayload: {
      requestorDID,
      issuerDID,
      clearanceLevel,
      ephemeralDID: ephemeralKeyPair.ephemeralDID,
      ephemeralPublicKey: ephemeralKeyPair.publicKey,
      signature,
      timestamp,
      nonce
    }
  };
}

/**
 * Verify an Ed25519 signature (for testing/validation purposes)
 *
 * @param payload - Original payload that was signed
 * @param signature - Base64url encoded signature
 * @param ed25519PublicKey - Signer's Ed25519 public key (32 bytes)
 * @returns true if signature is valid
 */
export function verifySignature(
  payload: AccessRequestPayload,
  signature: string,
  ed25519PublicKey: Uint8Array
): boolean {
  try {
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      documentId: payload.documentId,
      ephemeralDID: payload.ephemeralDID,
      timestamp: payload.timestamp,
      nonce: payload.nonce,
      requestorDID: payload.requestorDID
    }));

    const signatureBytes = base64url.decode(signature);

    return nacl.sign.detached.verify(payloadBytes, signatureBytes, ed25519PublicKey);
  } catch (error) {
    console.error('[EphemeralDIDCrypto] Signature verification error:', error);
    return false;
  }
}

/**
 * Get classification level label from number
 *
 * @param level - Classification level (1-4)
 * @returns Human-readable classification label
 */
export function getClassificationLabel(level: number): string {
  const labels: { [key: number]: string } = {
    1: 'UNCLASSIFIED',
    2: 'CONFIDENTIAL',
    3: 'SECRET',
    4: 'TOP_SECRET'
  };
  return labels[level] || 'UNKNOWN';
}

/**
 * Get classification level number from label
 *
 * @param label - Classification label string
 * @returns Numeric classification level (1-4)
 */
export function getClassificationLevel(label: string): number {
  const levels: { [key: string]: number } = {
    'UNCLASSIFIED': 1,
    'CONFIDENTIAL': 2,
    'SECRET': 3,
    'TOP_SECRET': 4
  };
  return levels[label.toUpperCase()] || 1;
}
