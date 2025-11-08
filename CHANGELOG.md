# Changelog

All notable changes to the Hyperledger Identus SSI Infrastructure project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.0.0] - 2025-11-02 - Phase 2 Client-Side Encryption (Production Ready)

### Added

**Phase 2 Client-Side Encryption**:
- End-to-end encrypted content delivery for Secure Information Portal
- X25519 public key extraction from Security Clearance VCs (server-side)
- Zero-knowledge server architecture (server cannot decrypt content)
- Client-side decryption using X25519 private keys (wallet-based)
- postMessage API for secure cross-window communication
- Encrypted content endpoint: `GET /api/dashboard/encrypted-content`
- Visual ciphertext display before decryption (base64url strings)
- Manual "Decrypt with Wallet" button for user-triggered decryption
- Auto-closing wallet window after successful decryption (2-second delay)
- Progress tracking UI showing "Decrypted X/N sections"

**Performance**:
- Measured 317-350ms latency per section (4 sections in parallel)
- 100% success rate in production testing
- XSalsa20-Poly1305 authenticated encryption (NaCl box)

**Security Enhancements**:
- Server stores only X25519 public keys (cannot decrypt)
- Private keys never transmitted (localStorage isolation)
- Origin validation for postMessage API
- Zero server knowledge of viewed content

### Changed

- Dashboard diagnostic logging fixed (removed SecurityError from cross-origin location access)
- Server session storage extended to include `x25519PublicKey` field
- Wallet SecureDashboardBridge enhanced with diagnostic logging

### Fixed

- **Backend X25519 Key Extraction** (server.js:3850-3866): Server now extracts and stores X25519 public key from Security Clearance VCs
- **Dashboard SecurityError** (dashboard.html:528-533, 946-953): Removed problematic `walletWindow.location` access causing cross-origin security exceptions

---

## [3.2.0] - 2025-10-31 - Secure Dashboard Bridge Implementation

### Added

**Wallet-Dashboard Communication**:
- SecureDashboardBridge utility for postMessage API communication
- WALLET_READY signal for handshake between wallet and dashboard
- DECRYPT_REQUEST/DECRYPT_RESPONSE message types
- Origin whitelist validation (`identuslabel.cz`, IP fallback, localhost)
- Automatic wallet window opening from dashboard
- Request ID tracking for message correlation

**Files Added**:
- `/services/edge-wallets/alice-wallet/src/utils/SecureDashboardBridge.ts`
- `/services/edge-wallets/bob-wallet/src/utils/SecureDashboardBridge.ts`

### Changed

- Wallet initialization includes SecureDashboardBridge setup
- Dashboard opener window detection for automatic READY signal

---

## [3.1.0] - 2025-10-30 - Secure Information Portal Phase 1

### Added

**Secure Information Portal**:
- VC-authenticated content access at `/ca/dashboard`
- Progressive disclosure based on Security Clearance level
- Session-based authentication (1-hour expiration)
- Content database abstraction layer for WordPress integration
- Five clearance levels: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED, TOP-SECRET
- API endpoint: `GET /api/dashboard/content?session={sessionId}`

**Content Management**:
- Local JSON content database (7 hardcoded sections)
- Database abstraction layer (`lib/contentDatabase.js`)
- WordPress integration documentation

**User Experience**:
- "Get Security Clearance" authentication flow
- Progressive content expansion after login
- Clearance badge indicators (color-coded)
- Graceful session expiration handling

---

## [3.0.0] - 2025-10-28 - StatusList2021 Architecture Clarification

### Clarified

**StatusList2021 Revocation Behavior** (Not a Bug):
- Documented asynchronous revocation processing architecture
- Revocation API returns success immediately (HTTP 200)
- Database `is_canceled` flag updated synchronously (0-1 second)
- StatusList bitstring updated asynchronously (30 minutes - several hours)
- This is **by design** for performance optimization

**Background Processing**:
- Background job: `StatusListJobs.updateBitStringForCredentialAndNotify`
- Message queue topic: `sync-status-list`
- Database tables documented: `credentials_in_status_list`, `credential_status_lists`

### Added

- **Credential Revocation Documentation** (CLAUDE.md): Complete StatusList2021 architecture
- **Database Schema Documentation**: PostgreSQL table structures
- **Verification Commands**: SQL queries for checking revocation status
- **Testing Procedures**: End-to-end revocation validation

### Fixed

- **CA Server Revocation Endpoint** (server.js:1919-1951): JWT decoding to extract `credentialStatusId`
- **Revocable Credentials API** (`/api/credentials/revocable`): Proper JWT parsing to identify revocable credentials

---

## [2.2.0] - 2025-10-25 - X25519 Bidirectional Decryption Fix

### Fixed

**Critical Encrypted Messaging Bug**:
- Sender could not decrypt their own sent encrypted messages
- Direction-based public key selection implemented in Chat.tsx
- SENT messages (direction = 0): Use recipient's X25519 public key
- RECEIVED messages (direction = 1): Use sender's X25519 public key

**Files Modified**:
- `alice-wallet/src/components/Chat.tsx` (lines 194-216)
- `bob-wallet/src/components/Chat.tsx` (lines 194-216)

**Technical Solution**:
- Leverages X25519 Diffie-Hellman symmetric property
- `scalar_mult(Alice_private, Bob_public) === scalar_mult(Bob_private, Alice_public)`
- Both sender and receiver can decrypt using same shared secret

---

## [2.1.0] - 2025-10-14 - SDK Attachment Validation Fix

### Fixed

**Critical SDK Stability Issue**:
- Fatal `UnsupportedAttachmentType` exception causing wallet crashes
- SDK now gracefully handles unknown attachment types with warning logs
- Empty attachment arrays processed correctly (DIDComm connection responses)

**Files Modified**:
- `sdk-ts/src/domain/models/Message.ts` (lines 104-142)

**Changes**:
- Replaced fatal exception throwing with attachment filtering
- Added warning console logs for debugging
- Validates attachments without breaking message flow

### Changed

**SDK Deployment Process**:
- Documented requirement to copy SDK build to wallet `node_modules`
- Added `.next` cache clearing to deployment steps
- Required user hard refresh (Ctrl+Shift+R) after SDK updates

---

## [2.0.0] - 2025-11-02 - HTTPS Migration Complete

### Added

**Domain-Based HTTPS Access**:
- Caddy reverse proxy with automatic Let's Encrypt SSL
- All services accessible via `https://identuslabel.cz`
- Service URLs: `/ca`, `/alice`, `/bob`, `/cloud-agent`, `/didcomm`, `/mediator`

**Configuration Changes**:
- Cloud Agent environment variables updated with HTTPS URLs
- CA Server base URL: `https://identuslabel.cz/cloud-agent`
- Mediator service endpoint: `https://identuslabel.cz/mediator`
- Wallet SecureDashboardBridge origin whitelist: `https://identuslabel.cz`

**Backward Compatibility**:
- HTTP access via IP maintained: `http://91.99.4.54:8000`
- Caddyfile `:8000` block handles HTTP traffic

### Changed

**Restart Sequence** (Critical Order):
1. Cloud Agent container recreated (not restarted) to apply env changes
2. Caddy reverse proxy restarted
3. CA server restarted with updated base URL
4. Wallets restarted with SecureDashboardBridge updates

**Files Modified**:
- `/infrastructure/docker/cloud-agent-with-reverse-proxy.yml` (lines 64-67)
- `/services/certification-authority/server.js` (line 11)
- `/infrastructure/reverse-proxy/Caddyfile` (lines 78-124)
- `/infrastructure/docker/identus-mediator/docker-compose.yml` (line 21)
- Wallet SecureDashboardBridge (alice-wallet/src/utils/SecureDashboardBridge.ts line 13)

### Fixed

**Invitation URL Immutability**:
- Documented that DIDComm invitation URLs are immutable once created
- Peer DIDs embed DIDCOMM_SERVICE_URL at creation time
- Old invitations retain HTTP URLs (cannot be changed)
- Solution: Always create fresh invitations after configuration changes

---

## [1.0.0] - 2025-10-01 - Initial Production Release

### Added

**Core SSI Infrastructure**:
- Hyperledger Identus Cloud Agent 2.0.0 integration
- Identus Edge Agent SDK v6.6.0 (with custom fixes)
- Identus Mediator for message routing
- Local PRISM Node (VDR) for DID resolution

**Hierarchical Issuance**:
- Top-Level Issuer Cloud Agent (port 8100)
- Main CA Cloud Agent (port 8000)
- Two-tier trust hierarchy

**Edge Wallets**:
- Alice Wallet (browser-based, port 3001)
- Bob Wallet (browser-based, port 3002)
- IndexedDB storage for credentials
- DIDComm v2 messaging support

**Certification Authority**:
- Web-based admin portal (port 3005)
- Identity Credential issuance
- Security Clearance Credential issuance
- Employee Badge Credential issuance
- Connection management UI
- Credential approval workflow

**Features**:
- DIDComm connection establishment (OOB invitations)
- W3C Verifiable Credential issuance
- VC presentation verification
- Encrypted messaging (X25519 + XSalsa20-Poly1305)
- Credential revocation (StatusList2021)

**Security**:
- HTTPS with Let's Encrypt (Caddy reverse proxy)
- Fail2ban SSH protection
- Ed25519 digital signatures
- X25519 key agreement (ECDH)
- Client-side key generation (keys never transmitted)

**Documentation**:
- CLAUDE.md (complete technical reference)
- README.md (quick start guide)
- DEVELOPMENT_HISTORY.md (evolution timeline)
- API documentation

---

## Versioning Scheme

**Version Format**: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes (incompatible API changes)
- **MINOR**: New features (backward-compatible)
- **PATCH**: Bug fixes (backward-compatible)

**Current Version**: 4.0.0 (Phase 2 Client-Side Encryption)

---

## Links

- **GitHub Repository**: https://github.com/your-org/hyperledger-identus-ssi
- **Documentation**: CLAUDE.md, README.md
- **Issue Tracker**: https://github.com/your-org/hyperledger-identus-ssi/issues
- **Hyperledger Identus**: https://www.hyperledger.org/projects/identus

---

## Legend

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features that will be removed
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security improvements
- **Clarified**: Documentation improvements without code changes

---

**Maintained By**: Hyperledger Identus SSI Infrastructure Team

**Last Updated**: 2025-11-08
