# Hyperledger Identus SSI Infrastructure

**Production Self-Sovereign Identity (SSI) Infrastructure**

A complete, production-ready implementation of Self-Sovereign Identity infrastructure using Hyperledger Identus (formerly Atala PRISM), featuring hierarchical credential issuance, end-to-end encrypted communication, W3C-compliant Verifiable Credentials, and VC-gated document access.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Hyperledger Identus](https://img.shields.io/badge/Hyperledger-Identus-2F3134)](https://www.hyperledger.org/projects/identus)
[![W3C VC](https://img.shields.io/badge/W3C-Verifiable%20Credentials-orange)](https://www.w3.org/TR/vc-data-model/)
[![DIDComm v2](https://img.shields.io/badge/DIDComm-v2.0-green)](https://identity.foundation/didcomm-messaging/spec/)

---

## Features

### Core SSI Capabilities

- **Hierarchical Credential Issuance**: Multi-tier trust model with Certification Authority and Enterprise/Company agents
- **DIDComm v2 Messaging**: Secure, encrypted peer-to-peer communication via mediator
- **W3C Verifiable Credentials**: Standards-compliant JWT-VC issuance, presentation, and verification
- **StatusList2021 Revocation**: Privacy-preserving credential revocation using compressed bitstrings
- **Edge Wallet (IDL Wallet)**: Browser-based wallet with IndexedDB storage for user-controlled identity

### Security & Privacy

- **Three-Tier CMK Encryption**: Company Master Key architecture for document access control
- **Zero-Knowledge Architecture**: Client-side decryption ensures server cannot read encrypted content
- **Security Clearance Access Control**: Clearance-based document and content access (UNCLASSIFIED → SECRET)
- **HTTPS Domain Access**: Caddy reverse proxy with automatic Let's Encrypt SSL
- **Client-Side Key Generation**: Ed25519 and X25519 keys never leave user's device
- **Re-Encryption Service**: Clearance-level-based re-encryption for document access delegation

### Production Features

- **Service-Linked VCs**: Credentials embed `serviceUrl` for automatic service discovery in the wallet Browser tab
- **VC-Gated Document Service**: Verifiable Presentation required to access encrypted documents
- **Company Admin Portal**: Multi-company DID management and employee onboarding (12-step workflow)
- **Iagon Decentralized Storage**: Encrypted wallet backup/restore via Iagon storage network
- **Mediator Service**: WebSocket-based message routing for offline delivery
- **PRISM Node**: Local VDR for decentralized identifier resolution
- **Health Monitoring**: Comprehensive health checks for all services

---

## Service URLs

| Service | URL | Port | Status |
|---------|-----|------|--------|
| **IDL Wallet** | `https://identuslabel.cz/wallet` | 3002 | ✅ Primary wallet |
| **CA Portal** | `https://identuslabel.cz/ca` | 3005 | ✅ Operational |
| **Company Admin Portal** | `https://identuslabel.cz/company-admin` | 3010 | ✅ Operational |
| **Document Service** | `https://identuslabel.cz/document-service` | 3020 | ✅ Operational |
| **Cloud Agent API** | `https://identuslabel.cz/cloud-agent` | 8000 | ✅ Operational |
| **Enterprise Agent** | `https://identuslabel.cz/enterprise` | 8300 | ✅ Operational |
| **Mediator** | `https://identuslabel.cz/mediator` | 8080 | ✅ Operational |
| **Multitenancy Agent** | `http://91.99.4.54:8200` (not proxied) | 8200 | ✅ Operational |
| **PRISM Node** | `91.99.4.54:50053` | 50053 | ✅ Operational (gRPC) |
| Alice Wallet | `https://identuslabel.cz/alice` | 3001 | ❌ Obsolete |

> **Note**: Alice Wallet (port 3001) is obsolete. All development and usage goes through **IDL Wallet** (port 3002).

---

## Architecture

### Service Topology

```
                        Caddy Reverse Proxy (HTTPS — identuslabel.cz)
                                         │
        ┌────────────┬──────────────┬────┴──────────┬─────────────────┐
        │            │              │               │                 │
  IDL Wallet    CA Portal    Company Admin    Document Service   Cloud Agent
   (3002)        (3005)        (3010)            (3020)            (8000)
        │                          │               │
        │                   Enterprise Agent   Iagon Storage
        │                        (8300)
        │
   Mediator (8080)
        │
   PRISM Node (50053)
```

### Key Components

| Component | Path | Description |
|-----------|------|-------------|
| **IDL Wallet** | `/opt/project_identuslabel/idl-wallet/` | Primary browser wallet (Next.js, port 3002) |
| **Certification Authority** | `/opt/project_identuslabel/certification-authority/` | CA server with secure portal (Express.js, port 3005) |
| **Company Admin Portal** | `/opt/project_identuslabel/company-admin-portal/` | Multi-company management (Express.js, port 3010) |
| **Document Service** | `/opt/project_identuslabel/identus-document-service/` | Stateless VP-gated document access (Express.js, port 3020) |

### Trust Hierarchy

```
Certification Authority DID (CA)
  │
  ├─ Issues: RealPersonIdentity (with serviceUrl for auto-login)
  ├─ Issues: SecurityClearance (UNCLASSIFIED → SECRET)
  ├─ Issues: EmployeeRole (with serviceUrl for company portal)
  ├─ Issues: CompanyIdentity
  │
  ▼
End Users (IDL Wallet)
  │
  └─ Present VPs to access services, documents, and encrypted content
```

### SDK Architecture (5 Building Blocks)

The Hyperledger Identus SDK used by IDL Wallet has 5 core modules:

1. **Apollo** — Cryptographic operations (Ed25519, X25519, Secp256k1)
2. **Castor** — DID management (PRISM DIDs, Peer DIDs)
3. **Pluto** — Storage (IndexedDB wrapper for credentials, DIDs, messages)
4. **Mercury** — DIDComm messaging (encrypted message transport)
5. **Pollux** — Verifiable Credential handling (JWT-VC, SD-JWT)

---

## Security Clearance Levels

Standard hierarchy used across all systems:

| Level | Name | Numeric |
|-------|------|---------|
| 0 | UNCLASSIFIED | 0 |
| 1 | INTERNAL | 1 |
| 2 | CONFIDENTIAL | 2 |
| 3 | RESTRICTED | 3 |
| 4 | SECRET | 4 |

> Legacy note: `TOP-SECRET` was renamed to `SECRET` in March 2026. Legacy aliases (`TOP_SECRET`, `TOPSECRET`) are still accepted for backward compatibility.

---

## Key Use Cases

### 1. Identity Credential Issuance

**Flow**: CA sends VC offer via DIDComm → User accepts in IDL Wallet → CA approves → Credential stored in wallet

**Credential Types**:
- `RealPersonIdentity` — Name, email, profile photo; includes `serviceUrl` for CA auto-login
- `SecurityClearance` — Clearance level (UNCLASSIFIED through SECRET)
- `EmployeeRole` — Employee ID, department, role; includes `serviceUrl` for company portal login
- `CompanyIdentity` — Company registration, jurisdiction, authorized issuer status

### 2. Service Discovery via Browser Tab

The IDL Wallet **Browser tab** (`/browser`) automatically scans all held credentials for the `serviceUrl` field and displays linked services — no wallet code changes needed per new service type.

Any VC granting service access should include:
```json
{
  "credentialSubject": {
    "serviceUrl": "https://identuslabel.cz/ca/login?uid=...",
    "serviceName": "Certification Authority",
    "serviceIcon": "🔐"
  }
}
```

### 3. VC-Gated Document Access

**Flow**: User presents VP → Document Service validates clearance level → Returns encrypted document content

- **Document Service** (port 3020): Stateless, validates VP on every request
- **Three-Tier CMK**: Company Master Key architecture controls document encryption
- **Re-Encryption**: Clearance-based content access delegation via `ReEncryptionService`

### 4. Employee Onboarding

**Company Admin Portal** runs a 12-step onboarding workflow (`EmployeeWalletManager`):
1. Creates company DID
2. Issues `EmployeeRole` VC to new employee wallet
3. Registers employee in enterprise agent tenant
4. Provisions document access based on clearance level

### 5. Credential Revocation

**Flow**: CA revokes credential → StatusList updated → Verifiers check public endpoint

- **Immediate**: Database `is_canceled` flag (0–1 second)
- **Eventual**: StatusList2021 bitstring update (30 minutes – several hours by design)
- **Public Verification**: `/credential-status/{id}` (no authentication required)
- **Privacy**: StatusLists bundle 131,072 credentials

---

## Development

### Prerequisites

- Docker 20.10+ and Docker Compose
- Node.js 18+ and Yarn 1.22+
- Domain with DNS pointing to server (for HTTPS)

### Starting Services

```bash
# Infrastructure (Docker — run from /root)
docker-compose -f cloud-agent-with-reverse-proxy.yml up -d
docker-compose -f identus-mediator/docker-compose.yml up -d
docker-compose -f enterprise-cloud-agent.yml up -d
docker-compose -f test-multitenancy-cloud-agent.yml up -d
docker-compose -f local-prism-node-addon.yml up -d

# Reload Caddy config
docker exec identus-cloud-agent-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Certification Authority (port 3005)
kill $(lsof -ti :3005) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/certification-authority && PORT=3005 nohup node server.js > /opt/project_identuslabel/ca.log 2>&1 &

# Company Admin Portal (port 3010)
kill $(lsof -ti :3010) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/company-admin-portal && PORT=3010 nohup node server.js > /opt/project_identuslabel/company-admin.log 2>&1 &

# Document Service (port 3020)
kill $(lsof -ti :3020) 2>/dev/null; sleep 1
cd /opt/project_identuslabel/identus-document-service && PORT=3020 nohup node server.js > /opt/project_identuslabel/document-service.log 2>&1 &

# IDL Wallet (port 3002) — must build before starting
cd /opt/project_identuslabel/idl-wallet && yarn build
kill $(lsof -ti :3002) 2>/dev/null; sleep 1
nohup node_modules/.bin/next start --port 3002 --hostname 0.0.0.0 > /opt/project_identuslabel/idl-wallet.log 2>&1 &
```

> **Important**: IDL Wallet runs as a production build (`next start`), not `yarn dev`. After any source change, run `yarn build` and restart.

### Viewing Logs

```bash
tail -f /opt/project_identuslabel/idl-wallet.log        # IDL Wallet (primary)
tail -f /opt/project_identuslabel/ca.log                # Certification Authority
tail -f /opt/project_identuslabel/company-admin.log     # Company Admin Portal
tail -f /opt/project_identuslabel/document-service.log  # Document Service
docker logs identus-mediator-identus-mediator-1 --tail 100  # Mediator
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

### E2E Tests

```bash
cd /opt/project_identuslabel/company-admin-portal
node test-vc-issuance.js
node test-employee-wallet-creation.js
```

---

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Browser cache** | Updates not appearing | Hard refresh: `Ctrl+Shift+R` |
| **Popup blocked** | Wallet doesn't open | Allow popups for CA domain |
| **Connection fails** | Invitation doesn't work | Check mediator: `curl -I https://identuslabel.cz/mediator/` |
| **WASM slowdown** | Wallet slows down over time | Refresh the wallet tab |
| **StatusList delay** | Revocation not visible immediately | Wait 30+ min (eventual consistency by design) |
| **IDL Wallet stale** | Changes not reflected | Rebuild: `yarn build` then restart |

---

## Standards Compliance

- **W3C Verifiable Credentials Data Model 1.0**
- **W3C Decentralized Identifiers (DIDs) v1.0**
- **W3C StatusList2021** (Bitstring Status List)
- **DIDComm Messaging v2.0**
- **X25519** Elliptic Curve Diffie-Hellman (RFC 7748)
- **Ed25519** Digital Signatures (RFC 8032)

---

## External Resources

- **Hyperledger Identus Docs**: https://docs.atalaprism.io/
- **SDK Repository**: https://github.com/hyperledger/identus-edge-agent-sdk-ts
- **Cloud Agent**: https://github.com/hyperledger/identus-cloud-agent
- **W3C Verifiable Credentials**: https://www.w3.org/TR/vc-data-model/
- **DIDComm v2 Spec**: https://identity.foundation/didcomm-messaging/spec/

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

## Status

**Last Updated**: 2026-05-11 | **Production Status**: Fully Operational

| Component | Version |
|-----------|---------|
| Cloud Agent | 2.0.0 |
| Edge Agent SDK | 6.6.0 |
| Mediator | Latest stable |
| PRISM Node | Latest stable |

**Recent milestones**:
- ✅ Three-tier CMK encryption architecture implemented
- ✅ VP-gated Document Service deployed (port 3020)
- ✅ Service-linked VC convention + Browser tab auto-discovery
- ✅ Iagon backup/restore (username+password login)
- ✅ All mocked flows replaced with real implementations
- ✅ IDL Wallet is primary; Alice Wallet decommissioned
