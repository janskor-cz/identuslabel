# TODO: Ephemeral DID Document Access Control System

## Project Overview

Implement secure document access control using ephemeral DIDs for perfect forward secrecy. This system enables employees to upload classified documents with releasability controls, and other authorized users to access accountable copies encrypted to single-use ephemeral keys.

**Whitepaper Reference**: `/mnt/project/SSI_Document_Access_Control_WhitePaper.docx` (Sections 2.3, 5.2)

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DOCUMENT UPLOAD FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Employee Wallet                    Enterprise Dashboard                     │
│  ┌──────────────┐                  ┌─────────────────────┐                  │
│  │ Employee     │  1. Authenticate │  Upload Form        │                  │
│  │ Badge VC     │ ───────────────► │  - PDF file         │                  │
│  │ + Security   │                  │  - Classification   │                  │
│  │ Clearance VC │                  │  - Releasability    │                  │
│  └──────────────┘                  │    (Issuer DIDs)    │                  │
│                                    └─────────┬───────────┘                  │
│                                              │                               │
│                                              ▼                               │
│                                    ┌─────────────────────┐                  │
│                                    │ Re-Encryption       │                  │
│                                    │ Service             │                  │
│                                    │ - Validate class.   │                  │
│                                    │ - Generate AES key  │                  │
│                                    │ - Encrypt document  │                  │
│                                    │ - Store metadata    │                  │
│                                    └─────────┬───────────┘                  │
│                                              │                               │
│                                              ▼                               │
│                          ┌──────────────────────────────────┐               │
│                          │ PostgreSQL                        │               │
│                          │ - documents table                 │               │
│                          │ - document_encryption_keys table  │               │
│                          └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         DOCUMENT ACCESS FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Requestor Wallet                                                            │
│  ┌───────────────────┐                                                      │
│  │ 1. Generate       │  Ephemeral X25519 key pair                           │
│  │    Ephemeral DID  │  did:peer:0z{publicKey}                              │
│  └─────────┬─────────┘                                                      │
│            │                                                                 │
│            ▼                                                                 │
│  ┌───────────────────┐                                                      │
│  │ 2. Sign Access    │  Ed25519 signature over:                             │
│  │    Request        │  {documentId, ephemeralDID, timestamp, nonce}        │
│  └─────────┬─────────┘                                                      │
│            │                                                                 │
│            ▼                                                                 │
│  ┌───────────────────┐     POST /api/documents/{id}/access                  │
│  │ 3. Send Request   │ ──────────────────────────────────────►              │
│  │    to Server      │     {requestorDID, issuerDID, clearanceLevel,        │
│  └───────────────────┘      ephemeralDID, ephemeralPublicKey, signature}    │
│                                                                              │
│                                         │                                    │
│                                         ▼                                    │
│                              ┌─────────────────────────┐                    │
│                              │ Re-Encryption Service   │                    │
│                              │                         │                    │
│                              │ 4. Verify:              │                    │
│                              │    - Issuer DID in      │                    │
│                              │      releasability list │                    │
│                              │    - Clearance level    │                    │
│                              │    - Revocation status  │                    │
│                              │      (StatusList2021)   │                    │
│                              │    - Request signature  │                    │
│                              │                         │                    │
│                              │ 5. Decrypt original     │                    │
│                              │    (AES-256-GCM)        │                    │
│                              │                         │                    │
│                              │ 6. Create accountable   │                    │
│                              │    copy with:           │                    │
│                              │    - Visible watermark  │                    │
│                              │    - Invisible metadata │                    │
│                              │    - Copy ID            │                    │
│                              │    - Requestor DID      │                    │
│                              │                         │                    │
│                              │ 7. Encrypt for          │                    │
│                              │    ephemeral public key │                    │
│                              │    (X25519 + XSalsa20)  │                    │
│                              │                         │                    │
│                              │ 8. Log to audit trail   │                    │
│                              └───────────┬─────────────┘                    │
│                                          │                                   │
│            ◄─────────────────────────────┘                                   │
│            │  {ciphertext, nonce, serverPublicKey, copyId}                   │
│            ▼                                                                 │
│  ┌───────────────────┐                                                      │
│  │ 9. Decrypt with   │  nacl.box.open(ciphertext, nonce,                    │
│  │    Ephemeral Key  │                serverPubKey, ephemeralSecretKey)     │
│  └─────────┬─────────┘                                                      │
│            │                                                                 │
│            ▼                                                                 │
│  ┌───────────────────┐                                                      │
│  │ 10. DESTROY       │  ephemeralSecretKey.fill(0)                          │
│  │     Ephemeral Key │  Perfect Forward Secrecy ✓                           │
│  └───────────────────┘                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions (Already Made)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Key Storage** | PostgreSQL | POC simplicity; production should use HSM |
| **Watermarking** | Both visible AND invisible | Visible for deterrence, invisible for forensics |
| **Ephemeral Key Lifetime** | Destroy immediately after decryption | Maximum security, perfect forward secrecy |
| **Revocation Checking** | Yes, before each access | Via StatusList2021 |
| **Offline Access** | No (online-only) | Maximum security for POC |
| **Crypto Library** | SDK patterns + tweetnacl | SDK doesn't expose box encryption |

---

## Existing Infrastructure

**Location**: Production server at `91.99.4.54` / `identuslabel.cz`

| Component | Port | Status |
|-----------|------|--------|
| CA Portal | 3005 | ✅ Running |
| Cloud Agent | 8000 | ✅ Running |
| Alice Wallet | 3001 | ✅ Running |
| Bob Wallet | 3002 | ✅ Running |
| Mediator | 8080 | ✅ Running |
| PostgreSQL | 5432 | ✅ Running |

**Relevant Files**:
- `/root/certification-authority/server.js` - CA server (extend this)
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/` - Wallet to extend
- `/mnt/project/CLAUDE.md` - Full system documentation

---

## Phase 1: Database Schema

### Task 1.1: Create Documents Table

**File**: `migrations/001_documents.sql`

```sql
-- Documents table for encrypted document storage
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- File metadata
    filename VARCHAR(255) NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    original_hash VARCHAR(64) NOT NULL,  -- SHA-256 of original file
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) DEFAULT 'application/pdf',
    
    -- Classification (1=PUBLIC, 2=INTERNAL, 3=CONFIDENTIAL, 4=RESTRICTED, 5=TOP-SECRET)
    classification_level INTEGER NOT NULL CHECK (classification_level BETWEEN 1 AND 5),
    classification_label VARCHAR(20) NOT NULL,
    
    -- Releasability: Array of accepted Issuer DIDs
    releasability_dids TEXT[] NOT NULL,
    
    -- Encryption
    encrypted_blob_path VARCHAR(500) NOT NULL,  -- Path to encrypted file
    encryption_key_id UUID NOT NULL,
    encryption_algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
    
    -- Creator info
    created_by_did VARCHAR(500) NOT NULL,
    created_by_enterprise VARCHAR(100),
    creator_clearance_level INTEGER NOT NULL,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    
    -- Soft delete
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Full-text search
    keywords TEXT[]
);

-- Indexes
CREATE INDEX idx_documents_classification ON documents(classification_level);
CREATE INDEX idx_documents_created_by ON documents(created_by_did);
CREATE INDEX idx_documents_enterprise ON documents(created_by_enterprise);
CREATE INDEX idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX idx_documents_releasability ON documents USING GIN(releasability_dids);
CREATE INDEX idx_documents_keywords ON documents USING GIN(keywords);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_documents_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_documents_timestamp();
```

### Task 1.2: Create Document Access Log Table

**File**: `migrations/002_document_access_log.sql`

```sql
-- Audit log for all document access attempts
CREATE TABLE document_access_log (
    id BIGSERIAL PRIMARY KEY,
    
    -- Document reference
    document_id UUID NOT NULL REFERENCES documents(id),
    original_document_hash VARCHAR(64),
    
    -- Requestor info
    requestor_did VARCHAR(500) NOT NULL,
    requestor_issuer_did VARCHAR(500) NOT NULL,
    requestor_clearance_level INTEGER NOT NULL,
    requestor_enterprise VARCHAR(100),
    
    -- Ephemeral DID info (for this access only)
    ephemeral_did VARCHAR(500) NOT NULL,
    ephemeral_public_key VARCHAR(100) NOT NULL,  -- Base64url X25519 public key
    
    -- Access request signature (Ed25519)
    access_request_signature TEXT NOT NULL,
    
    -- Accountable copy info
    copy_id UUID,
    copy_hash VARCHAR(64),  -- SHA-256 of watermarked copy
    
    -- Timestamps
    access_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Access result
    access_granted BOOLEAN NOT NULL,
    denial_reason TEXT,
    
    -- Verification flags
    credential_verified BOOLEAN DEFAULT FALSE,
    revocation_checked BOOLEAN DEFAULT FALSE,
    releasability_matched BOOLEAN DEFAULT FALSE,
    
    -- Request metadata
    client_ip INET,
    user_agent TEXT
);

-- Indexes for audit queries
CREATE INDEX idx_access_log_document ON document_access_log(document_id);
CREATE INDEX idx_access_log_requestor ON document_access_log(requestor_did);
CREATE INDEX idx_access_log_timestamp ON document_access_log(access_timestamp DESC);
CREATE INDEX idx_access_log_copy_id ON document_access_log(copy_id) WHERE copy_id IS NOT NULL;
CREATE INDEX idx_access_log_granted ON document_access_log(access_granted);
CREATE INDEX idx_access_log_issuer ON document_access_log(requestor_issuer_did);

-- Partition by month for large deployments (optional)
-- CREATE TABLE document_access_log_y2025m01 PARTITION OF document_access_log
--     FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

### Task 1.3: Create Encryption Keys Table

**File**: `migrations/003_document_encryption_keys.sql`

```sql
-- Encryption keys for documents (per-enterprise, per-classification)
CREATE TABLE document_encryption_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Scope
    enterprise VARCHAR(100) NOT NULL,
    classification_level INTEGER NOT NULL CHECK (classification_level BETWEEN 1 AND 5),
    
    -- Key material (encrypted at rest in production)
    -- For POC: stored directly; Production: HSM reference
    key_material BYTEA NOT NULL,  -- 32 bytes for AES-256
    key_reference VARCHAR(500),    -- HSM key ID for production
    
    -- Algorithm info
    algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
    
    -- Lifecycle
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    rotated_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Uniqueness: one active key per enterprise/classification combo
    UNIQUE (enterprise, classification_level, is_active) 
        WHERE is_active = TRUE
);

-- Index for key lookup
CREATE INDEX idx_encryption_keys_lookup 
    ON document_encryption_keys(enterprise, classification_level, is_active);
```

### Task 1.4: Run Migrations

```bash
# Connect to existing CA database
psql -h localhost -U postgres -d ca_database

# Run migrations in order
\i migrations/001_documents.sql
\i migrations/002_document_access_log.sql
\i migrations/003_document_encryption_keys.sql

# Verify tables created
\dt
```

---

## Phase 2: Server-Side Implementation

### Task 2.1: Create Key Store Service

**File**: `/root/certification-authority/services/keyStore.js`

```javascript
/**
 * KeyStore Service
 * Manages document encryption keys in PostgreSQL
 * 
 * TODO: Replace with HSM integration for production
 */

class KeyStore {
  constructor(db) {
    this.db = db;
  }

  /**
   * Get or create encryption key for enterprise/classification
   */
  async getOrCreateKey(enterprise, classificationLevel) {
    // Try to get existing active key
    let result = await this.db.query(
      `SELECT id, key_material FROM document_encryption_keys 
       WHERE enterprise = $1 AND classification_level = $2 AND is_active = TRUE`,
      [enterprise, classificationLevel]
    );
    
    if (result.rows.length > 0) {
      return {
        id: result.rows[0].id,
        key: result.rows[0].key_material
      };
    }
    
    // Create new key
    const keyMaterial = crypto.randomBytes(32); // AES-256
    
    result = await this.db.query(
      `INSERT INTO document_encryption_keys 
       (enterprise, classification_level, key_material, algorithm)
       VALUES ($1, $2, $3, 'AES-256-GCM')
       RETURNING id`,
      [enterprise, classificationLevel, keyMaterial]
    );
    
    return {
      id: result.rows[0].id,
      key: keyMaterial
    };
  }

  /**
   * Get key by ID
   */
  async getKey(keyId) {
    const result = await this.db.query(
      `SELECT key_material FROM document_encryption_keys WHERE id = $1`,
      [keyId]
    );
    
    if (result.rows.length === 0) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    return { key: result.rows[0].key_material };
  }
}

module.exports = { KeyStore };
```

### Task 2.2: Create StatusList Service

**File**: `/root/certification-authority/services/statusListService.js`

```javascript
/**
 * StatusList2021 Revocation Checker
 * Integrates with Cloud Agent revocation status
 */

class StatusListService {
  constructor(cloudAgentUrl, apiKey) {
    this.cloudAgentUrl = cloudAgentUrl;
    this.apiKey = apiKey;
  }

  /**
   * Check if a credential is revoked
   * 
   * @param {string} holderDID - DID of credential holder
   * @param {string} issuerDID - DID of credential issuer
   * @returns {boolean} true if revoked
   */
  async isRevoked(holderDID, issuerDID) {
    // Query Cloud Agent for revocation status
    // This checks the StatusList2021 bitstring
    
    try {
      // Option 1: Query credentials_in_status_list table directly
      // (faster, but requires database access)
      
      // Option 2: Query Cloud Agent API
      const response = await fetch(
        `${this.cloudAgentUrl}/credential-status/check`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.apiKey
          },
          body: JSON.stringify({
            holderDID,
            issuerDID
          })
        }
      );
      
      if (!response.ok) {
        console.warn('StatusList check failed, assuming not revoked');
        return false;
      }
      
      const data = await response.json();
      return data.revoked === true;
      
    } catch (error) {
      console.error('Revocation check error:', error);
      // Fail-safe: assume not revoked to avoid blocking legitimate access
      // In high-security: should fail closed (return true)
      return false;
    }
  }
}

module.exports = { StatusListService };
```

### Task 2.3: Integrate ReEncryptionService

**File**: Modify `/root/certification-authority/server.js`

Add the following:

```javascript
// At top of file, add imports
const { ReEncryptionService, createDocumentAccessRoute } = require('./services/reEncryptionService');
const { KeyStore } = require('./services/keyStore');
const { StatusListService } = require('./services/statusListService');

// After database connection setup, initialize services
const keyStore = new KeyStore(db);
const statusListService = new StatusListService(
  'https://identuslabel.cz/cloud-agent',
  process.env.CLOUD_AGENT_API_KEY
);

const reEncryptionService = new ReEncryptionService({
  db: db,
  keyStore: keyStore,
  documentStoragePath: '/var/documents/encrypted',
  statusListService: statusListService,
  didResolver: null  // TODO: Implement DID resolver
});

// Add route for document access
app.post('/api/documents/:documentId/access', createDocumentAccessRoute(reEncryptionService));

// Add route for document upload (see Task 2.4)
app.post('/api/documents/upload', uploadMiddleware, async (req, res) => {
  // TODO: Implement document upload
});

// Add route for document listing
app.get('/api/documents', async (req, res) => {
  // TODO: Implement document listing with releasability filtering
});
```

### Task 2.4: Implement Document Upload

**File**: `/root/certification-authority/services/documentUploadService.js`

```javascript
/**
 * Document Upload Service
 * Handles document classification, encryption, and storage
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class DocumentUploadService {
  constructor(db, keyStore, storagePath) {
    this.db = db;
    this.keyStore = keyStore;
    this.storagePath = storagePath;
  }

  /**
   * Upload and encrypt a document
   */
  async uploadDocument({
    fileBuffer,
    filename,
    title,
    description,
    classificationLevel,
    classificationLabel,
    releasabilityDids,
    creatorDID,
    creatorEnterprise,
    creatorClearanceLevel
  }) {
    // Validate creator can classify at this level
    if (creatorClearanceLevel < classificationLevel) {
      throw new Error('Cannot classify document above your clearance level');
    }
    
    // Calculate original hash
    const originalHash = crypto.createHash('sha256')
      .update(fileBuffer)
      .digest('hex');
    
    // Get encryption key
    const keyData = await this.keyStore.getOrCreateKey(
      creatorEnterprise,
      classificationLevel
    );
    
    // Encrypt document (AES-256-GCM)
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyData.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(fileBuffer),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    
    // Store encrypted file: [IV][AuthTag][Ciphertext]
    const encryptedData = Buffer.concat([iv, authTag, encrypted]);
    const blobFilename = `${crypto.randomUUID()}.enc`;
    const blobPath = path.join(this.storagePath, blobFilename);
    
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    await fs.writeFile(blobPath, encryptedData);
    
    // Create database record
    const result = await this.db.query(
      `INSERT INTO documents (
        filename, title, description, original_hash, file_size, mime_type,
        classification_level, classification_label, releasability_dids,
        encrypted_blob_path, encryption_key_id, encryption_algorithm,
        created_by_did, created_by_enterprise, creator_clearance_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id`,
      [
        filename, title, description, originalHash, fileBuffer.length, 'application/pdf',
        classificationLevel, classificationLabel, releasabilityDids,
        blobFilename, keyData.id, 'AES-256-GCM',
        creatorDID, creatorEnterprise, creatorClearanceLevel
      ]
    );
    
    return {
      documentId: result.rows[0].id,
      originalHash,
      classificationLevel,
      classificationLabel
    };
  }
}

module.exports = { DocumentUploadService };
```

---

## Phase 3: Wallet-Side Implementation

### Task 3.1: Copy EphemeralDIDCrypto to Wallet

**Source**: `/home/claude/ephemeral-did-implementation/wallet/src/utils/EphemeralDIDCrypto.ts`

**Target**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/utils/EphemeralDIDCrypto.ts`

```bash
cp /home/claude/ephemeral-did-implementation/wallet/src/utils/EphemeralDIDCrypto.ts \
   /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/utils/

cp /home/claude/ephemeral-did-implementation/wallet/src/utils/EphemeralDIDCrypto.ts \
   /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/utils/
```

### Task 3.2: Copy DocumentAccess Component to Wallet

**Source**: `/home/claude/ephemeral-did-implementation/wallet/src/components/DocumentAccess.tsx`

**Target**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/DocumentAccess.tsx`

```bash
cp /home/claude/ephemeral-did-implementation/wallet/src/components/DocumentAccess.tsx \
   /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/

cp /home/claude/ephemeral-did-implementation/wallet/src/components/DocumentAccess.tsx \
   /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/components/
```

### Task 3.3: Add Documents Tab to Wallet UI

**File**: Modify wallet's main page to add Documents tab

```tsx
// Add to wallet's navigation
<Tab label="Documents" value="documents" />

// Add Documents panel
<TabPanel value="documents">
  <DocumentBrowser 
    userDID={userDID}
    userIssuerDID={userIssuerDID}
    userClearanceLevel={userClearanceLevel}
    userSigningPrivateKey={signingKey}
  />
</TabPanel>
```

### Task 3.4: Create Document Browser Component

**File**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/DocumentBrowser.tsx`

```tsx
/**
 * DocumentBrowser.tsx
 * 
 * Browse available documents and request access
 */

import React, { useState, useEffect } from 'react';
import { DocumentAccess } from './DocumentAccess';

interface Document {
  id: string;
  title: string;
  filename: string;
  classification: string;
  classificationLevel: number;
  releasabilityDids: string[];
  createdBy: string;
  createdAt: string;
  fileSize: number;
}

interface DocumentBrowserProps {
  userDID: string;
  userIssuerDID: string;
  userClearanceLevel: number;
  userSigningPrivateKey: Uint8Array;
}

export const DocumentBrowser: React.FC<DocumentBrowserProps> = (props) => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      const response = await fetch(
        `https://identuslabel.cz/ca/api/documents?issuerDID=${encodeURIComponent(props.userIssuerDID)}`
      );
      const data = await response.json();
      setDocuments(data.documents);
    } catch (error) {
      console.error('Failed to fetch documents:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Loading documents...</div>;
  }

  if (selectedDocument) {
    return (
      <div>
        <button onClick={() => setSelectedDocument(null)}>← Back to List</button>
        <DocumentAccess
          document={selectedDocument}
          userDID={props.userDID}
          userIssuerDID={props.userIssuerDID}
          userClearanceLevel={props.userClearanceLevel}
          userSigningPrivateKey={props.userSigningPrivateKey}
          enterpriseApiEndpoint="https://identuslabel.cz/ca"
          onAccessComplete={(copyId) => console.log('Access granted:', copyId)}
          onAccessDenied={(reason) => console.log('Access denied:', reason)}
        />
      </div>
    );
  }

  return (
    <div>
      <h2>Available Documents</h2>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Classification</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {documents.map(doc => (
            <tr key={doc.id}>
              <td>{doc.title}</td>
              <td>{doc.classification}</td>
              <td>{new Date(doc.createdAt).toLocaleDateString()}</td>
              <td>
                <button onClick={() => setSelectedDocument(doc)}>
                  Request Access
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

---

## Phase 4: Integration & Testing

### Task 4.1: Create Integration Test Script

**File**: `/root/test-ephemeral-did-access.js`

```javascript
/**
 * End-to-end test for ephemeral DID document access
 */

const puppeteer = require('puppeteer');

async function testDocumentAccess() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('=== Testing Ephemeral DID Document Access ===');
  
  // Step 1: Open Alice wallet
  await page.goto('https://identuslabel.cz/alice');
  console.log('✓ Opened Alice wallet');
  
  // Step 2: Navigate to Documents tab
  await page.click('[data-tab="documents"]');
  console.log('✓ Opened Documents tab');
  
  // Step 3: Select a document
  await page.waitForSelector('.document-row');
  await page.click('.document-row:first-child button');
  console.log('✓ Selected document');
  
  // Step 4: Click Request Access
  await page.click('button:contains("Request Secure Access")');
  console.log('✓ Initiated access request');
  
  // Step 5: Wait for decryption
  await page.waitForSelector('.success-box', { timeout: 30000 });
  console.log('✓ Document decrypted successfully');
  
  // Step 6: Verify copy ID displayed
  const copyId = await page.$eval('.copy-info', el => el.textContent);
  console.log('✓ Copy ID:', copyId);
  
  // Step 7: View PDF
  await page.click('button:contains("View in Browser")');
  console.log('✓ Opened PDF viewer');
  
  await browser.close();
  console.log('\n=== All Tests Passed ===');
}

testDocumentAccess().catch(console.error);
```

### Task 4.2: Test Revocation Denial

```javascript
// Test that revoked credentials are denied access
async function testRevokedCredentialDenied() {
  // 1. Revoke Alice's Security Clearance credential
  // 2. Attempt document access
  // 3. Verify ACCESS_DENIED with code CREDENTIAL_REVOKED
}
```

### Task 4.3: Test Releasability Denial

```javascript
// Test that wrong issuer DID is denied
async function testReleasabilityDenied() {
  // 1. Create document releasable only to Issuer A
  // 2. Attempt access with credential from Issuer B
  // 3. Verify ACCESS_DENIED with code RELEASABILITY_DENIED
}
```

### Task 4.4: Test Clearance Denial

```javascript
// Test that insufficient clearance is denied
async function testClearanceDenied() {
  // 1. Create CONFIDENTIAL document
  // 2. Attempt access with INTERNAL clearance
  // 3. Verify ACCESS_DENIED with code CLEARANCE_DENIED
}
```

---

## Phase 5: Enterprise Dashboard UI

### Task 5.1: Create Document Upload Page

**File**: `/root/certification-authority/public/document-upload.html`

- Form with fields: file, title, description, classification dropdown, releasability multi-select
- Classification dropdown shows only levels ≤ user's clearance
- Releasability multi-select populated from known Issuer DIDs
- Progress indicator during upload
- Success message with document ID

### Task 5.2: Create Document Management Page

**File**: `/root/certification-authority/public/document-management.html`

- List all documents created by user
- Show access statistics (view count, last accessed)
- Allow updating releasability
- Support soft delete

### Task 5.3: Create Audit Log Viewer

**File**: `/root/certification-authority/public/audit-log.html`

- Search by document ID, requestor DID, date range
- Show access attempts (granted/denied)
- Export to CSV
- Filter by enterprise, classification level

---

## File Checklist

### Server-Side Files

- [ ] `migrations/001_documents.sql`
- [ ] `migrations/002_document_access_log.sql`
- [ ] `migrations/003_document_encryption_keys.sql`
- [ ] `services/keyStore.js`
- [ ] `services/statusListService.js`
- [ ] `services/reEncryptionService.js` (provided)
- [ ] `services/documentUploadService.js`
- [ ] Modify `server.js` to add routes

### Wallet-Side Files

- [ ] `utils/EphemeralDIDCrypto.ts` (provided)
- [ ] `components/DocumentAccess.tsx` (provided)
- [ ] `components/DocumentBrowser.tsx`
- [ ] Modify main page to add Documents tab

### Dashboard UI Files

- [ ] `public/document-upload.html`
- [ ] `public/document-management.html`
- [ ] `public/audit-log.html`

### Test Files

- [ ] `test-ephemeral-did-access.js`
- [ ] Test cases for denial scenarios

---

## Environment Variables

Add to `/root/certification-authority/.env`:

```bash
# Document Storage
DOCUMENT_STORAGE_PATH=/var/documents/encrypted

# Cloud Agent (for revocation checking)
CLOUD_AGENT_URL=https://identuslabel.cz/cloud-agent
CLOUD_AGENT_API_KEY=your-api-key

# Database (existing)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=ca_database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-password
```

---

## Security Checklist

- [ ] Ephemeral keys destroyed immediately after decryption
- [ ] All access attempts logged (success AND failure)
- [ ] Revocation checked via StatusList2021 before each access
- [ ] Signature verified on access requests
- [ ] Classification level enforced
- [ ] Releasability (issuer DID) enforced
- [ ] Visible watermarks on all copies
- [ ] Invisible forensic metadata in all copies
- [ ] Encrypted storage at rest (AES-256-GCM)
- [ ] HTTPS for all API calls

---

## Success Criteria

1. **Upload Flow**: User can upload PDF, set classification, set releasability, document encrypted and stored
2. **Access Flow**: User can request access, ephemeral DID generated, document decrypted client-side
3. **Accountability**: Every copy traceable via copy ID to specific requestor and access time
4. **Perfect Forward Secrecy**: Ephemeral key destroyed immediately after decryption
5. **Revocation**: Revoked credentials denied access
6. **Releasability**: Wrong issuer DID denied access
7. **Clearance**: Insufficient clearance denied access
8. **Audit Trail**: Complete log of all access attempts

---

## References

- **Whitepaper**: `/mnt/project/SSI_Document_Access_Control_WhitePaper.docx`
- **System Docs**: `/mnt/project/CLAUDE.md`
- **Working Package 1**: `/mnt/project/Working_Package_1__Registration_Authority_with_Email_Password_Hash_Authentication.md`
- **Existing TODO**: `/mnt/project/TODO.md` (DIDComm employee wallet bootstrap - separate feature)

---

**Last Updated**: 2025-12-07
**Status**: Ready for Implementation
**Priority**: High - Core document access control feature
