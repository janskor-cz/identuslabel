# Hyperledger Identus SSI Infrastructure - Changelog

This file contains historical updates and fixes that have been archived from the main documentation.

---

## November 2025

### DIDComm Label Transmission Implementation (November 7, 2025)

**Status**: ✅ Production Ready

Implemented dual-label system allowing user-provided names to be transmitted to Certification Authority while maintaining consistent wallet connection naming.

**Architecture**:
- **CA Label**: "CA Connection: {userName}" (server-side, from query parameter)
- **Wallet Label**: "Certification Authority" (client-side, fixed name)
- **Workaround**: Pre-populate label at invitation creation (sidesteps Cloud Agent 2.0.0 limitation)

**Key Fixes**:
1. CA server accepts `userName` query parameter in well-known invitation endpoint
2. Wallet sends userName via `?userName={name}` when fetching invitation
3. Wallet stores connection with fixed name "Certification Authority"
4. React state timing fix (synchronous local flag vs async state variable)
5. Automated test coverage (8/8 tests passing)

**Technical Details**:
- Cloud Agent 2.0.0 does not extract labels from HandshakeRequest messages
- Labels only set at invitation creation, never updated from incoming requests
- Query parameter solution avoids needing Cloud Agent modifications

**Files Modified**:
- `/root/certification-authority/server.js` (lines 616-671)
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/ConnectToCA.tsx` (lines 163-165, 306, 536)
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/components/ConnectToCA.tsx` (same changes)
- `/root/test-label-transmission.js` (added STEP 10 verification)

**Testing**:
- Automated Puppeteer test: 8/8 passing (100% success rate)
- Manual testing confirmed dual-label system working
- Screenshots captured at each test step

---

## October 2025

### Bidirectional Credential Sharing During Connection (October 29, 2025)

**Status**: ✅ Deployed

Implemented bidirectional credential sharing capability allowing both parties to exchange Verifiable Credentials during DIDComm connection establishment.

**Key Features**:
- Invitee can share credentials back when accepting invitation
- Automatic name extraction from shared VCs for connection labels
- RFC 0434 compliant `requests_attach` implementation
- Role-based architecture (inviter/invitee terminology)

**Files Modified**:
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/OOB.tsx`
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/components/OOB.tsx`

---

### W3C-Compliant Credential Schemas (October 28, 2025)

**Status**: ✅ Deployed

Successfully registered W3C-compliant credential schemas with auto-populated metadata and enhanced wallet display.

**Schemas**:
- **RealPerson v3.0.0**: GUID `e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`
- **SecurityClearanceLevel v4.0.0**: GUID `ba309a53-9661-33df-92a3-2023b4a56fd5`

**Enhancements**:
- Auto-populated metadata (credentialType, issuedDate, expiryDate, credentialId)
- Enhanced wallet display with type and expiration tracking
- Credential filtering (revoked credentials excluded from selection)
- Smart expiration display (days/months/years)

---

### Credential Revocation StatusList Fix (October 28, 2025)

**Status**: ✅ Resolved

Fixed multiple issues preventing accurate credential revocation status display in edge wallets.

**Issues Resolved**:
1. localStorage data leakage between wallets (no prefixes)
2. Timestamp display bug in chat messages
3. StatusList Base64URL decompression failure
4. Case-sensitive StatusPurpose comparison

**Solutions**:
- Created `prefixedStorage.ts` utility for wallet-specific localStorage
- Fixed timestamp threshold from 1 trillion to 10 billion milliseconds
- Removed incorrect Base64URL first-character stripping
- Case-insensitive StatusPurpose comparison

**Files Modified**:
- NEW: `src/utils/prefixedStorage.ts`
- Updated: `securityKeyStorage.ts`, `keyVCBinding.ts`, `OOB.tsx`, `ConnectionRequest.tsx`, `PresentationRequestModal.tsx`, `messageEncryption.ts`, `credentialStatus.ts`, `Chat.tsx`, `credentials.tsx`

---

### Duplicate Status Badge Cleanup (October 26, 2025)

**Status**: ✅ Completed

Removed redundant credential status badge implementation causing duplicate displays.

**Changes**:
- Removed page-level status checking in `credentials.tsx`
- Kept component-level status display in `Credential.tsx`
- Single status badge per credential

---

### X25519 Bidirectional Decryption Fix (October 25, 2025)

**Status**: ✅ Resolved

**Problem**: Sender could not decrypt their own sent encrypted messages.

**Root Cause**: Incorrect public key selection for decryption based on message direction.

**Solution**:
- Implemented direction-based public key selection
- SENT messages (direction = 0): Use recipient's X25519 public key
- RECEIVED messages (direction = 1): Use sender's X25519 public key

**Technical Details**:
X25519 Diffie-Hellman creates identical shared secrets on both sides:
- Alice encrypts: `shared_secret = scalar_mult(Alice_private, Bob_public)`
- Alice decrypts sent: `shared_secret = scalar_mult(Alice_private, Bob_public)` ✅
- Bob decrypts received: `shared_secret = scalar_mult(Bob_private, Alice_public)` ✅

**Files Modified**:
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/Chat.tsx` (lines 194-216)
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/components/Chat.tsx` (lines 194-216)

---

### Dual-Key Security Clearance Credentials Fix (October 25, 2025)

**Status**: ✅ Resolved

**Problem**: Security Clearance credentials issued with empty key fields.

**Root Cause**: Login flow redirected to deprecated page without key generation form.

**Solution**:
- Updated login redirect to `security-clearance.html` (with dual-key form)
- Created `SecurityClearanceLevel v3.0.0` schema with flat dual-key structure
- Unified endpoint `/api/credentials/issue-security-clearance`
- Ed25519 for signing, X25519 for encryption (derived from same seed)

**Files Modified**:
- `/root/certification-authority/server.js` (line 2831)
- Cloud Agent Schema Registry (new schema v3.0.0)

---

### StatusList2021 Credential Revocation Architecture (October 26-28, 2025)

**Status**: ✅ Documented

Comprehensive documentation of Cloud Agent's native StatusList2021 implementation.

**Key Points**:
- Cloud Agent handles all revocation mechanics internally
- Asynchronous batch processing architecture
- StatusList bitstring updates delayed 30 minutes to several hours (by design)
- Two-phase process: immediate database update + delayed bitstring sync
- Eventual consistency model for performance optimization

**Architecture**:
- **Phase 1** (synchronous): Database `is_canceled` flag set immediately
- **Phase 2** (asynchronous): Background job updates StatusList bitstring
- Public endpoint `/credential-status/{id}` serves StatusList2021 VCs
- Wallet verification via public endpoint (no authentication required)

**Database Schema**:
- `credentials_in_status_list`: Individual credential tracking
- `credential_status_lists`: StatusList VC storage (JSONB with compressed bitstring)

---

## September-October 2025

### SDK Attachment Validation Fix (October 14, 2025)

**Status**: ✅ Resolved

**Error**: `UnsupportedAttachmentType: Unsupported Attachment type` at SDK `Message.fromJson()` line 5250

**Root Cause**: SDK threw fatal exceptions instead of gracefully handling unsupported attachments.

**Solution**:
- Replaced exception throwing with graceful attachment filtering
- Added warning console logs for debugging
- Handles empty attachment arrays (standard for DIDComm connection responses)

**File Modified**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/src/domain/models/Message.ts` (lines 104-142)

**Deployment**:
1. SDK rebuilt from source
2. Fixed build copied to both wallets' `node_modules`
3. `.next` cache cleared
4. Development servers restarted

---

## Document Information

**Created**: November 2, 2025
**Purpose**: Archive historical updates from main documentation
**Maintained By**: Hyperledger Identus SSI Infrastructure Team

For current status and recent updates, see `/root/CLAUDE.md`
