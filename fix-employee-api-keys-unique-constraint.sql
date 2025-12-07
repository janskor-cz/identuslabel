-- Fix Employee API Keys UNIQUE Constraint
-- Allow multiple keys per connection (for rotation history)
-- But only ONE active (non-revoked) key per connection
--
-- Created: 2025-11-12
-- Issue: duplicate key value violates unique constraint "employee_api_keys_connection_id_key"

-- Step 1: Drop the UNIQUE constraint on connection_id
ALTER TABLE employee_api_keys
DROP CONSTRAINT IF EXISTS employee_api_keys_connection_id_key;

-- Step 2: Create a partial UNIQUE index
-- This ensures only ONE active (revoked=FALSE) key per connection
-- But allows multiple revoked keys for audit history
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_api_keys_active_connection
ON employee_api_keys(connection_id)
WHERE revoked = FALSE;

-- Verification query
-- Should show which connections have multiple keys (history)
SELECT
    connection_id,
    COUNT(*) as total_keys,
    SUM(CASE WHEN revoked = FALSE THEN 1 ELSE 0 END) as active_keys,
    SUM(CASE WHEN revoked = TRUE THEN 1 ELSE 0 END) as revoked_keys
FROM employee_api_keys
GROUP BY connection_id
ORDER BY total_keys DESC;
