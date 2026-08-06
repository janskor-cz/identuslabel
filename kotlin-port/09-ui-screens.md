# 09 — UI Screens

Reference for all UI work. Behaviour per screen, plus the global overlays — several of which carry
**security-relevant** decisions and are easy to overlook because they are not screens.

Framework: Compose Multiplatform, desktop first (`02` §2.5). Do not transliterate Tailwind classes;
build a theme. Current look: dark slate background, cyan/emerald/amber/indigo accents per section,
gradient cards (`src/app/index.css`, `components/layouts/MainLayout.tsx`).

## 9.0 Global overlays — build these before any screen

Mounted once in `pages/_app.tsx` inside `<MountSDK>`, so they are active on **every** screen. Two of
them are the wallet's security surface.

| Component | Role | Priority |
|---|---|---|
| `AutoStartAgent` | Starts the agent when the DB is connected | Phase 1 |
| `GlobalCAEnforcer` (`_app.tsx:37`) | Forces a CA connection to exist; renders `CAConnectionEnforcementModal` (768 lines). Also **backfills** `ConnectionMetadata.capabilities` on pre-existing connections | Phase 2 |
| `GlobalGrantWatcher` (`_app.tsx:110`) | 🔐 Scans messages for `service-access/1.0` grants/errors, applies the **trust check**, opens the portal | Phase 4 |
| `UnifiedProofRequestModal` (848) | 🔐 Human approval for **every** inbound presentation request | Phase 3 |
| `CredentialOfferModal` (399) | Accept/reject a credential offer | Phase 3 |
| `EnterpriseCredentialOfferModal` (402) | Same for enterprise-agent-custodied offers | Phase 5 |
| `CAPortalRenderer` (`_app.tsx:221`) | Renders `AccessRequestStatusModal` (92) then `CAPortalModal` (169) | Phase 4 |
| `WasmMemoryGuard` (323) | ⛔ **Do not port** — browser WASM only (`07` §7.9) |
| `ErrorBoundary` (63) | → Compose error boundary / crash handler | Phase 0 |
| `MainLayout` (572) | Nav shell, `NavItem`, `FooterNavigation`, `IDLLogo`, `StatusIndicator` | Phase 0 |

Two behaviours to preserve exactly:

- **`UnifiedProofRequestModal` is the only human gate on presentations.** The single documented
  exception is the automatic clearance handshake (`04` §4.8). Any new auto-response path is a security
  change, not a UX improvement.
- **`GlobalGrantWatcher` consumes grants by deleting the message** after processing, and keeps
  `seenGrantIds`/`seenErrorIds` — replaced by the persistent idempotency layer (`04` §4.4). It also
  logs every scanned message deliberately, because `parseServiceAccessGrant` fails silently by design.

`utils/CAPortalContext.tsx` (82) holds `pendingAccessRequest`, which drives the status modal. Port as a
state holder in the user scope, not a Compose `CompositionLocal` — the watcher writes to it from
outside the composition.

## 9.1 Dashboard (`pages/index.tsx`, 137)

Four navigation cards: Credentials 🎫, Documents 📁, Connections 🔗, Messages 💬 — each with icon,
label, description, and accent gradient (cyan/indigo/emerald/amber). Gated on `db` + `agent`;
`DBConnect` handles the unconnected state. Reads `selectIsEnterpriseConfigured` to decide whether
enterprise features appear.

Straightforward port. The card metadata is worth copying verbatim — the descriptions explain each
section to the user.

## 9.2 Credentials (`pages/credentials.tsx`, 805)

Lists held VCs with **per-type layouts** — `CredentialCardTypeLayouts.tsx` (476) `getCredentialLayout`
selects by credential type (`RealPersonIdentity`, `SecurityClearance`, `EmployeeRole`,
`CISTraining`, `ServiceConfiguration`, …). Supporting: `CredentialCard` (168), `Credential` (111),
`VCProofDisplay` (173), `VerificationBadge` (202), `SelectiveDisclosure` (218), `PrismDIDCard` (267).

Behaviours to keep:

- **Type detection** — `utils/credentialTypeDetector.ts` (607) + `credentialNaming.ts`,
  `credentialSchemaExtractor.ts`, `schemaMapping.ts`. This is a lot of code because type is inferred
  from schema id, `type` array, and claim shape. Port as one pure function with tests.
- **Revocation state** shown, not enforced (`06` §6.4) — StatusList2021 is eventually consistent.
- **Selective disclosure** for SD-JWT maps to Kotlin's
  `preparePresentationForRequestProof(request, credential, disclosingClaims)` (`01` §B.3).
- **Delete** requires `deleteCredential`, a Kotlin gap (`03` §3.4).
- The same layout engine renders `ConnectionMetadata.verifiedCredentialSubject` for peers whose
  identity was live-verified but from whom no VC was ever stored (`03` §3.6). **Apply the staleness
  TTL** (`connections.tsx`'s `PREVIEW_PHOTO_TTL_MS`).

## 9.3 Connections (`pages/connections.tsx`, 1218)

The busiest screen. Components: `connections/ConnectionCard` (225),
`ConnectionCredentialsModal` (140), `ConnectionDetailsModal` (79), `ConnectionAvatar` (97),
`OOB` (2628 — the largest file in the wallet), `PendingRequestsModal` (196),
`CredentialIssuanceRequestor` (233), `ConnectionSelect` (70), `InviterVerification` (121).

Features:

- **Establish** a connection: paste/scan an invitation → `InvitationPreviewModal` (1137) → accept.
  Invitation parsing is `utils/invitationParser.ts` (445) + `qrMessageParser.ts` (428) +
  `vcValidation.ts`'s `detectInvitationFormat` (url / json / base64).
- **Preview then verify.** The preview shows the inviter's attached `vc-proof-0` VC. It is
  **unverified** — labelled as such — and live verification runs *after* the connection establishes
  (`06` §6.1, §6.5). The UI must distinguish "preview" from "verified"; conflating them defeats the
  feature.
- **Display name resolution** — `connectionNameResolver.ts` (260), the 4-level priority in `03` §3.6.
- **🔓 Request Access** — capability dropdown from `connectionAccessTargets.ts` (152), starting the
  `service-access/1.0` flow (`05` §5.1).
- **Request credential issuance** — `credential-issuance/1.0` (`05` §5.2).
- **Delete** — `connectionDeletion.ts` (393), needs the Kotlin delete queries (`03` §3.4).
- **Enterprise portal login** — `handleEnterprisePortalLogin` derives the company-admin base URL from
  the VC's `serviceUrl` for HTTP grant polling. Per `CLAUDE.md`, this is `serviceUrl`'s **only**
  remaining use; it is not a UI entry point, and the old Browser tab that scanned for it was removed.
  **Do not resurrect a `serviceUrl` launch card.**

`OOB.tsx` at 2628 lines is where connection establishment, capability recording, and live verification
all live. **Read it in full before porting**, and split it: invitation parsing, preview, acceptance,
metadata recording, live verification. Each has tests available.

## 9.4 Messages / Chat (`pages/messages.tsx`, 422)

`Chat.tsx` (945) is the live component. Handles **only** `basicmessage/2.0/message`.

- Conversations grouped per connection — `messageFilters.ts` (227): `filterChatMessages`,
  `groupChatMessagesByConnection`, `getConversationId`, `toChatMessage`, `needsUserAction`.
- **Encrypted messages** — NaCl box (`07` §7.1), with `EncryptedMessageBadge` (66),
  `SecurityLevelSelector` (128), `sectionDecryptor.ts` (142). Sending encrypted triggers the automatic
  VC handshake to obtain the peer's clearance VC (`04` §4.8).
- Optimistic send status from `messageSendingStatus` (`03` §3.5).
- The Chat header carries a **🔓 Request Access** entry point, and previously had its own
  untrusted grant parser — now unified (`06` §6.2).

⛔ **`components/Message.tsx` (1348) is orphaned dead code** — not imported by any page since
`messages.tsx` was rewritten onto `Chat.tsx` (commit 053a969), per the note in
`liveIdentityVerification.ts`. **Do not port it.** Its `acceptPresentationRequest` is superseded by
`UnifiedProofRequestModal` + `sendVerifiablePresentation`.

## 9.5 DIDs (`pages/dids.tsx`, 297)

Lists peer DIDs and long-form PRISM DIDs; creation via `DIDManagementSection` (320),
`DIDSelectionModal` (190). Long-form PRISM DID creation is subject to the Cloud Agent validation
workaround (`01` §A.3). `cleanupOrphanedPeerDIDs.ts` (289) needs `deletePeerDID` (`03` §3.4).

## 9.6 Documents (`pages/documents.tsx`, 1424) and My Documents (`pages/my-documents.tsx`, 637)

The largest feature after connections, and Phase 5's bulk.

Components: `DocumentDIDAccess` (862), `ClassifiedDocumentViewer` (850), `DocumentAccess` (788),
`DocumentAccessRequestor` (253), `DocumentUploader` (182), `DocumentRow` (52),
`SectionRenderer` (121), `SecurityClearanceKeyManager` (524).

Flows:

1. **Browse** documents available at the user's clearance level.
2. **Access** a document — `service-access/1.0` `document-access` capability, `mode: payload`
   (`05` §5.1), with ephemeral-DID PFS (`07` §7.2) and best-effort holder PoP (`07` §7.4).
3. **View** with clearance-based **redaction** — sections above the user's level are removed
   server-side (`DocxRedactionService.js` in company-admin) and rendered per-section client-side.
4. **Upload / branch** — `document-upload/1.0` (`05` §5.3).
5. **Edit** — `document-update/request-edit` + `/submit` (`08` §8.7).

Storage: `documentStorage.ts` (688) keyed by `ephemeralDID`, `classifiedDocuments` reducer (444),
`walletFolderStorage.ts` (101).

**Per `project_document_access_holder_binding`: the server side is built; the wallet trigger for the
enterprise-channel document-access flow was still TODO.** Verify current state in
`identus-document-service` before implementing, and expect this to be the least-settled area.

## 9.7 Verify (`pages/verify.tsx`, 552)

QR scanning (`Scanner.tsx` 283, `@yudiel/react-qr-scanner`) → `qrMessageParser.ts` (428) → invitation
or proof-request handling. `last-qr-scan-time` debounces rescans. See §9.10 for the platform problem.

## 9.8 Configuration (`pages/configuration.tsx`, 315)

Enterprise agent configuration from ServiceConfiguration VCs — `ServiceConfigDisplay` (342),
`serviceConfigManager.ts` (221), `configurationStorage.ts` (395), `cloudWalletConfig.ts` (370),
`DebugConsoleSection` (58). API keys move to the keystore (`07` §7.6, `08` §8.2).

## 9.9 Key Management (`pages/key-management.tsx`, 27)

Thin shell over `SecurityClearanceKeyManager` (524), `DIDManagementSection` (320),
`BackupRestore` (130). Covers `07` §7.6 (key lifecycle) and §7.5 (Iagon backup — blocked on the
`08` §8.9 decision).

## 9.10 Browser-only surfaces — four platform decisions

| Surface | Current | Desktop / mobile options |
|---|---|---|
| **`CAPortalModal` iframe** | `mode: redirect` grants render the service page in an in-app iframe | (a) embedded webview — JCEF/KCEF on desktop, WebView on Android; (b) system browser. **(a) preserves the current UX and keeps the token off the clipboard/history; (b) is far simpler but sends a live `accessUrl` token to an external browser.** Recommend (a); if (b), the origin allowlist check (`06` §6.3) becomes the *only* protection |
| **DOCX rendering** | `docx-preview` (JS) | (a) Apache POI → render sections natively — best fit, since content is already section-structured for redaction; (b) convert to PDF and use a PDF viewer; (c) bundle a webview + the JS library. Recommend (a) |
| **Camera QR scan** | `@yudiel/react-qr-scanner` | ZXing / ML Kit on Android; desktop needs webcam capture (`webcam-capture` + ZXing) — or accept paste-only on desktop, since a desktop user can paste the invitation. **Recommend paste-first on desktop, camera on mobile** |
| **QR generation** | `react-qr-code` | ZXing `QRCodeWriter` — trivial |

The iframe decision is the one with security weight. Make it explicitly, and record it.

## 9.11 Component inventory — disposition

**Port:** `AccessRequestStatusModal`, `AgentRequire`, `AutoStartAgent`, `BackupRestore`,
`CACredentialConfirmationModal`, `CAConnectionEnforcementModal`, `CAHyperlinkGenerator` (if §8.6
keeps generation), `CAPortalModal`, `Chat`, `ClassifiedDocumentViewer`, `ConnectionAvatar`,
`ConnectionRequest`, `ConnectionSelect`, `Credential`, `CredentialCard`,
`CredentialCardTypeLayouts`, `CredentialIssuanceRequestor`, `CredentialOfferModal`,
`DBConnect`, `DebugConsoleSection`, `DIDManagementSection`, `DIDSelectionModal`,
`DocumentAccess`, `DocumentAccessRequestor`, `DocumentDIDAccess`, `DocumentRow`,
`DocumentUploader`, `EncryptedMessageBadge`, `EnterpriseCredentialOfferModal`, `ErrorBoundary`,
`FooterNavigation`, `IDLLogo`, `InvitationPreviewModal`, `InviterVerification`, `Loading`,
`MainLayout`, `Mnemonics`, `NavItem`, `OOB`, `PendingRequestsModal`, `PrismDIDCard`, `QuickAction`,
`Scanner`, `SectionRenderer`, `SecurityAlert`, `SecurityClearanceKeyManager`,
`SecurityLevelSelector`, `SelectiveDisclosure`, `ServiceConfigDisplay`, `StatusIndicator`,
`UnifiedProofRequestModal`, `VCProofDisplay`, `VCRequestDialog`, `VerificationBadge`,
`connections/*`.

**Do not port:**

| Component | Reason |
|---|---|
| `Message.tsx` (1348) | Orphaned dead code (§9.4) |
| `WasmMemoryGuard.tsx` (323) | Browser WASM only |
| `Agent.tsx` (13), `app/Box.tsx`, `app/Spacer.tsx`, `app/state.ts`, `app/utils.ts` | Trivial browser/layout shims |
| `app/layout.tsx` (22) | Next.js App Router stub; the wallet uses Pages Router |

**Utilities not to port:** `MemoryMonitor.ts`, `RouteMemoryCleanup.ts` (browser WASM);
`clipboard.ts` (platform API). The `wallet-reload-*` KV keys are browser-reload plumbing (`03` §3.7).

## 9.12 UI requirements

1. **Every trust state must be visible.** Unverified preview, verified, verification failed, and
   stale-verified are four different states (`06`). A single "verified" badge is a security regression.
2. **Never show a raw `accessUrl`** — it embeds a live token (`08` §8.8).
3. **Approval dialogs must show what is being disclosed** — which credential, which claims, to which
   DID. `UnifiedProofRequestModal` does; keep it.
4. **A failed live verification is not an error dialog** — the connection is still usable, just
   unverified (`06` §6.1).
5. **Long operations need visible progress with the real timeout** — human-in-the-loop flows take
   minutes (`04` §4.9). A spinner with no indication of a 5-minute budget reads as a hang; this is
   exactly what the `service-access/1.0/error` handling was added to fix.
