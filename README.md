# Hyperledger Identus SSI Infrastructure

**Production Self-Sovereign Identity (SSI) Infrastructure**

A complete, production-ready implementation of Self-Sovereign Identity infrastructure using Hyperledger Identus (formerly Atala PRISM), featuring hierarchical credential issuance, end-to-end encrypted communication, and W3C-compliant Verifiable Credentials.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Hyperledger Identus](https://img.shields.io/badge/Hyperledger-Identus-2F3134)](https://www.hyperledger.org/projects/identus)
[![W3C VC](https://img.shields.io/badge/W3C-Verifiable%20Credentials-orange)](https://www.w3.org/TR/vc-data-model/)
[![DIDComm v2](https://img.shields.io/badge/DIDComm-v2.0-green)](https://identity.foundation/didcomm-messaging/spec/)

---

## Features

### Core SSI Capabilities

- **Hierarchical Credential Issuance**: Multi-tier trust model with Top-Level Issuer and Certification Authority
- **DIDComm v2 Messaging**: Secure, encrypted peer-to-peer communication
- **W3C Verifiable Credentials**: Standards-compliant credential issuance and verification
- **StatusList2021 Revocation**: Privacy-preserving credential revocation using compressed bitstrings
- **Edge Wallet**: Browser-based wallet with IndexedDB storage for user-controlled identity

### Security & Privacy

- **End-to-End Encryption**: X25519 ECDH with XSalsa20-Poly1305 authenticated encryption
- **Zero-Knowledge Architecture**: Client-side decryption ensures server cannot read encrypted content
- **Progressive Disclosure**: Security clearance-based content access control
- **HTTPS Domain Access**: Caddy reverse proxy with automatic Let's Encrypt SSL
- **Client-Side Key Generation**: Ed25519 and X25519 keys never leave user's device

### Production Features

- **HTTPS Deployment**: Domain-based access via `identuslabel.cz` with automatic SSL
- **Mediator Service**: WebSocket-based message routing for offline delivery
- **PRISM Node**: Local VDR for decentralized identifier resolution
- **Health Monitoring**: Comprehensive health checks for all services
- **Fail2ban Protection**: SSH brute-force prevention with automatic IP banning

---

## Quick Start

### Prerequisites

- Ubuntu 20.04+ or Debian 11+
- Docker 20.10+
- Docker Compose 1.29+
- Node.js 18+
- Yarn 1.22+
- Domain with DNS pointing to server (for HTTPS)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/hyperledger-identus-ssi.git
   cd hyperledger-identus-ssi
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   nano .env  # Update SERVER_IP, SERVER_DOMAIN, and passwords
   ```

3. **Run installation script**:
   ```bash
   cd infrastructure/scripts
   chmod +x install.sh
   ./install.sh
   ```

4. **Verify installation**:
   ```bash
   ./health-check.sh
   ```

### Access Points

| Service | URL | Purpose | Status |
|---------|-----|---------|--------|
| **CA Portal** | `https://identuslabel.cz/ca` | Certification Authority admin interface | ✅ Operational |
| **Alice Wallet** | `https://identuslabel.cz/alice` | Primary development wallet | ✅ Operational |
| **Secure Portal** | `https://identuslabel.cz/ca/dashboard` | VC-authenticated content portal | ✅ Operational |
| **Cloud Agent API** | `https://identuslabel.cz/cloud-agent` | Main CA Cloud Agent REST API | ✅ Operational |
| **Enterprise Agent** | `https://identuslabel.cz/enterprise` | Enterprise multitenancy Cloud Agent | ✅ Operational |
| **Company Admin Portal** | `https://identuslabel.cz/company-admin` | Company DID and employee management | ✅ Operational |
| **Mediator** | `https://identuslabel.cz/mediator` | DIDComm message routing service | ✅ Operational |
| **Multitenancy Agent** | Internal: `http://91.99.4.54:8200` (not proxied) | Inter-company multitenancy | ✅ Operational |
| **PRISM Node** | `91.99.4.54:50053` | VDR/blockchain layer (gRPC) | ✅ Operational |

**Note**: Bob Wallet decommissioned November 9, 2025. All development and testing should use Alice Wallet only.

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                              │
│                     ┌──────────────┐                             │
│                     │ Alice Wallet │                             │
│                     │   (Browser)  │                             │
│                     └──────┬───────┘                             │
└────────────────────────────┼──────────────────────────────────────┘
                             │ DIDComm v2
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Mediator Layer                              │
│                   ┌──────────────────┐                           │
│                   │ Identus Mediator │                           │
│                   │   (WebSocket)    │                           │
│                   └────────┬─────────┘                           │
└────────────────────────────┼──────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloud Agent Layer                             │
│  ┌─────────────────────┐          ┌─────────────────────┐       │
│  │   Enterprise        │          │   Main CA           │       │
│  │   Cloud Agent       │          │   Cloud Agent       │       │
│  │   (Port 8300)       │          │   (HTTPS Domain)    │       │
│  └─────────┬───────────┘          └──────────┬──────────┘       │
│            │                                   │                 │
│            │                                   │                 │
│  ┌─────────▼────────┐              ┌──────────▼─────────┐       │
│  │  PostgreSQL DB   │              │   PostgreSQL DB    │       │
│  └──────────────────┘              └────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   VDR/Blockchain Layer                           │
│                 ┌─────────────────────┐                          │
│                 │   PRISM Node (VDR)  │                          │
│                 │   gRPC Port 50053   │                          │
│                 └─────────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### Trust Hierarchy

```
Certification Authority DID
  │
  ├─ Issues Identity Credentials
  ├─ Issues Security Clearance Credentials
  ├─ Issues Employee Badge Credentials
  ├─ Issues Company Identity Credentials
  │
  ▼
End Users (Alice, etc.)
  │
  └─ Present credentials for authentication
```

### Service Dependencies

1. **PRISM Node** (VDR/Blockchain)
   - Decentralized identifier resolution
   - DID publication and verification
   - Required by all Cloud Agents

2. **Mediator** (Message Routing)
   - Offline message delivery
   - WebSocket connection management
   - Required by all wallets

3. **Cloud Agents** (DIDComm + VC Issuance)
   - Main CA: Issues end-user credentials
   - Enterprise: Internal department credentials
   - Multitenancy: Inter-company credentials

4. **Edge Wallet** (User Agent)
   - Browser-based identity management
   - Credential storage and presentation
   - DIDComm messaging

5. **Reverse Proxy** (Caddy)
   - HTTPS termination with Let's Encrypt
   - Path-based routing to services
   - CORS handling

---

## Key Use Cases

### 1. DIDComm Connection Establishment

**Flow**: Alice creates invitation → User accepts → Both approve → Secure channel established

```bash
# Alice creates invitation in CA Portal
# User pastes invitation URL in wallet
# Both parties see connection request
# Both approve → Connection status turns green
```

### 2. Verifiable Credential Issuance

**Flow**: CA sends offer → User accepts → CA approves → Credential stored in wallet

**Credential Types**:
- **Identity Credential**: Name, email, profile photo
- **Security Clearance**: Clearance level (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED, TOP-SECRET)
- **Employee Badge**: Employee ID, department, role
- **Company Identity**: Company registration, jurisdiction, authorized issuer status

**States**:
- `OfferSent`: Waiting for user acceptance
- `RequestReceived`: Waiting for CA approval
- `CredentialSent`: Credential issued and stored

### 3. Zero-Knowledge Content Portal

**Flow**: User authenticates with Security Clearance VC → Server encrypts content with user's X25519 public key → Wallet decrypts locally → Progressive disclosure based on clearance level

**Architecture**:
- **Server**: Encrypts content but cannot decrypt (zero-knowledge)
- **Wallet**: Decrypts using X25519 private key (client-side)
- **Transport**: HTTPS + postMessage API for cross-window communication

**Performance**: 317-350ms latency per section, 100% success rate

### 4. Credential Revocation

**Flow**: CA revokes credential → StatusList updated (eventual consistency) → Verifiers check public endpoint

**Architecture**:
- **Immediate**: Database `is_canceled` flag updated (0-1 second)
- **Delayed**: StatusList bitstring updated (30 minutes - several hours)
- **Public Verification**: `/credential-status/{id}` endpoint (no authentication required)

**Privacy**: StatusLists bundle 131,072 credentials for group privacy

---

## Configuration

### Environment Variables

See `.env.example` for complete configuration options.

**Critical Variables**:
```bash
# Server
SERVER_IP=91.99.4.54
SERVER_DOMAIN=identuslabel.cz

# Cloud Agent
CLOUD_AGENT_ADMIN_TOKEN=your-secure-token
DEFAULT_WALLET_PASSPHRASE=your-passphrase

# Database
POSTGRES_PASSWORD=your-postgres-password

# Ports
CA_PORT=3005
ALICE_WALLET_PORT=3001
```

### Service Ports

| Service | Internal Port | External Access | Protocol |
|---------|---------------|-----------------|----------|
| Cloud Agent (Main) | 8085 | `https://identuslabel.cz/cloud-agent` | HTTPS |
| Cloud Agent DIDComm | 8090 | `https://identuslabel.cz/didcomm` | HTTPS |
| Enterprise Agent | 8085 | `https://identuslabel.cz/enterprise` | HTTPS |
| Enterprise DIDComm | 8090 | `https://identuslabel.cz/enterprise/didcomm` | HTTPS |
| Multitenancy Agent | 8085 | `http://91.99.4.54:8200` (internal) | HTTP |
| Mediator | 8080 | `https://identuslabel.cz/mediator` | HTTPS |
| PRISM Node | 50053 | `91.99.4.54:50053` | gRPC |
| PostgreSQL (Main) | 5432 | Internal only | TCP |
| PostgreSQL (Enterprise) | 5432 | Internal only | TCP |
| CA Server | 3005 | `https://identuslabel.cz/ca` | HTTPS |
| Alice Wallet | 3001 | `https://identuslabel.cz/alice` | HTTPS |
| Company Admin Portal | 3010 | `https://identuslabel.cz/company-admin` | HTTPS |

---

## Deployment

### Production Deployment

1. **Update DNS**: Point domain A record to `SERVER_IP`
2. **Configure SSL**: Update `ACME_EMAIL` in `.env`
3. **Generate secrets**: Use strong random values for all tokens/passwords
4. **Start services**: Run `infrastructure/scripts/install.sh`
5. **Verify health**: Run `infrastructure/scripts/health-check.sh`

### Service Management

**Start all services**:
```bash
cd infrastructure/scripts
./start-all.sh
```

**Stop all services**:
```bash
./stop-all.sh
```

**Restart service**:
```bash
# Cloud Agent
docker-compose -f infrastructure/docker/cloud-agent-with-reverse-proxy.yml restart

# Mediator
docker-compose -f infrastructure/docker/identus-mediator/docker-compose.yml restart

# Alice Wallet
cd services/edge-wallets/alice-wallet
fuser -k 3001/tcp && yarn dev &
```

**View logs**:
```bash
# Cloud Agent
docker logs -f identus-cloud-agent-backend

# Mediator
docker logs -f identus-mediator-identus-mediator-1

# CA Server
tail -f /tmp/ca.log

# Alice Wallet
tail -f /tmp/alice.log
```

---

## Health Checks

### Automated Health Check

```bash
cd infrastructure/scripts
./health-check.sh
```

### Manual Health Checks

```bash
# Cloud Agent
curl -s https://identuslabel.cz/_system/health | jq .

# CA Server
curl -s https://identuslabel.cz/ca/api/health | jq .

# Mediator
curl -I https://identuslabel.cz/mediator/

# Alice Wallet
curl -I https://identuslabel.cz/alice/

# Enterprise Cloud Agent
curl -s https://identuslabel.cz/enterprise/_system/health | jq .

# Company Admin Portal
curl -s https://identuslabel.cz/company-admin/api/health | jq .

# Multitenancy Cloud Agent (internal)
curl -s http://91.99.4.54:8200/_system/health | jq .

# PRISM Node
grpcurl -plaintext 91.99.4.54:50053 list
```

### Expected Health Response

```json
{
  "version": "2.0.0",
  "status": "healthy"
}
```

---

## Development

### Local Development Setup

1. **Install dependencies**:
   ```bash
   # Root workspace
   yarn install

   # Edge wallet
   cd services/edge-wallets/sdk-ts
   yarn install
   yarn build
   ```

2. **Start development servers**:
   ```bash
   # CA Server
   cd services/certification-authority
   PORT=3005 node server.js

   # Alice Wallet (PRIMARY DEVELOPMENT WALLET)
   cd services/edge-wallets/alice-wallet
   yarn dev

   # Company Admin Portal
   cd services/company-admin-portal
   ./start.sh
   ```

3. **SDK Development** (if modifying SDK):
   ```bash
   # Make changes in sdk-ts/src/
   cd services/edge-wallets/sdk-ts
   yarn build

   # Copy to Alice wallet
   cp -r build/* alice-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/

   # Restart Alice wallet
   cd alice-wallet && rm -rf .next && yarn dev
   ```

**Note**: Bob Wallet was decommissioned November 9, 2025. All development should use Alice Wallet only.

### Testing

**Manual Testing Flow**:
```bash
# 1. Create DIDComm connection
# Alice: Create invitation in CA Portal
# User: Accept invitation in Alice wallet

# 2. Issue credential
# CA: Send Identity Credential offer to Alice
# Alice: Accept offer in wallet
# CA: Approve credential in portal
# Alice: Verify credential appears in wallet

# 3. Test encrypted content portal
# Alice: Submit Security Clearance VC to dashboard
# Dashboard: Encrypts content with Alice's X25519 public key
# Alice: Click "Decrypt with Wallet"
# Wallet: Decrypts content locally
# Dashboard: Displays decrypted content

# 4. Test credential revocation
# CA: Revoke Alice's credential
# Verify: Database shows is_canceled=true
# Wait: 30+ minutes for StatusList sync
# Verify: Public endpoint shows revoked status
```

---

## Troubleshooting

### Common Issues

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Browser cache** | Updates not appearing | Hard refresh: `Ctrl+Shift+R` (Win/Linux) or `Cmd+Shift+R` (Mac) |
| **Popup blocked** | Wallet doesn't open | Allow popups for CA domain in browser settings |
| **Connection fails** | Invitation doesn't work | Check mediator health: `curl -I https://identuslabel.cz/mediator/` |
| **Credential missing** | Accepted but not visible | Verify state is `CredentialSent`, check wallet initialized |
| **SSL errors** | Certificate invalid | Verify DNS pointing to server, check Caddy logs |
| **Port conflicts** | Service won't start | Check ports with `netstat -tuln \| grep <port>` |

### Diagnostic Commands

```bash
# Check all Docker containers
docker ps -a

# Check specific service logs
docker logs <container-name>

# Check database connectivity
docker exec -it <db-container> psql -U postgres -c "SELECT version();"

# Check DID registration
curl -s https://identuslabel.cz/cloud-agent/did-registrar/dids | jq .

# Check credential revocation status
docker exec -it <db-container> psql -U postgres -d pollux -c \
  "SELECT issue_credential_record_id, is_canceled, is_processed
   FROM credentials_in_status_list
   WHERE issue_credential_record_id = '<recordId>';"
```

### SDK Modifications

If you encounter issues with SDK behavior, see `services/edge-wallets/SDK_MODIFICATIONS.md` for documented fixes and customizations.

---

## Security

### Security Features

- HTTPS with automatic Let's Encrypt SSL certificates
- Fail2ban SSH brute-force protection
- API key authentication for Cloud Agent endpoints
- Client-side key generation (Ed25519, X25519)
- Zero-knowledge server architecture for encrypted content
- W3C Data Integrity Proofs for credential verification
- Privacy-preserving revocation with StatusList2021

### Security Disclosure

For security vulnerabilities, please see [SECURITY.md](SECURITY.md).

### Production Hardening

1. **Change default passwords**: Update all tokens/passwords in `.env`
2. **Enable firewall**: Configure UFW to allow only required ports
3. **Update regularly**: Keep Docker images and system packages updated
4. **Monitor logs**: Set up log aggregation and alerting
5. **Backup databases**: Schedule regular PostgreSQL backups
6. **Restrict API access**: Use IP whitelisting for Cloud Agent admin endpoints

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Quick Contribution Guide

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit changes: `git commit -m "Add feature"`
4. Push to branch: `git push origin feature/your-feature`
5. Open a Pull Request

---

## Documentation

For complete technical documentation and architectural details, see:

- **[CLAUDE.md](CLAUDE.md)**: Complete technical documentation and project instructions
- **[CHANGELOG.md](CHANGELOG.md)**: Version history and updates
- **[DEVELOPMENT_HISTORY.md](docs/DEVELOPMENT_HISTORY.md)**: Detailed development timeline
- **[SDK_MODIFICATIONS.md](services/edge-wallets/SDK_MODIFICATIONS.md)**: Custom SDK fixes
- **[WORDPRESS_INTEGRATION.md](services/certification-authority/docs/WORDPRESS_INTEGRATION.md)**: CMS integration guide

**Additional Documentation**:
- **[/root/docs/](docs/)**: Complete documentation structure
  - Architecture diagrams
  - API references
  - Deployment guides
  - Security documentation

---

## Standards Compliance

- **W3C Verifiable Credentials Data Model 1.0**
- **W3C Decentralized Identifiers (DIDs) v1.0**
- **W3C StatusList2021** (Bitstring Status List)
- **DIDComm Messaging v2.0** (RFC 0434)
- **X25519** Elliptic Curve Diffie-Hellman (RFC 7748)
- **XSalsa20-Poly1305** Authenticated Encryption (NaCl/libsodium)
- **Ed25519** Digital Signatures (RFC 8032)

---

## External Resources

### Hyperledger Identus

- **Documentation**: https://docs.atalaprism.io/
- **SDK Repository**: https://github.com/hyperledger/identus-edge-agent-sdk-ts
- **Cloud Agent**: https://github.com/hyperledger/identus-cloud-agent
- **Community**: https://discord.gg/hyperledger

### W3C Standards

- **Verifiable Credentials**: https://www.w3.org/TR/vc-data-model/
- **DIDs**: https://www.w3.org/TR/did-core/
- **StatusList2021**: https://www.w3.org/TR/vc-status-list/

### DIDComm

- **DIDComm v2 Spec**: https://identity.foundation/didcomm-messaging/spec/
- **DIF (Decentralized Identity Foundation)**: https://identity.foundation/

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- **Hyperledger Foundation** for the Identus platform
- **W3C** for Verifiable Credentials and DID standards
- **Decentralized Identity Foundation** for DIDComm specifications
- **libsodium** project for cryptographic primitives
- **Caddy** project for reverse proxy and SSL automation

---

## Status

**Current Version**: 4.0 (Phase 2 Client-Side Encryption - Production Ready)

**Last Updated**: 2025-11-15

**Production Status**: Fully Operational

- Cloud Agent: 2.0.0
- Edge Agent SDK: 6.6.0 (with custom fixes)
- Mediator: Latest stable
- PRISM Node: Latest stable

**Infrastructure Updates** (November 2025):
- ✅ All services migrated to HTTPS domain access (`identuslabel.cz`)
- ✅ Bob Wallet decommissioned (November 9, 2025)
- ✅ Alice Wallet designated as primary development wallet
- ✅ Enterprise multitenancy infrastructure operational
- ✅ Company Admin Portal deployed
- ✅ Phase 2 client-side encryption fully operational

---

## Contact

For questions, issues, or contributions, please open an issue on GitHub or contact the maintainers.

**Maintained By**: Hyperledger Identus SSI Infrastructure Team
