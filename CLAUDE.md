# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

### Infrastructure Services (Docker)
```bash
# Start all infrastructure (run from /root)
docker-compose -f cloud-agent-with-reverse-proxy.yml up -d
docker-compose -f identus-mediator/docker-compose.yml up -d
docker-compose -f enterprise-cloud-agent.yml up -d
docker-compose -f test-multitenancy-cloud-agent.yml up -d
docker-compose -f local-prism-node-addon.yml up -d

# Start reverse proxy
pkill caddy; /usr/local/bin/caddy run --config /root/Caddyfile > /tmp/caddy.log 2>&1 &
```

### Application Services (Node.js)
```bash
# Certification Authority (port 3005)
cd /root/certification-authority && PORT=3005 node server.js > /tmp/ca.log 2>&1 &

# Company Admin Portal (port 3010)
cd /root/company-admin-portal && PORT=3010 node server.js > /tmp/company-admin.log 2>&1 &

# Alice Wallet (port 3001) - PRIMARY DEVELOPMENT WALLET
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
fuser -k 3001/tcp && rm -rf .next && yarn dev > /tmp/alice.log 2>&1 &

# IDL Wallet (port 3000)
cd /root/idl-wallet && yarn dev
```

### SDK Development (CRITICAL WORKFLOW)
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
```

### Testing
```bash
# Wallet tests
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
yarn test              # Run all tests
yarn test:basic        # Basic load test
yarn test:connect-ca   # CA connection test

# E2E tests (Puppeteer) in company-admin-portal
cd /root/company-admin-portal
node test-vc-issuance.js
node test-employee-wallet-creation.js
```

### Viewing Logs
```bash
tail -f /tmp/alice.log         # Alice Wallet
tail -f /tmp/ca.log            # Certification Authority
tail -f /tmp/company-admin.log # Company Admin Portal
docker logs identus-mediator-identus-mediator-1 --tail 100  # Mediator
```

## Architecture Overview

### Service Topology
```
                        Caddy Reverse Proxy (HTTPS)
                               ↓
    ┌──────────────────────────┼──────────────────────────┐
    │                          │                          │
Cloud Agent (8000)    Company Admin (3010)    Alice Wallet (3001)
    ↓                          ↓                          ↓
Mediator (8080)       Enterprise Agent (8300)    IDL Wallet (3000)
    ↓                          ↓
PRISM Node (50053)    Multitenancy Agent (8200)
```

### Key Directories
```
/root/clean-identus-wallet/sdk-v6-test/sdk-ts/     # Identus SDK source (modified)
  └── demos/alice-wallet/                          # Primary wallet (Next.js)
      └── src/
          ├── actions/                             # Redux async thunks
          ├── components/                          # React components
          ├── pages/                               # Next.js pages
          └── utils/                               # Utilities (crypto, storage)

/root/company-admin-portal/                        # Multi-company management (Express.js)
  ├── server.js                                    # Main server (~3500 lines)
  ├── lib/                                         # Core libraries
  │   ├── EmployeeWalletManager.js                 # 11-step employee onboarding
  │   ├── DocumentRegistry.js                      # Zero-knowledge document index
  │   ├── ReEncryptionService.js                   # Clearance-based access control
  │   ├── IagonStorageClient.js                    # Decentralized storage
  │   └── DocxRedactionService.js                  # DOCX clearance redaction
  └── public/                                      # Frontend assets

/root/certification-authority/                     # CA server with secure portal

/root/idl-wallet/                                  # Alternative wallet implementation
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
| 1 | INTERNAL | 1 |
| 2 | CONFIDENTIAL | 2 |
| 3 | RESTRICTED | 3 |
| 4 | TOP-SECRET | 4 |

Legacy mappings exist for backward compatibility (UNCLASSIFIED→INTERNAL, SECRET→RESTRICTED).

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

## Service URLs

| Service | URL | Port |
|---------|-----|------|
| Alice Wallet | https://identuslabel.cz/alice | 3001 |
| CA Portal | https://identuslabel.cz/ca | 3005 |
| Company Admin | https://identuslabel.cz/company-admin | 3010 |
| Cloud Agent | https://identuslabel.cz/cloud-agent | 8000 |
| Enterprise Agent | https://identuslabel.cz/enterprise | 8300 |
| Multitenancy Agent | http://91.99.4.54:8200 | 8200 |
| Mediator | https://identuslabel.cz/mediator | 8080 |

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
