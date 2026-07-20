# Task Test Report

**Generated:** 2026-07-18T14:56:14.458Z  
**Total:** 38 | **Passed:** 35 | **Failed:** 3

---

## ✅ Task 1: ClassificationKeyManager (7/7)

- ✅ wrap/unwrap round-trip — INTERNAL
- ✅ wrap/unwrap round-trip — CONFIDENTIAL
- ✅ wrap/unwrap round-trip — RESTRICTED
- ✅ wrap/unwrap round-trip — TOP_SECRET
- ✅ unwrap with wrong level throws
- ✅ wrapDEK produces unique ciphertext each call (random IV)
- ✅ load() throws on missing env var

## ✅ Task 2: DEK Wrapping in Upload Path (4/4)

- ✅ wrapDEK output has no raw "key" field
- ✅ wrapDEK output has required fields for manifest upload
- ✅ persisted registry has no raw contentEncryptionKey
- ✅ persisted registry has no raw iagonStorage.encryptionInfo.key

## ✅ Task 3: Registry Cleanup (no raw keys) (3/3)

- ✅ DocumentRegistry.registerDocument strips raw key from iagonStorage
- ✅ DocumentRegistry.registerDocument does not require contentEncryptionKey param
- ✅ Registry persistence migration strips legacy raw keys on load

## ❌ Task 4: CMK Unwrap in Access Pipeline (6/7)

- ✅ IagonStorageClient.downloadKeyManifest method exists
- ✅ ClassificationKeyManager.unwrapDEK method exists
- ✅ Full round-trip: wrapDEK → AES-encrypt → unwrapDEK → AES-decrypt
- ✅ Legacy path: decryptContent works with direct encryptionInfo.key
- ✅ ReEncryptionService.processAccessRequest function exists
- ❌ server.js /api/access-gate/present contains encryptionManifestId
  > `/api/access-gate/present must define the decryptFromIagon helper (Task 4)`
- ✅ ReEncryptionService.js source contains CMK-unwrap code

## ✅ Task 5: VC Schema — encryptionManifestId (4/4)

- ✅ issueDocumentMetadataVCToEmployee accepts encryptionManifestId param
- ✅ VC claims do not include raw encryption key
- ✅ VC claims include encryptionManifestId when provided
- ✅ VC claims omit encryptionManifestId when not provided

## ❌ Task 6: Content Hash in DID + Integrity Verification (5/6)

- ✅ EnterpriseDocumentManager accepts contentHash in iagonInfo
- ✅ contentHash format is sha256:<hex> (identus-document-service pattern)
- ✅ content integrity check: correct content passes
- ✅ content integrity check: tampered content fails
- ✅ documents without contentHash are not rejected (backward compat)
- ❌ identus-document-service ReEncryptionService has content hash check
  > `identus-document-service ReEncryptionService should contain CONTENT_INTEGRITY_FAILED check`

## ❌ Task 7: Signature Fallback Hardening (6/7)

- ✅ getLevelNumber returns correct hierarchy
- ✅ INTERNAL (level 1) allows format-only fallback
- ✅ CONFIDENTIAL (level 2) is denied when DID resolution fails
- ✅ RESTRICTED (level 3) is denied when DID resolution fails
- ✅ TOP_SECRET (level 4) is denied when DID resolution fails
- ✅ company-admin ReEncryptionService has classification-aware verifySignature
- ❌ identus-document-service ReEncryptionService has classification-aware verifySignature
  > `Should deny CONFIDENTIAL+ on DID resolution failure`

