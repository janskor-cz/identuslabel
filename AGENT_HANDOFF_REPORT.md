# Agent Handoff Report — Three-Tier Encryption + Service Wallet Architecture

**Date**: 2026-04-05  
**Prepared by**: Claude Sonnet 4.6 (claude-sonnet-4-6)  
**Purpose**: Assessment report for the next AI agent continuing this project

---

## What Was Implemented This Session

### 1. Three-Tier Encryption Architecture (CMK → DEK → AES-256-GCM)

**Problem solved**: AES-256-GCM Document Encryption Keys (DEKs) were stored in plaintext (base64 only) in the DocumentRegistry, registry JSON on disk, and Iagon key manifest.

**Solution implemented**:

| Component | File | Status |
|-----------|------|--------|
| `ClassificationKeyManager` | `company-admin-portal/lib/ClassificationKeyManager.js` | ✅ Done |
| CMK env vars (4 levels) | `company-admin-portal/.env` | ✅ Done |
| DEK wrapping in upload path | `company-admin-portal/server.js` lines ~3146, ~4962, ~7306 | ✅ Done |
| CMK unwrap in access path | `company-admin-portal/lib/ReEncryptionService.js` line ~241 | ✅ Done |
| CMK unwrap in access path | `identus-document-service/lib/ReEncryptionService.js` lines ~375, ~411 | ✅ Done |

**How it works**:
1. On upload: `encryptContent()` produces raw DEK → `cmkStore.wrapDEK(rawDEK, classificationLevel)` wraps it with the CMK for that level → `encryptionInfo.key` replaced with `'[WRAPPED-BY-CMK]'` before any persistence
2. On access: manifest fetched from Iagon → if `wrappingAlgorithm` present, `cmkStore.unwrapDEK(manifest, level)` recovers raw DEK → used to decrypt file → zeroed from memory
3. Legacy manifests (no `wrappingAlgorithm`) still work — raw key used directly

**CMK env vars** (in `company-admin-portal/.env`):
```
CMK_INTERNAL=AsqTKjDEWO1KGe3rsUfpZCNDo7SzO4eZB4kM4lR62KI=
CMK_CONFIDENTIAL=t/rxL8B2bzNsckgGwr9MnNyRNg6ue3c8mA8uKGJQVmU=
CMK_RESTRICTED=srgdBQ2eT0pepom4T6m+EhoUgblWmkI8ilJ6nJrrKmg=
CMK_TOP_SECRET=WmvprXrjGiV+42Lzkd/uorbsNVJs+qcCV1andFsCf/U=
```

---

### 2. Ed25519 Asymmetric JWT Signing for KeyManifest VCs

**Problem solved**: `KeyManifestVCIssuer` was using HMAC-SHA256 (symmetric — anyone with the key can forge). `jsonwebtoken` v9 does not support EdDSA.

**Solution**: Native Node.js `crypto.sign(null, buffer, ed25519PrivateKey)` / `crypto.verify()`.

| Component | File | Key detail |
|-----------|------|------------|
| `KeyManifestVCIssuer` | `company-admin-portal/lib/KeyManifestVCIssuer.js` | Issues EdDSA JWT; falls back to ephemeral key if env missing |
| `KeyManifestVCVerifier` | `identus-document-service/lib/KeyManifestVCVerifier.js` | Verifies EdDSA via JWKS URL or inline JWK; HS256 legacy fallback |
| JWKS endpoint | `company-admin-portal/server.js` line 442 | `GET /.well-known/jwks.json` — serves Ed25519 public key |
| Signing key | `company-admin-portal/.env` `MANIFEST_SIGNING_KEY` | JWK format, `alg: EdDSA`, `kid: 0d61ee2503418776` |
| Verification config | `identus-document-service/.env` `MANIFEST_ISSUER_JWKS_URL` | Points to company-admin JWKS endpoint |

**JWKS URL**: `https://identuslabel.cz/company-admin/.well-known/jwks.json` — live, 60s cache-control.

---

### 3. Service Tenant Registration on Multitenancy Cloud Agent

Three service wallets registered on `http://91.99.4.54:8200`:

| Service | Wallet ID | API Key (first 8) | PRISM DID (short) |
|---------|-----------|-------------------|-------------------|
| `company-admin-portal` | `9fca9469` | `b926dde9` | `did:prism:32751bea...` |
| `document-service` | `0f81c57d` | `03b7ca7a` | `did:prism:19d62c0b...` |
| `certification-authority` | `20c400c0` | `de2360b8` | `did:prism:929f673c...` |

Credentials stored in respective `.env` files under `SERVICE_WALLET_ID`, `SERVICE_API_KEY`, `SERVICE_DID`.

**Important architecture note**: Server-side wallets on the multitenancy agent do NOT need a mediator. They communicate directly via `https://identuslabel.cz/multitenancy/didcomm`. Mediators are only for edge/mobile wallets behind NAT.

---

### 4. Alice Employee Wallet (API-operated)

A fully API-operated employee wallet on the same multitenancy agent:

| Item | Value |
|------|-------|
| Wallet ID | `ec2ab479-0101-4b8b-b88e-dd3095e6246f` |
| Entity ID | `ae436d76-06df-4ff9-8673-6dbc53d0251f` |
| API Key | `2d0ffe4eed0d756af972e8f8260c2c8a5f3efc2d64cbdd71ac02426682fe7d63` |
| DID (short) | `did:prism:a145fc1d034771b742eaf299e49b7be3d47f373cad6bf46d521934c8eef1b3dd` |
| Credentials file | `company-admin-portal/alice-employee.env` |

**VCs issued to Alice** (both via DIDComm, no mediator):
1. **EmployeeRole VC** (record `a9d0833a`) — `role: Software Engineer`, `department: Engineering`, `employeeId: EMP-ALICE-001`
2. **SecurityClearance VC** (record `afbe6b9b`) — `clearanceLevel: INTERNAL`

**Connection** between company-admin and Alice: `83a21c5b` (company-admin side), `91686bc5` (Alice side). State: `ConnectionResponseSent/Received`.

**SecurityClearance schema** created: guid `0205bcaf-4294-3e27-bf3f-a9b12b714578` on the multitenancy agent.

---

### 5. DocumentService DID Service Endpoint Fix

**Problem**: PRISM DID creation was failing with `InvalidArgument(service endpoint is too long: [metadata])` because the service endpoint JSON included `releasableTo` (array of DIDs) and `iagonEncManifestId`.

**Fix** (`identus-document-service/lib/DocumentService.js` line ~323): stripped `releasableTo`, `iagonFilename`, `originalFilename`, `mimeType`, `iagonEncManifestId` from the DID service endpoint — only `iagonFileId` and `clearanceLevel` remain. These fields live in the KeyManifest VC (VCKeyStore) instead.

---

### 6. Test Results

#### `test-e2e-pipeline.js` — 20/20 PASS
Tests: CMK wrap/unwrap (×4 levels), Iagon connectivity, Iagon upload, DEK wrapping, PRISM DID creation, KeyManifest VC issuance (EdDSA), VCKeyStore persistence, Ed25519 verification (inline JWK, JWKS URL, tamper rejection), CMK unwrap + download + content hash, releasability enforcement, clearance enforcement, content hash tamper detection, VC revocation.

**Run**: `node test-e2e-pipeline.js`

#### `test-alice-vp-access.js` — 5/5 PASS
Tests: Get Alice VCs from cloud agent, upload INTERNAL doc to document-service, build VP with both VCs, VP-gated access returns HTTP 200, INTERNAL user denied RESTRICTED doc (403).

**Run**: `cd /opt/project_identuslabel/company-admin-portal && node test-alice-vp-access.js`

---

## Architecture Overview (Current State)

```
Employee (Alice)
  └─ Wallet: multitenancy agent tenant (ec2ab479)
       ├─ EmployeeRole VC (issued by company-admin service DID)
       └─ SecurityClearance VC (INTERNAL level)

Company Admin Portal (port 3010)
  └─ Service wallet: multitenancy agent tenant (9fca9469)
       └─ Issues VCs via DIDComm to employee wallets
       └─ Uploads documents: Iagon encrypted file + CMK-wrapped key manifest
       └─ Creates PRISM DID per document (service endpoint: iagonFileId + clearanceLevel)
       └─ Issues KeyManifest VC (Ed25519 JWT) → pushed to document-service VCKeyStore
       └─ Serves JWKS: GET /.well-known/jwks.json

Document Service (port 3020)
  └─ Service wallet: multitenancy agent tenant (0f81c57d)
       └─ Stores KeyManifest VCs in VCKeyStore (data/vc-key-store.json)
       └─ Verifies Ed25519 JWT via JWKS URL (60s cache) or inline public JWK
       └─ VP-gated access: POST /documents/:did/access
          1. Resolve DID → get iagonFileId + clearanceLevel
          2. Verify VP (EmployeeRole + SecurityClearance)
          3. Check clearance level ≥ document level
          4. Fetch KeyManifest VC from VCKeyStore
          5. CMK unwrap DEK
          6. Download + decrypt from Iagon
          7. Re-encrypt for client's ephemeral X25519 key (TweetNaCl box)
          8. Return encrypted content + server ephemeral public key
```

---

## Document Update Security Model (Fixed 2026-04-29)

### The Problem That Was Fixed
The `request-edit` endpoint used `document.classificationLevel` as the clearance gate for edit access. This field is the *discovery level* (controls list visibility), not the highest content classification. A DOCX document can have `classificationLevel: CONFIDENTIAL` while containing SECRET-styled paragraphs internally. A CONFIDENTIAL-cleared user could obtain an edit token, download the redacted DOCX (with `[REDACTED]` placeholder text), and re-upload it — permanently destroying SECRET content.

The `submit` endpoint had no clearance check at all.

### How It Works Now
1. `resolveDocumentHighestLevel(document, documentDID)` — new async helper before the versioning endpoints. Priority:
   - `sectionMetadata` from registry (fast, for classified-upload documents)
   - Download + parse original DOCX from Iagon via `DocxClearanceParser` (authoritative, for plain-upload documents)
   - Fallback to `classificationLevel`
2. Both `request-edit` and `submit` call this helper independently.
3. `DOCUMENT_EDITED` audit entries now include `previousFileId` for recovery.

### Important: classificationLevel vs Content Level
- `classificationLevel` = who can see this document in their list (discovery)
- Actual content level = highest paragraph style in the DOCX (only from parsing)
- Never use `classificationLevel` alone to gate write access to a document

---

## Known Gaps / Next Steps

### High Priority
1. **Document-service `createDocument` does NOT use CMK wrapping** (`lib/DocumentService.js` line ~89–109) — it stores the raw DEK in the manifest uploaded to Iagon. Documents created via `POST /documents` directly (not via company-admin portal) have unprotected DEKs. The company-admin portal path IS fixed.

2. **Document-service index file corrupted** — `data/document-index.json` is binary/corrupt, causing `Index load failed — starting fresh` on every boot. Iagon index update also fails with 400 (filename already exists). Non-fatal but should be fixed.

3. **`alice-employee.env` is not gitignored** — contains API key. Add to `.gitignore` or move to a secure location.

### Medium Priority
4. **T3 registry cleanup incomplete** — `DocumentRegistry.js` still has `contentEncryptionKey` in several places (lines 238, 463) serialized as `null`. Not a security gap (it's null), but cleanup was planned.

5. **T5 VC schema** — `encryptionManifestId` was planned to be added to the employee-facing VC `credentialSubject`. Not implemented.

6. **T7 signature fallback hardening** — the plan called for denying CONFIDENTIAL+ documents when DID resolution fails (no format-only fallback). Currently the code has a generic fallback regardless of clearance level. `ReEncryptionService.js` ~line 188.

7. **Certification-authority service** — has a registered wallet and DID but is not connected to the overall document access flow. Its `.env` is at `certification-authority/.env`.

### Low Priority
8. **Mediator `/etc/hosts` fix** — `172.20.0.1 identuslabel.cz` was added to `/root/identus-mediator/docker-compose.yml` `extra_hosts` via `sed` but the edit may not have persisted (permission was denied for the Write tool; sed ran under the identus user). Verify with `docker exec identus-mediator-identus-mediator-1 getent hosts identuslabel.cz`. If missing, the mediator will fail to reach service wallets if you ever need it.

9. **Alice's DID publication** — published on 2026-04-05 but PRISM node confirmation may still be pending. Long-form DID is usable immediately for VC issuance; short-form resolves after ~30 min.

---

## File Index (New/Modified This Session)

### New files
| File | Purpose |
|------|---------|
| `company-admin-portal/lib/ClassificationKeyManager.js` | CMK singleton — wrap/unwrap DEKs per classification level |
| `company-admin-portal/lib/KeyManifestVCIssuer.js` | Ed25519 JWT issuance for KeyManifest VCs (REWRITTEN) |
| `identus-document-service/lib/KeyManifestVCVerifier.js` | Ed25519 JWT verification via JWKS (REWRITTEN) |
| `company-admin-portal/test-e2e-pipeline.js` | 20-test CMK/Iagon/VC/crypto pipeline test |
| `company-admin-portal/test-alice-vp-access.js` | 5-test VP presentation → document access E2E |
| `company-admin-portal/test_doc.docx` | Multi-section DOCX test document (4 classification levels) |
| `company-admin-portal/alice-employee.env` | Alice wallet credentials (wallet ID, API key, DID, connection IDs) |
| `certification-authority/.env` | CA service wallet credentials |
| `scripts/register-service-tenants.cjs` | Idempotent service tenant registration script |

### Modified files
| File | What changed |
|------|-------------|
| `company-admin-portal/.env` | Added SERVICE_* vars, MANIFEST_SIGNING_KEY*, CMK_*, DOCUMENT_SERVICE_ADMIN_KEY |
| `company-admin-portal/server.js` | Added JWKS endpoint, CMK startup init, DEK wrapping in upload paths |
| `identus-document-service/.env` | Added SERVICE_* vars, MANIFEST_ISSUER_JWKS_URL, MANIFEST_SIGNING_KEY_PUBLIC |
| `identus-document-service/lib/ReEncryptionService.js` | CMK unwrap, async verifier call, vcContentHash priority fix |
| `identus-document-service/lib/DocumentService.js` | Stripped oversized fields from DID service endpoint |

---

## Service Health Check Commands

```bash
# All services
curl -s https://identuslabel.cz/company-admin/api/health | python3 -m json.tool
curl -s https://identuslabel.cz/document-service/health
curl -s https://identuslabel.cz/company-admin/.well-known/jwks.json

# Multitenancy agent wallets
curl -s http://91.99.4.54:8200/wallets -H "x-admin-api-key: N9TEJXrZlIX4Qg8R1RSlJwC820QZKwXb" \
  | python3 -c "import json,sys; [print(w['id'][:8], w['name']) for w in json.load(sys.stdin).get('contents',[])]"

# Run tests
cd /opt/project_identuslabel/company-admin-portal
node test-e2e-pipeline.js
node test-alice-vp-access.js
```

---

## Multitenancy Agent Admin

- **URL**: `http://91.99.4.54:8200`
- **Admin key**: `N9TEJXrZlIX4Qg8R1RSlJwC820QZKwXb` (header: `x-admin-api-key`)
- **DIDComm endpoint** (all tenants): `https://identuslabel.cz/multitenancy/didcomm` → proxied to `http://91.99.4.54:8290/didcomm` via Caddy

