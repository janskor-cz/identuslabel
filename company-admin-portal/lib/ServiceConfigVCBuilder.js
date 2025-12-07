/**
 * ServiceConfiguration Verifiable Credential Builder
 * Constructs minimal W3C-compliant ServiceConfiguration VCs for employee wallet provisioning
 *
 * Minimal Structure (3 fields only):
 * - enterpriseAgentUrl: HTTPS endpoint of Enterprise Cloud Agent
 * - enterpriseAgentName: Display name of the agent
 * - enterpriseAgentApiKey: 64-character hex authentication key
 *
 * All other information (employeePrismDid, walletId, mediator, services, etc.)
 * should be queried dynamically after configuration is applied.
 */

const EmployeeWalletManager = require('./EmployeeWalletManager');

class ServiceConfigVCBuilder {
    /**
     * Build minimal ServiceConfiguration VC claims with auto-created employee wallet
     * @param {Object} employeeData - Employee information (for wallet creation only)
     * @param {string} employeeData.email - Employee email
     * @param {string} employeeData.name - Employee name
     * @param {string} employeeData.department - Department
     * @param {string} employeeData.connectionId - DIDComm connection ID
     * @returns {Promise<Object>} { credentialSubject, employeeWallet }
     */
    static async buildServiceConfigClaims(employeeData) {
        try {
            console.log(`\n🏗️  [ServiceConfigVCBuilder] Building ServiceConfig claims for: ${employeeData.name}`);

            // 1. Create individual employee wallet on Employee Cloud Agent (port 8300)
            console.log('  → Step 1/3: Creating employee wallet with PRISM DID...');
            const employeeWallet = await EmployeeWalletManager.createEmployeeWallet({
                email: employeeData.email,
                name: employeeData.name,
                department: employeeData.department
            });

            console.log(`  ✅ Employee wallet created:`);
            console.log(`     Wallet ID: ${employeeWallet.walletId}`);
            console.log(`     PRISM DID: ${employeeWallet.prismDid.substring(0, 60)}...`);
            console.log(`     API Key: ${employeeWallet.apiKey.substring(0, 20)}...`);

            // 2. Build MINIMAL credential subject claims (only connection essentials)
            console.log('  → Step 2/2: Building minimal credential subject claims...');
            const credentialSubject = {
                // Enterprise Cloud Agent connection (ONLY essentials)
                enterpriseAgentUrl: "https://identuslabel.cz/enterprise",
                enterpriseAgentName: "TechCorp Enterprise Agent",
                enterpriseAgentApiKey: employeeWallet.apiKey,
                enterpriseAgentWalletId: employeeWallet.walletId  // CRITICAL: Required for API key encryption
            };

            console.log(`  ✅ Minimal ServiceConfiguration claims built successfully`);
            console.log(`     URL: ${credentialSubject.enterpriseAgentUrl}`);
            console.log(`     Name: ${credentialSubject.enterpriseAgentName}`);
            console.log(`     Wallet ID: ${credentialSubject.enterpriseAgentWalletId}`);
            console.log(`     API Key: ${credentialSubject.enterpriseAgentApiKey.substring(0, 20)}...\n`);

            // 3. Return complete credential claims structure + employee wallet details
            return {
                credentialSubject,
                employeeWallet // Include wallet details for logging/tracking
            };

        } catch (error) {
            console.error('[ServiceConfigVCBuilder] Error building VC claims:', error);
            throw new Error(`Failed to build ServiceConfiguration claims: ${error.message}`);
        }
    }

    /**
     * Build complete ServiceConfiguration VC JSON structure
     * (For reference/testing - actual issuance done via Cloud Agent API)
     * @param {Object} employeeData - Employee information
     * @param {string} issuerDID - Issuer DID (company DID)
     * @returns {Promise<Object>} Complete VC JSON + employee wallet details
     */
    static async buildCompleteVC(employeeData, issuerDID) {
        try {
            const claims = await this.buildServiceConfigClaims(employeeData);

            return {
                vc: {
                    "@context": [
                        "https://www.w3.org/2018/credentials/v1",
                        "https://identuslabel.cz/schemas/v1"
                    ],
                    "type": ["VerifiableCredential", "ServiceConfiguration"],
                    "issuer": issuerDID,
                    "credentialSubject": claims.credentialSubject
                },
                employeeWallet: claims.employeeWallet // Include wallet details
            };

        } catch (error) {
            console.error('[ServiceConfigVCBuilder] Error building complete VC:', error);
            throw error;
        }
    }

    /**
     * Build credential offer payload for Cloud Agent
     * @param {string} connectionId - DIDComm connection ID
     * @param {Object} claims - VC claims from buildServiceConfigClaims()
     * @param {string} issuerDID - Company's PRISM DID that will issue the credential
     * @param {string} schemaId - Schema ID from Cloud Agent schema registry
     * @returns {Object} Cloud Agent credential offer payload
     */
    static buildCredentialOfferPayload(connectionId, claims, issuerDID, schemaId) {
        return {
            connectionId: connectionId,
            credentialFormat: "JWT",
            claims: claims.credentialSubject, // Cloud Agent expects just credentialSubject
            automaticIssuance: true, // Auto-issue without manual approval
            issuingDID: issuerDID, // Company's PRISM DID
            schemaId: schemaId // REQUIRED: Reference to registered schema in Cloud Agent
        };
    }

    /**
     * Extract minimal configuration from ServiceConfiguration VC
     * (Used by wallet to parse received VC - only connection essentials)
     * @param {Object} vc - Verifiable Credential
     * @returns {Object} Parsed configuration (URL, Name, API Key only)
     */
    static extractConfiguration(vc) {
        try {
            const subject = vc.credentialSubject || vc.vc?.credentialSubject;

            if (!subject || !subject.enterpriseAgentUrl) {
                throw new Error('Invalid ServiceConfiguration VC structure');
            }

            // Return ONLY the 3 essential fields
            return {
                enterpriseAgentUrl: subject.enterpriseAgentUrl,
                enterpriseAgentName: subject.enterpriseAgentName,
                enterpriseAgentApiKey: subject.enterpriseAgentApiKey
            };

        } catch (error) {
            console.error('[ServiceConfigVCBuilder] Error extracting configuration:', error);
            throw new Error('Failed to extract configuration from VC');
        }
    }

    /**
     * Validate minimal ServiceConfiguration VC structure
     * @param {Object} vc - Verifiable Credential to validate
     * @returns {Object} { valid: boolean, errors: Array<string> }
     */
    static validateVC(vc) {
        const errors = [];

        // Check @context
        if (!vc['@context'] || !Array.isArray(vc['@context'])) {
            errors.push('Missing or invalid @context');
        }

        // Check type
        if (!vc.type || !vc.type.includes('ServiceConfiguration')) {
            errors.push('Missing ServiceConfiguration type');
        }

        // Check issuer
        if (!vc.issuer || !vc.issuer.startsWith('did:')) {
            errors.push('Missing or invalid issuer DID');
        }

        // Check credentialSubject
        const subject = vc.credentialSubject || vc.vc?.credentialSubject;

        if (!subject) {
            errors.push('Missing credentialSubject');
        } else {
            // Validate ONLY the 3 required minimal fields
            if (!subject.enterpriseAgentUrl) {
                errors.push('Missing enterpriseAgentUrl');
            } else {
                // Validate URL format
                try {
                    new URL(subject.enterpriseAgentUrl);
                } catch (e) {
                    errors.push('Invalid enterpriseAgentUrl format');
                }
            }

            if (!subject.enterpriseAgentName) {
                errors.push('Missing enterpriseAgentName');
            }

            if (!subject.enterpriseAgentApiKey) {
                errors.push('Missing enterpriseAgentApiKey');
            } else if (subject.enterpriseAgentApiKey.length !== 64) {
                errors.push('Invalid enterpriseAgentApiKey (must be 64-character hex string)');
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }
}

module.exports = ServiceConfigVCBuilder;
