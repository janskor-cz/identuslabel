# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

### Infrastructure Services (Docker)
```bash
# Start all infrastructure (run from /root — docker-compose files live there)
docker-compose -f cloud-agent-with-reverse-proxy.yml up -d
docker-compose -f identus-mediator/docker-compose.yml up -d
docker-compose -f enterprise-cloud-agent.yml up -d
docker-compose -f test-multitenancy-cloud-agent.yml up -d
docker-compose -f local-prism-node-addon.yml up -d

# Reload reverse proxy config (Caddy runs inside Docker container identus-cloud-agent-proxy)
docker exec identus-cloud-agent-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

### Application Services (Node.js)
```bash
# Certification Authority (port 3005)
kill $(lsof -ti :3005) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/certification-authority && PORT=3005 nohup node server.js > /opt/project_identuslabel/ca.log 2>&1 &

# Company Admin Portal (port 3010)
kill $(lsof -ti :3010) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/company-admin-portal && PORT=3010 nohup node server.js > /opt/project_identuslabel/company-admin.log 2>&1 &

# Document Service (port 3020) - stateless VP-gated access for ACME
kill $(lsof -ti :3020) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/identus-document-service && PORT=3020 nohup node server.js > /opt/project_identuslabel/document-service.log 2>&1 &

# Alice Wallet (port 3001) - OBSOLETE, do not use
# cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
# fuser -k 3001/tcp && rm -rf .next && yarn dev > /tmp/alice.log 2>&1 &

# IDL Wallet (port 3002) - PRIMARY WALLET (Caddy routes /wallet → 3002)
# IMPORTANT: runs as production build (next start), NOT yarn dev
# After any source change you MUST rebuild:
cd /opt/project_identuslabel/idl-wallet && yarn build
kill $(lsof -ti :3002) 2>/dev/null; sleep 1
nohup node_modules/.bin/next start --port 3002 --hostname 0.0.0.0 > /opt/project_identuslabel/idl-wallet.log 2>&1 &
```

### SDK Development (OBSOLETE — Alice Wallet only)
> **Note**: Alice Wallet (port 3001) is obsolete. IDL Wallet uses the SDK via npm packages.
> This workflow only applies if modifying SDK source for legacy Alice Wallet testing.

After modifying SDK source in `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/src/`:
```bash
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts
yarn build
cp -r build/* demos/alice-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
cd demos/alice-wallet && rm -rf .next && yarn dev
# Users must hard refresh browser (Ctrl+Shift+R)
```

### Health Checks
```bash
curl https://identuslabel.cz/_system/health              # Cloud Agent (8000)
curl https://identuslabel.cz/enterprise/_system/health   # Enterprise Agent (8300)
curl http://91.99.4.54:8200/_system/health               # Multitenancy Agent (8200)
curl https://identuslabel.cz/ca/api/health               # CA Server (3005)
curl https://identuslabel.cz/company-admin/api/health    # Company Admin (3010)
curl https://identuslabel.cz/document-service/health     # Document Service (3020)
```

### Testing
```bash
# Wallet tests (Alice Wallet — OBSOLETE, kept for SDK regression testing only)
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
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
tail -f /opt/project_identuslabel/idl-wallet.log        # IDL Wallet (primary)
tail -f /opt/project_identuslabel/ca.log                # Certification Authority
tail -f /opt/project_identuslabel/company-admin.log     # Company Admin Portal
tail -f /opt/project_identuslabel/document-service.log  # Document Service
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
      ├── pages/                                   # Next.js pages (browser.tsx, credentials.tsx, …)
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

/root/clean-identus-wallet/sdk-v6-test/sdk-ts/     # Identus SDK source (OBSOLETE — Alice Wallet only)
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
Any VC whose purpose is to grant access to a service should include these fields in `credentialSubject`:
```json
{
  "serviceUrl": "https://identuslabel.cz/ca/login?uid=...",
  "serviceName": "Certification Authority",
  "serviceIcon": "🔐"
}
```
The IDL Wallet **Browser tab** (`/browser`) scans all credentials for `serviceUrl` and auto-displays the service — no wallet code changes needed per new service type. `serviceName` and `serviceIcon` are optional but recommended.

Current issuers baking this in:
- `RealPersonIdentity` (CA server) — URL includes `uid` param for auto-login
- `EmployeeRole` (Company Admin) — URL includes `email` param for portal login

## Service URLs

| Service | URL | Port |
|---------|-----|------|
| IDL Wallet | https://identuslabel.cz/wallet | 3002 |
| CA Portal | https://identuslabel.cz/ca | 3005 |
| Company Admin | https://identuslabel.cz/company-admin | 3010 |
| Document Service | https://identuslabel.cz/document-service | 3020 |
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
