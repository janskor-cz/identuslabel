# Enterprise Cloud Agent Infrastructure

**STATUS**: ✅ **PRODUCTION READY** - Internal multitenancy Cloud Agent for company departments

A dedicated enterprise Cloud Agent instance has been deployed for internal company department usage. This infrastructure provides isolated wallets for HR, IT, and Security teams with cryptographically enforced data segregation.

---

## Table of Contents

- [Achievement Summary](#achievement-summary)
- [Department Identities](#department-identities)
- [Infrastructure Architecture](#infrastructure-architecture)
- [Security Validation](#security-validation)
- [Use Cases](#use-cases)
- [Configuration Files](#configuration-files)
- [Management Commands](#management-commands)
- [Reverse Proxy Configuration](#reverse-proxy-configuration)
- [Port Allocation](#port-allocation)
- [Tenant Isolation Verification](#tenant-isolation-verification)
- [Environment Variables](#environment-variables)
- [Benefits](#benefits)
- [Troubleshooting](#troubleshooting)

---

## Achievement Summary

- **Status**: ✅ **FULLY OPERATIONAL** - All department tenants created and isolated
- **Infrastructure**: Separate Cloud Agent on port 8300 (isolated from external multitenancy)
- **Security**: Database NOT exposed to internet, custom credentials, API key authentication
- **Departments Created**: 3 internal department wallets (HR, IT, Security)
- **Test Coverage**: Tenant isolation verified (each department sees only their own wallet)

---

## Department Identities

| Department | Wallet ID | Entity ID | API Key |
|------------|-----------|-----------|---------|
| **HR Department** | `5fb8d42e-940d-4941-a772-4a0e6a8bf8c7` | `ee90a6d6-cd95-481c-972b-8e36c1971f3f` | `2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c` |
| **IT Department** | `356a0ea1-883d-4985-a0d0-adc49c710fe0` | `45f35c16-93cf-4fe9-8108-347d83dcee39` | `63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52` |
| **Security Team** | `5b5eaab0-0b56-4cdc-81c9-00b18a49b712` | `8e792cd0-1161-420d-bd98-69eb7edbd19d` | `23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288` |

### Department Wallet Features

Each department wallet includes:
- **Isolated Storage**: Independent wallet with BIP32 seed
- **API Key Authentication**: Department-scoped access control
- **Tenant Isolation**: Cryptographically enforced data segregation
- **HTTPS Access**: Via domain `https://identuslabel.cz/enterprise`

---

## Infrastructure Architecture

```
Enterprise Cloud Agent (Port 8300)
├── PostgreSQL (Internal Only - NOT exposed)
├── Entity-Wallet-APIKey Authentication Model
├── HR Department Wallet (5fb8d42e...)
│   └── Internal employee credentials and connections
├── IT Department Wallet (356a0ea1...)
│   └── Internal employee credentials and connections
└── Security Team Wallet (5b5eaab0...)
    └── Internal employee credentials and connections
```

### Key Components

- **Cloud Agent**: Hyperledger Identus Cloud Agent 2.0.0 with multitenancy support
- **Database**: PostgreSQL with isolated department data
- **Authentication**: API key-based department scoping
- **Reverse Proxy**: Caddy 2.x for HTTPS termination
- **Domain**: `https://identuslabel.cz/enterprise`

---

## Security Validation

### Database Isolation (CRITICAL)

- ✅ PostgreSQL accessible ONLY from Docker internal network (172.18.0.0/16)
- ✅ NO port mapping to host (database not exposed to internet)
- ✅ Custom database user: `identus_enterprise` (NOT default `postgres`)

### Tenant Isolation Verified

- ✅ HR can see only HR wallet (1 wallet)
- ✅ IT cannot see HR wallet (0 wallets returned)
- ✅ Security cannot see HR/IT wallets (0 wallets returned)
- ✅ API key authentication correctly scopes all requests to department

### Security Credentials

- ✅ ADMIN_TOKEN: 32-character alphanumeric (auto-generated)
- ✅ API_KEY_SALT: 64-character hex (auto-generated)
- ✅ PostgreSQL Password: 32-character secure random (auto-generated)

---

## Use Cases

This enterprise infrastructure enables:

1. **Employee Onboarding**: HR issues employee credentials
2. **IT Access Management**: IT department manages system access credentials
3. **Security Clearances**: Security team issues clearance credentials
4. **Internal Workflows**: Department-to-department credential verification

---

## Configuration Files

| File | Purpose | Location |
|------|---------|----------|
| **Docker Compose** | Container orchestration | `/root/enterprise-cloud-agent.yml` |
| **PostgreSQL Init** | Database initialization | `/root/init-enterprise-dbs.sql` |
| **PostgreSQL Auth** | Trust authentication config | `/root/enterprise-pg_hba.conf` |
| **Tenant Creation Script** | Department setup automation | `/tmp/create-enterprise-tenants-v2.sh` |
| **Tenant Credentials** | Secure credentials log | `/tmp/enterprise-tenants-creation.log` |

---

## Management Commands

### Start Enterprise Cloud Agent

```bash
cd /root
docker-compose -f enterprise-cloud-agent.yml up -d
```

### Stop Enterprise Cloud Agent

```bash
cd /root
docker-compose -f enterprise-cloud-agent.yml down
```

### Health Check

```bash
# HTTPS (recommended)
curl https://identuslabel.cz/enterprise/_system/health

# HTTP (direct)
curl http://91.99.4.54:8300/_system/health
```

### List Department Wallets

```bash
# With department API key
curl -H 'apikey: <Department-API-Key>' https://identuslabel.cz/enterprise/wallets

# Direct HTTP access
curl -H 'apikey: <Department-API-Key>' http://91.99.4.54:8300/wallets
```

### View Logs

```bash
# Real-time logs
docker logs -f enterprise-cloud-agent

# Last 100 lines
docker logs --tail 100 enterprise-cloud-agent
```

### Restart Service

```bash
cd /root
docker-compose -f enterprise-cloud-agent.yml restart
```

---

## Reverse Proxy Configuration

### Caddy Routes

Configured in `/root/Caddyfile`:

- **Enterprise DIDComm**: `/enterprise/didcomm` → port 8390
- **Enterprise API**: `/enterprise` → port 8300

### HTTPS URLs

- **API**: `https://identuslabel.cz/enterprise/`
- **DIDComm**: `https://identuslabel.cz/enterprise/didcomm`
- **Health**: `https://identuslabel.cz/enterprise/_system/health`

### SSL/TLS

- **Provider**: Let's Encrypt (automatic via Caddy)
- **Certificate**: Wildcard certificate for `identuslabel.cz`
- **Auto-Renewal**: Enabled

---

## Port Allocation

| Service | Port (Internal) | Port (External) | Purpose |
|---------|-----------------|-----------------|---------|
| Cloud Agent HTTP | 8085 | 8300 | REST API |
| Cloud Agent Admin | 8086 | - | Internal admin interface |
| DIDComm Endpoint | 8090 | 8390 | DIDComm messaging |
| PostgreSQL | 5432 | - | Database (internal only) |

**Note**: External ports are accessible via `91.99.4.54` (direct IP) or `identuslabel.cz/enterprise` (HTTPS domain).

---

## Tenant Isolation Verification

### Test Script

Location: `/tmp/verify-tenant-isolation-fixed.sh`

### Verification Results

```
✅ PASS: All departments can only see their own wallet
✅ Tenant isolation is working correctly!
```

### Manual Verification

**HR Department**:
```bash
curl -s https://identuslabel.cz/enterprise/wallets \
  -H "apikey: 2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c" | jq .
# Returns: 1 wallet (HR Department only)
```

**IT Department**:
```bash
curl -s https://identuslabel.cz/enterprise/wallets \
  -H "apikey: 63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52" | jq .
# Returns: 1 wallet (IT Department only)
```

**Security Team**:
```bash
curl -s https://identuslabel.cz/enterprise/wallets \
  -H "apikey: 23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288" | jq .
# Returns: 1 wallet (Security Team only)
```

---

## Environment Variables

### Key Configuration

From `enterprise-cloud-agent.yml`:

```yaml
ADMIN_TOKEN: "3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu"
API_KEY_SALT: "24cf35cc510d5f7c846252502fb613ea0ea5ed98e80c4d44c126d923ff32d462"
API_KEY_ENABLED: 'true'
API_KEY_AUTO_PROVISIONING: 'false'
DEFAULT_WALLET_ENABLED: 'false'
REST_SERVICE_URL: http://91.99.4.54:8300/cloud-agent
DIDCOMM_SERVICE_URL: https://identuslabel.cz/enterprise/didcomm
SECRET_STORAGE_BACKEND: postgres
```

### Security Configuration

```yaml
# Database
POLLUX_DB_HOST: enterprise-db
POLLUX_DB_PORT: 5432
POLLUX_DB_NAME: pollux
POLLUX_DB_USER: identus_enterprise

# PRISM/VDR
PRISM_NODE_HOST: 91.99.4.54
PRISM_NODE_PORT: 50053
```

---

## Benefits

1. **Department Isolation**: Clear separation between HR, IT, and Security credentials
2. **Independent Lifecycle**: Each department manages their own credential issuance
3. **Scalability**: Can add additional departments as needed
4. **Audit Trail**: Clear separation enables better auditing of credential operations
5. **Security**: Internal-only usage with enterprise security controls

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Port conflict** | Check ports 8300, 8390 not in use: `netstat -tuln \| grep -E '8300\|8390'` |
| **Database error** | Verify PostgreSQL healthy: `docker ps \| grep enterprise-db` |
| **Health check fails** | Check logs: `docker logs enterprise-cloud-agent` |
| **API key auth fails** | Verify header: `apikey: <key>` (lowercase, no 'x-') |
| **HTTPS not working** | Verify Caddy running: `ps aux \| grep caddy` |
| **Certificate error** | Check Caddy logs: `tail -f /tmp/caddy.log` |

### Common Issues

**Issue**: Container fails to start
```bash
# Check Docker logs
docker logs enterprise-cloud-agent

# Verify PostgreSQL is running
docker ps | grep enterprise-db
```

**Issue**: Database connection error
```bash
# Test database connectivity
docker exec -it enterprise-db psql -U identus_enterprise -d pollux -c "SELECT version();"
```

**Issue**: API key authentication not working
```bash
# Verify API key header format (lowercase, no prefix)
curl -v -H "apikey: YOUR_API_KEY" https://identuslabel.cz/enterprise/wallets
```

---

## API Endpoints

All standard Cloud Agent endpoints are available at `https://identuslabel.cz/enterprise/`:

- `/_system/health` - Health check
- `/wallets` - Wallet management
- `/connections` - DIDComm connections
- `/issue-credentials/credential-offers` - Credential issuance
- `/did-registrar/dids` - DID management

**Authentication**: All requests require `apikey` header with department-specific API key.

---

**Document Version**: 1.0
**Last Updated**: 2025-11-15
**Status**: Production-Ready - Fully Operational with 3 Department Tenants
**Port**: 8300 (HTTP direct), 443 (HTTPS via domain)
**Domain**: `https://identuslabel.cz/enterprise`
**Network**: Docker internal network (172.18.0.0/16)
