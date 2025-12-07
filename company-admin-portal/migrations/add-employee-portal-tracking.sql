-- Employee Portal Authentication System Tracking Schema
-- Version: 1.0.0
-- Date: 2025-11-20
-- Database: PostgreSQL (Enterprise Cloud Agent Database)
--
-- This schema tracks employee wallet creation, PRISM DID registration,
-- DIDComm connections, and verifiable credential issuance for the
-- Company Admin Portal's employee management system.
--
-- Design Decisions:
-- 1. API keys stored as hashed values with salt for security
-- 2. Soft delete pattern using deleted_at timestamp
-- 3. Comprehensive indexing for performance optimization
-- 4. JSON columns for flexible metadata storage
-- 5. UUID primary keys for distributed system compatibility

-- Connect to the appropriate database (adjust as needed)
-- \c agent_enterprise;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- MAIN EMPLOYEE TRACKING TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_portal_accounts (
    -- Primary Key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Employee Identity (Business Keys)
    email VARCHAR(255) NOT NULL UNIQUE,  -- Primary business identifier
    full_name VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    employee_id VARCHAR(100),  -- Optional: External HR system ID

    -- Cloud Agent Wallet Information
    wallet_id UUID NOT NULL UNIQUE,  -- References Cloud Agent wallet
    entity_id UUID NOT NULL UNIQUE,  -- References Cloud Agent entity
    api_key_hash VARCHAR(255) NOT NULL,  -- SHA-256 hash of API key
    api_key_salt VARCHAR(32) NOT NULL,  -- Salt for API key hash
    api_key_hint VARCHAR(8),  -- Last 8 chars of API key for verification

    -- PRISM DID Information
    prism_did VARCHAR(500) UNIQUE,  -- Full PRISM DID (did:prism:...)
    prism_did_short VARCHAR(100),  -- Short form for display
    prism_did_published BOOLEAN DEFAULT FALSE,
    prism_did_published_at TIMESTAMP WITH TIME ZONE,

    -- DIDComm Connection Information
    techcorp_connection_id UUID,  -- Current active connection to TechCorp
    techcorp_connection_state VARCHAR(50),  -- Connection state tracking
    techcorp_connection_established_at TIMESTAMP WITH TIME ZONE,

    -- Previous connections (for audit trail)
    previous_connection_ids JSONB DEFAULT '[]'::jsonb,  -- Array of previous connection IDs

    -- Verifiable Credential Tracking
    -- Employee Role VC
    employee_role_vc_issued BOOLEAN DEFAULT FALSE,
    employee_role_vc_record_id UUID,  -- Cloud Agent credential record ID
    employee_role_vc_issued_at TIMESTAMP WITH TIME ZONE,
    employee_role_vc_revoked BOOLEAN DEFAULT FALSE,
    employee_role_vc_revoked_at TIMESTAMP WITH TIME ZONE,

    -- CIS Training VC
    cis_training_vc_issued BOOLEAN DEFAULT FALSE,
    cis_training_vc_record_id UUID,  -- Cloud Agent credential record ID
    cis_training_completion_date DATE,
    cis_training_vc_issued_at TIMESTAMP WITH TIME ZONE,
    cis_training_vc_revoked BOOLEAN DEFAULT FALSE,
    cis_training_vc_revoked_at TIMESTAMP WITH TIME ZONE,

    -- Service Configuration VC (for Enterprise wallet access)
    service_config_vc_issued BOOLEAN DEFAULT FALSE,
    service_config_vc_record_id UUID,
    service_config_vc_issued_at TIMESTAMP WITH TIME ZONE,

    -- Account Status
    is_active BOOLEAN DEFAULT TRUE,
    activation_date TIMESTAMP WITH TIME ZONE,
    deactivation_date TIMESTAMP WITH TIME ZONE,
    deactivation_reason VARCHAR(500),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,  -- Flexible field for additional data

    -- Audit Fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),  -- User/system that created the record
    updated_by VARCHAR(255),  -- User/system that last updated
    deleted_at TIMESTAMP WITH TIME ZONE,  -- Soft delete timestamp

    -- Constraints
    CONSTRAINT chk_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT chk_prism_did_format CHECK (prism_did IS NULL OR prism_did LIKE 'did:prism:%'),
    CONSTRAINT chk_connection_state CHECK (
        techcorp_connection_state IN (
            'InvitationGenerated',
            'InvitationReceived',
            'ConnectionRequestPending',
            'ConnectionRequestSent',
            'ConnectionRequestReceived',
            'ConnectionResponsePending',
            'ConnectionResponseSent',
            'ConnectionResponseReceived',
            'Connected',
            'Rejected',
            'Deleted'
        ) OR techcorp_connection_state IS NULL
    )
);

-- ============================================================
-- CREDENTIAL ISSUANCE HISTORY TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_credential_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_account_id UUID NOT NULL REFERENCES employee_portal_accounts(id) ON DELETE CASCADE,

    -- Credential Information
    credential_type VARCHAR(100) NOT NULL,  -- 'EmployeeRole', 'CISTraining', 'ServiceConfiguration', etc.
    credential_record_id UUID NOT NULL,  -- Cloud Agent record ID
    credential_schema_id VARCHAR(500),
    credential_definition_id VARCHAR(500),

    -- Issuance Details
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL,
    issued_by VARCHAR(255),
    issuer_did VARCHAR(500),

    -- Credential Status
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- 'active', 'revoked', 'expired', 'suspended'
    status_changed_at TIMESTAMP WITH TIME ZONE,
    status_change_reason VARCHAR(500),

    -- Credential Content (for audit)
    credential_claims JSONB,  -- Stores the actual claims issued

    -- Expiration
    expires_at TIMESTAMP WITH TIME ZONE,

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Audit Fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Indexes in credential history
    CONSTRAINT chk_credential_status CHECK (
        status IN ('active', 'revoked', 'expired', 'suspended', 'replaced')
    )
);

-- ============================================================
-- API KEY ACCESS LOG TABLE (for security audit)
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_api_access_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_account_id UUID REFERENCES employee_portal_accounts(id) ON DELETE SET NULL,

    -- Access Information
    access_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    api_endpoint VARCHAR(500),
    http_method VARCHAR(10),
    ip_address INET,
    user_agent TEXT,

    -- Response
    response_status INTEGER,
    response_time_ms INTEGER,

    -- Security
    api_key_hint VARCHAR(8),  -- For matching without storing full key
    access_granted BOOLEAN,
    denial_reason VARCHAR(255),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- CONNECTION EVENT HISTORY TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_connection_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_account_id UUID NOT NULL REFERENCES employee_portal_accounts(id) ON DELETE CASCADE,

    -- Connection Details
    connection_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,  -- 'invitation_created', 'invitation_accepted', 'connection_established', etc.
    event_state VARCHAR(50),  -- The connection state after this event

    -- Event Data
    event_data JSONB,
    event_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Source
    source_system VARCHAR(100),  -- 'cloud_agent', 'company_portal', 'employee_wallet'

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- ============================================================
-- PERFORMANCE INDEXES
-- ============================================================

-- Primary lookup indexes
CREATE INDEX idx_employee_email_active ON employee_portal_accounts(email)
    WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE INDEX idx_employee_prism_did ON employee_portal_accounts(prism_did)
    WHERE prism_did IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_employee_wallet_id ON employee_portal_accounts(wallet_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_employee_entity_id ON employee_portal_accounts(entity_id)
    WHERE deleted_at IS NULL;

-- Department queries
CREATE INDEX idx_employee_department ON employee_portal_accounts(department)
    WHERE deleted_at IS NULL AND is_active = TRUE;

-- Connection lookups
CREATE INDEX idx_employee_techcorp_connection ON employee_portal_accounts(techcorp_connection_id)
    WHERE techcorp_connection_id IS NOT NULL;

-- Credential status queries
CREATE INDEX idx_employee_role_vc_issued ON employee_portal_accounts(employee_role_vc_issued, employee_role_vc_issued_at)
    WHERE employee_role_vc_issued = TRUE;

CREATE INDEX idx_cis_training_vc_issued ON employee_portal_accounts(cis_training_vc_issued, cis_training_vc_issued_at)
    WHERE cis_training_vc_issued = TRUE;

-- Temporal queries
CREATE INDEX idx_employee_created_at ON employee_portal_accounts(created_at DESC);
CREATE INDEX idx_employee_updated_at ON employee_portal_accounts(updated_at DESC);

-- Credential history indexes
CREATE INDEX idx_cred_history_employee ON employee_credential_history(employee_account_id, issued_at DESC);
CREATE INDEX idx_cred_history_type ON employee_credential_history(credential_type, status);
CREATE INDEX idx_cred_history_record_id ON employee_credential_history(credential_record_id);

-- API access log indexes (keep limited for performance)
CREATE INDEX idx_api_log_employee ON employee_api_access_log(employee_account_id, access_timestamp DESC);
CREATE INDEX idx_api_log_timestamp ON employee_api_access_log(access_timestamp DESC);
-- Partial index for recent failed access attempts
CREATE INDEX idx_api_log_failures ON employee_api_access_log(ip_address, access_timestamp)
    WHERE access_granted = FALSE AND access_timestamp > CURRENT_TIMESTAMP - INTERVAL '1 hour';

-- Connection events indexes
CREATE INDEX idx_conn_events_employee ON employee_connection_events(employee_account_id, event_timestamp DESC);
CREATE INDEX idx_conn_events_connection ON employee_connection_events(connection_id, event_timestamp DESC);

-- ============================================================
-- TRIGGERS FOR AUTOMATIC TIMESTAMP UPDATES
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_employee_portal_accounts_updated_at
    BEFORE UPDATE ON employee_portal_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Function to hash API keys securely
CREATE OR REPLACE FUNCTION hash_api_key(api_key VARCHAR, salt VARCHAR)
RETURNS VARCHAR AS $$
BEGIN
    RETURN encode(digest(salt || api_key, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to verify API key
CREATE OR REPLACE FUNCTION verify_api_key(
    provided_key VARCHAR,
    stored_hash VARCHAR,
    stored_salt VARCHAR
)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN hash_api_key(provided_key, stored_salt) = stored_hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get active employees by department
CREATE OR REPLACE FUNCTION get_active_employees_by_department(dept VARCHAR)
RETURNS TABLE (
    id UUID,
    email VARCHAR,
    full_name VARCHAR,
    prism_did VARCHAR,
    wallet_id UUID
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        epa.id,
        epa.email,
        epa.full_name,
        epa.prism_did,
        epa.wallet_id
    FROM employee_portal_accounts epa
    WHERE epa.department = dept
        AND epa.deleted_at IS NULL
        AND epa.is_active = TRUE
    ORDER BY epa.full_name;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================

-- Active employees with full credential status
CREATE OR REPLACE VIEW v_active_employees AS
SELECT
    id,
    email,
    full_name,
    department,
    prism_did,
    wallet_id,
    techcorp_connection_id,
    techcorp_connection_state,
    employee_role_vc_issued,
    cis_training_vc_issued,
    service_config_vc_issued,
    created_at,
    updated_at
FROM employee_portal_accounts
WHERE deleted_at IS NULL
    AND is_active = TRUE;

-- Employees pending credential issuance
CREATE OR REPLACE VIEW v_employees_pending_credentials AS
SELECT
    id,
    email,
    full_name,
    department,
    prism_did,
    CASE
        WHEN NOT employee_role_vc_issued THEN 'Employee Role VC'
        WHEN NOT cis_training_vc_issued THEN 'CIS Training VC'
        WHEN NOT service_config_vc_issued THEN 'Service Configuration VC'
    END as pending_credential
FROM employee_portal_accounts
WHERE deleted_at IS NULL
    AND is_active = TRUE
    AND prism_did IS NOT NULL
    AND (
        NOT employee_role_vc_issued OR
        NOT cis_training_vc_issued OR
        NOT service_config_vc_issued
    );

-- ============================================================
-- SECURITY POLICIES (Optional - for Row Level Security)
-- ============================================================

-- Enable RLS on sensitive tables (uncomment if needed)
-- ALTER TABLE employee_portal_accounts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE employee_api_access_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- INITIAL DATA / MIGRATION FROM EXISTING SYSTEM
-- ============================================================

-- Example: Migrate existing employee data if available
-- INSERT INTO employee_portal_accounts (email, full_name, department, ...)
-- SELECT ... FROM existing_employee_table;

-- ============================================================
-- GRANT PERMISSIONS
-- ============================================================

-- Grant permissions to application user
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_portal_accounts TO identus_enterprise;
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_credential_history TO identus_enterprise;
GRANT SELECT, INSERT ON employee_api_access_log TO identus_enterprise;
GRANT SELECT, INSERT ON employee_connection_events TO identus_enterprise;

-- Grant sequence permissions for UUID generation
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO identus_enterprise;

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION hash_api_key TO identus_enterprise;
GRANT EXECUTE ON FUNCTION verify_api_key TO identus_enterprise;
GRANT EXECUTE ON FUNCTION get_active_employees_by_department TO identus_enterprise;

-- ============================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================

COMMENT ON TABLE employee_portal_accounts IS 'Main table tracking employee wallet accounts, PRISM DIDs, connections, and credential issuance status';
COMMENT ON COLUMN employee_portal_accounts.email IS 'Primary business identifier - employee email address';
COMMENT ON COLUMN employee_portal_accounts.api_key_hash IS 'SHA-256 hash of API key with salt - never store plaintext';
COMMENT ON COLUMN employee_portal_accounts.api_key_hint IS 'Last 8 characters of API key for verification/debugging';
COMMENT ON COLUMN employee_portal_accounts.prism_did IS 'Blockchain-anchored PRISM DID in full form (did:prism:...)';
COMMENT ON COLUMN employee_portal_accounts.techcorp_connection_id IS 'Current active DIDComm connection to TechCorp company wallet';
COMMENT ON COLUMN employee_portal_accounts.previous_connection_ids IS 'JSON array of previous connection IDs for audit trail';
COMMENT ON COLUMN employee_portal_accounts.metadata IS 'Flexible JSON field for additional data without schema changes';

COMMENT ON TABLE employee_credential_history IS 'Complete history of all credentials issued to employees';
COMMENT ON TABLE employee_api_access_log IS 'Security audit log of API key usage';
COMMENT ON TABLE employee_connection_events IS 'Event history for DIDComm connection state changes';

COMMENT ON VIEW v_active_employees IS 'Quick access view for active employees with credential status';
COMMENT ON VIEW v_employees_pending_credentials IS 'View showing employees who need credentials issued';

-- ============================================================
-- END OF SCHEMA DEFINITION
-- ============================================================

-- Migration execution note:
-- Run this script in the appropriate database (agent_enterprise or a dedicated portal database)
-- Example: psql -h localhost -U identus_enterprise -d agent_enterprise -f add-employee-portal-tracking.sql