/**
 * Employee API Key Manager
 * Handles generation, validation, rotation, and revocation of employee-specific API keys
 * for Enterprise Cloud Agent authentication
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

// BCRYPT_ROUNDS: Cost factor for bcrypt hashing (10 = ~100ms per hash on modern CPU)
const BCRYPT_ROUNDS = 10;

// API_KEY_LENGTH: Length of generated API keys in bytes (64 bytes = 128 hex chars)
const API_KEY_LENGTH = 32; // 32 bytes = 64 hex characters

// Default API key validity period (1 year)
const DEFAULT_EXPIRY_DAYS = 365;

// PostgreSQL connection pool for enterprise database
const pool = new Pool({
    host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',  // External IP for outside Docker
    port: process.env.ENTERPRISE_DB_PORT || 5434,           // External port mapping
    database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
    user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
    password: process.env.ENTERPRISE_DB_PASSWORD || 'dummy',  // From init-enterprise-dbs.sql
});

class EmployeeApiKeyManager {
    /**
     * Generate a new employee-specific API key
     * @param {Object} employeeData - Employee information
     * @param {string} employeeData.connectionId - DIDComm connection ID
     * @param {string} employeeData.email - Employee email
     * @param {string} employeeData.name - Employee name
     * @param {string} employeeData.department - Department ('HR', 'IT', or 'Security')
     * @param {Array<string>} customScope - Optional custom scope (defaults to department's default)
     * @param {number} expiryDays - Optional expiry period in days (default: 365)
     * @returns {Promise<Object>} { apiKey: string (plaintext, show once), keyId: string, expiresAt: Date }
     */
    static async generateEmployeeApiKey(employeeData, customScope = null, expiryDays = DEFAULT_EXPIRY_DAYS) {
        try {
            // 1. Generate cryptographically secure random API key
            const apiKey = crypto.randomBytes(API_KEY_LENGTH).toString('hex');

            // 2. Hash API key with bcrypt (never store plaintext)
            const apiKeyHash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS);

            // 3. Get department configuration for default scope
            const deptConfig = await this.getDepartmentConfig(employeeData.department);
            const scope = customScope || deptConfig.default_employee_scope;

            // 4. Calculate expiration date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiryDays);

            // 5. Store in database
            const insertQuery = `
                INSERT INTO employee_api_keys (
                    connection_id,
                    employee_email,
                    employee_name,
                    department,
                    api_key_hash,
                    scope,
                    expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, created_at
            `;

            const result = await pool.query(insertQuery, [
                employeeData.connectionId,
                employeeData.email,
                employeeData.name,
                employeeData.department,
                apiKeyHash,
                JSON.stringify(scope),
                expiresAt
            ]);

            const keyId = result.rows[0].id;
            const createdAt = result.rows[0].created_at;

            // 6. Audit log
            await this.auditLog(keyId, 'key_generated', {
                success: true,
                metadata: {
                    department: employeeData.department,
                    scope: scope,
                    expiryDays: expiryDays
                }
            });

            // 7. Return plaintext API key (ONLY TIME IT'S VISIBLE)
            return {
                apiKey: apiKey, // Plaintext - must be stored by caller immediately
                keyId: keyId,
                createdAt: createdAt,
                expiresAt: expiresAt,
                scope: scope
            };

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error generating API key:', error);
            throw new Error(`Failed to generate employee API key: ${error.message}`);
        }
    }

    /**
     * Validate an API key (called on each authenticated request)
     * @param {string} apiKey - Plaintext API key from request header
     * @param {string} connectionId - Optional connection ID to verify key ownership
     * @returns {Promise<Object|null>} Employee data if valid, null if invalid
     */
    static async validateApiKey(apiKey, connectionId = null) {
        try {
            // 1. Query all non-revoked, non-expired keys
            const query = `
                SELECT id, connection_id, employee_email, employee_name, department,
                       api_key_hash, scope, expires_at, usage_count
                FROM employee_api_keys
                WHERE revoked = FALSE
                  AND expires_at > CURRENT_TIMESTAMP
                ${connectionId ? 'AND connection_id = $1' : ''}
                ORDER BY created_at DESC
            `;

            const params = connectionId ? [connectionId] : [];
            const result = await pool.query(query, params);

            // 2. Compare API key against each hash (constant-time comparison via bcrypt)
            for (const row of result.rows) {
                const isValid = await bcrypt.compare(apiKey, row.api_key_hash);

                if (isValid) {
                    // 3. Update last used timestamp and usage count
                    await pool.query(`
                        UPDATE employee_api_keys
                        SET last_used_at = CURRENT_TIMESTAMP,
                            usage_count = usage_count + 1
                        WHERE id = $1
                    `, [row.id]);

                    // 4. Audit log
                    await this.auditLog(row.id, 'key_validated', {
                        success: true,
                        endpoint: null // Set by caller
                    });

                    // 5. Return employee data
                    return {
                        keyId: row.id,
                        connectionId: row.connection_id,
                        email: row.employee_email,
                        name: row.employee_name,
                        department: row.department,
                        scope: row.scope,
                        expiresAt: row.expires_at,
                        usageCount: row.usage_count + 1
                    };
                }
            }

            // 6. No matching key found - audit failed attempt
            await this.auditLog(null, 'unauthorized_attempt', {
                success: false,
                error_message: 'Invalid or expired API key',
                metadata: { connectionId: connectionId }
            });

            return null;

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error validating API key:', error);
            return null;
        }
    }

    /**
     * Revoke an API key (e.g., employee offboarding, security incident)
     * @param {string} keyId - UUID of the API key to revoke
     * @param {string} reason - Reason for revocation
     * @returns {Promise<boolean>} True if revoked, false if not found
     */
    static async revokeApiKey(keyId, reason = 'Revoked by administrator') {
        try {
            const result = await pool.query(`
                UPDATE employee_api_keys
                SET revoked = TRUE,
                    revoked_at = CURRENT_TIMESTAMP,
                    revoked_reason = $1
                WHERE id = $2
                  AND revoked = FALSE
                RETURNING id, employee_email
            `, [reason, keyId]);

            if (result.rowCount === 0) {
                return false; // Key not found or already revoked
            }

            await this.auditLog(keyId, 'key_revoked', {
                success: true,
                metadata: { reason: reason }
            });

            console.log(`[EmployeeApiKeyManager] Revoked API key ${keyId} for ${result.rows[0].employee_email}`);
            return true;

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error revoking API key:', error);
            return false;
        }
    }

    /**
     * Rotate an API key (revoke old, generate new)
     * Used for periodic key rotation or after security incidents
     * @param {string} oldKeyId - UUID of the old API key to revoke
     * @param {number} expiryDays - Optional expiry period for new key
     * @returns {Promise<Object>} New API key data
     */
    static async rotateApiKey(oldKeyId, expiryDays = DEFAULT_EXPIRY_DAYS) {
        try {
            // 1. Get old key details
            const oldKeyResult = await pool.query(`
                SELECT connection_id, employee_email, employee_name, department, scope
                FROM employee_api_keys
                WHERE id = $1
            `, [oldKeyId]);

            if (oldKeyResult.rowCount === 0) {
                throw new Error('Old API key not found');
            }

            const oldKeyData = oldKeyResult.rows[0];

            // 2. Revoke old API key FIRST (to avoid constraint violation)
            await this.revokeApiKey(oldKeyId, 'Rotated to new key');

            // 3. Generate new API key SECOND (now safe - only one active key)
            const newKeyData = await this.generateEmployeeApiKey({
                connectionId: oldKeyData.connection_id,
                email: oldKeyData.employee_email,
                name: oldKeyData.employee_name,
                department: oldKeyData.department
            }, oldKeyData.scope, expiryDays);

            // 4. Audit log
            await this.auditLog(newKeyData.keyId, 'key_rotated', {
                success: true,
                metadata: {
                    oldKeyId: oldKeyId,
                    rotatedBy: 'system'
                }
            });

            console.log(`[EmployeeApiKeyManager] Rotated API key ${oldKeyId} → ${newKeyData.keyId}`);
            return newKeyData;

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error rotating API key:', error);
            throw error;
        }
    }

    /**
     * Get all API keys for a department
     * @param {string} department - Department name
     * @returns {Promise<Array>} List of API keys (without hashes)
     */
    static async getDepartmentApiKeys(department) {
        try {
            const result = await pool.query(`
                SELECT id, connection_id, employee_email, employee_name,
                       scope, created_at, expires_at, revoked, last_used_at, usage_count,
                       config_vc_issued, config_accepted
                FROM employee_api_keys
                WHERE department = $1
                ORDER BY created_at DESC
            `, [department]);

            return result.rows.map(row => ({
                keyId: row.id,
                connectionId: row.connection_id,
                email: row.employee_email,
                name: row.employee_name,
                scope: row.scope,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                revoked: row.revoked,
                lastUsedAt: row.last_used_at,
                usageCount: row.usage_count,
                configVcIssued: row.config_vc_issued,
                configAccepted: row.config_accepted,
                // Compute status
                status: this.computeKeyStatus(row)
            }));

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error getting department API keys:', error);
            return [];
        }
    }

    /**
     * Mark ServiceConfiguration VC as issued
     * @param {string} connectionId - Connection ID
     * @param {string} vcRecordId - VC record ID from Cloud Agent
     */
    static async markConfigVcIssued(connectionId, vcRecordId) {
        try {
            await pool.query(`
                UPDATE employee_api_keys
                SET config_vc_issued = TRUE,
                    config_vc_record_id = $1
                WHERE connection_id = $2
            `, [vcRecordId, connectionId]);

            await this.auditLog(null, 'config_issued', {
                success: true,
                metadata: { connectionId, vcRecordId }
            });

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error marking config VC issued:', error);
        }
    }

    /**
     * Mark configuration as accepted by employee wallet
     * @param {string} connectionId - Connection ID
     */
    static async markConfigAccepted(connectionId) {
        try {
            await pool.query(`
                UPDATE employee_api_keys
                SET config_accepted = TRUE,
                    config_accepted_at = CURRENT_TIMESTAMP
                WHERE connection_id = $1
            `, [connectionId]);

            await this.auditLog(null, 'config_accepted', {
                success: true,
                metadata: { connectionId }
            });

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error marking config accepted:', error);
        }
    }

    /**
     * Get department configuration
     * @param {string} department - Department name
     * @returns {Promise<Object>} Department config
     */
    static async getDepartmentConfig(department) {
        const result = await pool.query(`
            SELECT * FROM employee_department_config WHERE department = $1
        `, [department]);

        if (result.rowCount === 0) {
            throw new Error(`Department configuration not found: ${department}`);
        }

        return result.rows[0];
    }

    /**
     * Compute key status (active, expired, revoked, etc.)
     * @param {Object} keyRow - Database row
     * @returns {string} Status string
     */
    static computeKeyStatus(keyRow) {
        if (keyRow.revoked) {
            return 'revoked';
        }

        if (new Date(keyRow.expires_at) < new Date()) {
            return 'expired';
        }

        if (!keyRow.config_vc_issued) {
            return 'pending_config';
        }

        if (!keyRow.config_accepted) {
            return 'pending_acceptance';
        }

        return 'active';
    }

    /**
     * Audit log helper
     * @param {string|null} keyId - API key ID (null for system-level events)
     * @param {string} action - Action type
     * @param {Object} details - Additional details
     */
    static async auditLog(keyId, action, details = {}) {
        try {
            // Get key ID from connection if not provided
            let actualKeyId = keyId;
            if (!keyId && details.metadata && details.metadata.connectionId) {
                const result = await pool.query(`
                    SELECT id FROM employee_api_keys WHERE connection_id = $1 LIMIT 1
                `, [details.metadata.connectionId]);

                if (result.rowCount > 0) {
                    actualKeyId = result.rows[0].id;
                }
            }

            await pool.query(`
                INSERT INTO employee_api_key_audit (
                    api_key_id, action, success, error_message, endpoint, metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                actualKeyId,
                action,
                details.success !== undefined ? details.success : true,
                details.error_message || null,
                details.endpoint || null,
                JSON.stringify(details.metadata || {})
            ]);

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error writing audit log:', error);
            // Don't throw - audit failure shouldn't break operations
        }
    }

    /**
     * Check for expired keys (for scheduled cleanup job)
     * @returns {Promise<Array>} List of expired keys
     */
    static async checkExpiredKeys() {
        try {
            const result = await pool.query(`
                SELECT id, employee_email, expires_at
                FROM employee_api_keys
                WHERE expires_at < CURRENT_TIMESTAMP
                  AND revoked = FALSE
            `);

            return result.rows.map(row => ({
                keyId: row.id,
                email: row.employee_email,
                expiredSince: new Date() - new Date(row.expires_at)
            }));

        } catch (error) {
            console.error('[EmployeeApiKeyManager] Error checking expired keys:', error);
            return [];
        }
    }
}

module.exports = EmployeeApiKeyManager;
