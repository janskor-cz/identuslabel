AI-Generated Content — This document was created by Elena Agent, an AI system developed by Plan.Net Studios (Serviceplan Group), operating autonomously without human review or oversight. The content may contain errors, inaccuracies, or outdated information. All data, analysis, and recommendations should be independently verified before making any business decisions or taking action based on this document.
Implementation Plan
Three-Tier Encryption Architecture
SSI Document Access Control — identuslabel.cz
April 2026 | Based on codebase review via MCP server
Executive Summary
This document defines seven discrete implementation tasks that bridge the gap between the current proof-of-concept state and the target three-tier encryption architecture described in the SSI white paper (Section 6.4, v3.2). Each task is independently triggerable, has clear acceptance criteria, and is sequenced to respect dependencies.
The tasks address five requirements gaps (R1–R5) identified in the codebase review. Tasks 1–5 form the critical path (CMK hierarchy, DEK wrapping, registry cleanup, access pipeline update, VC schema update). Tasks 6–7 are independent and can run in parallel with the critical path.
Task Dependency Map
Critical Path: Task 1 (CMK Store) → Task 2 (Wrap DEKs) → Task 3 (Clean Registry) → Task 4 (Access Pipeline)
Parallel: Task 5 (VC Schema) depends on Task 2 only | Task 6 (Content Hash) and Task 7 (Sig Fallback) have no dependencies
Task Overview
#	Task	Size	Dependencies	Gaps Addressed
1	Implement Classification Master Key (CMK) Store	M	None — this is the foundation task.	R1 (no CMK tier)
2	Wrap DEKs with CMK During Upload	M	Task 1 (CMK store must exist).	R1, R3 (flat keys, unprotected manifest)
3	Remove Raw Key Material from DocumentRegistry	M	Task 2 (uploads must already produce CMK-wrapped manifests so access pipeline can retrieve keys from Iagon at access time, not from registry).	R2 (key in 3 places)
4	Update Access Pipeline to Unwrap CMK-Protected Key Manifests	L	Tasks 1 + 2 (CMK store + wrapped manifests).	R1, R3 (CMK unwrap in access path)
5	Update DocumentMetadataVC Schema for Wrapped Key Reference	S	Task 2 (uploads produce wrapped manifests).	R2 (raw key in VC)
6	Anchor Content Hash in DID Document Service Endpoint	S	None — can run in parallel with Tasks 1–4.	R5 (hash not on-chain)
7	Harden Signature Verification Fallback	S	None — can run in parallel with Tasks 1–4.	R4 (fallback too broad)
 
Detailed Task Specifications
Task 1: Implement Classification Master Key (CMK) Store
Goal: Establish a per-classification key hierarchy that enables instant revocation at the classification level.
Estimated Complexity: Medium (50–150 lines changed)
Dependencies: None — this is the foundation task.
Scope
•	NEW: lib/ClassificationKeyManager.js — CMK lifecycle (load from env, derive wrapping keys, rotate)
•	MODIFY: company-admin-portal/server.js — Initialize CMK store at startup
•	MODIFY: identus-document-service/server.js — Initialize CMK store at startup
•	NEW: .env additions: CMK_INTERNAL, CMK_CONFIDENTIAL, CMK_RESTRICTED, CMK_TOP_SECRET (base64-encoded 256-bit keys)
Acceptance Criteria
•	Four CMKs loaded from environment variables at server startup
•	ClassificationKeyManager.wrapDEK(rawDEK, classificationLevel) returns an encrypted buffer
•	ClassificationKeyManager.unwrapDEK(wrappedDEK, classificationLevel) returns the original raw DEK
•	Attempting to unwrap with the wrong classification level fails
•	Unit tests pass for wrap/unwrap round-trip at each classification level
Task 2: Wrap DEKs with CMK During Upload
Goal: Ensure that no raw Document Encryption Key is ever written to persistent storage — only CMK-wrapped DEKs leave server memory.
Estimated Complexity: Medium (50–150 lines changed)
Dependencies: Task 1 (CMK store must exist).
Scope
•	MODIFY: lib/IagonStorageClient.js — encryptContent() returns raw DEK; caller wraps before manifest upload
•	MODIFY: company-admin-portal/server.js — Upload endpoints (POST /api/employee-portal/documents/upload, POST /api/classified-upload) wrap DEK with CMK before key manifest serialization
•	MODIFY: identus-document-service (if it has upload paths)
Acceptance Criteria
•	Key manifest JSON uploaded to Iagon contains wrappedDEK (base64) instead of raw key field
•	Key manifest includes wrappingAlgorithm: 'AES-256-GCM' and classificationLevel fields
•	Raw DEK is zeroed from memory (Buffer.fill(0)) after wrapping
•	Existing unmodified manifests (legacy format) are still readable by the access pipeline (backward compatibility)
Task 3: Remove Raw Key Material from DocumentRegistry
Goal: Eliminate the tripled attack surface by ensuring DocumentRegistry stores only manifest references, not raw keys.
Estimated Complexity: Medium (50–150 lines changed)
Dependencies: Task 2 (uploads must already produce CMK-wrapped manifests so access pipeline can retrieve keys from Iagon at access time, not from registry).
Scope
•	MODIFY: lib/DocumentRegistry.js — registerDocument() must not store contentEncryptionKey or iagonStorage.encryptionInfo with raw key
•	MODIFY: company-admin-portal/server.js — All callers of registerDocument() must pass only encryptionManifestId, not the full encryptionInfo object
•	MODIFY: lib/DocumentRegistryPersistence.js — Migration logic for existing registry JSON files (strip raw keys, retain only encryptionManifestId)
Acceptance Criteria
•	DocumentRegistry.documents Map entries contain NO raw key material (no contentEncryptionKey with actual key, no encryptionInfo.key)
•	Registry JSON file on disk contains only encryptionManifestId references
•	In-memory Map contains only encryptionManifestId references
•	Existing registry files are migrated on next load (raw keys stripped, encryptionManifestId retained)
•	Access pipeline still works (retrieves key from Iagon manifest, not from registry)
Task 4: Update Access Pipeline to Unwrap CMK-Protected Key Manifests
Goal: ReEncryptionService retrieves the CMK-wrapped key manifest from Iagon, unwraps it using the CMK, and decrypts the document — all in memory.
Estimated Complexity: Large (150+ lines changed, multi-file coordination)
Dependencies: Tasks 1 + 2 (CMK store + wrapped manifests).
Scope
•	MODIFY: company-admin-portal/lib/ReEncryptionService.js — processAccessRequest() must: (a) fetch encrypted manifest from Iagon, (b) unwrap DEK using ClassificationKeyManager, (c) decrypt document, (d) zero all key material
•	MODIFY: identus-document-service/lib/ReEncryptionService.js — Same changes for the stateless service
•	MODIFY: company-admin-portal/server.js — Download endpoints that directly use encryptionInfo from registry must switch to Iagon manifest retrieval + CMK unwrap
Acceptance Criteria
•	Access request for a CMK-wrapped document succeeds: manifest fetched from Iagon, DEK unwrapped, document decrypted, re-encrypted for ephemeral key
•	Access request for a legacy (unwrapped) manifest still succeeds (backward compatibility — detect by absence of wrappingAlgorithm field)
•	No raw DEK is logged or persisted at any point during access
•	Performance: manifest fetch + unwrap adds < 200ms to access latency
Task 5: Update DocumentMetadataVC Schema for Wrapped Key Reference
Goal: The DocumentMetadataVC issued via DIDComm should reference the encryptionManifestId, not carry or reference raw key material.
Estimated Complexity: Small (< 50 lines changed)
Dependencies: Task 2 (uploads produce wrapped manifests).
Scope
•	MODIFY: company-admin-portal/server.js — DIDComm VC issuance logic (credential subject must include encryptionManifestId, must NOT include raw key or full encryptionInfo)
•	MODIFY: idl-wallet credential display (if it renders key fields — verify and update)
Acceptance Criteria
•	Issued DocumentMetadataVC contains encryptionManifestId in credential subject
•	No raw key material appears in any VC field
•	Wallet displays document metadata correctly after schema change
Task 6: Anchor Content Hash in DID Document Service Endpoint
Goal: Create an immutable, on-chain tamper-evident binding between the document DID and its content by including the SHA-256 content hash in the DocumentMetadata service endpoint.
Estimated Complexity: Small (< 50 lines changed)
Dependencies: None — can run in parallel with Tasks 1–4.
Scope
•	MODIFY: company-admin-portal/lib/EnterpriseDocumentManager.js — createDocumentDIDWithServiceEndpoint() must include contentHash field in the DocumentMetadata service endpoint object
•	MODIFY: identus-document-service/lib/ReEncryptionService.js — After decrypting document content, compute SHA-256 hash and compare against contentHash from resolved DID Document; reject on mismatch
Acceptance Criteria
•	New documents have contentHash (sha256:...) in their DID Document’s DocumentMetadata service endpoint on Cardano
•	Access pipeline computes content hash after decryption and compares against on-chain value
•	Mismatch triggers CONTENT_INTEGRITY_FAILED denial with audit log entry
•	Legacy documents without contentHash in DID Document are not rejected (field treated as optional)
Task 7: Harden Signature Verification Fallback
Goal: Restrict the format-only signature validation fallback to INTERNAL-level documents only, preventing authentication bypass during Cloud Agent downtime for higher classifications.
Estimated Complexity: Small (< 50 lines changed)
Dependencies: None — can run in parallel with Tasks 1–4.
Scope
•	MODIFY: company-admin-portal/lib/ReEncryptionService.js — verifySignature() must accept documentClassificationLevel parameter; return false (deny) when DID resolution fails AND classification > INTERNAL
•	MODIFY: identus-document-service/lib/ReEncryptionService.js — Same change
•	MODIFY: Both callers of verifySignature() must pass the document’s classification level
Acceptance Criteria
•	When Cloud Agent is unreachable: INTERNAL documents are accessible (format-only fallback permitted)
•	When Cloud Agent is unreachable: CONFIDENTIAL, RESTRICTED, TOP_SECRET documents are denied with SIGNATURE_VERIFICATION_UNAVAILABLE error
•	When Cloud Agent is reachable: all classification levels work normally (no change to happy path)
•	Denial is logged in audit with reason DID_RESOLUTION_FAILED + classification level
 
Migration & Backward Compatibility
All tasks are designed for backward compatibility with existing documents. The migration strategy is:
•	New documents: encrypted with CMK-wrapped DEKs from Task 2 onward
•	Legacy documents: access pipeline detects unwrapped manifests (no wrappingAlgorithm field) and falls back to direct DEK use
•	Registry migration (Task 3): strips raw keys from existing registry entries on next server startup; encryptionManifestId is retained
•	No re-encryption of existing Iagon files required — legacy manifests remain readable
•	Optional batch job can re-wrap legacy manifests with CMK after the critical path is complete (not included as a task — operational decision)
Requirements Gap → Task Mapping
Gap	Description	Addressed By
R1	No Classification Master Key tier	Tasks 1, 2, 4
R2	Raw key in 3 persistent locations	Tasks 3, 5
R3	Key manifest unprotected on Iagon	Tasks 1, 2 (wrapped manifest)
R4	Signature fallback bypasses all levels	Task 7
R5	Content hash not anchored on-chain	Task 6

serviceplan-agents.com | support@serviceplan-agents.com
