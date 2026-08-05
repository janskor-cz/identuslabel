# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ This tree spans FIVE git repositories

`/opt/project_identuslabel/` is one directory but **not** one repo. Check which one you are in
before committing — `git status` from the wrong directory will silently show the wrong thing.

| Directory | Repository | Contents |
|---|---|---|
| `/opt/project_identuslabel/` | `janskor-cz/identuslabel` | CA, company-admin-portal, `packages/`, the frozen `idl-wallet` v1, presentation deck, `kotlin-port/`, infra + docs |
| `idl-wallet-v2/` | `janskor-cz/idl-wallet` | IDL Wallet v2 (SDK v8) — **gitignored by the parent** |
| `identus-document-service/` | `janskor-cz/identus-document-service` | VP-gated document microservice — **gitignored by the parent** |
| `clean-identus-wallet/sdk-v6-test/sdk-ts/` | `janskor-cz/identus-edge-wallet` (`fork` remote) | Patched SDK v6 fork that v1 depends on — **gitignored by the parent** |
| `idl-wallet-kotlin/` | `janskor-cz/idl-wallet-kotlin` | Kotlin Multiplatform port of `idl-wallet-v2`, desktop-first — **gitignored by the parent**; checked out here for porting-source proximity only, no `file:`-style dependency. Development happens on the maintainer's personal computer, not this server. |

The nesting is deliberate and must be preserved: `certification-authority`, `company-admin-portal`
and `identus-document-service` all depend on the shared libraries via relative
`file:../packages/...`, and `idl-wallet` v1 reaches `../clean-identus-wallet/...`. npm resolves
those **by filesystem path, not by repo boundary**, so moving any of these directories breaks
`yarn install` in the others. Split done 2026-07-31. `idl-wallet-kotlin` joined 2026-08-05 as a
plain sibling checkout (Gradle, not npm — no filesystem-path dependency to preserve).

**Runtime data is no longer tracked** in any of them (`certification-authority/data/*.json` except
`ca-authority-credential.json`, `idl-wallet/data/`, `idl-wallet-v2/data/`,
`identus-document-service/data/` except `admin-config.json`). Do not `git add` a whole `data/`
directory — that is how live verification codes and a Cloud Agent wallet apiKey previously reached
a public repo.

## Build & Development Commands

### Infrastructure Services (Docker)
```bash
# NOTE: /usr/bin/docker-compose (v1) is too old — always use DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose
# Start all infrastructure (run from /root — docker-compose files live there)
DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose -f cloud-agent-with-reverse-proxy.yml up -d
DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose -f enterprise-cloud-agent.yml up -d
DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose -f local-prism-node-addon.yml up -d

# test-multitenancy-cloud-agent.yml — despite the "test" name, this is NOT optional/disposable:
# it's the live Cloud Agent (port 8200 / 91.99.4.54:8200) that company-admin-portal uses for ALL
# companies (TechCorp, ACME — see MULTITENANCY_CLOUD_AGENT_URL in server.js). Stopping it breaks
# Company Admin Portal's credential/employee endpoints with ECONNREFUSED (confirmed 2026-07-15).
# It IS one of the heaviest CPU/RAM consumers on this 4-CPU/7.75GB host, so cap it rather than
# skip it — e.g. after `up -d`:
#   docker update --cpus 1.5 --memory 2g --memory-swap 2g multitenancy-test-cloud-agent
DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose -f test-multitenancy-cloud-agent.yml up -d

# Mediator — compose file lives in /opt/project_identuslabel/identus-mediator/ (NOT /root)
DOCKER_API_VERSION=1.44 /usr/local/bin/docker-compose --project-directory /opt/project_identuslabel/identus-mediator -f /opt/project_identuslabel/identus-mediator/docker-compose.yml up -d

# Reload reverse proxy config (Caddy runs inside Docker container identus-cloud-agent-proxy)
docker exec identus-cloud-agent-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

### Application Services (Node.js)
```bash
# Certification Authority (port 3005)
# WARNING: An old CA process from /root/certification-authority may hold port 3005 after a reboot.
# If kill below fails (permission denied), ask a root user to: kill $(lsof -ti :3005)
kill $(lsof -ti :3005) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/certification-authority && set -a && source .env && set +a && nohup node server.js > /opt/project_identuslabel/ca.log 2>&1 &

# Company Admin Portal (port 3010)
kill $(lsof -ti :3010) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/company-admin-portal && PORT=3010 nohup node server.js > /opt/project_identuslabel/company-admin.log 2>&1 &

# Document Service (port 3020) - stateless VP-gated access for ACME
kill $(lsof -ti :3020) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/identus-document-service && PORT=3020 nohup node server.js > /opt/project_identuslabel/document-service.log 2>&1 &

# Alice Wallet (port 3001) - OBSOLETE, do not use
# cd /opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
# fuser -k 3001/tcp && rm -rf .next && yarn dev > /tmp/alice.log 2>&1 &

# IDL Wallet v1 (port 3002) - PRIMARY WALLET (Caddy routes /wallet → 3002)
# ⚠️ FROZEN as of 2026-07-30 (tag `wallet-v1-frozen`) — SECURITY FIXES ONLY, no feature work.
#    v1 runs on a patched fork of the DISCONTINUED @hyperledger/identus-edge-agent-sdk@6.6.0.
#    Its successor package is @hyperledger/identus-sdk (now 8.1.0). v2 is being built on v8;
#    v1 retires once v2 passes kotlin-port/11-acceptance-tests.md.
#    Plan: .claude/plans/ · Background: kotlin-port/13-sdk-version-strategy.md
#
# IMPORTANT: runs as production build (next start), NOT yarn dev
# After any source change you MUST rebuild:
cd /opt/project_identuslabel/idl-wallet && yarn build
kill $(lsof -ti :3002) 2>/dev/null; sleep 1
nohup node_modules/.bin/next start --port 3002 --hostname 0.0.0.0 > /opt/project_identuslabel/idl-wallet.log 2>&1 &

# IDL Wallet v2 (port 3004) - SDK v8 SUCCESSOR, under construction (Caddy: /wallet-v2 → 3004)
# Coexists with frozen v1 on 3002. Storage isolation is a SECURITY property, not a convenience:
# both are served from identuslabel.cz, so they share one browser origin and therefore share
# IndexedDB/localStorage. The ONLY thing keeping v2 out of v1's live user data is the namespace
# constant in idl-wallet-v2/src/config/walletNamespace.ts (v2 = idl2, v1 = idl).
#   INVARIANT — must return nothing but walletNamespace.ts itself:
#     grep -rn "identus-wallet-idl\b\|wallet-idl-\|'idl'" idl-wallet-v2/src/
# NOT on port 3003 — the Caddyfile already claims that for the /test-wallet staging route.
# Caddy route: run `sudo idl-wallet-v2/deploy-caddy-route.sh` (needs root; idempotent).
#
# ⚠️ v2 PATCHES THE SDK AT POSTINSTALL — see "SDK: v2 patches upstream npm" below before
#    upgrading @hyperledger/identus-sdk or debugging a patch that appears not to work.
cd /opt/project_identuslabel/idl-wallet-v2 && yarn build
kill $(lsof -ti :3004) 2>/dev/null; sleep 1
nohup node_modules/.bin/next start --port 3004 --hostname 0.0.0.0 > /opt/project_identuslabel/idl-wallet-v2.log 2>&1 &

# Presentation Deck (port 3040) - static IDL Wallet / DID+VC explainer deck
# Zero-dependency static file server (server.js, built-in http module only).
# Caddy route /presentation* -> 127.0.0.1:3040 already wired in /root/Caddyfile
# (see presentation/deploy-caddy-route.sh — only needs re-running if the route is ever removed).
kill $(lsof -ti :3040) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/presentation && PORT=3040 nohup node server.js > /opt/project_identuslabel/presentation.log 2>&1 &
```

### SDK: IDL Wallet v1 runs on a LOCAL PATCHED FORK, not an npm package

⚠️ **This corrects a long-standing error in this file, which claimed "IDL Wallet uses the SDK via
npm packages." It does not.** `idl-wallet/package.json` declares:

```
"@hyperledger/identus-edge-agent-sdk": "file:../clean-identus-wallet/sdk-v6-test/sdk-ts"
```

That is a **git working tree** at `/opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts`
— upstream `v6.6.0` plus **4 local commits** (`v6.6.0-4-g17799031`) carrying **13 distinct patches**
across 20 files. They are load-bearing: without them, credential offers from Cloud Agent throw,
presentations are signed with the wrong curve, and duplicate-key conflicts break connections.

- Patch set documented: `kotlin-port/01-sdk-gap-analysis.md` Part A
- Patch diff preserved: `kotlin-port/artifacts/sdk-fork.patch`
- Also pushed to `fork/master` on `janskor-cz/identus-edge-wallet`
- Freeze tags: `wallet-v1-frozen` (this repo), `wallet-v1-frozen-sdk` (the fork)

**The path was previously `/root/clean-identus-wallet/...`, which no longer exists** — the tree was
moved to `/opt`. Until fixed (2026-07-30) any `yarn install` in `idl-wallet` would have failed. The
dependency is now a **relative** `file:` path so it survives future moves.

After modifying SDK source, rebuild the SDK and reinstall it into the wallet:
```bash
cd /opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts && yarn build
cd /opt/project_identuslabel/idl-wallet && yarn install --force && yarn build   # then restart 3002
```
Test any dependency change in a **copy** first, never the live tree:
```bash
tar -C idl-wallet -cf - --exclude=node_modules --exclude=.next --exclude=.git . \
  | (mkdir -p /opt/project_identuslabel/.installtest && tar -C /opt/project_identuslabel/.installtest -xf -)
cd /opt/project_identuslabel/.installtest && yarn install && yarn build   # verified working 2026-07-30
```

> **Alice Wallet (port 3001) is obsolete.** Its demos under `sdk-ts/demos/` had their
> `node_modules`/`.next` build artifacts deleted on 2026-07-30 to reclaim 20 GB (disk was at 98%).
> Sources are still git-tracked and on `fork/master`; run `yarn install` in a demo to restore it.

### SDK: v2 patches upstream npm (no fork)

v1 pins a **local patched fork** (above). **v2 does not** — it depends on the published package
(`"@hyperledger/identus-edge-agent-sdk": "npm:@hyperledger/identus-sdk@8.1.0"`), so patches cannot
live in a git tree. They are applied post-install by `idl-wallet-v2/scripts/patch-sdk.js`, wired to
`postinstall` (also runnable as `yarn patch-sdk`).

Each patch is an idempotent, self-verifying **exact string replacement over the shipped minified
bundle** — not a unified diff, which for a one-line 1 MB file would be unreadable and would break
on any upstream rebuild. Re-running is safe. **The script exits 1 rather than skipping when a patch
no longer matches**, so an SDK upgrade fails loudly instead of silently dropping a fix; re-derive
each patch against the new bundle, or delete it if upstream fixed the bug.

Current patches:

| ID | Fixes |
|----|-------|
| `P1` | DIF presentation submissions were signed with an arbitrary key (`getDIDPrivateKeysByDID(...).at(0)` — RxDB sorts by random `uuid`, so ~50% of DIDs drew `master-0`). Master keys are excluded from every PRISM verification relationship, so those VPs passed the SDK's own verifier but failed the authentication-scoped check in `idl-wallet-v2/src/utils/liveIdentityVerification.ts`, breaking live identity verification and the reciprocal identity disclosure in `OOB.tsx`. |

⚠️ **The SDK ships every module twice — ESM `build/*.js` and CJS `build/*.cjs`, with identical
minified identifiers.** `package.json` sets `main: ./build/index.cjs`, and **Next.js bundles the
CJS copy**. Patching only the `.js` chunk builds and deploys cleanly while changing nothing. Always
confirm a patch landed in the built artifact, not just `node_modules`:

```bash
cd /opt/project_identuslabel/idl-wallet-v2
grep -o 'signWithDID([^)]*"AUTHENTICATION_KEY")' .next/static/chunks/pages/_app-*.js
```

### Health Checks
```bash
curl https://identuslabel.cz/_system/health              # Cloud Agent (8000)
curl https://identuslabel.cz/enterprise/_system/health   # Enterprise Agent (8300)
curl http://91.99.4.54:8200/_system/health               # Multitenancy Agent (8200)
curl https://identuslabel.cz/ca/api/health               # CA Server (3005)
curl https://identuslabel.cz/company-admin/api/health    # Company Admin (3010)
curl https://identuslabel.cz/document-service/health     # Document Service (3020)
curl -o /dev/null -w '%{http_code}\n' https://identuslabel.cz/wallet        # IDL Wallet v1 (3002, FROZEN)
curl -o /dev/null -w '%{http_code}\n' https://identuslabel.cz/wallet-v2     # IDL Wallet v2 (3004)
curl -o /dev/null -w '%{http_code}\n' https://identuslabel.cz/presentation  # Presentation Deck (3040)
```

### Testing
```bash
# Wallet tests (Alice Wallet — OBSOLETE, kept for SDK regression testing only)
cd /opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
yarn test              # Run all tests
yarn test:basic        # Basic load test
yarn test:connect-ca   # CA connection test

# E2E tests (Puppeteer) in company-admin-portal
cd /opt/project_identuslabel/company-admin-portal
node test-vc-issuance.js
node test-employee-wallet-creation.js
```

### Viewing Logs
```bash
tail -f /opt/project_identuslabel/idl-wallet.log        # IDL Wallet v1 (frozen)
tail -f /opt/project_identuslabel/idl-wallet-v2.log     # IDL Wallet v2 (SDK v8)
tail -f /opt/project_identuslabel/ca.log                # Certification Authority
tail -f /opt/project_identuslabel/company-admin.log     # Company Admin Portal
tail -f /opt/project_identuslabel/document-service.log  # Document Service
tail -f /opt/project_identuslabel/presentation.log      # Presentation Deck
docker logs identus-mediator-identus-mediator-1 --tail 100  # Mediator
```

## Architecture Overview

### Service Topology
```
                        Caddy Reverse Proxy (HTTPS)
                               ↓
    ┌──────────────────────────┼──────────────────────────┐
    │                          │                          │
Cloud Agent (8000)    Company Admin (3010)    IDL Wallet (3002)
    ↓                          ↓
Mediator (8080)       Enterprise Agent (8300)
    ↓                          ↓
PRISM Node (50053)    Multitenancy Agent (8200)
```

### Key Directories
```
/opt/project_identuslabel/idl-wallet/              # IDL Wallet — PRIMARY wallet (port 3002)
  └── src/
      ├── actions/                                 # Redux async thunks
      ├── components/                              # React components
      ├── pages/                                   # Next.js pages (credentials.tsx, connections.tsx, …)
      └── utils/                                   # Utilities (crypto, storage, credentialTypeDetector)

/opt/project_identuslabel/company-admin-portal/    # Multi-company management (Express.js)
  ├── server.js                                    # Main server
  ├── lib/                                         # Core libraries
  │   ├── EmployeeWalletManager.js                 # 12-step employee onboarding
  │   ├── DocumentRegistry.js                      # Zero-knowledge document index
  │   ├── ReEncryptionService.js                   # Clearance-based access control
  │   ├── IagonStorageClient.js                    # Decentralized storage
  │   └── DocxRedactionService.js                  # DOCX clearance redaction
  └── public/                                      # Frontend assets

/opt/project_identuslabel/certification-authority/ # CA server with secure portal

/opt/project_identuslabel/identus-document-service/ # Stateless VP-gated document service (port 3020)

/opt/project_identuslabel/presentation/            # Static DID+VC explainer deck (port 3040)
  ├── server.js                                    # Zero-dependency static file server
  ├── index.html                                   # Deck content
  └── deploy-caddy-route.sh                        # One-time Caddy route setup (needs /root access)

/opt/project_identuslabel/clean-identus-wallet/sdk-v6-test/sdk-ts/  # PATCHED SDK FORK — v1 depends on this (file: dep)
  └── demos/alice-wallet/                          # Alice Wallet — OBSOLETE, do not use
```

### SDK Architecture (5 Building Blocks)
The Hyperledger Identus SDK has 5 core modules:
1. **Apollo** - Cryptographic operations (Ed25519, X25519, Secp256k1)
2. **Castor** - DID management (PRISM DIDs, Peer DIDs)
3. **Pluto** - Storage (IndexedDB wrapper for credentials, DIDs, messages)
4. **Mercury** - DIDComm messaging (encrypted message transport)
5. **Pollux** - Verifiable Credential handling (JWT-VC, SD-JWT)

### Wallet State Management Pattern
**CRITICAL**: Both database AND Redux state must be updated:
```typescript
// LAYER 1: Persist to IndexedDB via Pluto
await agent.pluto.deleteMessage(message.id);
// LAYER 2: Update Redux state
dispatch(messagesRemoved({ ids: [message.id] }));
// Missing either layer causes state desync bugs
```

### Storage Isolation
Multiple wallets use prefixed storage to prevent collisions:
- IndexedDB: `identus-wallet-alice`, `identus-wallet-bob`
- localStorage: `wallet-alice-*`, `wallet-bob-*`
- Handled by `src/utils/prefixedStorage.ts`

## Security Clearance Levels
Standard hierarchy (used across all systems):
| Level | Name | Numeric |
|-------|------|---------|
| 0 | UNCLASSIFIED | 0 |
| 1 | INTERNAL | 1 |
| 2 | CONFIDENTIAL | 2 |
| 3 | RESTRICTED | 3 |
| 4 | SECRET | 4 |

Legacy mappings exist for backward compatibility: `TOP-SECRET` / `TOP_SECRET` / `TOPSECRET` → `SECRET` (renamed Mar 21, 2026). `UNCLASSIFIED` → level 0.

## Known Development Issues

1. **Browser cache**: Always hard refresh (Ctrl+Shift+R) after SDK/wallet changes
2. **SDK deployment**: Must manually copy build to `node_modules` (see SDK workflow above)
3. **Cloud Agent PRISM DID validation**: Long-form PRISM DIDs disabled for credential requests (workaround active in `actions/index.ts`)
4. **StatusList2021 delay**: Revocation takes 30min-hours (eventual consistency by design)
5. **WebAssembly memory**: Refresh wallet if it slows down (WASM memory accumulation)

## Code Patterns

### Adding New Redux Actions
```typescript
// 1. Define in src/actions/index.ts
export const myAction = createAsyncThunk(
  'myAction',
  async (params, { getState }) => {
    const { app } = getState() as RootState;
    // Use app.agent for SDK operations
    return result;
  }
);

// 2. Handle in src/reducers/app.ts
.addCase(myAction.fulfilled, (state, action) => {
  // Update state
});
```

### DIDComm Message Handling
Messages flow through `src/actions/index.ts`:
- `processMessages` - Polls mediator for new messages
- Message types handled: `OfferCredential`, `RequestPresentation`, `IssueCredential`, etc.
- Each type has dedicated handler in SDK (`src/edge-agent/didcomm/`)

### Enterprise Agent Communication
```typescript
// Get ServiceConfiguration VC for API credentials
const serviceConfig = getServiceConfigurationFromCredentials(credentials);
// Use apiKey and baseUrl from serviceConfig for REST calls
```

### Service-Linked VC Convention
`EmployeeRole` (Company Admin) VCs still carry a `serviceUrl` field in `credentialSubject`
(`https://identuslabel.cz/company-admin/employee-portal-login.html?email=...`), but the wallet no
longer uses it to auto-launch anything — the **Browser tab** (`/browser`) that used to scan
credentials for `serviceUrl` and display a launch card was removed as obsolete once all
interactive service access moved to the DIDComm Access Request Protocol below.
`serviceUrl` is only read now in `connections.tsx`'s `handleEnterprisePortalLogin` to derive the
company-admin base URL for HTTP grant polling — it is not a UI entry point.

**All interactive service access (CA pages, the employee portal, document-service access) goes
through the DIDComm Access Request protocol, not URL links in VCs** — see below.

### DIDComm Access Request Protocol (`service-access/1.0`)
CA-protected pages (and the company-admin employee portal, and document-service document access)
are accessed via one shared DIDComm protocol, not URL links in VCs. Full spec:
`packages/service-access-didcomm/PROTOCOL.md`.

This replaced three independent, hand-duplicated implementations (CA's and company-admin's own
copy-pasted `DIDCommCommandService.js`, and document-service's separate `document-access/1.0`)
that had drifted apart — most notably, CA/company-admin trusted Cloud Agent's internal
`PresentationVerified` state alone with no independent signature/issuer check, and the wallet's
trust decision was a cached flag derived from a mutable, locally-editable connection display
name rather than the sender's actual DID. All three services now share one library
(`packages/service-access-didcomm`) with real ES256K verification, a fail-closed DID-keyed trust
registry, and declarative claim extraction.

**To request access** (from Connections tab or Chat header):
1. User clicks **🔓 Request Access** → selects a capability from dropdown
2. Wallet sends JSON envelope over DIDComm BasicMessage:
   ```json
   { "type": "https://identuslabel.cz/protocols/service-access/1.0/request",
     "id": "ar-...", "body": { "capability": "security-clearance" } }
   ```
3. Service sends a VP proof request; user approves in wallet
4. Service verifies (signature + fail-closed trust registry) → sends grant envelope:
   ```json
   { "type": "https://identuslabel.cz/protocols/service-access/1.0/grant", "thid": "ar-...",
     "body": { "capability": "...", "mode": "redirect", "accessUrl": "https://.../api/access?token=UUID", "label": "...", ... } }
   ```
   (`mode: "payload"` capabilities — e.g. document-access — carry capability-specific data in
   `body.result` instead of `accessUrl`.)
5. `GlobalGrantWatcher` in `idl-wallet/src/pages/_app.tsx` detects the grant, checks the
   **sender's actual DID** against `idl-wallet/src/config/serviceTrust.ts` /
   per-connection `capabilities` (see `connectionMetadata.ts`), and auto-opens `CAPortalModal`
   iFrame for `mode: redirect` grants.

**Adding a new capability** — two places:
1. The service's own `server.js` (or equivalent) — add an entry to the `capabilities` object
   passed to `new ServiceAccessService({...})` (see `certification-authority/server.js` or
   `company-admin-portal/server.js` for examples):
   ```javascript
   'my-capability': { label: 'My Page', icon: '📄', mode: 'redirect', redirectPath: '/ca/my-page',
     trustedIssuerVcType: 'RealPerson',
     proofSpec: { proofs: [{ schemaId: '...', trustIssuers: [] }], goalCode: '...', goal: '...', claims: {} } }
   ```
2. The wallet needs a `TrustedServiceEntry` in `idl-wallet/src/config/serviceTrust.ts` (or a
   `capabilities` entry written to `ConnectionMetadata` at connection-establishment time) naming
   this capability under the service's DID — see `serviceTrust.ts`'s doc comment for the two-tier
   model (deployment-pinned vs. per-connection).

**Key files:**
- `packages/service-access-didcomm/` — shared library (all three services depend on it via
  a `file:` dependency); `PROTOCOL.md` is the spec.
- `idl-wallet/src/pages/_app.tsx` → `GlobalGrantWatcher` — auto-opens portal on trusted grant
- `idl-wallet/src/utils/serviceAccessGrant.ts` — grant parsing + DID-keyed trust check, shared
  by `_app.tsx`, `Chat.tsx`, and `DocumentAccessRequestor.tsx`
- `idl-wallet/src/config/serviceTrust.ts` — wallet-side trust anchors
- `idl-wallet/src/utils/CAPortalContext.tsx` → `pendingAccessRequest` — drives login status modal
- `idl-wallet/src/components/AccessRequestStatusModal.tsx` — login-in-progress UI

### Enterprise Employee Portal Login

The employee portal uses the same `service-access/1.0` protocol but goes through the **enterprise
agent** channel (not personal wallet) — its grant is delivered via both a DIDComm message and an
HTTP-pollable transport (`GET /api/enterprise-portal/grant-status`, backed by
`ServiceAccessService.consumeGrant`), since the wallet's own SDK-managed DIDComm inbox can't
observe messages on an enterprise-agent-managed connection. The shared library's
`ClaimExtractor` reads **all VCs** from the VP — not just the first — and returns:

```javascript
{ email, role, department, prismDid,        // always present (EmployeeRole)
  cisTraining: { hasValidTraining, expiryDate, ... } | null,
  clearance:   { hasClearanceVC, level }    | null }
```

Portal routing is determined strictly by what the employee presented:
- No CISTraining VC → training page
- CISTraining VC → dashboard
- SecurityClearanceGrant VC → clearance access on dashboard

No server-side fallback lookups are performed — the employee's VC selection is the authority.

**PRISM DID format:** The DB stores short-form DIDs (`did:prism:<hash>`); JWT `sub` fields carry long-form (`did:prism:<hash>:<key-material>`). Use `prismDidsMatch(a, b)` in `server.js` for all PRISM DID comparisons — it compares only the hash segment.

**Enterprise vs personal connection detection:** Use `isEnterpriseAgentConnection(theirDid)` in `server.js` — decodes the `.S` segment of `did:peer:2` DIDs to check the service URI. Enterprise connections contain `enterprise` in the URI; personal wallet connections route through the mediator.

## Service URLs

| Service | URL | Port |
|---------|-----|------|
| IDL Wallet v1 | https://identuslabel.cz/wallet | 3002 — **FROZEN** |
| IDL Wallet v2 | https://identuslabel.cz/wallet-v2 | 3004 — SDK v8, in progress |
| CA Portal | https://identuslabel.cz/ca | 3005 |
| Company Admin | https://identuslabel.cz/company-admin | 3010 |
| Document Service | https://identuslabel.cz/document-service | 3020 |
| Presentation Deck | https://identuslabel.cz/presentation | 3040 |
| Cloud Agent | https://identuslabel.cz/cloud-agent | 8000 |
| Enterprise Agent | https://identuslabel.cz/enterprise | 8300 |
| Multitenancy Agent | http://91.99.4.54:8200 | 8200 |
| Mediator | https://identuslabel.cz/mediator | 8080 |
| Alice Wallet | https://identuslabel.cz/alice | 3001 — **OBSOLETE** |

## Commit Message Format
```
<type>(<scope>): <subject>

Types: feat, fix, docs, refactor, test, chore, perf, security
Scope: wallet, sdk, ca, company-admin, docs
```

## Additional Documentation

- **Project Status & Changelog**: [PROJECT_STATUS.md](./PROJECT_STATUS.md)
- **Development History**: [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md)
- **Feature Documentation**: [docs/features/](./docs/features/)
- **Infrastructure Docs**: [docs/infrastructure/](./docs/infrastructure/)
