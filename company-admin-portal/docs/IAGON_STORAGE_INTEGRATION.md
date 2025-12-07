# Iagon Decentralized Storage Integration - Technical Reference

**Document Version**: 2.0
**Last Updated**: December 7, 2025
**Status**: Production Ready - Verified December 6, 2025
**Tested On**: Iagon Public Gateway v2 API

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Configuration](#configuration)
4. [API Endpoints Reference](#api-endpoints-reference)
5. [File ID Management](#file-id-management)
6. [Encryption](#encryption)
7. [Error Handling](#error-handling)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Architecture](#architecture)

---

## Overview

The Iagon Storage Integration provides decentralized file storage for the Document DID Management System. Documents are stored on Iagon's decentralized network and linked to blockchain-anchored PRISM DIDs, creating a permanent, verifiable record of document existence and ownership.

### Key Features

- **Decentralized Storage**: Files stored across Iagon's distributed network
- **Classification-Based Encryption**: Two-layer security model based on document classification
- **Content Integrity**: SHA-256 hash verification for all uploads/downloads
- **Retry Logic**: Exponential backoff for resilient operations (3 attempts)
- **DID Integration**: Documents linked to PRISM DIDs via Enterprise Cloud Agent
- **Clearance-Based Access**: Progressive disclosure based on security clearance levels

### Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| `IagonStorageClient` | `/root/company-admin-portal/lib/IagonStorageClient.js` | Core API client for Iagon storage operations |
| `EnterpriseDocumentManager` | `/root/company-admin-portal/lib/EnterpriseDocumentManager.js` | Document DID creation with Iagon storage |
| `DocumentRegistry` | `/root/company-admin-portal/lib/DocumentRegistry.js` | Zero-knowledge document registry with Bloom filters |

---

## Architecture

### System Flow

```
                                    +---------------------+
                                    |  Employee Portal    |
                                    |  (Browser UI)       |
                                    +----------+----------+
                                               |
                                               v
+---------------------------+       +----------+----------+
|  Iagon Decentralized      |<----->|  Company Admin      |
|  Storage Network          |       |  Portal (Node.js)   |
|  (gw.iagon.com)           |       +----------+----------+
+---------------------------+                  |
                                               v
                            +------------------+------------------+
                            |                                     |
                   +--------v--------+               +------------v-----------+
                   |  Enterprise     |               |  Document Registry     |
                   |  Cloud Agent    |               |  (In-Memory + JSON)    |
                   |  (Port 8200)    |               +------------------------+
                   +--------+--------+
                            |
                            v
                   +--------+--------+
                   |  PRISM Node     |
                   |  (Blockchain)   |
                   +--------+--------+
```

### Data Flow: Document Upload

1. **Employee uploads document** via Employee Portal
2. **Classification check** determines encryption requirement
3. **Pre-encryption** (AES-256-GCM) for CONFIDENTIAL+ documents
4. **Upload to Iagon** via `POST /storage/upload`
5. **File ID captured** from response (`data._id`)
6. **DID creation** via Enterprise Cloud Agent
7. **Blockchain publication** (30-60 seconds)
8. **Registry entry** created with Iagon metadata

### Data Flow: Document Download

1. **Clearance verification** via Security Clearance VP
2. **Registry query** with Bloom filter check
3. **Download from Iagon** via `POST /storage/download` with file ID
4. **Decryption** using stored encryption metadata
5. **Content verification** via SHA-256 hash comparison

---

## Configuration and Setup

### Environment Variables

Add the following to `/root/company-admin-portal/.env`:

```bash
# REQUIRED: Iagon API Access Token
# Generate at: https://app.iagon.com/ -> Settings -> "Generate Token"
IAGON_ACCESS_TOKEN=your-iagon-access-token-here

# REQUIRED: Your Iagon storage node ID
# Obtained after registering a storage node
IAGON_NODE_ID=your-iagon-node-id-here

# Optional: Override default download base URL
# Default: https://gw.iagon.com/api/v2
# IAGON_DOWNLOAD_BASE_URL=https://gw.iagon.com/api/v2
```

### Obtaining Credentials

1. **Create Iagon Account**: Visit https://app.iagon.com/
2. **Generate Access Token**:
   - Navigate to Settings
   - Click "Generate Token"
   - Copy the token securely
3. **Register Storage Node**:
   - Follow Iagon documentation to register a node
   - Note the Node ID after registration

### Verification

Test the configuration:

```bash
cd /root/company-admin-portal
node -e "
const { getIagonClient } = require('./lib/IagonStorageClient');
const client = getIagonClient();
client.testConnection().then(console.log);
"
```

Expected output:
```javascript
{
  configured: true,
  connected: true,
  nodeId: 'your-node-id',
  downloadBaseUrl: 'https://gw.iagon.com/api/v2',
  note: 'Iagon gateway reachable'
}
```

---

## API Reference

### IagonStorageClient

The main client class for interacting with Iagon storage.

#### Constructor

```javascript
const { IagonStorageClient } = require('./lib/IagonStorageClient');

const client = new IagonStorageClient({
  accessToken: process.env.IAGON_ACCESS_TOKEN,  // Required
  nodeId: process.env.IAGON_NODE_ID,            // Required
  downloadBaseUrl: 'https://gw.iagon.com/api/v2', // Optional
  maxRetries: 3,           // Optional: default 3
  retryDelay: 1000,        // Optional: default 1000ms
  maxFileSize: 40 * 1024 * 1024  // Optional: default 40MB
});
```

#### Methods

##### `uploadFile(fileContent, filename, options)`

Upload a file to Iagon storage with optional encryption.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileContent` | `Buffer` | Yes | File content as Buffer |
| `filename` | `string` | Yes | Filename for storage |
| `options.classificationLevel` | `string` | No | `UNCLASSIFIED`, `CONFIDENTIAL`, `SECRET`, or `TOP_SECRET` |

**Returns:** `Promise<Object>`
```javascript
{
  success: true,
  filename: 'doc_abc123_v1.pdf',
  nodeId: 'your-node-id',
  fileId: '507f1f77bcf86cd799439011',  // Iagon file ID for downloads
  contentHash: 'sha256:abc123...',
  encryptionInfo: {
    algorithm: 'AES-256-GCM' | 'none',
    keyId: 'key-fingerprint',
    key: 'base64-encoded-key',    // Only for encrypted uploads
    iv: 'base64-encoded-iv',
    authTag: 'base64-encoded-tag'
  },
  iagonUrl: 'https://gw.iagon.com/api/v2/download?nodeId=...',
  uploadedAt: '2025-12-06T10:00:00.000Z',
  fileSize: 1024,      // Encrypted size
  originalSize: 1000   // Original size
}
```

##### `downloadFile(fileId, encryptionInfo)`

Download and optionally decrypt a file from Iagon storage.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileId` | `string` | Yes | File ID from upload response |
| `encryptionInfo` | `Object` | No | Encryption metadata for decryption |

**Returns:** `Promise<Buffer>` - Decrypted file content

##### `calculateContentHash(content)`

Calculate SHA-256 hash of content.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `Buffer` | Yes | Content to hash |

**Returns:** `string` - Hash in format `sha256:hexdigest`

##### `generateFilename(documentDID, contentHash, version, extension)`

Generate a unique filename for Iagon storage.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `documentDID` | `string` | - | PRISM DID |
| `contentHash` | `string` | - | Content hash (hex) |
| `version` | `number` | `1` | Version number |
| `extension` | `string` | `'dat'` | File extension |

**Returns:** `string` - Format: `{shortDID}_{contentHash8}_v{version}.{extension}`

##### `isConfigured()`

Check if Iagon credentials are configured.

**Returns:** `boolean`

##### `testConnection()`

Validate Iagon connectivity.

**Returns:** `Promise<Object>`
```javascript
{
  configured: boolean,
  connected: boolean,
  nodeId: string,
  downloadBaseUrl: string,
  error?: string,        // If connection failed
  errorType?: 'DNS_RESOLUTION' | 'NETWORK' | 'API'
}
```

### Iagon REST API Endpoints

These are the verified Iagon API endpoints (as of December 6, 2025):

| Operation | Method | Endpoint | Body |
|-----------|--------|----------|------|
| Upload | `POST` | `https://gw.iagon.com/api/v2/storage/upload` | `multipart/form-data` |
| Download | `POST` | `https://gw.iagon.com/api/v2/storage/download` | `{ "id": fileId, "files": [fileId] }` |
| Directory | `GET` | `https://gw.iagon.com/api/v2/storage/directory?visibility=public` | - |

**Authentication**: All requests require `x-api-key` header with access token.

**Upload Form Fields:**
- `file`: File content (binary)
- `node_id`: Storage node ID

---

## Security Model

### Encryption Strategy

The integration implements a two-layer encryption model based on document classification:

```
+-------------------+------------------+------------------+
| Classification    | Pre-Encryption   | Iagon Encryption |
+-------------------+------------------+------------------+
| UNCLASSIFIED      | None             | Yes (default)    |
| CONFIDENTIAL      | AES-256-GCM      | Yes (default)    |
| SECRET            | AES-256-GCM      | Yes (default)    |
| TOP_SECRET        | AES-256-GCM      | Yes (default)    |
+-------------------+------------------+------------------+
```

### Layer 1: Application-Level Encryption (AES-256-GCM)

For documents classified CONFIDENTIAL or higher:

1. **Key Generation**: 256-bit random key per document
2. **IV Generation**: 96-bit random IV (GCM standard)
3. **Encryption**: AES-256-GCM authenticated encryption
4. **Authentication Tag**: 128-bit tag for integrity verification

```javascript
// Encryption metadata structure
encryptionInfo: {
  algorithm: 'AES-256-GCM',
  keyId: '16-char-fingerprint',
  key: 'base64-encoded-256-bit-key',
  iv: 'base64-encoded-96-bit-iv',
  authTag: 'base64-encoded-128-bit-tag'
}
```

### Layer 2: Iagon Network Encryption

All files stored on Iagon are encrypted by the network using their default encryption. This provides an additional layer of protection at the storage level.

### Key Storage

Encryption keys are stored in the `DocumentRegistry` alongside document metadata:

```javascript
documentRecord: {
  documentDID: 'did:prism:...',
  iagonStorage: {
    fileId: '...',
    encryptionInfo: { ... }  // Keys stored here
  }
}
```

**Security Considerations:**
- Keys are stored in the same system as file references
- Production deployment should use HSM or external key management
- Consider implementing key rotation for long-term storage

### Access Control

Access to documents is controlled by:

1. **Security Clearance Level**: Employee must have sufficient clearance
2. **Company Affiliation**: Employee's company must be in `releasableTo` list
3. **Bloom Filter**: Privacy-preserving initial lookup

```
Clearance Hierarchy:
UNCLASSIFIED < CONFIDENTIAL < SECRET < TOP_SECRET
```

---

## Usage Examples

### Basic Upload and Download

```javascript
const { IagonStorageClient } = require('./lib/IagonStorageClient');

// Initialize client
const client = new IagonStorageClient({
  accessToken: process.env.IAGON_ACCESS_TOKEN,
  nodeId: process.env.IAGON_NODE_ID
});

// Upload a file
const content = Buffer.from('Hello, Iagon!');
const result = await client.uploadFile(content, 'hello.txt', {
  classificationLevel: 'UNCLASSIFIED'
});

console.log('File ID:', result.fileId);
console.log('Content Hash:', result.contentHash);

// Download the file
const downloaded = await client.downloadFile(
  result.fileId,
  result.encryptionInfo
);

console.log('Downloaded:', downloaded.toString());
```

### Encrypted Document Upload

```javascript
// Upload a CONFIDENTIAL document (auto-encrypted)
const confidentialDoc = Buffer.from('Sensitive information');
const result = await client.uploadFile(confidentialDoc, 'sensitive.pdf', {
  classificationLevel: 'CONFIDENTIAL'
});

console.log('Encryption Algorithm:', result.encryptionInfo.algorithm);
// Output: 'AES-256-GCM'

// Download and decrypt
const decrypted = await client.downloadFile(
  result.fileId,
  result.encryptionInfo
);
```

### Using the Singleton Pattern

```javascript
const { getIagonClient } = require('./lib/IagonStorageClient');

// Get singleton instance (auto-configured from environment)
const client = getIagonClient();

// Use client...
const status = await client.testConnection();
```

---

## Document DID Integration

The `EnterpriseDocumentManager` combines Iagon storage with PRISM DID creation.

### Creating a Document DID with Storage

```javascript
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');

const manager = new EnterpriseDocumentManager(
  'http://91.99.4.54:8200',  // Enterprise Cloud Agent URL
  'optional-api-key'
);

// Create document with Iagon storage
const result = await manager.createDocumentDIDWithStorage(
  'HR',  // Department
  {
    title: 'Employee Handbook 2025',
    description: 'Updated company policies',
    classificationLevel: 'CONFIDENTIAL'
  },
  fileBuffer,          // Document content
  'handbook.pdf'       // Original filename
);

console.log('Document DID:', result.documentDID);
console.log('Iagon File ID:', result.iagonStorage.fileId);
console.log('Operation ID:', result.operationId);  // Blockchain publication
```

### Result Structure

```javascript
{
  documentDID: 'did:prism:abc123...',
  operationId: 'pub-operation-id',
  iagonStorage: {
    nodeId: 'node-id',
    filename: 'abc123_def456_v1.pdf',
    fileId: '507f1f77bcf86cd799439011',
    url: 'https://gw.iagon.com/api/v2/download?...',
    contentHash: 'sha256:...',
    encryptionInfo: { ... },
    uploadedAt: '2025-12-06T10:00:00.000Z',
    fileSize: 2048,
    originalSize: 2000
  },
  metadata: {
    title: 'Employee Handbook 2025',
    description: 'Updated company policies',
    classificationLevel: 'CONFIDENTIAL',
    department: 'HR',
    createdAt: '2025-12-06T10:00:00.000Z'
  }
}
```

### Downloading a Document

```javascript
const iagonStorage = documentRecord.iagonStorage;  // From DocumentRegistry

const content = await manager.downloadDocument(iagonStorage);
console.log('Downloaded:', content.length, 'bytes');
```

---

## Troubleshooting

### Common Issues

#### 1. "Iagon storage not configured"

**Symptom:** Upload/download operations fail with configuration error

**Cause:** Missing `IAGON_ACCESS_TOKEN` or `IAGON_NODE_ID`

**Solution:**
```bash
# Check current configuration
node -e "console.log('Token:', process.env.IAGON_ACCESS_TOKEN ? 'SET' : 'MISSING')"
node -e "console.log('Node:', process.env.IAGON_NODE_ID ? 'SET' : 'MISSING')"

# Ensure .env is loaded
source /root/company-admin-portal/.env
```

#### 2. Upload Returns 404

**Symptom:** `POST /storage/upload` returns 404 Not Found

**Cause:** Using incorrect endpoint (e.g., `/storage/region/upload/{viewPermission}`)

**Solution:** Use the verified endpoint:
```javascript
const uploadUrl = 'https://gw.iagon.com/api/v2/storage/upload';
```

#### 3. Download Returns Empty or Corrupt Data

**Symptom:** Downloaded file is empty or decryption fails

**Cause:** Using GET instead of POST for download, or missing file ID

**Solution:**
```javascript
// Correct download method
const response = await axios.post(
  'https://gw.iagon.com/api/v2/storage/download',
  { id: fileId, files: [fileId] },
  {
    headers: {
      'x-api-key': accessToken,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer'
  }
);
```

#### 4. Decryption Error: "Unsupported state or unable to authenticate"

**Symptom:** GCM authentication fails during decryption

**Cause:** Encryption metadata mismatch or corrupted data

**Solution:**
- Verify `encryptionInfo` is passed correctly from upload result
- Check content hash matches original
- Ensure no data modification during transit

#### 5. Connection Timeout

**Symptom:** Operations fail after 120 seconds

**Cause:** Network issues or Iagon service unavailable

**Solution:**
- Check Iagon status at https://status.iagon.com/
- Verify network connectivity: `curl -I https://gw.iagon.com`
- Retry logic handles transient failures automatically (3 attempts)

### Diagnostic Commands

```bash
# Test Iagon connectivity
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-api-key: $IAGON_ACCESS_TOKEN" \
  https://gw.iagon.com/api/v2/storage/directory?visibility=public

# Run end-to-end test
cd /root/company-admin-portal
node test-iagon-e2e.js

# Check client configuration
node -e "
const { getIagonClient } = require('./lib/IagonStorageClient');
getIagonClient().testConnection().then(r => console.log(JSON.stringify(r, null, 2)));
"
```

### Log Analysis

Iagon operations are logged with the `[IagonStorageClient]` prefix:

```bash
# Watch upload/download operations
tail -f /tmp/company-admin.log | grep IagonStorageClient

# Example log output:
# [IagonStorageClient] Upload attempt 1/3 for doc_abc123_v1.pdf
# [IagonStorageClient] Upload successful: doc_abc123_v1.pdf
# [IagonStorageClient] Download attempt 1/3 for file 507f1f77bcf86cd799439011
# [IagonStorageClient] Download and decryption successful: 507f1f77bcf86cd799439011
```

---

## Known Limitations

### 1. Private Storage Not Supported via API

**Description:** Iagon private storage requires Cardano wallet authentication using CIP8 message signing. This cannot be performed server-side with an API token.

**Impact:** All documents are stored with public visibility on Iagon (but with application-level encryption for classified documents).

**Workaround:** Use application-level encryption (AES-256-GCM) for CONFIDENTIAL+ documents.

### 2. Maximum File Size: 40MB

**Description:** Iagon API limits individual file uploads to 40MB.

**Impact:** Large documents must be split or compressed.

**Workaround:** Implement file chunking for documents exceeding 40MB.

### 3. File ID Required for Download

**Description:** Downloads require the file ID returned from the upload response. The legacy URL-based download method is not reliable.

**Impact:** Documents uploaded before file ID capture was implemented cannot be downloaded.

**Workaround:** Re-upload affected documents to capture file IDs.

### 4. No Direct File Deletion API Verified

**Description:** File deletion endpoint behavior is not fully verified.

**Impact:** Deleting files from Iagon may not work as expected.

**Workaround:** Manage document lifecycle through the DocumentRegistry (soft delete).

### 5. Encryption Keys Stored with Metadata

**Description:** AES-256-GCM keys are stored in the DocumentRegistry alongside file references.

**Impact:** Compromising the registry exposes encryption keys.

**Recommendation:** For production, implement external key management (HSM, AWS KMS, etc.).

---

## Testing

### End-to-End Test Suite

Run the comprehensive test:

```bash
cd /root/company-admin-portal
source .env
node test-iagon-e2e.js
```

### Test Coverage

The test suite validates:

| Test | Description | Status |
|------|-------------|--------|
| Upload with file ID capture | Verify file ID is returned | WORKING |
| Download using file ID | Retrieve file by ID | WORKING |
| Content integrity verification | SHA-256 hash comparison | WORKING |
| Encrypted document round-trip | Upload, download, decrypt | WORKING |

### Expected Output

```
=== Iagon Storage End-to-End Test ===

[check] Iagon client configured
   Node ID: your-node-id
   Download Base URL: https://gw.iagon.com/api/v2

[document] Test document: iagon-e2e-test-1733490000000.txt
   Size: 85 bytes

[upload] Step 1: Uploading file to Iagon...
[check] Upload successful!
   File ID: 507f1f77bcf86cd799439011
   Content Hash: sha256:abc123...

[download] Step 2: Downloading file using file ID...
[check] Download successful!
   Downloaded Size: 85 bytes

[search] Step 3: Verifying content integrity...
[check] Content verification PASSED!

[upload] Step 4: Testing encrypted document upload (CONFIDENTIAL)...
[check] Encrypted upload successful!
   Encryption Algorithm: AES-256-GCM

[download] Step 5: Downloading and decrypting encrypted file...
[check] Encrypted document round-trip PASSED!

==================================================
[celebrate] ALL TESTS PASSED!
==================================================

Summary:
  [check] Upload with file ID capture: WORKING
  [check] Download using file ID: WORKING
  [check] Content integrity verification: WORKING
  [check] Encrypted document round-trip: WORKING
```

---

## Appendix: API Request/Response Examples

### Upload Request

```http
POST /api/v2/storage/upload HTTP/1.1
Host: gw.iagon.com
x-api-key: your-access-token
Content-Type: multipart/form-data; boundary=----FormBoundary

------FormBoundary
Content-Disposition: form-data; name="file"; filename="document.pdf"
Content-Type: application/octet-stream

[binary content]
------FormBoundary
Content-Disposition: form-data; name="node_id"

your-node-id
------FormBoundary--
```

### Upload Response

```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "name": "document.pdf",
    "size": 1024,
    "createdAt": "2025-12-06T10:00:00.000Z"
  }
}
```

### Download Request

```http
POST /api/v2/storage/download HTTP/1.1
Host: gw.iagon.com
x-api-key: your-access-token
Content-Type: application/json

{
  "id": "507f1f77bcf86cd799439011",
  "files": ["507f1f77bcf86cd799439011"]
}
```

### Download Response

Binary file content (arraybuffer)

---

## References

- Iagon API Documentation: https://api.docs.iagon.com/
- Iagon Platform: https://app.iagon.com/
- AES-GCM (NIST SP 800-38D): https://csrc.nist.gov/publications/detail/sp/800-38d/final
- W3C Decentralized Identifiers: https://www.w3.org/TR/did-core/

---

**Document Maintainer**: Hyperledger Identus SSI Infrastructure Team
**Related Files**:
- `/root/company-admin-portal/lib/IagonStorageClient.js`
- `/root/company-admin-portal/lib/EnterpriseDocumentManager.js`
- `/root/company-admin-portal/lib/DocumentRegistry.js`
- `/root/company-admin-portal/test-iagon-e2e.js`
