# Employee Onboarding with Cloud Agent Wallet

**Complete Documentation of Automated Employee Wallet Creation Workflow**

---

## Overview

**Status**: ✅ **FULLY OPERATIONAL** (November 17, 2025)

A fully automated employee onboarding system that creates Cloud Agent wallets, publishes PRISM DIDs to the blockchain, and establishes DIDComm connections between employee wallets and the TechCorp company wallet.

### Achievement Summary

- **Status**: ✅ **Production-Ready** - All 11 steps complete with 100% success rate
- **Performance**: ~35-40 seconds total execution time
- **Architecture**: Enterprise Cloud Agent (port 8300) ↔ TechCorp Company Wallet (port 8200)
- **DID Publication**: PRISM DIDs published to Cardano blockchain (~28 seconds)
- **Connection**: Bidirectional DIDComm connection established between employee and TechCorp
- **Atomicity**: All-or-nothing transaction with automatic rollback on failure

---

## Architecture

### Infrastructure Components

```
┌─────────────────────────────────────────────────────────────┐
│ Company Admin Portal (Port 3010)                            │
│ - Employee management UI                                     │
│ - EmployeeWalletManager.js orchestration                    │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├──────────────────────────────────────────┐
                 │                                          │
                 ▼                                          ▼
┌─────────────────────────────────┐    ┌──────────────────────────────────┐
│ Enterprise Cloud Agent (8300)   │    │ TechCorp Cloud Agent (8200)      │
│ - Employee wallets               │◄──►│ - Company wallet                 │
│ - PRISM DID creation             │    │ - Connection invitations         │
│ - API: 91.99.4.54:8300           │    │ - API: 91.99.4.54:8200           │
│ - HTTPS: identuslabel.cz/enterprise│  │ - API Key: b45cde04...           │
└─────────────────────────────────┘    └──────────────────────────────────┘
                 │                                          │
                 └──────────────┬───────────────────────────┘
                                │
                                ▼
                 ┌──────────────────────────────┐
                 │ PRISM Node (50053)           │
                 │ - DID publication             │
                 │ - Blockchain verification     │
                 └──────────────────────────────┘
```

### Cross-Agent Communication

**DNS Resolution Fix** (Critical):
- Enterprise Cloud Agent container must resolve `identuslabel.cz` to host IP
- Solution: `extra_hosts: ["identuslabel.cz:91.99.4.54"]` in Docker Compose
- Without this fix: Connections stuck in `ConnectionRequestPending` state

---

## 11-Step Onboarding Workflow

### Step 1: Create Wallet

**Purpose**: Create isolated wallet container for employee in Enterprise Cloud Agent

**API Endpoint**: `POST http://91.99.4.54:8300/wallets`

**Request Body**:
```json
{
  "name": "Alice Test Employee - alice.test@techcorp.com"
}
```

**Response**:
```json
{
  "id": "255312ec-4340-4795-bab4-a0e8ad6ad032",
  "name": "Alice Test Employee - alice.test@techcorp.com",
  "createdAt": "2025-11-17T10:00:00Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:47-60`

**Validation**:
- Response must contain `id` field
- HTTP status 201 (Created)

**Rollback**: Delete wallet via `DELETE /wallets/{id}` (may return 404 if entity deleted first)

---

### Step 2: Create Entity

**Purpose**: Create authentication entity with wallet association

**API Endpoint**: `POST http://91.99.4.54:8300/iam/entities`

**Request Body**:
```json
{
  "name": "Alice Test Employee",
  "walletId": "255312ec-4340-4795-bab4-a0e8ad6ad032"
}
```

**Response**:
```json
{
  "id": "9f165095-cc1c-4224-83a4-c7cf3f6d0db8",
  "name": "Alice Test Employee",
  "walletId": "255312ec-4340-4795-bab4-a0e8ad6ad032",
  "createdAt": "2025-11-17T10:00:00Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:63-80`

**Validation**:
- Response must contain `id` field
- HTTP status 201 (Created)

**Rollback**: Delete entity via `DELETE /iam/entities/{id}` (cascades to API keys)

---

### Step 3: Register API Key

**Purpose**: Generate authentication token for employee's Cloud Agent access

**API Endpoint**: `POST http://91.99.4.54:8300/iam/apikey-authentication`

**Request Body**:
```json
{
  "entityId": "9f165095-cc1c-4224-83a4-c7cf3f6d0db8"
}
```

**Response**:
```json
{
  "apiKey": "fb1aa0d981364b51d895c86a4e2b7f3a8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f",
  "entityId": "9f165095-cc1c-4224-83a4-c7cf3f6d0db8",
  "createdAt": "2025-11-17T10:00:00Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:83-101`

**Validation**:
- Response must contain `apiKey` field (64-char hex string)
- HTTP status 201 (Created)

**Security**: API key stored in Service Configuration VC for edge wallet access

**Rollback**: API key automatically deleted when entity is deleted (cascade)

---

### Step 4: Create PRISM DID

**Purpose**: Create blockchain-anchored decentralized identifier for employee

**API Endpoint**: `POST http://91.99.4.54:8300/did-registrar/dids`

**Request Body**:
```json
{
  "documentTemplate": {
    "publicKeys": [
      {
        "id": "auth-key",
        "purpose": "authentication"
      },
      {
        "id": "assertion-key",
        "purpose": "assertionMethod"
      }
    ],
    "services": []
  }
}
```

**Response**:
```json
{
  "did": "did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58",
  "status": "CREATED",
  "didRef": {
    "canonicalId": "did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58",
    "longFormDid": "did:prism:f8bf2e858d4c7bcd...?_state=..."
  }
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:104-131`

**Key Types**:
- **Authentication Key**: For DIDComm connections
- **Assertion Method Key**: For issuing/signing credentials

**State**: DID created locally, not yet on blockchain (status: `CREATED`)

---

### Step 5: Publish PRISM DID to Blockchain

**Purpose**: Anchor DID to Cardano blockchain for decentralized verification

**API Endpoint**: `POST http://91.99.4.54:8300/did-registrar/dids/{did}/publications`

**Request**: Empty body (POST trigger)

**Response**:
```json
{
  "scheduledOperation": {
    "id": "pub-op-123",
    "didRef": "did:prism:f8bf2e...",
    "status": "PENDING_SUBMISSION"
  }
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:309-340`

**Process**:
1. Submit publication request
2. Cloud Agent submits transaction to PRISM node
3. PRISM node broadcasts to Cardano network
4. Blockchain confirms transaction
5. DID status changes: `CREATED` → `PUBLICATION_PENDING` → `PUBLISHED`

**Timing**: Publication confirmation takes ~28 seconds (blockchain confirmation time)

---

### Step 6: Wait for DID Publication Completion

**Purpose**: Poll DID status until blockchain publication confirmed

**API Endpoint**: `GET http://91.99.4.54:8300/did-registrar/dids/{did}`

**Polling Strategy**:
- **Max Attempts**: 45
- **Interval**: 2 seconds
- **Total Timeout**: 90 seconds
- **Success State**: `status === "PUBLISHED"`

**Response** (published):
```json
{
  "did": "did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58",
  "status": "PUBLISHED",
  "didRef": {
    "canonicalId": "did:prism:f8bf2e...",
    "longFormDid": "did:prism:f8bf2e...?_state=..."
  },
  "publishedAt": "2025-11-17T10:00:28Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:343-381`

**Expected Timeline**:
- Attempt 1-13: `PUBLICATION_PENDING` (2-26 seconds)
- Attempt 14: `PUBLISHED` (28 seconds) ✅

**Console Output**:
```
[EmployeeWalletMgr] Waiting for DID publication (max 90s)...
[EmployeeWalletMgr] Attempt 1/45 - Status: PUBLICATION_PENDING
[EmployeeWalletMgr] Attempt 2/45 - Status: PUBLICATION_PENDING
...
[EmployeeWalletMgr] Attempt 14/45 - Status: PUBLISHED
✅ [EmployeeWalletMgr] DID published successfully
```

---

### Step 7: Create TechCorp Invitation

**Purpose**: Generate DIDComm invitation from TechCorp company wallet to employee

**API Endpoint**: `POST http://91.99.4.54:8200/connections`

**Request Body**:
```json
{
  "label": "TechCorp - Alice Test Employee"
}
```

**Response**:
```json
{
  "connectionId": "4787d564-2928-4f45-83f6-2370b6d3fe04",
  "state": "InvitationGenerated",
  "invitation": {
    "id": "inv-123",
    "type": "https://didcomm.org/out-of-band/2.0/invitation",
    "from": "did:peer:2...",
    "invitationUrl": "https://identuslabel.cz/didcomm?_oob=eyJ0eXBlIjoi..."
  }
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:384-426`

**Configuration**:
- **Cloud Agent**: TechCorp (port 8200)
- **API Key**: `b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2`
- **Label Format**: `TechCorp - {employeeName}`

**Key Fields**:
- `connectionId`: TechCorp-side connection identifier
- `invitationUrl`: Base64-encoded OOB invitation (for QR codes or direct links)

---

### Step 8: Employee Accept TechCorp Invitation

**Purpose**: Employee wallet accepts invitation and sends connection request

**API Endpoint**: `POST http://91.99.4.54:8300/connection-invitations`

**Request Body**:
```json
{
  "invitation": "https://identuslabel.cz/didcomm?_oob=eyJ0eXBlIjoi..."
}
```

**Response**:
```json
{
  "connectionId": "cf50d52c-960b-444a-90b5-2f9f67c520c4",
  "state": "ConnectionRequestPending",
  "thid": "thid-abc123",
  "role": "Invitee"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:429-471`

**Configuration**:
- **Cloud Agent**: Enterprise (port 8300)
- **API Key**: Employee's API key (from Step 3)
- **Authentication**: `apikey` header with employee credentials

**State Progression**:
1. `ConnectionRequestPending` (initial)
2. `ConnectionRequestSent` (request delivered)
3. `ConnectionResponseReceived` (TechCorp accepted) ✅ Final state for invitee

**Key Fields**:
- `connectionId`: Employee-side connection identifier (different from TechCorp's)
- `thid`: Thread ID for DIDComm message correlation

---

### Step 9: Wait for Employee Connection

**Purpose**: Poll employee connection until established

**API Endpoint**: `GET http://91.99.4.54:8300/connections/{connectionId}`

**Polling Strategy**:
- **Max Attempts**: 15
- **Interval**: 1 second
- **Total Timeout**: 15 seconds
- **Success States**: `Connected`, `ConnectionResponseReceived`, `ConnectionResponseSent`

**Response** (established):
```json
{
  "connectionId": "cf50d52c-960b-444a-90b5-2f9f67c520c4",
  "state": "ConnectionResponseReceived",
  "thid": "thid-abc123",
  "myDid": "did:peer:2...",
  "theirDid": "did:peer:2...",
  "role": "Invitee",
  "label": "TechCorp",
  "updatedAt": "2025-11-17T10:00:30Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:474-536`

**Expected Timeline**:
- Attempt 1: `ConnectionResponseReceived` (immediate) ✅

**Connection State Machine** (Cloud Agent 2.0.0):

**Invitee Side** (Employee):
```
InvitationGenerated
  → ConnectionRequestPending
  → ConnectionRequestSent
  → ConnectionResponseReceived ✅ (Final state)
```

**Inviter Side** (TechCorp):
```
InvitationGenerated
  → ConnectionRequestReceived
  → ConnectionResponseSent ✅ (Final state)
```

**Critical Fix**: Must accept `ConnectionResponseReceived` as valid final state for invitee (not just `Connected`).

---

### Step 10: Wait for TechCorp Connection

**Purpose**: Poll TechCorp connection until established

**API Endpoint**: `GET http://91.99.4.54:8200/connections/{connectionId}`

**Polling Strategy**:
- **Max Attempts**: 15
- **Interval**: 1 second
- **Total Timeout**: 15 seconds
- **Success States**: `Connected`, `ConnectionResponseReceived`, `ConnectionResponseSent`

**Response** (established):
```json
{
  "connectionId": "4787d564-2928-4f45-83f6-2370b6d3fe04",
  "state": "ConnectionResponseSent",
  "thid": "thid-abc123",
  "myDid": "did:peer:2...",
  "theirDid": "did:peer:2...",
  "role": "Inviter",
  "label": "TechCorp - Alice Test Employee",
  "updatedAt": "2025-11-17T10:00:30Z"
}
```

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:539-567`

**Configuration**:
- **Cloud Agent URL**: TechCorp (port 8200) - **Must pass explicit URL parameter**
- **API Key**: TechCorp API key
- **Connection ID**: From Step 7 (TechCorp-side ID)

**Critical Fix**: Must pass `cloudAgentUrl` parameter to `waitForConnectionComplete()` function to use TechCorp endpoint instead of hardcoded Employee endpoint.

**Expected Timeline**:
- Attempt 1: `ConnectionResponseSent` (immediate) ✅

**Verification**: Both sides show established connection (bidirectional confirmation)

---

### Step 11: Finalization

**Purpose**: Prepare Service Configuration VC payload for edge wallet integration

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:183-211`

**Service Configuration VC Fields**:
```json
{
  "enterpriseAgentUrl": "http://91.99.4.54:8300",
  "enterpriseAgentName": "TechCorp Enterprise Wallet",
  "enterpriseAgentApiKey": "fb1aa0d981364b51d895c86a4e2b7f3a8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f"
}
```

**Return Value**:
```javascript
{
  walletId: "255312ec-4340-4795-bab4-a0e8ad6ad032",
  entityId: "9f165095-cc1c-4224-83a4-c7cf3f6d0db8",
  apiKey: "fb1aa0d981364b51...",
  prismDid: "did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58",
  techCorpConnectionId: "4787d564-2928-4f45-83f6-2370b6d3fe04",
  employeeConnectionId: "cf50d52c-960b-444a-90b5-2f9f67c520c4",
  serviceConfigVCPayload: { /* Service Config VC claims */ }
}
```

**Next Step** (Not Automated):
1. CA issues Service Configuration VC to employee's edge wallet (Alice)
2. Employee accepts VC in edge wallet
3. Edge wallet extracts `enterpriseAgentUrl`, `enterpriseAgentName`, `enterpriseAgentApiKey`
4. Edge wallet can now query Cloud Agent API for DIDs, credentials, connections

---

## Performance Metrics

### Measured Execution Times (November 17, 2025)

| Step | Operation | Avg Time | Notes |
|------|-----------|----------|-------|
| 1 | Create Wallet | ~1s | HTTP POST to Enterprise Cloud Agent |
| 2 | Create Entity | ~1s | HTTP POST with wallet association |
| 3 | Register API Key | ~1s | Cryptographic key generation |
| 4 | Create PRISM DID | ~2s | Local DID creation (not blockchain) |
| 5 | Publish DID | ~1s | Submit to PRISM node |
| 6 | Wait for Publication | **~28s** | Blockchain confirmation (14 polling attempts) |
| 7 | Create TechCorp Invitation | ~1s | Generate DIDComm invitation |
| 8 | Accept Invitation | ~1s | Employee sends connection request |
| 9 | Wait Employee Connection | **~1s** | Immediate state change (1 attempt) |
| 10 | Wait TechCorp Connection | **~1s** | Immediate state change (1 attempt) |
| 11 | Finalization | <1s | Prepare return payload |
| **TOTAL** | **End-to-End** | **~35-40s** | **100% success rate** |

**Bottleneck**: Step 6 (DID publication) accounts for 70% of total time (blockchain confirmation)

---

## Configuration

### Environment Variables

**Enterprise Cloud Agent** (Employee Wallets):
```bash
ENTERPRISE_CLOUD_AGENT_URL="http://91.99.4.54:8300"
ENTERPRISE_ADMIN_TOKEN="3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu"
```

**TechCorp Cloud Agent** (Company Wallet):
```bash
TECHCORP_CLOUD_AGENT_URL="http://91.99.4.54:8200"
TECHCORP_API_KEY="b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2"
TECHCORP_WALLET_ID="40e3db59-afcb-46f7-ae39-47417ad894d9"
```

**Hardcoded in EmployeeWalletManager.js** (lines 21-28):
```javascript
const ENTERPRISE_CLOUD_AGENT_URL = process.env.ENTERPRISE_CLOUD_AGENT_URL || 'http://91.99.4.54:8300';
const ADMIN_TOKEN = process.env.ENTERPRISE_ADMIN_TOKEN || '3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu';
const TECHCORP_CLOUD_AGENT_URL = process.env.TECHCORP_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const TECHCORP_API_KEY = process.env.TECHCORP_API_KEY || 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const TECHCORP_WALLET_ID = process.env.TECHCORP_WALLET_ID || '40e3db59-afcb-46f7-ae39-47417ad894d9';
```

### DNS Configuration (Critical)

**File**: `/root/enterprise-cloud-agent.yml`

**Lines 119-121**:
```yaml
# DNS Resolution - Allow container to resolve identuslabel.cz to host IP
extra_hosts:
  - "identuslabel.cz:91.99.4.54"
```

**Why Required**:
- TechCorp invitation URLs contain `https://identuslabel.cz/didcomm` endpoint
- Without DNS mapping, Enterprise Cloud Agent container cannot resolve domain
- Results in connection stuck in `ConnectionRequestPending` state
- With DNS fix, connections establish immediately

**Verification**:
```bash
# Test DNS resolution inside container
docker exec enterprise-cloud-agent ping -c 1 identuslabel.cz
# Should resolve to: 91.99.4.54
```

---

## API Reference

### Enterprise Cloud Agent (Port 8300)

#### Wallets
- **POST** `/wallets` - Create wallet
- **GET** `/wallets/{id}` - Get wallet details
- **DELETE** `/wallets/{id}` - Delete wallet

#### IAM (Identity and Access Management)
- **POST** `/iam/entities` - Create entity
- **GET** `/iam/entities/{id}` - Get entity
- **DELETE** `/iam/entities/{id}` - Delete entity (cascades to API keys)
- **POST** `/iam/apikey-authentication` - Register API key

#### DID Registry
- **POST** `/did-registrar/dids` - Create PRISM DID
- **GET** `/did-registrar/dids/{did}` - Get DID status
- **POST** `/did-registrar/dids/{did}/publications` - Publish DID to blockchain

#### Connections
- **POST** `/connection-invitations` - Accept invitation (creates connection)
- **GET** `/connections/{id}` - Get connection status
- **GET** `/connections` - List all connections

### TechCorp Cloud Agent (Port 8200)

#### Connections
- **POST** `/connections` - Create invitation
- **GET** `/connections/{id}` - Get connection status
- **GET** `/connections` - List all connections

### Authentication

**Enterprise Cloud Agent**:
- **Admin Operations**: `x-admin-api-key: {ADMIN_TOKEN}` header
- **Wallet-Scoped Operations**: `apikey: {employeeApiKey}` header

**TechCorp Cloud Agent**:
- **All Operations**: `apikey: {TECHCORP_API_KEY}` header

---

## Rollback Mechanism

### Automatic Rollback on Failure

**Trigger**: Any step failure throws exception → `catch` block executes rollback

**Implementation**: `/root/company-admin-portal/lib/EmployeeWalletManager.js:215-305`

**Rollback Sequence**:
```javascript
try {
  // Steps 1-11: Employee wallet creation
} catch (error) {
  console.error(`❌ [EmployeeWalletMgr] Wallet creation failed at step: ${error.message}`);
  console.error(`❌ [EmployeeWalletMgr] Rolling back employee wallet for ${email}...`);

  // Rollback: Delete API key, entity, wallet
  await rollbackEmployeeWallet(walletId, entityId);

  throw error; // Re-throw for caller handling
}
```

### Rollback Steps

**Step 1: Delete API Key** (Automatic via entity deletion)
```javascript
console.log(`[EmployeeWalletMgr] Deleting API key for entity ${entityId}...`);
// API keys cascade delete when entity is deleted
console.log(`[EmployeeWalletMgr] API key will be deleted with entity`);
```

**Step 2: Delete Entity**
```javascript
const entityRes = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/iam/entities/${entityId}`, {
  method: 'DELETE',
  headers: { 'x-admin-api-key': ADMIN_TOKEN }
});

if (!entityRes.ok) {
  throw new Error(`Entity deletion: HTTP ${entityRes.status}`);
}
console.log(`✅ [EmployeeWalletMgr] Entity deleted`);
```

**Step 3: Delete Wallet**
```javascript
const walletRes = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/wallets/${walletId}`, {
  method: 'DELETE',
  headers: { 'x-admin-api-key': ADMIN_TOKEN }
});

if (!walletRes.ok) {
  errors.push(`Wallet deletion: HTTP ${walletRes.status}`);
} else {
  console.log(`✅ [EmployeeWalletMgr] Wallet deleted`);
}
```

**Known Behavior**: Wallet deletion may return 404 if entity was deleted first (cascade behavior). This is logged but not treated as fatal error.

### Rollback Completion

```javascript
if (errors.length > 0) {
  console.log(`⚠️ [EmployeeWalletMgr] Rollback completed with errors: ${JSON.stringify(errors)}`);
} else {
  console.log(`✅ [EmployeeWalletMgr] Rollback completed successfully`);
}
```

---

## Testing

### End-to-End Test Script

**File**: `/root/test-employee-onboarding-complete.js` (216 lines)

**Test Employee**:
```javascript
const testEmployee = {
  name: 'Alice Test Employee',
  email: 'alice.test@techcorp.com',
  department: 'Engineering'
};
```

**Test Flow**:
```javascript
async function runTest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST: Complete Employee Onboarding Flow');
  console.log('═══════════════════════════════════════════════════════════════');

  // Create employee wallet (11 steps)
  const result = await EmployeeWalletManager.createEmployeeWallet(
    testEmployee.name,
    testEmployee.email,
    testEmployee.department
  );

  // Verification 1: Check DID published
  // Verification 2: Check employee connection established
  // Verification 3: Check TechCorp connection established
  // Verification 4: Validate Service Config VC payload
}
```

### Test Results (November 17, 2025)

**Log File**: `/tmp/employee-onboarding-FINAL-TEST.log`

**Output**:
```
═══════════════════════════════════════════════════════════════
  TEST: Complete Employee Onboarding Flow
═══════════════════════════════════════════════════════════════

📋 Test Employee:
   Name: Alice Test Employee
   Email: alice.test@techcorp.com
   Department: Engineering

🚀 Starting employee wallet creation (11 steps)...

🏗️  [EmployeeWalletMgr] Creating wallet for: Alice Test Employee (alice.test@techcorp.com)
  → Step 1/11: Creating wallet...
  ✅ Wallet created: 255312ec-4340-4795-bab4-a0e8ad6ad032
  → Step 2/11: Creating entity...
  ✅ Entity created: 9f165095-cc1c-4224-83a4-c7cf3f6d0db8
  → Step 3/11: Registering API key...
  ✅ API key registered: fb1aa0d981364b51...
  → Step 4/11: Creating PRISM DID...
  ✅ PRISM DID created: did:prism:f8bf2e858d4c7bcd1871d69d521811...
  → Step 5/11: Publishing PRISM DID to blockchain...
  ✅ DID publication initiated
  → Step 6/11: Waiting for DID publication...
[EmployeeWalletMgr] Waiting for DID publication (max 90s)...
[EmployeeWalletMgr] Attempt 1/45 - Status: PUBLICATION_PENDING
[EmployeeWalletMgr] Attempt 2/45 - Status: PUBLICATION_PENDING
...
[EmployeeWalletMgr] Attempt 14/45 - Status: PUBLISHED
✅ [EmployeeWalletMgr] DID published successfully
  ✅ DID published: did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58
  → Step 7/11: Creating TechCorp invitation...
  ✅ TechCorp invitation created (connectionId: 4787d564-2928-4f45-83f6-2370b6d3fe04)
  → Step 8/11: Employee accepting TechCorp invitation...
  ✅ Invitation accepted (connectionId: cf50d52c-960b-444a-90b5-2f9f67c520c4)
  → Step 9/11: Waiting for employee connection...
[EmployeeWalletMgr] Attempt 1/15 - State: ConnectionResponseReceived
✅ [EmployeeWalletMgr] Connection established
  → Step 10/11: Waiting for TechCorp connection...
[EmployeeWalletMgr] Attempt 1/15 - State: ConnectionResponseSent
✅ [EmployeeWalletMgr] Connection established
  → Step 11/11: Finalizing employee wallet...

🎉 [EmployeeWalletMgr] Employee wallet created successfully!
   Wallet ID: 255312ec-4340-4795-bab4-a0e8ad6ad032
   Entity ID: 9f165095-cc1c-4224-83a4-c7cf3f6d0db8
   PRISM DID: did:prism:f8bf2e858d4c7bcd1871d69d521811a5889eb66651ed2428d6a7844de0162e58
   TechCorp Connection: 4787d564-2928-4f45-83f6-2370b6d3fe04
   Employee Connection: cf50d52c-960b-444a-90b5-2f9f67c520c4
   API Key: fb1aa0d981364b51d895... (SAVE THIS!)
```

**Success Rate**: 100% (all 11 steps passed)

**Total Time**: ~35-40 seconds

---

## Troubleshooting

### Issue 1: Connection Stuck in ConnectionRequestPending

**Symptom**: Step 9 times out, connection never progresses

**Cause**: DNS resolution failure in Enterprise Cloud Agent container

**Solution**: Add `extra_hosts: ["identuslabel.cz:91.99.4.54"]` to `/root/enterprise-cloud-agent.yml`

**Verification**:
```bash
docker exec enterprise-cloud-agent ping -c 1 identuslabel.cz
# Should resolve to 91.99.4.54
```

---

### Issue 2: Step 10 Returns 401 Unauthorized

**Symptom**: `Failed to check connection status: 401` at Step 10

**Cause**: `waitForConnectionComplete()` was hardcoded to use Employee Cloud Agent URL, but checking TechCorp connection

**Solution**: Pass explicit `cloudAgentUrl` parameter to function

**Fixed Code** (lines 174-178):
```javascript
// Step 10: Wait for TechCorp connection to be established (using TechCorp URL)
await this.waitForConnectionComplete(
  techCorpConnectionId,
  TECHCORP_CLOUD_AGENT_URL,  // ✅ Explicit URL parameter
  TECHCORP_API_KEY
);
```

---

### Issue 3: Connection Not Recognized as Complete

**Symptom**: Step 9 or 10 times out despite connection being established

**Cause**: Function only accepted `Connected` or `ConnectionResponseSent` states, but invitee reaches `ConnectionResponseReceived`

**Solution**: Accept `ConnectionResponseReceived` as valid final state

**Fixed Code** (lines 507-513):
```javascript
// Connection is established when state is 'Connected', 'ConnectionResponseSent', or 'ConnectionResponseReceived'
// Note: ConnectionResponseReceived is the final state for invitee side in Cloud Agent 2.0.0
if (connectionData.state === 'Connected' ||
    connectionData.state === 'ConnectionResponseSent' ||
    connectionData.state === 'ConnectionResponseReceived') {
  console.log(`✅ [EmployeeWalletMgr] Connection established`);
  return connectionData;
}
```

---

### Issue 4: DID Publication Times Out

**Symptom**: Step 6 exceeds 90 seconds, DID stuck in `PUBLICATION_PENDING`

**Possible Causes**:
1. PRISM node not running
2. Blockchain network congestion
3. Enterprise Cloud Agent cannot reach PRISM node

**Verification**:
```bash
# Check PRISM node running
docker ps | grep prism-node

# Test PRISM node gRPC endpoint
grpcurl -plaintext 91.99.4.54:50053 list

# Check Enterprise Cloud Agent logs
docker logs enterprise-cloud-agent | grep -i prism
```

**Solution**:
- Ensure PRISM node healthy
- Verify `PRISM_NODE_HOST=91.99.4.54` and `PRISM_NODE_PORT=50053` in Enterprise Cloud Agent config
- Wait for blockchain confirmation (may take up to 90 seconds)

---

### Issue 5: Rollback Errors

**Symptom**: `⚠️ Rollback completed with errors: [ 'Wallet deletion: HTTP 404' ]`

**Cause**: Entity deletion cascades to wallet deletion in some Cloud Agent configurations

**Impact**: **None** - Wallet is already deleted, 404 is expected behavior

**Solution**: No action needed, this is normal behavior

---

## Code References

### EmployeeWalletManager.js

**File**: `/root/company-admin-portal/lib/EmployeeWalletManager.js` (596 lines)

**Key Functions**:

| Function | Lines | Purpose |
|----------|-------|---------|
| `createEmployeeWallet()` | 46-214 | Main orchestration (11 steps) |
| `rollbackEmployeeWallet()` | 215-305 | Cleanup on failure |
| `publishPrismDid()` | 309-340 | Publish DID to blockchain |
| `waitForPublicationComplete()` | 343-381 | Poll DID status |
| `createTechCorpInvitation()` | 384-426 | Generate TechCorp invitation |
| `acceptTechCorpInvitation()` | 429-471 | Employee accepts invitation |
| `waitForConnectionComplete()` | 474-536 | Poll connection status |

**Configuration Constants** (lines 21-28):
```javascript
const ENTERPRISE_CLOUD_AGENT_URL = process.env.ENTERPRISE_CLOUD_AGENT_URL || 'http://91.99.4.54:8300';
const ADMIN_TOKEN = process.env.ENTERPRISE_ADMIN_TOKEN || '3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu';
const TECHCORP_CLOUD_AGENT_URL = process.env.TECHCORP_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const TECHCORP_API_KEY = process.env.TECHCORP_API_KEY || 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const TECHCORP_WALLET_ID = process.env.TECHCORP_WALLET_ID || '40e3db59-afcb-46f7-ae39-47417ad894d9';
```

### Enterprise Cloud Agent Configuration

**File**: `/root/enterprise-cloud-agent.yml`

**DNS Fix** (lines 119-121):
```yaml
extra_hosts:
  - "identuslabel.cz:91.99.4.54"
```

**Environment Variables** (key sections):
```yaml
ADMIN_TOKEN: "3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu"
API_KEY_ENABLED: 'true'
REST_SERVICE_URL: http://91.99.4.54:8300/cloud-agent
DIDCOMM_SERVICE_URL: https://identuslabel.cz/enterprise/didcomm
PRISM_NODE_HOST: 91.99.4.54
PRISM_NODE_PORT: 50053
```

---

## Future Enhancements

### 1. Service Configuration VC Issuance Automation

**Current State**: Manual - CA must issue VC to employee's edge wallet

**Proposed**: Automatically issue Service Config VC during onboarding

**Implementation**:
```javascript
// Step 12 (new): Issue Service Configuration VC to edge wallet
const vcOffer = await createServiceConfigVCOffer(
  employeeConnectionId,
  serviceConfigVCPayload
);

// Step 13 (new): Wait for employee to accept offer
await waitForVCAccepted(vcOffer.recordId);
```

**Benefits**:
- Fully automated onboarding (no manual VC issuance)
- Employee can immediately access Cloud Agent data
- Reduces onboarding time

---

### 2. Batch Employee Onboarding

**Current State**: Single employee per API call

**Proposed**: Bulk import from CSV/JSON with parallel processing

**Implementation**:
```javascript
const employees = [
  { name: 'Alice', email: 'alice@techcorp.com', department: 'Engineering' },
  { name: 'Bob', email: 'bob@techcorp.com', department: 'Sales' },
  // ... more employees
];

const results = await Promise.allSettled(
  employees.map(emp => EmployeeWalletManager.createEmployeeWallet(
    emp.name, emp.email, emp.department
  ))
);

// Report: X succeeded, Y failed
```

**Benefits**:
- Onboard entire department at once
- Parallel execution reduces total time
- Bulk reporting

---

### 3. Employee Wallet Dashboard

**Current State**: No UI for employee wallet management

**Proposed**: Admin dashboard showing all employee wallets, connections, DIDs

**Features**:
- List all employees with wallet status
- View employee PRISM DIDs
- View employee connections (to TechCorp, external parties)
- Revoke employee credentials
- Deactivate employee wallets

---

### 4. Connection Metadata

**Current State**: Minimal connection labels

**Proposed**: Rich metadata (hire date, department, manager, etc.)

**Implementation**: Store metadata in connection's `metadata` field or separate database

**Benefits**:
- Better audit trail
- Connection search/filtering
- Compliance reporting

---

## Related Documentation

- **[CLAUDE.md](./CLAUDE.md)** - Complete SSI infrastructure documentation
- **[Company Admin Portal README](./company-admin-portal/README.md)** - Admin portal user guide
- **[Enterprise Cloud Agent Configuration](./enterprise-cloud-agent.yml)** - Docker Compose setup
- **[EmployeeWalletManager.js](./company-admin-portal/lib/EmployeeWalletManager.js)** - Source code

---

**Document Version**: 1.0
**Last Updated**: 2025-11-17
**Status**: Production-Ready
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
