# Certification Authority (CA) Portal

**Production-Ready Digital Identity Issuance Service**

The Certification Authority is a web-based portal for issuing, managing, and verifying W3C-compliant Verifiable Credentials within the Hyperledger Identus SSI infrastructure. It serves as the trusted issuer for identity credentials (RealPerson) and access control credentials (SecurityClearanceLevel).

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [API Reference](#api-reference)
- [Credential Schemas](#credential-schemas)
- [Secure Information Portal](#secure-information-portal)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Overview

### What is the CA?

The Certification Authority is the **trusted credential issuer** in the Hyperledger Identus ecosystem. It bridges end users with the Cloud Agent infrastructure, providing:

- **Identity Verification**: Issues RealPerson credentials for identity attestation
- **Access Control**: Issues SecurityClearanceLevel credentials for hierarchical access control
- **Credential Management**: Admin interface for approval, revocation, and lifecycle management
- **Verification Services**: Verifies credential presentations from wallets
- **Secure Content Delivery**: Progressive disclosure dashboard with client-side encryption

### Service Information

| Property | Value |
|----------|-------|
| **URL** | https://identuslabel.cz/ca |
| **Port** | 3005 |
| **Main File** | `server.js` (6,181 lines) |
| **Framework** | Express.js (Node.js) |
| **Cloud Agent** | https://identuslabel.cz/cloud-agent |
| **API Key** | `admin` (simple agent token) |
| **Entity ID** | `certification-authority-entity` |

### Role in SSI Infrastructure

```
┌─────────────────────────────────────────────────────────────┐
│                     SSI Infrastructure                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  User Wallets (Alice, Bob)                                 │
│       ↕ DIDComm (via Mediator)                             │
│                                                             │
│  Certification Authority (3005) ←→ Cloud Agent (8000)      │
│       │                                                     │
│       ├─ Credential Issuance                               │
│       ├─ Revocation Management                             │
│       ├─ Proof Verification                                │
│       └─ Secure Content Delivery                           │
│                                                             │
│  Cloud Agent (8000) ←→ VDR/PRISM Node (50053)              │
│       │                                                     │
│       ├─ DID Operations                                    │
│       ├─ Schema Registry                                   │
│       └─ StatusList2021 Revocation                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Technology Stack

**Backend**:
- **Express.js**: REST API server
- **Node-Fetch**: HTTP client for Cloud Agent communication
- **Libsodium-Wrappers**: X25519/XSalsa20-Poly1305 encryption
- **TweetNaCl**: Additional cryptographic primitives
- **Pako**: GZIP compression for StatusList bitstrings
- **UUID**: Session and credential ID generation

**Frontend**:
- **Vanilla JavaScript**: No framework dependencies
- **BroadcastChannel API**: Wallet communication for decryption
- **postMessage API**: Cross-origin secure messaging
- **Bootstrap**: UI styling

### Design Patterns

**1. Proxy Pattern**: CA proxies requests to Cloud Agent API
```javascript
// CA frontend → CA backend → Cloud Agent
POST /api/credentials/issue-realperson
  → Cloud Agent: POST /issue-credentials/credential-offers
```

**2. Two-Phase Issuance Flow**:
```
User Request → CA Receives → Admin Approval → Cloud Agent Issues → Wallet Stores
```

**3. Database Abstraction Layer**:
```javascript
// lib/contentDatabase.js
// Supports: Local JSON (Phase 1) → WordPress CMS (Phase 2)
contentDatabase.getAccessibleContent(clearanceLevel)
```

**4. Client-Side Encryption**:
```
Server Encrypts (X25519) → Wallet Decrypts Locally → Zero-Knowledge Server
```

### Integration Points

| Component | Protocol | Purpose |
|-----------|----------|---------|
| **Cloud Agent** | REST API | DID operations, credential issuance, revocation |
| **User Wallets** | DIDComm v2 | Connection establishment, credential delivery |
| **Mediator** | WebSocket | Message routing for wallet communication |
| **VDR/PRISM Node** | gRPC (via Cloud Agent) | Blockchain anchoring for DIDs |
| **Browser Wallets** | BroadcastChannel/postMessage | Client-side content decryption |

---

## Features

### ✅ Core Capabilities

#### 1. DID Management

**Create PRISM DIDs**:
- **Endpoint**: `POST /api/create-did`
- **Implementation**: Lines 411-456
- **Supports**: `Ed25519`, `secp256k1` key types
- **Output**: Long-form DID, published state tracking

**Publish DIDs to Blockchain**:
- **Endpoint**: `POST /api/publish-did`
- **Implementation**: Lines 491-532
- **Process**: Anchors DID to Cardano blockchain via PRISM node

#### 2. Connection Management

**Out-of-Band Invitations**:
- **Endpoint**: `POST /api/cloud-agent/connections/create-invitation`
- **Implementation**: Lines 534-611
- **Features**:
  - Custom labels for user tracking
  - Persistent user-connection mappings
  - Soft-delete support for privacy

**Connection State Tracking**:
- States: `InvitationGenerated`, `ConnectionRequested`, `ConnectionResponseSent`
- Color coding: 🟠 Orange (pending) → 🟢 Green (connected)
- Admin UI: Real-time connection monitoring

#### 3. Credential Issuance

**RealPerson Identity Credentials (v3.0.0)**:
- **Endpoint**: `POST /api/credentials/issue-realperson`
- **Implementation**: Lines 1709-1878
- **Schema GUID**: `e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`
- **Fields**:
  - User-provided: `firstName`, `lastName`, `uniqueId`, `dateOfBirth`, `gender`
  - Auto-populated: `credentialType`, `issuedDate`, `expiryDate`, `credentialId`
- **Validity**: 2 years
- **Revocation**: StatusList2021 enabled

**SecurityClearanceLevel Credentials (v4.0.0)**:
- **Endpoint**: `POST /api/credentials/issue-security-clearance`
- **Implementation**: Lines 4780-5153
- **Schema GUID**: `ba309a53-9661-33df-92a3-2023b4a56fd5`
- **Clearance Levels**: `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`, `TOP-SECRET`
- **Dual-Key Architecture**:
  - **Ed25519**: Digital signature keys (authentication)
  - **X25519**: Encryption keys (secure content access)
- **Validity Periods**:
  - `INTERNAL`: 1 year
  - `CONFIDENTIAL`: 2 years
  - `RESTRICTED`: 6 months
  - `TOP-SECRET`: 1 year
- **Security**: Private keys generated client-side only (never transmitted)

#### 4. Credential Lifecycle Management

**Admin Approval Workflow**:
- **Pending Credentials**: `GET /api/credentials/pending`
- **Approve**: `POST /api/credentials/approve/:recordId`
- **Deny**: Reject credential request
- **States**: `OfferSent` → `RequestReceived` (pending approval) → `CredentialSent`

**Revocation Management** (StatusList2021):
- **Endpoint**: `POST /api/credentials/revoke/:recordId`
- **Implementation**: Lines 6022-6065
- **Process**:
  1. CA proxies to Cloud Agent: `PATCH /credential-status/revoke-credential/{recordId}`
  2. Cloud Agent updates database: `is_canceled = true`
  3. Background job (30min-hours): Updates StatusList bitstring
- **Architecture**: Asynchronous eventual consistency (see main `/root/CLAUDE.md` for details)

**Revocable Credentials Query**:
- **Endpoint**: `GET /api/credentials/revocable`
- **Implementation**: Lines 1919-2000
- **Features**:
  - JWT credential decoding to extract `credentialStatus`
  - Identifies revocable credentials (those with `statusListCredential` property)
  - Admin UI displays revocation status and controls

#### 5. Proof Verification

**Verifiable Presentation Verification**:
- **Endpoint**: `POST /api/presentations/verify`
- **Implementation**: Lines 3217-3360
- **Supports**:
  - JWT-encoded presentations
  - W3C VC Data Model 1.0 compliance
  - Schema validation
  - Expiration checking
  - Revocation status verification (StatusList2021)

**DIDComm Proof Requests**:
- **Initiate**: `POST /api/auth/didcomm/initiate`
- **Check Status**: `GET /api/auth/didcomm/status/:proofId`
- **Verify**: `POST /api/auth/didcomm/verify/:proofId`
- **Flow**: CA creates proof request → Wallet submits VP → CA verifies → Session created

#### 6. Secure Information Portal

**Phase 1: Progressive Disclosure** ✅ OPERATIONAL
- **Dashboard**: `GET /dashboard`
- **Content API**: `GET /api/dashboard/content?session={sessionId}`
- **Implementation**: Lines 3731-3954
- **Features**:
  - Server-side content filtering by clearance level
  - Hierarchical access control (PUBLIC → INTERNAL → CONFIDENTIAL → RESTRICTED → TOP-SECRET)
  - Session-based authentication (1-hour expiration)
  - 7 content sections with progressive disclosure

**Phase 2: Client-Side Encryption** ✅ OPERATIONAL (November 2, 2025)
- **Encrypted API**: `GET /api/dashboard/encrypted-content?session={sessionId}`
- **Implementation**: Lines 3956-4113
- **Documentation**: `/docs/ENCRYPTED_CONTENT_API.md`
- **Features**:
  - X25519 key agreement for encryption
  - XSalsa20-Poly1305 authenticated encryption
  - BroadcastChannel/postMessage wallet communication
  - Zero-knowledge server architecture
  - Measured performance: 317-350ms latency per section

**Content Database Abstraction**:
- **File**: `/lib/contentDatabase.js`
- **Current Source**: Local JSON (7 hardcoded sections)
- **Future Source**: WordPress CMS via REST API
- **Configuration**: `CONTENT_SOURCE=local|wordpress`
- **Migration Guide**: `/docs/WORDPRESS_INTEGRATION.md`

---

## API Reference

### DID Operations

#### Create PRISM DID

```http
POST /api/create-did
Content-Type: application/json

{
  "keyType": "Ed25519"  // or "secp256k1"
}
```

**Response**:
```json
{
  "success": true,
  "did": "did:prism:abcdef123456...",
  "published": false,
  "longFormDid": "did:prism:abcdef123456...?state=..."
}
```

#### Publish DID

```http
POST /api/publish-did
Content-Type: application/json

{
  "did": "did:prism:abcdef123456..."
}
```

---

### Connection Management

#### Create Out-of-Band Invitation

```http
POST /api/cloud-agent/connections/create-invitation
Content-Type: application/json

{
  "label": "Alice Smith - RealPerson Issuance"
}
```

**Response**:
```json
{
  "success": true,
  "connectionId": "uuid-v4",
  "invitationUrl": "https://my.domain.com/path?_oob=eyJpZCI6...",
  "state": "InvitationGenerated"
}
```

#### List Connections

```http
GET /api/cloud-agent/connections
```

**Response**:
```json
{
  "success": true,
  "connections": [
    {
      "connectionId": "uuid-v4",
      "label": "Alice Smith - RealPerson Issuance",
      "state": "ConnectionResponseSent",
      "userName": "Alice Smith",
      "uniqueId": "USER-001",
      "softDeleted": false,
      "createdAt": "2025-11-02T10:00:00Z"
    }
  ]
}
```

#### Delete Connection (Soft Delete)

```http
DELETE /api/cloud-agent/connections/:connectionId
```

---

### Credential Issuance

#### Issue RealPerson Credential

```http
POST /api/credentials/issue-realperson
Content-Type: application/json

{
  "connectionId": "uuid-v4",
  "firstName": "Alice",
  "lastName": "Smith",
  "uniqueId": "SSN-123-45-6789",
  "dateOfBirth": "1990-01-15",
  "gender": "Female"
}
```

**Response**:
```json
{
  "success": true,
  "recordId": "uuid-v4",
  "state": "OfferSent",
  "message": "RealPerson credential offer sent successfully. User must accept in wallet, then admin must approve."
}
```

#### Issue SecurityClearanceLevel Credential

```http
POST /api/credentials/issue-security-clearance
Content-Type: application/json

{
  "connectionId": "uuid-v4",
  "clearanceLevel": "CONFIDENTIAL",
  "holderName": "Alice Smith",
  "holderUniqueId": "USER-001",
  "ed25519PublicKey": "abcdef123456...",
  "ed25519Fingerprint": "SHA256:abcdef...",
  "x25519PublicKey": "xyz789...",
  "x25519Fingerprint": "SHA256:xyz..."
}
```

**Clearance Levels**: `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`, `TOP-SECRET`

**Response**:
```json
{
  "success": true,
  "recordId": "uuid-v4",
  "state": "OfferSent",
  "clearanceLevel": "CONFIDENTIAL",
  "expiryDate": "2027-11-02T10:00:00Z"
}
```

---

### Credential Management

#### Get Pending Credentials (Awaiting Approval)

```http
GET /api/credentials/pending
```

**Response**:
```json
{
  "success": true,
  "credentials": [
    {
      "recordId": "uuid-v4",
      "state": "RequestReceived",
      "credentialType": "RealPersonIdentity",
      "holderName": "Alice Smith",
      "createdAt": "2025-11-02T10:00:00Z"
    }
  ]
}
```

**Note**: Only returns credentials in `RequestReceived` state (user accepted offer, awaiting admin approval).

#### Approve Credential

```http
POST /api/credentials/approve/:recordId
```

**Response**:
```json
{
  "success": true,
  "recordId": "uuid-v4",
  "state": "CredentialSent",
  "message": "Credential approved and sent to wallet"
}
```

#### Get Revocable Credentials

```http
GET /api/credentials/revocable
```

**Response**:
```json
{
  "success": true,
  "credentials": [
    {
      "recordId": "uuid-v4",
      "credentialType": "RealPersonIdentity",
      "holderName": "Alice Smith",
      "issuedAt": "2025-11-02T10:00:00Z",
      "revocable": true,
      "statusListCredential": "https://identuslabel.cz/cloud-agent/credential-status/xyz789",
      "statusListIndex": "12345"
    }
  ]
}
```

**Implementation**: Decodes JWT credentials to extract `credentialStatus` property (Cloud Agent API does not expose this field).

#### Revoke Credential

```http
POST /api/credentials/revoke/:recordId
```

**Response (Success)**:
```json
{
  "success": true,
  "recordId": "uuid-v4",
  "message": "Credential revocation initiated successfully"
}
```

**Response (Already Revoked)**:
```json
{
  "success": false,
  "error": "Credential already revoked"
}
```

**Important**: Revocation uses asynchronous processing:
1. **Immediate**: Database `is_canceled` flag set to `true`
2. **Delayed (30min-hours)**: StatusList bitstring updated via background job

See main `/root/CLAUDE.md` "StatusList2021 Credential Revocation Architecture" section for details.

---

### Proof Verification

#### Verify Presentation

```http
POST /api/presentations/verify
Content-Type: application/json

{
  "presentation": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...",
  "proofId": "uuid-v4"
}
```

**Response (Valid)**:
```json
{
  "success": true,
  "verified": true,
  "credentialData": {
    "firstName": "Alice",
    "lastName": "Smith",
    "uniqueId": "USER-001",
    "credentialType": "RealPersonIdentity"
  }
}
```

**Response (Invalid)**:
```json
{
  "success": false,
  "verified": false,
  "error": "Credential expired"
}
```

---

### Secure Information Portal

#### Get Dashboard Content (Phase 1 - Plaintext)

```http
GET /api/dashboard/content?session={sessionId}
```

**Response (Authenticated - CONFIDENTIAL)**:
```json
{
  "success": true,
  "user": {
    "name": "Alice Smith",
    "clearanceLevel": "CONFIDENTIAL",
    "authenticated": true
  },
  "sections": [
    {
      "id": "public-1",
      "title": "Welcome to Secure Information Portal",
      "content": "Welcome message...",
      "clearanceBadge": "PUBLIC",
      "badgeColor": "#4CAF50",
      "category": "general"
    },
    {
      "id": "internal-1",
      "title": "Internal Operations Report",
      "content": "Internal content...",
      "clearanceBadge": "INTERNAL",
      "badgeColor": "#2196F3",
      "category": "operations"
    },
    {
      "id": "confidential-1",
      "title": "Project Phoenix Status",
      "content": "Confidential content...",
      "clearanceBadge": "CONFIDENTIAL",
      "badgeColor": "#FF9800",
      "category": "projects"
    }
    // Total: 5 sections for CONFIDENTIAL user
  ]
}
```

**Progressive Disclosure**:
- **PUBLIC (no auth)**: 1 section
- **INTERNAL**: 3 sections (PUBLIC + 2 INTERNAL)
- **CONFIDENTIAL**: 5 sections (PUBLIC + INTERNAL + 2 CONFIDENTIAL)
- **RESTRICTED**: 6 sections
- **TOP-SECRET**: 7 sections (all content)

#### Get Encrypted Dashboard Content (Phase 2 - E2E Encryption)

```http
GET /api/dashboard/encrypted-content?session={sessionId}
```

**Response**:
```json
{
  "success": true,
  "user": {
    "name": "Alice Smith",
    "clearanceLevel": "CONFIDENTIAL",
    "authenticated": true,
    "x25519PublicKey": "QJYjq8oYQr-z8EvpWx1..."
  },
  "sections": [
    {
      "id": "public-1",
      "title": "Welcome to Secure Information Portal",
      "clearanceBadge": "PUBLIC",
      "badgeColor": "#4CAF50",
      "category": "general",
      "encryptedContent": {
        "encrypted": true,
        "algorithm": "XSalsa20-Poly1305",
        "version": "2.0",
        "ciphertext": "base64url_encoded...",
        "nonce": "base64url_nonce",
        "senderPublicKey": "CA_x25519_pubkey",
        "recipientPublicKey": "user_x25519_pubkey"
      }
    }
    // ... 4 more encrypted sections
  ]
}
```

**Encryption Details**:
- **Algorithm**: X25519 key agreement + XSalsa20-Poly1305 authenticated encryption
- **Key Agreement**: ECDH between CA's ephemeral keypair and user's X25519 public key
- **Nonce**: Random 24-byte nonce per section
- **Decryption**: Client-side only via wallet's BroadcastChannel API
- **Performance**: ~1ms encryption per section, 317-350ms wallet decryption latency

**Error Responses**:

```json
// 401 - No session
{
  "success": false,
  "error": "AuthenticationRequired",
  "message": "No active session. Please authenticate with Security Clearance VC."
}

// 400 - Missing X25519 keys
{
  "success": false,
  "error": "MissingEncryptionKeys",
  "message": "Your Security Clearance credential does not contain X25519 encryption keys."
}
```

**Complete API Documentation**: `/docs/ENCRYPTED_CONTENT_API.md`

---

### Testing Endpoints

#### Create Test Session with Encryption

```http
POST /api/test/create-session-with-encryption
Content-Type: application/json

{
  "clearanceLevel": "CONFIDENTIAL"
}
```

**Response**:
```json
{
  "success": true,
  "sessionId": "test-encrypted-session-1762073298395",
  "message": "Test encrypted session created with CONFIDENTIAL clearance and X25519 encryption keys",
  "clearanceLevel": "CONFIDENTIAL",
  "x25519PublicKey": "QJYjq8oYQr...",
  "expiresAt": "2025-11-02T11:00:00Z",
  "testEndpoint": "/api/dashboard/encrypted-content?session=test-encrypted-session-1762073298395"
}
```

**Valid Clearance Levels**: `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`, `TOP-SECRET`

---

### Health Check

```http
GET /api/health
```

**Response**:
```json
{
  "status": "healthy",
  "service": "Certification Authority",
  "version": "1.0.0",
  "cloudAgent": "connected",
  "timestamp": "2025-11-02T10:00:00Z"
}
```

---

## Credential Schemas

### RealPerson v3.0.0

**Purpose**: Identity attestation credential

**Schema GUID**: `e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`

**Schema ID**: `did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c/20a78dc2-2d6c-450f-a8a6-65ff4218e08f?version=3.0.0`

**Cloud Agent URL**: `https://identuslabel.cz/cloud-agent/schema-registry/schemas/e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`

**File**: `/realperson-schema-v3-simplified.json`

**Fields**:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `credentialType` | string | Auto | `"RealPersonIdentity"` (wallet display) |
| `firstName` | string | User | Person's first name |
| `lastName` | string | User | Person's last name |
| `uniqueId` | string | User | Unique identifier (e.g., SSN) |
| `dateOfBirth` | string | User | ISO 8601 date (YYYY-MM-DD) |
| `gender` | string | User | Gender identity |
| `issuedDate` | string | Auto | Issuance date (ISO 8601) |
| `expiryDate` | string | Auto | Expiration date (2 years from issuance) |
| `credentialId` | string | Auto | Format: `REALPERSON-{timestamp}-{random}` |

**Validity**: 2 years (63,072,000 seconds)

**Revocation**: StatusList2021 enabled

**Wallet Display**: `"Alice Smith (ID) [Exp: 2yr]"`

---

### SecurityClearanceLevel v4.0.0

**Purpose**: Hierarchical access control credential with dual-key cryptography

**Schema GUID**: `ba309a53-9661-33df-92a3-2023b4a56fd5`

**Schema ID**: `did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c/365b8597-d6c8-4782-af4e-1bed81485a81?version=4.0.0`

**Cloud Agent URL**: `https://identuslabel.cz/cloud-agent/schema-registry/schemas/ba309a53-9661-33df-92a3-2023b4a56fd5`

**File**: `/security-clearance-schema-v4-simplified.json`

**Fields**:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `credentialType` | string | Auto | `"SecurityClearance"` (wallet display) |
| `clearanceLevel` | string | User | INTERNAL \| CONFIDENTIAL \| RESTRICTED \| TOP-SECRET |
| `holderName` | string | User | Full name |
| `holderUniqueId` | string | User | Unique identifier |
| `ed25519PublicKey` | string | User | Ed25519 signing public key (base64) |
| `ed25519Fingerprint` | string | User | Ed25519 key fingerprint (SHA256) |
| `x25519PublicKey` | string | User | X25519 encryption public key (base64url) |
| `x25519Fingerprint` | string | User | X25519 key fingerprint (SHA256) |
| `issuedDate` | string | Auto | Issuance date (ISO 8601) |
| `expiryDate` | string | Auto | Expiration date (varies by level) |
| `clearanceId` | string | Auto | Format: `CLEARANCE-{level}-{timestamp}-{random}` |

**Clearance Hierarchy**:
- **Level 0**: PUBLIC (no authentication required)
- **Level 1**: INTERNAL (1 year validity)
- **Level 2**: CONFIDENTIAL (2 years validity)
- **Level 3**: RESTRICTED (6 months validity)
- **Level 4**: TOP-SECRET (1 year validity)

**Dual-Key Architecture**:

1. **Ed25519 Keys** (Authentication):
   - Digital signature creation and verification
   - DIDComm authentication
   - Proof generation

2. **X25519 Keys** (Encryption):
   - Diffie-Hellman key agreement
   - Client-side content decryption
   - Secure dashboard access

**Security Model**:
- Private keys generated **client-side only** using Web Crypto API
- Public keys submitted to CA during credential request
- Private keys **NEVER** transmitted to CA server
- Keys stored in wallet's secure IndexedDB storage

**Wallet Display**: `"Alice Smith (Clearance) [CONFIDENTIAL - Exp: 1yr]"`

---

### Schema Management

**List All Schemas**:
```bash
curl -s https://identuslabel.cz/cloud-agent/schema-registry/schemas | jq '.contents[]'
```

**Get RealPerson Schema**:
```bash
curl -s https://identuslabel.cz/cloud-agent/schema-registry/schemas/e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f | jq '.'
```

**Get SecurityClearanceLevel Schema**:
```bash
curl -s https://identuslabel.cz/cloud-agent/schema-registry/schemas/ba309a53-9661-33df-92a3-2023b4a56fd5 | jq '.'
```

**Complete Schema Reference**: `/SCHEMA_REFERENCE.md`

---

## Secure Information Portal

### Overview

The Secure Information Portal is a **progressive disclosure dashboard** that displays security-sensitive content based on user's verified Security Clearance level. It implements a two-phase architecture:

1. **Phase 1**: Server-side content filtering (plaintext delivery over HTTPS)
2. **Phase 2**: Client-side encryption (E2E encryption with wallet decryption)

### User Experience

| User Type | Content Sections | Access Level |
|-----------|------------------|--------------|
| **Unauthenticated** | 1 section (PUBLIC) | Public information only |
| **INTERNAL** | 3 sections | PUBLIC + INTERNAL |
| **CONFIDENTIAL** | 5 sections | PUBLIC + INTERNAL + CONFIDENTIAL |
| **RESTRICTED** | 6 sections | Up to RESTRICTED |
| **TOP-SECRET** | 7 sections | Full access |

### Content Hierarchy

```
PUBLIC (Level 0)
  ├─ Welcome to Secure Information Portal
  └─ What is this portal?

INTERNAL (Level 1)
  ├─ Q4 2025 Financial Summary
  └─ HR Policy Updates

CONFIDENTIAL (Level 2)
  ├─ Project Phoenix Status
  └─ Security Incident Reports

RESTRICTED (Level 3)
  └─ Enterprise Client Acquisition Strategy

TOP-SECRET (Level 4)
  └─ Strategic Intelligence Brief
```

### Authentication Flow

1. **User visits**: `https://identuslabel.cz/ca/dashboard`
   - Shows public content + "Get Security Clearance" button

2. **User clicks**: "Get Security Clearance"
   - Redirected to `/security-clearance.html`
   - Dual-key credential issuance form (Ed25519 + X25519)
   - Complete VC verification with wallet

3. **CA creates session**:
   - Verifies RealPerson + SecurityClearanceLevel credentials
   - Extracts clearance level and X25519 public key
   - Creates session (1-hour expiration)

4. **Redirect to dashboard**: `/dashboard?session={sessionId}`
   - Content expands progressively based on clearance level
   - Same page - no separate redirects

### Phase 1: Progressive Disclosure

**Status**: ✅ FULLY OPERATIONAL

**API Endpoint**: `GET /api/dashboard/content?session={sessionId}`

**Features**:
- Server-side content filtering by clearance level
- HTTPS encryption in transit
- Session-based authentication
- No client-side decryption required

**Response Format**:
```json
{
  "success": true,
  "user": {
    "name": "Alice Smith",
    "clearanceLevel": "CONFIDENTIAL",
    "authenticated": true
  },
  "sections": [
    {
      "id": "public-1",
      "title": "Welcome to Secure Information Portal",
      "content": "Plaintext content...",
      "clearanceBadge": "PUBLIC",
      "badgeColor": "#4CAF50",
      "category": "general"
    }
    // ... more sections
  ]
}
```

### Phase 2: Client-Side Encryption

**Status**: ✅ FULLY OPERATIONAL (November 2, 2025)

**API Endpoint**: `GET /api/dashboard/encrypted-content?session={sessionId}`

**Architecture**:
```
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│   Browser    │                  │   CA Server  │                  │    Wallet    │
│  Dashboard   │                  │              │                  │   (E2E Dec)  │
└──────────────┘                  └──────────────┘                  └──────────────┘
       │                                 │                                 │
       │ 1. GET /encrypted-content      │                                 │
       ├───────────────────────────────>│                                 │
       │                                 │                                 │
       │                                 │ 2. Encrypt with X25519          │
       │                                 │    (user's public key)          │
       │                                 │                                 │
       │ 3. Return encrypted sections   │                                 │
       │<───────────────────────────────┤                                 │
       │                                 │                                 │
       │ 4. postMessage(encrypted)      │                                 │
       ├───────────────────────────────────────────────────────────────>│
       │                                 │                                 │
       │                                 │ 5. Decrypt with X25519          │
       │                                 │    (user's private key)         │
       │                                 │                                 │
       │ 6. postMessage(plaintext)      │                                 │
       │<───────────────────────────────────────────────────────────────┤
       │                                 │                                 │
       │ 7. Display content              │                                 │
       │                                 │                                 │
```

**Features**:
- **X25519 Key Agreement**: Diffie-Hellman shared secret derivation
- **XSalsa20-Poly1305**: Authenticated encryption (confidentiality + integrity)
- **Zero-Knowledge Server**: Server cannot decrypt content after encryption
- **BroadcastChannel/postMessage**: Secure wallet communication
- **Performance**: 317-350ms latency per section

**Encryption Format**:
```json
{
  "encrypted": true,
  "algorithm": "XSalsa20-Poly1305",
  "version": "2.0",
  "ciphertext": "base64url_encoded_ciphertext",
  "nonce": "base64url_encoded_nonce_24_bytes",
  "senderPublicKey": "CA_x25519_public_key_base64url",
  "recipientPublicKey": "user_x25519_public_key_base64url"
}
```

**Implementation Files**:
- **Encryption Library**: `/lib/encryption.js`
- **API Endpoint**: `/server.js` lines 3956-4113
- **Dashboard UI**: `/public/dashboard.html`
- **Documentation**: `/docs/ENCRYPTED_CONTENT_API.md`

### Content Database Abstraction

**File**: `/lib/contentDatabase.js`

**Purpose**: Provides database-agnostic content retrieval supporting multiple backends

**Current Implementation**: Local JSON storage (7 hardcoded sections)

**Future Implementation**: WordPress CMS integration

**Configuration**:
```bash
# Local mode (default)
CONTENT_SOURCE=local

# WordPress mode (future)
CONTENT_SOURCE=wordpress
WORDPRESS_URL=https://your-wordpress-site.com
WORDPRESS_API_ENDPOINT=/wp-json/security/v1/content
```

**Switching Content Sources**:
```javascript
// No frontend changes required!
// contentDatabase.js handles source switching transparently

async getAccessibleContent(clearanceLevel) {
  if (this.useWordPress) {
    return this.getContentFromWordPress(clearanceLevel);
  } else {
    return this.getContentFromLocal(clearanceLevel);
  }
}
```

**WordPress Integration Guide**: `/docs/WORDPRESS_INTEGRATION.md`

**Benefits**:
- **Content Management**: Non-technical users can edit content via WordPress admin UI
- **Versioning**: WordPress revision history
- **Media Support**: Rich media embedding (images, videos, PDFs)
- **SEO**: WordPress plugins for optimization
- **Zero Frontend Changes**: Database abstraction layer handles everything

### Session Management

**Session Structure**:
```javascript
{
  sessionId: 'uuid-v4',
  authenticated: true,
  firstName: 'Alice',
  lastName: 'Smith',
  clearanceLevel: 'CONFIDENTIAL',
  x25519PublicKey: 'base64url_encoded_key',
  hasEncryptionCapability: true,
  userData: {
    firstName: 'Alice',
    lastName: 'Smith',
    uniqueId: 'USER-001',
    clearanceLevel: 'CONFIDENTIAL'
  },
  clearanceData: {
    level: 'CONFIDENTIAL',
    verified: true,
    x25519PublicKey: 'base64url_key',
    issuedAt: '2025-11-02T10:00:00Z',
    validUntil: '2026-11-02T10:00:00Z'
  },
  createdAt: '2025-11-02T10:00:00Z',
  authenticatedAt: '2025-11-02T10:05:00Z',
  expiresAt: '2025-11-02T11:00:00Z'  // 1 hour duration
}
```

**Session Storage**: In-memory Map (`global.userSessions`)

**Session Expiration**:
- **Duration**: 1 hour (configurable)
- **Cleanup**: Automatic on access check
- **Behavior**: Dashboard gracefully degrades to public content when expired

---

## Configuration

### Environment Variables

```bash
# Server Configuration
PORT=3005                           # CA server port

# Cloud Agent Configuration
CLOUD_AGENT_URL=https://identuslabel.cz/cloud-agent
CLOUD_AGENT_API_KEY=admin          # Simple agent admin token
WALLET_ID=certification-authority-wallet
ENTITY_ID=certification-authority-entity

# Content Database (Dashboard)
CONTENT_SOURCE=local                # local | wordpress

# WordPress CMS (if CONTENT_SOURCE=wordpress)
WORDPRESS_URL=https://your-wordpress-site.com
WORDPRESS_API_ENDPOINT=/wp-json/security/v1/content

# Session Configuration
SESSION_DURATION=3600000            # 1 hour in milliseconds

# Logging
LOG_LEVEL=info                      # debug | info | warn | error
```

### File Paths

```
/root/certification-authority/
├── server.js                       # Main Express server (6,181 lines)
├── package.json                    # Dependencies
├── lib/
│   ├── contentDatabase.js          # Database abstraction layer
│   └── encryption.js               # X25519/XSalsa20-Poly1305 encryption
├── public/
│   ├── index.html                  # CA admin portal
│   ├── dashboard.html              # Secure Information Portal
│   ├── security-clearance.html     # Dual-key credential issuance
│   ├── realperson.html             # RealPerson credential form
│   ├── login.html                  # Login page
│   └── revocation-management.html  # Revocation admin UI
├── data/
│   ├── user-connection-mappings.json  # Persistent user connections
│   └── soft-deleted-connections.json  # Soft-deleted connections
├── docs/
│   ├── ENCRYPTED_CONTENT_API.md    # Phase 2 encryption API docs
│   └── WORDPRESS_INTEGRATION.md    # WordPress CMS integration guide
├── SCHEMA_REFERENCE.md             # Credential schemas quick reference
└── README.md                       # This file
```

### Dependencies

**Production**:
- `express@^4.18.2` - Web framework
- `node-fetch@^2.7.0` - HTTP client for Cloud Agent
- `libsodium-wrappers@^0.7.15` - X25519/XSalsa20-Poly1305 encryption
- `tweetnacl@^1.0.3` - Additional cryptographic primitives
- `tweetnacl-util@^0.15.1` - TweetNaCl utilities
- `pako@^2.1.0` - GZIP compression for StatusList
- `uuid@^11.1.0` - Session and credential ID generation

**Development**:
- `jsonwebtoken` - JWT credential decoding (for revocation status extraction)

---

## Deployment

### Prerequisites

1. **Cloud Agent Running**: `https://identuslabel.cz/cloud-agent`
2. **Mediator Running**: `https://identuslabel.cz/mediator`
3. **VDR/PRISM Node**: `91.99.4.54:50053`
4. **Node.js**: v18+ recommended

### Installation

```bash
cd /root/certification-authority

# Install dependencies
npm install

# Verify configuration
cat ca-config.json
```

### Start CA Server

```bash
# Standard start
PORT=3005 node server.js

# With PM2 (production)
pm2 start server.js --name ca-server -- --port=3005

# Background process
PORT=3005 node server.js &

# With logging
PORT=3005 node server.js > ca.log 2>&1 &
```

### Verify Service Health

```bash
# Health check
curl https://identuslabel.cz/ca/api/health

# Expected output:
# {
#   "status": "healthy",
#   "service": "Certification Authority",
#   "version": "1.0.0",
#   "cloudAgent": "connected",
#   "timestamp": "2025-11-02T10:00:00Z"
# }

# Test Cloud Agent connectivity
curl -s https://identuslabel.cz/cloud-agent/_system/health | jq '.'

# Test mediator
curl -I https://identuslabel.cz/mediator/
```

### Stop CA Server

```bash
# Stop background process
pkill -f "node server.js"

# Stop PM2 process
pm2 stop ca-server
pm2 delete ca-server

# Check running processes
ps aux | grep "node server.js"
```

### Restart After Changes

```bash
# Stop existing process
pkill -f "node server.js"

# Start fresh
PORT=3005 node server.js > ca.log 2>&1 &

# Monitor logs
tail -f ca.log
```

### Production Deployment

**Recommended Architecture**:
1. **Reverse Proxy**: nginx or Caddy for HTTPS termination
2. **Process Manager**: PM2 for auto-restart and monitoring
3. **Logging**: Winston or Pino for structured logging
4. **Monitoring**: Prometheus + Grafana for metrics
5. **Backup**: Regular backup of `data/` directory

**Example nginx Configuration**:
```nginx
server {
    listen 443 ssl http2;
    server_name ca.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Troubleshooting

### Common Issues

#### Issue: CA cannot connect to Cloud Agent

**Symptoms**:
- API requests return "Cloud Agent unreachable"
- Health check shows `"cloudAgent": "disconnected"`

**Diagnosis**:
```bash
# Test Cloud Agent directly
curl -s https://identuslabel.cz/cloud-agent/_system/health | jq '.'

# Check Cloud Agent logs
docker logs <cloud-agent-container>
```

**Solutions**:
1. Verify Cloud Agent is running: `docker ps | grep cloud-agent`
2. Check Cloud Agent health: `curl https://identuslabel.cz/cloud-agent/_system/health`
3. Verify API key in CA config: `CLOUD_AGENT_API_KEY=admin`
4. Restart Cloud Agent: `docker-compose -f cloud-agent-with-reverse-proxy.yml restart`

---

#### Issue: Credential not appearing in wallet

**Symptoms**:
- CA shows `CredentialSent` state
- Wallet doesn't display credential

**Diagnosis**:
```bash
# Check credential state
curl -s https://identuslabel.cz/cloud-agent/issue-credentials/records | jq '.contents[] | {recordId, state}'

# Check mediator message delivery
docker logs identus-mediator-identus-mediator-1 --tail 100 | grep ForwardMessage
```

**Solutions**:
1. Verify wallet initialized (browser console: "Agent started")
2. Check connection state (must be green/`ConnectionResponseSent`)
3. Verify mediator running: `curl -I https://identuslabel.cz/mediator/`
4. Hard refresh wallet (Ctrl+Shift+R or Cmd+Shift+R)
5. Check wallet IndexedDB for credential storage

---

#### Issue: "MissingEncryptionKeys" error on encrypted dashboard

**Symptoms**:
- User authenticated successfully
- Dashboard shows error: "Your Security Clearance credential does not contain X25519 encryption keys"

**Diagnosis**:
```bash
# Check session structure
# In browser console:
fetch('/api/session/' + sessionId).then(r => r.json()).then(console.log)

# Verify x25519PublicKey field exists
```

**Solutions**:
1. Issue new Security Clearance VC with dual-key format (v4.0.0)
2. Verify credential issuance form includes X25519 fields
3. Check user generated X25519 keys client-side
4. Confirm public keys submitted to CA during issuance

---

#### Issue: Revoked credential still appears valid in wallet

**Symptoms**:
- Credential revoked via CA admin UI
- Wallet verification still passes
- StatusList endpoint shows credential valid

**Explanation**: **This is expected behavior** - StatusList2021 uses asynchronous processing

**Timeline**:
- **Immediate (0-1 sec)**: Database `is_canceled` flag set to `true`
- **Delayed (30min-hours)**: StatusList bitstring updated via background job
- **After sync**: Public endpoint reflects revocation

**Verification**:
```bash
# Check database immediately
docker exec -it <cloud-agent-db> psql -U postgres -d pollux -c \
  "SELECT is_canceled, is_processed FROM credentials_in_status_list
   WHERE issue_credential_record_id = '<recordId>';"

# Expected: is_canceled=true, is_processed=false (immediately after)
# Expected: is_canceled=true, is_processed=true (after 30min-hours)
```

**See Also**: Main `/root/CLAUDE.md` - "StatusList2021 Credential Revocation Architecture" section

---

#### Issue: Session expired on dashboard

**Symptoms**:
- User authenticated successfully
- After 1 hour, dashboard shows only public content
- API returns 401 Unauthorized

**Explanation**: Sessions expire after 1 hour by design

**Solutions**:
1. User must re-authenticate (click "Get Security Clearance" again)
2. Extend session duration in server config (not recommended for security)
3. Implement session refresh mechanism (future enhancement)

---

#### Issue: Large encrypted content response size

**Symptoms**:
- Slow dashboard loading
- High bandwidth consumption
- Mobile performance degradation

**Diagnosis**:
- Encryption adds ~33% size overhead (base64url encoding)
- Each section includes metadata (nonce, public keys)
- 7 sections = ~10-20KB total response

**Solutions**:
1. Use Phase 1 endpoint (`/api/dashboard/content`) for non-sensitive content
2. Implement response compression (gzip) at nginx level
3. Consider content streaming for large sections (future enhancement)
4. Cache encrypted content client-side (unique per user)

---

#### Issue: Double revocation returns 500 error

**Symptoms**:
- First revocation succeeds (200 OK)
- Second revocation fails (500 Internal Server Error)

**Explanation**: Cloud Agent returns error when attempting to revoke already-revoked credential

**Solution**: Check `is_canceled` flag before attempting revocation

```bash
# Query database first
docker exec -it <db> psql -U postgres -d pollux -c \
  "SELECT is_canceled FROM credentials_in_status_list
   WHERE issue_credential_record_id = '<recordId>';"

# Only revoke if is_canceled = false
```

---

### Diagnostic Commands

```bash
# Check CA server process
ps aux | grep "node server.js"

# Monitor CA logs
tail -f /root/certification-authority/ca.log

# Check Cloud Agent health
curl -s https://identuslabel.cz/cloud-agent/_system/health | jq '.'

# Check mediator status
curl -I https://identuslabel.cz/mediator/

# List all connections
curl -s https://identuslabel.cz/ca/api/cloud-agent/connections | jq '.connections[]'

# List pending credentials
curl -s https://identuslabel.cz/ca/api/credentials/pending | jq '.credentials[]'

# List revocable credentials
curl -s https://identuslabel.cz/ca/api/credentials/revocable | jq '.credentials[]'

# Check session status
curl -s https://identuslabel.cz/ca/api/session/{sessionId} | jq '.'

# Test encrypted content endpoint
SESSION_ID=$(curl -s -X POST https://identuslabel.cz/ca/api/test/create-session-with-encryption \
  -H "Content-Type: application/json" \
  -d '{"clearanceLevel": "CONFIDENTIAL"}' | jq -r '.sessionId')

curl -s "https://identuslabel.cz/ca/api/dashboard/encrypted-content?session=${SESSION_ID}" | jq '.'
```

---

## Related Documentation

### Internal Documentation

- **Main Infrastructure Guide**: `/root/CLAUDE.md` - Complete SSI infrastructure documentation
- **Schema Reference**: `/SCHEMA_REFERENCE.md` - Credential schemas quick reference
- **Encrypted Content API**: `/docs/ENCRYPTED_CONTENT_API.md` - Phase 2 encryption details
- **WordPress Integration**: `/docs/WORDPRESS_INTEGRATION.md` - CMS integration guide
- **Phase 2 Implementation**: `/PHASE2_IMPLEMENTATION_SUMMARY.md` - Technical implementation summary
- **Phase 2 Testing**: `/PHASE2_TESTING_GUIDE.md` - Testing procedures

### External Resources

**Hyperledger Identus**:
- Documentation: https://docs.atalaprism.io/
- Cloud Agent: https://github.com/hyperledger/identus-cloud-agent
- Edge Agent SDK: https://github.com/hyperledger/identus-edge-agent-sdk-ts

**Standards**:
- W3C Verifiable Credentials: https://www.w3.org/TR/vc-data-model/
- W3C DIDs: https://www.w3.org/TR/did-core/
- DIDComm v2: https://identity.foundation/didcomm-messaging/spec/
- StatusList2021: https://www.w3.org/TR/vc-status-list/
- X25519: https://datatracker.ietf.org/doc/html/rfc7748
- XSalsa20-Poly1305: https://nacl.cr.yp.to/

---

## Development Notes

### Code Organization

**Main Server** (`server.js` - 6,181 lines):
- Lines 1-410: Imports, configuration, persistent storage
- Lines 411-533: DID management endpoints
- Lines 534-775: Connection management
- Lines 870-1127: Schema creation (deprecated - use Cloud Agent directly)
- Lines 1303-1878: Credential issuance (RealPerson, SecurityClearance)
- Lines 1919-2000: Revocable credentials query (JWT decoding)
- Lines 2002-2563: Authentication and session management
- Lines 2674-3360: Proof verification
- Lines 3731-4113: Dashboard content delivery (Phase 1 + Phase 2)
- Lines 4115-4255: Testing endpoints
- Lines 5923-6097: Admin credential management
- Lines 6022-6065: Credential revocation

**Library Files**:
- `lib/contentDatabase.js` - Database abstraction for dashboard content
- `lib/encryption.js` - X25519/XSalsa20-Poly1305 encryption utilities

**Public HTML**:
- `public/index.html` - CA admin portal
- `public/dashboard.html` - Secure Information Portal
- `public/security-clearance.html` - Dual-key credential issuance form
- `public/realperson.html` - RealPerson credential form
- `public/revocation-management.html` - Revocation admin UI

### Adding New Credential Types

1. **Create Schema** in Cloud Agent:
   ```bash
   curl -X POST https://identuslabel.cz/cloud-agent/schema-registry/schemas \
     -H "apikey: admin" \
     -H "Content-Type: application/json" \
     -d @new-schema.json
   ```

2. **Add Issuance Endpoint** in `server.js`:
   ```javascript
   app.post('/api/credentials/issue-new-type', async (req, res) => {
     // Extract user fields from req.body
     // Auto-populate metadata fields
     // Call Cloud Agent credential offer endpoint
   });
   ```

3. **Create HTML Form** in `public/`:
   ```html
   <!-- new-credential-type.html -->
   <form id="new-credential-form">
     <!-- User input fields -->
   </form>
   ```

4. **Update Wallet** credential naming utility:
   ```typescript
   // demos/{alice,bob}-wallet/src/utils/credentialNaming.ts
   export function getCredentialDisplayName(vc: any): string {
     if (vc.credentialType === 'NewCredentialType') {
       return `${vc.holderName} (New Type) [Exp: ${expirationText}]`;
     }
   }
   ```

### Adding New Dashboard Content

**Phase 1 (Local JSON)**:
```javascript
// lib/contentDatabase.js - LOCAL_CONTENT.sections array
{
  id: 'new-section-1',
  title: 'New Security Briefing',
  requiredLevel: 2,  // CONFIDENTIAL
  clearanceBadge: 'CONFIDENTIAL',
  badgeColor: '#FF9800',
  category: 'security',
  content: `Detailed briefing content...`
}
```

**Phase 2 (WordPress CMS)**: See `/docs/WORDPRESS_INTEGRATION.md`

---

## Security Considerations

### Key Security Features

✅ **Client-Side Key Generation**: Private keys never transmitted to server
✅ **End-to-End Encryption**: Phase 2 dashboard content encrypted client-side only
✅ **Zero-Knowledge Server**: CA cannot decrypt encrypted dashboard content
✅ **StatusList2021 Revocation**: W3C-compliant privacy-preserving revocation
✅ **Session Expiration**: 1-hour session timeout prevents stale access
✅ **Hierarchical Access Control**: Progressive disclosure by clearance level
✅ **Authenticated Encryption**: XSalsa20-Poly1305 provides confidentiality + integrity
✅ **Soft Delete**: Connection soft-delete preserves audit trail

### Security Recommendations

**Production Deployment**:
1. **HTTPS Only**: Use TLS 1.3 for all communications
2. **API Key Rotation**: Rotate Cloud Agent API key regularly
3. **Session Storage**: Move from in-memory to Redis for scalability
4. **Rate Limiting**: Implement rate limiting on credential issuance endpoints
5. **Audit Logging**: Log all credential operations for compliance
6. **Input Validation**: Sanitize all user inputs before Cloud Agent submission
7. **CORS Policy**: Restrict CORS to trusted wallet origins only
8. **CSP Headers**: Implement Content Security Policy headers

**Key Management**:
- CA ephemeral X25519 keypair: Regenerate on server restart (current behavior)
- User X25519 private keys: Store in wallet IndexedDB with encryption
- Cloud Agent API key: Store in environment variables (not hardcoded)

---

## Performance

### Benchmarks

**Credential Issuance**:
- RealPerson: ~500ms (Cloud Agent processing)
- SecurityClearance: ~600ms (dual-key overhead)

**Dashboard Content Delivery**:
- Phase 1 (plaintext): ~50ms
- Phase 2 (encrypted): ~150ms server-side encryption
- Client-side decryption: 317-350ms per section (measured)

**Connection Establishment**:
- Out-of-Band invitation: ~200ms
- DIDComm connection handshake: ~1-2 seconds (includes mediator)

### Optimization Strategies

✅ **Ephemeral Keypair Caching**: CA X25519 keypair generated once per instance
✅ **Libsodium Performance**: Native C implementation for encryption
✅ **Connection Pooling**: Reuse HTTP connections to Cloud Agent
🔄 **Content Caching**: Cache encrypted content per user (future)
🔄 **Streaming Encryption**: Large content sections (future)
🔄 **Database Connection Pool**: PostgreSQL connection pooling (future)

---

## Changelog

### v1.0.0 (November 2, 2025)

**Major Features**:
- ✅ Phase 2 Client-Side Encryption - FULLY OPERATIONAL
- ✅ X25519 public key extraction from Security Clearance VCs
- ✅ postMessage API wallet communication
- ✅ Zero-knowledge server architecture
- ✅ Measured performance: 317-350ms decryption latency

**Recent Fixes**:
- ✅ StatusList2021 revocation endpoint (October 28, 2025)
- ✅ JWT credential decoding for revocable credentials query (October 28, 2025)
- ✅ Asynchronous revocation processing documentation (October 28, 2025)

**Previous Milestones**:
- ✅ RealPerson v3.0.0 schema with auto-populated metadata
- ✅ SecurityClearanceLevel v4.0.0 dual-key schema
- ✅ Progressive disclosure dashboard (Phase 1)
- ✅ Database abstraction layer for WordPress integration
- ✅ Persistent user-connection mappings
- ✅ Soft-delete connection management

---

## Support

**Issues and Questions**:
- Check `/root/CLAUDE.md` for complete infrastructure documentation
- Review `/docs/ENCRYPTED_CONTENT_API.md` for Phase 2 encryption details
- Consult `/SCHEMA_REFERENCE.md` for credential schema reference

**Troubleshooting Steps**:
1. Check CA server logs: `tail -f ca.log`
2. Verify Cloud Agent health: `curl https://identuslabel.cz/cloud-agent/_system/health`
3. Test mediator: `curl -I https://identuslabel.cz/mediator/`
4. Review diagnostic commands above
5. Check main troubleshooting guide in `/root/CLAUDE.md`

---

**Document Version**: 1.0
**Last Updated**: 2025-11-02
**Status**: Production-Ready - Fully Operational
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
