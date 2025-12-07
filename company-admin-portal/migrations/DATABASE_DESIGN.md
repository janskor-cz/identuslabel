# Employee Portal Database Design Documentation

## Overview

The Employee Portal Authentication System tracking database provides comprehensive tracking of employee wallet creation, PRISM DID registration, DIDComm connections, and verifiable credential issuance.

## Architecture Decisions

### 1. Security Design

#### API Key Storage
- **Decision**: Store API keys as SHA-256 hashes with salt
- **Rationale**:
  - Never store plaintext API keys in database
  - Salt prevents rainbow table attacks
  - SHA-256 provides sufficient security for API keys
- **Implementation**:
  ```sql
  api_key_hash VARCHAR(255) -- SHA-256 hash
  api_key_salt VARCHAR(32)  -- Random salt per key
  api_key_hint VARCHAR(8)   -- Last 8 chars for debugging
  ```

#### Alternative Considered
- **Encryption at rest**: Could use pgcrypto to encrypt API keys
- **Rejected because**:
  - API keys are write-once, never need retrieval
  - Hashing is more secure for authentication tokens
  - Eliminates key management complexity

### 2. Performance Optimization

#### Indexing Strategy
- **Primary lookups**: Email (business key) and PRISM DID
- **Partial indexes**: Filter out soft-deleted records
- **Composite indexes**: For multi-column queries
- **Decision rationale**:
  - Most queries filter by `deleted_at IS NULL`
  - Partial indexes reduce index size by ~20-30%
  - Better cache utilization

#### Key Indexes
```sql
-- Fast employee lookup by email (most common)
CREATE INDEX idx_employee_email_active
  ON employee_portal_accounts(email)
  WHERE deleted_at IS NULL AND is_active = TRUE;

-- DID-based lookups for wallet operations
CREATE INDEX idx_employee_prism_did
  ON employee_portal_accounts(prism_did)
  WHERE prism_did IS NOT NULL AND deleted_at IS NULL;
```

### 3. Data Integrity

#### Soft Delete Pattern
- **Decision**: Use `deleted_at` timestamp instead of hard deletes
- **Benefits**:
  - Audit trail preservation
  - Recovery capability
  - Referential integrity maintained
  - Compliance with data retention policies

#### UUID Primary Keys
- **Decision**: Use UUID v4 for all primary keys
- **Rationale**:
  - Distributed system compatibility
  - No sequence bottlenecks
  - Globally unique across systems
  - Safe for client-side generation

### 4. Flexibility vs Schema

#### JSONB Columns
- **Used for**:
  - `metadata`: Extensible properties without schema changes
  - `previous_connection_ids`: Array of historical connections
  - `credential_claims`: Actual VC content for audit
  - `event_data`: Flexible event payloads

- **Benefits**:
  - Schema evolution without migrations
  - Rich querying with GIN indexes
  - Preserves full audit trail

#### Structured Columns
- **Decision**: Explicit columns for core business fields
- **Rationale**:
  - Type safety and constraints
  - Better query performance
  - Clear documentation
  - IDE/tool support

### 5. Audit & Compliance

#### Three-Tier Audit System

1. **Main Table Audit Fields**
   ```sql
   created_at, updated_at, created_by, updated_by
   ```

2. **Event History Tables**
   - `employee_credential_history`: All credential operations
   - `employee_connection_events`: Connection state changes
   - `employee_api_access_log`: API usage tracking

3. **Benefits**
   - Complete audit trail
   - Security incident investigation
   - Compliance reporting
   - Performance monitoring

### 6. Scalability Considerations

#### Table Partitioning Ready
- **API Access Log**: Can partition by `access_timestamp`
- **Credential History**: Can partition by `issued_at`
- **Future growth**: Schema supports partitioning without changes

#### Connection Pooling Friendly
- No long-running transactions
- Prepared statement compatible
- Connection-safe functions

## Usage Guide

### 1. Initial Setup

```bash
# Connect to database
psql -h localhost -U identus_enterprise -d agent_enterprise

# Run migration
\i /root/company-admin-portal/migrations/add-employee-portal-tracking.sql
```

### 2. Common Operations

#### Create Employee Account
```javascript
const db = new EmployeePortalDatabase(pgClient);

const employee = await db.createEmployeeAccount({
  email: 'john.doe@techcorp.com',
  fullName: 'John Doe',
  department: 'Engineering',
  walletId: 'uuid-here',
  entityId: 'uuid-here',
  apiKey: 'generated-api-key'
});
```

#### Verify API Key
```javascript
const result = await db.verifyApiKey(
  'john.doe@techcorp.com',
  'provided-api-key'
);

if (result.valid) {
  // Grant access
}
```

#### Track Credential Issuance
```javascript
await db.recordCredentialIssuance(
  employeeId,
  'EmployeeRole',
  'credential-record-id',
  { role: 'Senior Engineer', issuedBy: 'HR Department' }
);
```

### 3. Monitoring Queries

#### Active Employees Overview
```sql
SELECT
  department,
  COUNT(*) as total,
  COUNT(CASE WHEN prism_did IS NOT NULL THEN 1 END) as with_did,
  COUNT(CASE WHEN employee_role_vc_issued THEN 1 END) as with_role_vc
FROM v_active_employees
GROUP BY department;
```

#### Recent API Activity
```sql
SELECT
  DATE(access_timestamp) as date,
  COUNT(*) as requests,
  COUNT(DISTINCT employee_account_id) as unique_users,
  AVG(response_time_ms) as avg_response_time
FROM employee_api_access_log
WHERE access_timestamp > CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(access_timestamp)
ORDER BY date DESC;
```

#### Credentials Pending Issuance
```sql
SELECT * FROM v_employees_pending_credentials;
```

### 4. Maintenance

#### Cleanup Old Access Logs
```sql
-- Archive logs older than 90 days
DELETE FROM employee_api_access_log
WHERE access_timestamp < CURRENT_DATE - INTERVAL '90 days';
```

#### Reactivate Employee
```sql
UPDATE employee_portal_accounts
SET
  is_active = true,
  deleted_at = NULL,
  deactivation_date = NULL,
  deactivation_reason = NULL
WHERE email = 'john.doe@techcorp.com';
```

## Performance Benchmarks

### Expected Query Performance

| Query Type | Expected Time | Index Used |
|------------|---------------|------------|
| Lookup by email | < 1ms | `idx_employee_email_active` |
| Lookup by PRISM DID | < 1ms | `idx_employee_prism_did` |
| List by department | < 5ms | `idx_employee_department` |
| Verify API key | < 2ms | `idx_employee_email_active` + hash |
| Recent credentials | < 10ms | `idx_cred_history_employee` |

### Capacity Planning

- **Employee Accounts**: 10,000+ without performance impact
- **API Access Logs**: 1M+ records (consider partitioning at 10M)
- **Credential History**: 100K+ records
- **Connection Events**: 500K+ records

## Security Considerations

### 1. API Key Security
- Never log full API keys
- Use hint (last 8 chars) for debugging
- Rotate keys periodically
- Monitor failed authentication attempts

### 2. PII Protection
- Email and full_name are PII
- Consider encryption at rest for sensitive fields
- Implement data retention policies
- Regular audit of access logs

### 3. Row-Level Security (Optional)
```sql
-- Enable RLS for multi-company scenarios
ALTER TABLE employee_portal_accounts ENABLE ROW LEVEL SECURITY;

-- Create policy for company isolation
CREATE POLICY company_isolation ON employee_portal_accounts
  FOR ALL
  USING (company_id = current_setting('app.company_id')::uuid);
```

## Migration Rollback

If needed to rollback:

```sql
-- Drop views
DROP VIEW IF EXISTS v_employees_pending_credentials;
DROP VIEW IF EXISTS v_active_employees;

-- Drop functions
DROP FUNCTION IF EXISTS get_active_employees_by_department;
DROP FUNCTION IF EXISTS verify_api_key;
DROP FUNCTION IF EXISTS hash_api_key;
DROP FUNCTION IF EXISTS update_updated_at_column;

-- Drop triggers
DROP TRIGGER IF EXISTS update_employee_portal_accounts_updated_at
  ON employee_portal_accounts;

-- Drop tables (cascade will handle foreign keys)
DROP TABLE IF EXISTS employee_connection_events CASCADE;
DROP TABLE IF EXISTS employee_api_access_log CASCADE;
DROP TABLE IF EXISTS employee_credential_history CASCADE;
DROP TABLE IF EXISTS employee_portal_accounts CASCADE;
```

## Future Enhancements

### 1. Multi-Company Support
- Add `company_id` column
- Implement row-level security
- Company-specific API key namespaces

### 2. Advanced Analytics
- Materialized views for dashboards
- Time-series data for usage patterns
- Credential lifecycle analytics

### 3. Integration Points
- Webhook events table
- External system sync status
- Batch operation tracking

### 4. Performance Optimization
- Table partitioning for logs
- Archival strategy for old data
- Read replicas for reporting

## Conclusion

This schema provides a robust foundation for employee portal authentication tracking with:
- **Security-first** design with hashed API keys
- **Performance** through strategic indexing
- **Flexibility** via JSONB fields
- **Audit trail** for compliance
- **Scalability** to thousands of employees

The design balances normalized structure with practical flexibility, ensuring both data integrity and operational efficiency.