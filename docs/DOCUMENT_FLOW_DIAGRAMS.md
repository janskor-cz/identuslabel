# Document Process Flow Diagrams

This document describes the complete process flows for document creation and access in the Hyperledger Identus SSI Infrastructure.

## Overview

Two main flows are documented:
1. **Document Creation Flow** - DOCX with multiple security levels → encryption → decentralized storage
2. **Document Access Flow** - Request → verification → decryption → user reads document

---

## Flow 1: Document Creation (DOCX Upload with Multi-Level Security)

### Actors
- **Employee** - Uploads document via Employee Portal Dashboard
- **Enterprise Server** - company-admin-portal (port 3010)
- **Iagon** - Decentralized storage node
- **Blockchain** - PRISM Node for DID publication

### Prerequisites
- Employee has: RealPerson VC, Security Clearance VC, EmployeeRole VC
- Employee is authenticated (session active)

### Process Flow

```
EMPLOYEE                    ENTERPRISE SERVER                      IAGON / BLOCKCHAIN
   │                              │                                      │
   │  1. Upload DOCX file         │                                      │
   │  (multer middleware)         │                                      │
   ├─────────────────────────────►│                                      │
   │                              │                                      │
   │                              │  2. parseDocxClearanceSections()     │
   │                              │     └── loadStyleDefinitions()       │
   │                              │     └── findStyledParagraphs()       │
   │                              │     └── findInlineStyledText()       │
   │                              │     └── extractSDTSection()          │
   │                              │     └── determineOverallClassification() │
   │                              │                                      │
   │                              │  3. For each clearance level section:│
   │                              │     └── encryptContent() [AES-256-GCM]│
   │                              │         - INTERNAL: no pre-encryption│
   │                              │         - CONFIDENTIAL+: AES-256-GCM │
   │                              │                                      │
   │                              │  4. uploadFile()                     │
   │                              ├─────────────────────────────────────►│
   │                              │     └── POST /storage/upload         │
   │                              │     └── Returns fileId               │
   │                              │◄─────────────────────────────────────┤
   │                              │                                      │
   │                              │  5. Create Document PRISM DID        │
   │                              │     └── EnterpriseDocumentManager    │
   │                              │         .createDocumentDID()         │
   │                              ├─────────────────────────────────────►│
   │                              │     └── Publish to blockchain        │
   │                              │     └── serviceEndpoint = Iagon URL  │
   │                              │◄─────────────────────────────────────┤
   │                              │                                      │
   │                              │  6. DocumentRegistry.registerDocument()│
   │                              │     └── Store metadata in-memory     │
   │                              │     └── Bloom filter indexing        │
   │                              │                                      │
   │                              │  7. Issue DocumentMetadataVC         │
   │                              │     └── DIDComm to employee wallet   │
   │                              │     └── automaticIssuance: true      │
   │                              │                                      │
   │  8. Success response         │                                      │
   │◄─────────────────────────────┤                                      │
   │     documentDID, iagonUrl    │                                      │
   │                              │                                      │
```

### Key Functions (Document Creation)

| Step | Function | Location | Purpose |
|------|----------|----------|---------|
| 2a | `parseDocxClearanceSections()` | DocxClearanceParser.js | Parse DOCX, extract sections by clearance style |
| 2b | `loadStyleDefinitions()` | DocxClearanceParser.js | Map Word styles to clearance levels |
| 2c | `findStyledParagraphs()` | DocxClearanceParser.js | Find paragraphs with clearance paragraph styles |
| 2d | `findInlineStyledText()` | DocxClearanceParser.js | Find inline text with character styles |
| 2e | `getClearanceFromStyle()` | DocxClearanceParser.js | Map style name → INTERNAL/CONFIDENTIAL/RESTRICTED/TOP-SECRET |
| 2f | `determineOverallClassification()` | DocxClearanceParser.js | Get lowest clearance level in document |
| 3 | `encryptContent()` | IagonStorageClient.js | AES-256-GCM encryption for CONFIDENTIAL+ |
| 4 | `uploadFile()` | IagonStorageClient.js | Upload to Iagon decentralized storage |
| 5 | `createDocumentDID()` | EnterpriseDocumentManager.js | Create PRISM DID with Iagon URL in serviceEndpoint |
| 6 | `registerDocument()` | DocumentRegistry.js | Store in in-memory registry with Bloom filter |
| 7 | `issueDocumentMetadataVC()` | DocumentMetadataVC.js | Issue VC via DIDComm |

### Encryption Layers

| Classification | Pre-Encryption (App) | Iagon Encryption | Total Layers |
|----------------|---------------------|------------------|--------------|
| INTERNAL | None | Yes | 1 |
| CONFIDENTIAL | AES-256-GCM | Yes | 2 |
| RESTRICTED | AES-256-GCM | Yes | 2 |
| TOP-SECRET | AES-256-GCM | Yes | 2 |

### DOCX Clearance Style Mapping

Documents use Microsoft Word paragraph/character styles to mark classified content:

| Style Name | Clearance Level |
|------------|-----------------|
| Internal, Public | INTERNAL (Level 1) |
| Confidential | CONFIDENTIAL (Level 2) |
| Restricted | RESTRICTED (Level 3) |
| TopSecret, Top-Secret | TOP-SECRET (Level 4) |

---

## Flow 2: Document Access (Request → Decrypt → Read)

### Actors
- **Employee** - Requests document via Employee Portal Dashboard
- **Wallet** - IDL Wallet or Alice Wallet (browser)
- **Enterprise Server** - company-admin-portal (port 3010)
- **Iagon** - Decentralized storage node

### Prerequisites
- Employee has: RealPerson VC, Security Clearance VC (with clearance level), EmployeeRole VC
- Employee session authenticated
- Document exists in DocumentRegistry

### Process Flow

```
EMPLOYEE PORTAL          WALLET (Browser)           ENTERPRISE SERVER              IAGON
      │                       │                            │                          │
      │  1. Click "View"      │                            │                          │
      │  on document          │                            │                          │
      │                       │                            │                          │
      │  2. window.open()     │                            │                          │
      │  to wallet URL        │                            │                          │
      ├──────────────────────►│                            │                          │
      │                       │                            │                          │
      │  3. WALLET_READY      │                            │                          │
      │◄──────────────────────┤                            │                          │
      │   (postMessage)       │                            │                          │
      │                       │                            │                          │
      │  4. DOCUMENT_ACCESS   │                            │                          │
      │     _REQUEST          │                            │                          │
      ├──────────────────────►│                            │                          │
      │   documentDID,        │                            │                          │
      │   clearanceLevel,     │                            │                          │
      │   sessionToken        │                            │                          │
      │                       │                            │                          │
      │                       │  5. Generate ephemeral     │                          │
      │                       │     X25519 keypair         │                          │
      │                       │     (perfect forward       │                          │
      │                       │      secrecy)              │                          │
      │                       │                            │                          │
      │                       │  6. Get Ed25519 key        │                          │
      │                       │     from Pluto/localStorage│                          │
      │                       │                            │                          │
      │                       │  7. Sign access request    │                          │
      │                       │     (Ed25519 signature)    │                          │
      │                       │                            │                          │
      │                       │  8. POST /api/ephemeral-   │                          │
      │                       │     documents/access       │                          │
      │                       ├───────────────────────────►│                          │
      │                       │     documentDID,           │                          │
      │                       │     requestorDID,          │                          │
      │                       │     issuerDID,             │                          │
      │                       │     clearanceLevel,        │                          │
      │                       │     ephemeralPublicKey,    │                          │
      │                       │     signature, nonce       │                          │
      │                       │                            │                          │
      │                       │                            │  9. verifySignature()    │
      │                       │                            │     - Ed25519 verify     │
      │                       │                            │     - Timestamp check    │
      │                       │                            │                          │
      │                       │                            │  10. checkReplay()       │
      │                       │                            │      - Nonce uniqueness  │
      │                       │                            │                          │
      │                       │                            │  11. DocumentRegistry    │
      │                       │                            │      .get(documentDID)   │
      │                       │                            │                          │
      │                       │                            │  12. Check releasability │
      │                       │                            │      issuerDID in        │
      │                       │                            │      releasableTo[]      │
      │                       │                            │                          │
      │                       │                            │  13. Check clearance     │
      │                       │                            │      userLevel >=        │
      │                       │                            │      docLevel            │
      │                       │                            │                          │
      │                       │                            │  14. StatusListService   │
      │                       │                            │      .isRevoked()        │
      │                       │                            │      (on-chain check)    │
      │                       │                            │                          │
      │                       │                            │  15. downloadFile()      │
      │                       │                            ├─────────────────────────►│
      │                       │                            │     POST /storage/       │
      │                       │                            │     download             │
      │                       │                            │◄─────────────────────────┤
      │                       │                            │     encrypted file       │
      │                       │                            │                          │
      │                       │                            │  16. decryptContent()    │
      │                       │                            │      (AES-256-GCM        │
      │                       │                            │       if CONFIDENTIAL+)  │
      │                       │                            │                          │
      │                       │                            │  17. applyRedactions()   │
      │                       │                            │      (if DOCX with       │
      │                       │                            │       multi-level)       │
      │                       │                            │                          │
      │                       │                            │  18. encryptForEphemeral │
      │                       │                            │      Key()               │
      │                       │                            │      - Server X25519     │
      │                       │                            │        keypair           │
      │                       │                            │      - NaCl box encrypt  │
      │                       │                            │        (XSalsa20-        │
      │                       │                            │         Poly1305)        │
      │                       │                            │                          │
      │                       │  19. Response: ciphertext, │                          │
      │                       │      nonce, serverPublicKey│                          │
      │                       │◄───────────────────────────┤                          │
      │                       │                            │                          │
      │                       │  20. nacl.box.open()       │                          │
      │                       │      - Decrypt with        │                          │
      │                       │        ephemeral secret    │                          │
      │                       │        + server public     │                          │
      │                       │                            │                          │
      │  21. DOCUMENT_ACCESS  │                            │                          │
      │      _RESPONSE        │                            │                          │
      │◄──────────────────────┤                            │                          │
      │      documentBlob,    │                            │                          │
      │      filename,        │                            │                          │
      │      mimeType         │                            │                          │
      │                       │                            │                          │
      │  22. Render in        │                            │                          │
      │      PDF.js canvas    │                            │                          │
      │      (view-only)      │                            │                          │
      │                       │                            │                          │
```

### Key Functions (Document Access)

| Step | Function | Location | Purpose |
|------|----------|----------|---------|
| 3 | `setSecureDashboardAgent()` | SecureDashboardBridge.ts | Send WALLET_READY when agent ready |
| 4 | `handleDocumentAccessRequest()` | SecureDashboardBridge.ts | Handle postMessage from dashboard |
| 5 | `nacl.box.keyPair()` | tweetnacl | Generate ephemeral X25519 keypair |
| 6 | `getEd25519KeyFromPluto()` | SecureDashboardBridge.ts | Two-pass key lookup (localStorage → Pluto) |
| 7 | `nacl.sign.detached()` | tweetnacl | Sign request payload |
| 9 | `verifySignature()` | ReEncryptionService.js | Verify Ed25519 signature, check timestamp |
| 10 | `checkReplay()` | ReEncryptionService.js | Ensure nonce uniqueness (5min window) |
| 11 | `DocumentRegistry.get()` | DocumentRegistry.js | Get document metadata |
| 12 | Check `releasableTo[]` | ReEncryptionService.js | Verify issuer DID authorized |
| 13 | `getLevelNumber()` | ReEncryptionService.js | Compare user vs document clearance |
| 14 | `StatusListService.isRevoked()` | StatusListService.js | On-chain revocation check |
| 15 | `downloadFile()` | IagonStorageClient.js | Download from Iagon |
| 16 | `decryptContent()` | IagonStorageClient.js | AES-256-GCM decryption |
| 17 | `applyRedactions()` | DocxRedactionService.js | Redact sections above user's clearance |
| 18 | `encryptForEphemeralKey()` | ReEncryptionService.js | NaCl box encryption for wallet |
| 20 | `nacl.box.open()` | tweetnacl (wallet) | Decrypt with ephemeral keys |

---

## Encryption/Decryption Summary

| Stage | Algorithm | Keys | Purpose |
|-------|-----------|------|---------|
| Storage (Iagon) | AES-256-GCM | Server-generated symmetric key | At-rest encryption for CONFIDENTIAL+ |
| Transport (Server→Wallet) | X25519 + XSalsa20-Poly1305 | Ephemeral keypairs | Perfect forward secrecy |
| Signature | Ed25519 | User's PRISM DID key | Request authentication |

---

## Verifiable Credential Verification Points

| VC Type | Verification Point | Purpose |
|---------|-------------------|---------|
| RealPerson VC | Session authentication | User identity verification |
| Security Clearance VC | Step 13 (clearance check) | Access level authorization |
| EmployeeRole VC | Step 12 (releasability) | Issuer DID in `releasableTo[]` |

---

## Security Features

### Document Creation Security
- **Multi-layer encryption**: Application-level AES-256-GCM + Iagon storage encryption
- **Immutable storage reference**: Iagon URL embedded in PRISM DID serviceEndpoint
- **Blockchain anchoring**: Document DID published to PRISM blockchain
- **VC-based metadata**: DocumentMetadataVC issued via DIDComm

### Document Access Security
- **Perfect forward secrecy**: Ephemeral X25519 keypairs for each access
- **Replay attack prevention**: Nonce uniqueness check (5-minute window)
- **Timestamp validation**: Requests must be within 5 minutes
- **Signature verification**: Ed25519 signatures on access requests
- **On-chain revocation**: StatusList2021 credential revocation check
- **Clearance-based redaction**: Content above user's clearance level redacted
- **View-only display**: PDF.js canvas rendering prevents downloads

---

## File Locations

| Component | Path |
|-----------|------|
| DocxClearanceParser | `/root/company-admin-portal/lib/DocxClearanceParser.js` |
| DocxRedactionService | `/root/company-admin-portal/lib/DocxRedactionService.js` |
| ReEncryptionService | `/root/company-admin-portal/lib/ReEncryptionService.js` |
| IagonStorageClient | `/root/company-admin-portal/lib/IagonStorageClient.js` |
| DocumentRegistry | `/root/company-admin-portal/lib/DocumentRegistry.js` |
| EnterpriseDocumentManager | `/root/company-admin-portal/lib/EnterpriseDocumentManager.js` |
| SecureDashboardBridge | `/root/idl-wallet/src/utils/SecureDashboardBridge.ts` |
| StatusListService | `/root/company-admin-portal/lib/StatusListService.js` |

---

**Document Version**: 1.0
**Last Updated**: 2026-02-01
**Author**: Hyperledger Identus SSI Infrastructure Team
