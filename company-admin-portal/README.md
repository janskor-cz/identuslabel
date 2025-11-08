# Company Admin Portal

**Standalone Admin Interface for Multitenancy Company DID and Employee Management**

A dedicated Node.js/Express application providing company-specific administration for Hyperledger Identus SSI infrastructure. Enables HR administrators to manage company DIDs, create employee DIDComm invitations, and issue verifiable credentials.

---

## Features

- **🏢 Multi-Company Support**: TechCorp, ACME, EvilCorp
- **🆔 Company DID Management**: View and manage PRISM DIDs with public keys and services
- **👥 Employee Management**: List, invite, and manage employee DIDComm connections
- **📱 QR Code Invitations**: Generate invitation QR codes for employee onboarding
- **🎫 Credential Issuance**: Issue verifiable credentials to connected employees
- **🔒 Session-Based Authentication**: Secure company-scoped access control
- **🌐 Multitenancy Integration**: Connects to dedicated Cloud Agent (port 8200)

---

## Architecture

```
Company Admin Portal (Port 3010)
├── Express.js Server
├── Session-Based Authentication
├── Company Configuration (lib/companies.js)
└── Multitenancy Cloud Agent Integration (Port 8200)
        ├── TechCorp Wallet
        ├── ACME Wallet
        └── EvilCorp Wallet
```

---

## Quick Start

### 1. Install Dependencies

```bash
cd /root/company-admin-portal
npm install
```

### 2. Start Server

```bash
# Using startup script (recommended)
./start.sh

# Or manually
PORT=3010 node server.js
```

### 3. Access Portal

- **Local**: http://localhost:3010
- **Domain** (via Caddy reverse proxy): https://identuslabel.cz/company-admin

---

## Company Credentials

### TechCorp
- **Wallet ID**: `40e3db59-afcb-46f7-ae39-47417ad894d9`
- **Entity ID**: `e69b1c94-727f-43e9-af8e-ad931e714f68`
- **API Key**: `b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2`
- **DID**: `did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf`
- **Website**: https://techcorp.example.com

### ACME
- **Wallet ID**: `5d177000-bb54-43c2-965c-76e58864975a`
- **Entity ID**: `e7537e1d-47c2-4a83-a48d-b063e9126858`
- **API Key**: `a5b2c19cd9cfe9ff0b9f7bacfdc9d097ae02074b3ef7b03981a8d837c0d0a784`
- **DID**: `did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9`
- **Website**: https://acme.example.com

### EvilCorp
- **Wallet ID**: `3d06f2e3-0c04-4442-8a3d-628f66bf5c72`
- **Entity ID**: `2f0aa374-8876-47b0-9935-7978f3135ec1`
- **API Key**: `83732572365e98bc866e2247a268366b55c44a66348854e98866c4d44e0480a7`
- **DID**: `did:prism:1706a8c2adaace6cb5e6b90c94f20991fa7bf4257a9183d69da5c45153f9ca73`
- **Website**: https://evilcorp.example.com

---

## API Endpoints

### Public Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serve frontend UI |
| `/api/health` | GET | Health check |
| `/api/companies` | GET | List all companies |

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Select company and create session |
| `/api/auth/current` | GET | Get current company from session |
| `/api/auth/logout` | POST | Clear session |

### Company-Scoped Operations (Authentication Required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/company/info` | GET | Get company info + DID |
| `/api/company/dids` | GET | List company DIDs |
| `/api/company/connections` | GET | List employee connections |
| `/api/company/invite-employee` | POST | Create employee invitation |
| `/api/company/connections/:id` | DELETE | Remove employee |
| `/api/company/issue-credential` | POST | Issue credential to employee |
| `/api/company/credentials` | GET | List issued credentials |

---

## User Guide

### Login

1. Visit https://identuslabel.cz/company-admin
2. Select your company (TechCorp, ACME, or EvilCorp)
3. Click on the company card to login

### View Company DID

- Dashboard displays company DID information
- Shows public keys (auth-key-1, assertion-key-1)
- Lists service endpoints

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

### Issue Credential

1. Find employee in table
2. Click "Issue Credential"
3. Confirm credential issuance
4. Credential sent to employee's wallet

---

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3010)

### Company Configuration

Edit `/lib/companies.js` to:
- Add new companies
- Update company credentials
- Modify company branding (logo, color, tagline)

### Cloud Agent URL

Configured in `/lib/companies.js`:
```javascript
const MULTITENANCY_CLOUD_AGENT_URL = 'http://91.99.4.54:8200';
```

---

## Development

### File Structure

```
company-admin-portal/
├── server.js              # Express server
├── package.json           # Dependencies
├── start.sh              # Startup script
├── lib/
│   └── companies.js      # Company configuration
├── public/
│   ├── index.html        # Frontend UI
│   ├── app.js            # Frontend JavaScript
│   └── styles.css        # Styling
└── data/
    └── .gitkeep          # Session/data storage
```

### Adding a New Company

1. Add company entry in `/lib/companies.js`:
```javascript
newcompany: {
  id: 'newcompany',
  name: 'NewCompany',
  displayName: 'NewCompany Inc.',
  tagline: 'Innovation & Excellence',
  walletId: '<wallet-id>',
  entityId: '<entity-id>',
  apiKey: '<api-key>',
  did: '<did>',
  website: 'https://newcompany.example.com',
  publicKeys: [...],
  services: [...],
  color: '#3b82f6',
  logo: '🏭'
}
```

2. Restart server:
```bash
./start.sh
```

### Development Mode

```bash
# Install nodemon
npm install -g nodemon

# Run with auto-reload
npm run dev
```

---

## Deployment

### Caddy Reverse Proxy

Route configured in `/root/Caddyfile`:

```caddyfile
handle_path /company-admin* {
    reverse_proxy 127.0.0.1:3010 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

Restart Caddy after changes:
```bash
pkill caddy
/usr/local/bin/caddy run --config /root/Caddyfile > /tmp/caddy.log 2>&1 &
```

### Production Startup

Add to system startup script or use systemd:

```bash
# In /etc/rc.local or systemd service
cd /root/company-admin-portal
PORT=3010 node server.js > /tmp/company-admin.log 2>&1 &
```

---

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

1. Verify Caddy is running:
```bash
ps aux | grep caddy
```

2. Check Caddy logs:
```bash
tail -f /tmp/caddy.log
```

3. Test reverse proxy:
```bash
curl https://identuslabel.cz/company-admin/api/health
```

### Session Issues

Clear browser cookies and cache, or use incognito mode.

### Multitenancy Cloud Agent Not Responding

1. Verify Cloud Agent is running:
```bash
docker ps | grep multitenancy
```

2. Test Cloud Agent:
```bash
curl http://91.99.4.54:8200/_system/health
```

---

## Security

- **Session Secret**: Change in production (see `server.js`)
- **API Keys**: Stored in configuration file (not environment variables)
- **HTTPS**: Enabled via Caddy reverse proxy
- **Session Expiration**: 24 hours (configurable in `server.js`)
- **Company Isolation**: Enforced via session-based API key injection

---

## Tech Stack

- **Backend**: Node.js, Express.js
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Session Management**: express-session
- **HTTP Client**: node-fetch
- **QR Code Generation**: qrcode.js (CDN)
- **Reverse Proxy**: Caddy 2.x

---

## License

MIT License - Hyperledger Identus SSI Infrastructure

---

## Support

For issues or questions:
- Check logs: `/tmp/company-admin.log`
- Review CLAUDE.md: `/root/CLAUDE.md`
- Check multitenancy setup: `/tmp/company-dids-summary.txt`

---

**Version**: 1.0.0
**Last Updated**: 2025-11-08
**Status**: ✅ Production Ready
