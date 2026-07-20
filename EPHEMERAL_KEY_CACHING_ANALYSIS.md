# Document Access Flow & Ephemeral Key Caching Analysis

## Overview
When a user opens a document in the wallet, the system uses ephemeral X25519 keypairs for perfect forward secrecy (PFS). The ephemeral **private key** is cached in **localStorage** to enable subsequent access without requiring a fresh verification presentation.

---

## 1. EPHEMERAL KEY CACHING LOCATIONS

### Storage Location: localStorage (Browser-based)
**File**: `/opt/project_identuslabel/idl-wallet/src/utils/prefixedStorage.ts` (lines 1-50)

```
Prefix pattern: wallet-idl-
Key pattern: wallet-idl-ephemeral-key-{ephemeralDID}
or: wallet-idl-ephemeral-key-{storageId}
```

**Metadata stored with key:**
```javascript
{
  secretKey: string,           // Base64-encoded X25519 private key
  publicKey: string,           // Base64-encoded X25519 public key
  ephemeralDID: string,        // The ephemeral DID identifier
  storageId: string,           // Alternative lookup key
  createdAt: number            // Timestamp (ms since epoch)
}
```

### Where Keys Are Stored

1. **SecureDashboardBridge.ts** (lines 930-962)
   - Called during SSI document download flow
   - Stores keys via `setItem()` for later decryption
   - TWO entries per ephemeralDID: by `ephemeralDID` AND by `storageId` for backward compatibility

2. **DocumentDIDAccess.tsx** (lines 658)
   - Stores ephemeral key after direct DID access
   - Pattern: `setItem(\`ephemeral-key-${did}\`, { secretKey: secretKeyB64, ephemeralDID: did })`

3. **ClassifiedDocumentViewer.tsx** (lines 360-395)
   - **READS** cached ephemeral keys during document decryption
   - Two lookup patterns:
     - Direct key lookup: `ephemeral-key-${ephemeralDID}`
     - Pattern matching: All keys matching `ephemeral-key-*` are searched for matching ephemeralDID

---

## 2. ACCESS GATE CHALLENGE ENDPOINT REQUEST/RESPONSE FORMAT

### Challenge Request
**Endpoint**: `GET /api/access-gate/challenge?documentDID=...`  
**Location**: `/opt/project_identuslabel/company-admin-portal/server.js` (lines 5065-5133)

**Response (200 OK):**
```json
{
  "success": true,
  "challenge": "UUID-string",
  "documentDID": "did:prism:...",
  "presentationDefinition": {
    "id": "challenge-UUID",
    "input_descriptors": [
      {
        "id": "enterprise_vc",
        "name": "Enterprise Employee Credential",
        "purpose": "Prove you are an authorized employee",
        "constraints": {
          "fields": [
            { "path": ["$.vc.credentialSubject.role"], "filter": { "type": "string" } },
            { "path": ["$.vc.credentialSubject.department"], "filter": { "type": "string" } }
          ]
        }
      },
      {
        "id": "clearance_vc",
        "name": "Security Clearance Credential",
        "purpose": "Prove your security clearance level",
        "constraints": {
          "fields": [
            { "path": ["$.vc.credentialSubject.clearanceLevel"], "filter": { "type": "string" } }
          ]
        }
      }
    ]
  },
  "expiresIn": 300
}
```

**Challenge TTL**: 5 minutes (300 seconds) — stored server-side in `pendingDocumentAccessChallenges` Map

---

### Present Endpoint (VP Submission)
**Endpoint**: `POST /api/access-gate/present`  
**Location**: `/opt/project_identuslabel/company-admin-portal/server.js` (lines 5158-5439)

**Request Body:**
```json
{
  "documentDID": "did:prism:...",
  "vp": {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    "type": ["VerifiablePresentation"],
    "verifiableCredential": ["JWT1", "JWT2", ...]
  },
  "challenge": "UUID-from-challenge-endpoint",
  "ephemeralPublicKey": "Base64-encoded X25519 public key"
}
```

**Verification Steps (Server-side):**
1. Validate challenge exists and not expired (line 5176-5187)
2. Consume challenge (one-time use) — delete from Map (line 5189)
3. Verify VP and extract claims (line 5192)
4. Check releasability (issuer in document.releasableTo) (line 5209)
5. Check clearance level >= document classification (line 5228-5250)
6. Check StatusList2021 revocation (line 5254-5277)
7. Download from Iagon, decrypt, redact (line 5279-5371)
8. Create EphemeralDID as audit token (line 5374-5381)
9. Re-encrypt with wallet's ephemeralPublicKey (PFS) (line 5385)
10. Log access (line 5391-5402)

**Response (200 OK):**
```json
{
  "success": true,
  "granted": true,
  "documentDID": "did:prism:...",
  "copyId": "UUID",
  "copyHash": "sha256-hex",
  "ephemeralDID": "ephemeral-identifier",
  "clearanceLevel": "CONFIDENTIAL",
  "documentMetadata": {
    "title": "Document Title",
    "overallClassification": "CONFIDENTIAL"
  },
  "encryptedDocument": {
    "ciphertext": "base64-encrypted-content",
    "nonce": "base64-nonce",
    "serverPublicKey": "base64-server-ephemeral-x25519-public-key",
    "copyId": "UUID",
    "filename": "document.html",
    "mimeType": "text/html",
    "classificationLevel": "CONFIDENTIAL"
  }
}
```

---

## 3. CACHED KEY vs. FRESH VP CHALLENGE CODE PATHS

### Path A: Fresh VP Challenge (Full Access Gate Flow)

**Triggered by**: `DocumentDIDAccess.tsx` (lines 519-698, handleAccess function)

**Step-by-step:**
1. User opens document by pasting its PRISM DID (line 533-537)
2. System auto-detects or user selects identity (EmployeeRole or SecurityClearance) (lines 384-407)
3. Generate new ephemeral X25519 keypair (line 578)
4. POST `/api/access-gate/challenge` to get challenge UUID (lines 678, 687-691 in KeyAuthorityClient.ts)
5. POST `/api/access-gate/present` with VP + challenge + ephemeralPublicKey (line 596-600)
6. Server returns encrypted document re-encrypted with wallet's ephemeral public key
7. **Store ephemeral private key in localStorage** (line 658): `setItem(\`ephemeral-key-${did}\`, { secretKey: ... })`
8. Store document metadata in IndexedDB (line 683)
9. Trigger document viewer (line 718)

**File locations:**
- Request flow: `/opt/project_identuslabel/idl-wallet/src/utils/KeyAuthorityClient.ts` lines 273-320 (requestDocumentAccess)
- Access challenge: `/opt/project_identuslabel/idl-wallet/src/components/DocumentDIDAccess.tsx` lines 596-610

---

### Path B: Cached Ephemeral Key Decryption (No VP Challenge)

**Triggered by**: Opening an already-downloaded document in the viewer

**Step-by-step:**
1. User clicks "View" on a document in "My Documents" list (documents.tsx line 360)
2. Document viewer opens (`ClassifiedDocumentViewer.tsx` component)
3. **CRITICAL**: In `useEffect` at lines 206-301, system attempts decryption:
   - **First attempt**: Try ephemeral key specific to this document (lines 227-243)
     - Look up by calling `getEphemeralKey(document.ephemeralDID)` (lines 360-395)
     - Searches localStorage for keys matching pattern `ephemeral-key-{ephemeralDID}`
     - If found: decrypt using `nacl.box.open(ciphertext, nonce, serverPublicKey, ephemeralPrivateKey)`
   - **If successful**: Document is decrypted, no server round-trip (line 238-239)
   - **Fallback**: If ephemeral key not found, try security-clearance keys (lines 246-273)

**Code path:**
```typescript
// ClassifiedDocumentViewer.tsx lines 226-243
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
    }
  } catch (ephemeralErr) {
    console.warn('[ClassifiedDocumentViewer] Ephemeral key decryption failed:', ephemeralErr);
  }
}
```

**No VP Challenge Required** — the cached private key is sufficient for decryption

---

## 4. EPHEMERAL KEY LOOKUP IMPLEMENTATION

**File**: `/opt/project_identuslabel/idl-wallet/src/components/ClassifiedDocumentViewer.tsx` (lines 360-395)

```typescript
const getEphemeralKey = (ephemeralDID: string): Uint8Array | null => {
  // PATTERN 1: Direct key name lookup (fast path)
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes(`ephemeral-key-${ephemeralDID}`)) {
      try {
        const data = JSON.parse(localStorage.getItem(key) || '{}');
        if (data.secretKey) {
          console.log('[ClassifiedDocumentViewer] Found ephemeral key for:', ephemeralDID);
          return base64ToUint8Array(data.secretKey);
        }
      } catch (e) {
        console.warn('[ClassifiedDocumentViewer] Failed to parse ephemeral key:', e);
      }
    }
  }
  
  // PATTERN 2: Fallback pattern matching (checks ephemeralDID field in value)
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
```

**Performance**: O(n) where n = number of localStorage keys (both patterns scan all keys)

---

## 5. LIGHTWEIGHT ACCESS NOTIFICATION ENDPOINT

### Finding: NO LIGHTWEIGHT ACCESS-ONLY ENDPOINT EXISTS

**Search result**: Grep for `notify|report.*access|lightweight.*access` returned NO MATCHES in server.js

**Current behavior:**
- The `/api/access-gate/present` endpoint (lines 5158-5439) is a **FULL VP VERIFICATION + ACCESS GRANT** endpoint
- It logs access regardless (lines 5391-5402):
  ```javascript
  fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
    timestamp: new Date().toISOString(),
    viewerName: viewerName || null,
    documentDID,
    documentTitle: document?.metadata?.title || null,
    clearanceLevel: clearanceLevel || null,
    companyDID: document.ownerCompanyDID || null,
    accessGranted: true,   // <-- Always logs
    denialReason: null,
    copyId,
    clientIp: req.ip || req.connection?.remoteAddress || null
  }) + '\n', () => {});
  ```

**To enable cached-key access notifications without full VP:**
1. The `/api/access-gate/present` endpoint would need a `notificationOnly` flag
2. OR a new lightweight endpoint `/api/access-gate/notify` would be needed
3. This would allow: "User accessed document with cached key" logging without VP re-verification

**Currently**: Each cached key access has **NO notification to server** — it's purely local decryption

---

## 6. EPHEMERAL KEY LIFECYCLE

| Stage | Where | Duration | Details |
|-------|-------|----------|---------|
| **Generation** | `/api/access-gate/present` response | — | Server creates ephemeralDID, wallet creates X25519 keypair |
| **Delivery** | Response encrypted with wallet's ephemeralPublicKey | One-time | Private key never leaves wallet |
| **Storage** | localStorage with key `ephemeral-key-{ephemeralDID}` | TTL of document | Persists across browser restarts |
| **Lookup** | ClassifiedDocumentViewer on document open | O(n) scan | Fast for small localStorage, slow if many ephemeral keys |
| **Decryption** | nacl.box.open() in viewer | — | Local, no server access |
| **Cleanup** | Manual (user removes document) or TTL expiry | Document expiresAt | IndexedDB record expires, localStorage key remains (orphaned) |

---

## 7. SECURITY PROPERTIES

### Perfect Forward Secrecy (PFS)
- ✅ Each document access generates a **unique ephemeral X25519 keypair**
- ✅ Server never sees the private key (encrypted with server's ephemeralPublicKey in response)
- ✅ Compromise of cached localStorage key only affects **this specific document copy**, not others

### Key Isolation
- ✅ Ephemeral key cached **per document copy** (not shared across document versions)
- ✅ Wallet prefix (`wallet-idl-`) prevents cross-wallet collisions on shared domain

### Limitations
- ⚠️ **No server-side TTL**: localStorage keys persist indefinitely unless manually deleted
- ⚠️ **No access audit trail** for cached-key decryption (no server-side notification)
- ⚠️ **No revocation check** for cached-key access (ephemeral key has no revocation status)

---

## 8. CODE REFERENCES (EXACT FILE PATHS & LINE NUMBERS)

### Ephemeral Key Storage
- `idl-wallet/src/utils/prefixedStorage.ts` (14-27): Storage prefix management
- `idl-wallet/src/utils/SecureDashboardBridge.ts` (930-962): Store key during SSI download
- `idl-wallet/src/components/DocumentDIDAccess.tsx` (658): Store key after VP challenge

### Ephemeral Key Lookup & Decryption
- `idl-wallet/src/components/ClassifiedDocumentViewer.tsx` (206-301): Decryption logic
- `idl-wallet/src/components/ClassifiedDocumentViewer.tsx` (360-395): Key lookup implementation

### VP Challenge Flow
- `idl-wallet/src/utils/KeyAuthorityClient.ts` (273-320): requestDocumentAccess() function
- `company-admin-portal/server.js` (5065-5133): GET /api/access-gate/challenge endpoint
- `company-admin-portal/server.js` (5158-5439): POST /api/access-gate/present endpoint

### Document Access Initiation
- `idl-wallet/src/components/DocumentDIDAccess.tsx` (529-698): handleAccess() — full access flow
- `idl-wallet/src/pages/documents.tsx` (359-361): User clicks "View" button

---

## Summary

When a document is opened in the wallet:

1. **First time**: User's credentials (EmployeeRole + SecurityClearance) are presented via VP challenge → server verifies → server sends encrypted document
2. **Ephemeral key caching**: The wallet's X25519 **private key** is stored in `localStorage` with key `ephemeral-key-{ephemeralDID}`
3. **Subsequent times**: Cached private key is found in localStorage → document decrypted locally → no server access
4. **No lightweight notify**: Currently, cached-key access has no server-side notification (all information is local)
