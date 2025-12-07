# Top-Level Issuer Infrastructure (ARCHIVED)

> **ARCHIVED DOCUMENTATION**: This infrastructure was decommissioned on November 9, 2025
>
> **Status**: ❌ **DECOMMISSIONED**
>
> **Replacement**: Enterprise Cloud Agent multitenancy solution (port 8300)
>
> **Reason**: The Top-Level Issuer infrastructure was replaced by the more comprehensive Enterprise Cloud Agent multitenancy solution, which provides better department isolation and scalability for internal company operations.
>
> This document is preserved for historical reference only.

---

## Overview

**Purpose**: Separate Cloud Agent instance that acts as a top-level authority to issue CA credentials

**Status**: ❌ **DECOMMISSIONED** (November 9, 2025) - Replaced by enterprise multitenancy infrastructure

**Reason for Decommissioning**: The Top-Level Issuer infrastructure was replaced by the more comprehensive Enterprise Cloud Agent multitenancy solution, which provides better department isolation and scalability for internal company operations.

## Architecture (Historical Reference)

The top-level issuer infrastructure provided a dedicated Cloud Agent instance specifically designed to issue credentials to the main CA. This separation prevented self-connection issues and established a clear trust hierarchy.

**Components**:
- **Top-Level Issuer Cloud Agent**: `http://91.99.4.54:8100` (port 8100)
- **DIDComm Endpoint**: `http://91.99.4.54:8190` (port 8190)
- **Dedicated PostgreSQL Database**: Port 5433 (external), separate from main CA database
- **Top-Level Issuer DID**: `did:prism:3a0db80b774bf7736058a518c31fcfdb17e531b772b4ff0676809847b02b58b8`

**Key Differences from Main CA Cloud Agent**:
- Completely separate Docker container and database
- No credential issuance to end users (only to CA)
- Uses PostgreSQL trust authentication (no password within Docker network)
- Shares same PRISM node and mediator infrastructure

## Configuration Files

| File | Purpose | Location |
|------|---------|----------|
| **Docker Compose** | Container orchestration | `/root/top-level-issuer-cloud-agent.yml` |
| **PostgreSQL Init** | Database initialization | `/root/init-top-level-issuer-dbs.sql` |
| **PostgreSQL Auth** | Trust authentication config | `/root/top-level-issuer-pg_hba.conf` |
| **DID Creation Script** | Top-level DID generator | `/root/create-top-level-issuer-did.js` |

## Key Features

1. **Separation of Concerns**: Dedicated instance prevents self-connection issues in hierarchical credential issuance
2. **Trust Authentication**: PostgreSQL configured with trust authentication for simplified Docker networking
3. **API Key Security**: Automatic API key provisioning on startup
4. **Shared Infrastructure**: Connects to same PRISM node (50053) and mediator (8080) as main CA
5. **Independent Database**: Port 5433 avoids conflicts with main CA database (5432)

## Port Allocation

| Service | Port (Internal) | Port (External) | Purpose |
|---------|-----------------|-----------------|---------|
| Cloud Agent HTTP | 8085 | 8100 | REST API |
| Cloud Agent Admin | 8086 | - | Internal admin interface |
| DIDComm Endpoint | 8090 | 8190 | DIDComm messaging |
| PostgreSQL | 5432 | 5433 | Database access |

## Service Endpoints

**Health Check**:
```bash
curl http://91.99.4.54:8100/_system/health
```

**API Base URL**: `http://91.99.4.54:8100/cloud-agent`

**DIDComm Service**: `http://91.99.4.54:8190/didcomm`

## Management Commands

### Start Top-Level Issuer
```bash
cd /root
docker-compose -f top-level-issuer-cloud-agent.yml up -d
```

### Stop Top-Level Issuer
```bash
cd /root
docker-compose -f top-level-issuer-cloud-agent.yml down
```

### Restart Top-Level Issuer
```bash
cd /root
docker-compose -f top-level-issuer-cloud-agent.yml restart
```

### View Logs
```bash
# Real-time logs
docker logs -f top-level-issuer-cloud-agent

# Last 100 lines
docker logs --tail 100 top-level-issuer-cloud-agent
```

### Check Container Status
```bash
docker ps --filter "name=top-level-issuer"
```

## Database Access

**Connection String**:
```bash
docker exec -it top-level-issuer-db psql -U postgres
```

**Database Names**:
- `pollux` - Credential management
- `connect` - DIDComm connections
- `agent` - Agent wallet and DIDs
- `node` - Internal node state

## Environment Configuration

Key environment variables in `top-level-issuer-cloud-agent.yml`:

```yaml
# API Configuration
API_KEY_ENABLED: "true"
API_KEY_AUTHENTICATE_AS_DEFAULT_USER: "true"
API_KEY_AUTO_PROVISIONING: "true"

# Service URLs
REST_SERVICE_URL: http://91.99.4.54:8100/cloud-agent
DIDCOMM_SERVICE_URL: http://91.99.4.54:8190/didcomm

# Database
POLLUX_DB_HOST: top-level-issuer-db
POLLUX_DB_PORT: 5432
POLLUX_DB_NAME: pollux

# PRISM/VDR
PRISM_NODE_HOST: 91.99.4.54
PRISM_NODE_PORT: 50053
```

## Security Considerations

**PostgreSQL Trust Authentication**:
- Enabled only for Docker internal network (`172.18.0.0/16`)
- External connections (port 5433) still require password authentication
- Simplifies agent-to-database communication within Docker

**API Key Authentication**:
- Auto-provisioned on startup
- Required for all Cloud Agent API calls
- Retrieve from container logs on first start

## Troubleshooting

| Issue | Symptom | Solution |
|-------|---------|----------|
| **Port conflict** | Container fails to start | Check if ports 8100, 8190, or 5433 are in use: `netstat -tuln \| grep -E '8100\|8190\|5433'` |
| **Database connection error** | Cloud Agent crashes on startup | Verify PostgreSQL container running: `docker ps \| grep top-level-issuer-db` |
| **Health check fails** | `/_system/health` returns error | Check logs: `docker logs top-level-issuer-cloud-agent` |
| **PRISM node unavailable** | DID operations fail | Verify PRISM node running on port 50053: `docker ps \| grep prism-node` |

## Integration with Main CA

The top-level issuer connects to the main CA via DIDComm to issue credentials. This establishes a trust hierarchy:

```
Top-Level Issuer (8100)
         ↓ (issues credential)
    Main CA (3005)
         ↓ (issues credentials)
  End Users (Alice, Bob)
```

**Connection Flow**:
1. Main CA creates invitation to Top-Level Issuer
2. Top-Level Issuer accepts connection
3. Top-Level Issuer issues CA credential to Main CA
4. Main CA uses received credential to establish authority

## Verification Commands

```bash
# Verify all services running
docker ps --filter "name=top-level-issuer"

# Check health
curl -s http://91.99.4.54:8100/_system/health | jq .

# Verify database connectivity
docker exec -it top-level-issuer-db psql -U postgres -c "SELECT version();"

# Check DID registration
curl -s http://91.99.4.54:8100/cloud-agent/did-registrar/dids | jq .

# Verify PRISM node connectivity
docker logs top-level-issuer-cloud-agent | grep -i "prism"
```

## Benefits

1. **Clear Trust Hierarchy**: Separate issuer for CA credentials establishes explicit trust chain
2. **No Self-Connection**: Avoids complexity of CA issuing credentials to itself
3. **Independent Lifecycle**: Can manage top-level issuer separately from main CA
4. **Scalability**: Can add multiple CAs under same top-level issuer
5. **Audit Trail**: Clear separation enables better auditing of credential issuance

---

**Document Version**: 1.0 (Historical Archive)
**Archived Date**: 2025-11-15
**Original Implementation**: 2025-11-09
**Decommissioned**: 2025-11-09
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
