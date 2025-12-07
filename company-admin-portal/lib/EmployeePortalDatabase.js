/**
 * Employee Portal Database Interface
 *
 * Provides database operations for the employee portal authentication tracking system.
 * Works with the schema defined in migrations/add-employee-portal-tracking.sql
 */

const crypto = require('crypto');

class EmployeePortalDatabase {
  constructor(pgClient) {
    this.db = pgClient;
  }

  /**
   * Generate salt for API key hashing
   */
  generateSalt() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Hash API key with salt
   */
  hashApiKey(apiKey, salt) {
    return crypto
      .createHash('sha256')
      .update(salt + apiKey)
      .digest('hex');
  }

  /**
   * Get last 8 characters of API key as hint
   */
  getApiKeyHint(apiKey) {
    return apiKey.slice(-8);
  }

  /**
   * Create new employee portal account
   */
  async createEmployeeAccount({
    email,
    fullName,
    department,
    employeeId,
    walletId,
    entityId,
    apiKey,
    prismDid = null,
    createdBy = 'system'
  }) {
    const salt = this.generateSalt();
    const apiKeyHash = this.hashApiKey(apiKey, salt);
    const apiKeyHint = this.getApiKeyHint(apiKey);

    const query = `
      INSERT INTO employee_portal_accounts (
        email,
        full_name,
        department,
        employee_id,
        wallet_id,
        entity_id,
        api_key_hash,
        api_key_salt,
        api_key_hint,
        prism_did,
        prism_did_short,
        created_by,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, email, full_name, department, wallet_id, created_at
    `;

    const prismDidShort = prismDid ? prismDid.split(':').pop().substring(0, 8) : null;

    const values = [
      email,
      fullName,
      department,
      employeeId,
      walletId,
      entityId,
      apiKeyHash,
      salt,
      apiKeyHint,
      prismDid,
      prismDidShort,
      createdBy,
      JSON.stringify({ createdAt: new Date().toISOString() })
    ];

    try {
      const result = await this.db.query(query, values);
      return result.rows[0];
    } catch (error) {
      if (error.constraint === 'employee_portal_accounts_email_key') {
        throw new Error(`Employee with email ${email} already exists`);
      }
      if (error.constraint === 'employee_portal_accounts_wallet_id_key') {
        throw new Error(`Wallet ID ${walletId} already assigned to another employee`);
      }
      throw error;
    }
  }

  /**
   * Get employee by email
   */
  async getEmployeeByEmail(email) {
    const query = `
      SELECT
        id,
        email,
        full_name,
        department,
        employee_id,
        wallet_id,
        entity_id,
        api_key_hint,
        prism_did,
        prism_did_published,
        techcorp_connection_id,
        techcorp_connection_state,
        employee_role_vc_issued,
        cis_training_vc_issued,
        service_config_vc_issued,
        is_active,
        created_at,
        updated_at
      FROM employee_portal_accounts
      WHERE email = $1 AND deleted_at IS NULL
    `;

    const result = await this.db.query(query, [email]);
    return result.rows[0] || null;
  }

  /**
   * Get employee by PRISM DID
   */
  async getEmployeeByDid(prismDid) {
    const query = `
      SELECT
        id,
        email,
        full_name,
        department,
        wallet_id,
        entity_id,
        prism_did,
        techcorp_connection_id
      FROM employee_portal_accounts
      WHERE prism_did = $1 AND deleted_at IS NULL
    `;

    const result = await this.db.query(query, [prismDid]);
    return result.rows[0] || null;
  }

  /**
   * Verify API key for employee
   */
  async verifyApiKey(email, apiKey) {
    const query = `
      SELECT
        id,
        api_key_hash,
        api_key_salt,
        is_active
      FROM employee_portal_accounts
      WHERE email = $1 AND deleted_at IS NULL
    `;

    const result = await this.db.query(query, [email]);
    if (!result.rows[0]) {
      return { valid: false, reason: 'Employee not found' };
    }

    const employee = result.rows[0];
    if (!employee.is_active) {
      return { valid: false, reason: 'Employee account inactive' };
    }

    const providedHash = this.hashApiKey(apiKey, employee.api_key_salt);
    const isValid = providedHash === employee.api_key_hash;

    // Log access attempt
    await this.logApiAccess({
      employeeAccountId: isValid ? employee.id : null,
      apiKeyHint: this.getApiKeyHint(apiKey),
      accessGranted: isValid,
      denialReason: isValid ? null : 'Invalid API key'
    });

    return { valid: isValid, employeeId: employee.id };
  }

  /**
   * Update PRISM DID after publication
   */
  async updatePrismDid(walletId, prismDid) {
    const query = `
      UPDATE employee_portal_accounts
      SET
        prism_did = $2,
        prism_did_short = $3,
        prism_did_published = true,
        prism_did_published_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE wallet_id = $1 AND deleted_at IS NULL
      RETURNING id, email, prism_did
    `;

    const prismDidShort = prismDid.split(':').pop().substring(0, 8);
    const result = await this.db.query(query, [walletId, prismDid, prismDidShort]);
    return result.rows[0];
  }

  /**
   * Update TechCorp connection
   */
  async updateTechCorpConnection(employeeId, connectionId, state) {
    const query = `
      UPDATE employee_portal_accounts
      SET
        techcorp_connection_id = $2::uuid,
        techcorp_connection_state = $3::varchar,
        techcorp_connection_established_at = CASE
          WHEN $3::varchar IN ('Connected', 'ConnectionResponseReceived', 'ConnectionResponseSent')
          THEN CURRENT_TIMESTAMP
          ELSE techcorp_connection_established_at
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
      RETURNING id, email, techcorp_connection_id, techcorp_connection_state
    `;

    const result = await this.db.query(query, [employeeId, connectionId, state]);

    // Log connection event
    if (result.rows[0]) {
      await this.logConnectionEvent({
        employeeAccountId: employeeId,
        connectionId,
        eventType: `connection_${state.toLowerCase()}`,
        eventState: state
      });
    }

    return result.rows[0];
  }

  /**
   * Record credential issuance
   */
  async recordCredentialIssuance(employeeId, credentialType, recordId, claims = {}) {
    // Update main table based on credential type
    let updateQuery;
    const updateValues = [employeeId, recordId];

    switch (credentialType) {
      case 'EmployeeRole':
        updateQuery = `
          UPDATE employee_portal_accounts
          SET
            employee_role_vc_issued = true,
            employee_role_vc_record_id = $2,
            employee_role_vc_issued_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        break;

      case 'CISTraining':
        updateQuery = `
          UPDATE employee_portal_accounts
          SET
            cis_training_vc_issued = true,
            cis_training_vc_record_id = $2,
            cis_training_vc_issued_at = CURRENT_TIMESTAMP,
            cis_training_completion_date = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        updateValues.push(claims.completionDate || null);
        break;

      case 'ServiceConfiguration':
        updateQuery = `
          UPDATE employee_portal_accounts
          SET
            service_config_vc_issued = true,
            service_config_vc_record_id = $2,
            service_config_vc_issued_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        break;

      default:
        // For other credential types, only record in history
        break;
    }

    if (updateQuery) {
      await this.db.query(updateQuery, updateValues);
    }

    // Record in credential history
    const historyQuery = `
      INSERT INTO employee_credential_history (
        employee_account_id,
        credential_type,
        credential_record_id,
        issued_at,
        issued_by,
        credential_claims,
        status
      ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, 'active')
      RETURNING id
    `;

    const historyValues = [
      employeeId,
      credentialType,
      recordId,
      claims.issuedBy || 'system',
      JSON.stringify(claims)
    ];

    const result = await this.db.query(historyQuery, historyValues);
    return result.rows[0];
  }

  /**
   * Get active employees by department
   */
  async getActiveEmployeesByDepartment(department) {
    const query = `
      SELECT * FROM get_active_employees_by_department($1)
    `;

    const result = await this.db.query(query, [department]);
    return result.rows;
  }

  /**
   * Get employees pending credentials
   */
  async getEmployeesPendingCredentials() {
    const query = `
      SELECT * FROM v_employees_pending_credentials
      ORDER BY created_at DESC
    `;

    const result = await this.db.query(query);
    return result.rows;
  }

  /**
   * Log API access attempt
   */
  async logApiAccess({
    employeeAccountId,
    apiEndpoint,
    httpMethod,
    ipAddress,
    userAgent,
    responseStatus,
    responseTimeMs,
    apiKeyHint,
    accessGranted,
    denialReason,
    metadata = {}
  }) {
    const query = `
      INSERT INTO employee_api_access_log (
        employee_account_id,
        api_endpoint,
        http_method,
        ip_address,
        user_agent,
        response_status,
        response_time_ms,
        api_key_hint,
        access_granted,
        denial_reason,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    const values = [
      employeeAccountId,
      apiEndpoint,
      httpMethod,
      ipAddress,
      userAgent,
      responseStatus,
      responseTimeMs,
      apiKeyHint,
      accessGranted,
      denialReason,
      JSON.stringify(metadata)
    ];

    try {
      await this.db.query(query, values);
    } catch (error) {
      // Log errors should not break the main flow
      console.error('Failed to log API access:', error);
    }
  }

  /**
   * Log connection event
   */
  async logConnectionEvent({
    employeeAccountId,
    connectionId,
    eventType,
    eventState,
    eventData = {},
    sourceSystem = 'company_portal'
  }) {
    const query = `
      INSERT INTO employee_connection_events (
        employee_account_id,
        connection_id,
        event_type,
        event_state,
        event_data,
        source_system
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;

    const values = [
      employeeAccountId,
      connectionId,
      eventType,
      eventState,
      JSON.stringify(eventData),
      sourceSystem
    ];

    try {
      await this.db.query(query, values);
    } catch (error) {
      console.error('Failed to log connection event:', error);
    }
  }

  /**
   * Soft delete employee account
   */
  async softDeleteEmployee(employeeId, reason = null, deletedBy = 'system') {
    const query = `
      UPDATE employee_portal_accounts
      SET
        deleted_at = CURRENT_TIMESTAMP,
        is_active = false,
        deactivation_date = CURRENT_TIMESTAMP,
        deactivation_reason = $2,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = $3
      WHERE id = $1
      RETURNING id, email, deleted_at
    `;

    const result = await this.db.query(query, [employeeId, reason, deletedBy]);
    return result.rows[0];
  }

  /**
   * Get credential history for employee
   */
  async getEmployeeCredentialHistory(employeeId) {
    const query = `
      SELECT
        credential_type,
        credential_record_id,
        issued_at,
        issued_by,
        status,
        expires_at,
        credential_claims
      FROM employee_credential_history
      WHERE employee_account_id = $1
      ORDER BY issued_at DESC
    `;

    const result = await this.db.query(query, [employeeId]);
    return result.rows;
  }

  /**
   * Mark credential as revoked
   */
  async markCredentialRevoked(employeeId, credentialType, recordId, reason = null) {
    // Update main table
    let updateQuery;
    const updateValues = [employeeId];

    switch (credentialType) {
      case 'EmployeeRole':
        updateQuery = `
          UPDATE employee_portal_accounts
          SET
            employee_role_vc_revoked = true,
            employee_role_vc_revoked_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        break;

      case 'CISTraining':
        updateQuery = `
          UPDATE employee_portal_accounts
          SET
            cis_training_vc_revoked = true,
            cis_training_vc_revoked_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `;
        break;
    }

    if (updateQuery) {
      await this.db.query(updateQuery, updateValues);
    }

    // Update credential history
    const historyQuery = `
      UPDATE employee_credential_history
      SET
        status = 'revoked',
        status_changed_at = CURRENT_TIMESTAMP,
        status_change_reason = $3
      WHERE employee_account_id = $1 AND credential_record_id = $2
    `;

    await this.db.query(historyQuery, [employeeId, recordId, reason]);
  }
}

module.exports = EmployeePortalDatabase;