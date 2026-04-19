/**
 * KeyAuthorityClient.ts
 *
 * Contacts the company-admin Key Authority endpoint to obtain per-section
 * AES-256-GCM keys wrapped with the wallet's ephemeral X25519 public key.
 *
 * Flow:
 *  1. Caller generates an ephemeral X25519 keypair (nacl.box.keyPair())
 *  2. Caller finds EmployeeRole + SecurityClearance VCs in wallet state
 *  3. This module POSTs a VP + ephemeralPublicKey to the KA endpoint
 *  4. Server verifies VP, returns wrapped section keys + encrypted sections
 *  5. Caller decrypts sections using the ephemeral secret key (see sectionDecryptor.ts)
 */

import nacl from 'tweetnacl';
import { getCredentialType, getCredentialSubject } from '@/utils/credentialTypeDetector';

const COMPANY_ADMIN_BASE = 'https://identuslabel.cz/company-admin';

export interface WrappedSectionKey {
  sectionId: string;
  clearance: string;
  accessible: true;
  wrappedKey: string;              // base64 NaCl-boxed AES key
  nonce: string;                   // base64 NaCl box nonce
  serverEphemeralPublicKey: string; // base64 server's one-time X25519 public key
}

export interface RedactedSectionKey {
  sectionId: string;
  clearance: string;
  accessible: false;
}

export type SectionKeyEntry = WrappedSectionKey | RedactedSectionKey;

export interface EncryptedSection {
  sectionId: string;
  clearance: string;
  clearanceLevel: number;
  ciphertext: string;  // base64
  iv: string;          // base64
  authTag: string;     // base64
  title?: string;
  tagName?: string;
  isInline?: boolean;
}

export interface KAResponse {
  success: true;
  sourceFormat: 'html' | 'docx';
  useServerRedaction?: boolean;
  clearanceLevel?: string;
  encryptedSections?: EncryptedSection[];
  sectionKeys?: SectionKeyEntry[];
  documentMetadata: {
    title: string;
    overallClassification: string;
  };
}

/**
 * Build a minimal Verifiable Presentation from wallet credentials.
 * Includes EmployeeRole and SecurityClearance VCs (as raw JWT strings).
 */
function buildVP(credentials: any[]): { vp: object; hasCredentials: boolean } {
  const jwtStrings: string[] = [];

  for (const cred of credentials) {
    const type = getCredentialType(cred);
    if (type !== 'EmployeeRole' && type !== 'SecurityClearance') continue;

    // Credentials may be stored as raw JWT string, base64-encoded JWT, or object with .jwt / .credential field
    let jwtStr: string | null = null;
    if (typeof cred === 'string') {
      if (cred.includes('.')) {
        // Already a raw JWT (header.payload.signature)
        jwtStr = cred;
      } else {
        // Try base64-decoding to get the raw JWT
        try {
          const b64Pad = cred.replace(/-/g, '+').replace(/_/g, '/');
          const padded = b64Pad + '='.repeat((4 - (b64Pad.length % 4)) % 4);
          const decoded = atob(padded);
          if (decoded.includes('.')) jwtStr = decoded;
        } catch { /* not base64 */ }
      }
    } else if (cred?.properties && typeof cred.properties.get === 'function') {
      // SDK JWTCredential (Map-based) — raw JWS is stored under 'jti' key
      try {
        const jti = cred.properties.get('jti');
        if (typeof jti === 'string' && jti.split('.').length === 3) {
          jwtStr = jti;
        }
      } catch { /* Map.get failed */ }
    } else if (cred?.jwt && typeof cred.jwt === 'string') {
      jwtStr = cred.jwt;
    } else if (cred?.credential && typeof cred.credential === 'string') {
      jwtStr = cred.credential;
    } else if (cred?.id && typeof cred.id === 'string') {
      // Packed credential object — try to extract the raw JWT from common fields
      const raw = cred.rawCredential || cred.vcJwt || cred.encodedSignedCredential;
      if (raw && typeof raw === 'string') jwtStr = raw;
    }

    if (jwtStr) jwtStrings.push(jwtStr);
  }

  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    verifiableCredential: jwtStrings
  };

  return { vp, hasCredentials: jwtStrings.length > 0 };
}

export interface DocxKAResponse {
  success: true;
  sourceFormat: 'docx';
  clearanceLevel: string;
  encryptedDocument: {
    ciphertext: string;      // base64
    nonce: string;           // base64
    serverPublicKey: string; // base64
  };
  filename: string;
  mimeType: string;
  documentMetadata: {
    title: string;
    overallClassification: string;
  };
}

/**
 * Request section keys from the Key Authority (HTML documents).
 */
export async function requestSectionKeys(
  documentDID: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair
): Promise<KAResponse> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error(
      'No EmployeeRole or SecurityClearance credentials found in wallet. ' +
      'Please ensure your credentials are loaded.'
    );
  }

  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

  const res = await fetch(`${COMPANY_ADMIN_BASE}/api/documents/issue-section-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentDID, vp, ephemeralPublicKey })
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(json.message || json.error || 'Key Authority request failed');
  }

  return json as KAResponse;
}

/**
 * Request a redacted DOCX from the Key Authority (DOCX documents).
 * Server applies clearance-level redaction and returns the file
 * encrypted with the wallet's ephemeral X25519 key.
 */
export async function requestDocxAccess(
  documentDID: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair
): Promise<DocxKAResponse> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error(
      'No EmployeeRole or SecurityClearance credentials found in wallet. ' +
      'Please ensure your credentials are loaded.'
    );
  }

  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

  const res = await fetch(`${COMPANY_ADMIN_BASE}/api/documents/issue-docx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentDID, vp, ephemeralPublicKey })
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(json.message || json.error || 'DOCX Key Authority request failed');
  }

  return json as DocxKAResponse;
}

export interface AccessGateResponse {
  success: true;
  granted: true;
  documentDID: string;
  copyId: string;
  ephemeralDID: string;
  clearanceLevel: string;
  documentMetadata: {
    title: string;
    overallClassification: string;
  };
  encryptedDocument: {
    ciphertext: string;
    nonce: string;
    serverPublicKey: string;
    filename: string;
    mimeType: string;
    classificationLevel: string;
  };
}

/**
 * Request document access via the two-step challenge → VP presentation flow.
 * Replaces the legacy issue-section-keys / issue-docx endpoints.
 * The server applies clearance-based redaction and returns the document
 * (HTML or DOCX) re-encrypted with the wallet's ephemeral X25519 key.
 */
export async function requestDocumentAccess(
  documentDID: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair
): Promise<AccessGateResponse> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error(
      'No EmployeeRole or SecurityClearance credentials found in wallet. ' +
      'Please ensure your credentials are loaded.'
    );
  }

  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

  // Step 1: Obtain a one-time challenge
  const challengeRes = await fetch(
    `${COMPANY_ADMIN_BASE}/api/access-gate/challenge?documentDID=${encodeURIComponent(documentDID)}`
  );
  const challengeJson = await challengeRes.json();
  if (!challengeRes.ok || !challengeJson.success) {
    throw new Error(challengeJson.message || challengeJson.error || 'Failed to obtain access challenge');
  }
  const challenge: string = challengeJson.challenge;

  // Step 2: Present VP + ephemeral key to receive encrypted document
  const res = await fetch(`${COMPANY_ADMIN_BASE}/api/access-gate/present`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentDID, vp, challenge, ephemeralPublicKey })
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(json.message || json.error || 'Document access request failed');
  }

  return json as AccessGateResponse;
}

/**
 * Request an editable copy of a DOCX document for versioned editing.
 * Server redacts to the user's clearance level, returns the file
 * encrypted with the wallet's ephemeral X25519 key, plus a signed editToken.
 */
export async function requestEditAccess(
  documentDID: string,
  credentials: any[]
): Promise<{ editToken: string; expiresIn: number }> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error('No EmployeeRole or SecurityClearance credentials found in wallet.');
  }

  // Step 1: Obtain a one-time challenge from the server
  const challengeRes = await fetch(
    `${COMPANY_ADMIN_BASE}/api/access-gate/challenge?documentDID=${encodeURIComponent(documentDID)}`
  );
  const challengeJson = await challengeRes.json();
  if (!challengeRes.ok || !challengeJson.success) {
    throw new Error(challengeJson.message || challengeJson.error || 'Failed to obtain challenge');
  }
  const challenge: string = challengeJson.challenge;

  // Step 2: Request edit token with the challenge
  const res = await fetch(`${COMPANY_ADMIN_BASE}/api/document-update/request-edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentDID, vp, challenge })
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(json.message || json.error || 'Edit access request failed');
  }

  return json;
}
