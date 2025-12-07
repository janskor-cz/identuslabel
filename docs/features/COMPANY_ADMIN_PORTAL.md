# Company Admin Portal

**STATUS**: ✅ **PRODUCTION READY** - Standalone multitenancy admin interface for company DID and employee management

A dedicated Node.js/Express application providing company-specific administration for the Hyperledger Identus SSI infrastructure. Enables HR administrators to manage company DIDs, create employee DIDComm invitations, and issue verifiable credentials.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [API Endpoints](#api-endpoints)
- [User Guide](#user-guide)
- [Configuration](#configuration)
- [File Structure](#file-structure)
- [Security Features](#security-features)
- [Caddy Reverse Proxy](#caddy-reverse-proxy)
- [Troubleshooting](#troubleshooting)
- [Tech Stack](#tech-stack)
- [Company Identity Credentials](#company-identity-credentials)
- [Complete Documentation](#complete-documentation)

## Overview

**Purpose**: Provide company administrators with a self-service portal to manage their organization's decentralized identity infrastructure

**URL**: `https://identuslabel.cz/company-admin`

**Architecture**: Standalone Express application with session-based company authentication

## Features

- **🏢 Multi-Company Support**: TechCorp, ACME, EvilCorp with isolated sessions
- **🆔 Company DID Management**: View and manage PRISM DIDs with public keys and services
- **👥 Employee Management**: List, invite, and manage employee DIDComm connections
- **📱 QR Code Invitations**: Generate invitation QR codes for employee onboarding
- **🎫 Credential Issuance**: Issue verifiable credentials to connected employees
- **🔒 Session-Based Authentication**: Secure company-scoped access control
- **🌐 Multitenancy Integration**: Connects to dedicated Cloud Agent (port 8200)

## Architecture

```
Company Admin Portal (Port 3010)
├── Express.js Server
├── Session-Based Authentication
├── Company Configuration (lib/companies.js)
└── Multitenancy Cloud Agent Integration (Port 8200)
        ├── TechCorp Wallet (40e3db59-afcb-46f7-ae39-47417ad894d9)
        ├── ACME Wallet (5d177000-bb54-43c2-965c-76e58864975a)
        └── EvilCorp Wallet (3d06f2e3-0c04-4442-8a3d-628f66bf5c72)
```

## Quick Start

```bash
# Start Company Admin Portal
cd /root/company-admin-portal
./start.sh

# Or manually
PORT=3010 node server.js > /tmp/company-admin.log 2>&1 &

# Access portal
# Local: http://localhost:3010
# Domain: https://identuslabel.cz/company-admin

# Health check
curl https://identuslabel.cz/company-admin/api/health
```

## API Endpoints

### Public Routes

- `GET /` - Serve frontend UI
- `GET /api/health` - Health check
- `GET /api/companies` - List all companies

### Authentication

- `POST /api/auth/login` - Select company and create session
- `GET /api/auth/current` - Get current company from session
- `POST /api/auth/logout` - Clear session

### Company-Scoped Operations

(Requires authentication)

- `GET /api/company/info` - Get company info + DID
- `GET /api/company/dids` - List company DIDs
- `GET /api/company/connections` - List employee connections
- `POST /api/company/invite-employee` - Create employee invitation
- `DELETE /api/company/connections/:id` - Remove employee
- `POST /api/company/issue-credential` - Issue credential to employee
- `GET /api/company/credentials` - List issued credentials

## User Guide

### Login Flow

1. Visit `https://identuslabel.cz/company-admin`
2. Select your company (TechCorp, ACME, or EvilCorp)
3. Click on company card to login

### Invite Employee

1. Click "➕ Invite New Employee"
2. Enter employee name (required)
3. Optionally enter role and department
4. Click "Generate Invitation"
5. Share QR code or copy invitation URL
6. Employee scans QR code with Identus wallet

### Manage Employees

- View all connected employees in table
- See connection status (Active, Pending, etc.)
- Issue credentials to employees
- Remove employee connections

## Configuration

### Company Credentials

(in `/lib/companies.js`)

**TechCorp**:
- Wallet ID: `40e3db59-afcb-46f7-ae39-47417ad894d9`
- Entity ID: `e69b1c94-727f-43e9-af8e-ad931e714f68`
- API Key: `b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2`
- DID: `did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf`

**ACME**:
- Wallet ID: `5d177000-bb54-43c2-965c-76e58864975a`
- Entity ID: `e7537e1d-47c2-4a83-a48d-b063e9126858`
- API Key: `a5b2c19cd9cfe9ff0b9f7bacfdc9d097ae02074b3ef7b03981a8d837c0d0a784`
- DID: `did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9`

**EvilCorp**:
- Wallet ID: `3d06f2e3-0c04-4442-8a3d-628f66bf5c72`
- Entity ID: `2f0aa374-8876-47b0-9935-7978f3135ec1`
- API Key: `83732572365e98bc866e2247a268366b55c44a66348854e98866c4d44e0480a7`
- DID: `did:prism:1706a8c2adaace6cb5e6b90c94f20991fa7bf4257a9183d69da5c45153f9ca73`

**Multitenancy Cloud Agent**: `https://identuslabel.cz/multitenancy` (internal: `http://91.99.4.54:8200`)

## File Structure

```
company-admin-portal/
├── server.js              # Express server (560 lines)
├── package.json           # Dependencies
├── start.sh              # Startup script
├── README.md             # Full documentation
├── lib/
│   └── companies.js      # Company configuration
├── public/
│   ├── index.html        # Frontend UI (260 lines)
│   ├── app.js            # Frontend JavaScript (400 lines)
│   └── styles.css        # Styling (620 lines)
└── data/
    └── .gitkeep          # Session/data storage
```

## Security Features

- **Session Secret**: Change in production (see `server.js`)
- **API Keys**: Stored in configuration file (not environment variables)
- **HTTPS**: Enabled via Caddy reverse proxy
- **Session Expiration**: 24 hours (configurable in `server.js`)
- **Company Isolation**: Enforced via session-based API key injection

## Caddy Reverse Proxy

Route configured in `/root/Caddyfile` (lines 27-36):

```caddyfile
# Company Admin Portal (/company-admin -> port 3010)
handle_path /company-admin* {
    reverse_proxy 127.0.0.1:3010 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

## Troubleshooting

### Server Won't Start

```bash
# Check if port 3010 is in use
lsof -ti:3010

# Kill existing process
kill -9 $(lsof -ti:3010)

# Check logs
tail -f /tmp/company-admin.log
```

### Cannot Access via Domain

```bash
# Verify Caddy is running
ps aux | grep caddy

# Check Caddy logs
tail -f /tmp/caddy.log

# Test reverse proxy
curl https://identuslabel.cz/company-admin/api/health
```

### Multitenancy Cloud Agent Not Responding

```bash
# Verify Cloud Agent is running
docker ps | grep multitenancy

# Test Cloud Agent
curl https://identuslabel.cz/multitenancy/_system/health
```

## Tech Stack

- **Backend**: Node.js, Express.js
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Session Management**: express-session
- **HTTP Client**: node-fetch
- **QR Code Generation**: qrcode.js (CDN)
- **Reverse Proxy**: Caddy 2.x

## Company Identity Credentials

**NEW - November 2025**

**Feature**: Display and manage CompanyIdentity verifiable credentials received from the Certification Authority

The Company Admin Portal now displays CompanyIdentity credentials with advanced filtering, detail views, and JWT export functionality.

### Key Features

- **📜 Credential Display**: Table view of all company credentials with status badges
- **🔍 Smart Filtering**: Filter by status (All, Active, Revoked, Expired)
- **📊 Real-time Stats**: Live count of credentials by status
- **🔬 Detail Modal**: Comprehensive view of all credential fields and metadata
- **📋 JWT Export**: Copy base64-encoded JWT credential to clipboard
- **🔓 JWT Decoding**: Automatic decoding of base64-encoded credentials

### API Endpoint

```bash
GET /api/company/credentials?filter={status}
```

**Query Parameters**:
- `filter`: `all` | `active` | `revoked` | `expired` (default: `all`)

### Response Structure

```json
{
  "success": true,
  "credentials": [
    {
      "recordId": "85a6a127-fc95-48b7-8e77-26e12aed6742",
      "protocolState": "CredentialReceived",
      "credentialType": "CompanyIdentity",
      "claims": {
        "companyName": "TechCorp Corporation",
        "registrationNumber": "CZ12345678",
        "jurisdiction": "Czech Republic",
        "industry": "Technology",
        "authorizedToIssueCredentials": true,
        "credentialId": "techcorp-company-id-001"
      },
      "issuedDate": "2025-01-15",
      "expiryDate": "2026-01-15",
      "status": "active",
      "issuer": "did:prism:...",
      "subject": "did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf",
      "jwtCredential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."
    }
  ],
  "stats": {
    "total": 1,
    "active": 1,
    "revoked": 0,
    "expired": 0
  }
}
```

### Backend Implementation

(`server.js:438-554`)

- `decodeCredential()` helper function: Decodes base64 → JWT → extracts VC claims
- Enhanced `/api/company/credentials` endpoint with status determination
- Filters credentials by `CredentialReceived` and `CredentialSent` states
- Filters for `CompanyIdentity` credential type only

### Frontend Components

(`public/index.html`, `public/app.js`, `public/styles.css`)

- Company Identity Credentials section with filter buttons
- Credential table with 7 columns (ID, Name, Reg#, Issued, Expiry, Status, Actions)
- Credential details modal with comprehensive field display
- Status badges (Active: green, Revoked: red, Expired: gray)
- Empty state handling

### Status Determination Logic

- **Active**: Not expired and not on revocation list
- **Expired**: Current date past `expiryDate`
- **Revoked**: On StatusList2021 (future implementation)

### User Workflow

1. CA issues CompanyIdentity credential via DIDComm
2. Company accepts credential offer
3. CA approves credential request
4. Credential automatically appears in Company Admin Portal
5. Click "View Details" to see full credential information
6. Click "Copy JWT" to export base64-encoded credential

### Related Documentation

- **[CREDENTIAL_ISSUANCE_WORKFLOW.md](./company-admin-portal/docs/CREDENTIAL_ISSUANCE_WORKFLOW.md)** - Complete issuance workflow guide
- **[API_REFERENCE.md](./company-admin-portal/docs/API_REFERENCE.md)** - API endpoint documentation

## Complete Documentation

Full documentation available at:
- **[README.md](./company-admin-portal/README.md)** - Complete user guide and API reference
- **[CREDENTIAL_ISSUANCE_WORKFLOW.md](./company-admin-portal/docs/CREDENTIAL_ISSUANCE_WORKFLOW.md)** - Credential issuance guide
- **[API_REFERENCE.md](./company-admin-portal/docs/API_REFERENCE.md)** - API endpoint documentation
- Server code: `/root/company-admin-portal/server.js`
- Company configuration: `/root/company-admin-portal/lib/companies.js`
- Frontend: `/root/company-admin-portal/public/`

---

**Last Updated**: November 8, 2025
**Status**: Production Ready
**Version**: 1.0
