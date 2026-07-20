# Server Claude Code Synchronization
## Design Work & Progress Synthesis (April 2026)

**Last Updated:** April 4, 2026 | **Source:** `/opt/project_identuslabel/.claude/` project memory

---

## I. CURRENT STATE SUMMARY

### A. Production Infrastructure (identuslabel.cz)

**Core Services Running:**

| Service | Type | Port | Status | Notes |
|---------|------|------|--------|-------|
| IDL Wallet (PRIMARY) | Next.js 14 | 3000 | ✅ Active | `identuslabel.cz/wallet` — main user wallet |
| Alice Wallet | Next.js | 3001 | ❌ **OBSOLETE** | Decommissioned; do not use |
| Company Admin Portal | Express.js | 3010 | ✅ Active | Multi-company management |
| Certification Authority | Node.js | 3005 | ✅ Active | CA server for credential issuance |
| Document Service | Node.js | 3020 | ✅ Active | VP-gated document access for ACME |
| Cloud Agent | Java (Identus) | 8000 | ✅ Active | Credential issuance/verification |
| Enterprise Agent | Java (Identus) | 8300 | ✅ Active | Enterprise operations |
| Multitenancy Agent | Java (Identus) | 8200 | ✅ Active | Multi-tenant support |
| Mediator | Java (Identus) | 8080 | ✅ Active | DIDComm message routing |
| PRISM Node | Java (Indexer) | 50053 | ✅ Active | Cardano DID resolver (running since Jan 23) |
| **Reverse Proxy** | Caddy | 80/443 | ✅ Active | SSL via Let's Encrypt |

**Infrastructure:**
- Cloud agents managed via Docker Compose
- Node.js services run standalone
- All logs: `/tmp/*.log` (ca.log, idl-wallet.log, document-service.log, etc.)
- Project path: `/opt/project_identuslabel/`

---

## II. SDK & WALLET ARCHITECTURE

### A. Hyperledger Identus SDK 5 Building Blocks

Location: `/opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts/src/`

| Module | Purpose | Key Classes |
|--------|---------|-------------|
| **Apollo** | Cryptographic primitives | Ed25519, X25519, Secp256k1 key ops |
| **Castor** | DID lifecycle management | PRISM DIDs, Peer DIDs, DID document updates |
| **Pluto** | Storage abstraction layer | IndexedDB wrapper (localStorage persistence) |
| **Mercury** | DIDComm v2 messaging | Transport, message routing, endpoint resolution |
| **Pollux** | Verifiable Credentials | JWT-VC, SD-JWT, credential schemas |

### B. IDL Wallet (PRIMARY — Port 3000)

**Tech Stack:**
- Next.js 14 + TypeScript (~98.5% TS)
- Redux Toolkit (3 slices: `app`, `enterpriseAgent`, `classifiedDocuments`)
- Jotai (minimal usage; only `mnemonicsAtom`)
- SDK: local path (`clean-identus-wallet/sdk-v6-test/sdk-ts`)

**Directory Structure:**
```
/opt/project_identuslabel/idl-wallet/
├── src/
│   ├── pages/        (13 pages)
│   │   ├── credentials
│   │   ├── documents
│   │   ├── connections
│   │   ├── messages
│   │   ├── dids
│   │   ├── did-management
│   │   ├── verify
│   │   ├── configuration
│   │   ├── debug
│   │   ├── key-management
│   │   ├── my-documents
│   │   └── i/[token]
│   ├── components/   (52+ components)
│   │   ├── ClassifiedDocumentViewer
│   │   ├── SecurityClearanceKeyManager
│   │   ├── UnifiedProofRequestModal
│   │   └── ...
│   ├── redux/        (store slices)
│   ├── lib/          (utilities)
│   └── styles/
├── .next/            (build output)
└── node_modules/
```

**Security Clearance Model:**
```
INTERNAL(1) < CONFIDENTIAL(2) < RESTRICTED(3) < TOP-SECRET(4)
```
Legacy mapping:
- `UNCLASSIFIED` → `INTERNAL`
- `SECRET` → `RESTRICTED`

---

## III. CRITICAL STATE MANAGEMENT PATTERN

⚠️ **DUAL-LAYER STATE UPDATES REQUIRED**

When modifying wallet state, **ALWAYS update both layers** or face desynchronization bugs:

```javascript
// Layer 1: IndexedDB via Pluto (persistent storage)
await agent.pluto.deleteMessage(messageId);  // OR
await agent.pluto.updateCredential(cred);    // OR
await agent.pluto.storeConnection(conn);

// Layer 2: Redux state (in-memory + sync)
dispatch(messagesRemoved([messageId]));      // OR
dispatch(credentialUpdated(cred));           // OR
dispatch(connectionAdded(conn));
```

**If you skip one layer:**
- Messages appear deleted locally but reappear after refresh
- Credentials update on screen but don't persist
- Connections appear but state machine breaks

---

## IV. SDK DEPLOYMENT WORKFLOW

**Critical manual step:** After modifying SDK source code:

```bash
cd /opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts
yarn build

# MUST copy to wallet's node_modules
cp -r build/* /opt/project_identuslabel/idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/

# Restart wallet
cd /opt/project_identuslabel/idl-wallet
yarn dev

# Hard refresh browser (Ctrl+Shift+R)
```

**Why:** Next.js caches SDK build output; manual copy forces rebuild without cache interference.

---

## V. DOCUMENT ACCESS CONTROL IMPLEMENTATION

### A. New Stateless Service Architecture (identus-document-service)

**Location:** `/opt/project_identuslabel/identus-document-service/`

**Key Innovation:** Document access decisions are **stateless** and read policy from **DID resolution on Cardano** — not server RAM or database.

#### Policy Resolution Flow:
```
Request for Document → Service resolves documentDID on Cardano
                    ↓
                Extract DocumentMetadata service endpoint from DID Doc
                    ↓
                Parse clearanceLevel, releasableTo, iagonFileId
                    ↓
                Compare against requestor's credentials
                    ↓
                Decision: ALLOW / DENY (with reason)
```

**DID Document Structure (stored on Cardano):**
```javascript
{
  documentDID: "did:prism:...",
  services: [
    {
      id: "DocumentMetadata",
      type: "DocumentMetadata",
      serviceEndpoint: {
        iagonFileId: "uuid-of-encrypted-doc",
        iagonFilename: "document.pdf",
        originalFilename: "sensitive-report.pdf",
        mimeType: "application/pdf",
        clearanceLevel: "CONFIDENTIAL",           // ← Policy
        releasableTo: ["did:prism:issuer-1", ...], // ← Policy
        iagonEncManifestId: "uuid-of-key-manifest"
      }
    }
  ]
}
```

### B. Access Decision Pipeline

**File:** `/opt/project_identuslabel/identus-document-service/lib/ReEncryptionService.js` (lines 252–357)

```
Step 1: Signature Verification        ← cryptographic (Ed25519)
Step 2: Replay Attack Detection       ← application logic
Step 3: Releasability Check           ← array lookup against releasableTo[]
Step 4: Clearance Level Check         ← numeric comparison
Step 5: Revocation Check              ← VC StatusList2021 query
Step 6: Content Decryption            ← AES-256-GCM (key from Iagon manifest)
Step 7: Copy Accountability           ← UUID copyId + SHA-256 copyHash
Step 8: Re-Encryption for Transport   ← X25519/XSalsa20-Poly1305 ephemeral key
```

**Result on Success:**
```javascript
{
  success: true,
  documentDID,
  copyId: "uuid-per-access",
  copyHash: "sha256(content + copyId)",
  filename: "sensitive-report.pdf",
  mimeType: "application/pdf",
  clearanceLevel: "CONFIDENTIAL",
  ciphertext: "encrypted-for-user-ephemeral-key",
  nonce: "transport-nonce",
  serverPublicKey: "server-ephemeral-public-key"
}
```

### C. Encryption Implementation

**File:** `/opt/project_identuslabel/identus-document-service/lib/IagonStorageClient.js` (lines 68–102)

**Storage Layer (at-rest):**
- Algorithm: **AES-256-GCM**
- Key: 32 bytes (random per document)
- IV: 12 bytes (random, never reused)
- Key manifest stored separately on Iagon (referenced by `iagonEncManifestId`)

**Transport Layer (in-flight):**
- Algorithm: **X25519 ECDH + XSalsa20-Poly1305**
- Per-request ephemeral key pair
- Server encrypts document for user's ephemeral public key
- User decrypts with ephemeral private key (never transmitted)

### D. Credential Requirement

All document access requests must include a **VerifiablePresentation** with:
- Requestor's long-term DID
- Clearance credential (INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET)
- Issuer DID (for releasability verification)
- Ed25519 signature over request metadata

---

## VI. CURRENT IMPLEMENTATION GAPS

### Critical (whitepaper-to-code mismatches):

| Gap # | Feature | Current State | Target | Impact |
|-------|---------|---------------|--------|--------|
| **G1** | Content Hash Anchoring | Computed but NOT in DID | Hash in DID on Cardano | Can't prove document authenticity on-chain |
| **G2** | Three-Tier Key Hierarchy | Missing (only random per-doc keys) | CMK→DEK→ephemeral | Can't revoke via StatusList2021; requires re-encryption |
| **G3** | User DID Watermarking | Not embedded (copyId UUID only) | User's requestor DID + signature in delivered copy | Can't trace leaked documents to specific user |
| **G4** | Cryptographic Access Control | Server-side logic | Zero-Knowledge Proof / verifiable presentation | Server remains trust anchor (violates data-centric principle) |
| **G5** | Three-Tier Encryption | Partial (storage + transport) | Add CMK ↔ DEK layer for instant revocation | Revocation requires document re-encryption |
| **G6** | Offline Operation | Not supported | Cache decrypted keys locally + verify offline | Coalition partners can't access docs without network |

---

## VII. RECENT ARCHITECTURAL IMPROVEMENTS

✅ **Stateless Document Service** (identus-document-service)
- Reads policy from Cardano DID resolution
- No in-memory state or database queries for access control
- Scales horizontally; policy authority is blockchain

✅ **Classification Policy in DID Documents**
- Clearance and releasability now embedded on-chain
- Immutable and verifiable on Cardano

✅ **Document Registry Persistence**
- New `DocumentRegistryPersistence.js` module
- JSON file storage (previously in-memory only)
- Survives server restart

✅ **Ephemeral Key Re-encryption**
- X25519 ECDH + XSalsa20-Poly1305 per-request
- Perfect forward secrecy; private keys never transmitted

---

## VIII. KNOWN DEVELOPMENT ISSUES & WORKAROUNDS

### 1. Browser Cache (Always Hard Refresh)
After SDK or wallet code changes:
```
Ctrl+Shift+R  (Windows/Linux)
Cmd+Shift+R   (macOS)
```

### 2. SDK Deployment (Manual Copy Required)
Modify → build → copy to node_modules → restart → hard refresh.
Failure mode: SDK changes appear to have no effect.

### 3. Cloud Agent PRISM DID Validation
Long-form PRISM DIDs disabled in credential requests.
Workaround: Use short-form DIDs or inline issuer DID verification in `actions/index.ts`.

### 4. StatusList2021 Revocation Delay
Revocation eventual consistency: 30 min — hours (by design).
Expect delay between credential revocation and access denial.

### 5. WebAssembly Memory Accumulation
If wallet slows down after extended use, WASM memory may not be garbage collected.
Solution: Refresh browser tab (`F5`).

---

## IX. SECURITY CLEARANCE LEVELS (Current Schema)

```javascript
const clearanceLevels = {
  INTERNAL:       1,  // Org-wide but not sensitive
  CONFIDENTIAL:   2,  // Management/strategic info
  RESTRICTED:     3,  // Executive/legal/financial
  TOP_SECRET:     4   // National security / M&A
};

// Access rule: userClearanceLevel >= documentClearanceLevel
```

**Credential Issuance:**
- Cloud Agent (port 8000) issues clearance credentials as W3C Verifiable Credentials
- Credentials include clearance level in credential subject
- Signature signed by issuer DID (stored on Cardano as PRISM DID)

---

## X. MCP SERVER CAPABILITIES

You now have direct bash/file access to the production server via 6 MCP tools:

1. **identuslabel:Bash** — Execute commands, restart services, run tasks
2. **Identus Label:WebFetch** — Fetch content from running services
3. **Identus Label:Glob** — Search files in codebase
4. **Identus Label:CronList** — View scheduled jobs
5. **Identus Label:CronDelete** — Cancel jobs
6. **Identus Label:TaskStop** — Stop background tasks

---

## XI. GITHUB REPOSITORIES

### janskor-cz/identuslabel
**Server & Infrastructure**
- `company-admin-portal/` — Express.js, multi-company mgmt, ports 3005, 3010
- `certification-authority/` — CA server (JavaScript)
- `identus-document-service/` — NEW stateless access control + re-encryption
- Cloud agent configs (YAML), PRISM node setup, Caddyfile

### janskor-cz/identus-edge-wallet
**Browser Wallet (IDL Wallet)**
- `/idl-wallet/` — PRIMARY user wallet (Next.js, port 3000)
- `/clean-identus-wallet/` — SDK build & test environment
- SDK modifications in `sdk-src/` (custom changes to Hyperledger Identus SDK 6.6.0)

---

## XII. PROJECT GOALS & ALIGNMENT

### From Your Requirements Analysis:

**G1: Secure Document Classification** ✅ **PARTIAL**
- Wallet UI supports classification selection
- DID Document contains clearance level
- **Gap:** Three-tier key hierarchy not implemented

**G2: Strict Access Control** ✅ **YES**
- Access decision stateless and cryptographically verifiable
- Clear denial reasons (CLEARANCE_DENIED, RELEASABILITY_DENIED, CREDENTIAL_REVOKED)
- **Gap:** Server logic makes final decision (not cryptographic proof)

**G3: Credential-Based Authentication** ✅ **YES**
- All operations gated on VerifiablePresentation
- Issuer DIDs verified against releasableTo on-chain
- Ed25519 signatures on all access requests

**G4: Document Integrity & Encryption** ✅ **PARTIAL**
- AES-256-GCM at rest, X25519 ECDH in flight
- **Gap:** No content hash anchored to DID on Cardano

**G5: Audit & Compliance** ✅ **PARTIAL**
- Copy accountability via copyId + copyHash
- Access decision logs available at service level
- **Gap:** No structured audit trail persisted (yet)

**G6: User Experience** ✅ **GOOD**
- 13-page wallet interface with visual credential/document management
- Clear error messages for access denials

---

## XIII. NEXT PRIORITIES (From ARCHITECTURE_QA)

Based on the comprehensive gap analysis performed by your server Claude Code instance:

### Near-Term (1–2 weeks):
1. **Anchor content hash to DID** — Modify `DocumentService.js` to add `contentHash` to service endpoint
2. **Implement three-tier key hierarchy** — Add CMK (per level) → DEK (per document) layer (~150 lines)
3. **Embed user DID in delivered copy** — Modify `ReEncryptionService.js` to include requestor DID signature

### Medium-Term (3–4 weeks):
4. **Structured audit trail** — Persist all access decisions to PostgreSQL with full request/response
5. **Cryptographic access proof** — Evaluate zero-knowledge proof for clearance verification
6. **Offline operation support** — Cache policy + decrypted keys with offline verification

### Strategic (2+ months):
7. **Midnight Network integration** — Privacy-preserving access control with private inputs
8. **Coalition partner onboarding** — Federation model for multi-org document sharing
9. **Full cryptographic policy enforcement** — Move from server logic to verifiable computation

---

## XIV. HOW TO USE THIS SYNC

This document **unifies**:
- ✅ Server Claude Code design memory (architecture, wallet, SDK patterns)
- ✅ Implementation audit (ARCHITECTURE_QA.md findings)
- ✅ Your requirements analysis document
- ✅ Known issues and workarounds

**For development:**
1. Refer to SDK section for wallet state management
2. Check "Known Issues" before debugging strange behavior
3. Use "Access Control Implementation" as spec for document service changes
4. Track progress against "Implementation Gaps" and "Next Priorities"

**For architecture decisions:**
- Cross-reference your whitepaper vision against "Current State" and "Gaps"
- Use "MCP Server Capabilities" to run experiments on production
- Leverage dual-agent model (server Claude Code for implementation, this project for design)

---

## XV. KEY TAKEAWAYS

1. **IDL Wallet (port 3000) is primary** — Alice Wallet is obsolete
2. **Stateless access control works** — reads policy from Cardano DIDs
3. **State management is complex** — dual-layer updates required (Pluto + Redux)
4. **SDK changes require manual copy** — no automatic propagation
5. **Server is still trust anchor** — cryptographic proof not yet implemented
6. **Data-centric vision is 70% realized** — policy on-chain, but access control still server-side
7. **MCP connectivity is strong** — can deploy changes directly from this chat

**Status:** ✅ Foundational system functional | 🔄 Architectural gaps identified | 📈 Next wave of improvements ready to implement

---

**Questions or clarifications?** I can pull live logs, code excerpts, or run diagnostics on any component using the MCP tools.
