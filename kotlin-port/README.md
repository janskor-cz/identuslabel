# Kotlin IDL Wallet — porting specification

Specification set for reproducing `idl-wallet` (Next.js 14 / TypeScript / Redux, port 3002) as a
Kotlin application: **desktop first, Android next, iOS later**, at **full feature parity**.

This directory contains no Kotlin code. It exists because the wallet's behaviour is **not derivable
from its source alone** — a large share lives in a privately patched SDK fork, three custom DIDComm
protocols, and workarounds whose reasons are recorded only in comments (some of which document
designs that were tried and failed). A port written from the TypeScript alone will silently
reintroduce bugs this deployment already fixed.

## Start here

**Read `01-sdk-gap-analysis.md` first, before writing any Kotlin or choosing a Gradle setup.** It
determines whether individual features are cheap, expensive, or currently impossible. Several
decisions in `02-architecture.md` exist solely to accommodate its findings.

| # | Document | Read when |
|---|---|---|
| — | `README.md` (this file) | first |
| 01 | `01-sdk-gap-analysis.md` | **before anything else** |
| 02 | `02-architecture.md` | before Phase 0 |
| 03 | `03-state-and-storage.md` | Phase 0 |
| 04 | `04-message-pipeline.md` | Phase 1 |
| 05 | `05-protocols.md` | Phase 2 / 4 |
| 06 | `06-trust-model.md` | Phase 4 — read with 05 |
| 07 | `07-crypto.md` | Phase 5 |
| 08 | `08-external-services.md` | Phase 5 |
| 09 | `09-ui-screens.md` | any UI work |
| 10 | `10-build-order.md` | to plan the work |
| 11 | `11-acceptance-tests.md` | to know when it's done |
| 12 | `12-coverage.md` | to check what is *not* covered, and the open findings |
| 13 | `13-sdk-version-strategy.md` | **before choosing a baseline** — the TS SDK is discontinued and two majors behind |
| — | `artifacts/` | with 01 |

`artifacts/` holds the recovered SDK fork diff (`sdk-fork.patch`, `sdk-fork.diffstat.txt`,
`sdk-fork.commits.txt`). **Treat these as primary sources — they cannot be regenerated once
`idl-wallet/node_modules` is reinstalled.**

## The eight constraints that shape everything

1. **The TS wallet runs on a patched fork of a *discontinued* SDK, and the fork's source is gone.**
   `package.json` points at `/root/clean-identus-wallet/sdk-v6-test/sdk-ts`, which no longer exists.
   The only copy is `idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk` — a git repo at
   `v6.6.0` + 4 local commits across 20 files. 13 distinct patches, all load-bearing. → `01` Part A.
   **Worse than it looks:** that npm package received no release after 6.6.0; the SDK was renamed to
   `@hyperledger/identus-sdk` and is now at **8.1.0**. A `yarn install` in `idl-wallet` today would
   break the running wallet. → **`13` §13.1, and do §13.6 first.**

2. **`sdk-kmp` is Android + JVM only — there is no iOS artifact.**
   `github.com/hyperledger-identus/sdk-kmp`, latest tag `v5.0.0`, Maven
   `org.hyperledger.identus:sdk`. Source sets are `commonMain` / `androidMain` / `jvmMain`; no
   `iosMain`. iOS cannot share the Kotlin SDK — it needs `sdk-swift` behind a shared interface.
   → `01` §B.1, `02` §2.4.

3. **Kotlin Pluto has no delete operations at all.** No `deleteMessage`, `deleteCredential`, or
   `deletePeerDID` — only `revokeCredential`. The wallet uses deletes in 10 places, and
   `deleteCredential` was itself a fork patch. → `01` §B.4, `03` §3.4.

4. **The message listener has different semantics.** TS `addListener(MESSAGE)` delivers **new**
   messages; Kotlin `handleMessagesEvents()` re-emits the **entire message table**. Every handler in
   `actions/index.ts` assumes new-only. Porting naively recreates the known redelivery bug cluster
   by construction. → `01` §B.5, `04` §4.4.

5. **JVM storage is unencrypted with a hardcoded path.** `JdbcSqliteDriver("jdbc:sqlite:prism.db")`
   — versus per-user, password-encrypted stores in TS. Multi-user isolation is a security property
   here, not a convenience. → `01` §B.7, `03` §3.3.

6. **`initiatePresentationRequest` now requires `domain` + `challenge`**, and
   `handlePresentation` requires the original request message to still be in Pluto. Both hit
   `liveIdentityVerification.ts` directly. → `01` §B.6.

7. **Several browser-only surfaces need designed replacements**, not ports: the `CAPortalModal`
   iframe that renders `mode: redirect` grants, `docx-preview` DOCX rendering, camera QR scanning,
   WebCrypto, NaCl via libsodium/tweetnacl, and the 5 Next.js API routes the wallet calls on its own
   origin — a desktop app has no server half. → `09` §9.10, `08` §8.5.

8. **A live GitHub PAT is checked into the vendored SDK's git config**
   (`.git/config`, `fork` remote). Unrelated to the port; should be revoked, and must not be copied
   into any new repository.

## Conventions used in these documents

- Every behavioural claim cites its source as `path:line` (e.g. `idl-wallet/src/actions/index.ts:2450`)
  so it can be re-read rather than trusted.
- Kotlin API claims are marked 🟢 verified present / 🟡 differs, verify / 🔴 missing or broken /
  ⚪ not applicable. Anything read only from documentation rather than source is labelled
  **unverified** — `01` §B.9 lists all outstanding items.
- **"Do not port"** appears where TypeScript code should be deliberately dropped (dead code,
  browser-specific workarounds, or a fix that was already reverted upstream of itself). These are
  as important as the things to build.

## Scope

**In:** full parity with the current wallet — all screens, the three custom DIDComm protocols, the
trust model, documents (DOCX redaction, ephemeral-DID PFS, section keys), NaCl chat encryption,
security-key management, enterprise-agent REST integration, Iagon backup/restore, multi-user login.

**Out:** changes to `idl-wallet` or any running service; new features; the AnonCreds path (present
in both SDKs, unused by this wallet — see `01` §B.8).

## Live deployment reference

The Kotlin wallet targets the same running services, so specs are verifiable end-to-end:

| Service | URL | Port |
|---|---|---|
| Mediator | `https://identuslabel.cz/mediator` | 8080 |
| Cloud Agent | `https://identuslabel.cz/cloud-agent` | 8000 |
| Enterprise Agent | `https://identuslabel.cz/enterprise` | 8300 |
| Multitenancy Agent | `http://91.99.4.54:8200` | 8200 |
| CA Portal | `https://identuslabel.cz/ca` | 3005 |
| Company Admin | `https://identuslabel.cz/company-admin` | 3010 |
| Document Service | `https://identuslabel.cz/document-service` | 3020 |
| IDL Wallet (reference impl) | `https://identuslabel.cz/wallet` | 3002 |

Mediator DID is hardcoded at `idl-wallet/src/reducers/app.ts:19`. The CA's invitation is fetched
live from `GET /ca/api/well-known/invitation` (regenerated across CA restarts — do not pin it).

> **Location note:** this spec set was intended for `docs/kotlin-port/`, but `/opt/project_identuslabel/docs`
> is root-owned and not writable by the `identus` user. To relocate, a root user runs:
> `mv /opt/project_identuslabel/kotlin-port /opt/project_identuslabel/docs/ && chown -R identus:identus /opt/project_identuslabel/docs`
