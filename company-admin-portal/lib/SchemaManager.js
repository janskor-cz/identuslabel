/**
 * Schema Manager for Company Admin Portal
 * Handles registration and retrieval of credential schemas in Multitenancy Cloud Agent
 *
 * Manages multiple schema types:
 * - ServiceConfiguration: Enterprise wallet configuration
 * - EmployeeRole: Employee position and department credentials
 * - CISTrainingCertificate: Compliance training completion credentials
 */

const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

class SchemaManager {
    constructor(cloudAgentUrl, apiKey) {
        this.cloudAgentUrl = cloudAgentUrl?.replace(/\/$/, '') || '';
        this.apiKey = apiKey || '';
        this.cacheFile = path.join(__dirname, '..', '.schema-cache.json');
    }

    /**
     * Load cached schema GUIDs from file
     * @private
     * @returns {Object} Cached schema mappings
     */
    async loadCache() {
        try {
            const data = await fs.readFile(this.cacheFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            // Cache doesn't exist yet
            return {};
        }
    }

    /**
     * Save schema GUIDs to cache file
     * @private
     * @param {Object} cache - Schema cache object
     */
    async saveCache(cache) {
        await fs.writeFile(this.cacheFile, JSON.stringify(cache, null, 2));
    }

    /**
     * Register EmployeeRole schema for employee position credentials
     * @param {string} authorDID - Company's PRISM DID (schema author)
     * @returns {Promise<string>} Schema GUID for EmployeeRole
     */
    async registerEmployeeRoleSchema(authorDID) {
        const cache = await this.loadCache();

        // Check cache first
        if (cache.employeeRoleSchemaGuid) {
            console.log('[SchemaManager] Using cached EmployeeRole schema GUID:', cache.employeeRoleSchemaGuid);
            return cache.employeeRoleSchemaGuid;
        }

        const schemaDefinition = {
            name: 'EmployeeRole',
            version: '1.2.0',
            description: 'Employee role and position within organization (with issuer DID for document releasability)',
            type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
            author: authorDID,
            authored: new Date().toISOString(),
            tags: ['employee', 'role', 'hr', 'techcorp', 'issuer-based'],
            schema: {
                '$schema': 'https://json-schema.org/draft/2020-12/schema',
                '$id': 'https://identuslabel.cz/schemas/EmployeeRole/1.2.0',
                'type': 'object',
                'properties': {
                    'prismDid': {
                        'type': 'string'
                    },
                    'employeeId': {
                        'type': 'string'
                    },
                    'email': {
                        'type': 'string'
                    },
                    'issuerDID': {
                        'type': 'string'
                    },
                    'role': {
                        'type': 'string'
                    },
                    'department': {
                        'type': 'string'
                    },
                    'hireDate': {
                        'type': 'string'
                    },
                    'effectiveDate': {
                        'type': 'string'
                    },
                    'expiryDate': {
                        'type': 'string'
                    }
                },
                'required': [
                    'prismDid',
                    'employeeId',
                    'email',
                    'issuerDID',
                    'role',
                    'department',
                    'hireDate',
                    'effectiveDate',
                    'expiryDate'
                ],
                'additionalProperties': false
            }
        };

        try {
            const response = await fetch(`${this.cloudAgentUrl}/schema-registry/schemas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': this.apiKey
                },
                body: JSON.stringify(schemaDefinition)
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 409) {
                    // Schema already exists, try to find it
                    const existing = await this.findSchemaByNameAndVersion('EmployeeRole', '1.2.0');
                    if (existing) {
                        cache.employeeRoleSchemaGuid = existing.guid;
                        await this.saveCache(cache);
                        return existing.guid;
                    }
                }
                throw new Error(`Schema registration failed (${response.status}): ${errorText}`);
            }

            const result = await response.json();
            console.log('[SchemaManager] ✅ EmployeeRole schema registered:', result.guid);

            // Cache the GUID
            cache.employeeRoleSchemaGuid = result.guid;
            await this.saveCache(cache);

            return result.guid;
        } catch (error) {
            console.error('[SchemaManager] Error registering EmployeeRole schema:', error);
            throw error;
        }
    }

    /**
     * Register CISTrainingCertificate schema for compliance training credentials
     * @param {string} authorDID - Company's PRISM DID (schema author)
     * @returns {Promise<string>} Schema GUID for CISTrainingCertificate
     */
    async registerCISTrainingSchema(authorDID) {
        const cache = await this.loadCache();

        // Check cache first
        if (cache.cisTrainingSchemaGuid) {
            console.log('[SchemaManager] Using cached CISTraining schema GUID:', cache.cisTrainingSchemaGuid);
            return cache.cisTrainingSchemaGuid;
        }

        const schemaDefinition = {
            name: 'CISTrainingCertificate',
            version: '1.0.0',
            description: 'Corporate Information Security (CIS) training completion certificate',
            type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
            author: authorDID,
            authored: new Date().toISOString(),
            tags: ['training', 'compliance', 'security', 'cis', 'techcorp'],
            schema: {
                '$schema': 'https://json-schema.org/draft/2020-12/schema',
                '$id': 'https://identuslabel.cz/schemas/CISTrainingCertificate/1.0.0',
                'type': 'object',
                'properties': {
                    'prismDid': {
                        'type': 'string'
                    },
                    'employeeId': {
                        'type': 'string'
                    },
                    'trainingYear': {
                        'type': 'string'
                    },
                    'completionDate': {
                        'type': 'string'
                    },
                    'certificateNumber': {
                        'type': 'string'
                    },
                    'expiryDate': {
                        'type': 'string'
                    }
                },
                'required': [
                    'prismDid',
                    'employeeId',
                    'trainingYear',
                    'completionDate',
                    'certificateNumber',
                    'expiryDate'
                ],
                'additionalProperties': false
            }
        };

        try {
            const response = await fetch(`${this.cloudAgentUrl}/schema-registry/schemas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': this.apiKey
                },
                body: JSON.stringify(schemaDefinition)
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 409) {
                    // Schema already exists, try to find it
                    const existing = await this.findSchemaByNameAndVersion('CISTrainingCertificate', '1.0.0');
                    if (existing) {
                        cache.cisTrainingSchemaGuid = existing.guid;
                        await this.saveCache(cache);
                        return existing.guid;
                    }
                }
                throw new Error(`Schema registration failed (${response.status}): ${errorText}`);
            }

            const result = await response.json();
            console.log('[SchemaManager] ✅ CISTrainingCertificate schema registered:', result.guid);

            // Cache the GUID
            cache.cisTrainingSchemaGuid = result.guid;
            await this.saveCache(cache);

            return result.guid;
        } catch (error) {
            console.error('[SchemaManager] Error registering CISTraining schema:', error);
            throw error;
        }
    }

    /**
     * Register DocumentMetadata schema for document metadata credentials
     * @param {string} authorDID - Company's PRISM DID (schema author)
     * @returns {Promise<string>} Schema GUID for DocumentMetadata
     */
    async registerDocumentMetadataSchema(authorDID) {
        const cache = await this.loadCache();

        // Check cache first
        if (cache.documentMetadataSchemaGuid) {
            console.log('[SchemaManager] Using cached DocumentMetadata schema GUID:', cache.documentMetadataSchemaGuid);
            return cache.documentMetadataSchemaGuid;
        }

        const schemaDefinition = {
            name: 'DocumentMetadata',
            version: '1.0.0',
            description: 'Document metadata credential linking document DID to classification, type, and releasability information',
            type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
            author: authorDID,
            authored: new Date().toISOString(),
            tags: ['document', 'metadata', 'classification', 'releasability', 'techcorp'],
            schema: {
                '$schema': 'https://json-schema.org/draft/2020-12/schema',
                '$id': 'https://identuslabel.cz/schemas/DocumentMetadata/1.0.0',
                'type': 'object',
                'properties': {
                    'documentDID': {
                        'type': 'string',
                        'description': 'PRISM DID of the document (contains Iagon storage URL in service endpoint)'
                    },
                    'documentTitle': {
                        'type': 'string',
                        'description': 'Title of the document'
                    },
                    'documentType': {
                        'type': 'string',
                        'description': 'Type of document (Report, Contract, Policy, Procedure, Memo, Certificate, Other)'
                    },
                    'classificationLevel': {
                        'type': 'string',
                        'description': 'Security classification level (UNCLASSIFIED, CONFIDENTIAL, SECRET, TOP_SECRET)'
                    },
                    'documentDescription': {
                        'type': 'string',
                        'description': 'Description of the document contents'
                    },
                    'releasableTo': {
                        'type': 'string',
                        'description': 'Organizations/entities authorized to receive this document'
                    },
                    'createdBy': {
                        'type': 'string',
                        'description': 'Name of the employee who created the document'
                    },
                    'createdByDID': {
                        'type': 'string',
                        'description': 'PRISM DID of the employee who created the document'
                    },
                    'createdAt': {
                        'type': 'string',
                        'description': 'ISO 8601 timestamp when the document was created'
                    }
                },
                'required': [
                    'documentDID',
                    'documentTitle',
                    'documentType',
                    'classificationLevel'
                ],
                'additionalProperties': false
            }
        };

        try {
            const response = await fetch(`${this.cloudAgentUrl}/schema-registry/schemas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': this.apiKey
                },
                body: JSON.stringify(schemaDefinition)
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 409) {
                    // Schema already exists, try to find it
                    const existing = await this.findSchemaByNameAndVersion('DocumentMetadata', '1.0.0');
                    if (existing) {
                        cache.documentMetadataSchemaGuid = existing.guid;
                        await this.saveCache(cache);
                        return existing.guid;
                    }
                }
                throw new Error(`Schema registration failed (${response.status}): ${errorText}`);
            }

            const result = await response.json();
            console.log('[SchemaManager] ✅ DocumentMetadata schema registered:', result.guid);

            // Cache the GUID
            cache.documentMetadataSchemaGuid = result.guid;
            await this.saveCache(cache);

            return result.guid;
        } catch (error) {
            console.error('[SchemaManager] Error registering DocumentMetadata schema:', error);
            throw error;
        }
    }

    /**
     * Find schema by name and version
     * @param {string} name - Schema name
     * @param {string} version - Schema version
     * @returns {Promise<Object|null>} Schema object or null
     */
    async findSchemaByNameAndVersion(name, version) {
        try {
            const response = await fetch(`${this.cloudAgentUrl}/schema-registry/schemas`, {
                method: 'GET',
                headers: {
                    'apikey': this.apiKey
                }
            });

            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            const schemas = data.contents || [];
            return schemas.find(s => s.name === name && s.version === version) || null;
        } catch (error) {
            console.error('[SchemaManager] Error finding schema:', error);
            return null;
        }
    }

    /**
     * Get schema by GUID
     * @param {string} schemaGuid - Schema GUID from Cloud Agent
     * @returns {Promise<Object>} Schema object
     */
    async getSchema(schemaGuid) {
        try {
            const response = await fetch(`${this.cloudAgentUrl}/schema-registry/schemas/${schemaGuid}`, {
                method: 'GET',
                headers: {
                    'apikey': this.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to fetch schema: ${response.status} - ${errorText}`);
            }

            const schema = await response.json();
            console.log(`[SchemaManager] Fetched schema: ${schema.name} v${schema.version}`);
            return schema;
        } catch (error) {
            console.error('[SchemaManager] Schema fetch error:', error);
            throw error;
        }
    }

    /**
     * List all registered schemas
     * @param {Object} options - Query options
     * @returns {Promise<Array>} Array of schema objects
     */
    async listSchemas(options = {}) {
        try {
            const params = new URLSearchParams();
            if (options.author) params.append('author', options.author);
            if (options.name) params.append('name', options.name);
            if (options.version) params.append('version', options.version);
            if (options.tags) {
                options.tags.forEach(tag => params.append('tags', tag));
            }

            const url = params.toString()
                ? `${this.cloudAgentUrl}/schema-registry/schemas?${params.toString()}`
                : `${this.cloudAgentUrl}/schema-registry/schemas`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': this.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to list schemas: ${response.status} - ${errorText}`);
            }

            const result = await response.json();
            return result.contents || [];
        } catch (error) {
            console.error('[SchemaManager] Schema list error:', error);
            throw error;
        }
    }

    // Keep existing static methods for backward compatibility

    /**
     * STATIC METHOD - Keep for backward compatibility
    /**
     * Register ServiceConfiguration schema in Multitenancy Cloud Agent
     * @param {string} cloudAgentUrl - Multitenancy Cloud Agent URL
     * @param {string} apiKey - Company API key for authentication
     * @param {string} authorDID - Company's PRISM DID (schema author)
     * @returns {Promise<Object>} Schema registration response with guid and self URL
     */
    static async registerServiceConfigSchema(cloudAgentUrl, apiKey, authorDID) {
        try {
            // Check if schema already exists
            const existingSchema = await this.getServiceConfigSchema(cloudAgentUrl, apiKey);
            if (existingSchema) {
                console.log('[SchemaManager] ServiceConfiguration schema already registered:', existingSchema.guid);
                return existingSchema;
            }

            // Define minimal ServiceConfiguration schema structure
            // 4 fields: URL, Name, API Key, Wallet ID
            // All other information (DID, mediator, services, etc.) should be queried dynamically
            const schemaDefinition = {
                name: 'ServiceConfiguration',
                version: '3.0.0', // ⚠️ BREAKING CHANGE: Added enterpriseAgentWalletId field
                description: 'Configuration credential for Enterprise Cloud Agent access (URL, Name, API Key, Wallet ID)',
                type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
                author: authorDID,
                authored: new Date().toISOString(),
                tags: ['service-config', 'enterprise', 'configuration', 'minimal', 'v3'],
                schema: {
                    '$schema': 'https://json-schema.org/draft/2020-12/schema',
                    '$id': 'https://identuslabel.cz/schemas/ServiceConfiguration/3.0.0',
                    'type': 'object',
                    'properties': {
                        'enterpriseAgentUrl': {
                            'type': 'string'
                        },
                        'enterpriseAgentName': {
                            'type': 'string'
                        },
                        'enterpriseAgentApiKey': {
                            'type': 'string'
                        },
                        'enterpriseAgentWalletId': {
                            'type': 'string'
                        }
                    },
                    'required': ['enterpriseAgentUrl', 'enterpriseAgentName', 'enterpriseAgentApiKey', 'enterpriseAgentWalletId'],
                    'additionalProperties': false
                }
            };

            console.log('[SchemaManager] Registering ServiceConfiguration schema...');

            const response = await fetch(`${cloudAgentUrl}/schema-registry/schemas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': apiKey
                },
                body: JSON.stringify(schemaDefinition)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Schema registration failed (${response.status}): ${errorText}`);
            }

            const schemaData = await response.json();
            console.log('[SchemaManager] ✅ Schema registered successfully:', schemaData.guid);
            console.log('[SchemaManager] Schema URL:', `${cloudAgentUrl}${schemaData.self}`);

            return schemaData;

        } catch (error) {
            console.error('[SchemaManager] Error registering schema:', error);
            throw new Error(`Failed to register ServiceConfiguration schema: ${error.message}`);
        }
    }

    /**
     * Get ServiceConfiguration schema from Multitenancy Cloud Agent
     * @param {string} cloudAgentUrl - Multitenancy Cloud Agent URL
     * @param {string} apiKey - Company API key for authentication
     * @returns {Promise<Object|null>} Schema object or null if not found
     */
    static async getServiceConfigSchema(cloudAgentUrl, apiKey) {
        try {
            const response = await fetch(`${cloudAgentUrl}/schema-registry/schemas`, {
                method: 'GET',
                headers: {
                    'apikey': apiKey
                }
            });

            if (!response.ok) {
                console.error('[SchemaManager] Failed to fetch schemas:', response.status);
                return null;
            }

            const data = await response.json();
            const schemas = data.contents || [];

            // Find ServiceConfiguration schema by name (version 3.0.0 - with walletId)
            const serviceConfigSchema = schemas.find(schema =>
                schema.name === 'ServiceConfiguration' && schema.version === '3.0.0'
            );

            if (serviceConfigSchema) {
                console.log('[SchemaManager] Found existing ServiceConfiguration schema:', serviceConfigSchema.guid);
                return serviceConfigSchema;
            }

            return null;

        } catch (error) {
            console.error('[SchemaManager] Error fetching schemas:', error);
            return null;
        }
    }

    /**
     * Ensure ServiceConfiguration schema is registered (idempotent)
     * Checks if schema exists, registers if not
     * @param {string} cloudAgentUrl - Multitenancy Cloud Agent URL
     * @param {string} apiKey - Company API key for authentication
     * @param {string} authorDID - Company's PRISM DID
     * @returns {Promise<string>} Schema ID for credential issuance
     */
    static async ensureServiceConfigSchema(cloudAgentUrl, apiKey, authorDID) {
        try {
            // Check if schema already registered
            let schema = await this.getServiceConfigSchema(cloudAgentUrl, apiKey);

            // Register if not found
            if (!schema) {
                schema = await this.registerServiceConfigSchema(cloudAgentUrl, apiKey, authorDID);
            }

            // Return schema ID in format required by credential offers
            const schemaId = `${cloudAgentUrl}${schema.self}`;
            console.log('[SchemaManager] Schema ready for issuance:', schemaId);

            return schemaId;

        } catch (error) {
            console.error('[SchemaManager] Error ensuring schema:', error);
            throw error;
        }
    }
}

module.exports = SchemaManager;
