# Hash-Based Document Discovery via VDR + Storage Locator Service

## Concept

Instead of embedding storage-specific information (Iagon file IDs, download URLs) directly into immutable PRISM DIDs, the system separates:

1. **Identity layer** — The DID: immutable, storage-agnostic, published on Cardano
2. **Discovery layer** — A hash index: maps content hashes to DIDs
3. **Storage locator layer** — A locator service: maps `plaintextHash → storage path`

This means a DID never needs to be updated when the underlying storage changes provider, migrates regions, or gets re-uploaded. The DID is a permanent commitment to the document's identity and access policy — not its physical location.

---

## What Each DID Contains

The document DID's `#metadata` service endpoint contains **only identity and policy** — no storage-provider specifics:

```json
{
  "id": "#metadata",
  "type": "DocumentMetadata",
  "serviceEndpoint": {
    "issuerDID":           "did:prism:6ee757c...",
    "plaintextHash":       "sha256:a3f2c1...",
    "encryptedHash":       "sha256:9b8e4d...",
    "clearanceLevel":      "CONFIDENTIAL",
    "releasableTo":        []
  }
}
```

The `#access` service endpoint points to the document access gate (unchanged):
```json
{
  "id": "#access",
  "type": "DocumentAccessGate",
  "serviceEndpoint": "https://identuslabel.cz/document-service/access"
}
```

**No `iagonFileId`, no download URL, no storage-specific fields in the DID.**

---

## Storage Locator Service

A separate, lightweight service maintains a mutable mapping:

```
plaintextHash  →  { storageProvider, fileId, encryptionManifestId, uploadedAt, ... }
```

This service:
- Is updated when a document is uploaded (write-through from company-admin-portal)
- Can be updated without touching the immutable DID when a file is migrated
- Is NOT the source of truth for access policy — the DID is
- Can be queried publicly (reveals only storage location, not content)

### API

```
GET  /storage-locator/by-hash/{plaintextHash}
→ { storageProvider: "iagon", fileId: "abc123", region: "eu", ... }

POST /storage-locator/register
Body: { plaintextHash, encryptedHash, documentDID, storageProvider, fileId }

PUT  /storage-locator/migrate
Body: { plaintextHash, newStorageProvider, newFileId }
```

---

## Complete Access Flow

### Scenario A: User receives an encrypted blob and wants to access it

```
1. User receives encrypted file blob
   ↓
2. Compute sha256(ciphertext)  →  encryptedHash
   ↓
3. Query hash discovery index:
   POST /hash-index/lookup  { hash: encryptedHash }
   ← { documentDID, issuerDID, clearanceLevel, accessEndpoint }
   ↓
4. Resolve document DID (optional verification):
   GET /dids/{documentDID}
   ← Confirm plaintextHash, clearanceLevel, issuerDID
   ↓
5. Request access with VP proving identity + clearance:
   POST /document-service/access
   Body: { documentDID, ephemeralPublicKey, vp: <VP JWT> }
   ↓
6. Document service:
   a. Verifies VP (clearance level, issuer match, signature)
   b. Checks releasability
   c. Queries Storage Locator: GET /storage-locator/by-hash/{plaintextHash}
   d. Downloads encrypted file from storage provider
   e. Decrypts with DEK (from VCKeyStore / CMK-wrapped manifest)
   f. Verifies sha256(plaintext) === plaintextHash
   g. Re-encrypts with client's ephemeralPublicKey (X25519)
   ← { ciphertext, nonce, serverPublicKey }
   ↓
7. Client decrypts with ephemeral private key → plaintext
   ↓
8. Client verifies: sha256(plaintext) === plaintextHash from DID   ✓
```

### Scenario B: User knows the document hash (out-of-band) and wants to request it

```
1. User already has plaintextHash (received via secure channel, email, etc.)
   ↓
2. Query hash discovery index:
   POST /hash-index/lookup  { hash: plaintextHash }
   ← { documentDID, issuerDID, clearanceLevel }
   ↓
3-8. Same as Scenario A from step 4 onwards
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     PRISM Blockchain (VDR)                   │
│  DID: { issuerDID, plaintextHash, encryptedHash,            │
│          clearanceLevel, accessGateURL }                     │
│  ← Immutable, authoritative, storage-agnostic               │
└──────────────────────────┬──────────────────────────────────┘
                           │ published once
                           ↓
┌──────────────────────────────────────────────────────────────┐
│              Off-Chain Index Layer (write-through)            │
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────┐    │
│  │   Hash Discovery    │    │   Storage Locator        │    │
│  │   Index             │    │   Service                │    │
│  │                     │    │                          │    │
│  │  encryptedHash  →   │    │  plaintextHash  →        │    │
│  │    documentDID      │    │    { provider, fileId }  │    │
│  │  plaintextHash  →   │    │                          │    │
│  │    documentDID      │    │  Mutable: can be updated │    │
│  │                     │    │  when file migrates      │    │
│  └─────────────────────┘    └──────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                           │
                           ↓ query at access time
┌─────────────────────────────────────────────────────────────┐
│              Document Access Service                         │
│  1. Verify VP (clearance, releasability, signature)         │
│  2. Query Storage Locator → get fileId                      │
│  3. Download from Iagon (or future provider)                │
│  4. Decrypt + verify hash                                   │
│  5. Re-encrypt for client ephemeral key                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1 — DID Service Endpoint Cleanup

**File:** `company-admin-portal/lib/EnterpriseDocumentManager.js`

Remove `iagonFileId` from the `#metadata` service endpoint. Add `encryptedHash`:

```javascript
// Before:
serviceEndpoint: {
  iagonFileId:    iagonInfo.fileId,    // ← REMOVE
  clearanceLevel: ...,
  contentHash:    iagonInfo.contentHash
}

// After:
serviceEndpoint: {
  issuerDID:        company.did,
  plaintextHash:    iagonInfo.contentHash,       // sha256(plaintext)
  encryptedHash:    iagonInfo.encryptedHash,     // sha256(ciphertext) — NEW
  clearanceLevel:   metadata.classificationLevel,
  releasableTo:     []
}
```

**File:** `company-admin-portal/server.js`

At upload time, compute `encryptedHash`:
```javascript
const encryptedHash = 'sha256:' + crypto.createHash('sha256')
  .update(encryptedBuffer).digest('hex');
```

Pass `encryptedHash` into `createDocumentDIDWithServiceEndpoint()`.

---

### Phase 2 — Storage Locator Service

**New File:** `company-admin-portal/lib/StorageLocator.js`

```javascript
class StorageLocator {
  // Persistent: company-admin-portal/data/storage-locator.json

  register({ plaintextHash, encryptedHash, documentDID,
             storageProvider, fileId, encryptionManifestId })

  getByPlaintextHash(hash)
  // → { storageProvider, fileId, encryptionManifestId, documentDID }

  migrate({ plaintextHash, newStorageProvider, newFileId })
}
```

**File:** `company-admin-portal/server.js`

Register after successful upload:
```javascript
storageLocator.register({
  plaintextHash:       iagonInfo.contentHash,
  encryptedHash:       encryptedHash,
  documentDID:         result.documentDID,
  storageProvider:     'iagon',
  fileId:              iagonInfo.fileId,
  encryptionManifestId: iagonInfo.encryptionManifestId
});
```

Add REST endpoint:
```
GET /api/storage-locator/:hash
→ { storageProvider, fileId, documentDID }
```

---

### Phase 3 — Hash Discovery Index

**New File:** `company-admin-portal/lib/DocumentHashIndex.js`

```javascript
class DocumentHashIndex {
  // Persistent: company-admin-portal/data/hash-index.json

  register({ encryptedHash, plaintextHash, documentDID,
             issuerDID, clearanceLevel })

  lookup(hash)
  // → { documentDID, issuerDID, clearanceLevel, accessEndpoint } | null
}
```

**File:** `company-admin-portal/server.js`

Public discovery endpoint (no auth):
```
POST /api/documents/lookup
Body:  { hash: "sha256:..." }
→ { documentDID, issuerDID, clearanceLevel, accessEndpoint }
```

---

### Phase 4 — Document Service: Use Storage Locator

**File:** `identus-document-service/lib/DIDDocumentResolver.js`

Stop extracting `iagonFileId` from DID (it's no longer there). Instead, after resolving the DID to get `plaintextHash`, query the Storage Locator service to get `fileId`.

**File:** `identus-document-service/lib/ReEncryptionService.js`

Replace:
```javascript
// Old: fileId came from DID metadata
const fileId = docMeta.iagonFileId;
```

With:
```javascript
// New: fileId comes from Storage Locator
const location = await storageLocator.getByPlaintextHash(docMeta.plaintextHash);
const fileId = location.fileId;
```

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `company-admin-portal/lib/StorageLocator.js` | **CREATE** — plaintextHash → storage path index |
| `company-admin-portal/lib/DocumentHashIndex.js` | **CREATE** — content hash → DID discovery index |
| `company-admin-portal/lib/EnterpriseDocumentManager.js` | Remove `iagonFileId` from DID service endpoint; add `encryptedHash`, `issuerDID` |
| `company-admin-portal/server.js` | Compute `encryptedHash` at upload; register in both indices; add `/api/documents/lookup` and `/api/storage-locator/:hash` endpoints |
| `identus-document-service/lib/DIDDocumentResolver.js` | Extract `plaintextHash`/`encryptedHash` instead of `iagonFileId` |
| `identus-document-service/lib/ReEncryptionService.js` | Query Storage Locator for `fileId` instead of reading from DID metadata |

---

## Why This Is Better Than the Current Design

| Concern | Current | This Design |
|---------|---------|-------------|
| File migration | Must update DID (impossible — immutable) | Update Storage Locator only |
| Storage provider swap | Iagon hardcoded in DID | `storageProvider` field in locator |
| DID size | Includes fileId, manifestId | Minimal — hashes + policy only |
| Discovery | Must know DID in advance | Hash-based reverse lookup |
| Verification | Trust the service | Verify against immutable DID independently |
| Separation of concerns | Identity + storage mixed | Identity (DID) / Storage (locator) separate |

---

## Backward Compatibility

Existing documents have `iagonFileId` in their DID service endpoint. The migration path:

1. `DIDDocumentResolver` checks: if `iagonFileId` present in DID → use it directly (legacy path)
2. If `plaintextHash` present but no `iagonFileId` → query Storage Locator (new path)
3. Storage Locator can be pre-populated with existing documents by scanning `DocumentRegistry.json`

No existing DIDs need to change. New documents use the new format.
