#!/usr/bin/env node

/**
 * Simple CIS Training Schema Registration
 *
 * Registers the CISTrainingCertificate schema on the Main Cloud Agent
 */

const SchemaManager = require('./lib/SchemaManager');

// Main Cloud Agent configuration
const CLOUD_AGENT_URL = 'https://identuslabel.cz/cloud-agent';
const API_KEY = 'default';

// Use the published DID on Main Cloud Agent
const ISSUER_DID = 'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c';

async function registerTrainingSchema() {
    try {
        console.log('\n=== CIS Training Schema Registration ===');
        console.log(`Cloud Agent: ${CLOUD_AGENT_URL}`);
        console.log(`Issuer DID: ${ISSUER_DID}`);
        console.log('');

        // Initialize SchemaManager
        const schemaManager = new SchemaManager(CLOUD_AGENT_URL, API_KEY);

        // Register CISTrainingCertificate schema
        console.log('Registering CISTrainingCertificate schema...');
        const cisTrainingGuid = await schemaManager.registerCISTrainingSchema(ISSUER_DID);
        console.log(`✅ CISTraining Schema GUID: ${cisTrainingGuid}`);

        // Verify registration
        console.log('\nVerifying schema registration...');
        const schema = await schemaManager.getSchema(cisTrainingGuid);
        console.log(`✅ Schema retrieved: ${schema.name} v${schema.version}`);
        console.log(`   Author: ${schema.author}`);
        console.log(`   Type: ${schema.type}`);

        console.log('\n=== Registration Complete ===');
        console.log(`\nSchema GUID to add to .env:`);
        console.log(`CIS_TRAINING_SCHEMA_GUID=${cisTrainingGuid}`);
        console.log('\nThe schema cache has been automatically updated.');
        console.log('The backend server can now issue CIS Training certificates!\n');

    } catch (error) {
        console.error('\n❌ Error registering schema:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        process.exit(1);
    }
}

// Run registration
registerTrainingSchema();
