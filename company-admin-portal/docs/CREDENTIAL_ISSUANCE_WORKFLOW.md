# Credential Issuance Workflow Guide

**Hyperledger Identus Multitenancy Architecture - Company Credential Issuance**

This guide documents the complete workflow for issuing CompanyIdentity credentials from the Certification Authority (CA) to company wallets using Hyperledger Identus Cloud Agent 2.0.0 in multitenancy mode.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Complete Issuance Workflow](#complete-issuance-workflow)
4. [Verification Procedures](#verification-procedures)
5. [Troubleshooting](#troubleshooting)
6. [File Reference](#file-reference)

---

## Architecture Overview

### Hierarchical Credential Issuance

```
Certification Authority (CA Server)
  ├─ Cloud Agent: https://identuslabel.cz/cloud-agent (Main CA)
  ├─ DID: did:prism:... (CA's DID)
  └─ Issues credentials to companies

Company (TechCorp Corporation)
  ├─ Cloud Agent: http://91.99.4.54:8200 (Multitenancy - internal-only)
  ├─ Wallet ID: 40e3db59-afcb-46f7-ae39-47417ad894d9
  ├─ DID: did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf
  ├─ API Key: b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2
  └─ Receives credentials from CA
```

**Note**: Multitenancy Cloud Agent (port 8200) is accessible only via internal IP address and is not exposed through the reverse proxy.

**Key Principle**: CA and Company use **separate Cloud Agent instances** with **DIDComm messaging** for credential exchange.

### Multitenancy Cloud Agent Configuration

The Company Cloud Agent (port 8200) runs in multitenancy mode:

**Docker Compose**: `/root/company-cloud-agent.yml`
```yaml
services:
  company-cloud-agent:
    image: ghcr.io/hyperledger/identus-cloud-agent:2.0.0
    environment:
      MULTITENANCY_ENABLED: "true"
      API_KEY_ENABLED: "true"
      API_KEY_AUTO_PROVISIONING: "true"
      POLLUX_DB_NAME: pollux_company
      CONNECT_DB_NAME: connect_company
      AGENT_DB_NAME: agent_company
      # ... other environment variables
    ports:
      - "8200:8085"  # REST API (internal-only, not proxied)
      - "8290:8090"  # DIDComm endpoint
```

**Note**: These ports are internal-only and not exposed through the Caddy reverse proxy.

**Key Features**:
- **Separate Database**: Isolated company data (`pollux_company`, `connect_company`, `agent_company`)
- **API Key Authentication**: Each wallet has unique API key
- **DIDComm Service**: Endpoint at `http://91.99.4.54:8290/didcomm`

---

## Prerequisites

### 1. Infrastructure Running

Verify all services are operational:

```bash
# CA Server (Main Cloud Agent)
curl https://identuslabel.cz/_system/health | jq .

# Company Cloud Agent (Multitenancy)
curl http://91.99.4.54:8200/_system/health | jq .

# Mediator
curl https://identuslabel.cz/mediator/ -I

# Company Admin Portal
curl https://identuslabel.cz/company-admin/api/health | jq .
```

### 2. CA DID Published

CA must have a published PRISM DID:

```bash
# Check CA's DIDs
curl https://identuslabel.cz/cloud-agent/did-registrar/dids \
  -H "apikey: {CA_API_KEY}" | jq '.contents[] | {did, status}'

# Expected: status = "PUBLISHED"
```

### 3. Company Wallet Configured

Company must have:
- ✅ Wallet created with unique ID
- ✅ API key provisioned
- ✅ PRISM DID created and published
- ✅ Configuration in Company Admin Portal

**Verification**:
```bash
# Check company's DIDs
curl http://91.99.4.54:8200/cloud-agent/did-registrar/dids \
  -H "apikey: b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2" \
  | jq '.contents[] | {did, status}'
```

### 4. CompanyIdentity Schema Created

Schema must be registered on CA's Cloud Agent:

```bash
# Check schemas
curl https://identuslabel.cz/cloud-agent/schema-registry/schemas \
  -H "apikey: {CA_API_KEY}" | jq '.contents[] | select(.name == "CompanyIdentity")'
```

**Schema Structure**:
```json
{
  "name": "CompanyIdentity",
  "version": "1.0.0",
  "type": "https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json",
  "author": "did:prism:{CA_DID}",
  "attributes": {
    "companyName": "string",
    "companyDisplayName": "string",
    "registrationNumber": "string",
    "jurisdiction": "string",
    "industry": "string",
    "website": "string",
    "establishedDate": "date",
    "authorizedToIssueCredentials": "boolean",
    "credentialId": "string",
    "issuedDate": "date",
    "expiryDate": "date"
  }
}
```

---

## Complete Issuance Workflow

### Phase 1: DIDComm Connection Establishment

**CRITICAL**: CA and Company must establish a DIDComm connection before credential issuance.

#### Step 1.1: CA Creates Invitation

**CA Server Endpoint**:
```bash
POST https://identuslabel.cz/ca/api/cloud-agent/connections/create-invitation
Content-Type: application/json

{
  "label": "TechCorp Corporation Connection",
  "goalCode": "credential-issuance",
  "goal": "Establish connection for issuing CompanyIdentity credential"
}
```

**Response**:
```json
{
  "success": true,
  "invitation": {
    "invitationUrl": "https://my.domain.com/path?_oob=eyJpZCI6IjEyM...",
    "invitation": {
      "@id": "invitation-id",
      "@type": "https://didcomm.org/out-of-band/2.0/invitation",
      "from": "did:peer:2.Ez6LSgh...",
      "body": {
        "goal_code": "credential-issuance",
        "goal": "Establish connection for issuing CompanyIdentity credential",
        "accept": ["didcomm/v2"]
      }
    }
  },
  "connectionId": "connection-record-id"
}
```

**Important**: Save the `invitationUrl` and `connectionId` for next steps.

#### Step 1.2: Company Accepts Invitation

**Critical Fix Applied** (October 2024): Connection storage requires explicit peer DID creation and storage.

**Company Admin Portal Implementation** (`server.js:565-764`):

```javascript
// POST /api/cloud-agent/connections/accept-invitation
app.post('/api/cloud-agent/connections/accept-invitation', requireCompany, async (req, res) => {
  const { invitationUrl } = req.body;

  try {
    // 1. Accept invitation via Cloud Agent
    const acceptResult = await cloudAgentRequest(
      req.company.apiKey,
      '/connections',
      'POST',
      { invitation: invitationUrl }
    );

    const connectionRecord = acceptResult.data;

    // 2. CRITICAL: Extract peer DIDs from connection record
    const myDid = connectionRecord.myDid;
    const theirDid = connectionRecord.theirDid;

    // 3. Store peer DIDs in database (via did-registrar endpoint)
    await cloudAgentRequest(
      req.company.apiKey,
      '/did-registrar/dids',
      'POST',
      {
        method: 'peer',
        did: myDid,
        label: 'Connection to CA'
      }
    );

    // 4. Return connection record
    res.json({
      success: true,
      connection: connectionRecord
    });

  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
```

**Expected Connection States**:
1. **Initial**: `InvitationGenerated` (CA side)
2. **After Accept**: `ConnectionRequestPending` (both sides)
3. **Final**: `ConnectionResponseSent` (active, can issue credentials)

#### Step 1.3: Verify Connection Established

**CA Side**:
```bash
curl https://identuslabel.cz/cloud-agent/connections/{connectionId} \
  -H "apikey: {CA_API_KEY}" | jq '.state'

# Expected: "ConnectionResponseSent"
```

**Company Side** (internal-only access):
```bash
curl http://91.99.4.54:8200/cloud-agent/connections \
  -H "apikey: b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2" \
  | jq '.contents[] | {connectionId, state, theirLabel}'

# Expected: state = "ConnectionResponseSent"
```

**Note**: Multitenancy Cloud Agent accessible only via internal IP.

---

### Phase 2: Credential Issuance

#### Step 2.1: CA Creates Credential Offer

**CA Server Endpoint**:
```bash
POST https://identuslabel.cz/ca/api/credentials/issue-company-identity
Content-Type: application/json

{
  "connectionId": "connection-record-id",
  "companyName": "TechCorp Corporation",
  "companyDisplayName": "TechCorp",
  "registrationNumber": "CZ12345678",
  "jurisdiction": "Czech Republic",
  "industry": "Technology",
  "website": "https://techcorp.example.com",
  "establishedDate": "2020-01-15",
  "authorizedToIssueCredentials": true,
  "credentialId": "techcorp-company-id-001",
  "expiryDate": "2026-01-15"
}
```

**Backend Implementation** (`ca/server.js`):
```javascript
app.post('/api/credentials/issue-company-identity', async (req, res) => {
  const {
    connectionId,
    companyName,
    registrationNumber,
    jurisdiction,
    industry,
    website,
    establishedDate,
    authorizedToIssueCredentials,
    credentialId,
    expiryDate
  } = req.body;

  try {
    // 1. Get CA's published DID
    const didsResult = await cloudAgentRequest(
      CA_API_KEY,
      '/did-registrar/dids'
    );

    const publishedDid = didsResult.data.contents.find(
      d => d.status === 'PUBLISHED'
    );

    // 2. Create credential offer
    const offerPayload = {
      claims: {
        companyName,
        companyDisplayName: req.body.companyDisplayName || companyName,
        registrationNumber,
        jurisdiction,
        industry,
        website,
        establishedDate,
        authorizedToIssueCredentials,
        credentialId,
        issuedDate: new Date().toISOString().split('T')[0],
        expiryDate
      },
      issuingDID: publishedDid.did,
      connectionId,
      credentialFormat: 'JWT',
      automaticIssuance: false,
      schemaId: 'e64cd9eb-6a4e-3a2d-81b3-c77411d6fbdb'
    };

    // 3. Send offer to Cloud Agent
    const offerResult = await cloudAgentRequest(
      CA_API_KEY,
      '/issue-credentials/credential-offers',
      'POST',
      offerPayload
    );

    res.json({
      success: true,
      credentialRecord: offerResult.data
    });

  } catch (error) {
    console.error('Error issuing credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
```

**Expected Response**:
```json
{
  "success": true,
  "credentialRecord": {
    "recordId": "85a6a127-fc95-48b7-8e77-26e12aed6742",
    "protocolState": "OfferSent",
    "connectionId": "connection-record-id",
    "issuingDID": "did:prism:...",
    "claims": { /* credential claims */ }
  }
}
```

#### Step 2.2: Company Receives and Accepts Offer

**Automatic Processing**: Cloud Agent automatically receives the offer and stores it.

**Company Side - Check Pending Offers** (internal-only access):
```bash
curl http://91.99.4.54:8200/cloud-agent/issue-credentials/records \
  -H "apikey: {COMPANY_API_KEY}" \
  | jq '.contents[] | select(.protocolState == "OfferReceived")'
```

**Company Side - Accept Offer** (internal-only access):
```bash
POST http://91.99.4.54:8200/cloud-agent/issue-credentials/records/{recordId}/accept-offer
Authorization: apikey {COMPANY_API_KEY}
Content-Type: application/json

{
  "subjectId": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf"
}
```

**Expected State Transitions**:
1. `OfferSent` → `OfferReceived` (company receives offer)
2. `OfferReceived` → `RequestPending` (company accepts offer)
3. `RequestPending` → `RequestReceived` (CA receives request)

#### Step 2.3: CA Approves Credential Request

**CA Server Endpoint**:
```bash
POST https://identuslabel.cz/ca/api/approve-credential
Content-Type: application/json

{
  "recordId": "85a6a127-fc95-48b7-8e77-26e12aed6742"
}
```

**Backend Implementation**:
```javascript
app.post('/api/approve-credential', async (req, res) => {
  const { recordId } = req.body;

  try {
    const result = await cloudAgentRequest(
      CA_API_KEY,
      `/issue-credentials/records/${recordId}/issue-credential`,
      'POST',
      {}
    );

    res.json({
      success: true,
      message: 'Credential issued successfully',
      record: result.data
    });
  } catch (error) {
    console.error('Error approving credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
```

**Expected State Transitions**:
1. `RequestReceived` → `CredentialPending` (CA processing)
2. `CredentialPending` → `CredentialSent` (CA side)
3. `CredentialSent` → `CredentialReceived` (Company side)

#### Step 2.4: Company Receives Credential

**Automatic Processing**: Cloud Agent automatically receives and stores the credential.

**Company Side - Verify Receipt** (internal-only access):
```bash
curl http://91.99.4.54:8200/cloud-agent/issue-credentials/records/{recordId} \
  -H "apikey: {COMPANY_API_KEY}" \
  | jq '{recordId, protocolState, credential}'
```

**Expected Output**:
```json
{
  "recordId": "85a6a127-fc95-48b7-8e77-26e12aed6742",
  "protocolState": "CredentialReceived",
  "credential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."
}
```

**Credential Format**: Base64-encoded JWT (JSON Web Token)

---

### Phase 3: Display in Company Admin Portal

The Company Admin Portal automatically displays received credentials with filtering and detail views.

#### Step 3.1: Fetch Credentials

**Company Admin Portal Endpoint**:
```bash
GET https://identuslabel.cz/company-admin/api/company/credentials?filter=all
```

**Query Parameters**:
- `filter`: `all` | `active` | `revoked` | `expired`

**Response**:
```json
{
  "success": true,
  "credentials": [
    {
      "recordId": "85a6a127-fc95-48b7-8e77-26e12aed6742",
      "protocolState": "CredentialReceived",
      "credentialFormat": "JWT",
      "credentialType": "CompanyIdentity",
      "claims": {
        "companyName": "TechCorp Corporation",
        "registrationNumber": "CZ12345678",
        "jurisdiction": "Czech Republic",
        "industry": "Technology",
        "website": "https://techcorp.example.com",
        "establishedDate": "2020-01-15",
        "authorizedToIssueCredentials": true,
        "credentialId": "techcorp-company-id-001",
        "issuedDate": "2025-01-15",
        "expiryDate": "2026-01-15"
      },
      "issuedDate": "2025-01-15",
      "expiryDate": "2026-01-15",
      "status": "active",
      "credentialStatus": null,
      "issuer": "did:prism:...",
      "subject": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf",
      "jwtCredential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."
    }
  ],
  "totalCount": 1,
  "filter": "all",
  "stats": {
    "total": 1,
    "active": 1,
    "revoked": 0,
    "expired": 0
  }
}
```

#### Step 3.2: UI Display

The Company Admin Portal displays credentials in a filterable table with:

- **Filter Buttons**: All (1) | Active (1) | Revoked (0) | Expired (0)
- **Credential Table**: Credential ID, Company Name, Registration Number, Issued Date, Expiry Date, Status, Actions
- **Detail Modal**: Full credential information with copy JWT functionality

**Frontend Implementation** (`public/app.js`):
```javascript
// Automatically loads on page load
async function loadCompanyCredentials(filter = 'all') {
  const response = await fetch(`/company-admin/api/company/credentials?filter=${filter}`);
  const data = await response.json();

  if (data.success) {
    displayCompanyCredentials(data.credentials, data.stats);
  }
}

// Display in table with status badges
function displayCompanyCredentials(credentials, stats) {
  // Update filter counts
  document.getElementById('count-all').textContent = stats.total;
  document.getElementById('count-active').textContent = stats.active;
  document.getElementById('count-revoked').textContent = stats.revoked;
  document.getElementById('count-expired').textContent = stats.expired;

  // Render table rows with View Details and Copy JWT buttons
  // ...
}
```

---

## Verification Procedures

### End-to-End Verification Checklist

#### 1. Connection Verification

```bash
# CA Side
curl https://identuslabel.cz/cloud-agent/connections/{connectionId} \
  -H "apikey: {CA_API_KEY}" \
  | jq '{state, theirLabel, myDid, theirDid}'

# Company Side (internal-only access)
curl http://91.99.4.54:8200/cloud-agent/connections \
  -H "apikey: {COMPANY_API_KEY}" \
  | jq '.contents[] | select(.theirLabel == "Certification Authority") | {state, myDid, theirDid}'
```

**Expected**: Both sides show `state: "ConnectionResponseSent"`

#### 2. Credential State Verification

```bash
# CA Side (Issuer)
curl https://identuslabel.cz/cloud-agent/issue-credentials/records/{recordId} \
  -H "apikey: {CA_API_KEY}" \
  | jq '{recordId, protocolState, connectionId}'

# Company Side (Holder)
curl http://91.99.4.54:8200/cloud-agent/issue-credentials/records/{recordId} \
  -H "apikey: {COMPANY_API_KEY}" \
  | jq '{recordId, protocolState, credential}'
```

**Expected**:
- CA Side: `protocolState: "CredentialSent"`
- Company Side (internal-only access): `protocolState: "CredentialReceived"` with base64 `credential` field

#### 3. JWT Credential Decoding

```bash
# Extract credential from API response
CREDENTIAL_BASE64="eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."

# Decode base64 to JWT
echo "$CREDENTIAL_BASE64" | base64 -d

# Expected output: JWT string "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJkaWQ6cHJpc206..."
```

**Decode JWT** (using jwt.io or Node.js):
```javascript
const jwt = require('jsonwebtoken');
const jwtString = Buffer.from(credential, 'base64').toString('utf-8');
const decoded = jwt.decode(jwtString, { complete: true });

console.log(decoded.payload.vc);
// Expected: Verifiable Credential with CompanyIdentity claims
```

#### 4. Company Admin Portal Verification

**Access**: `https://identuslabel.cz/company-admin`

**Steps**:
1. Login with TechCorp credentials
2. Verify "Company Identity Credentials" section visible
3. Check credential displayed in table
4. Verify status badge shows "Active"
5. Click "View Details" → Modal shows full credential information
6. Click "Copy JWT" → JWT copied to clipboard

---

## Troubleshooting

### Common Issues

#### Issue 1: Connection State Stuck at "InvitationGenerated"

**Symptom**: Company accepts invitation, but CA side shows `InvitationGenerated`

**Cause**: Connection request not delivered via DIDComm

**Solutions**:
1. Verify mediator running: `curl https://identuslabel.cz/mediator/ -I`
2. Check mediator logs: `docker logs identus-mediator-identus-mediator-1 --tail 100`
3. Restart mediator: `docker restart identus-mediator-identus-mediator-1`
4. Re-create invitation and re-accept

#### Issue 2: Credential Offer Not Received

**Symptom**: CA shows `OfferSent`, Company doesn't show `OfferReceived`

**Cause**: DIDComm message delivery failure

**Solutions**:
1. Verify connection state is `ConnectionResponseSent` on both sides
2. Check company's message pickup:
   ```bash
   curl http://91.99.4.54:8200/cloud-agent/issue-credentials/records \
     -H "apikey: {COMPANY_API_KEY}"
   ```
3. Check mediator logs for `ForwardMessage` entries
4. Verify company's DIDComm endpoint accessible (internal-only): `curl http://91.99.4.54:8290/didcomm -I`

#### Issue 3: Credential Not Displayed in Company Admin Portal

**Symptom**: Credential in `CredentialReceived` state but not shown in UI

**Cause**: Frontend filter or JWT decoding error

**Solutions**:
1. Check browser console for JavaScript errors
2. Verify credential type is `CompanyIdentity` (not other credential type)
3. Check backend logs: `tail -f /tmp/company-admin.log`
4. Manually test API endpoint:
   ```bash
   curl https://identuslabel.cz/company-admin/api/company/credentials?filter=all \
     -H "Cookie: connect.sid={session-cookie}"
   ```

#### Issue 4: JWT Decoding Error

**Symptom**: Backend error "Cannot decode credential"

**Cause**: Invalid base64 encoding or malformed JWT

**Solutions**:
1. Verify credential format in Cloud Agent response (internal-only access):
   ```bash
   curl http://91.99.4.54:8200/cloud-agent/issue-credentials/records/{recordId} \
     -H "apikey: {COMPANY_API_KEY}" \
     | jq -r '.credential' | base64 -d
   ```
2. Check JWT structure (should have 3 parts separated by dots)
3. Verify `jsonwebtoken` npm package installed: `npm list jsonwebtoken`

#### Issue 5: "API key not found" Error

**Symptom**: Company Admin Portal cannot access Cloud Agent

**Cause**: Session not authenticated or API key misconfigured

**Solutions**:
1. Verify company configuration in `/root/company-admin-portal/config/companies.js`:
   ```javascript
   {
     id: 'techcorp',
     name: 'TechCorp Corporation',
     apiKey: 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2',
     cloudAgentUrl: 'http://91.99.4.54:8200'
   }
   ```
2. Test API key directly:
   ```bash
   curl http://91.99.4.54:8200/cloud-agent/did-registrar/dids \
     -H "apikey: b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2"
   ```
3. Check session authentication in browser (login required)

---

## File Reference

### CA Server Files

| File | Purpose | Location |
|------|---------|----------|
| **server.js** | Main CA server with credential issuance endpoints | `/root/certification-authority/server.js` |
| **CLAUDE.md** | Main infrastructure documentation | `/root/CLAUDE.md` |
| **cloud-agent-with-reverse-proxy.yml** | CA Cloud Agent Docker Compose | `/root/cloud-agent-with-reverse-proxy.yml` |

**Key CA Endpoints**:
- `POST /api/cloud-agent/connections/create-invitation` - Create DIDComm invitation
- `POST /api/credentials/issue-company-identity` - Issue CompanyIdentity credential
- `GET /api/credentials/pending` - Get pending credential approvals
- `POST /api/approve-credential` - Approve credential request

### Company Admin Portal Files

| File | Purpose | Location |
|------|---------|----------|
| **server.js** | Backend API with JWT decoding and filtering | `/root/company-admin-portal/server.js` |
| **index.html** | Frontend UI with credential display section | `/root/company-admin-portal/public/index.html` |
| **app.js** | JavaScript functionality for credential management | `/root/company-admin-portal/public/app.js` |
| **styles.css** | CSS styling for credential components | `/root/company-admin-portal/public/styles.css` |
| **companies.js** | Company configuration (API keys, DIDs) | `/root/company-admin-portal/config/companies.js` |

**Key Portal Endpoints**:
- `POST /api/cloud-agent/connections/accept-invitation` - Accept CA invitation
- `GET /api/company/credentials?filter={status}` - Get filtered credentials
- `GET /api/company/info` - Get company DID and wallet information

### Company Cloud Agent Files

| File | Purpose | Location |
|------|---------|----------|
| **company-cloud-agent.yml** | Multitenancy Cloud Agent Docker Compose | `/root/company-cloud-agent.yml` |
| **company-pg_hba.conf** | PostgreSQL authentication config | `/root/company-pg_hba.conf` |
| **init-company-dbs.sql** | Database initialization script | `/root/init-company-dbs.sql` |

### Critical Code Sections

**Connection Acceptance** (`company-admin-portal/server.js:565-764`):
```javascript
// POST /api/cloud-agent/connections/accept-invitation
// CRITICAL: Stores peer DIDs to prevent "Connection not found" errors
```

**JWT Decoding** (`company-admin-portal/server.js:438-494`):
```javascript
// function decodeCredential(record)
// Decodes base64 → JWT → extracts claims and status
```

**Credential Filtering** (`company-admin-portal/server.js:501-554`):
```javascript
// GET /api/company/credentials
// Filters by status (all/active/revoked/expired)
```

---

## Summary

**Complete Workflow**:
1. ✅ CA creates DIDComm invitation
2. ✅ Company accepts invitation (with peer DID storage fix)
3. ✅ Connection established (`ConnectionResponseSent`)
4. ✅ CA creates credential offer
5. ✅ Company receives and accepts offer
6. ✅ CA approves credential request
7. ✅ Company receives credential (`CredentialReceived`)
8. ✅ Company Admin Portal displays credential with filtering

**Key Success Factors**:
- Separate Cloud Agent instances for CA and Company
- DIDComm connection established before issuance
- Peer DID storage fix in connection acceptance
- JWT decoding in Company Admin Portal backend
- Credential status determination (active/revoked/expired)

**Result**: ✅ **FULLY OPERATIONAL** - Hierarchical credential issuance with multitenancy support

---

**Document Version**: 1.0
**Last Updated**: 2025-01-15
**Author**: Hyperledger Identus SSI Infrastructure Team
