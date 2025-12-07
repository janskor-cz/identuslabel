# Company Admin Portal API Reference

**Hyperledger Identus Multitenancy - REST API Documentation**

Complete API reference for the Company Admin Portal, including authentication, company management, employee connections, and credential operations.

---

## Table of Contents

1. [Base URL & Authentication](#base-url--authentication)
2. [Public Endpoints](#public-endpoints)
3. [Authentication Endpoints](#authentication-endpoints)
4. [Company Information](#company-information)
5. [DIDComm Connections](#didcomm-connections)
6. [Credential Management](#credential-management)
7. [Error Codes](#error-codes)
8. [Rate Limiting](#rate-limiting)

---

## Base URL & Authentication

### Base URLs

**Production**: `https://identuslabel.cz/company-admin`
**Local Development**: `http://localhost:3010`

### Authentication

The Company Admin Portal uses **session-based authentication** with cookies.

**Session Creation**:
```bash
POST /api/auth/login
Content-Type: application/json

{
  "companyId": "techcorp"
}
```

**Session Validation**:
- All company-scoped endpoints require an active session
- Session cookie name: `connect.sid`
- Session duration: 24 hours (configurable)
- Session stored server-side (express-session)

**Authentication Middleware**:
```javascript
// Automatic company context injection
const requireCompany = (req, res, next) => {
  if (!req.session.companyId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.company = companies.find(c => c.id === req.session.companyId);
  next();
};
```

---

## Public Endpoints

### GET /

Serve frontend UI (HTML).

**Response**: HTML page

**Example**:
```bash
curl https://identuslabel.cz/company-admin/
```

---

### GET /api/health

Health check endpoint.

**Authentication**: None required

**Response**:
```json
{
  "success": true,
  "service": "Company Admin Portal",
  "version": "1.0.0",
  "port": "3010",
  "cloudAgent": "http://91.99.4.54:8200",
  "uptime": 1234.567
}
```

**Note**: `cloudAgent` URL is internal-only (Multitenancy Cloud Agent not exposed through reverse proxy).

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/health
```

---

### GET /api/companies

List all registered companies.

**Authentication**: None required

**Response**:
```json
{
  "success": true,
  "companies": [
    {
      "id": "techcorp",
      "name": "TechCorp Corporation",
      "description": "Leading technology solutions provider",
      "industry": "Technology",
      "logo": "🏢"
    },
    {
      "id": "acme",
      "name": "ACME Corporation",
      "description": "General services and solutions",
      "industry": "Services",
      "logo": "🏭"
    },
    {
      "id": "evilcorp",
      "name": "EvilCorp Industries",
      "description": "Security testing entity",
      "industry": "Testing",
      "logo": "🦹"
    }
  ]
}
```

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/companies | jq .
```

---

## Authentication Endpoints

### POST /api/auth/login

Create authenticated session for a company.

**Authentication**: None required

**Request Body**:
```json
{
  "companyId": "techcorp"
}
```

**Response** (Success):
```json
{
  "success": true,
  "company": {
    "id": "techcorp",
    "name": "TechCorp Corporation",
    "description": "Leading technology solutions provider"
  }
}
```

**Response** (Error - Invalid Company):
```json
{
  "success": false,
  "error": "Company not found"
}
```

**Example**:
```bash
curl -X POST https://identuslabel.cz/company-admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"companyId": "techcorp"}' \
  -c cookies.txt
```

---

### GET /api/auth/current

Get currently authenticated company from session.

**Authentication**: Required (session)

**Response** (Authenticated):
```json
{
  "success": true,
  "company": {
    "id": "techcorp",
    "name": "TechCorp Corporation",
    "description": "Leading technology solutions provider"
  }
}
```

**Response** (Not Authenticated):
```json
{
  "success": false
}
```

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/auth/current \
  -b cookies.txt
```

---

### POST /api/auth/logout

Clear authenticated session.

**Authentication**: Required (session)

**Response**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Example**:
```bash
curl -X POST https://identuslabel.cz/company-admin/api/auth/logout \
  -b cookies.txt
```

---

## Company Information

### GET /api/company/info

Get company information including DID.

**Authentication**: Required (session)

**Response**:
```json
{
  "success": true,
  "company": {
    "id": "techcorp",
    "name": "TechCorp Corporation",
    "walletId": "40e3db59-afcb-46f7-ae39-47417ad894d9",
    "did": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf"
  }
}
```

**Implementation**:
- Fetches first published PRISM DID from Cloud Agent
- Filters for `status: "PUBLISHED"`
- Returns short-form DID

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/company/info \
  -b cookies.txt \
  | jq .
```

---

### GET /api/company/dids

List all DIDs for the authenticated company.

**Authentication**: Required (session)

**Query Parameters**:
- `status` (optional): Filter by DID status (`CREATED`, `PUBLICATION_PENDING`, `PUBLISHED`)

**Response**:
```json
{
  "success": true,
  "dids": [
    {
      "id": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf",
      "status": "PUBLISHED",
      "publicKeys": [
        {
          "id": "key-1",
          "purpose": "authentication"
        },
        {
          "id": "key-2",
          "purpose": "assertionMethod"
        }
      ],
      "services": [
        {
          "id": "service-1",
          "type": "LinkedDomains",
          "serviceEndpoint": "https://techcorp.example.com"
        }
      ]
    }
  ]
}
```

**Example**:
```bash
# Get all DIDs
curl https://identuslabel.cz/company-admin/api/company/dids \
  -b cookies.txt

# Get only published DIDs
curl 'https://identuslabel.cz/company-admin/api/company/dids?status=PUBLISHED' \
  -b cookies.txt
```

---

## DIDComm Connections

### GET /api/company/connections

List all DIDComm connections (employees) for the authenticated company.

**Authentication**: Required (session)

**Response**:
```json
{
  "success": true,
  "connections": [
    {
      "connectionId": "abc123",
      "state": "ConnectionResponseSent",
      "label": "Employee: John Doe",
      "theirLabel": "John Doe's Wallet",
      "role": "Software Engineer",
      "department": "Engineering",
      "myDid": "did:peer:...",
      "theirDid": "did:peer:...",
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-15T10:05:00Z"
    }
  ]
}
```

**Connection States**:
- `InvitationGenerated`: Invitation created, waiting for acceptance
- `ConnectionRequestPending`: Request received, pending approval
- `ConnectionResponseSent`: Connection active

**Example**:
```bash
curl https://identuslabel.cz/company-admin/api/company/connections \
  -b cookies.txt \
  | jq '.connections[] | {label, state}'
```

---

### POST /api/company/invite-employee

Create DIDComm invitation for new employee.

**Authentication**: Required (session)

**Request Body**:
```json
{
  "employeeName": "John Doe",
  "role": "Software Engineer",
  "department": "Engineering"
}
```

**Required Fields**:
- `employeeName` (string): Employee's full name

**Optional Fields**:
- `role` (string): Job title
- `department` (string): Department name

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
        "goal_code": "employee-onboarding",
        "goal": "Connect employee John Doe (Software Engineer, Engineering)",
        "accept": ["didcomm/v2"]
      }
    }
  },
  "connectionId": "connection-record-id"
}
```

**Example**:
```bash
curl -X POST https://identuslabel.cz/company-admin/api/company/invite-employee \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "employeeName": "John Doe",
    "role": "Software Engineer",
    "department": "Engineering"
  }' | jq .
```

---

### DELETE /api/company/connections/:connectionId

Remove employee connection.

**Authentication**: Required (session)

**URL Parameters**:
- `connectionId` (required): Cloud Agent connection record ID

**Response** (Success):
```json
{
  "success": true,
  "message": "Connection deleted successfully"
}
```

**Response** (Error - Not Found):
```json
{
  "success": false,
  "error": "Connection not found"
}
```

**Example**:
```bash
curl -X DELETE https://identuslabel.cz/company-admin/api/company/connections/abc123 \
  -b cookies.txt
```

---

### POST /api/cloud-agent/connections/accept-invitation

Accept DIDComm invitation (for company-to-CA connections).

**Authentication**: Required (session)

**Request Body**:
```json
{
  "invitationUrl": "https://identuslabel.cz/ca/invitation?_oob=eyJpZCI6IjEyM..."
}
```

**Response**:
```json
{
  "success": true,
  "connection": {
    "connectionId": "connection-id",
    "state": "ConnectionRequestPending",
    "myDid": "did:peer:...",
    "theirDid": "did:peer:...",
    "theirLabel": "Certification Authority"
  }
}
```

**Critical Fix** (October 2024): This endpoint now properly stores peer DIDs to prevent "Connection not found" errors.

**Example**:
```bash
curl -X POST https://identuslabel.cz/company-admin/api/cloud-agent/connections/accept-invitation \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "invitationUrl": "https://identuslabel.cz/ca/invitation?_oob=eyJpZCI6IjEyM..."
  }'
```

---

## Credential Management

### GET /api/company/credentials

Get company credentials with filtering by status.

**Authentication**: Required (session)

**Query Parameters**:
- `filter` (optional): `all` | `active` | `revoked` | `expired` (default: `all`)

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
        "companyDisplayName": "TechCorp",
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
      "issuedDate": "2025-01-15T00:00:00Z",
      "expiryDate": "2026-01-15T00:00:00Z",
      "status": "active",
      "credentialStatus": null,
      "issuer": "did:prism:...",
      "subject": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf",
      "jwtCredential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ...",
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-15T10:05:00Z"
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

**Status Determination**:
- **Active**: Not expired and not on revocation list
- **Expired**: Current date > `expiryDate`
- **Revoked**: On StatusList2021 (future implementation)

**Credential Filtering**:
- Only shows `CompanyIdentity` credential type
- Only shows `CredentialReceived` or `CredentialSent` protocol states
- Decodes base64 JWT to extract claims

**Example**:
```bash
# Get all credentials
curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=all' \
  -b cookies.txt \
  | jq .

# Get only active credentials
curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=active' \
  -b cookies.txt

# Get expired credentials
curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=expired' \
  -b cookies.txt
```

---

### POST /api/company/issue-credential

Issue verifiable credential to connected employee.

**Authentication**: Required (session)

**Request Body**:
```json
{
  "connectionId": "abc123",
  "credentialType": "EmployeeID",
  "claims": {
    "employeeName": "John Doe",
    "employeeId": "EMP001",
    "role": "Software Engineer",
    "department": "Engineering",
    "email": "john.doe@techcorp.com",
    "issuedDate": "2025-01-15",
    "expiryDate": "2026-01-15"
  },
  "automaticIssuance": false
}
```

**Required Fields**:
- `connectionId` (string): Target connection ID
- `credentialType` (string): Type of credential to issue
- `claims` (object): Credential claims/attributes

**Optional Fields**:
- `automaticIssuance` (boolean): Auto-issue without approval (default: `false`)
- `schemaId` (string): Schema ID (uses default if not provided)

**Response**:
```json
{
  "success": true,
  "credentialRecord": {
    "recordId": "credential-record-id",
    "protocolState": "OfferSent",
    "connectionId": "abc123",
    "credentialFormat": "JWT",
    "claims": { /* ... */ }
  }
}
```

**Example**:
```bash
curl -X POST https://identuslabel.cz/company-admin/api/company/issue-credential \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connectionId": "abc123",
    "credentialType": "EmployeeID",
    "claims": {
      "employeeName": "John Doe",
      "employeeId": "EMP001",
      "role": "Software Engineer",
      "department": "Engineering"
    },
    "automaticIssuance": false
  }'
```

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Description |
|------|---------|-------------|
| **200** | OK | Request successful |
| **201** | Created | Resource created successfully |
| **400** | Bad Request | Invalid request parameters |
| **401** | Unauthorized | Not authenticated (no session) |
| **403** | Forbidden | Authenticated but not authorized |
| **404** | Not Found | Resource not found |
| **500** | Internal Server Error | Server error or Cloud Agent failure |

### Error Response Format

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

### Common Error Messages

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `Not authenticated` | No active session | Call `/api/auth/login` first |
| `Company not found` | Invalid company ID | Check company ID in login request |
| `Connection not found` | Invalid connection ID | Verify connection exists via `/api/company/connections` |
| `Cloud Agent request failed` | Multitenancy Cloud Agent error | Check Cloud Agent logs: `docker logs company-cloud-agent` |
| `Cannot find module 'jsonwebtoken'` | Missing dependency | Run `npm install jsonwebtoken` |

---

## Rate Limiting

**Current Status**: No rate limiting implemented

**Future Consideration**: Rate limiting may be added to prevent abuse

**Recommended Limits** (for future implementation):
- Public endpoints: 100 requests/minute/IP
- Authenticated endpoints: 1000 requests/minute/session
- Credential operations: 10 requests/minute/session

---

## Example Workflows

### Complete Employee Onboarding

```bash
# 1. Login as TechCorp
curl -X POST https://identuslabel.cz/company-admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"companyId": "techcorp"}' \
  -c cookies.txt

# 2. Get company info and DID
curl https://identuslabel.cz/company-admin/api/company/info \
  -b cookies.txt

# 3. Create employee invitation
INVITATION=$(curl -X POST https://identuslabel.cz/company-admin/api/company/invite-employee \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "employeeName": "John Doe",
    "role": "Software Engineer",
    "department": "Engineering"
  }' | jq -r '.invitation.invitationUrl')

echo "Share this invitation: $INVITATION"

# 4. Wait for employee to accept connection (check periodically)
curl https://identuslabel.cz/company-admin/api/company/connections \
  -b cookies.txt \
  | jq '.connections[] | select(.label | contains("John Doe"))'

# 5. Once connected, issue credential
CONNECTION_ID=$(curl https://identuslabel.cz/company-admin/api/company/connections \
  -b cookies.txt \
  | jq -r '.connections[] | select(.label | contains("John Doe")) | .connectionId')

curl -X POST https://identuslabel.cz/company-admin/api/company/issue-credential \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d "{
    \"connectionId\": \"$CONNECTION_ID\",
    \"credentialType\": \"EmployeeID\",
    \"claims\": {
      \"employeeName\": \"John Doe\",
      \"employeeId\": \"EMP001\",
      \"role\": \"Software Engineer\"
    }
  }"
```

### Retrieve Company Credentials

```bash
# 1. Login
curl -X POST https://identuslabel.cz/company-admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"companyId": "techcorp"}' \
  -c cookies.txt

# 2. Get all credentials with stats
curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=all' \
  -b cookies.txt \
  | jq '{total: .stats.total, active: .stats.active, credentials: .credentials}'

# 3. Get only active credentials
curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=active' \
  -b cookies.txt \
  | jq '.credentials[] | {companyName: .claims.companyName, status: .status}'

# 4. Extract JWT credential
JWT=$(curl 'https://identuslabel.cz/company-admin/api/company/credentials?filter=all' \
  -b cookies.txt \
  | jq -r '.credentials[0].jwtCredential')

echo "JWT Credential: $JWT"
```

---

## Technical Notes

### Session Management

**Implementation**: `express-session` with MemoryStore

**Session Data Structure**:
```javascript
{
  companyId: 'techcorp',
  cookie: {
    originalMaxAge: 86400000, // 24 hours
    expires: '2025-01-16T10:00:00Z',
    httpOnly: true,
    path: '/'
  }
}
```

**Production Consideration**: Use Redis or database-backed session store for production deployments.

### JWT Credential Decoding

**Process**:
1. Fetch credential from Cloud Agent (base64-encoded)
2. Decode base64 to UTF-8 string (JWT format)
3. Decode JWT without verification using `jsonwebtoken` library
4. Extract `payload.vc` for Verifiable Credential structure
5. Extract `payload.vc.credentialSubject` for claims

**Code Reference**: `server.js:438-494` (`decodeCredential()` function)

### Multitenancy Cloud Agent Integration

**Authentication Flow**:
1. User selects company in frontend
2. Frontend calls `/api/auth/login` with `companyId`
3. Session stores `companyId`
4. Middleware `requireCompany` loads company config
5. Company API key injected into Cloud Agent requests
6. Cloud Agent scopes operations to company wallet

**Key Benefit**: Companies cannot access each other's data (enforced by API key scoping)

---

## Support & Troubleshooting

**Server Logs**:
```bash
tail -f /tmp/company-admin.log
```

**Cloud Agent Logs**:
```bash
docker logs company-cloud-agent --tail 100
```

**Health Checks**:
```bash
# Portal health
curl https://identuslabel.cz/company-admin/api/health

# Cloud Agent health (internal-only access)
curl http://91.99.4.54:8200/_system/health
```

**Note**: Multitenancy Cloud Agent (port 8200) is only accessible via internal IP address.

**Common Issues**:
- **Session expired**: Re-login via `/api/auth/login`
- **Cloud Agent connection error**: Verify Cloud Agent running on port 8200
- **Credentials not displaying**: Check `jsonwebtoken` dependency installed

---

## Related Documentation

- **[CREDENTIAL_ISSUANCE_WORKFLOW.md](./CREDENTIAL_ISSUANCE_WORKFLOW.md)** - Complete credential issuance guide
- **[README.md](../README.md)** - Company Admin Portal overview
- **[/root/CLAUDE.md](/root/CLAUDE.md)** - Main infrastructure documentation

---

**Document Version**: 1.0
**Last Updated**: 2025-01-15
**Author**: Hyperledger Identus SSI Infrastructure Team
