# 12 — Coverage Appendix

Every file in `idl-wallet/src` is accounted for: covered by one of documents 01–11, or listed here as
**intentionally dropped**. 152 source files total.

This appendix exists so the executing agent can tell "not yet ported" from "deliberately not ported."
Silent omission is the failure mode this prevents.

## 12.1 Verification performed

| Check | Method | Result |
|---|---|---|
| File coverage | Every `src/**/*.ts(x)` basename cross-referenced against the spec set | 152 files; 8 initially uncovered, resolved in §12.2 |
| Fork patch coverage | Every file in `artifacts/sdk-fork.diffstat.txt` mapped to a patch | 20/20 — `01` §A.2 |
| Kotlin API claims | Read from `sdk-kmp@main` source (`EdgeAgent.kt`, `Pluto.kt`, `OfferCredential.kt`, `jvmMain/DbConnectionImpl.kt`, `sdk/build.gradle.kts`, `README.md`) | Verified, with 9 open items in `01` §B.9 |
| Protocol spec | `service-access/1.0` transcribed from `packages/service-access-didcomm/PROTOCOL.md`; the other three reconstructed from `actions/index.ts:2035-2350` | See §12.4 |
| Capability keys | Read from `certification-authority/server.js:8275-8340` and `company-admin-portal/lib/companyPortalRegistry.js:70`; wallet derivation run against `lib/companies.js` display names | Verified — `05` §5.1. Found one fragile double-derivation (finding 8, §12.5) |
| Live services | `curl` on all four health endpoints | CA, company-admin, document-service, mediator all **200** (2026-07-30) |

## 12.2 Files resolved by this appendix

These eight were not named in 01–11. All are genuine, non-trivial logic; two carry rejected-design
records as valuable as the ones in `06` §6.1.

### `utils/connectionCredentialMatcher.ts` (108) — 🔴 rejected design recorded

**There is no stored field anywhere — SDK/Pluto schema or Redux — linking a credential to the
connection it arrived over.** Two approaches:

- ❌ **Rejected:** `credential.subject === connection.receiver`. Empirically confirmed via live wallet
  diagnostics to **never** match — `credential.subject` is a stable `did:prism:…` identity DID (who the
  credential is *about*), while `connection.receiver` is a per-connection `did:peer:2…`. Different DID
  methods; never equal.
- ✅ **Works:** match on the DIDComm `issue-credential` **message** that delivered the credential. Its
  `from` equals `connection.receiver`. The raw JWT is recoverable from that message's attachment
  (`data.base64`, decoded), and `Credential.id` **is** the raw JWT string — so exact string equality
  matches the two.

Exports `getCredentialsForConnection`, `getPhotoBearingCredentialsForConnection`. `messages` is an
optional parameter (defaults to no matches) so callers without `app.messages` keep prior behaviour.

**Port instruction:** implement the message-based match. Belongs in `domain/`, keyed off the same
`ISSUE_CREDENTIAL_PIURIS` set the pipeline uses — the file notes it mirrors `actions/index.ts`'s check
"exactly, so this stays in sync." In Kotlin, share **one** constant (`04` §4.5). Do not retry the
subject/receiver comparison.

### `utils/proofRequestFieldMatching.ts` (105) — 🔴 shape assumption recorded

Flattens **every** `input_descriptor`'s fields into one list. The recorded reason: *some issuers emit
one `input_descriptor` per requested claim* rather than one descriptor with many fields — so reading
only `input_descriptors[0]` **silently drops the rest** in that shape.

Exports `aggregateRequestedFields`, `extractRequestedFields`, `filterCredentialsByRequestedFields`.

Documented limitation to carry forward: it does **not** evaluate DIF PE `submission_requirements`
(rules that group descriptors). State that limit explicitly in the Kotlin port rather than implying
full DIF PE support.

**Port instruction:** pure function, `domain/`, with a test for the one-descriptor-per-claim shape.
Relates to `01` §A.3's empty-filter bug and `04` §4.8.

### `utils/credentialFilterRules.ts` (223) — purpose-based credential filtering

Decides which credentials are offered to the user when responding to a proof request. Four tables:

- `SYSTEM_CREDENTIAL_BLOCKLIST` — credential types never shareable (e.g. `ServiceConfiguration`)
- `SHAREABLE_CREDENTIAL_TYPES`
- `PURPOSE_TO_CREDENTIAL_MAP` — request purpose → acceptable types
- `SCHEMA_TO_CREDENTIAL_MAP` — schema id → type

Plus `isSystemCredential`, `isShareableCredential`, `getCredentialTypesForRequest`,
`filterCredentialsForProofRequest`, `RequestPurpose`.

**Port instruction:** the blocklist is **security-relevant** — `ServiceConfiguration` VCs carry
enterprise API keys (`08` §8.2), so disclosing one leaks a credential. Port the blocklist as a
fail-closed default: a type not on `SHAREABLE_CREDENTIAL_TYPES` is not offered. Belongs with
`09` §9.2 and the `UnifiedProofRequestModal`.

### `utils/selectiveDisclosure.ts` (194) — VC-proof attachment construction

Distinct from SD-JWT selective disclosure (`01` §B.3). This builds the **`vc-proof-0` attachments**
used in OOB invitations and the `vc-proof-sharing/1.0` protocol (`05` §5.4):
`createSelectiveDisclosure`, `applySelectiveDisclosure`, `getFieldsForDisclosureLevel`,
`createVCProofAttachment`, `parseVCProofAttachment`, `createVCRequestAttachment`,
`parseVCRequestAttachment`, `getRequiredFieldsForVCType`, `validateSelectiveDisclosure`.

**Port instruction:** required for Phase 2 (invitation previews) and Phase 4 (live verification
previews). `parseVCProofAttachment` reads **untrusted** input — use the soft-failure result type
(`07` §7.8). Pairs with `components/SelectiveDisclosure.tsx` (`09` §9.2).

### `utils/caValidation.ts` (206) and `utils/companyValidation.ts` (412)

Validate CA Authority Identity and Company Identity credentials embedded in OOB invitations, at
wallet-initialisation / trust-establishment time. Parallel structures:
`parse*CredentialFromInvitation`, `validate*Credential`, `parseOOBInvitation`, `extractOOBFromURL`,
plus `CACredentialData` / `ValidatedCAConfig` / `CompanyCredentialData` / `ValidatedCompanyConfig`.

`companyValidation.ts` additionally holds a **second implementation of company TOFU pinning** —
`CompanyPIN`, `pinCompany`, `isCompanyVerified`, `getPinnedCompany`, `verifyPinnedCompany`,
`hashCredential` — duplicating the same-named helpers in `prefixedStorage.ts` (`06` §6.6). It also has
`extractIssuerDID`, `checkCAConnection`, and `verifyCompanyIssuer` (company credential → issuing CA
chain).

**Port instruction:** ⚠️ **Two divergent TOFU implementations and two `parseOOBInvitation`/
`hashCredential` pairs exist.** Determine which is live before porting either — `06` §6.6 assumed the
`prefixedStorage.ts` versions. Consolidate to one; a duplicated trust store is a real hazard, since
pinning through one path and verifying through the other silently never matches. **Treat this as a
finding to report, not just a porting task.**

### `hooks/usePhotoDID.ts` (225) — photo resolution with a two-tier cache

Resolves a photo reference into a displayable image:

- DID → endpoint URL — **short TTL**, to pick up DID document updates quickly
- `iagonFileId` → data URL — **long TTL**, to avoid re-downloading unchanged images

**Port instruction:** two-tier cache with the same TTL asymmetry (the reasoning is sound and
non-obvious). In Compose this becomes a repository + image loader rather than a hook. Relates to
`RealPersonIdentity` photo rendering (`09` §9.2) and the `photoDID` flow (DB → `EmployeeRole` VC →
login). Apply the `verifiedCredentialSubject` staleness TTL too (`03` §3.6 item 3).

### `types/securityKeys.ts` (91) — type definitions

Interfaces for Ed25519-based Security Clearance VCs, including the **dual-key** structure
(`addSecurityKeyDual` in `07` §7.6). Port as Kotlin data classes alongside the key lifecycle.

## 12.3 Intentionally dropped

Consolidated from `07` §7.9, `09` §9.11, and `08` §8.4.

| File | Lines | Reason |
|---|---|---|
| `components/Message.tsx` | 1348 | **Orphaned dead code** — not imported by any page since `messages.tsx` was rewritten onto `Chat.tsx` (commit 053a969). Superseded by `UnifiedProofRequestModal` + `sendVerifiablePresentation` |
| `components/WasmMemoryGuard.tsx` | 323 | Browser WASM memory accumulation only |
| `utils/MemoryMonitor.ts` | 329 | ditto |
| `utils/RouteMemoryCleanup.ts` | 287 | ditto |
| `pages/api/mediator/register-peer-did.ts` | 81 | Writes directly to the mediator's MongoDB with hardcoded credentials; bypasses DIDComm mediation (`08` §8.4) |
| `pages/api/logs.ts` | 196 | Browser can't write files; desktop logs locally (`08` §8.5) |
| `pages/api/wallet/{check,download,upload}.ts` | 247 | Hold the server-side `IAGON_ACCESS_TOKEN`; replaced per the `08` §8.3 decision |
| `pages/api/shorten.ts` + `pages/i/[token].tsx` | 60 | Consuming deep links is kept; *generating* short links depends on the `08` §8.6 decision |
| `utils/clipboard.ts` | 58 | Platform API |
| `components/Agent.tsx` | 13 | Trivial shim |
| `app/{layout.tsx,Box.tsx,Spacer.tsx,state.ts,utils.ts}` | 51 | Next.js / layout shims; `app/layout.tsx` is an unused App Router stub (the wallet uses Pages Router) |

Also dropped, as data rather than code: the `wallet-reload-timestamp` / `wallet-reload-url` KV keys
(`03` §3.7) and the null-user storage-prefix fallback (`03` §3.1).

Total dropped: ~3 100 lines, ~6% of the 52 372-line source tree. `Message.tsx` alone is 43% of that —
**confirm it is still unreferenced** before dropping it, since the claim comes from a source comment
rather than a fresh import check.

## 12.4 Known gaps in this spec set

Stated plainly so they are not mistaken for completeness.

1. **`credential-issuance/1.0`'s `fields-required` descriptor shape is not fully specified**
   (`05` §5.2). It is not recoverable from the wallet side; read
   `packages/credential-issuance-didcomm/lib/CredentialIssuanceService.js` before implementing.
2. **9 unverified Kotlin SDK behaviours** — `01` §B.9. Each must be resolved in the phase that
   depends on it.
3. **5 blocking operator decisions** — `10` "Blocking decisions".
4. **The duplicate TOFU/validation implementations in §12.2** need triage before Phase 2.
5. **The enterprise-channel document-access wallet trigger** was still TODO at last record
   (`09` §9.6). Verify the current state of `identus-document-service` before Phase 5e.
6. **Large files not read line-by-line during spec authoring** — `OOB.tsx` (2628),
   `SecureDashboardBridge.ts` (1185), `documents.tsx` (1424), `ConnectionRequest.tsx` (1788),
   `InvitationPreviewModal.tsx` (1137), `EnterpriseAgentClient.ts` (850). Their *roles* are
   specified; their internal edge cases are not. Read each in full at the start of the phase that
   ports it.
7. **No performance or scale requirements are specified.** The current wallet is a browser SPA with
   known memory pressure; a desktop app has different constraints. If throughput or dataset-size
   targets matter, they need to be stated — nothing here addresses them.

## 12.5 Findings worth acting on independent of the port

Surfaced while writing this spec set; none are porting tasks.

1. 🔴 **Live GitHub PAT on disk.** `idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/.git/config`
   has a `fork` remote with an embedded `ghp_…` token. Revoke it.
2. 🔴 **The SDK fork's declared source path no longer exists.** `package.json` points at
   `/root/clean-identus-wallet/sdk-v6-test/sdk-ts`. **A `yarn install` in `idl-wallet` today would
   fail or silently replace the patched SDK with upstream `v6.6.0`, breaking the running wallet.**
   The patches are preserved in `artifacts/sdk-fork.patch`, but the live dependency should be repointed
   at a real, version-controlled location.
3. 🟡 **Hardcoded mediator MongoDB credentials** in `pages/api/mediator/register-peer-did.ts`
   (`mongodb://admin:admin@127.0.0.1:27017`).
4. 🟡 **Private key material in unprefixed `localStorage`** — `security-clearance-keys` leaks across
   user profiles on the same origin (`03` §3.2), contrary to `prefixedStorage.ts`'s own isolation claim.
5. 🟡 **Duplicate TOFU trust stores** (§12.2) — pinning via one path and verifying via the other would
   never match.
6. 🟡 **No upload size cap** on `document-upload/1.0`, whose payload is base64 inside a DIDComm message
   (`05` §5.3).
7. 🟡 **Employee-portal capability key is derived twice, by different rules** — the server uses
   `${company.id}-employee-portal`, the wallet slugifies the display name (`05` §5.1). The three
   current tenants agree by coincidence of naming; a tenant whose `id` differs from
   `slug(displayName − legalSuffix)` gets a silently non-functional portal login. This class of
   failure has already occurred once (`evilcorp`, before the config-driven registry). Consider making
   the server's `capabilityKey` the single source and having the wallet only ever read it.
7. ⚪ **`docs/` is root-owned**, and `CLAUDE.md`'s references to `docs/features/` and
   `docs/infrastructure/` are stale — neither exists. This spec set is at `kotlin-port/` as a result
   (`README.md`, location note).
