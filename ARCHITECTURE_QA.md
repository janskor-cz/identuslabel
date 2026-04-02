# Architecture Q&A — identuslabel.cz SSI Document System

> Codebase investigation conducted 2026-04-02.
> Each answer quotes the relevant code with file path and line numbers.

---

## 1. Is there a new stateless service handling document access decisions? If yes, where does it read its rules from — DID resolution, database, or memory?

**YES.** `identus-document-service` is a new stateless microservice that handles all document access decisions. It reads its rules **from DID resolution** — not from a database or in-memory config.

The access decision engine resolves the document's PRISM DID and extracts `clearanceLevel` and `releasableTo` (authorized issuer DIDs) from the `DocumentMetadata` service endpoint embedded in the DID Document on Cardano.

**`identus-document-service/lib/DIDDocumentResolver.js` (lines 59–82):**
```javascript
const metadataService = services.find(s => s.type === 'DocumentMetadata');
if (!metadataService) {
    throw new Error(`No DocumentMetadata service endpoint in DID document: ${documentDID}`);
}

let metadata = metadataService.serviceEndpoint;
// ...
if (!metadata.iagonFileId) {
    throw new Error(`DocumentMetadata missing iagonFileId in DID: ${documentDID}`);
}
```

**`identus-document-service/lib/ReEncryptionService.js` (lines 262–288) — decision logic:**
```javascript
// Step 3: Releasability — issuer DID must be in releasableTo
if (companyDID !== null && !docMeta.releasableTo.includes(issuerDID)) {
    return { success: false, error: 'RELEASABILITY_DENIED' };
}

// Step 4: Clearance level
const requiredLevel = getLevelNumber(docMeta.clearanceLevel);
if (clearanceLevelNum < requiredLevel) {
    return {
        success: false,
        error: 'CLEARANCE_DENIED',
        message: `Document requires ${docMeta.clearanceLevel}, you have ${clearanceLevelStr}`
    };
}
```

---

## 2. Is there any ABE or ABE-like encryption implemented? If yes, what library and what scheme?

**NO.** There is no Attribute-Based Encryption (ABE) or ABE-like scheme. The codebase uses standard **AES-256-GCM** with random per-document keys.

**`identus-document-service/lib/IagonStorageClient.js` (lines 68–102):**
```javascript
encryptContent(content, classificationLevel) {
    // Generate encryption key and IV
    const key = crypto.randomBytes(32); // 256 bits
    const iv  = crypto.randomBytes(12); // 96 bits for GCM

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // ...

    return {
        content: encrypted,
        encryptionInfo: {
            algorithm: 'AES-256-GCM',
            keyId: keyId,
            key:   key.toString('base64'),
            iv:    iv.toString('base64'),
            authTag: authTag.toString('base64')
        }
    };
}
```

Access control is enforced at the application layer (clearance comparison + signature verification) rather than by cryptographic policy enforcement.

---

## 3. Is the document content hash computed and included in the DID Document published to Cardano?

**The hash is computed, but NOT included in the DID Document.**

A SHA-256 hash is computed during upload and during each access (to create a unique copy fingerprint), but the DID Document's `DocumentMetadata` service endpoint contains no `contentHash` field.

**Hash is computed — `identus-document-service/lib/IagonStorageClient.js` (line 148):**
```javascript
const contentHash = this.calculateContentHash(fileContent);
```

**Hash is also computed per access — `identus-document-service/lib/ReEncryptionService.js` (lines 334–336):**
```javascript
const copyId   = crypto.randomUUID();
const copyHash = crypto.createHash('sha256').update(content).update(copyId).digest('hex');
```

**But the DID Document services contain no hash — `identus-document-service/lib/DocumentService.js` (lines 318–353):**
```javascript
_buildServices({ iagonFileId, iagonFilename, originalFilename, mimeType,
                 clearanceLevel, releasableTo, iagonEncManifestId, auditWebhookUrl }) {
    const services = [
      {
        id:   'metadata',
        type: 'DocumentMetadata',
        serviceEndpoint: {
          iagonFileId,
          iagonFilename,
          originalFilename,
          mimeType,
          clearanceLevel,
          releasableTo,
          iagonEncManifestId
          // ← no contentHash
        }
      }
    ];
}
```

The hash is used for audit trails only, not for on-chain integrity verification.

---

## 4. Is DocumentRegistry still in-memory or has it been persisted somewhere?

**Both — in-memory Map with file-based persistence for crash recovery.**

The registry is kept in a `Map` at runtime and flushed to `company-admin-portal/data/document-registry.json` after every write.

**`company-admin-portal/lib/DocumentRegistry.js` (lines 22–28):**
```javascript
constructor() {
    // In-memory document storage (replace with PostgreSQL in production)
    this.documents        = new Map();
    this.documentVersions = new Map();
    // ...
    this.persistence = DocumentRegistryPersistence;
}
```

**`company-admin-portal/lib/DocumentRegistry.js` (lines 147–153) — persist after every registration:**
```javascript
try {
    await this.persistence.saveRegistry(this.documents, this.documentVersions);
} catch (error) {
    console.error(`[DocumentRegistry] ⚠️  Failed to persist registry: ${error.message}`);
    // Don't fail registration if persistence fails
}
```

**`company-admin-portal/lib/DocumentRegistryPersistence.js` (lines 34–96) — disk write:**
```javascript
async saveRegistry(documentsMap, documentVersionsMap = new Map()) {
    // ...
    await fs.writeFile(
        this.storagePath,   // → company-admin-portal/data/document-registry.json
        JSON.stringify(persistedData, null, 2),
        'utf8'
    );
}
```

On server restart, the registry is loaded from disk before serving requests.

---

## 5. Are classification level and trusted issuer DIDs embedded in the DID Document on Cardano, or still only in server RAM?

**Embedded in the DID Document on Cardano.** Both `clearanceLevel` and `releasableTo` (the array of authorized issuer DIDs) are written into the `DocumentMetadata` service endpoint at DID creation time and published to Cardano via the Enterprise Cloud Agent.

**`identus-document-service/lib/DocumentService.js` (lines 318–332):**
```javascript
_buildServices({ iagonFileId, iagonFilename, originalFilename, mimeType,
                 clearanceLevel, releasableTo, iagonEncManifestId, auditWebhookUrl }) {
    const services = [
      {
        id:   'metadata',
        type: 'DocumentMetadata',
        serviceEndpoint: {
          iagonFileId,
          iagonFilename,
          originalFilename,
          mimeType,
          clearanceLevel,   // ← on-chain
          releasableTo,     // ← on-chain (array of issuer DIDs)
          iagonEncManifestId
        }
      }
    ];
}
```

**`identus-document-service/lib/DocumentService.js` (lines 125–131) — DID publication:**
```javascript
// Step 6: Create PRISM DID
const { longFormDid, operationId } = await this._createPRISMDID(services);

// Step 7: Publish (fire-and-forget — long-form DID usable immediately)
this._publishDID(longFormDid).catch(err =>
    console.warn(`[DocumentService] DID publication failed (non-fatal): ${err.message}`)
);
```

The access decision engine resolves these directly from the DID Document, so the authoritative copy lives on-chain, not in server RAM.

---

## 6. Are documents encrypted at rest with classification master keys and per-document keys?

**Partially — yes to per-document keys, no to classification master keys.**

Every document is encrypted with a unique random 256-bit AES-GCM key generated at upload time. There are no classification-tier master keys; all clearance levels use the same algorithm with independent keys.

**`identus-document-service/lib/IagonStorageClient.js` (lines 68–76):**
```javascript
const key = crypto.randomBytes(32); // 256-bit random key — unique per document
const iv  = crypto.randomBytes(12); // 96-bit IV for GCM

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
```

The key and IV are stored in a separate **encryption manifest file** on Iagon (referenced by `iagonEncManifestId` in the DID Document):

**`identus-document-service/lib/DocumentService.js` (lines 99–110):**
```javascript
if (encryptionInfo.algorithm !== 'none') {
    const manifestBuf    = Buffer.from(JSON.stringify(encryptionInfo), 'utf8');
    const manifestResult = await this.iagon.uploadFile(manifestBuf, `enckey-${iagonResult.fileId}.json`);
    iagonEncManifestId   = manifestResult.fileId;
}
```

The server fetches the key manifest at access time to decrypt and re-encrypt for the requesting user.

---

## 7. When a document is delivered to a user, is their DID embedded in the copy they receive?

**No — the user's DID is NOT embedded in the delivered copy.** Instead, a random `copyId` (UUID) is generated per access and a `copyHash` (SHA-256 of content + copyId) is returned for accountability. The content is re-encrypted with the user's ephemeral X25519 key for transport security.

**`identus-document-service/lib/ReEncryptionService.js` (lines 334–357):**
```javascript
// Step 7: Generate copy ID for accountability
const copyId   = crypto.randomUUID();
const copyHash = crypto.createHash('sha256').update(content).update(copyId).digest('hex');

// Step 8: Re-encrypt for user's ephemeral key
const encrypted = ecdhEncrypt(ephemeralPublicKey, content);

return {
    success:         true,
    documentDID,
    copyId,           // unique UUID per access (for audit log)
    copyHash,         // SHA-256(content + copyId)
    filename:         docMeta.originalFilename || docMeta.iagonFilename || 'document',
    mimeType:         getMimeType(docMeta),
    clearanceLevel:   docMeta.clearanceLevel,
    ciphertext:       encrypted.ciphertext,   // re-encrypted for this user's ephemeral key
    nonce:            encrypted.nonce,
    serverPublicKey:  encrypted.serverPublicKey
};
```

The user's long-term DID is used for authorization only; it does not appear in the content bytes they receive.

---

## 8. Who makes the final access decision — the server logic or a cryptographic proof?

**Server logic makes the final decision.** The cryptographic layer (Ed25519 signature) verifies the request is authentic, but authorization (releasability + clearance) is enforced by application-level comparisons against values read from the DID Document.

**`identus-document-service/lib/ReEncryptionService.js` (lines 262–288) — full decision pipeline:**
```javascript
// Step 1: Verify Ed25519 signature  ← cryptographic authenticity only
const sigValid = await verifySignature({ documentDID, ephemeralDID, timestamp, nonce, signature, requestorDID });
if (!sigValid) {
    return { success: false, error: 'INVALID_SIGNATURE' };
}

// Step 2: Replay detection           ← application logic
if (checkReplay(nonce)) {
    return { success: false, error: 'REPLAY_DETECTED' };
}

// Step 3: Releasability check        ← application logic (array lookup)
if (companyDID !== null && !docMeta.releasableTo.includes(issuerDID)) {
    return { success: false, error: 'RELEASABILITY_DENIED' };
}

// Step 4: Clearance level check      ← application logic (numeric comparison)
const requiredLevel = getLevelNumber(docMeta.clearanceLevel);
if (clearanceLevelNum < requiredLevel) {
    return { success: false, error: 'CLEARANCE_DENIED' };
}

// Step 5: Revocation check           ← application logic (VC status query)
const revoked = await checkRevocation(credential);
if (revoked) {
    return { success: false, error: 'CREDENTIAL_REVOKED' };
}
```

There is no Zero-Knowledge Proof or verifiable presentation checked cryptographically for authorization. The server trusts itself as the policy enforcement point.

---

## Summary

| # | Question | Answer | Key file |
|---|----------|--------|----------|
| 1 | Stateless access service? | **Yes — reads from DID resolution** | `identus-document-service/lib/ReEncryptionService.js:252–357` |
| 2 | ABE encryption? | **No — AES-256-GCM per document** | `identus-document-service/lib/IagonStorageClient.js:68–102` |
| 3 | Content hash in DID on Cardano? | **No — computed but not embedded** | `identus-document-service/lib/DocumentService.js:318–353` |
| 4 | DocumentRegistry persistence? | **Yes — in-memory + JSON file** | `company-admin-portal/lib/DocumentRegistryPersistence.js:34–96` |
| 5 | Clearance & issuer DIDs on Cardano? | **Yes — in DID Document service endpoint** | `identus-document-service/lib/DocumentService.js:328–329` |
| 6 | Classification master keys? | **No — only random per-document AES-256-GCM** | `identus-document-service/lib/IagonStorageClient.js:68–76` |
| 7 | User DID embedded in delivered copy? | **No — copyId UUID used for accountability** | `identus-document-service/lib/ReEncryptionService.js:334–339` |
| 8 | Final decision: server or crypto proof? | **Server logic (not cryptographic proof)** | `identus-document-service/lib/ReEncryptionService.js:262–288` |
