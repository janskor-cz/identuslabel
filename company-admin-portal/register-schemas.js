#!/usr/bin/env node

/**
 * Schema Registration Script for Company Admin Portal
 *
 * Registers EmployeeRole and CISTrainingCertificate schemas in the Cloud Agent Schema Registry.
 * Uses TechCorp's credentials from the multitenancy Cloud Agent.
 *
 * Usage:
 *   node register-schemas.js [--cloud-agent <url>]
 *
 * Options:
 *   --cloud-agent <url>  Override Cloud Agent URL (default: Main Cloud Agent)
 *   --use-multitenancy   Use Multitenancy Cloud Agent instead of Main
 *   --clear-cache        Clear cached schema GUIDs before registration
 *
 * Output:
 *   Prints schema GUIDs that can be added to .env file
 */

const SchemaManager = require('./lib/SchemaManager');
const { COMPANIES, MULTITENANCY_CLOUD_AGENT_URL } = require('./lib/companies');

// Parse command line arguments
const args = process.argv.slice(2);
const useMultitenancy = args.includes('--use-multitenancy');
const clearCache = args.includes('--clear-cache');
const cloudAgentIndex = args.indexOf('--cloud-agent');
const customCloudAgentUrl = cloudAgentIndex !== -1 ? args[cloudAgentIndex + 1] : null;

// Default to Main Cloud Agent (port 8000) for better isolation
const MAIN_CLOUD_AGENT_URL = 'https://identuslabel.cz/cloud-agent';

// Choose Cloud Agent URL
let CLOUD_AGENT_URL;
if (customCloudAgentUrl) {
    CLOUD_AGENT_URL = customCloudAgentUrl;
    console.log(`Using custom Cloud Agent URL: ${CLOUD_AGENT_URL}`);
} else if (useMultitenancy) {
    CLOUD_AGENT_URL = MULTITENANCY_CLOUD_AGENT_URL;
    console.log(`Using Multitenancy Cloud Agent: ${CLOUD_AGENT_URL}`);
} else {
    CLOUD_AGENT_URL = MAIN_CLOUD_AGENT_URL;
    console.log(`Using Main Cloud Agent: ${CLOUD_AGENT_URL}`);
}

// Get TechCorp configuration
const techCorp = COMPANIES.techcorp;
if (!techCorp) {
    console.error('Error: TechCorp configuration not found');
    process.exit(1);
}

// For Main Cloud Agent, we need a different API key
// You should configure this in environment variables
const API_KEY = useMultitenancy ? techCorp.apiKey : (process.env.MAIN_CLOUD_AGENT_API_KEY || 'default_api_key');

async function registerSchemas() {
    try {
        console.log('\n=== Schema Registration Script ===');
        console.log(`Cloud Agent: ${CLOUD_AGENT_URL}`);
        console.log(`Author DID: ${techCorp.did}`);
        console.log(`Company: ${techCorp.displayName}`);
        console.log('');

        // Initialize SchemaManager
        const schemaManager = new SchemaManager(CLOUD_AGENT_URL, API_KEY);

        // Clear cache if requested
        if (clearCache) {
            console.log('Clearing schema cache...');
            await schemaManager.saveCache({});
            console.log('Cache cleared.\n');
        }

        // Register EmployeeRole schema
        console.log('1. Registering EmployeeRole schema...');
        const employeeRoleGuid = await schemaManager.registerEmployeeRoleSchema(techCorp.did);
        console.log(`   EmployeeRole Schema GUID: ${employeeRoleGuid}`);

        // Register CISTrainingCertificate schema
        console.log('\n2. Registering CISTrainingCertificate schema...');
        const cisTrainingGuid = await schemaManager.registerCISTrainingSchema(techCorp.did);
        console.log(`   CISTraining Schema GUID: ${cisTrainingGuid}`);

        // Register DocumentMetadata schema
        console.log('\n3. Registering DocumentMetadata schema...');
        const documentMetadataGuid = await schemaManager.registerDocumentMetadataSchema(techCorp.did);
        console.log(`   DocumentMetadata Schema GUID: ${documentMetadataGuid}`);

        // List all schemas to verify
        console.log('\n4. Verifying registered schemas...');
        const schemas = await schemaManager.listSchemas({ author: techCorp.did });
        console.log(`   Found ${schemas.length} schemas authored by TechCorp:`);
        schemas.forEach(schema => {
            console.log(`   - ${schema.name} v${schema.version} (${schema.guid})`);
        });

        // Test fetching individual schemas
        console.log('\n5. Testing schema retrieval...');
        const employeeRoleSchema = await schemaManager.getSchema(employeeRoleGuid);
        console.log(`   ✅ EmployeeRole schema retrieved: ${employeeRoleSchema.name}`);

        const cisTrainingSchema = await schemaManager.getSchema(cisTrainingGuid);
        console.log(`   ✅ CISTraining schema retrieved: ${cisTrainingSchema.name}`);

        const documentMetadataSchema = await schemaManager.getSchema(documentMetadataGuid);
        console.log(`   ✅ DocumentMetadata schema retrieved: ${documentMetadataSchema.name}`);

        // Print environment variables
        console.log('\n=== Environment Variables ===');
        console.log('Add these to your .env file:\n');
        console.log(`EMPLOYEE_ROLE_SCHEMA_GUID=${employeeRoleGuid}`);
        console.log(`CIS_TRAINING_SCHEMA_GUID=${cisTrainingGuid}`);
        console.log(`DOCUMENT_METADATA_SCHEMA_GUID=${documentMetadataGuid}`);
        console.log(`CLOUD_AGENT_URL=${CLOUD_AGENT_URL}`);

        if (!useMultitenancy) {
            console.log(`# Note: Using Main Cloud Agent requires proper API key configuration`);
        }

        console.log('\n✅ Schema registration completed successfully!');

        // Show cached GUIDs
        const cache = await schemaManager.loadCache();
        console.log('\n=== Cached Schema GUIDs ===');
        console.log(JSON.stringify(cache, null, 2));

    } catch (error) {
        console.error('\n❌ Schema registration failed:', error.message);
        console.error('Error details:', error);
        process.exit(1);
    }
}

// Execute registration
registerSchemas().then(() => {
    console.log('\n=== Script completed ===');
    process.exit(0);
}).catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
});