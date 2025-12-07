/**
 * Connection Event Handler
 * Handles automatic issuance of ServiceConfiguration VCs when employee connections are established
 */

const fetch = require('node-fetch');
const EmployeeApiKeyManager = require('./EmployeeApiKeyManager');
const ServiceConfigVCBuilder = require('./ServiceConfigVCBuilder');
const SchemaManager = require('./SchemaManager');

class ConnectionEventHandler {
  /**
   * Handle connection established event and auto-issue ServiceConfiguration VC
   * @param {Object} connectionData - Connection information
   * @param {string} connectionData.connectionId - DIDComm connection ID
   * @param {string} connectionData.email - Employee email
   * @param {string} connectionData.name - Employee name
   * @param {string} connectionData.department - Department (HR, IT, or Security)
   * @param {string} connectionData.state - Connection state
   * @param {string} connectionData.cloudAgentUrl - Multitenancy Cloud Agent URL
   * @param {string} connectionData.companyApiKey - Company API key for issuing VCs
   * @param {string} connectionData.issuerDID - Company's PRISM DID for issuing credentials
   * @returns {Promise<Object>} Result object with success status
   */
  static async handleConnectionEstablished(connectionData) {
    try {
      const { connectionId, email, name, department, state, cloudAgentUrl, companyApiKey, issuerDID } = connectionData;

      console.log(`[CONNECTION-HANDLER] Processing connection ${connectionId} for ${name} (state: ${state})`);
      console.log(`[CONNECTION-HANDLER] Using Cloud Agent: ${cloudAgentUrl}`);
      console.log(`[CONNECTION-HANDLER] Issuer DID: ${issuerDID}`);

      // Validate required parameters
      if (!cloudAgentUrl || !companyApiKey || !issuerDID) {
        throw new Error('cloudAgentUrl, companyApiKey, and issuerDID are required');
      }

      // Only process active connections
      if (state !== 'ConnectionResponseSent' && state !== 'Active') {
        return {
          success: false,
          reason: 'connection_not_active',
          message: `Connection state is ${state}, waiting for active state`
        };
      }

      // Validate department
      if (!['HR', 'IT', 'Security'].includes(department)) {
        throw new Error(`Invalid department: ${department}`);
      }

      // ✨ REMOVED: API key generation step (now auto-created during wallet creation)
      // The new architecture auto-creates individual employee wallets with their own API keys

      // Step 1: Build ServiceConfiguration VC claims (auto-creates employee wallet with PRISM DID)
      console.log(`[CONNECTION-HANDLER] Building ServiceConfiguration VC claims for ${name} (${email})`);
      console.log(`[CONNECTION-HANDLER] This will auto-create an employee wallet on Employee Cloud Agent (port 8300)`);

      const claims = await ServiceConfigVCBuilder.buildServiceConfigClaims({
        email,
        name,
        department,
        connectionId
      }); // ✨ REMOVED: apiKeyPlaintext parameter (auto-generated in wallet creation)

      // ✨ NEW: Log employee wallet details (created during claims build)
      console.log(`[CONNECTION-HANDLER] ✅ Employee wallet created:`);
      console.log(`   Wallet ID: ${claims.employeeWallet.walletId}`);
      console.log(`   Entity ID: ${claims.employeeWallet.entityId}`);
      console.log(`   PRISM DID: ${claims.employeeWallet.prismDid.substring(0, 60)}...`);
      console.log(`   API Key: ${claims.employeeWallet.apiKey.substring(0, 20)}... (stored in VC)`);

      // Step 2.5: Ensure ServiceConfiguration schema is registered
      console.log(`[CONNECTION-HANDLER] Ensuring ServiceConfiguration schema is registered`);
      const schemaId = await SchemaManager.ensureServiceConfigSchema(
        cloudAgentUrl,
        companyApiKey,
        issuerDID
      );
      console.log(`[CONNECTION-HANDLER] Using schema: ${schemaId}`);

      // Step 3: Build credential offer payload
      const credentialOffer = ServiceConfigVCBuilder.buildCredentialOfferPayload(
        connectionId,
        claims,
        issuerDID,
        schemaId
      );

      // Step 4: Issue credential via Multitenancy Cloud Agent (company's wallet)
      console.log(`[CONNECTION-HANDLER] Issuing ServiceConfiguration VC via Multitenancy Cloud Agent`);
      const response = await fetch(`${cloudAgentUrl}/issue-credentials/credential-offers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': companyApiKey
        },
        body: JSON.stringify(credentialOffer)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud Agent error (${response.status}): ${errorText}`);
      }

      const vcRecord = await response.json();

      // ✨ REMOVED: Step 5 - markConfigVcIssued() call
      // No longer needed as API keys are managed by Enterprise Agent's IAM system, not employee_api_keys table

      console.log(`[CONNECTION-HANDLER] ✅ ServiceConfiguration VC issued successfully`);
      console.log(`[CONNECTION-HANDLER] - Employee: ${name} (${email})`);
      console.log(`[CONNECTION-HANDLER] - Department: ${department}`);
      console.log(`[CONNECTION-HANDLER] - Connection ID: ${connectionId}`);
      console.log(`[CONNECTION-HANDLER] - VC Record ID: ${vcRecord.recordId}`);
      console.log(`[CONNECTION-HANDLER] - Wallet ID: ${claims.employeeWallet.walletId}`);
      console.log(`[CONNECTION-HANDLER] - Entity ID: ${claims.employeeWallet.entityId}`);

      return {
        success: true,
        message: 'ServiceConfiguration VC issued successfully',
        data: {
          walletId: claims.employeeWallet.walletId,
          entityId: claims.employeeWallet.entityId,
          vcRecordId: vcRecord.recordId,
          connectionId,
          department,
          employee: { name, email }
        }
      };

    } catch (error) {
      console.error('[CONNECTION-HANDLER] ❌ Error processing connection:', error);
      return {
        success: false,
        reason: 'error',
        message: error.message,
        error: error
      };
    }
  }

  /**
   * Check if ServiceConfiguration VC should be issued for a connection
   * @param {string} connectionId - DIDComm connection ID
   * @param {string} department - Department name
   * @returns {Promise<Object>} Status object
   */
  static async shouldIssueServiceConfig(connectionId, department) {
    try {
      const keys = await EmployeeApiKeyManager.getDepartmentApiKeys(department);
      const existingKey = keys.find(k => k.connectionId === connectionId);

      if (!existingKey) {
        return {
          shouldIssue: true,
          reason: 'no_api_key',
          message: 'No API key generated yet'
        };
      }

      if (existingKey.configVcIssued) {
        return {
          shouldIssue: false,
          reason: 'already_issued',
          message: 'ServiceConfiguration VC already issued',
          keyData: existingKey
        };
      }

      return {
        shouldIssue: false,
        reason: 'api_key_exists_no_plaintext',
        message: 'API key exists but plaintext not available. Manual intervention required.',
        keyData: existingKey
      };

    } catch (error) {
      console.error('[CONNECTION-HANDLER] Error checking status:', error);
      return {
        shouldIssue: false,
        reason: 'error',
        message: error.message,
        error: error
      };
    }
  }

  /**
   * Process pending connections and issue ServiceConfiguration VCs
   * (Can be called manually or via scheduled job)
   * @param {string} department - Department to process
   * @param {Array<Object>} connections - Array of connection objects from Cloud Agent
   * @param {string} cloudAgentUrl - Multitenancy Cloud Agent URL
   * @param {string} companyApiKey - Company API key for issuing VCs
   * @param {string} issuerDID - Company's PRISM DID for issuing credentials
   * @returns {Promise<Object>} Summary of processing results
   */
  static async processPendingConnections(department, connections, cloudAgentUrl, companyApiKey, issuerDID) {
    const results = {
      processed: 0,
      issued: 0,
      skipped: 0,
      errors: 0,
      details: []
    };

    console.log(`[CONNECTION-HANDLER] Processing ${connections.length} connections for ${department}`);

    for (const conn of connections) {
      results.processed++;

      try {
        // Skip if not active
        if (conn.state !== 'ConnectionResponseSent' && conn.state !== 'Active') {
          results.skipped++;
          results.details.push({
            connectionId: conn.connectionId,
            status: 'skipped',
            reason: 'not_active',
            state: conn.state
          });
          continue;
        }

        // Extract employee info from connection label
        // Expected format: "Employee Name (Role) - Department"
        const label = conn.label || '';
        const parts = label.split(' - ');
        const namePart = parts[0] || '';
        const [name, role] = namePart.split(' (');

        // Try to extract email from theirLabel or use placeholder
        const email = conn.theirLabel || `${name.toLowerCase().replace(/\s+/g, '.')}@company.com`;

        const result = await this.handleConnectionEstablished({
          connectionId: conn.connectionId,
          email: email,
          name: name.trim(),
          department: department,
          state: conn.state,
          cloudAgentUrl: cloudAgentUrl,
          companyApiKey: companyApiKey,
          issuerDID: issuerDID
        });

        if (result.success) {
          results.issued++;
          results.details.push({
            connectionId: conn.connectionId,
            status: 'issued',
            ...result.data
          });
        } else {
          if (result.reason === 'already_issued') {
            results.skipped++;
          } else {
            results.errors++;
          }
          results.details.push({
            connectionId: conn.connectionId,
            status: 'skipped',
            reason: result.reason,
            message: result.message
          });
        }

      } catch (error) {
        results.errors++;
        results.details.push({
          connectionId: conn.connectionId,
          status: 'error',
          message: error.message
        });
      }
    }

    console.log(`[CONNECTION-HANDLER] ✅ Processing complete: ${results.issued} issued, ${results.skipped} skipped, ${results.errors} errors`);

    return results;
  }
}

module.exports = ConnectionEventHandler;
