# StatusList2021 Credential Revocation Architecture

> **Note**: This documentation was extracted from CLAUDE.md on 2025-11-15 for better organization and maintainability.

## Table of Contents

- [Overview](#overview)
- [How StatusList2021 Works](#how-statuslist2021-works)
  - [1. Credential Structure (with revocation enabled)](#1-credential-structure-with-revocation-enabled)
  - [2. Public StatusList Endpoint](#2-public-statuslist-endpoint)
  - [3. Verification Flow](#3-verification-flow)
  - [4. Revocation by Issuer](#4-revocation-by-issuer)
- [Asynchronous Revocation Processing](#asynchronous-revocation-processing)
  - [Phase 1: Immediate Database Update (Synchronous)](#phase-1-immediate-database-update-synchronous)
  - [Phase 2: Delayed StatusList Bitstring Update (Asynchronous)](#phase-2-delayed-statuslist-bitstring-update-asynchronous)
  - [What This Means for Integrations](#what-this-means-for-integrations)
- [Technical Details](#technical-details)
  - [Database Schema](#database-schema)
  - [Background Job Mechanism](#background-job-mechanism)
- [Testing & Verification](#testing--verification)
  - [Immediate Verification (Database Check)](#immediate-verification-database-check)
  - [Delayed Verification (StatusList Sync Check)](#delayed-verification-statuslist-sync-check)
  - [Public Endpoint Verification](#public-endpoint-verification)
  - [End-to-End Verification](#end-to-end-verification)
- [Known Behaviors](#known-behaviors)
  - [StatusList Update Delays Are Normal](#statuslist-update-delays-are-normal)
  - [Double Revocation Returns Error](#double-revocation-returns-error)
  - [Credentials Without credentialStatusId Cannot Be Revoked](#credentials-without-credentialstatusid-cannot-be-revoked)
- [Configuration](#configuration)
- [Integration Notes](#integration-notes)
  - [CA Server Requirements](#ca-server-requirements)
  - [Wallet Integration](#wallet-integration)
  - [Performance Considerations](#performance-considerations)
- [Standards Compliance](#standards-compliance)

---

## Overview

**Status**: ✅ **FULLY OPERATIONAL** (October 28, 2025)

Hyperledger Identus Cloud Agent 2.0.0 implements **W3C StatusList2021** for credential revocation using an **asynchronous batch processing architecture**. Fresh revocations work perfectly, but the system uses "eventual consistency" by design, with StatusList updates delayed 30 minutes to several hours after revocation.

**Key Discovery**: What appeared to be a "sync bug" is actually the intended architecture - the system prioritizes performance over real-time accuracy using asynchronous background jobs.

## How StatusList2021 Works

**Key Principle**: Revocation status is **NOT stored in the credential itself**. Instead, credentials contain a **reference** to an external StatusList.

### 1. Credential Structure (with revocation enabled)

When a credential is issued with revocation support, it includes a `credentialStatus` property:

```json
{
  "credentialStatus": {
    "id": "http://91.99.4.54:8000/cloud-agent/credential-status/{statusId}#12345",
    "type": "StatusList2021Entry",
    "statusPurpose": "revocation",
    "statusListIndex": "12345",
    "statusListCredential": "http://91.99.4.54:8000/cloud-agent/credential-status/{statusId}"
  }
}
```

### 2. Public StatusList Endpoint

**GET `/credential-status/{id}`** - Publicly accessible (no authentication required)

Returns a `StatusList2021Credential` (a special VC) containing:
- **Compressed bitstring**: GZIP-compressed list of revocation statuses
- **statusPurpose**: "revocation"
- **Issuer**: DID of the credential issuer
- **Proof**: Data integrity proof for the StatusList itself

**Example Response**:
```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://w3id.org/vc/status-list/2021/v1"
  ],
  "type": ["VerifiableCredential", "StatusList2021Credential"],
  "issuer": "did:prism:...",
  "id": "http://91.99.4.54:8000/cloud-agent/credential-status/{statusId}",
  "credentialSubject": {
    "type": "StatusList2021",
    "statusPurpose": "Revocation",
    "encodedList": "H4sIAAAAAAAA_-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA"
  }
}
```

### 3. Verification Flow

When a verifier receives a credential:

1. **Extract StatusList URL**: Read `credentialStatus.statusListCredential` from the credential
2. **Fetch StatusList VC**: HTTP GET to the public URL (no API key needed)
3. **Verify StatusList**: Validate the StatusList VC's cryptographic proof
4. **Decompress bitstring**: GZIP decompress the `encodedList` field
5. **Check bit**: Read bit at position `statusListIndex`
   - **Bit = 0**: Credential is valid (not revoked)
   - **Bit = 1**: Credential is revoked

**Privacy Feature**: StatusLists bundle thousands of credentials (minimum 131,072 entries), providing "group privacy" by obscuring which specific credential is being checked.

### 4. Revocation by Issuer

**API Endpoints**:
- **PATCH `/credential-status/revoke-credential/{recordId}`** - Works with full path
- **PATCH `/cloud-agent/credential-status/revoke-credential/{recordId}`** - Also works (with prefix)

Both endpoints require `apikey` authentication.

**Response**: HTTP 200 OK on success
```json
{
  "success": true
}
```

**Error Handling**:
- **404**: Credential not found or not revocable (missing `credentialStatusId`)
- **500**: Already revoked (attempting double revocation)

**CA Server Endpoint**: `/api/credentials/revoke/:recordId`
- Proxies to Cloud Agent revocation endpoint
- Fixed October 2025 to use correct endpoint path

## Asynchronous Revocation Processing

**CRITICAL UNDERSTANDING**: Cloud Agent uses a **two-phase asynchronous architecture** for revocation:

### Phase 1: Immediate Database Update (Synchronous)

When revocation endpoint is called:
1. **HTTP 200 OK** returned immediately
2. Database table `credentials_in_status_list` updated:
   - `is_canceled` flag set to `true`
   - `is_processed` flag set to `false`
   - Change visible in database instantly

**Verification Query**:
```sql
SELECT
  issue_credential_record_id,
  status_list_index,
  is_canceled,
  is_processed
FROM credentials_in_status_list
WHERE issue_credential_record_id = '{recordId}';
```

### Phase 2: Delayed StatusList Bitstring Update (Asynchronous)

Background job processes revocations in batches:
1. **Background Job**: `StatusListJobs.updateBitStringForCredentialAndNotify`
2. **Message Queue Topic**: `sync-status-list`
3. **Processing Delay**: 30 minutes to several hours
4. **Database Update**: `credential_status_lists` table updated:
   - `status_list_credential` JSON field contains the W3C VC
   - `encodedList` field within JSON updated with new bitstring
   - `updated_at` timestamp reflects last sync time
   - `is_processed` flag in `credentials_in_status_list` set to `true`

**Architecture Rationale**:
- **Performance**: Batching reduces cryptographic operations (signing StatusList VCs)
- **Efficiency**: Minimizes database writes to `credential_status_lists` table
- **Scalability**: Supports high-volume revocation scenarios
- **Tradeoff**: Real-time accuracy sacrificed for system performance

### What This Means for Integrations

**Immediate (0-1 second)**:
- ✅ Revocation API returns success
- ✅ Database `is_canceled` flag updated
- ✅ Internal systems can check revocation status via database

**Delayed (30 minutes - several hours)**:
- ⏳ StatusList bitstring not yet updated
- ⏳ Public `/credential-status/{id}` endpoint still shows valid
- ⏳ Wallet verification still passes
- ⏳ External verifiers see credential as valid

**After Background Processing**:
- ✅ StatusList bitstring updated
- ✅ Public endpoint reflects revocation
- ✅ Wallet verification fails
- ✅ External verifiers see credential as revoked

## Technical Details

### Database Schema

**Table: `credentials_in_status_list`** (Individual credential tracking)
```sql
CREATE TABLE credentials_in_status_list (
  id UUID PRIMARY KEY,
  issue_credential_record_id UUID NOT NULL,
  status_list_registry_id UUID NOT NULL,
  status_list_index INTEGER NOT NULL,  -- Position in bitstring (0-131071)
  is_canceled BOOLEAN DEFAULT FALSE,   -- Revocation flag (immediate)
  is_processed BOOLEAN DEFAULT FALSE,  -- Sync completion flag (delayed)
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

**Table: `credential_status_lists`** (StatusList VC storage)
```sql
CREATE TABLE credential_status_lists (
  id UUID PRIMARY KEY,
  issuer TEXT NOT NULL,                    -- DID of issuer
  issued TIMESTAMP NOT NULL,
  purpose TEXT NOT NULL,                   -- "revocation" or "suspension"
  status_list_credential JSONB NOT NULL,   -- W3C VC with encodedList
  size INTEGER DEFAULT 131072,             -- Bitstring size (16KB compressed)
  last_used_index INTEGER DEFAULT -1,      -- Last allocated position
  created_at TIMESTAMP,
  updated_at TIMESTAMP                     -- Last bitstring update time
);
```

**StatusList VC JSON Structure** (in `status_list_credential` field):
```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://w3id.org/vc/status-list/2021/v1"
  ],
  "type": ["VerifiableCredential", "StatusList2021Credential"],
  "issuer": "did:prism:...",
  "issuanceDate": "2025-10-28T10:00:00Z",
  "credentialSubject": {
    "id": "http://91.99.4.54:8000/cloud-agent/credential-status/{statusId}",
    "type": "StatusList2021",
    "statusPurpose": "Revocation",
    "encodedList": "H4sIAAAAAAAA_-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA"
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "created": "2025-10-28T10:00:00Z",
    "verificationMethod": "did:prism:...#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "..."
  }
}
```

### Background Job Mechanism

**Job Name**: `StatusListJobs.updateBitStringForCredentialAndNotify`

**Trigger Conditions**:
- Scheduled interval (30+ minutes)
- Message queue event on `sync-status-list` topic
- Manual trigger (if supported)

**Processing Steps**:
1. Query all `is_canceled = true AND is_processed = false` records
2. Group by `status_list_registry_id`
3. For each StatusList:
   - Fetch current bitstring from `credential_status_lists`
   - Decompress GZIP bitstring
   - Set bits to 1 for all revoked credentials
   - Compress updated bitstring
   - Generate new W3C VC with updated `encodedList`
   - Sign VC with issuer's private key
   - Update `status_list_credential` JSON field
   - Set `updated_at` timestamp
4. Mark processed credentials: `is_processed = true`

**Performance Characteristics**:
- **Bitstring Size**: 131,072 bits = 16 KB compressed (GZIP)
- **Cryptographic Cost**: Ed25519 signature generation per StatusList
- **Database Cost**: JSONB field update in `credential_status_lists`
- **Batch Optimization**: Multiple revocations processed in single update

## Testing & Verification

### Immediate Verification (Database Check)

**Verify revocation succeeded**:
```sql
-- Connect to Cloud Agent PostgreSQL database
docker exec -it <cloud-agent-db-container> psql -U postgres -d pollux

-- Check if credential is marked for revocation
SELECT
  issue_credential_record_id,
  status_list_index,
  is_canceled,
  is_processed,
  created_at,
  updated_at
FROM credentials_in_status_list
WHERE issue_credential_record_id = '<recordId>';
```

**Expected Output (immediately after revocation)**:
```
 issue_credential_record_id | status_list_index | is_canceled | is_processed |      created_at        |      updated_at
----------------------------+-------------------+-------------+--------------+------------------------+------------------------
 abc123...                  |             12345 | t           | f            | 2025-10-28 10:00:00+00 | 2025-10-28 10:05:00+00
```

Key indicators:
- `is_canceled = true` ✅ Revocation successful
- `is_processed = false` ⏳ Bitstring update pending

### Delayed Verification (StatusList Sync Check)

**Check when StatusList was last updated**:
```sql
SELECT
  id,
  issuer,
  purpose,
  size,
  last_used_index,
  updated_at
FROM credential_status_lists
WHERE id IN (
  SELECT status_list_registry_id
  FROM credentials_in_status_list
  WHERE issue_credential_record_id = '<recordId>'
);
```

**Expected Output**:
```
      id      |   issuer    | purpose    | size   | last_used_index |      updated_at
--------------+-------------+------------+--------+-----------------+------------------------
 xyz789...    | did:prism:...| revocation | 131072 |           15000 | 2025-10-28 09:30:00+00
```

**Interpretation**:
- If `updated_at` is BEFORE revocation API call → Bitstring not yet synced ⏳
- If `updated_at` is AFTER revocation API call → Bitstring synced ✅

**Check bitstring sync status**:
```sql
SELECT
  c.issue_credential_record_id,
  c.is_canceled,
  c.is_processed,
  c.status_list_index,
  s.updated_at as statuslist_last_updated
FROM credentials_in_status_list c
JOIN credential_status_lists s ON c.status_list_registry_id = s.id
WHERE c.issue_credential_record_id = '<recordId>';
```

### Public Endpoint Verification

**Fetch current StatusList**:
```bash
# Get statusListCredential URL from credential
# Example: http://91.99.4.54:8000/cloud-agent/credential-status/xyz789

curl http://91.99.4.54:8000/cloud-agent/credential-status/{statusId} | jq
```

**Decode bitstring** (Python):
```python
import base64
import gzip

# Extract encodedList from response
encoded_list = "H4sIAAAAAAAA_-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA"

# Decode and decompress
compressed = base64.b64decode(encoded_list)
bitstring = gzip.decompress(compressed)

# Check specific bit (status_list_index from credential)
status_index = 12345
byte_index = status_index // 8
bit_index = status_index % 8
is_revoked = bool(bitstring[byte_index] & (1 << bit_index))

print(f"Credential at index {status_index} is {'REVOKED' if is_revoked else 'VALID'}")
```

### End-to-End Verification

**Complete revocation test**:
```bash
# 1. Issue credential with revocation support
recordId=$(curl -X POST http://91.99.4.54:8000/cloud-agent/issue-credentials/credential-offers \
  -H "apikey: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}' | jq -r '.recordId')

# 2. Revoke credential
curl -X PATCH http://91.99.4.54:8000/cloud-agent/credential-status/revoke-credential/$recordId \
  -H "apikey: $API_KEY"

# 3. Immediately check database (should show is_canceled=true, is_processed=false)
docker exec -it <db-container> psql -U postgres -d pollux -c \
  "SELECT is_canceled, is_processed FROM credentials_in_status_list
   WHERE issue_credential_record_id = '$recordId';"

# 4. Wait 30+ minutes, check again (should show is_processed=true)
# 5. Fetch public StatusList and decode bitstring (should show bit=1)
```

## Known Behaviors

### StatusList Update Delays Are Normal

**Expected Behavior**:
- Revocation API returns success immediately ✅
- Database `is_canceled` flag updates immediately ✅
- Public StatusList bitstring updates after 30min-hours ⏳
- This is **by design**, not a bug

**User Impact**:
- Wallets may show credential as valid during sync window
- External verifiers see credential as valid during sync window
- Only affects public verification, not internal tracking

**Mitigation**:
- For real-time revocation checks, query database directly
- For public verification, accept eventual consistency model
- Document expected delay in user-facing materials

### Double Revocation Returns Error

**Behavior**:
```bash
# First revocation
curl -X PATCH .../revoke-credential/{recordId}  # 200 OK ✅

# Second revocation (same credential)
curl -X PATCH .../revoke-credential/{recordId}  # 500 Error ❌
```

**Error Response**:
```json
{
  "type": "InternalServerError",
  "status": 500,
  "detail": "Credential already revoked"
}
```

**Recommendation**: Check `is_canceled` flag before attempting revocation

### Credentials Without `credentialStatusId` Cannot Be Revoked

**Issue**: Cloud Agent API `/issue-credentials/records` does not expose `credentialStatusId` field

**Impact**: Cannot determine if credential is revocable from API response alone

**Solution**: Decode JWT credential to extract `credentialStatus` property

**CA Server Implementation** (`/api/credentials/revocable` endpoint):
```javascript
// Fixed October 28, 2025 - Lines 1919-1951 in server.js
const jwt = require('jsonwebtoken');

// Decode JWT credential without verification
const decoded = jwt.decode(record.credential, { complete: true });
const credentialStatus = decoded?.payload?.vc?.credentialStatus;

if (credentialStatus && credentialStatus.statusListCredential) {
  // Credential is revocable
  return {
    recordId: record.recordId,
    revocable: true,
    statusListCredential: credentialStatus.statusListCredential,
    statusListIndex: credentialStatus.statusListIndex
  };
}
```

**Without JWT Decoding**: Must assume all credentials issued with StatusList configuration are revocable

## Configuration

**StatusList Registry**: Configured via environment variable
```bash
POLLUX_STATUS_LIST_REGISTRY_PUBLIC_URL=http://91.99.4.54:8000/cloud-agent
```

**Default Bitstring Size**: 131,072 bits (16 KB compressed)

**Background Job Interval**: Configurable (default 30+ minutes)

## Integration Notes

### CA Server Requirements

**JWT Decoding Necessity**:
- Cloud Agent API does not expose `credentialStatusId` in `/issue-credentials/records`
- Must decode JWT credential to extract `credentialStatus` property
- Required for identifying revocable credentials in CA admin UI

**Implementation Reference**: `/root/certification-authority/server.js` lines 1919-1951

**Library**: `jsonwebtoken` npm package
```javascript
const jwt = require('jsonwebtoken');
const decoded = jwt.decode(jwtCredential, { complete: true });
const credentialStatus = decoded?.payload?.vc?.credentialStatus;
```

### Wallet Integration

**Verification Strategy**:
1. Extract `credentialStatus.statusListCredential` URL from credential
2. Fetch StatusList VC from public endpoint (no auth required)
3. Verify StatusList VC signature
4. Decompress `encodedList` bitstring
5. Check bit at `statusListIndex` position
6. Cache StatusList (check `updated_at` for freshness)

**Caching Recommendations**:
- Cache StatusList VCs for 5-15 minutes
- Re-fetch if credential verification critical
- Accept eventual consistency for non-critical checks

### Performance Considerations

**High-Volume Revocation**:
- Batch revocations process efficiently (single bitstring update)
- No performance penalty for revoking multiple credentials simultaneously
- StatusList supports up to 131,072 credentials per list

**StatusList Scalability**:
- Multiple StatusLists created automatically as needed
- Each issuer DID can have multiple StatusLists
- System auto-allocates credentials across StatusLists

## Standards Compliance

- ✅ W3C StatusList2021 (implements W3C Bitstring Status List specification)
- ✅ Privacy-preserving revocation (group privacy via large bitstring lists)
- ✅ Public verifiability (no authentication required to check status)
- ✅ Cryptographically signed StatusLists (Data Integrity Proof)
- ✅ Asynchronous processing (eventual consistency model)

---

**Document Version**: 1.0
**Extracted**: 2025-11-15
**Original Source**: `/root/CLAUDE.md` (lines 1161-1670)
**Related Files**:
- `/root/certification-authority/server.js` (lines 1919-1951)
- `/root/cloud-agent-with-reverse-proxy.yml` (StatusList configuration)
