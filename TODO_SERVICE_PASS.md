# TODO: DIDComm-Based Employee Wallet Configuration Bootstrap

## Project Goal
Implement secure employee wallet configuration distribution via DIDComm messaging, where enterprise cloud agent automatically provisions new employee wallets with all necessary configuration parameters including API keys.

---

## Phase 1: Define Configuration Schema

### 1.1 Create Custom DIDComm Message Type
- [ ] Define message type identifier: `https://yourenterprise.com/wallet-config/1.0/bootstrap`
- [ ] Document message schema specification
- [ ] Create JSON schema validation for configuration messages

**Message Structure:**
```json
{
  "type": "https://yourenterprise.com/wallet-config/1.0/bootstrap",
  "id": "uuid-v4",
  "to": ["did:peer:employee-wallet"],
  "from": "did:peer:enterprise-cloud-agent",
  "body": {
    "walletConfig": {
      "walletId": "string",
      "walletName": "string",
      "dbName": "string",
      "storagePrefix": "string"
    },
    "cloudAgentAuth": {
      "apiKey": "string",
      "apiEndpoint": "string",
      "expiresAt": "ISO8601",
      "scope": ["array", "of", "permissions"]
    },
    "mediatorConfig": {
      "did": "string",
      "endpoint": "string"
    },
    "enterpriseInfo": {
      "name": "string",
      "department": "string",
      "employeeId": "string"
    }
  }
}
```

### 1.2 Define Configuration Parameters
- [ ] Document all required wallet configuration parameters
- [ ] Define API key structure and scoping rules
- [ ] Specify mediator configuration format
- [ ] Define enterprise metadata fields

**Files to Create:**
- `/services/certification-authority/schemas/wallet-config-message.json`
- `/docs/WALLET_CONFIG_SCHEMA.md`

---

## Phase 2: API Key Management System

### 2.1 Employee API Key Generation
- [ ] Implement employee-specific API key generation
- [ ] Add JWT-based token structure with scopes
- [ ] Implement key expiration and renewal logic
- [ ] Add API key storage in PostgreSQL database

**Database Schema:**
```sql
CREATE TABLE employee_api_keys (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(255) NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  scope JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_used_at TIMESTAMP
);

CREATE INDEX idx_employee_api_keys_employee_id ON employee_api_keys(employee_id);
CREATE INDEX idx_employee_api_keys_api_key ON employee_api_keys(api_key);
```

### 2.2 API Key Validation Middleware
- [ ] Create Express middleware for API key validation
- [ ] Implement scope-based authorization
- [ ] Add rate limiting per API key
- [ ] Log API key usage for audit trail

**Files to Create/Modify:**
- `/services/certification-authority/middleware/apiKeyAuth.js`
- `/services/certification-authority/utils/apiKeyGenerator.js`
- `/services/certification-authority/database/migrations/003_employee_api_keys.sql`

### 2.3 API Key Rotation Support
- [ ] Implement key rotation endpoint
- [ ] Add grace period for old keys during rotation
- [ ] Create automated rotation scheduling
- [ ] Notification system for upcoming expirations

---

## Phase 3: Enterprise Cloud Agent - Configuration Sender

### 3.1 Employee Onboarding Workflow
- [ ] Create employee registration endpoint
- [ ] Generate employee-specific cloud agent tenant (if multi-tenant)
- [ ] Create DIDComm invitation for new employee
- [ ] Store employee metadata in database

**API Endpoints:**
```
POST /api/employees/onboard
  - Body: { name, email, department, employeeId }
  - Returns: { invitationURL, employeeId, connectionId }
```

### 3.2 Configuration Message Sender
- [ ] Implement connection established event handler
- [ ] Create configuration message builder
- [ ] Send configuration via DIDComm after connection approval
- [ ] Add retry logic for failed deliveries

**Implementation:**
```javascript
// /services/certification-authority/handlers/employeeOnboarding.js

async function handleEmployeeConnectionEstablished(connectionId) {
  // 1. Get employee info from connection metadata
  // 2. Generate API key
  // 3. Build configuration message
  // 4. Send via DIDComm
  // 5. Store API key in database
  // 6. Update employee status to "configured"
}
```

### 3.3 Connection State Management
- [ ] Track connection states (invited, connected, configured)
- [ ] Add webhook for connection state changes
- [ ] Implement automatic configuration resend if needed
- [ ] Add admin dashboard for monitoring employee onboarding

**Files to Create/Modify:**
- `/services/certification-authority/handlers/employeeOnboarding.js`
- `/services/certification-authority/routes/employees.js`
- `/services/certification-authority/database/migrations/004_employee_connections.sql`

---

## Phase 4: Employee Edge Wallet - Configuration Receiver

### 4.1 Configuration Message Handler
- [ ] Register custom message type handler in wallet SDK
- [ ] Implement configuration message parser
- [ ] Validate received configuration
- [ ] Apply configuration to wallet state

**Implementation:**
```typescript
// /services/edge-wallets/employee-wallet/src/handlers/configHandler.ts

async function handleWalletConfigMessage(message: DIDCommMessage) {
  // 1. Validate message signature
  // 2. Parse configuration body
  // 3. Store API key securely in IndexedDB
  // 4. Update wallet configuration
  // 5. Initialize mediator connection
  // 6. Send acknowledgment back to enterprise
}
```

### 4.2 Secure Storage Implementation
- [ ] Implement encrypted storage for API keys in IndexedDB
- [ ] Add key derivation for storage encryption
- [ ] Implement secure retrieval methods
- [ ] Add automatic key clearing on logout

**Files to Create:**
- `/services/edge-wallets/employee-wallet/src/handlers/configHandler.ts`
- `/services/edge-wallets/employee-wallet/src/storage/secureStorage.ts`
- `/services/edge-wallets/employee-wallet/src/types/walletConfig.ts`

### 4.3 Wallet Initialization Flow
- [ ] Create employee wallet template application
- [ ] Implement invitation acceptance UI
- [ ] Add configuration progress indicator
- [ ] Show success/error states for configuration

**UI Components:**
- Invitation paste/QR scan screen
- Connection establishing loader
- Configuration receiving progress
- Success screen with enterprise info

### 4.4 API Key Usage Implementation
- [ ] Add API key to authenticated requests
- [ ] Implement token refresh logic (if using refresh tokens)
- [ ] Handle API key expiration gracefully
- [ ] Add re-authentication flow

---

## Phase 5: Security Enhancements

### 5.1 API Key Scoping
- [ ] Define permission scopes for employee API keys
- [ ] Implement scope validation in middleware
- [ ] Document available scopes
- [ ] Add scope-based UI hiding/showing

**Scope Examples:**
```javascript
const EMPLOYEE_SCOPES = {
  CREDENTIALS_READ: 'credentials:read',
  CREDENTIALS_REQUEST: 'credentials:request',
  CONNECTIONS_MANAGE_OWN: 'connections:manage:own',
  DOCUMENTS_READ: 'documents:read',
  DOCUMENTS_UPLOAD: 'documents:upload'
};
```

### 5.2 Short-Lived Tokens with Refresh
- [ ] Implement access token (30 min) + refresh token (1 year) pattern
- [ ] Create token refresh endpoint
- [ ] Add automatic token refresh in wallet
- [ ] Implement refresh token rotation

### 5.3 Audit Trail
- [ ] Log all configuration message deliveries
- [ ] Track API key generation events
- [ ] Monitor API key usage patterns
- [ ] Alert on suspicious activity

**Files to Create:**
- `/services/certification-authority/middleware/auditLogger.js`
- `/services/certification-authority/database/migrations/005_audit_logs.sql`

---

## Phase 6: Testing & Validation

### 6.1 Unit Tests
- [ ] Test API key generation
- [ ] Test configuration message creation
- [ ] Test message encryption/decryption
- [ ] Test API key validation
- [ ] Test scope-based authorization

### 6.2 Integration Tests
- [ ] Test complete employee onboarding flow
- [ ] Test configuration message delivery
- [ ] Test wallet auto-configuration
- [ ] Test API key authentication
- [ ] Test error scenarios (offline wallet, invalid config, etc.)

### 6.3 Security Testing
- [ ] Verify DIDComm encryption works correctly
- [ ] Test API key cannot be intercepted
- [ ] Verify mediator cannot decrypt configuration
- [ ] Test API key scope enforcement
- [ ] Penetration testing on API endpoints

**Files to Create:**
- `/services/certification-authority/tests/employeeOnboarding.test.js`
- `/services/edge-wallets/employee-wallet/tests/configHandler.test.ts`

---

## Phase 7: Documentation & Deployment

### 7.1 Documentation
- [ ] Update README.md with employee onboarding flow
- [ ] Create employee wallet setup guide
- [ ] Document API key management procedures
- [ ] Create admin guide for employee management
- [ ] Document troubleshooting procedures

**Documentation Files:**
- `/docs/EMPLOYEE_ONBOARDING.md`
- `/docs/API_KEY_MANAGEMENT.md`
- `/docs/EMPLOYEE_WALLET_SETUP.md`

### 7.2 Admin UI
- [ ] Create employee management dashboard
- [ ] Add employee onboarding UI
- [ ] Show connection status for employees
- [ ] Add API key management UI
- [ ] Display audit logs

**Features:**
- List all employees
- Create new employee invitation
- View connection status
- Regenerate API keys
- Revoke employee access
- View audit trail

### 7.3 Deployment Checklist
- [ ] Update environment variables
- [ ] Run database migrations
- [ ] Deploy updated cloud agent
- [ ] Deploy employee wallet template
- [ ] Test end-to-end in production
- [ ] Monitor initial rollout

---

## Phase 8: Advanced Features (Future)

### 8.1 Dynamic Service Discovery
- [ ] Add service endpoints to enterprise DID Document
- [ ] Implement service endpoint parsing in wallet
- [ ] Support multiple cloud agent endpoints
- [ ] Load balancing across endpoints

### 8.2 Multi-Enterprise Support
- [ ] Support employee connections to multiple enterprises
- [ ] Implement enterprise switching in wallet
- [ ] Separate API keys per enterprise
- [ ] Unified credential storage across enterprises

### 8.3 Mobile Wallet Support
- [ ] Port employee wallet to React Native
- [ ] Implement mobile-specific secure storage
- [ ] Add biometric authentication
- [ ] Push notifications for configuration updates

---

## Implementation Priority

### High Priority (Must Have)
1. ✅ Define configuration message schema
2. ✅ Implement API key generation and storage
3. ✅ Create configuration message sender
4. ✅ Implement configuration message receiver
5. ✅ Add secure storage for API keys
6. ✅ Test end-to-end flow

### Medium Priority (Should Have)
7. Add API key scoping and validation
8. Implement audit logging
9. Create admin dashboard
10. Add error handling and retry logic
11. Write comprehensive tests

### Low Priority (Nice to Have)
12. Implement token refresh mechanism
13. Add dynamic service discovery
14. Create mobile wallet version
15. Support multi-enterprise scenarios

---

## Success Criteria

- [ ] Employee can accept invitation URL
- [ ] Wallet auto-configures after connection established
- [ ] API key is securely delivered via DIDComm
- [ ] API key stored encrypted in wallet
- [ ] Employee can make authenticated requests to cloud agent
- [ ] All configuration delivery events logged
- [ ] Admin can monitor employee onboarding status
- [ ] System handles 100+ concurrent employee onboardings
- [ ] Zero security vulnerabilities in penetration testing

---

## Technical Dependencies

### Required Components
- ✅ Hyperledger Identus Cloud Agent (already deployed)
- ✅ Identus Mediator (already deployed)
- ✅ Edge Agent SDK (already integrated)
- ✅ PostgreSQL database (already deployed)
- ⚠️ Employee-specific API key system (NEW)
- ⚠️ Custom DIDComm message handlers (NEW)

### Development Environment
- Node.js 18+
- TypeScript 5+
- PostgreSQL 14+
- Docker & Docker Compose
- Yarn package manager

---

## Resources & References

### DIDComm Specifications
- DIDComm v2.0: https://identity.foundation/didcomm-messaging/spec/
- W3C DID Core: https://www.w3.org/TR/did-core/
- DID Method Peer: https://identity.foundation/peer-did-method-spec/

### Identus Documentation
- Cloud Agent API: https://hyperledger-identus.github.io/docs/
- Edge Agent SDK: https://github.com/hyperledger/identus-edge-agent-sdk-ts
- Mediator: https://github.com/hyperledger/identus-mediator

### Project Documentation
- `/mnt/project/CLAUDE.md` - Current system architecture
- `/mnt/project/README.md` - System overview
- `/mnt/project/Classification-Based_Document_Access_Control_System_-_Requirements_Analysis.md`

---

## Notes

### Security Considerations
- API keys are transmitted encrypted via DIDComm (X25519 + XSalsa20-Poly1305)
- Mediator cannot decrypt configuration messages (zero-knowledge)
- API keys stored encrypted at rest in wallet IndexedDB
- Scope-based authorization limits API key permissions
- Audit trail provides accountability

### Performance Considerations
- Configuration delivery is asynchronous (employee can be offline)
- Mediator stores messages for offline wallets
- API key validation is fast (JWT verification)
- IndexedDB provides good performance for wallet storage

### Scalability Considerations
- System supports multi-tenant cloud agent architecture
- Each employee has isolated API key
- Mediator handles message routing for thousands of wallets
- Database indexed for fast API key lookup

---

**Last Updated:** 2025-11-08
**Status:** Planning Phase
**Next Action:** Review and approve implementation plan
