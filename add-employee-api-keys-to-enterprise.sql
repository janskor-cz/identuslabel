-- Employee API Keys Database Migration
-- For Enterprise Cloud Agent (port 8300) - Internal Employee Management
-- Created: 2025-11-09
-- Purpose: Store employee-specific API keys for authenticated Enterprise Cloud Agent access

-- Table: employee_api_keys
-- Stores API keys issued to employees for accessing Enterprise Cloud Agent
CREATE TABLE IF NOT EXISTS employee_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Employee identification
    connection_id TEXT NOT NULL UNIQUE,
    employee_email TEXT NOT NULL,
    employee_name TEXT,
    department VARCHAR(50) NOT NULL CHECK (department IN ('HR', 'IT', 'Security')),

    -- API key (hashed with bcrypt)
    api_key_hash TEXT NOT NULL,

    -- Scope/permissions (JSON array of strings)
    scope JSONB NOT NULL DEFAULT '["read:own_credentials", "manage:own_connections"]'::jsonb,

    -- Lifecycle management
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_reason TEXT,

    -- Configuration tracking
    config_vc_issued BOOLEAN DEFAULT FALSE,
    config_vc_record_id TEXT,
    config_accepted BOOLEAN DEFAULT FALSE,
    config_accepted_at TIMESTAMP WITH TIME ZONE,

    -- Metadata
    last_used_at TIMESTAMP WITH TIME ZONE,
    last_used_ip TEXT,
    usage_count INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX idx_employee_api_keys_connection_id ON employee_api_keys(connection_id);
CREATE INDEX idx_employee_api_keys_email ON employee_api_keys(employee_email);
CREATE INDEX idx_employee_api_keys_department ON employee_api_keys(department);
CREATE INDEX idx_employee_api_keys_expires_at ON employee_api_keys(expires_at);
CREATE INDEX idx_employee_api_keys_revoked ON employee_api_keys(revoked) WHERE revoked = FALSE;

-- Table: employee_api_key_audit
-- Comprehensive audit log for all API key operations
CREATE TABLE IF NOT EXISTS employee_api_key_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID NOT NULL REFERENCES employee_api_keys(id) ON DELETE CASCADE,

    -- Action details
    action VARCHAR(50) NOT NULL CHECK (action IN (
        'key_generated',
        'key_validated',
        'key_revoked',
        'key_rotated',
        'key_expired',
        'config_issued',
        'config_accepted',
        'unauthorized_attempt',
        'scope_violation'
    )),

    -- Context
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    endpoint TEXT,

    -- Result
    success BOOLEAN,
    error_message TEXT,

    -- Additional metadata (JSON for flexibility)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Index for audit queries
CREATE INDEX idx_employee_audit_api_key_id ON employee_api_key_audit(api_key_id);
CREATE INDEX idx_employee_audit_timestamp ON employee_api_key_audit(timestamp DESC);
CREATE INDEX idx_employee_audit_action ON employee_api_key_audit(action);

-- Table: employee_department_config
-- Department-specific configuration (shared across all employees in department)
CREATE TABLE IF NOT EXISTS employee_department_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department VARCHAR(50) NOT NULL UNIQUE CHECK (department IN ('HR', 'IT', 'Security')),

    -- Department wallet identifiers
    department_wallet_id UUID NOT NULL,
    department_entity_id UUID NOT NULL,
    department_api_key TEXT NOT NULL, -- For issuing credentials to employees

    -- Default scopes for new employees
    default_employee_scope JSONB NOT NULL DEFAULT '["read:own_credentials"]'::jsonb,

    -- Service access configuration
    services JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Lifecycle
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed department configuration with existing data
INSERT INTO employee_department_config (department, department_wallet_id, department_entity_id, department_api_key, default_employee_scope, services)
VALUES
    ('HR', '5fb8d42e-940d-4941-a772-4a0e6a8bf8c7', 'ee90a6d6-cd95-481c-972b-8e36c1971f3f', '2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c',
     '["read:own_credentials", "manage:own_connections", "submit:requests"]'::jsonb,
     '[{"name": "Company Admin Portal", "url": "https://identuslabel.cz/company-admin", "scope": ["read:documents", "submit:requests"]}]'::jsonb),

    ('IT', '356a0ea1-883d-4985-a0d0-adc49c710fe0', '45f35c16-93cf-4fe9-8108-347d83dcee39', '63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52',
     '["read:own_credentials", "manage:own_connections", "manage:systems"]'::jsonb,
     '[{"name": "Company Admin Portal", "url": "https://identuslabel.cz/company-admin", "scope": ["read:documents", "submit:requests", "manage:it_systems"]}]'::jsonb),

    ('Security', '5b5eaab0-0b56-4cdc-81c9-00b18a49b712', '8e792cd0-1161-420d-bd98-69eb7edbd19d', '23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288',
     '["read:own_credentials", "manage:own_connections", "read:security_logs", "issue:security_clearances"]'::jsonb,
     '[{"name": "Company Admin Portal", "url": "https://identuslabel.cz/company-admin", "scope": ["read:documents", "submit:requests", "read:security_logs"]}, {"name": "Secure Information Portal", "url": "https://identuslabel.cz/ca/dashboard", "scope": ["read:confidential"]}]'::jsonb)
ON CONFLICT (department) DO NOTHING;

-- Function: Automatic timestamp update
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger: Auto-update updated_at on department config changes
CREATE TRIGGER update_department_config_updated_at
    BEFORE UPDATE ON employee_department_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function: Check API key expiration (for scheduled cleanup)
CREATE OR REPLACE FUNCTION check_expired_api_keys()
RETURNS TABLE(key_id UUID, employee_email TEXT, expired_since INTERVAL) AS $$
BEGIN
    RETURN QUERY
    SELECT
        id,
        employee_email,
        CURRENT_TIMESTAMP - expires_at as expired_since
    FROM employee_api_keys
    WHERE expires_at < CURRENT_TIMESTAMP
      AND revoked = FALSE;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions to identus_enterprise user
GRANT ALL PRIVILEGES ON TABLE employee_api_keys TO identus_enterprise;
GRANT ALL PRIVILEGES ON TABLE employee_api_key_audit TO identus_enterprise;
GRANT ALL PRIVILEGES ON TABLE employee_department_config TO identus_enterprise;

-- Comments for documentation
COMMENT ON TABLE employee_api_keys IS 'Employee-specific API keys for Enterprise Cloud Agent authentication';
COMMENT ON TABLE employee_api_key_audit IS 'Comprehensive audit log for all API key operations';
COMMENT ON TABLE employee_department_config IS 'Department-specific configuration (wallet IDs, default scopes, services)';

COMMENT ON COLUMN employee_api_keys.api_key_hash IS 'Bcrypt hash of API key (cost factor 10), never stored in plaintext';
COMMENT ON COLUMN employee_api_keys.scope IS 'JSON array of permission strings (e.g., ["read:own_credentials", "manage:connections"])';
COMMENT ON COLUMN employee_api_keys.config_vc_issued IS 'TRUE if ServiceConfiguration VC has been issued to employee';
COMMENT ON COLUMN employee_api_keys.config_accepted IS 'TRUE if employee has applied the configuration in their wallet';
COMMENT ON COLUMN employee_api_key_audit.metadata IS 'Flexible JSON field for action-specific data (e.g., old/new scope on rotation)';

-- Migration complete
-- Next steps:
-- 1. Run this script against enterprise-db PostgreSQL database
-- 2. Verify tables created: \dt employee_*
-- 3. Test department config seeded: SELECT * FROM employee_department_config;
