# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | :white_check_mark: |
| 3.x     | :x:                |
| 2.x     | :x:                |
| 1.x     | :x:                |

---

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

The Hyperledger Identus SSI Infrastructure team takes security seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**Email**: security@identuslabel.cz

**Include**:
- Type of vulnerability
- Full paths of source files related to the issue
- Location of affected source code (tag/branch/commit/URL)
- Step-by-step instructions to reproduce
- Proof-of-concept or exploit code (if possible)
- Impact assessment
- Suggested fix (if available)

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: 1-7 days
  - High: 7-14 days
  - Medium: 14-30 days
  - Low: 30-90 days

### What to Expect

1. **Acknowledgment**: We'll confirm receipt of your report
2. **Investigation**: We'll investigate and validate the issue
3. **Updates**: We'll keep you informed of progress
4. **Fix Development**: We'll develop and test a fix
5. **Disclosure**: We'll coordinate disclosure timing with you
6. **Credit**: We'll credit you in the security advisory (if desired)

---

## Security Features

### Current Security Measures

#### Infrastructure Security

- **HTTPS Everywhere**: All services accessible via HTTPS with Let's Encrypt SSL
- **Reverse Proxy**: Caddy handles SSL termination and CORS
- **Fail2ban**: SSH brute-force protection with automatic IP banning
- **Docker Isolation**: Services run in isolated containers
- **Database Security**: PostgreSQL with password authentication
- **API Key Authentication**: Cloud Agent endpoints require API keys

#### Cryptographic Security

- **Ed25519 Signatures**: Modern elliptic curve for digital signatures
- **X25519 Key Agreement**: ECDH for secure key derivation
- **XSalsa20-Poly1305**: Authenticated encryption (NaCl box)
- **Client-Side Key Generation**: Private keys never leave user's device
- **Zero-Knowledge Architecture**: Server cannot decrypt user content

#### Application Security

- **W3C Data Integrity Proofs**: Cryptographic verification of credentials
- **DIDComm v2 Encryption**: End-to-end encrypted messaging
- **Origin Validation**: postMessage API enforces allowed origins
- **Session Management**: Time-limited sessions with secure tokens
- **Input Validation**: Sanitization of user inputs

#### Privacy Features

- **StatusList2021**: Privacy-preserving credential revocation
- **Group Privacy**: Revocation lists bundle 131,072 credentials
- **Progressive Disclosure**: Only share necessary information
- **Selective Disclosure**: Users control what they reveal

---

## Security Best Practices

### For Deployments

#### Essential Security Steps

1. **Change Default Credentials**:
   ```bash
   # Update .env with strong passwords
   CLOUD_AGENT_ADMIN_TOKEN=$(openssl rand -hex 32)
   POSTGRES_PASSWORD=$(openssl rand -hex 32)
   SESSION_SECRET=$(openssl rand -hex 32)
   ```

2. **Enable Firewall**:
   ```bash
   ufw allow 22/tcp      # SSH
   ufw allow 80/tcp      # HTTP (redirects to HTTPS)
   ufw allow 443/tcp     # HTTPS
   ufw enable
   ```

3. **Restrict SSH Access**:
   ```bash
   # /etc/ssh/sshd_config
   PermitRootLogin no
   PasswordAuthentication no
   PubkeyAuthentication yes
   ```

4. **Configure Fail2ban**:
   ```bash
   # Ensure fail2ban is running
   systemctl status fail2ban

   # Monitor banned IPs
   fail2ban-client status sshd
   ```

5. **Enable Automatic Updates**:
   ```bash
   apt install unattended-upgrades
   dpkg-reconfigure -plow unattended-upgrades
   ```

#### Database Security

1. **Restrict Database Access**:
   ```yaml
   # docker-compose.yml
   services:
     postgres:
       ports:
         - "127.0.0.1:5432:5432"  # Bind to localhost only
   ```

2. **Regular Backups**:
   ```bash
   # Backup script
   docker exec postgres pg_dump -U postgres pollux > backup.sql
   ```

3. **Rotate Credentials**:
   ```bash
   # Update passwords periodically
   docker exec -it postgres psql -U postgres
   ALTER USER postgres PASSWORD 'new-secure-password';
   ```

#### API Security

1. **Rotate API Keys**:
   ```bash
   # Generate new Cloud Agent API key
   curl -X POST http://localhost:8000/cloud-agent/apikeys \
     -H "apikey: $OLD_API_KEY" \
     -d '{"name": "new-key"}'
   ```

2. **IP Whitelisting** (optional):
   ```nginx
   # In Caddyfile
   @allowed_ips {
     remote_ip 1.2.3.4 5.6.7.8
   }
   handle @allowed_ips {
     reverse_proxy localhost:8000
   }
   ```

3. **Rate Limiting** (optional):
   ```nginx
   # In Caddyfile
   rate_limit {
     zone dynamic_zone {
       key {remote_host}
       events 100
       window 1m
     }
   }
   ```

#### Monitoring and Logging

1. **Enable Audit Logging**:
   ```bash
   # Monitor access logs
   tail -f /var/log/caddy/access.log

   # Monitor application logs
   docker logs -f identus-cloud-agent-backend
   ```

2. **Set Up Alerting** (optional):
   ```bash
   # Example: Email on failed SSH attempts
   # Configure fail2ban actions
   ```

3. **Regular Security Audits**:
   ```bash
   # Check for exposed secrets
   grep -r "password\|secret\|key" . --exclude-dir=node_modules

   # Check Docker images
   docker scan identus-cloud-agent-backend
   ```

---

## Secure Development Practices

### For Contributors

1. **Never Commit Secrets**:
   - Use `.env` files (never commit them)
   - Use `.env.example` for templates
   - Use secrets management tools for production

2. **Input Validation**:
   ```typescript
   // Always validate user inputs
   const sanitizeInput = (input: string): string => {
     return input.replace(/[<>]/g, '');
   };
   ```

3. **Avoid SQL Injection**:
   ```typescript
   // Use parameterized queries
   const result = await db.query(
     'SELECT * FROM users WHERE id = $1',
     [userId]
   );
   ```

4. **XSS Prevention**:
   ```typescript
   // Escape HTML in user-generated content
   const escapeHtml = (text: string): string => {
     return text
       .replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;')
       .replace(/'/g, '&#039;');
   };
   ```

5. **CSRF Protection**:
   ```typescript
   // Use CSRF tokens for state-changing operations
   // Already implemented in CA server sessions
   ```

6. **Secure Random Generation**:
   ```typescript
   // Use crypto.randomBytes, not Math.random()
   import crypto from 'crypto';
   const token = crypto.randomBytes(32).toString('hex');
   ```

---

## Known Security Considerations

### Architectural Limitations

1. **Browser-Based Wallets**:
   - **Risk**: Wallets run in browser, subject to XSS attacks
   - **Mitigation**: Content Security Policy, input sanitization
   - **Consideration**: For high-security use cases, use native mobile wallets

2. **LocalStorage Key Storage**:
   - **Risk**: Keys stored in browser localStorage
   - **Mitigation**: Keys encrypted with wallet passphrase
   - **Consideration**: Use hardware wallets for production

3. **Eventual Consistency (Revocation)**:
   - **Risk**: Revoked credentials appear valid for 30min-hours
   - **Mitigation**: Document delay, provide database check for real-time
   - **Consideration**: Design systems to handle delayed revocation

4. **Client-Side Trust**:
   - **Risk**: Malicious client can manipulate browser state
   - **Mitigation**: Server validates all VCs cryptographically
   - **Consideration**: Never trust client-side data without verification

### Dependencies

**Regularly update dependencies**:
```bash
# Check for vulnerabilities
yarn audit

# Update dependencies
yarn upgrade

# Update Docker images
docker-compose pull
```

**Subscribe to security advisories**:
- Hyperledger Identus releases
- Node.js security updates
- Docker security bulletins

---

## Incident Response

### In Case of Security Breach

1. **Immediate Actions**:
   - Isolate affected systems
   - Revoke compromised credentials
   - Rotate all API keys and passwords
   - Review access logs

2. **Investigation**:
   - Determine scope of breach
   - Identify attack vector
   - Assess data exposure

3. **Remediation**:
   - Apply security patches
   - Update vulnerable components
   - Restore from backups if needed

4. **Communication**:
   - Notify affected users
   - Publish security advisory
   - Document lessons learned

5. **Post-Incident**:
   - Conduct post-mortem
   - Implement additional controls
   - Update security documentation

---

## Compliance and Standards

### Standards Adherence

- **W3C Verifiable Credentials**: Security considerations per spec
- **DIDComm v2**: Encryption and authentication per protocol
- **OWASP Top 10**: Awareness and mitigation strategies
- **RFC 7748 (X25519)**: Key agreement implementation
- **RFC 8032 (Ed25519)**: Digital signature implementation

### GDPR Considerations

- **Data Minimization**: Only store necessary data
- **Right to Erasure**: Ability to delete user data
- **Data Portability**: Export credentials in standard format
- **Consent Management**: User controls credential sharing
- **Privacy by Design**: Zero-knowledge architecture

---

## Security Contacts

**Security Team**: security@identuslabel.cz

**PGP Key** (optional): [Link to public key]

**Bug Bounty Program**: Not currently available

---

## Acknowledgments

We thank the following security researchers for responsible disclosure:

- *None yet - be the first!*

---

## Additional Resources

- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [W3C VC Security Considerations](https://www.w3.org/TR/vc-data-model/#security-considerations)
- [DIDComm Security](https://identity.foundation/didcomm-messaging/spec/#security-and-privacy-considerations)
- [Hyperledger Security](https://www.hyperledger.org/learn/security)

---

**Last Updated**: 2025-11-08

**Version**: 1.0
