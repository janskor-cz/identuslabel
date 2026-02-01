# Hyperledger Identus SSI Infrastructure - Project Status

**Production Self-Sovereign Identity (SSI) Infrastructure**

> **Note**: This file was previously `CLAUDE.md`. For Claude Code development guidance (build commands, architecture, workflows), see the new [CLAUDE.md](./CLAUDE.md).

> **Complete Documentation**: See [Documentation Index](#documentation-index) for comprehensive guides and references
>
> **Development History**: [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md) | **Update Log**: [CHANGELOG.md](./CHANGELOG.md)

---

## 📋 Quick Navigation

| Section | Purpose |
|---------|---------|
| [Latest Updates](#latest-updates) | Recent feature releases and fixes |
| [Quick Reference](#quick-reference) | Service URLs, status, architecture |
| [Getting Started](#getting-started) | First-time setup and deployment |
| [Core Features](#core-features) | Main SSI capabilities |
| [Documentation Index](#documentation-index) | Complete docs by category |
| [Known Issues](#known-issues) | Current limitations and workarounds |
| [Support](#support) | Troubleshooting and help resources |

---

## Latest Updates

> **Historical Updates**: See [CHANGELOG.md](./CHANGELOG.md)

### ✅ Security Clearance Level Standardization (Jan 7, 2026)

**STATUS**: ✅ **PRODUCTION READY** - Unified security clearance naming across all systems

Standardized security clearance level naming convention across CA Portal, Enterprise Server, and all wallet implementations.

**Standard Levels**:
| Level | Name | Numeric | Description |
|-------|------|---------|-------------|
| 1 | INTERNAL | 1 | Basic organizational access |
| 2 | CONFIDENTIAL | 2 | Sensitive business information |
| 3 | RESTRICTED | 3 | Highly sensitive strategic information |
| 4 | TOP-SECRET | 4 | Classified information (highest) |

**Previous Naming (Legacy)**:
- `UNCLASSIFIED` → now `INTERNAL`
- `SECRET` → now `RESTRICTED`
- `TOP_SECRET` → now `TOP-SECRET` (hyphenated)

**Backward Compatibility**: All systems include legacy mappings to support existing documents and credentials created with old naming.

**Files Modified**:

*Enterprise Server (`/root/company-admin-portal`)*:
- `lib/ClearanceDocumentParser.js` - CLEARANCE_LEVELS constant
- `lib/DocxRedactionService.js` - CLEARANCE_LEVELS, STYLE_CLEARANCE_MAP
- `lib/ReEncryptionService.js` - getLevelNumber(), getLevelLabel()
- `lib/DocumentRegistry.js` - clearanceLevels objects, meetsClassificationRequirement(), getStatistics()
- `lib/DocxClearanceParser.js` - STYLE_CLEARANCE_MAP
- `server.js` - ~20+ validation arrays and objects
- `public/employee-portal-dashboard.html` - CSS classes, dropdown options
- `public/js/employee-portal-dashboard.js` - color functions, level maps

*IDL Wallet (`/root/idl-wallet`)*:
- `src/utils/securityLevels.ts` - SecurityLevel enum
- `src/pages/documents.tsx` - levelMap
- `src/components/SecurityLevelSelector.tsx` - switch cases
- `src/components/EncryptedMessageBadge.tsx` - badge colors
- `src/components/Chat.tsx` - default levels
- `src/actions/index.ts` - default levels
- `src/utils/keyVCBinding.ts` - default values

*Alice Wallet (`/root/clean-identus-wallet/.../alice-wallet`)*:
- `src/utils/securityLevels.ts` - SecurityLevel enum (complete rewrite)
- `src/actions/index.ts` - default levels, comments
- `src/components/Chat.tsx` - default levels
- `src/components/EncryptedMessageBadge.tsx` - switch cases
- `src/components/SecurityLevelSelector.tsx` - switch cases
- `src/components/DocumentAccess.tsx` - badge labels
- `src/components/ClassifiedDocumentViewer.tsx` - badge labels, CSS selectors
- `src/pages/documents.tsx` - badge labels, levelMap, dropdowns
- `src/pages/my-documents.tsx` - badge labels
- `src/types/StandardMessageBody.ts` - type union
- `src/types/invitations.ts` - type union
- `src/utils/keyVCBinding.ts` - comments, defaults
- `src/utils/credentialTypeDetector.ts` - defaults
- `src/utils/EphemeralDIDCrypto.ts` - label functions
- `src/utils/SecureDashboardBridge.ts` - defaults
- `src/utils/documentStorage.ts` - comments

**Legacy Support Pattern**:
```javascript
const clearanceLevels = {
    'INTERNAL': 1,
    'UNCLASSIFIED': 1,  // Legacy
    'CONFIDENTIAL': 2,
    'RESTRICTED': 3,
    'SECRET': 3,  // Legacy
    'TOP-SECRET': 4,
    'TOP_SECRET': 4,  // Legacy
    'TOPSECRET': 4    // Legacy
};
```

---

### ✅ Configurable Wallet Selector for Employee Portal (Jan 4, 2026)

**STATUS**: ✅ **PRODUCTION READY** - Employees can switch between wallets for document access

Added a configurable wallet selector to the Employee Portal Dashboard, allowing users to switch between different wallets (IDL Wallet, Alice Wallet, or custom URLs) for document access operations.

**Key Features**:
- **Default wallet**: IDL Wallet (`/wallet`) - changed from previous Alice Wallet default
- **Preset buttons**: Quick switch between IDL Wallet and Alice Wallet
- **Custom URL input**: Enter any wallet path for testing/development
- **Persistence**: Selection saved in `localStorage`, survives page refresh
- **Auto-cleanup**: Closes existing wallet window when switching

**UI Location**: "Wallet Settings" card at the bottom of the Employee Portal Dashboard

**Files Modified**:
- `company-admin-portal/public/js/employee-portal-dashboard.js` - Dynamic wallet URL functions, localStorage management
- `company-admin-portal/public/employee-portal-dashboard.html` - Wallet Settings UI card, CSS styles

**Technical Details**:
```javascript
// New functions added:
getCurrentWalletPath()    // Get saved wallet path or default
getWalletUrl()           // Build full wallet URL based on environment
getWalletOrigin()        // Get wallet origin for postMessage validation
setWalletPath(path)      // Save wallet path and reset connection
updateWalletSelectorUI() // Update UI to reflect current selection
```

---

### ✅ Browser Console Logging & Proof Request Name Resolution (Jan 4, 2026)

**STATUS**: ✅ **PRODUCTION READY** - Console logs captured to server, proof requests show connection names

#### Browser Console Logging Re-enabled

Re-enabled the ConsoleLogger system that captures browser console output to server-side log files for debugging.

**Features**:
- All `console.log`, `console.error`, `console.warn`, `console.info` captured
- Log filename displayed in browser console at startup: `📁 [ConsoleLogger] Logging to: /root/logs/wallet-debug-alice-2026-01-04-XX-XX-XX.log`
- Auto-rotation: Max 10MB per file, max 50 files per wallet
- Batched sends every 5 seconds or 100 entries

**Log Location**: `/root/logs/wallet-debug-{walletId}-{timestamp}.log`

**Files Modified**:
- `alice-wallet/src/pages/_app.tsx` - Uncommented `initConsoleLogger('alice')`
- `alice-wallet/src/pages/api/logs.ts` - Changed `LOG_DIR` to `/root/logs`, added `logFilePath` to response
- `alice-wallet/src/utils/ConsoleLogger.ts` - Display log filename after first successful flush

#### Proof Request Connection Name Resolution (IDL Wallet)

Enhanced proof request display to show connection names instead of DIDs using multi-strategy lookup.

**Problem**: Proof requests showed `did:peer:2.Ez6LSsJTM...` instead of connection name like "Alice Cooper"

**Solution**: Enhanced `getConnectionName()` with 3 resolution strategies:
1. **Exact DID match** - Find connection where `receiver` or `host` matches requester DID
2. **Partial DID match** - Handle slight DID format differences
3. **Credential resolver** - Look up names from credentials associated with the connection

**Files Modified**:
- `idl-wallet/src/components/UnifiedProofRequestModal.tsx` - Added import for `getConnectionNameWithFallback`, enhanced `getConnectionName()` with debug logging

**Debug Logs**: Check browser console for `[ProofRequest]` messages showing resolution attempts

---

### ✅ Security Clearance Credential Display Name Fix (Jan 2, 2026)

**STATUS**: ✅ **PRODUCTION READY** - Security Clearance credentials now display holder name and clearance level correctly

Fixed credential display in proof request dropdowns and OOB modals where Security Clearance VCs showed DID instead of holder name.

**Problem**: Security Clearance showed `did:prism:be299...32AGmzWjmq (Clearance) [Exp: 1yr]` instead of `Alice Copper (CONFIDENTIAL) [Exp: 1yr]`

**Root Cause**: `credentialNaming.ts` accessed `credential.credentialSubject` directly, but SDK credentials store claims in a `properties` Map that requires special extraction via `getCredentialSubject()` helper.

**Fix Applied**:
```typescript
// credentialNaming.ts - Now uses getCredentialSubject helper
import { getCredentialSubject } from './credentialTypeDetector';

const subject = getCredentialSubject(credential);  // Handles SDK Map format
if (subject) {
  // Existing holderName and clearanceLevel checks now work correctly
}
```

**File Modified**:
- `alice-wallet/src/utils/credentialNaming.ts` - Added import and use of `getCredentialSubject` helper

**Result**: Security Clearance credentials now correctly display `Alice Copper (CONFIDENTIAL) [Exp: 1yr]`

---

### ✅ PRISM DID Binding Disabled for Credential Issuance (Dec 15, 2025)

**STATUS**: ⚠️ **WORKAROUND ACTIVE** - Custom PRISM DID binding temporarily disabled

Cloud Agent v2.1.0 cannot validate long-form PRISM DIDs in JWT credential requests. All credential issuance attempts with custom holder DIDs failed with `InvalidDid` error.

**Root Cause**: When wallet passed a custom PRISM DID to the SDK for credential requests, the resulting JWT contained:
```json
{
  "header": {
    "alg": "ES256K",
    "kid": "did:prism:be299c1387e9da53...#authentication-0"  // Long-form PRISM DID
  }
}
```
Cloud Agent failed to parse/resolve this long-form DID and returned:
```
CredentialRequestValidationFailed(JWT presentation verification failed: InvalidDid(invalidDid))
```

**Workaround Applied**: Disabled PRISM DID binding feature - SDK now creates internal DIDs for each credential request (original working behavior).

**File Modified**:
- `alice-wallet/src/actions/index.ts` - Removed `subjectDID` parameter from `prepareRequestCredentialWithIssuer()` call

**Credential Issuance Flow** (current):
```
Cloud Agent (Issuer)                    Edge Wallet (Holder)
        │                                       │
        │  1. OfferCredential                   │
        │  ────────────────────────►            │
        │                                       │  2. SDK creates internal PRISM DID
        │                                       │     (masterSk + authSk stored in Pluto)
        │  3. RequestCredential                 │
        │  ◄────────────────────────            │
        │     JWT signed by authSk              │
        │                                       │
        │  4. IssueCredential                   │
        │  ────────────────────────►            │
        │     VC with SDK's DID in subject.id  │
```

**Impact**:
- ✅ Credential issuance now works
- ⚠️ Holder DID in credentials is SDK-generated (not CA-connection PRISM DID)
- 📋 TODO: Re-enable when Cloud Agent supports long-form PRISM DID validation

**Related**: Security Clearance VCs store custom Ed25519/X25519 keys as **claim data fields** (not as holder DID), which is why they work with custom keys.

---

### ✅ PRISM DID Duplicate Prevention & CA Connection Fix (Dec 14, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Single PRISM DID created per CA connection

Fixed critical bugs where:
1. PRISM DID was not created for existing CA connections (early return bug)
2. Multiple duplicate PRISM DIDs were created (3 instead of 1)
3. "Copy DID" button showed nothing instead of PRISM DID

**Root Causes**:
1. **Early Return Bug**: `CAConnectionEnforcementModal.tsx` returned early for existing CA connections without checking/creating PRISM DID
2. **Duplicate Creation**: No check for existing CA PRISM DID before creating new one (clicking Connect multiple times created duplicates)
3. **Pluto Storage Bug**: SDK's `storeDID()` with 3 private keys creates 3 database entries; `getAllPrismDIDs()` returns all 3 as duplicates

**Solutions**:
```javascript
// 1. localStorage guard prevents duplicate creation
const existingCAPrismDID = getItem('ca-connection-prism-did');
if (existingCAPrismDID) {
    console.log('[CA MODAL] Reusing existing PRISM DID');
    return existingCAPrismDID; // Don't create new one
}
// After creation, store immediately:
setItem('ca-connection-prism-did', newPrismDID);

// 2. Deduplication in refreshPrismDIDs action
const seenDIDs = new Set<string>();
const prismDIDs = allPrismDIDs.filter(item => {
    if (seenDIDs.has(item.did)) return false;
    seenDIDs.add(item.did);
    return true;
});
```

**Files Modified**:
- `alice-wallet/src/components/CAConnectionEnforcementModal.tsx` - Added PRISM DID check for existing connections, localStorage guard
- `alice-wallet/src/components/PageHeader.tsx` - Updated "Copy DID" to show PRISM DID from connection metadata
- `alice-wallet/src/actions/index.ts` - Added deduplication to `refreshPrismDIDs` action

**Console Output** (after fix):
```
[CA MODAL] Creating PRISM DID with alias: Alice Cooper
[PRISM DID] Removed 2 duplicate entries
[PRISM DID] Refreshed list, count: 1 with aliases: 1
```

---

### ✅ DOCX Whitespace Preservation & Filename Fix (Dec 13, 2025)

**STATUS**: ✅ **PRODUCTION READY** - DOCX documents now preserve proper spacing and use original filenames

Fixed critical bug where downloaded DOCX documents had missing spaces between words (e.g., "Thisis" instead of "This is"). Also fixed filename handling to use the original uploaded filename instead of DOCX internal metadata.

**Root Cause**: The `DocxRedactionService` was using `xml2js` to parse and re-serialize the entire document XML. During serialization, xml2js normalizes whitespace, collapsing spaces between text runs and losing the original formatting.

**Solution**: Complete rewrite of `DocxRedactionService.js` to use **string manipulation** instead of xml2js serialization:
- Use xml2js **only** to find which paragraphs need redaction (via style analysis)
- Use **regex** on the **original XML string** to replace only redacted paragraphs
- Non-redacted content remains **completely untouched**, preserving all whitespace

**Key Fixes**:
```javascript
// DocxRedactionService.js - String manipulation approach
static redactParagraphsByStyle(xml, styleId, clearance) {
  const paragraphRegex = new RegExp(`(<w:p[^>]*>)(.*?)(<\\/w:p>)`, 'gs');
  return xml.replace(paragraphRegex, (match, openTag, content, closeTag) => {
    if (stylePattern.test(content)) {
      return this.createRedactedParagraphXml(styleId, clearance);
    }
    return match; // Keep original - preserves whitespace perfectly
  });
}

// server.js - Always use original filename
const filenameWithoutExt = file.originalname.replace(/\.(docx|html?)$/i, '');
parsedDocument.metadata.title = filenameWithoutExt;
```

**Files Modified**:
- `/root/company-admin-portal/lib/DocxRedactionService.js` - Complete rewrite with string manipulation
- `/root/company-admin-portal/lib/DocxClearanceParser.js` - Fixed spacing in text extraction methods
- `/root/company-admin-portal/server.js` - Filename handling, removed unused title parameter

**Verification**: Uploaded "classified-document-test-4.docx" now displays as "classified-document-test-4" with all text properly spaced.

---

### ✅ PDF.js Secure Viewer with CORS Session Support (Dec 12, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Documents display in secure modal with download prevention

Implemented PDF.js-based document viewer that renders PDFs to canvas, preventing downloads while allowing secure viewing. Also fixed cross-origin session authentication for wallet-to-server communication.

**Key Features**:
- **PDF.js Canvas Rendering**: Documents rendered as pixels on HTML5 canvas (no native PDF controls)
- **Download Prevention**: No download button, right-click disabled, Ctrl+S/Ctrl+P blocked
- **Page Navigation**: Prev/Next buttons with page counter for multi-page documents
- **Auto-scaling**: PDF scaled to fit container width while maintaining aspect ratio
- **CORS Session Support**: Wallet can now authenticate with server via `X-Session-ID` header
- **View-once Restriction Removed**: Documents can be viewed multiple times in modal

**Security Measures**:
```
- Canvas rendering (no downloadable PDF object)
- Context menu disabled on modal
- Keyboard shortcuts blocked (save, print)
- Text selection disabled
- Blob URL revoked on close
```

**Architecture Change**:
```
Before: <object> tag → Browser PDF viewer → Download possible
After:  PDF.js → Canvas rendering → View-only (no download)
```

**Files Modified**:
- `/root/company-admin-portal/public/employee-portal-dashboard.html` - PDF.js modal with canvas
- `/root/company-admin-portal/public/js/employee-portal-dashboard.js` - PDF.js viewer functions
- `/root/company-admin-portal/server.js` - CORS middleware for X-Session-ID header
- `/root/company-admin-portal/lib/ReEncryptionService.js` - Disabled view-once restriction

---

### ✅ PDF Blob Corruption Fix for Document Display (Dec 11, 2025)

**STATUS**: ✅ **PRODUCTION READY** - PDF documents now display correctly after decryption

Fixed critical bug where PDF documents failed to display with "Tento soubor nemůžeme otevřít" (Czech: "We can't open this file") despite successful decryption.

**Root Cause**: The `Blob` constructor in the dashboard received a plain JavaScript array of numbers `[212, 36, 205, ...]` from `Array.from(decrypted)` via postMessage. JavaScript's `Blob()` converts plain arrays to their string representation `"212,36,205,32,..."` (UTF-8 text) instead of treating them as binary bytes.

**Key Fix**:
```javascript
// Before (broken):
new Blob([documentBlob], { type: 'application/pdf' });

// After (fixed):
new Blob([new Uint8Array(documentBlob)], { type: 'application/pdf' });
```

**Data Flow**:
```
Server → NaCl box ciphertext (base64) → Wallet decrypts to Uint8Array →
Array.from(decrypted) via postMessage → Dashboard receives number array →
new Uint8Array(array) → Blob → PDF displays correctly
```

**Files Modified**:
- `/root/company-admin-portal/public/js/employee-portal-dashboard.js` (lines 785-790)

**Details**: See plan file at `/root/.claude/plans/smooth-moseying-clock.md`

---

### ✅ Document Upload with PRISM DID & DocumentMetadataVC (Dec 7, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Complete document upload flow with blockchain-anchored DIDs

Employees can upload documents through the Employee Portal Dashboard. Documents are stored on Iagon decentralized storage, assigned blockchain-anchored PRISM DIDs with storage URLs embedded in service endpoints, and metadata is issued as Verifiable Credentials.

**Key Features**:
- **Iagon-First Upload**: File uploaded to Iagon before DID creation (required for immutable service endpoint)
- **PRISM DID with Service Endpoint**: Document DID contains Iagon download URL in `services[].serviceEndpoint`
- **DocumentMetadataVC**: VC issued via DIDComm to employee's wallet (`automaticIssuance: true`)
- **Document Type Classification**: Report, Contract, Policy, Procedure, Memo, Certificate, Other
- **Clearance-Based Access**: UNCLASSIFIED/CONFIDENTIAL/SECRET/TOP_SECRET classification

**Upload Flow**:
```
Employee Form → Iagon Upload → PRISM DID (with Iagon URL) → Blockchain Publish → DocumentMetadataVC → Employee Wallet
```

**SSI Compliance Note**:
Current model has department wallet holding Document DID keys while employee receives DocumentMetadataVC. This is documented as a known architectural trade-off suitable for enterprise use cases. Full SSI compliance (custodian holds VC) is planned for future enhancement.

**Files Modified**:
- `/root/company-admin-portal/lib/DocumentMetadataVC.js` - Changed `automaticIssuance: true` (line 180)
- `/root/company-admin-portal/server.js` - Made description field optional (line 2722)
- `/root/company-admin-portal/public/employee-portal-dashboard.html` - releasableTo uses company names

**Details**: See plan file at `/root/.claude/plans/noble-greeting-frog.md`

---

### ✅ Iagon Decentralized Storage Integration (Dec 6, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Document files stored on Iagon decentralized storage

Integrated Iagon decentralized storage for document file storage with clearance-based encryption. All API endpoints verified working.

**Key Features**:
- Upload to `https://gw.iagon.com/api/v2/storage/upload` (POST, multipart/form-data)
- Download via `https://gw.iagon.com/api/v2/storage/download` (POST, JSON body with file ID)
- **File ID capture** from upload response (`data._id`) for downloads
- **AES-256-GCM encryption** for CONFIDENTIAL+ documents before upload
- **SHA-256 content hash** verification
- Retry logic with exponential backoff (3 attempts)

**Encryption Strategy**:
| Classification | Pre-Encryption | Iagon Encryption | Total Layers |
|----------------|----------------|------------------|--------------|
| UNCLASSIFIED   | None           | Yes              | 1            |
| CONFIDENTIAL   | AES-256-GCM    | Yes              | 2            |
| SECRET         | AES-256-GCM    | Yes              | 2            |
| TOP_SECRET     | AES-256-GCM    | Yes              | 2            |

**Known Limitation**: Private storage requires Cardano wallet authentication (CIP8 message signing) - not supported via API token. Files stored publicly with application-level encryption.

**Files**:
- `/root/company-admin-portal/lib/IagonStorageClient.js` - API client
- `/root/company-admin-portal/lib/EnterpriseDocumentManager.js` - Document DID + storage
- `/root/company-admin-portal/docs/IAGON_STORAGE_INTEGRATION.md` - Full documentation

**Details**: [Iagon Storage Integration](./company-admin-portal/docs/IAGON_STORAGE_INTEGRATION.md)

---

### ✅ Document Auto-Refresh After Clearance Verification (Dec 6, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Documents automatically refresh after clearance verification

Fixed issue where employees with verified security clearance still only saw UNCLASSIFIED documents. The document list now automatically refreshes after successful clearance verification.

**Root Cause**: `showClearanceSuccess()` function called `loadDocuments()` without the required `profile` parameter, causing early return with "No EmployeeRole VC found".

**Key Fix**:
- Changed `await loadDocuments();` to `await loadDocuments(profile);`
- Profile is already available from the `loadProfile()` call above

**Files Modified**:
- `/root/company-admin-portal/public/js/employee-portal-dashboard.js` (line 437)

**Verification**: bob.johnson with CONFIDENTIAL clearance now sees 5 documents (3 UNCLASSIFIED + 2 CONFIDENTIAL) after verification

---

### ✅ DIDComm Security Clearance VP Parsing Fix (Dec 6, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Clearance level now correctly extracted from VP JWTs

Fixed critical bug in clearance verification where Cloud Agent's VP response format wasn't being parsed correctly. The `presentationData.data` array contains raw VP JWT strings, not objects with `claims` properties.

**Root Cause**: Server expected `presentationData.data[]` to contain objects like `{ claims: { clearanceLevel: "..." } }`, but Cloud Agent returns raw VP JWT strings that need nested JWT parsing.

**Key Fix**:
- VP JWT contains `vp.verifiableCredential[]` array of VC JWTs
- Each VC JWT contains `vc.credentialSubject.clearanceLevel`
- Updated parsing logic to detect JWT strings and decode nested structure
- Backward compatibility maintained for legacy object format

**Technical Implementation**:
- 3-tier JWT parsing: VP JWT → `vp.verifiableCredential[]` → VC JWT → `vc.credentialSubject`
- Base64url decoding of JWT payload sections
- Extracts `clearanceLevel` or `securityLevel` from Security Clearance VC

**Files Modified**:
- `/root/company-admin-portal/server.js` (lines 3064-3122) - VP parsing logic

**Verification**: Security Clearance level now correctly returned (e.g., `CONFIDENTIAL`) instead of `UNKNOWN`

---

### ✅ PRISM DID Key Fallback for Security Clearance VCs (Dec 5, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Keys from PRISM DIDs now work with Security Clearance VCs

Added fallback mechanism to find encryption keys in Pluto (IndexedDB) when not in localStorage. Includes deferred WALLET_READY signal fix for SecureDashboardBridge race condition.

**Key Features**: Two-pass key lookup (localStorage → Pluto), PRISM DID integration, fingerprint matching, deferred WALLET_READY

**Details**: [PRISM DID Key Fallback](./docs/features/PRISM_DID_KEY_FALLBACK.md)

---

### ✅ Holder PRISM DID in Verifiable Credentials (Dec 3, 2025)

**STATUS**: ✅ **PRODUCTION READY** - VCs now include holder's PRISM DID in credentialSubject.id

Modified SDK and wallet to include the holder's PRISM DID in the standard W3C `credentialSubject.id` field when accepting credential offers.

**Key Features**:
- Holder's **PRISM DID** automatically included in `credentialSubject.id` field
- Uses the PRISM DID created during CA connection (stored in connection metadata)
- Standard W3C field - **no schema changes required**
- Falls back to creating new PRISM DID if none associated with connection

**Technical Implementation**:
- Modified SDK `HandleOfferCredential.ts` to accept optional `subjectDID` parameter
- Modified SDK `Agent.ts` to pass `subjectDID` option to `prepareRequestCredentialWithIssuer()`
- Modified wallet `actions/index.ts` to lookup connection's PRISM DID from metadata
- SDK retrieves existing DID's keys from Pluto storage for credential signing

**Files Modified**:
- `src/edge-agent/didcomm/HandleOfferCredential.ts` - Accept optional existing PRISM DID
- `src/edge-agent/didcomm/Agent.ts` - Add subjectDID parameter to API
- `demos/alice-wallet/src/actions/index.ts` - Pass connection PRISM DID when accepting

**Verification**: Issued credentials now contain holder DID in `credentialSubject.id`:
```json
"credentialSubject": {
  "id": "did:prism:be299c1387e9da53...",
  "firstName": "Jan",
  "lastName": "Novak"
}
```

**Details**: [CHANGELOG.md](./CHANGELOG.md)

---

### ✅ CA Connection with Compulsory Name and PRISM DID (Dec 3, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Enhanced CA connection with identity anchoring

Modified "Connect to CA" flow to require user name and automatically create a PRISM DID during connection establishment.

**Key Features**:
- Name field now **compulsory** (connection cannot proceed without name)
- Long-form **PRISM DID created** automatically with name as alias
- PRISM DID **linked to CA connection** via connection metadata
- Progress feedback shows "Creating PRISM DID..." during creation
- Existing connections honored (no duplicate DID creation)

**Technical Implementation**:
- Uses existing `createLongFormPrismDID` action from `actions/index.ts`
- Stores PRISM DID in connection metadata via `saveConnectionMetadata()`
- Long-form PRISM DIDs immediately usable (no blockchain wait)
- No DIDComm services on PRISM DID (Peer DIDs handle routing)

**Files Modified**:
- `src/components/ConnectToCA.tsx` - All changes in this file

**Details**: [CHANGELOG.md](./CHANGELOG.md)

---

### ✅ DID Management Page Improvements (Dec 3, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Enhanced DID management with document resolution and enterprise DIDs

Improved the DID Management page in Alice wallet with enterprise DID loading and full DID document resolution.

**Key Features**:
- Enterprise DIDs loading from Cloud Agent (requires ServiceConfiguration VC)
- DID Document resolution using SDK's `castor.resolveDID()`
- Expandable PRISM DID cards with full DID document display
- Copy functionality for both DID string and JSON document
- Auto-refresh every 30 seconds for both PRISM and Enterprise DIDs
- Type badges (LONG-FORM/SHORT-FORM) and status indicators

**Technical Implementation**:
- `refreshEnterpriseDIDs` async thunk in `enterpriseAgentActions.ts`
- Enhanced `PrismDIDCard` component with DID document resolution
- Proper serialization of DIDDocument objects (verificationMethods, services, authentication, assertionMethod)

**Files Modified**:
- `src/actions/enterpriseAgentActions.ts` - Added `refreshEnterpriseDIDs` action
- `src/pages/did-management.tsx` - Enterprise DID loading and refresh
- `src/components/PrismDIDCard.tsx` - DID document resolution capability

**Details**: [CHANGELOG.md](./CHANGELOG.md)

---

### ✅ Document Creation & Clearance-Based Disclosure (Dec 2, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Employees can create document DIDs with clearance-based access control

Implemented complete document creation workflow allowing employees to register documents with blockchain-anchored DIDs and automatic clearance-based filtering for disclosure control.

**Key Features**:
- Document DID creation via Enterprise Cloud Agent (30-60s blockchain publication)
- 4-level classification hierarchy (UNCLASSIFIED, CONFIDENTIAL, SECRET, TOP_SECRET)
- Clearance-based progressive disclosure (Security Clearance VC required)
- Cross-company releasability filtering (TechCorp, ACME support)
- Zero-knowledge document registry with Bloom filter indexing (1024-bit, 3 hash functions)
- Employee Portal UI for document creation and discovery

**Technical Implementation**:
- `EnterpriseDocumentManager`: DID creation and blockchain publication
- `DocumentRegistry`: In-memory registry with clearance filtering
- Clearance hierarchy enforcement (higher clearance sees lower classified docs)
- Session-based clearance capture from Security Clearance VC

**Testing**: Comprehensive 7-step validation suite confirming clearance hierarchy logic, cross-company filtering, and registry statistics

**Details**: [Document Creation Feature](./docs/features/DOCUMENT_CREATION.md) *(in progress)*

---

### ✅ Cloud Agent v2.1.0 Upgrade (Nov 28, 2025)

**STATUS**: ✅ **PRODUCTION DEPLOYED** - All Cloud Agent instances upgraded to v2.1.0

Upgraded all 4 Hyperledger Identus Cloud Agent instances from v2.0.0 to v2.1.0 with zero downtime.

**Upgraded Instances**:
- Main Cloud Agent (port 8000) ✅ v2.1.0
- Employee Wallet Agent (port 8300) ✅ v2.1.0 - Individual employee wallets
- Enterprise/Company Wallet Agent (port 8200) ✅ v2.1.0 - Company wallets (TechCorp, ACME, EvilCorp)
- Top-Level Issuer Cloud Agent (port 8100) ✅ v2.1.0

**Key v2.1.0 Improvements**:
- Ed25519 key selection fix in proof jobs
- Enhanced DIF Presentation Exchange support
- Improved schema $id URL handling in presentation requests
- Performance optimizations and security updates

**Impact**: Potential fix for proof request creation errors with schema $id URLs (validation pending).

**Details**: [CHANGELOG.md](./CHANGELOG.md)

---

### ✅ Enterprise Credential Offer Base64 Fix (Nov 27, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Base64-encoded credentials now parse correctly

Fixed enterprise credential offer acceptance failure in Alice wallet. Enterprise Cloud Agent 2.0 stores credentials as base64-encoded JWT strings, but parsing logic was missing the base64 decode step.

**Key Fix**:
- Added 3-tier parsing strategy: Base64 decode → JSON.parse → Plain JWT
- Applied to both credential identification and PRISM DID extraction
- Removed verbose diagnostic logs, kept essential error handling

**Impact**: Enterprise credential offers now accepted successfully with correct PRISM DID extraction

**Details**: [Enterprise Credential Offer Base64 Fix](./ENTERPRISE_CREDENTIAL_OFFER_BASE64_FIX.md)

---

### ✅ Enterprise Proof Request Approval Fix (Nov 24, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Fixed wallet compilation and proof request approval errors

Fixed critical bug preventing enterprise proof request approval in Alice wallet. Wallet was sending wrong payload format to Enterprise Cloud Agent, causing 500 errors. Also fixed TypeScript import error in EnterpriseProofRequestPolling component.

**Key Fixes**:
- Changed payload from `{ proof: { credential: "jwt" } }` to `{ proofId: ["record-id"] }`
- Fixed import statement (declinePresentation → declinePresentationRequest)
- Corrected REST API communication vs DIDComm message protocol
- Fixed field name usage (presentationId vs id)

**Impact**: Enterprise proof request approval now works correctly (200 OK instead of 500 error)

**Details**: [Enterprise Proof Request Fix](./ENTERPRISE_PROOF_REQUEST_FIX.md)

---

### ✅ Enterprise Database Security Upgrade (Nov 22, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Critical security improvement eliminating hardcoded passwords

Upgraded Enterprise Cloud Agent database authentication from insecure hardcoded 'dummy' password to cryptographically secure 256-bit password managed via environment variables.

**Security Improvements**:
- No hardcoded passwords in source code
- Fail-fast validation (refuses to start without proper configuration)
- 256-bit entropy secure password
- `.gitignore` protection prevents accidental commits
- Environment variable configuration via `.env` file

**Files Modified**:
- Database password updated (`71e430bef6...` 64-char hex)
- Application code hardened (EmployeeWalletManager, server.js)
- Startup script updated (automatic .env loading)
- Configuration templates created (.env.example)

**Details**: [Enterprise Database Security](./ENTERPRISE_DATABASE_SECURITY.md)

---

### ✅ Employee Portal Authentication System (Nov 20, 2025)

**STATUS**: ✅ **PRODUCTION READY** - Complete employee self-service portal with PRISM DID-based authentication

Comprehensive employee portal allowing PRISM DID authentication via Peer DID-signed Verifiable Presentations, mandatory CIS training completion, and secure dashboard access.

**Key Features**:
- Challenge-response authentication (replay attack prevention)
- Domain binding (phishing prevention)
- Peer DID signatures (wallet control proof)
- PRISM DID extraction from EmployeeRole VC
- Automatic CIS training certificate issuance
- 4-hour session management
- Role-based access control ready

**Performance**: 10-25 second authentication, 100+ test assertions passing

**Details**: [Employee Portal Authentication](./docs/features/EMPLOYEE_PORTAL_AUTHENTICATION.md)

---

### ✅ ServiceConfiguration VC Encryption Fix (Nov 20, 2025)

Fixed critical architectural flaw where enterprise wallet configuration required Security Clearance VC encryption keys. API keys now stored directly in signed ServiceConfiguration VCs - no encryption dependency.

**Impact**: Employee onboarding works immediately without security clearance requirement.

**Details**: [ServiceConfiguration VC Documentation](./docs/features/SERVICE_CONFIG_VC.md)

---

### ✅ Automated Employee Onboarding (Nov 17, 2025)

Fully automated 11-step employee wallet creation: Cloud Agent wallet → PRISM DID publication → DIDComm connection (~35-40 seconds total).

**Performance**: 100% success rate, blockchain publication in ~28 seconds.

**Details**: [Employee Onboarding Guide](./EMPLOYEE_ONBOARDING.md)

---

### ✅ Wallet Context Selector (Nov 15, 2025)

Card-based UI for switching between Personal and Enterprise wallet contexts. Auto-detects ServiceConfiguration VC for Enterprise mode.

**Details**: [Wallet Context Selector](./docs/features/WALLET_CONTEXT_SELECTOR.md) *(doc in progress)*

---

### ✅ Infrastructure Enhancements (Nov 2025)

- **Enterprise/Company Wallet Agent (8200)**: 3-company isolation (TechCorp, ACME, EvilCorp) - credentials ISSUED FROM here - [Details](./MULTITENANCY_TEST_REPORT.md)
- **Employee Wallet Agent (8300)**: Individual employee wallets - credentials ISSUED TO here - [Details](./docs/infrastructure/ENTERPRISE_CLOUD_AGENT.md)
- **Company Admin Portal**: Multi-company management UI - [Details](./docs/features/COMPANY_ADMIN_PORTAL.md)
- **Phase 2 Encryption**: Zero-knowledge content delivery - [Details](./docs/features/PHASE2_ENCRYPTION.md)
- **DIDComm Label Transmission**: Dual-label system for connection identification - [Details](./docs/archive/)
- **HTTPS Migration**: Domain access via `identuslabel.cz` - [Details](./docs/archive/)

---

## Quick Reference

### Service Status & URLs

| Service | URL | Port | Status |
|---------|-----|------|--------|
| **Alice Wallet** | https://identuslabel.cz/alice | 3001 | ✅ Primary Wallet |
| **Certification Authority** | https://identuslabel.cz/ca | 3005 | ✅ Operational |
| **Secure Information Portal** | https://identuslabel.cz/ca/dashboard | 3005 | ✅ Phase 2 Encryption |
| **Cloud Agent (Main)** | https://identuslabel.cz/cloud-agent | 8000 | ✅ Operational |
| **Enterprise/Company Wallet Agent** | Internal: http://91.99.4.54:8200 | 8200 | ✅ Company wallets - Credentials ISSUED FROM |
| **Employee Wallet Agent** | https://identuslabel.cz/enterprise | 8300 | ✅ Employee wallets - Credentials ISSUED TO |
| **Company Admin Portal** | https://identuslabel.cz/company-admin | 3010 | ✅ Operational |
| **Mediator** | https://identuslabel.cz/mediator | 8080 | ✅ Operational |
| **PRISM Node (gRPC)** | 91.99.4.54:50053 | 50053 | ✅ Operational |

**Note**: Bob wallet decommissioned November 9, 2025. Alice wallet is the sole active development wallet.

---

### Infrastructure Architecture

```
VDR/PRISM Node (50053)
         ↑
         |
    ┌────┴─────────────────┐
    |                      |
CA (3005) ←→ Cloud Agent (8000) ←→ Mediator (8080)
    ↓                      ↓
Secure Portal       Alice Wallet (3001)
                   [Personal | Enterprise]

Enterprise/Company Wallet Agent (8200)    Employee Wallet Agent (8300)
├── TechCorp (issues VCs FROM)            ├── Individual employees
├── ACME (issues VCs FROM)                │   (receive VCs TO)
└── EvilCorp (issues VCs FROM)            └── Created via automated onboarding

Company Admin Portal (3010)
└── Multi-company management UI
```

---

## Getting Started

### Quick Start Commands

```bash
# 1. Start mediator (includes MongoDB)
cd /root/identus-mediator && docker-compose up -d

# 2. Start Cloud Agent (includes PostgreSQL)
cd /root && docker-compose -f cloud-agent-with-reverse-proxy.yml up -d

# 3. Start Enterprise Cloud Agent
cd /root && docker-compose -f enterprise-cloud-agent.yml up -d

# 4. Start Multitenancy Cloud Agent
cd /root && docker-compose -f test-multitenancy-cloud-agent.yml up -d

# 5. Start PRISM Node
cd /root && docker-compose -f local-prism-node-addon.yml up -d

# 6. Start Caddy Reverse Proxy
pkill caddy
/usr/local/bin/caddy run --config /root/Caddyfile > /tmp/caddy.log 2>&1 &

# 7. Start Certification Authority
cd /root/certification-authority && PORT=3005 node server.js > /tmp/ca.log 2>&1 &

# 8. Start Company Admin Portal
cd /root/company-admin-portal && PORT=3010 node server.js > /tmp/company-admin.log 2>&1 &

# 9. Start Alice Wallet
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
fuser -k 3001/tcp && rm -rf .next
yarn dev > /tmp/alice.log 2>&1 &
```

### Health Checks

```bash
curl https://identuslabel.cz/_system/health              # Cloud Agent
curl https://identuslabel.cz/enterprise/_system/health   # Enterprise Agent
curl http://91.99.4.54:8200/_system/health               # Multitenancy Agent
curl https://identuslabel.cz/mediator/                   # Mediator
curl https://identuslabel.cz/ca/api/health               # CA
curl https://identuslabel.cz/company-admin/api/health    # Company Admin
curl -I https://identuslabel.cz/alice/                   # Alice Wallet
```

**Complete Setup Guide**: *(Documentation in progress - see archived CLAUDE.md)*

---

## Core Features

### DIDComm Connections
Create secure peer-to-peer connections using out-of-band invitations with RFC 0434 compliance.

### Verifiable Credentials
Issue, receive, and verify W3C Verifiable Credentials with StatusList2021 revocation support.

### StatusList2021 Revocation
Asynchronous credential revocation with eventual consistency (30min-hours delay by design).

**Details**: [StatusList2021 Architecture](./docs/infrastructure/STATUSLIST2021_ARCHITECTURE.md)

### Secure Dashboard
Phase 2 client-side encryption with clearance-based progressive disclosure and X25519 key agreement.

### Enterprise Wallets
ServiceConfiguration VCs enable enterprise mode with Cloud Agent integration for company-managed credentials.

**User Workflows**: *(Documentation in progress)*

**API Reference**: *(Documentation in progress)*

---

## Documentation Index

### 📚 Guides *(In Progress)*
- **User Guide** - End-user workflows (DIDComm, credentials, verification)
- **Developer Guide** - SDK development, wallet customization, testing
- **API Reference** - Complete API documentation for all services
- **Configuration Guide** - All configuration options and environment variables
- **Deployment Guide** - Production deployment best practices

### 🏗️ Infrastructure
- [Cloud Agent Setup](./docs/infrastructure/) *(See archived CLAUDE.md)*
- [Multitenancy Setup](./docs/infrastructure/MULTITENANCY_SETUP.md)
- [Enterprise Cloud Agent](./docs/infrastructure/ENTERPRISE_CLOUD_AGENT.md)
- [StatusList2021 Architecture](./docs/infrastructure/STATUSLIST2021_ARCHITECTURE.md)
- [Mediator Setup](./docs/infrastructure/) *(See archived CLAUDE.md)*
- [PRISM Node Setup](./docs/infrastructure/) *(See archived CLAUDE.md)*

### ✨ Features
- [PRISM DID Key Fallback](./docs/features/PRISM_DID_KEY_FALLBACK.md) - Two-pass key lookup with Pluto fallback
- [Employee Onboarding](./EMPLOYEE_ONBOARDING.md) - Automated wallet creation (11 steps)
- [Wallet Context Selector](./docs/features/WALLET_CONTEXT_SELECTOR.md) - Personal/Enterprise mode *(in progress)*
- [ServiceConfiguration VC](./docs/features/SERVICE_CONFIG_VC.md) - Enterprise wallet configuration fix
- [Company Admin Portal](./docs/features/COMPANY_ADMIN_PORTAL.md) - Multi-company management
- [Phase 2 Encryption](./docs/features/PHASE2_ENCRYPTION.md) - Zero-knowledge content delivery

### 🔧 Troubleshooting *(In Progress)*
- **Common Issues** - Symptoms, causes, and solutions
- **Diagnostic Commands** - Debugging tools and monitoring
- **Known Issues** - Current limitations (see below)

### 🔒 Security *(In Progress)*
- **Security Overview** - Current security posture and compliance
- **Key Management** - Ed25519/X25519 key generation and storage
- **Encryption Guide** - Client-side encryption implementation

### 📖 Reference *(See Archived CLAUDE.md)*
- **File Locations** - Project structure and configuration files
- **Glossary** - SSI terminology (DIDComm, VC, VP, OOB, etc.)
- **Configuration Options** - All settings and environment variables
- **Standards Compliance** - W3C/DIDComm/Hyperledger standards

### 📦 Archive
- [Historical Fixes](./docs/archive/) - Completed implementations (Oct-Nov 2025)
- [Multitenancy Test Report](./MULTITENANCY_TEST_REPORT.md) - Validation results
- [Archived CLAUDE.md v5](./docs/archive/CLAUDE_MD_V5_ARCHIVED_20251120.md) - Previous comprehensive documentation

---

## Known Issues

| Issue | Impact | Status | Workaround |
|-------|--------|--------|------------|
| Browser cache persistence | Updates not appearing | 🔴 High | Hard refresh (Ctrl+Shift+R) |
| Cloud Agent long-form PRISM DID validation | Custom holder DID rejected in credential requests | 🟡 Medium | **Workaround active** - SDK creates internal DIDs |
| WebAssembly memory accumulation | Periodic refresh needed | 🟡 Low | Refresh when wallet slows |
| SDK deployment requirement | SDK changes need manual copy | 🟡 Low | Copy build to `node_modules` after SDK changes |
| StatusList revocation delay | Revoked credentials appear valid for 30min-hours | 🟡 Low | **By design** - eventual consistency model |

**Known Behaviors (Not Bugs)**:
- **Asynchronous revocation processing**: StatusList bitstring updates delayed 30 minutes to several hours after revocation API call (intentional architecture for performance optimization)
- **DIDComm invitation immutability**: Invitation URLs contain embedded service endpoints - always create fresh invitations after configuration changes

**Complete List**: *(Documentation in progress)*

---

## Support

### Quick Troubleshooting Steps

1. **Check Service Status**: Run health checks (see [Quick Start](#quick-start-commands))
2. **Check Logs**:
   ```bash
   tail -f /tmp/alice.log         # Alice Wallet
   tail -f /tmp/ca.log             # Certification Authority
   docker logs identus-mediator-identus-mediator-1 --tail 100
   ```
3. **Common Issues**: *(See archived CLAUDE.md for detailed troubleshooting)*
4. **Hard Refresh**: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)

### Resources

- **Development History**: [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md) - Complete project evolution
- **Archived Documentation**: [v5 CLAUDE.md](./docs/archive/CLAUDE_MD_V5_ARCHIVED_20251120.md) - Full previous documentation
- **External Resources**:
  - Hyperledger Identus: https://docs.atalaprism.io/
  - W3C VC Data Model: https://www.w3.org/TR/vc-data-model/
  - DIDComm v2: https://identity.foundation/didcomm-messaging/spec/

### Hard Refresh Required

Users must hard refresh after SDK updates or major changes to clear browser cache.

### HTTPS Migration

All services now use `https://identuslabel.cz` domain. Replace any hardcoded IP addresses with domain URLs.

---

## Security

### Current Security Posture

**Status**: 🟢 **FULLY SECURED**

- ✅ Cryptocurrency malware eliminated (Oct 2025)
- ✅ fail2ban SSH protection active
- ✅ No unauthorized accounts
- ✅ Mediator service healthy
- ✅ Ed25519 client-side key generation
- ✅ X25519 client-side encryption/decryption
- ✅ Private keys never transmitted to CA
- ✅ SDK attachment validation hardened
- ✅ Phase 2 zero-knowledge content delivery
- ✅ HTTPS/TLS for all public endpoints
- ✅ Let's Encrypt automatic SSL certificate renewal

### Standards Compliance

- ✅ W3C Verifiable Credentials Data Model 1.0
- ✅ W3C Decentralized Identifiers (DIDs) v1.0
- ✅ W3C StatusList2021 (Bitstring Status List)
- ✅ DIDComm Messaging v2.0 (RFC 0434)
- ✅ Hyperledger Identus SDK v6.6.0 (with custom fixes)
- ✅ X25519 Elliptic Curve Diffie-Hellman (RFC 7748)
- ✅ XSalsa20-Poly1305 Authenticated Encryption (NaCl/libsodium)
- ✅ Browser postMessage API (WHATWG HTML Living Standard)

**Complete Security Documentation**: *(In progress)*

---

## Glossary (Quick Reference)

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
| **StatusList2021** | W3C standard for credential revocation using compressed bitstrings |
| **ServiceConfiguration VC** | Credential containing enterprise wallet configuration (API keys, endpoints) |

**Complete Glossary**: *(Documentation in progress)*

---

## Documentation Reorganization Notice

**Date**: November 20, 2025

This documentation has been reorganized to improve maintainability and AI performance. Previous comprehensive documentation (1,211 lines) has been archived and replaced with this navigation hub (~400 lines - 67% reduction).

**Archived Documentation**: [CLAUDE_MD_V5_ARCHIVED_20251120.md](./docs/archive/CLAUDE_MD_V5_ARCHIVED_20251120.md)

**Progressive Extraction**: Detailed documentation is being extracted to specialized files in `/root/docs/`. Until extraction is complete, refer to archived CLAUDE.md for comprehensive information.

**Status**: See [REORGANIZATION_COMPLETE.md](./docs/REORGANIZATION_COMPLETE.md) for implementation progress.

---

**Document Version**: 6.10 (Jan 7, 2026 - Security Clearance Level Standardization)
**Last Updated**: 2026-01-07
**Status**: Production-Ready - Streamlined for AI Performance
**File Size**: ~750 lines (with detailed feature docs in subdocuments)
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
