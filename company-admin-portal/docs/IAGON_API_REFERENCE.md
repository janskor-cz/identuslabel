# Iagon Storage API Reference

**Version**: 1.0.0
**Last Updated**: December 7, 2025
**Status**: Production Ready

---

## Table of Contents

1. [Overview](#overview)
2. [Configuration](#configuration)
3. [IagonStorageClient API](#iagonstorageclient-api)
4. [EnterpriseDocumentManager API](#enterprisedocumentmanager-api)
5. [REST API Endpoints](#rest-api-endpoints)
6. [Data Models](#data-models)
7. [Error Handling](#error-handling)
8. [Code Examples](#code-examples)

---

## Overview

The Iagon Storage integration provides decentralized file storage capabilities for the Company Admin Portal. Documents uploaded through the Employee Portal are stored on the Iagon decentralized network with automatic encryption based on classification level.

### Key Features

- **Decentralized Storage**: Files stored on Iagon distributed storage network
- **Automatic Encryption**: AES-256-GCM encryption for classified documents
- **Classification-Based Access**: Clearance-based document disclosure
- **Content Integrity**: SHA-256 content hashing and verification
- **Large File Support**: Up to 40MB file size limit (Iagon constraint)
- **Automatic Retry**: Exponential backoff retry logic for reliability

### Architecture

```
Employee Portal → Company Admin Portal → IagonStorageClient → Iagon API
                                      ↓
                           EnterpriseDocumentManager
                                      ↓
                              DocumentRegistry
```

---

## Configuration

### Environment Variables

Configuration is managed through environment variables. Copy `.env.example` to `.env` and configure:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IAGON_ACCESS_TOKEN` | **Yes** | - | API access token from Iagon dashboard |
| `IAGON_NODE_ID` | **Yes** | - | Your Iagon storage node ID |
| `IAGON_TUNNELING_URL` | No | - | Custom tunneling URL for storage node uploads |
| `IAGON_DOWNLOAD_BASE_URL` | No | `https://gw.iagon.com/api/v2` | Iagon API base URL |

### Obtaining Credentials

1. **Access Token**: Visit https://app.iagon.com/ → Settings → "Generate Token"
2. **Node ID**: Obtained after registering a storage node at https://app.iagon.com/

### Configuration File Example

```bash
# .env file
IAGON_ACCESS_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
IAGON_NODE_ID=node_abc123def456
IAGON_DOWNLOAD_BASE_URL=https://gw.iagon.com/api/v2
```

---

## IagonStorageClient API

**File**: `/root/company-admin-portal/lib/IagonStorageClient.js`

### Constructor

Creates a new IagonStorageClient instance.

```javascript
new IagonStorageClient(options)
```

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `Object` | No | `{}` | Configuration options |
| `options.accessToken` | `String` | No | `process.env.IAGON_ACCESS_TOKEN` | Iagon API access token |
| `options.nodeId` | `String` | No | `process.env.IAGON_NODE_ID` | Iagon storage node ID |
| `options.tunnelingUrl` | `String` | No | `process.env.IAGON_TUNNELING_URL` | Custom tunneling URL |
| `options.downloadBaseUrl` | `String` | No | `https://gw.iagon.com/api/v2` | Iagon API base URL |
| `options.maxRetries` | `Number` | No | `3` | Maximum upload/download retry attempts |
| `options.retryDelay` | `Number` | No | `1000` | Initial retry delay in milliseconds |
| `options.maxFileSize` | `Number` | No | `41943040` | Maximum file size (40MB) |

#### Example

```javascript
const { IagonStorageClient } = require('./lib/IagonStorageClient');

const client = new IagonStorageClient({
  accessToken: 'your-access-token',
  nodeId: 'your-node-id',
  maxRetries: 5,
  retryDelay: 2000
});
```

---

### Methods

#### isConfigured()

Checks if Iagon credentials are properly configured.

```javascript
client.isConfigured()
```

**Returns**: `Boolean` - `true` if both `accessToken` and `nodeId` are set

**Example**:
```javascript
if (client.isConfigured()) {
  console.log('Iagon storage is ready');
} else {
  console.log('Missing IAGON_ACCESS_TOKEN or IAGON_NODE_ID');
}
```

---

#### uploadFile(fileContent, filename, options)

Uploads a file to Iagon decentralized storage with optional encryption.

```javascript
await client.uploadFile(fileContent, filename, options)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileContent` | `Buffer` | **Yes** | File content as Buffer |
| `filename` | `String` | **Yes** | Filename to use on Iagon |
| `options` | `Object` | No | Upload options |
| `options.classificationLevel` | `String` | No | Classification level: `UNCLASSIFIED`, `CONFIDENTIAL`, `SECRET`, `TOP_SECRET` |

**Returns**: `Promise<Object>` - Upload result

**Response Object**:
```javascript
{
  success: true,
  filename: "did123_abc12345_v1.pdf",
  nodeId: "node_abc123",
  fileId: "507f1f77bcf86cd799439011",  // MongoDB ObjectId for downloads
  contentHash: "sha256:a3b2c1d4e5f6...",
  encryptionInfo: {
    algorithm: "AES-256-GCM",  // or "none" for UNCLASSIFIED
    keyId: "a1b2c3d4e5f6g7h8",
    key: "base64-encoded-256-bit-key",
    iv: "base64-encoded-96-bit-iv",
    authTag: "base64-encoded-auth-tag"
  },
  iagonUrl: "https://gw.iagon.com/api/v2/download?nodeId=node_abc123&filename=...",
  uploadedAt: "2025-12-07T10:30:00.000Z",
  fileSize: 1024567,      // Encrypted size
  originalSize: 1024000   // Original size
}
```

**Encryption Behavior**:
- `UNCLASSIFIED`: No encryption (`algorithm: "none"`)
- `CONFIDENTIAL`, `SECRET`, `TOP_SECRET`: AES-256-GCM encryption

**Error Handling**:
- Throws `Error` if Iagon not configured
- Throws `Error` if file exceeds 40MB limit
- Automatically retries failed uploads (up to `maxRetries`)

**Example**:
```javascript
const fs = require('fs');
const fileContent = fs.readFileSync('./document.pdf');

const result = await client.uploadFile(fileContent, 'document.pdf', {
  classificationLevel: 'CONFIDENTIAL'
});

console.log('File ID:', result.fileId);
console.log('Encryption key:', result.encryptionInfo.key);
```

---

#### downloadFile(fileId, encryptionInfo)

Downloads a file from Iagon storage and optionally decrypts it.

```javascript
await client.downloadFile(fileId, encryptionInfo)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileId` | `String` | **Yes** | File ID from upload response (`data._id`) |
| `encryptionInfo` | `Object` | No | Encryption metadata for decryption |
| `encryptionInfo.algorithm` | `String` | No | Encryption algorithm (`AES-256-GCM` or `none`) |
| `encryptionInfo.key` | `String` | Conditional | Base64-encoded encryption key (required if `algorithm !== "none"`) |
| `encryptionInfo.iv` | `String` | Conditional | Base64-encoded initialization vector |
| `encryptionInfo.authTag` | `String` | Conditional | Base64-encoded authentication tag |

**Returns**: `Promise<Buffer>` - Decrypted file content

**Example**:
```javascript
const fileContent = await client.downloadFile('507f1f77bcf86cd799439011', {
  algorithm: 'AES-256-GCM',
  key: 'base64-key-here',
  iv: 'base64-iv-here',
  authTag: 'base64-tag-here'
});

fs.writeFileSync('downloaded.pdf', fileContent);
```

**API Details**:
- Uses Iagon's `POST /api/v2/storage/download` endpoint
- Requires JSON body: `{ id: fileId, files: [fileId] }`
- Returns raw file content as `arraybuffer`
- Automatically decrypts if `encryptionInfo` provided

---

#### encryptContent(content, classificationLevel)

Encrypts content using AES-256-GCM encryption.

```javascript
const { content, encryptionInfo } = client.encryptContent(content, classificationLevel)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `Buffer` | **Yes** | Content to encrypt |
| `classificationLevel` | `String` | **Yes** | Classification level |

**Returns**: `Object`

```javascript
{
  content: Buffer,  // Encrypted content
  encryptionInfo: {
    algorithm: "AES-256-GCM",
    keyId: "a1b2c3d4e5f6g7h8",  // First 16 chars of SHA-256(key)
    key: "base64-encoded-key",
    iv: "base64-encoded-iv",
    authTag: "base64-encoded-tag"
  }
}
```

**Encryption Algorithm**:
- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Size**: 256 bits (32 bytes)
- **IV Size**: 96 bits (12 bytes) - optimal for GCM
- **Auth Tag**: 128 bits (16 bytes)

**Example**:
```javascript
const plaintext = Buffer.from('Secret document content');
const { content, encryptionInfo } = client.encryptContent(plaintext, 'SECRET');

console.log('Encrypted:', content.toString('base64'));
console.log('Key ID:', encryptionInfo.keyId);
```

---

#### decryptContent(encryptedContent, encryptionInfo)

Decrypts AES-256-GCM encrypted content.

```javascript
const decrypted = client.decryptContent(encryptedContent, encryptionInfo)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `encryptedContent` | `Buffer` | **Yes** | Encrypted content |
| `encryptionInfo` | `Object` | **Yes** | Encryption metadata from `encryptContent()` |

**Returns**: `Buffer` - Decrypted content

**Example**:
```javascript
const decrypted = client.decryptContent(encryptedBuffer, {
  algorithm: 'AES-256-GCM',
  key: 'base64-key',
  iv: 'base64-iv',
  authTag: 'base64-tag'
});

console.log('Decrypted:', decrypted.toString('utf8'));
```

---

#### calculateContentHash(content)

Calculates SHA-256 hash of content for integrity verification.

```javascript
const hash = client.calculateContentHash(content)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `Buffer` | **Yes** | Content to hash |

**Returns**: `String` - Hash in format `sha256:{hex}`

**Example**:
```javascript
const hash = client.calculateContentHash(Buffer.from('content'));
// Returns: "sha256:a3b2c1d4e5f6789..."
```

---

#### generateFilename(documentDID, contentHash, version, extension)

Generates a unique filename for Iagon storage.

```javascript
const filename = client.generateFilename(documentDID, contentHash, version, extension)
```

**Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `documentDID` | `String` | **Yes** | - | Document DID identifier |
| `contentHash` | `String` | **Yes** | - | Content hash (full hash, not prefixed) |
| `version` | `Number` | No | `1` | Document version number |
| `extension` | `String` | No | `'dat'` | File extension |

**Returns**: `String` - Filename in format `{shortDID}_{hash8}_v{version}.{ext}`

**Example**:
```javascript
const filename = client.generateFilename(
  'did:prism:abc123def456...',
  'a3b2c1d4e5f6789...',
  1,
  'pdf'
);
// Returns: "abc123def456_a3b2c1d4_v1.pdf"
```

---

#### testConnection()

Validates Iagon configuration and tests connectivity.

```javascript
await client.testConnection()
```

**Returns**: `Promise<Object>` - Connection status

**Success Response**:
```javascript
{
  configured: true,
  connected: true,
  nodeId: "node_abc123",
  downloadBaseUrl: "https://gw.iagon.com/api/v2",
  note: "Iagon gateway reachable (actual upload/download may require specific endpoints)"
}
```

**Configuration Error**:
```javascript
{
  configured: false,
  error: "Missing IAGON_ACCESS_TOKEN or IAGON_NODE_ID"
}
```

**Connection Error**:
```javascript
{
  configured: true,
  connected: false,
  error: "getaddrinfo ENOTFOUND gw.iagon.com",
  errorType: "DNS_RESOLUTION",  // or "NETWORK", "API"
  nodeId: "node_abc123",
  downloadBaseUrl: "https://gw.iagon.com/api/v2"
}
```

**Example**:
```javascript
const status = await client.testConnection();
if (status.connected) {
  console.log('Iagon is ready');
} else {
  console.error('Connection failed:', status.error);
}
```

---

#### Static Method: getExtension(filename, contentType)

Extracts file extension from filename or MIME type.

```javascript
IagonStorageClient.getExtension(filename, contentType)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | `String` | No | Filename with extension |
| `contentType` | `String` | No | MIME type |

**Returns**: `String` - File extension (lowercase, no dot)

**Supported MIME Types**:
- `application/pdf` → `pdf`
- `application/msword` → `doc`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` → `docx`
- `text/plain` → `txt`
- `application/json` → `json`
- `image/jpeg` → `jpg`
- `image/png` → `png`
- `application/octet-stream` → `dat`

**Example**:
```javascript
const ext1 = IagonStorageClient.getExtension('document.pdf');
// Returns: "pdf"

const ext2 = IagonStorageClient.getExtension(null, 'application/pdf');
// Returns: "pdf"
```

---

#### Singleton Instance: getIagonClient(options)

Returns a singleton IagonStorageClient instance.

```javascript
const { getIagonClient } = require('./lib/IagonStorageClient');
const client = getIagonClient(options);
```

**Parameters**: Same as constructor

**Returns**: `IagonStorageClient` - Singleton instance

**Example**:
```javascript
const { getIagonClient } = require('./lib/IagonStorageClient');
const client1 = getIagonClient();
const client2 = getIagonClient();
// client1 === client2 (same instance)
```

---

## EnterpriseDocumentManager API

**File**: `/root/company-admin-portal/lib/EnterpriseDocumentManager.js`

Manages document DID creation via Enterprise Cloud Agent and integrates with Iagon storage.

### Constructor

```javascript
new EnterpriseDocumentManager(enterpriseCloudAgentUrl, apiKey)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enterpriseCloudAgentUrl` | `String` | **Yes** | Base URL of Enterprise Cloud Agent |
| `apiKey` | `String` | No | API key for Cloud Agent authentication |

**Example**:
```javascript
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');

const manager = new EnterpriseDocumentManager(
  'http://91.99.4.54:8300',
  'your-api-key-here'
);
```

---

### Methods

#### createDocumentDID(department, metadata)

Creates and publishes a blockchain-anchored document DID.

```javascript
await manager.createDocumentDID(department, metadata)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `department` | `String` | **Yes** | Department name: `HR`, `IT`, `Security` |
| `metadata` | `Object` | **Yes** | Document metadata |
| `metadata.title` | `String` | **Yes** | Document title |
| `metadata.description` | `String` | No | Document description |
| `metadata.classificationLevel` | `String` | No | Classification level |
| `metadata.createdBy` | `String` | No | Creator email |
| `metadata.createdByDID` | `String` | No | Creator PRISM DID |

**Returns**: `Promise<String>` - Long-form PRISM DID

**Process**:
1. Creates unpublished DID (long-form) via Cloud Agent
2. Submits DID for blockchain publication
3. Returns long-form DID (immediately usable)
4. Blockchain publication occurs asynchronously (30-60 seconds)

**Example**:
```javascript
const did = await manager.createDocumentDID('HR', {
  title: 'Employee Handbook 2025',
  description: 'Internal company policies',
  classificationLevel: 'CONFIDENTIAL',
  createdBy: 'alice@techcorp.com',
  createdByDID: 'did:prism:abc123...'
});

console.log('Document DID:', did);
// Returns: "did:prism:longform:abc123def456..."
```

---

#### createDocumentDIDWithStorage(department, metadata, fileContent, originalFilename)

Creates document DID with integrated Iagon file storage.

```javascript
await manager.createDocumentDIDWithStorage(department, metadata, fileContent, originalFilename)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `department` | `String` | **Yes** | Department name |
| `metadata` | `Object` | **Yes** | Document metadata (same as `createDocumentDID`) |
| `fileContent` | `Buffer` | **Yes** | File content as Buffer |
| `originalFilename` | `String` | **Yes** | Original filename for extension detection |

**Returns**: `Promise<Object>` - Comprehensive result

**Response Object**:
```javascript
{
  documentDID: "did:prism:longform:abc123...",
  operationId: "operation-uuid-here",
  iagonStorage: {
    nodeId: "node_abc123",
    filename: "abc123def456_a3b2c1d4_v1.pdf",
    fileId: "507f1f77bcf86cd799439011",
    url: "https://gw.iagon.com/api/v2/download?nodeId=...",
    contentHash: "sha256:a3b2c1d4...",
    encryptionInfo: {
      algorithm: "AES-256-GCM",
      keyId: "a1b2c3d4e5f6g7h8",
      key: "base64-key",
      iv: "base64-iv",
      authTag: "base64-tag"
    },
    uploadedAt: "2025-12-07T10:30:00.000Z",
    fileSize: 1024567,
    originalSize: 1024000
  },
  metadata: {
    title: "Document Title",
    description: "Document description",
    classificationLevel: "CONFIDENTIAL",
    department: "HR",
    createdAt: "2025-12-07T10:30:00.000Z"
  }
}
```

**Fallback Behavior**:
If Iagon is not configured, creates DID without storage:
```javascript
{
  documentDID: "did:prism:longform:abc123...",
  iagonStorage: null,
  warning: "Iagon storage not configured. Document DID created without file storage."
}
```

**Example**:
```javascript
const fs = require('fs');
const fileContent = fs.readFileSync('./document.pdf');

const result = await manager.createDocumentDIDWithStorage(
  'HR',
  {
    title: 'Employee Contract Template',
    description: 'Standard employment contract',
    classificationLevel: 'CONFIDENTIAL'
  },
  fileContent,
  'contract-template.pdf'
);

console.log('Document DID:', result.documentDID);
console.log('Iagon File ID:', result.iagonStorage.fileId);
console.log('Encryption Key:', result.iagonStorage.encryptionInfo.key);
```

---

#### downloadDocument(iagonStorage)

Downloads a document from Iagon storage with automatic decryption.

```javascript
await manager.downloadDocument(iagonStorage)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `iagonStorage` | `Object` | **Yes** | Iagon storage metadata from DocumentRegistry |
| `iagonStorage.fileId` | `String` | **Yes** | Iagon file ID |
| `iagonStorage.filename` | `String` | No | Original filename (for logging) |
| `iagonStorage.encryptionInfo` | `Object` | No | Encryption metadata |

**Returns**: `Promise<Buffer>` - Decrypted file content

**Error Handling**:
- Throws `Error` if Iagon not configured
- Throws `Error` if `fileId` is missing
- Throws `Error` if download fails

**Example**:
```javascript
const iagonStorage = {
  fileId: '507f1f77bcf86cd799439011',
  filename: 'abc123def456_a3b2c1d4_v1.pdf',
  encryptionInfo: {
    algorithm: 'AES-256-GCM',
    key: 'base64-key',
    iv: 'base64-iv',
    authTag: 'base64-tag'
  }
};

const fileContent = await manager.downloadDocument(iagonStorage);
fs.writeFileSync('downloaded.pdf', fileContent);
```

---

#### checkIagonStatus()

Checks Iagon storage configuration and connectivity.

```javascript
await manager.checkIagonStatus()
```

**Returns**: `Promise<Object>` - Same as `IagonStorageClient.testConnection()`

**Example**:
```javascript
const status = await manager.checkIagonStatus();
console.log('Configured:', status.configured);
console.log('Connected:', status.connected);
```

---

#### waitForPublication(operationId, maxAttempts)

Waits for DID blockchain publication to complete (optional polling).

```javascript
await manager.waitForPublication(operationId, maxAttempts)
```

**Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `operationId` | `String` | **Yes** | - | Publication operation ID from `createDocumentDID` |
| `maxAttempts` | `Number` | No | `60` | Maximum polling attempts (60 × 2s = 120s) |

**Returns**: `Promise<String>` - Published canonical DID

**Polling Behavior**:
- Polls every 2 seconds
- Maximum wait: 120 seconds (default)
- Returns canonical DID when `didState === "PUBLISHED"`

**Example**:
```javascript
// Create DID
const did = await manager.createDocumentDID('HR', metadata);

// Wait for blockchain publication (optional - long-form DID already usable)
const publishedDID = await manager.waitForPublication(operationId, 60);
console.log('Published DID:', publishedDID);
```

---

## REST API Endpoints

### GET /api/iagon/status

Check Iagon storage configuration and connectivity status.

**Authentication**: None required

**Request**:
```http
GET /api/iagon/status HTTP/1.1
Host: identuslabel.cz
```

**Response 200 OK**:
```json
{
  "success": true,
  "iagon": {
    "configured": true,
    "connected": true,
    "nodeId": "node_abc123",
    "downloadBaseUrl": "https://gw.iagon.com/api/v2",
    "note": "Iagon gateway reachable (actual upload/download may require specific endpoints)"
  }
}
```

**Response 500 Error**:
```json
{
  "success": false,
  "error": "StatusCheckFailed",
  "message": "getaddrinfo ENOTFOUND gw.iagon.com"
}
```

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/iagon/status
```

---

### POST /api/employee-portal/documents/upload

Upload a document with automatic DID creation and Iagon storage.

**Authentication**: Employee session required (set via cookie)

**Request**:
```http
POST /api/employee-portal/documents/upload HTTP/1.1
Host: identuslabel.cz
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary
Cookie: employee-session=...

------WebKitFormBoundary
Content-Disposition: form-data; name="title"

Employee Handbook 2025
------WebKitFormBoundary
Content-Disposition: form-data; name="description"

Internal company policies and procedures
------WebKitFormBoundary
Content-Disposition: form-data; name="classificationLevel"

CONFIDENTIAL
------WebKitFormBoundary
Content-Disposition: form-data; name="releasableTo"

TechCorp Corporation,ACME Corporation
------WebKitFormBoundary
Content-Disposition: form-data; name="file"; filename="handbook.pdf"
Content-Type: application/pdf

<binary file data>
------WebKitFormBoundary--
```

**Request Parameters**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `String` | **Yes** | Document title |
| `description` | `String` | No | Document description |
| `classificationLevel` | `String` | **Yes** | `UNCLASSIFIED`, `CONFIDENTIAL`, `SECRET`, `TOP_SECRET` |
| `releasableTo` | `String` | **Yes** | Comma-separated company names |
| `file` | `File` | **Yes** | Document file (max 40MB) |

**Response 200 OK**:
```json
{
  "success": true,
  "documentDID": "did:prism:longform:abc123def456...",
  "title": "Employee Handbook 2025",
  "classificationLevel": "CONFIDENTIAL",
  "releasableTo": ["TechCorp Corporation", "ACME Corporation"],
  "iagonStorage": {
    "nodeId": "node_abc123",
    "filename": "abc123def456_a3b2c1d4_v1.pdf",
    "fileId": "507f1f77bcf86cd799439011",
    "url": "https://gw.iagon.com/api/v2/download?nodeId=...",
    "uploadedAt": "2025-12-07T10:30:00.000Z"
  }
}
```

**Error Responses**:

**401 Unauthorized**:
```json
{
  "success": false,
  "error": "NoSession",
  "message": "Employee session required"
}
```

**400 Bad Request**:
```json
{
  "success": false,
  "error": "ValidationError",
  "message": "Missing required field: title"
}
```

**413 Payload Too Large**:
```json
{
  "success": false,
  "error": "FileTooLarge",
  "message": "File size exceeds maximum limit of 40MB"
}
```

**500 Internal Server Error**:
```json
{
  "success": false,
  "error": "InternalServerError",
  "message": "Failed to upload document"
}
```

**Example (JavaScript)**:
```javascript
const formData = new FormData();
formData.append('title', 'Employee Handbook 2025');
formData.append('description', 'Internal policies');
formData.append('classificationLevel', 'CONFIDENTIAL');
formData.append('releasableTo', 'TechCorp Corporation,ACME Corporation');
formData.append('file', fileBlob, 'handbook.pdf');

const response = await fetch('/api/employee-portal/documents/upload', {
  method: 'POST',
  body: formData,
  credentials: 'include'  // Include session cookie
});

const result = await response.json();
console.log('Document DID:', result.documentDID);
```

---

### GET /api/employee-portal/documents/:documentDID/download

Download a document from Iagon decentralized storage.

**Authentication**: Employee session required

**Authorization**:
- Employee's clearance level must meet document classification
- Employee's company must be in document's `releasableTo` list

**Request**:
```http
GET /api/employee-portal/documents/did:prism:abc123.../download HTTP/1.1
Host: identuslabel.cz
Cookie: employee-session=...
```

**Response 200 OK**:
```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="handbook.pdf"
Content-Length: 1024567
X-Document-DID: did:prism:abc123...
X-Classification-Level: CONFIDENTIAL

<binary file data>
```

**Response Headers**:

| Header | Description |
|--------|-------------|
| `Content-Type` | MIME type from document metadata |
| `Content-Disposition` | Filename for browser download |
| `Content-Length` | File size in bytes |
| `X-Document-DID` | Document DID identifier |
| `X-Classification-Level` | Document classification level |

**Error Responses**:

**401 Unauthorized**:
```json
{
  "success": false,
  "error": "NoSession",
  "message": "Employee session required"
}
```

**403 Forbidden (Insufficient Clearance)**:
```json
{
  "success": false,
  "error": "InsufficientClearance",
  "message": "This document requires CONFIDENTIAL clearance. You have UNCLASSIFIED clearance."
}
```

**403 Forbidden (Access Denied)**:
```json
{
  "success": false,
  "error": "AccessDenied",
  "message": "Your company is not authorized to access this document"
}
```

**404 Not Found**:
```json
{
  "success": false,
  "error": "DocumentNotFound",
  "message": "Document not found in registry"
}
```

**404 Not Found (No Storage)**:
```json
{
  "success": false,
  "error": "NoStorageMetadata",
  "message": "Document has no file stored on Iagon"
}
```

**Example (JavaScript)**:
```javascript
const documentDID = 'did:prism:abc123...';
const response = await fetch(
  `/api/employee-portal/documents/${encodeURIComponent(documentDID)}/download`,
  { credentials: 'include' }
);

if (response.ok) {
  const blob = await response.blob();
  const filename = response.headers.get('Content-Disposition')
    .match(/filename="(.+)"/)[1];

  // Trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
} else {
  const error = await response.json();
  console.error('Download failed:', error.message);
}
```

---

## Data Models

### IagonStorageMetadata

Stored in DocumentRegistry alongside document DID.

```typescript
interface IagonStorageMetadata {
  nodeId: string;              // Iagon storage node ID
  filename: string;            // Generated filename on Iagon
  fileId: string;              // Iagon file ID (for download API)
  url: string;                 // Iagon download URL
  contentHash: string;         // SHA-256 hash: "sha256:abc123..."
  encryptionInfo: EncryptionInfo;
  uploadedAt: string;          // ISO 8601 timestamp
  fileSize: number;            // Encrypted file size (bytes)
  originalSize: number;        // Original file size (bytes)
}
```

### EncryptionInfo

Encryption metadata for AES-256-GCM.

```typescript
interface EncryptionInfo {
  algorithm: "AES-256-GCM" | "none";
  keyId: string | null;        // First 16 chars of SHA-256(key)
  key: string | null;          // Base64-encoded 256-bit key
  iv: string | null;           // Base64-encoded 96-bit IV
  authTag: string | null;      // Base64-encoded 128-bit auth tag
}
```

### DocumentMetadata

Document metadata stored in DocumentRegistry.

```typescript
interface DocumentMetadata {
  title: string;
  description?: string;
  createdBy: string;           // Employee email
  createdByDID: string;        // Employee PRISM DID
  department: string;          // HR, IT, Security
  originalFilename: string;
  fileSize: number;            // Original file size
  mimeType: string;            // MIME type
  createdAt: string;           // ISO 8601 timestamp
}
```

---

## Error Handling

### Common Error Types

| Error | HTTP Status | Cause | Resolution |
|-------|-------------|-------|------------|
| `Iagon storage not configured` | 500 | Missing `IAGON_ACCESS_TOKEN` or `IAGON_NODE_ID` | Configure environment variables |
| `File size exceeds maximum` | 413 | File larger than 40MB | Reduce file size or split document |
| `Upload failed after N attempts` | 500 | Network or Iagon API error | Check logs, verify connectivity |
| `Download failed after N attempts` | 500 | Invalid `fileId` or network error | Verify `fileId`, check Iagon status |
| `No Iagon file ID found` | 500 | Document uploaded before `fileId` support | Re-upload document |

### Retry Logic

Both upload and download operations use exponential backoff retry:

```javascript
// Retry configuration
maxRetries: 3
initialDelay: 1000ms

// Exponential backoff
attempt 1: 1000ms delay
attempt 2: 2000ms delay
attempt 3: 4000ms delay
```

### Error Handling Best Practices

1. **Check Configuration First**:
```javascript
const client = getIagonClient();
if (!client.isConfigured()) {
  console.error('Iagon not configured');
  return;
}
```

2. **Test Connectivity**:
```javascript
const status = await client.testConnection();
if (!status.connected) {
  console.error('Iagon unreachable:', status.error);
  return;
}
```

3. **Handle Upload Errors**:
```javascript
try {
  const result = await client.uploadFile(content, filename, options);
  console.log('Upload successful:', result.fileId);
} catch (error) {
  if (error.message.includes('exceeds maximum')) {
    console.error('File too large');
  } else if (error.message.includes('not configured')) {
    console.error('Iagon not configured');
  } else {
    console.error('Upload failed:', error.message);
  }
}
```

---

## Code Examples

### Complete Document Upload Workflow

```javascript
const { getIagonClient } = require('./lib/IagonStorageClient');
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const DocumentRegistry = require('./lib/DocumentRegistry');
const fs = require('fs');

async function uploadDocument() {
  try {
    // 1. Check Iagon configuration
    const client = getIagonClient();
    if (!client.isConfigured()) {
      throw new Error('Iagon not configured');
    }

    // 2. Test connectivity
    const status = await client.testConnection();
    if (!status.connected) {
      throw new Error(`Iagon unreachable: ${status.error}`);
    }

    // 3. Read file
    const fileContent = fs.readFileSync('./document.pdf');
    console.log(`File size: ${fileContent.length} bytes`);

    // 4. Create document DID with Iagon storage
    const manager = new EnterpriseDocumentManager(
      'http://91.99.4.54:8300',
      'your-api-key'
    );

    const result = await manager.createDocumentDIDWithStorage(
      'HR',
      {
        title: 'Employee Handbook 2025',
        description: 'Company policies',
        classificationLevel: 'CONFIDENTIAL',
        createdBy: 'alice@techcorp.com',
        createdByDID: 'did:prism:alice123...'
      },
      fileContent,
      'handbook.pdf'
    );

    console.log('Document DID:', result.documentDID);
    console.log('Iagon File ID:', result.iagonStorage.fileId);

    // 5. Register in DocumentRegistry
    await DocumentRegistry.registerDocument({
      documentDID: result.documentDID,
      title: 'Employee Handbook 2025',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: [
        'did:prism:techcorp123...',
        'did:prism:acme456...'
      ],
      contentEncryptionKey: result.iagonStorage.encryptionInfo.key,
      metadata: {
        title: 'Employee Handbook 2025',
        description: 'Company policies',
        createdBy: 'alice@techcorp.com',
        department: 'HR',
        originalFilename: 'handbook.pdf',
        fileSize: fileContent.length,
        mimeType: 'application/pdf',
        createdAt: new Date().toISOString()
      },
      iagonStorage: result.iagonStorage
    });

    console.log('✅ Document registered successfully');
    return result;

  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    throw error;
  }
}

uploadDocument();
```

### Complete Document Download Workflow

```javascript
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const DocumentRegistry = require('./lib/DocumentRegistry');
const fs = require('fs');

async function downloadDocument(documentDID, employeeIssuerDID, employeeClearance) {
  try {
    // 1. Get document from registry (authorization check)
    const document = await DocumentRegistry.getDocument(
      documentDID,
      employeeIssuerDID
    );

    // 2. Check clearance level
    const clearanceLevels = {
      'UNCLASSIFIED': 1,
      'CONFIDENTIAL': 2,
      'SECRET': 3,
      'TOP_SECRET': 4
    };

    const documentLevel = clearanceLevels[document.classificationLevel] || 1;
    const employeeLevel = clearanceLevels[employeeClearance] || 1;

    if (employeeLevel < documentLevel) {
      throw new Error(
        `Insufficient clearance: document requires ${document.classificationLevel}, ` +
        `employee has ${employeeClearance}`
      );
    }

    // 3. Download from Iagon
    const manager = new EnterpriseDocumentManager('http://91.99.4.54:8300');
    const fileContent = await manager.downloadDocument(document.iagonStorage);

    console.log(`✅ Downloaded ${fileContent.length} bytes`);

    // 4. Save to disk
    const filename = document.metadata.originalFilename || 'document';
    fs.writeFileSync(filename, fileContent);
    console.log(`✅ Saved to ${filename}`);

    return fileContent;

  } catch (error) {
    console.error('❌ Download failed:', error.message);
    throw error;
  }
}

// Example usage
downloadDocument(
  'did:prism:abc123...',
  'did:prism:techcorp123...',
  'CONFIDENTIAL'
);
```

### Manual Encryption/Decryption

```javascript
const { IagonStorageClient } = require('./lib/IagonStorageClient');
const fs = require('fs');

// Encrypt a file
const client = new IagonStorageClient();
const plaintext = fs.readFileSync('./secret.txt');

const { content: encrypted, encryptionInfo } = client.encryptContent(
  plaintext,
  'SECRET'
);

console.log('Encrypted:', encrypted.toString('base64').substring(0, 50) + '...');
console.log('Key ID:', encryptionInfo.keyId);
console.log('Algorithm:', encryptionInfo.algorithm);

// Save encryption metadata (would normally go to DocumentRegistry)
fs.writeFileSync('encryption-info.json', JSON.stringify(encryptionInfo, null, 2));

// Decrypt the file
const decrypted = client.decryptContent(encrypted, encryptionInfo);
console.log('Decrypted:', decrypted.toString('utf8'));

// Verify integrity
console.log('Match:', plaintext.equals(decrypted));
```

### Content Hashing and Integrity Verification

```javascript
const { getIagonClient } = require('./lib/IagonStorageClient');
const fs = require('fs');

const client = getIagonClient();
const fileContent = fs.readFileSync('./document.pdf');

// Calculate hash before upload
const originalHash = client.calculateContentHash(fileContent);
console.log('Original hash:', originalHash);

// Upload file
const uploadResult = await client.uploadFile(fileContent, 'document.pdf', {
  classificationLevel: 'UNCLASSIFIED'
});

console.log('Stored hash:', uploadResult.contentHash);

// Verify hashes match
if (originalHash === uploadResult.contentHash) {
  console.log('✅ Content hash verified');
} else {
  console.error('❌ Hash mismatch - upload corrupted!');
}

// Download and verify again
const downloaded = await client.downloadFile(
  uploadResult.fileId,
  uploadResult.encryptionInfo
);

const downloadHash = client.calculateContentHash(downloaded);
console.log('Download hash:', downloadHash);

if (downloadHash === originalHash) {
  console.log('✅ Download integrity verified');
} else {
  console.error('❌ Download corrupted!');
}
```

---

## References

- **Iagon API Documentation**: https://api.docs.iagon.com/
- **Iagon Dashboard**: https://app.iagon.com/
- **AES-256-GCM**: https://en.wikipedia.org/wiki/Galois/Counter_Mode
- **SHA-256**: https://en.wikipedia.org/wiki/SHA-2
- **Node.js Crypto**: https://nodejs.org/api/crypto.html

---

**Document Version**: 1.0.0
**Last Updated**: December 7, 2025
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
