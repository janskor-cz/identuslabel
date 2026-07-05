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
 * Decode the payload of a JWT string without verifying its signature.
 * Returns the payload object, or null if the string is not a valid 3-part JWT.
 */
function decodeJWTPayload(jwt: string): Record<string, any> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * Compare two PRISM DIDs by their short-form hash segment only.
 * Handles long-form (did:prism:<hash>:<key-material>) vs short-form (did:prism:<hash>) mismatch.
 */
function prismDIDsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const shortForm = (did: string) =>
    did.startsWith('did:prism:') ? did.split(':').slice(0, 3).join(':') : did;
  return shortForm(a) === shortForm(b);
}

/** Extract a raw JWT string from any credential storage format. */
function extractJWTString(cred: any): string | null {
  if (typeof cred === 'string') {
    if (cred.includes('.')) return cred;
    try {
      const b64Pad = cred.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64Pad + '='.repeat((4 - (b64Pad.length % 4)) % 4);
      const decoded = atob(padded);
      if (decoded.includes('.')) return decoded;
    } catch { /* not base64 */ }
    return null;
  }
  if (cred?.properties && typeof cred.properties.get === 'function') {
    try {
      const jti = cred.properties.get('jti');
      if (typeof jti === 'string' && jti.split('.').length === 3) return jti;
    } catch { /* Map.get failed */ }
    return null;
  }
  if (cred?.jwt && typeof cred.jwt === 'string') return cred.jwt;
  if (cred?.credential && typeof cred.credential === 'string') return cred.credential;
  if (cred?.id && typeof cred.id === 'string') {
    const raw = cred.rawCredential || cred.vcJwt || cred.encodedSignedCredential;
    if (raw && typeof raw === 'string') return raw;
  }
  return null;
}

/**
 * Build a minimal Verifiable Presentation from wallet credentials.
 * Only includes EmployeeRole, SecurityClearance, and SecurityClearanceGrant VCs.
 *
 * Subject consistency: a VP must not mix credentials from different subjects or
 * most servers will reject it with "mixed credential subjects". When the wallet
 * holds both enterprise credentials (EmployeeRole) and personal credentials
 * (SecurityClearance from CA) with different payload.sub values, this function
 * filters to only include VCs that share the same subject as the EmployeeRole VC.
 * Non-enterprise VCs whose subject matches the enterprise DID are still included.
 */
export function buildVP(credentials: any[]): { vp: object; hasCredentials: boolean } {
  // Phase 1: collect all eligible JWT candidates with their decoded sub
  const candidates: { jwt: string; sub: string | null; type: string }[] = [];

  for (const cred of credentials) {
    const type = getCredentialType(cred);
    if (type !== 'EmployeeRole' && type !== 'SecurityClearance' && type !== 'SecurityClearanceGrant') continue;

    const jwtStr = extractJWTString(cred);
    if (!jwtStr) continue;

    const payload = decodeJWTPayload(jwtStr);
    // Prefer credentialSubject.id over payload.sub: when a VC is issued via DIDComm
    // without an explicit subjectId, payload.sub is set to the connection peer DID
    // (did:peer:...) rather than the holder's PRISM DID.  credentialSubject.id is always
    // set to the holder's PRISM DID by the agent.
    const sub = payload?.vc?.credentialSubject?.id || payload?.sub || null;
    candidates.push({ jwt: jwtStr, sub, type });
  }

  // Phase 2: pick the canonical subject from the EmployeeRole VC (required for enterprise access)
  const employeeRoleCandidate = candidates.find(c => c.type === 'EmployeeRole');
  const canonicalSub = employeeRoleCandidate?.sub ?? null;

  // Phase 3: filter to credentials that share the canonical subject (PRISM DID-normalised)
  const jwtStrings = candidates
    .filter(c => !canonicalSub || !c.sub || prismDIDsMatch(c.sub, canonicalSub))
    .map(c => c.jwt);

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
 * The server applies clearance-based redaction and returns the document
 * (HTML or DOCX) re-encrypted with the wallet's ephemeral X25519 key.
 *
 * @param opts.challengeUrl  Full URL of the challenge endpoint from the DID's
 *   "document-access-gate" service.  When omitted the COMPANY_ADMIN_BASE
 *   constant is used as a fallback.
 */
export async function requestDocumentAccess(
  documentDID: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair,
  opts?: { challengeUrl?: string }
): Promise<AccessGateResponse> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error(
      'No EmployeeRole or SecurityClearance credentials found in wallet. ' +
      'Please ensure your credentials are loaded.'
    );
  }

  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

  // Derive base URL: strip the trailing /challenge path segment if the caller
  // passed the full challenge URL from the DID document service endpoint.
  const accessGateBase = opts?.challengeUrl
    ? opts.challengeUrl.replace(/\/challenge(\?.*)?$/, '')
    : `${COMPANY_ADMIN_BASE}/api/access-gate`;

  // Step 1: Obtain a one-time challenge
  const challengeRes = await fetch(
    `${accessGateBase}/challenge?documentDID=${encodeURIComponent(documentDID)}`
  );
  const challengeJson = await challengeRes.json();
  if (!challengeRes.ok || !challengeJson.success) {
    throw new Error(challengeJson.message || challengeJson.error || 'Failed to obtain access challenge');
  }
  const challenge: string = challengeJson.challenge;

  // Step 2: Present VP + ephemeral key to receive encrypted document
  const res = await fetch(`${accessGateBase}/present`, {
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

// ---------------------------------------------------------------------------
// SSI-aligned VP-gated access via identus-document-service
// ---------------------------------------------------------------------------

/**
 * Response shape from POST /access (document service, SSI-aligned).
 * Server never decrypts the file — returns encrypted DEK + raw encrypted blob.
 * Wallet decrypts: DEK via nacl.box.open, file via WebCrypto AES-GCM.
 */
export interface VPGatedAccessResponse {
  success: true;
  copyId: string;
  copyHash: string;
  filename: string;
  mimeType: string;
  clearanceLevel: string;
  accessedAt: string;
  /** nacl.box of the 32-byte DEK */
  encryptedDEK: {
    ciphertext:      string; // base64
    nonce:           string; // base64
    senderPublicKey: string; // base64 server ephemeral X25519
  };
  /** Raw AES-256-GCM encrypted file bytes from Iagon (base64) */
  encryptedBlob:  string;
  fileIv:         string; // base64
  fileAuthTag:    string; // base64
  fileAlgorithm:  string; // 'AES-256-GCM'
  /** sha256 of plaintext — wallet verifies after decryption */
  contentHash:    string | null;
}

/**
 * Extract a stable employee identifier from wallet credentials.
 * Preference order: email (EmployeeRole) → prismDid → employeeId.
 */
function extractEmployeeIdentifier(credentials: any[]): string {
  for (const cred of credentials) {
    const type    = getCredentialType(cred);
    const subject = getCredentialSubject(cred);
    if (type === 'EmployeeRole') {
      if (subject?.email)      return subject.email;
      if (subject?.prismDid)   return subject.prismDid;
      if (subject?.employeeId) return subject.employeeId;
    }
  }
  // Fallback: SecurityClearance holder
  for (const cred of credentials) {
    const subject = getCredentialSubject(cred);
    if (subject?.prismDid)   return subject.prismDid;
    if (subject?.email)      return subject.email;
  }
  throw new Error('Cannot determine employee identifier from wallet credentials — no EmployeeRole credential found');
}

/**
 * Request document access via DIDComm present-proof (preferred over direct HTTP VP).
 *
 * Three-step flow:
 *   1. POST /api/document-access/initiate  → server sends DIDComm RequestPresentation to wallet
 *      The wallet's UnifiedProofRequestModal will appear for the user to approve.
 *   2. Poll GET /api/document-access/status/:sessionId until status === 'authorized'
 *   3. POST /api/document-access/complete  → server verifies VP (holder-bound) and returns doc
 *
 * Security advantages over direct HTTP VP submission:
 *   - Holder binding: VP is signed by the wallet's DID key (cryptographic proof of ownership)
 *   - Channel binding: VP is tied to the existing DIDComm connection (not just a challenge nonce)
 *   - No credential exfiltration: VC JWTs never leave the DIDComm channel unencrypted
 */
export async function requestDocumentAccessDIDComm(
  documentDID: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair,
  opts?: { baseUrl?: string; timeoutMs?: number; employeeIdentifier?: string }
): Promise<AccessGateResponse> {
  const base             = opts?.baseUrl ?? COMPANY_ADMIN_BASE;
  const timeoutMs        = opts?.timeoutMs ?? 3 * 60 * 1000;   // 3 min default
  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');
  // Use caller-supplied identifier (from enterpriseDIDs / storedDID / auto-detect)
  // before falling back to credential-subject extraction, which fails for
  // SecurityClearance VCs that don't embed email/prismDid in their subject.
  const employeeIdentifier = opts?.employeeIdentifier ?? extractEmployeeIdentifier(credentials);

  // Step 1: Initiate — server creates DIDComm proof request; wallet will receive it shortly
  const initRes = await fetch(`${base}/api/document-access/initiate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ documentDID, employeeIdentifier, ephemeralPublicKey })
  });
  const initJson = await initRes.json() as any;
  if (!initRes.ok || !initJson.success) {
    throw new Error(initJson.message || initJson.error || 'Failed to initiate DIDComm document access');
  }
  const { sessionId } = initJson;

  // Step 2: Poll until authorized (user approves DIDComm proof request in modal)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes  = await fetch(`${base}/api/document-access/status/${sessionId}`);
    const statusJson = await statusRes.json() as any;
    if (statusJson.status === 'authorized') break;
    if (statusJson.status === 'rejected' || statusJson.status === 'failed') {
      throw new Error(`Document access denied: ${statusJson.status}`);
    }
  }

  // Step 3: Complete — server verifies VP and returns encrypted document
  const completeRes = await fetch(`${base}/api/document-access/complete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sessionId })
  });
  const completeJson = await completeRes.json() as any;
  if (!completeRes.ok || !completeJson.success) {
    throw new Error(completeJson.message || completeJson.error || 'Document access complete step failed');
  }
  return completeJson as AccessGateResponse;
}

/**
 * Helper: base64 string → Uint8Array.
 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Request VP-gated document access from the identus-document-service.
 *
 * SSI-aligned flow:
 *   1. Wallet sends VP + ephemeral X25519 public key to POST /access
 *   2. Server verifies VP, unwraps DEK (CMK), nacl.box(DEK, clientPubKey)
 *   3. Server downloads raw encrypted blob from Iagon (no decryption)
 *   4. Wallet decrypts DEK via nacl.box.open → rawDEK
 *   5. Wallet decrypts file via WebCrypto AES-GCM → plaintext
 *   6. Wallet verifies content hash
 *
 * @param documentDID  - full PRISM DID of the document
 * @param accessUrl    - document service access endpoint (from DID's DocumentAccessGate service)
 * @param credentials  - wallet credentials array (EmployeeRole + SecurityClearance VCs)
 * @param keyPair      - ephemeral nacl.box keypair (caller generates per request)
 * @returns decrypted file as Uint8Array
 */
export async function requestVPGatedAccess(
  documentDID: string,
  accessUrl: string,
  credentials: any[],
  keyPair: nacl.BoxKeyPair
): Promise<{ plaintext: Uint8Array; filename: string; mimeType: string; copyId: string; clearanceLevel: string }> {
  const { vp, hasCredentials } = buildVP(credentials);

  if (!hasCredentials) {
    throw new Error(
      'No EmployeeRole or SecurityClearance credentials found in wallet. ' +
      'Please ensure your credentials are loaded.'
    );
  }

  const ephemeralPublicKey = Buffer.from(keyPair.publicKey).toString('base64');

  // Step 1: Send VP + ephemeral public key to document service
  const res = await fetch(accessUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentDID, vp, ephemeralPublicKey })
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(json.message || json.error || 'VP-gated access denied');
  }

  const data = json as VPGatedAccessResponse;

  // Step 2: Decrypt DEK — nacl.box.open with server's ephemeral public key
  const dek = nacl.box.open(
    b64ToBytes(data.encryptedDEK.ciphertext),
    b64ToBytes(data.encryptedDEK.nonce),
    b64ToBytes(data.encryptedDEK.senderPublicKey),
    keyPair.secretKey
  );
  if (!dek) {
    throw new Error('DEK decryption failed — nacl.box.open returned null');
  }

  // Step 3: Decrypt file — WebCrypto AES-256-GCM
  // WebCrypto AES-GCM expects ciphertext || authTag concatenated
  const encryptedBytes = b64ToBytes(data.encryptedBlob);
  const fileAuthTagBytes = b64ToBytes(data.fileAuthTag);
  const combined = new Uint8Array(encryptedBytes.length + fileAuthTagBytes.length);
  combined.set(encryptedBytes);
  combined.set(fileAuthTagBytes, encryptedBytes.length);

  const dekCryptoKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['decrypt']);
  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(data.fileIv) },
      dekCryptoKey,
      combined
    );
  } finally {
    // Zero DEK from memory (TypedArray — fill with zeros)
    (dek as Uint8Array).fill(0);
  }

  const plaintext = new Uint8Array(plaintextBuf);

  // Step 4: Verify content hash (sha256 of decrypted plaintext)
  if (data.contentHash) {
    const hashBuf = await crypto.subtle.digest('SHA-256', plaintext);
    const actualHash = 'sha256:' + Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (actualHash !== data.contentHash) {
      throw new Error(`CONTENT_INTEGRITY_FAILED: expected ${data.contentHash}, got ${actualHash}`);
    }
  }

  return {
    plaintext,
    filename:       data.filename,
    mimeType:       data.mimeType,
    copyId:         data.copyId,
    clearanceLevel: data.clearanceLevel
  };
}

// ---------------------------------------------------------------------------
// Manifest VC version history + chain verification
// ---------------------------------------------------------------------------

export interface ManifestVCEntry {
  vcId: string;
  vcJwt?: string;       // present on current; may be present on history entries
  issuedAt: string;
  documentDID?: string;
  claims?: {
    versionNumber?: number;
    updatedBy?: string;
    predecessorHash?: string;
    classificationLevel?: string;
    iagonFileId?: string;
  };
}

export interface ManifestHistoryResponse {
  documentDID: string;
  current: ManifestVCEntry;
  history: ManifestVCEntry[]; // newest-first (history[0] = immediate predecessor)
}

export interface ChainVerificationResult {
  valid: boolean;
  /** Index into history[] where the chain breaks, if any (0 = current→history[0]) */
  brokenAt?: number;
  reason?: string;
}

/**
 * Compute SHA-256 of a string and return 'sha256:<hex>'.
 * Uses WebCrypto (available in browser and Node.js ≥ 15).
 */
async function computeSha256Prefix(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'sha256:' + hex;
}

/**
 * Fetch the KeyManifest VC version history for a document from the company-admin proxy.
 * Requires an active employee session (cookie-based auth).
 *
 * @param documentDID  Full PRISM DID of the document
 */
export async function fetchManifestHistory(documentDID: string): Promise<ManifestHistoryResponse> {
  const res = await fetch(
    `${COMPANY_ADMIN_BASE}/api/documents/${encodeURIComponent(documentDID)}/vc-history`,
    { credentials: 'include' }
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message || json.error || 'Failed to fetch manifest history');
  }
  return json as ManifestHistoryResponse;
}

/**
 * Verify the predecessor hash chain in a ManifestHistoryResponse.
 *
 * Verification:
 *   For each adjacent pair (newer, older) where newer.claims.predecessorHash is set:
 *     sha256(older.vcJwt) must equal newer.claims.predecessorHash
 *
 * Returns { valid: true } if the chain is intact (or there is only one version).
 * Returns { valid: false, brokenAt, reason } if a link is broken.
 *
 * Note: entries without vcJwt cannot be verified — those links are skipped.
 *
 * @param data  ManifestHistoryResponse from fetchManifestHistory
 */
export async function verifyManifestChain(data: ManifestHistoryResponse): Promise<ChainVerificationResult> {
  if (!data.current) {
    return { valid: false, reason: 'No current VC in history response' };
  }

  // Build ordered array: [current, history[0], history[1], ...]
  const chain: ManifestVCEntry[] = [data.current, ...data.history];

  // Verify each link: chain[i].predecessorHash === sha256(chain[i+1].vcJwt)
  for (let i = 0; i < chain.length - 1; i++) {
    const newer = chain[i];
    const older = chain[i + 1];

    const claimedHash = newer.claims?.predecessorHash;
    if (!claimedHash) {
      // No predecessorHash claim — this link is unverifiable, skip
      continue;
    }
    if (!older.vcJwt) {
      // Cannot verify without vcJwt
      continue;
    }

    const actualHash = await computeSha256Prefix(older.vcJwt);
    if (actualHash !== claimedHash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Chain broken at position ${i}: expected ${claimedHash.slice(0, 20)}… got ${actualHash.slice(0, 20)}…`
      };
    }
  }

  return { valid: true };
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
