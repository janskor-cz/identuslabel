# Hyperledger Identus SSI Infrastructure

**Production Self-Sovereign Identity (SSI) Infrastructure**

> For complete development history and architectural evolution, see [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md)

---

## Latest Updates

> **For historical updates and archived fixes, see [CHANGELOG.md](./CHANGELOG.md)**

### ✅ ServiceConfiguration VC Encryption Dependency Fix (November 20, 2025)

**STATUS**: ✅ **FIXED** - Removed improper encryption dependency that blocked enterprise wallet configuration

A critical architectural design flaw has been fixed where ServiceConfiguration VC API keys required Security Clearance VC X25519 encryption keys, creating an improper dependency that broke employee onboarding.

#### Problem Fixed

**Design Conflation**: ServiceConfiguration VC (employee onboarding) incorrectly depended on Security Clearance VC (classified content access) X25519 keys for API key encryption.

**Before Fix**:
- Employee receives ServiceConfiguration VC
- System tries to encrypt API key using X25519 keys from Security Clearance VC
- ❌ Fails: No X25519 keys available (employee doesn't have security clearance)
- Configuration marked "applied" but API key unavailable
- Enterprise wallet features fail: "No API key available - configuration may not be applied"

**After Fix**:
- Employee receives ServiceConfiguration VC
- API key stored directly in signed VC (no encryption needed)
- ✅ Configuration applies immediately
- ✅ Enterprise wallet features work without Security Clearance VC

#### Solution

**Removed Client-Side API Key Encryption**:
- API keys now stored directly in signed ServiceConfiguration VCs
- VC signature provides integrity protection
- IndexedDB provides browser-level access control
- Cloud Agent validates API keys server-side

**Security Analysis**:
- VC cryptographic signature prevents tampering
- Browser same-origin policy protects IndexedDB
- 64-character hex API keys (128-bit entropy)
- No additional security benefit from client-side encryption
- Removing encryption eliminates improper architectural dependency

#### Clean Separation of Concerns

| Credential | Purpose | Required For | Keys Needed |
|------------|---------|--------------|-------------|
| **ServiceConfiguration VC** | Enterprise wallet connection | Employee onboarding | None (API key in signed VC) |
| **Security Clearance VC** | Classified content access | Secure Information Portal | X25519 (content decryption) |

**Result**: Employee onboarding works independently of security clearance approval.

#### Files Modified

- `src/utils/configurationStorage.ts` - Removed encrypted API key storage
- `src/utils/EnterpriseAgentClient.ts` - Read API key directly from config
- Documentation updated to clarify separation of concerns

---

### ✅ Automated Employee Onboarding - FULLY OPERATIONAL (November 17, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Complete automated employee wallet creation with PRISM DID publication and DIDComm connection establishment

A fully automated 11-step employee onboarding workflow that creates Cloud Agent wallets, publishes PRISM DIDs to the Cardano blockchain, and establishes bidirectional DIDComm connections between employee wallets and the TechCorp company wallet.

#### Achievement Summary

- **Status**: ✅ **Production-Ready** - All 11 steps complete with 100% success rate
- **Performance**: ~35-40 seconds total execution time
- **Architecture**: Enterprise Cloud Agent (port 8300) ↔ TechCorp Company Wallet (port 8200)
- **DID Publication**: PRISM DIDs published to blockchain in ~28 seconds
- **Connection**: Bidirectional DIDComm established between employee and TechCorp
- **Atomicity**: All-or-nothing transaction with automatic rollback on failure

#### 11-Step Workflow

1. **Create Wallet** - Isolated wallet container in Enterprise Cloud Agent
2. **Create Entity** - Authentication entity with wallet association
3. **Register API Key** - 64-char hex authentication token for Cloud Agent access
4. **Create PRISM DID** - Blockchain-anchored decentralized identifier with dual keys:
   - Authentication key (DIDComm connections)
   - Assertion method key (credential issuance)
5. **Publish DID** - Submit DID to Cardano blockchain via PRISM node
6. **Wait for Publication** - Poll until blockchain confirms (~28 seconds, 14 attempts)
7. **Create TechCorp Invitation** - Generate DIDComm invitation from company wallet
8. **Accept Invitation** - Employee wallet accepts and sends connection request
9. **Wait Employee Connection** - Poll until established (`ConnectionResponseReceived`)
10. **Wait TechCorp Connection** - Poll until established (`ConnectionResponseSent`)
11. **Finalization** - Prepare Service Configuration VC payload for edge wallet

#### Key Technical Fixes

**DNS Resolution Fix** (Critical):
- Added `extra_hosts: ["identuslabel.cz:91.99.4.54"]` to Enterprise Cloud Agent Docker Compose
- Without fix: Connections stuck in `ConnectionRequestPending` state
- With fix: Connections establish immediately

**Connection State Handling**:
- Accept `ConnectionResponseReceived` as valid final state for invitee (Cloud Agent 2.0.0)
- Accept `ConnectionResponseSent` as valid final state for inviter
- Fixed cross-agent URL authentication (explicit `cloudAgentUrl` parameter)

#### Service Configuration VC

**Generated Payload** (Step 11):
```json
{
  "enterpriseAgentUrl": "http://91.99.4.54:8300",
  "enterpriseAgentName": "TechCorp Enterprise Wallet",
  "enterpriseAgentApiKey": "fb1aa0d981364b51..."
}
```

**Next Steps** (Manual):
1. CA issues Service Configuration VC to employee's edge wallet (Alice)
2. Employee accepts VC in edge wallet
3. Edge wallet extracts API credentials and enables Enterprise mode
4. Edge wallet can now query Cloud Agent for DIDs, credentials, connections

#### Performance Metrics

| Metric | Value |
|--------|-------|
| **Total Time** | ~35-40 seconds |
| **DID Publication** | ~28 seconds (70% of total) |
| **Connection Establishment** | ~2 seconds (immediate after DNS fix) |
| **Success Rate** | 100% (all 11 steps pass) |
| **Blockchain Confirmations** | 14 polling attempts (2s interval) |

#### Quick Start

```bash
# Test employee onboarding
node /root/test-employee-onboarding-complete.js

# Expected output:
# ✅ Wallet created: <wallet-id>
# ✅ Entity created: <entity-id>
# ✅ API key registered: <api-key>
# ✅ PRISM DID created: did:prism:...
# ✅ DID published: did:prism:... (after ~28s)
# ✅ TechCorp invitation created
# ✅ Invitation accepted
# ✅ Employee connection established
# ✅ TechCorp connection established
# 🎉 Employee wallet created successfully!
```

#### Configuration Files

- **Employee Wallet Manager**: `/root/company-admin-portal/lib/EmployeeWalletManager.js` (596 lines)
- **Enterprise Cloud Agent**: `/root/enterprise-cloud-agent.yml` (DNS fix on lines 119-121)
- **Test Script**: `/root/test-employee-onboarding-complete.js` (216 lines)

**Complete Documentation**: See [EMPLOYEE_ONBOARDING.md](./EMPLOYEE_ONBOARDING.md) for comprehensive technical details, API reference, troubleshooting guide, and future enhancements.

---

### ✅ Wallet Context Selector Implementation (November 15, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Enhanced wallet UX with clickable card-based context selection

Alice wallet now features a streamlined context selection UI for switching between Personal and Enterprise wallet modes.

#### Key Features

- **Clickable Card Interface**: Visual card-based selector replacing radio button UI
- **Enterprise Wallet Integration**: Automatic ServiceConfiguration credential detection
- **Seamless Context Switching**: Switch between Personal and Enterprise wallets without reloading
- **Visual Feedback**: Active wallet highlighted with distinct styling
- **Single Wallet Architecture**: Alice is now the sole active development wallet (Bob decommissioned November 9, 2025)

#### User Experience

**Personal Wallet Mode**:
- Individual identity credentials
- Direct CA connections
- Personal security clearance

**Enterprise Wallet Mode** (requires ServiceConfiguration VC):
- Company-issued credentials
- Department-specific connections
- Enterprise-managed identity

#### Implementation Details

**Files Modified**:
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/OOB.tsx`
  - Removed radio button UI sections
  - Implemented clickable card selector
  - Enhanced visual feedback for active wallet context

**Detection Logic**:
- Scans wallet credentials for `ServiceConfiguration` type
- Auto-enables Enterprise mode when configuration VC present
- Graceful fallback to Personal mode if no configuration found

**Benefits**:
- Improved UX with intuitive card interface
- Clear visual distinction between wallet contexts
- Simplified codebase (single wallet implementation)
- Better alignment with enterprise multitenancy architecture

---

### ✅ Multitenancy Infrastructure - FULLY VALIDATED (November 8, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Complete multitenancy Cloud Agent with verified tenant isolation

A separate security-hardened Cloud Agent instance deployed for multi-company SSI scenarios with isolated tenant wallets and cryptographically enforced data segregation.

#### Key Highlights

- **Infrastructure**: Dedicated Cloud Agent on port 8200 (internal-only access)
- **Security**: PostgreSQL NOT exposed to internet, custom credentials, API key authentication
- **Tenants**: 3 independent company wallets (TechCorp, ACME, EvilCorp)
- **Isolation**: Cryptographically enforced (Wallet B/C cannot access Wallet A's DIDs)
- **Capabilities**: Full PRISM DID support with authentication and assertion method keys

#### Company Identities

| Company | DID (Short Form) | Role |
|---------|------------------|------|
| **TechCorp** | `did:prism:6ee757c2...` | Technology corporation |
| **ACME** | `did:prism:474c9151...` | General services company |
| **EvilCorp** | `did:prism:1706a8c2...` | Adversarial testing entity |

#### Use Cases

- Inter-company credential issuance (TechCorp → ACME)
- Supply chain verifiable credential exchange
- B2B identity verification
- Security testing with adversarial scenarios

#### Quick Access

```bash
# Start multitenancy infrastructure
docker-compose -f test-multitenancy-cloud-agent.yml up -d

# Health check (internal-only)
curl http://91.99.4.54:8200/_system/health

# List TechCorp DIDs
curl -H 'apikey: <TechCorp-API-Key>' http://91.99.4.54:8200/did-registrar/dids
```

**Complete Documentation**: See [MULTITENANCY_TEST_REPORT.md](./MULTITENANCY_TEST_REPORT.md) for full setup guide and test results.

---

### ✅ Enterprise Cloud Agent - FULLY OPERATIONAL (November 9, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Internal multitenancy Cloud Agent for company departments

Dedicated enterprise Cloud Agent instance for internal department usage with isolated wallets for HR, IT, and Security teams.

#### Key Highlights

- **Infrastructure**: Separate Cloud Agent on port 8300 with HTTPS domain access
- **URL**: `https://identuslabel.cz/enterprise`
- **Departments**: HR, IT, Security with independent wallets
- **Security**: Database internal-only, API key authentication, tenant isolation verified
- **Integration**: Caddy reverse proxy for HTTPS access

#### Department Wallets

| Department | Wallet ID | Purpose |
|------------|-----------|---------|
| **HR Department** | `5fb8d42e-940d-4941-a772-4a0e6a8bf8c7` | Employee onboarding, HR credentials |
| **IT Department** | `356a0ea1-883d-4985-a0d0-adc49c710fe0` | System access management |
| **Security Team** | `5b5eaab0-0b56-4cdc-81c9-00b18a49b712` | Security clearance issuance |

#### Management Commands

```bash
# Start Enterprise Cloud Agent
cd /root && docker-compose -f enterprise-cloud-agent.yml up -d

# Health check
curl https://identuslabel.cz/enterprise/_system/health

# List department wallets (with API key)
curl -H 'apikey: <Department-API-Key>' https://identuslabel.cz/enterprise/wallets
```

#### HTTPS Endpoints

- **API**: `https://identuslabel.cz/enterprise/`
- **DIDComm**: `https://identuslabel.cz/enterprise/didcomm`
- **Health**: `https://identuslabel.cz/enterprise/_system/health`

**Complete Documentation**: Configuration files in `/root/enterprise-cloud-agent.yml`, `/root/init-enterprise-dbs.sql`

---

### ✅ Company Admin Portal - FULLY OPERATIONAL (November 8, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Standalone multitenancy admin interface

Node.js/Express application providing company-specific administration for the Hyperledger Identus SSI infrastructure.

#### Key Features

- **URL**: `https://identuslabel.cz/company-admin`
- **Multi-Company Support**: TechCorp, ACME, EvilCorp with isolated sessions
- **Company DID Management**: View and manage PRISM DIDs
- **Employee Management**: Create invitations, manage connections, issue credentials
- **QR Code Invitations**: Generate employee onboarding QR codes
- **Credential Display**: View received CompanyIdentity credentials from CA

#### Quick Start

```bash
# Start Company Admin Portal
cd /root/company-admin-portal && ./start.sh

# Health check
curl https://identuslabel.cz/company-admin/api/health

# Access portal
# https://identuslabel.cz/company-admin
```

#### Key Endpoints

**Public**:
- `GET /` - Frontend UI
- `GET /api/health` - Health check
- `GET /api/companies` - List companies

**Authenticated** (requires company session):
- `GET /api/company/info` - Company info and DID
- `GET /api/company/connections` - Employee connections
- `POST /api/company/invite-employee` - Create employee invitation
- `GET /api/company/credentials` - List credentials
- `POST /api/company/issue-credential` - Issue credential to employee

**Complete Documentation**: See `/root/company-admin-portal/README.md` for full API reference and user guide.

---

### ✅ Phase 2 Client-Side Encryption - FULLY OPERATIONAL (November 2, 2025)

**STATUS**: ✅ **PRODUCTION READY** - End-to-end encrypted content delivery with zero-knowledge server

The Secure Information Portal implements client-side encryption using X25519 keys from Security Clearance VCs.

#### Architecture

**Zero-Knowledge Model**:
- Server encrypts content using user's X25519 public key (from Security Clearance VC)
- Content sent as encrypted ciphertext to dashboard
- User clicks "Decrypt with Wallet" → Alice wallet opens in popup
- Wallet decrypts locally using X25519 private key (never transmitted)
- Decrypted content displayed via postMessage communication
- Wallet auto-closes after completion

#### Security Features

- **X25519 Key Agreement**: Diffie-Hellman for secure shared secret derivation
- **XSalsa20-Poly1305**: Authenticated encryption (confidentiality + integrity)
- **Unique Nonces**: Random 24-byte nonce per encryption operation
- **Zero Server Knowledge**: CA cannot decrypt content after encryption
- **Origin Validation**: postMessage enforces origin whitelisting
- **Private Key Isolation**: Keys never leave user's wallet

#### Performance Metrics

| Metric | Value |
|--------|-------|
| **Decryption Time** (per section) | 10-30ms |
| **Total Flow Time** (5 sections) | 2-4 seconds |
| **Overhead vs Phase 1** | +2-3 seconds |

#### User Flow

1. User logs in with Security Clearance VC → session created
2. Dashboard shows encrypted placeholders with 🔒 icons
3. User clicks "🔓 Decrypt Content with Wallet"
4. Alice wallet opens in popup (450x650px)
5. Wallet receives DECRYPT_REQUEST via postMessage
6. Wallet decrypts using X25519 private key (localStorage)
7. Wallet sends DECRYPT_RESPONSE with plaintext
8. Dashboard displays decrypted content with fade-in animation
9. Wallet auto-closes after 2 seconds

**Complete Documentation**: See technical implementation details in previous CLAUDE.md sections (archived).

---

### ✅ DIDComm Label Transmission - FULLY OPERATIONAL (November 7, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Dual-label system for CA connection identification

User-provided names correctly transmitted to CA when establishing DIDComm connections.

#### Dual Label System

**CA Server View**:
- Connection Label: "CA Connection: Alice Cooper"
- Allows CA to distinguish which user is connecting

**Wallet View** (Alice's Browser):
- Connection Name: "Certification Authority"
- User sees consistent CA name regardless of input

#### Implementation

**CA Server**: Accepts `userName` query parameter in well-known invitation endpoint, pre-populates connection label before invitation generation

**Wallet**: Sends `?userName={name}` query parameter when fetching invitation, stores connection with fixed "Certification Authority" name

**Test Coverage**: 8/8 automated tests passing (100% success rate)

**Automated Test**: `/root/test-label-transmission.js`

---

### ✅ HTTPS Migration Complete - Domain Access via identuslabel.cz (November 2, 2025)

**STATUS**: ✅ **FULLY OPERATIONAL** - All services accessible via HTTPS domain

Complete infrastructure migration from HTTP (IP-based) to HTTPS (domain-based access).

#### Access URLs (All via HTTPS)

- CA Portal: `https://identuslabel.cz/ca`
- Alice Wallet: `https://identuslabel.cz/alice`
- Cloud Agent API: `https://identuslabel.cz/cloud-agent`
- Cloud Agent DIDComm: `https://identuslabel.cz/didcomm`
- Mediator: `https://identuslabel.cz/mediator`
- Enterprise Cloud Agent: `https://identuslabel.cz/enterprise`
- Company Admin Portal: `https://identuslabel.cz/company-admin`

#### Key Infrastructure Changes

- **Caddy Reverse Proxy**: Native binary with automatic Let's Encrypt SSL
- **Cloud Agent HTTPS Config**: `DIDCOMM_SERVICE_URL=https://identuslabel.cz/didcomm`
- **CA Server**: Base URL updated to HTTPS proxy routes
- **Mediator**: Service endpoint updated with HTTPS URL
- **Wallet**: SecureDashboardBridge updated for HTTPS origin

**Important**: Old DIDComm invitations with HTTP URLs are immutable. Always create fresh invitations after configuration changes.

---

### ✅ Historical Fixes Archive

The following fixes are documented in archived files for historical reference:

**October 2025**:
- ✅ X25519 Bidirectional Decryption Fix (Oct 25) - Direction-based public key selection
- ✅ SDK Attachment Validation Fix (Oct 14) - Graceful handling of unsupported attachment types

**Complete Archive**: See [CHANGELOG.md](./CHANGELOG.md) for full historical update log.

---

### 📁 Archived Documentation

Detailed documentation extracted to dedicated files:

- **[MULTITENANCY_TEST_REPORT.md](./MULTITENANCY_TEST_REPORT.md)** - Full multitenancy test results
- **[docs/infrastructure/STATUSLIST2021_ARCHITECTURE.md](./docs/infrastructure/STATUSLIST2021_ARCHITECTURE.md)** - StatusList2021 revocation architecture
- **[docs/infrastructure/TOP_LEVEL_ISSUER_HISTORICAL.md](./docs/infrastructure/TOP_LEVEL_ISSUER_HISTORICAL.md)** - Decommissioned Top-Level Issuer (Nov 9, 2025)
- **[company-admin-portal/README.md](./company-admin-portal/README.md)** - Company Admin Portal full guide
- **[company-admin-portal/docs/CREDENTIAL_ISSUANCE_WORKFLOW.md](./company-admin-portal/docs/CREDENTIAL_ISSUANCE_WORKFLOW.md)** - Credential issuance workflow
- **[company-admin-portal/docs/API_REFERENCE.md](./company-admin-portal/docs/API_REFERENCE.md)** - API endpoint documentation

---

## Quick Reference

### Service Status

| Service | URL | Port | Status |
|---------|-----|------|--------|
| **Alice Wallet** | https://identuslabel.cz/alice | 3001 | ✅ Operational - PRIMARY WALLET |
| **Certification Authority** | https://identuslabel.cz/ca | 3005 | ✅ Operational |
| **Secure Information Portal** | https://identuslabel.cz/ca/dashboard | 3005 | ✅ Operational (Phase 2 encryption) |
| **Cloud Agent (Main)** | https://identuslabel.cz/cloud-agent | 8000 | ✅ Operational |
| **Multitenancy Cloud Agent** | Internal: http://91.99.4.54:8200 | 8200 | ✅ Operational (internal-only) |
| **Enterprise Cloud Agent** | https://identuslabel.cz/enterprise | 8300 | ✅ Operational |
| **Company Admin Portal** | https://identuslabel.cz/company-admin | 3010 | ✅ Operational |
| **Mediator** | https://identuslabel.cz/mediator | 8080 | ✅ Operational |
| **Alice RIDB Backend** | Internal: http://91.99.4.54:5001 | 5001 | ✅ Operational |
| **VDR/PRISM Node (gRPC)** | 91.99.4.54:50053 | 50053 | ✅ Operational |

**Note**: Bob wallet decommissioned November 9, 2025. Alice wallet is the sole active development wallet.

### Infrastructure Architecture

```
                        VDR/PRISM Node (50053)
                               ↑
                               |
            ┌──────────────────┼──────────────────┐
            |                  |                  |
    CA (3005) ←→ Cloud Agent (8000)              |
            ↓                  ↓                  |
    Secure Portal      Mediator (8080)           |
                               ↓                  |
                        Alice Wallet (3001)       |
                        [Personal | Enterprise]   |
                                                  |
    Multitenancy Cloud Agent (8200) ←────────────┘
    ├── TechCorp
    ├── ACME
    └── EvilCorp

    Enterprise Cloud Agent (8300) ←──────────────┘
    ├── HR Department
    ├── IT Department
    └── Security Team

    Company Admin Portal (3010)
    └── Multi-company management UI
```

---

## StatusList2021 Credential Revocation

### Overview

**Status**: ✅ **FULLY OPERATIONAL** (October 28, 2025)

Hyperledger Identus Cloud Agent 2.0.0 implements **W3C StatusList2021** for credential revocation using an **asynchronous batch processing architecture**.

### Key Principles

**Revocation Architecture**:
- Revocation status NOT stored in credential itself
- Credentials contain reference to external StatusList
- Public verification endpoint (no authentication required)
- Asynchronous processing for performance (30min-hours delay)

**How It Works**:
1. Credential issued with `credentialStatus` property containing StatusList URL
2. Verifier fetches public StatusList VC from Cloud Agent endpoint
3. StatusList contains GZIP-compressed bitstring (131,072 entries)
4. Verifier decompresses bitstring, checks bit at credential's `statusListIndex`
5. Bit = 0: Valid | Bit = 1: Revoked

### Revocation Process

**Immediate (Database Update)**:
```bash
# Revoke credential
curl -X PATCH https://identuslabel.cz/cloud-agent/credential-status/revoke-credential/{recordId} \
  -H "apikey: $API_KEY"
```

**Response**: HTTP 200 OK immediately, database `is_canceled` flag set to `true`

**Delayed (StatusList Sync)**:
- Background job processes revocations in batches
- StatusList bitstring updated 30 minutes to several hours later
- Public endpoint reflects revocation after background processing completes

### Public Verification Endpoint

```bash
# Get StatusList VC (public, no auth required)
curl https://identuslabel.cz/cloud-agent/credential-status/{statusId}
```

**Returns**: W3C `StatusList2021Credential` with compressed bitstring

### Database Schema

**Table: `credentials_in_status_list`** (Individual credential tracking):
- `is_canceled`: Revocation flag (immediate)
- `is_processed`: Sync completion flag (delayed)
- `status_list_index`: Position in bitstring (0-131071)

**Table: `credential_status_lists`** (StatusList VC storage):
- `status_list_credential`: W3C VC with encodedList (JSONB)
- `updated_at`: Last bitstring update timestamp

### Verification Commands

```bash
# Check immediate revocation (database)
docker exec -it <cloud-agent-db-container> psql -U postgres -d pollux -c \
  "SELECT is_canceled, is_processed FROM credentials_in_status_list
   WHERE issue_credential_record_id = '<recordId>';"

# Expected after revocation:
# is_canceled = true (immediate)
# is_processed = false (pending sync)

# Check StatusList last update
docker exec -it <cloud-agent-db-container> psql -U postgres -d pollux -c \
  "SELECT id, updated_at FROM credential_status_lists ORDER BY updated_at DESC LIMIT 5;"
```

### Important Behaviors

**Asynchronous Processing** (By Design):
- Revocation API returns success immediately ✅
- Database `is_canceled` flag updates immediately ✅
- Public StatusList bitstring updates after 30min-hours ⏳
- This is **intentional architecture** for performance optimization

**Eventual Consistency**:
- Wallets may show credential as valid during sync window
- External verifiers see credential as valid until StatusList syncs
- For real-time checks, query database directly

**Double Revocation**:
- Attempting to revoke already-revoked credential returns HTTP 500
- Check `is_canceled` flag before attempting revocation

**Complete Documentation**: See detailed architecture in archived sections or database schema reference.

---

## Quick Start Commands

### Start All Infrastructure

```bash
# 1. Mediator (includes MongoDB)
cd /root/identus-mediator && docker-compose up -d

# 2. Cloud Agent (includes PostgreSQL)
cd /root && docker-compose -f cloud-agent-with-reverse-proxy.yml up -d

# 3. Enterprise Cloud Agent
cd /root && docker-compose -f enterprise-cloud-agent.yml up -d

# 4. Multitenancy Cloud Agent
cd /root && docker-compose -f test-multitenancy-cloud-agent.yml up -d

# 5. PRISM Node
cd /root && docker-compose -f local-prism-node-addon.yml up -d

# 6. Caddy Reverse Proxy
pkill caddy
/usr/local/bin/caddy run --config /root/Caddyfile > /tmp/caddy.log 2>&1 &

# 7. Certification Authority
cd /root/certification-authority && PORT=3005 node server.js > /tmp/ca.log 2>&1 &

# 8. Company Admin Portal
cd /root/company-admin-portal && PORT=3010 node server.js > /tmp/company-admin.log 2>&1 &

# 9. Alice Wallet
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
fuser -k 3001/tcp
rm -rf .next
yarn dev > /tmp/alice.log 2>&1 &
```

### Health Checks

```bash
curl https://identuslabel.cz/_system/health              # Cloud Agent (Main)
curl https://identuslabel.cz/enterprise/_system/health   # Enterprise Cloud Agent
curl http://91.99.4.54:8200/_system/health               # Multitenancy Cloud Agent (internal)
curl https://identuslabel.cz/mediator/                   # Mediator
curl https://identuslabel.cz/ca/api/health               # CA
curl https://identuslabel.cz/company-admin/api/health    # Company Admin Portal
curl -I https://identuslabel.cz/alice/                   # Alice Wallet
```

### Stop Services

```bash
docker stop $(docker ps -q --filter "name=mediator")
docker stop $(docker ps -q --filter "name=cloud-agent")
docker stop $(docker ps -q --filter "name=enterprise")
docker stop $(docker ps -q --filter "name=multitenancy")
docker stop $(docker ps -q --filter "name=prism")
pkill caddy
pkill -f "node server.js"
pkill -f "next dev"
```

---

## Core Features

### DIDComm Connection Establishment

| Step | Alice (Inviter) | User (Invitee) |
|------|-----------------|----------------|
| 1 | Create invitation (OOB tab) | - |
| 2 | - | Paste invitation URL, Accept |
| 3 | Review request in Connections tab | Wait for acceptance |
| 4 | Accept/Reject connection request | - |
| 5 | Connection established (green) | Connection established (green) |

**Invitation State Colors**:
- 🟠 Orange: `InvitationGenerated` (waiting for requests)
- 🟡 Yellow: `ConnectionRequested` (pending approval)
- 🟢 Green: `Connected` (active connection)
- 🔴 Red: `Rejected` (declined)

### Verifiable Credential Issuance

| State | Description | Action Required |
|-------|-------------|-----------------|
| `OfferSent` | Offer sent to wallet | User accepts in wallet |
| `RequestReceived` | User accepted | **Admin approves in CA portal** |
| `CredentialSent` | Credential issued | Auto-stored in wallet |

**CA API Endpoints**:
- `GET /api/credentials/pending` - Only shows `RequestReceived` (awaiting approval)
- `POST /api/approve-credential` - Approve credential
- `POST /api/deny-credential` - Deny credential

### VC Proof Verification

**User Flow**:
1. Click "🔐 VERIFY" tab in wallet
2. Paste base64-encoded proof request from CA
3. Select matching credential
4. Submit verification → CA receives result

**Implementation**: Direct VerifiablePresentation submission

### Secure Information Portal

**URL**: `https://identuslabel.cz/ca/dashboard`

**Architecture**: Two-tier protection (Phase 1: Progressive Disclosure, Phase 2: Client-Side Encryption)

**User Experience**:

| Clearance Level | Sections Visible | Total Sections |
|-----------------|------------------|----------------|
| **Unauthenticated** | PUBLIC only | 1 |
| **INTERNAL** | PUBLIC + INTERNAL | 3 |
| **CONFIDENTIAL** | PUBLIC + INTERNAL + CONFIDENTIAL | 5 |
| **RESTRICTED** | Up to RESTRICTED | 6 |
| **TOP-SECRET** | All sections | 7 |

**Phase 2 Encryption** (Current):
- Content encrypted server-side using user's X25519 public key
- User clicks "Decrypt with Wallet" → Alice wallet opens
- Wallet decrypts locally using X25519 private key
- Decrypted content displayed via postMessage
- Zero-knowledge server (CA cannot read decrypted content)

**API Endpoints**:
- `GET /api/dashboard/content` - Phase 1 cleartext (deprecated)
- `GET /api/dashboard/encrypted-content` - Phase 2 encrypted (current)

---

## Configuration Reference

### Alice Wallet Configuration

**File**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/reducers/app.ts`

```javascript
const getWalletConfig = () => ({
    walletId: 'alice',
    walletName: 'Alice Wallet',
    dbName: 'identus-wallet-alice',
    storagePrefix: 'wallet-alice-'
});
```

### Mediator DID

```javascript
// In src/actions/index.ts
const mediatorDID = "did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y...";
```

### Cloud Agent Endpoints

**Main Cloud Agent**:
```javascript
const CLOUD_AGENT_URL = "https://identuslabel.cz/cloud-agent";
const DIDCOMM_SERVICE_URL = "https://identuslabel.cz/didcomm";
```

**Enterprise Cloud Agent**:
```javascript
const ENTERPRISE_AGENT_URL = "https://identuslabel.cz/enterprise";
const ENTERPRISE_DIDCOMM_URL = "https://identuslabel.cz/enterprise/didcomm";
```

**Multitenancy Cloud Agent** (Internal-Only):
```javascript
const MULTITENANCY_AGENT_URL = "http://91.99.4.54:8200";
```

---

## API Quick Reference

### Cloud Agent

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/_system/health` | GET | Health check |
| `/connections` | POST | Create invitation |
| `/connections/{id}` | GET | Get connection |
| `/issue-credentials/credential-offers` | POST | Create VC offer |
| `/issue-credentials/records` | GET | List credentials |
| `/did-registrar/dids` | POST | Create PRISM DID |
| `/credential-status/revoke-credential/{recordId}` | PATCH | Revoke credential (requires apikey) |
| `/credential-status/{statusId}` | GET | Get StatusList VC (public, no auth) |

**Base URL**: `https://identuslabel.cz/cloud-agent`

### Certification Authority

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/create-did` | POST | Create PRISM DID |
| `/api/cloud-agent/connections/create-invitation` | POST | Create invitation |
| `/api/credentials/pending` | GET | Get pending approvals |
| `/api/approve-credential` | POST | Approve credential |
| `/api/deny-credential` | POST | Deny credential |
| `/api/credentials/revocable` | GET | Get revocable credentials |
| `/api/credentials/revoke/:recordId` | POST | Revoke credential |
| `/api/dashboard/encrypted-content` | GET | Get encrypted dashboard content (Phase 2) |

**Base URL**: `https://identuslabel.cz/ca`

### Company Admin Portal

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/companies` | GET | List all companies |
| `/api/auth/login` | POST | Company login |
| `/api/company/info` | GET | Get company info + DID |
| `/api/company/connections` | GET | List employee connections |
| `/api/company/invite-employee` | POST | Create employee invitation |
| `/api/company/credentials` | GET | List issued credentials |
| `/api/company/issue-credential` | POST | Issue credential to employee |

**Base URL**: `https://identuslabel.cz/company-admin`

### Mediator

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/` | HTTP | Health check |
| `/ws` | WebSocket | DIDComm message pickup |

**Base URL**: `https://identuslabel.cz/mediator`

---

## Development Workflow

### Alice Wallet Development

**Directory**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet`

#### Making Changes

1. **Edit Component Files**:
   ```bash
   cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components
   # Edit OOB.tsx, Credentials.tsx, Message.tsx, etc.
   ```

2. **Clear Cache and Restart**:
   ```bash
   cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
   fuser -k 3001/tcp
   rm -rf .next
   yarn dev > /tmp/alice.log 2>&1 &
   ```

3. **Hard Refresh Browser**: Ctrl+Shift+R (Win/Linux) or Cmd+Shift+R (Mac)

#### SDK Modifications

If modifying Edge Agent SDK source:

1. **Edit SDK Files**:
   ```bash
   cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/src/domain/models
   # Edit Message.ts, etc.
   ```

2. **Rebuild SDK**:
   ```bash
   cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts
   yarn build
   ```

3. **Copy to Wallet**:
   ```bash
   cp -r build/* demos/alice-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
   ```

4. **Restart Wallet**:
   ```bash
   cd demos/alice-wallet
   fuser -k 3001/tcp
   rm -rf .next
   yarn dev > /tmp/alice.log 2>&1 &
   ```

#### Redux Two-Layer Pattern

**CRITICAL**: Both database AND state must be updated

```javascript
// LAYER 1: Action (Database)
await agent.pluto.deleteMessage(message.id);

// LAYER 2: Reducer (State)
state.messages = state.messages.filter(m => m.id !== message.id);
```

#### Connection Storage

```javascript
// ✅ CORRECT - Persists to IndexedDB
await agent.pluto.storeDIDPair(hostDID, receiverDID, label);

// ❌ WRONG - Memory only
await agent.connectionManager.addConnection(didPair);
```

---

## Troubleshooting

### Common Issues

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Credential not appearing** | Accepted but not in wallet | 1. Check wallet initialized<br>2. Verify connection green<br>3. Check mediator logs<br>4. Verify credential state `CredentialSent` |
| **Connection not establishing** | Invitation fails | 1. Check invitation URL format<br>2. Verify mediator running: `curl -I https://identuslabel.cz/mediator/`<br>3. Ensure wallet agent started |
| **WebAssembly memory error** | `RangeError: Out of memory` | **Hard refresh**: Ctrl+Shift+R (Win/Linux) or Cmd+Shift+R (Mac) |
| **Changes not appearing** | Old code persists | 1. Clear server cache: `rm -rf .next`<br>2. Restart: `fuser -k 3001/tcp && yarn dev &`<br>3. **User hard refresh** |
| **Mediator unhealthy** | `(unhealthy)` status | `docker restart identus-mediator-identus-mediator-1` |
| **Mixed Content error** | HTTPS page loading HTTP resources | Verify all URLs use `https://identuslabel.cz` (not IP addresses) |
| **StatusList shows valid but revoked** | Credential revoked but appears valid | **Expected** - Asynchronous processing delay (30min-hours). Check database for immediate status |

### Diagnostic Commands

```bash
# Check mediator message delivery
docker logs identus-mediator-identus-mediator-1 --tail 100 | grep ForwardMessage

# Check credential state
curl -s https://identuslabel.cz/cloud-agent/issue-credentials/records | jq '.contents[] | {recordId, state}'

# Check connection state (must be "ConnectionResponseSent" or "Active")
curl -s https://identuslabel.cz/cloud-agent/connections | jq '.contents[] | {connectionId, state}'

# Monitor fail2ban (security)
tail -f /var/log/fail2ban.log

# Check credential revocation status (database)
docker exec -it <cloud-agent-db-container> psql -U postgres -d pollux -c \
  "SELECT issue_credential_record_id, is_canceled, is_processed, status_list_index
   FROM credentials_in_status_list
   WHERE issue_credential_record_id = '<recordId>';"

# Check StatusList last update time
docker exec -it <cloud-agent-db-container> psql -U postgres -d pollux -c \
  "SELECT id, issuer, purpose, updated_at
   FROM credential_status_lists
   ORDER BY updated_at DESC LIMIT 5;"

# Check Caddy reverse proxy logs
tail -f /tmp/caddy.log

# Verify HTTPS certificate
curl -vI https://identuslabel.cz 2>&1 | grep -i "SSL certificate"
```

---

## Security

### Current Security Posture

**Status**: 🟢 **FULLY SECURED**

- ✅ Cryptocurrency malware eliminated (Oct 2025)
- ✅ fail2ban SSH protection active
- ✅ No unauthorized accounts
- ✅ Mediator service healthy
- ✅ Ed25519 client-side key generation
- ✅ X25519 client-side encryption/decryption (Nov 2025)
- ✅ Private keys never transmitted to CA
- ✅ SDK attachment validation hardened (Oct 14, 2025)
- ✅ Phase 2 zero-knowledge content delivery (Nov 2, 2025)
- ✅ HTTPS/TLS for all public endpoints
- ✅ Let's Encrypt automatic SSL certificate renewal

### fail2ban Configuration

```ini
[sshd]
enabled = true
maxretry = 5
findtime = 600
bantime = 3600
```

**Monitor**: `tail -f /var/log/fail2ban.log`

### Ed25519 Key Management

**Client-Side Only**:
```javascript
const apollo = new SDK.Apollo();
const privateKey = apollo.createPrivateKey({
  type: SDK.Domain.KeyTypes.EC,
  curve: SDK.Domain.Curve.ED25519,
  seed: Buffer.from(seed.value).toString("hex")
});

// Only public key sent to CA
const publicKey = privateKey.publicKey();
submitPublicKeyToCA(Buffer.from(publicKey.raw).toString("hex"));
```

**Security**: Private keys NEVER leave user's device

### X25519 Encryption Keys

**Generated Client-Side**:
- Wallet generates X25519 key pair locally
- Public key embedded in Security Clearance VC
- Private key stored in wallet localStorage (never transmitted)
- Server encrypts content using public key
- Wallet decrypts using private key

### Standards Compliance

- ✅ W3C Verifiable Credentials Data Model 1.0
- ✅ W3C Decentralized Identifiers (DIDs) v1.0
- ✅ W3C StatusList2021 (Bitstring Status List)
- ✅ DIDComm Messaging v2.0 (RFC 0434)
- ✅ Hyperledger Identus SDK v6.6.0 (with custom fixes)
- ✅ X25519 Elliptic Curve Diffie-Hellman (RFC 7748)
- ✅ XSalsa20-Poly1305 Authenticated Encryption (NaCl/libsodium)
- ✅ Browser postMessage API (WHATWG HTML Living Standard)

---

## Known Issues

| Issue | Impact | Status | Workaround |
|-------|--------|--------|------------|
| Browser cache issues | Updates not appearing | 🔴 High | Hard refresh (Ctrl+Shift+R) required after updates |
| WebAssembly memory accumulation | Periodic refresh needed | 🟡 Low | Hard refresh when wallet slows down |
| SDK deployment requirement | Changes need manual copy | 🟡 Low | Copy build to `node_modules` after SDK changes |
| StatusList revocation delay | Revoked credentials appear valid for 30min-hours | 🟡 Low | **By design** - eventual consistency model. Query database for real-time status |

**Known Behaviors (Not Bugs)**:
- **Asynchronous revocation processing**: StatusList bitstring updates delayed 30 minutes to several hours after revocation API call. This is intentional architecture for performance optimization.
- **DIDComm invitation immutability**: Invitation URLs contain embedded service endpoints. Old invitations retain HTTP URLs even after HTTPS migration. Always create fresh invitations after configuration changes.

**Previously Fixed Issues**:
- ~~DIDComm connection storage error~~ - ✅ RESOLVED Oct 14 via SDK fix
- ~~Messages not delivered~~ - ✅ RESOLVED Oct 14 via SDK fix
- ~~UnsupportedAttachmentType crashes~~ - ✅ RESOLVED Oct 14 via graceful filtering
- ~~Message timestamp display~~ - ✅ RESOLVED via timestamp conversion
- ~~Sender cannot decrypt own sent messages~~ - ✅ RESOLVED Oct 25 via direction-based key selection
- ~~StatusList revocation sync failure~~ - ✅ CLARIFIED Oct 28 - Not a bug, asynchronous by design
- ~~Bob wallet inactive~~ - ✅ DECOMMISSIONED Nov 9, 2025 - Alice is sole active wallet

---

## File Locations Reference

### Alice Wallet (SDK v6.6.0)

```
/root/clean-identus-wallet/sdk-v6-test/sdk-ts/
  src/domain/models/
    Message.ts       # ✅ FIXED Oct 14 - Graceful attachment handling
  demos/
    alice-wallet/src/
      components/      # UI components
        OOB.tsx        # Invitation handling + context selector
        Message.tsx    # DIDComm messages
        Credentials.tsx # VC display
        Verify.tsx     # VC verification
      actions/index.ts # Redux actions
      reducers/app.ts  # State management
      utils/           # Utilities
        InvitationStateManager.ts
        vcValidation.ts
        UniversalVCResolver.ts
        SecureDashboardBridge.ts  # Phase 2 encryption support
        LazySDKLoader.ts
        MemoryMonitor.ts
```

### Certification Authority

```
/root/certification-authority/
  server.js                    # Main Express server
  public/
    dashboard.html             # Secure Information Portal
    security-clearance.html    # Security clearance request flow
  lib/
    encryption.js              # X25519 encryption utilities
    contentDatabase.js         # Content management abstraction
```

### Company Admin Portal

```
/root/company-admin-portal/
  server.js              # Express server
  package.json
  start.sh
  README.md
  lib/
    companies.js         # Company configuration
  public/
    index.html          # Frontend UI
    app.js              # Frontend JavaScript
    styles.css          # Styling
  docs/
    CREDENTIAL_ISSUANCE_WORKFLOW.md
    API_REFERENCE.md
```

---

## Glossary

| Term | Definition |
|------|------------|
| **DIDComm** | Decentralized Identifier Communication protocol |
| **DID** | Decentralized Identifier (W3C standard) |
| **VC** | Verifiable Credential |
| **VP** | Verifiable Presentation |
| **OOB** | Out-of-Band (initial connection protocol) |
| **Peer DID** | DID without blockchain anchoring |
| **PRISM DID** | Atala PRISM blockchain-anchored DID |
| **Edge Wallet** | Browser-based wallet on user's device |
| **Cloud Agent** | Server-side DIDComm agent |
| **Mediator** | Message routing service |
| **IndexedDB** | Browser-based persistent storage |
| **Ed25519** | Modern elliptic curve cryptography for digital signatures |
| **X25519** | Elliptic curve Diffie-Hellman key agreement for encryption |
| **StatusList2021** | W3C standard for credential revocation using compressed bitstrings |
| **Eventual Consistency** | System architecture where updates propagate asynchronously over time |
| **NaCl Box** | Authenticated encryption using XSalsa20-Poly1305 (libsodium crypto_box) |
| **postMessage** | Browser API for secure cross-window/cross-origin communication |
| **Zero-Knowledge Server** | Server architecture where server cannot decrypt encrypted content it stores/transmits |
| **ServiceConfiguration VC** | Credential containing enterprise wallet configuration (API keys, endpoints) |
| **Wallet Context** | Mode of wallet operation (Personal vs Enterprise) |

---

## External Resources

**Hyperledger Identus**:
- Documentation: https://docs.atalaprism.io/
- SDK Repository: https://github.com/hyperledger/identus-edge-agent-sdk-ts
- Cloud Agent: https://github.com/hyperledger/identus-cloud-agent

**Standards**:
- W3C Verifiable Credentials: https://www.w3.org/TR/vc-data-model/
- W3C DIDs: https://www.w3.org/TR/did-core/
- DIDComm v2: https://identity.foundation/didcomm-messaging/spec/
- W3C StatusList2021: https://www.w3.org/TR/vc-status-list/
- X25519: https://tools.ietf.org/html/rfc7748
- XSalsa20-Poly1305: https://nacl.cr.yp.to/

---

## Support

**Troubleshooting Steps**:
1. Check mediator logs for message delivery
2. Verify Cloud Agent credential states
3. Ensure wallet initialization (browser console)
4. Review troubleshooting table above
5. Perform hard refresh after updates (Ctrl+Shift+R)
6. Check DEVELOPMENT_HISTORY.md for historical context
7. Verify all URLs use HTTPS domain (not IP addresses)

**Hard Refresh Required**: Users must hard refresh after SDK updates or major changes to clear browser cache

**SDK Development**: After modifying SDK source, must rebuild AND copy to wallet's `node_modules` directory

**HTTPS Migration**: All services now use `https://identuslabel.cz` domain. Replace any hardcoded IP addresses with domain URLs.

---

**Document Version**: 5.0 (Streamlined Edition)
**Last Updated**: 2025-11-15
**Status**: Production-Ready - Restructured for Clarity
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
