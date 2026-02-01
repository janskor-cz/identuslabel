#!/usr/bin/env node

/**
 * Test CISTraining VC Issuance to Alice's Employee Wallet
 *
 * Issues a CIS Training Certificate to Alice's employee wallet via the Cloud Agent
 */

const { Pool } = require('pg');

const MULTITENANCY_CLOUD_AGENT_URL = 'http://91.99.4.54:8200';
const TECHCORP_API_KEY = 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const TECHCORP_DID = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';

console.log('========================================================================');
console.log('🎓 CISTraining VC Issuance Test');
console.log('========================================================================\n');

// Helper function for Cloud Agent API calls
async function cloudAgentRequest(apiKey, path, options = {}) {
  const url = `${MULTITENANCY_CLOUD_AGENT_URL}${path}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
        ...(options.headers || {})
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`Cloud Agent Error (${response.status}):`, data);
      return { success: false, error: data };
    }

    return { success: true, data };
  } catch (error) {
    console.error('Cloud Agent Request Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  // Connect to database
  const dbPool = new Pool({
    host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
    port: process.env.ENTERPRISE_DB_PORT || 5434,
    database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
    user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
    password: process.env.ENTERPRISE_DB_PASSWORD,
  });

  try {
    console.log('📋 Step 1: Fetching Alice\'s employee wallet details...');

    const query = `
      SELECT
        id,
        email,
        full_name,
        department,
        employee_id,
        wallet_id,
        prism_did,
        prism_did_short,
        techcorp_connection_id,
        techcorp_connection_state,
        cis_training_vc_issued,
        cis_training_vc_record_id
      FROM employee_portal_accounts
      WHERE email = $1
    `;

    const result = await dbPool.query(query, ['alice.private@techcorp.test']);

    if (result.rows.length === 0) {
      console.error('❌ Alice\'s employee wallet not found');
      process.exit(1);
    }

    const employee = result.rows[0];

    console.log('✅ Employee wallet found:');
    console.log(`   Email: ${employee.email}`);
    console.log(`   Name: ${employee.full_name}`);
    console.log(`   Department: ${employee.department}`);
    console.log(`   Employee ID: ${employee.employee_id}`);
    console.log(`   PRISM DID: ${employee.prism_did}`);
    console.log(`   Connection ID: ${employee.techcorp_connection_id}`);
    console.log(`   Connection State: ${employee.techcorp_connection_state}`);
    console.log(`   CIS Training VC Issued: ${employee.cis_training_vc_issued}\n`);

    // Check if already issued
    if (employee.cis_training_vc_issued) {
      console.log('⚠️  CIS Training VC already issued');
      console.log(`   Record ID: ${employee.cis_training_vc_record_id}\n`);

      // Still proceed to verify it
      console.log('   Proceeding to verify existing credential...\n');
    }

    // Verify connection is established
    if (!employee.techcorp_connection_id) {
      console.error('❌ No TechCorp connection found');
      process.exit(1);
    }

    if (employee.techcorp_connection_state !== 'ConnectionResponseSent' &&
        employee.techcorp_connection_state !== 'ConnectionResponseReceived') {
      console.error(`❌ Connection not in established state (current: ${employee.techcorp_connection_state})`);
      process.exit(1);
    }

    console.log('📋 Step 2: Getting CISTraining schema ID...');

    // Load schema cache to get the CIS Training schema GUID
    const fs = require('fs');
    const path = require('path');
    const cacheFile = path.join(__dirname, 'lib', '.schema-cache.json');

    if (!fs.existsSync(cacheFile)) {
      console.error('❌ Schema cache not found. Run schema initialization first.');
      process.exit(1);
    }

    const schemaCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

    if (!schemaCache.cisTrainingSchemaGuid) {
      console.error('❌ CISTraining schema not registered');
      process.exit(1);
    }

    const schemaGuid = schemaCache.cisTrainingSchemaGuid;
    console.log(`✅ Schema GUID: ${schemaGuid}\n`);

    console.log('📋 Step 3: Generating CISTraining certificate details...');

    const completionDate = new Date();
    const expiryDate = new Date(completionDate);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Valid for 1 year

    const certificateNumber = `CIS-${Date.now()}-${employee.employee_id}`;
    const trainingYear = completionDate.getFullYear().toString();

    const claims = {
      prismDid: employee.prism_did,
      employeeId: employee.employee_id,
      trainingYear,
      completionDate: completionDate.toISOString(),
      certificateNumber,
      expiryDate: expiryDate.toISOString()
    };

    console.log('   Certificate Details:');
    console.log(`   - Certificate Number: ${certificateNumber}`);
    console.log(`   - Training Year: ${trainingYear}`);
    console.log(`   - Completion Date: ${completionDate.toISOString()}`);
    console.log(`   - Expiry Date: ${expiryDate.toISOString()}\n`);

    console.log('📋 Step 4: Creating credential offer...');

    const credentialOffer = {
      issuingDID: TECHCORP_DID,
      connectionId: employee.techcorp_connection_id,
      schemaId: `${MULTITENANCY_CLOUD_AGENT_URL}/schema-registry/schemas/${schemaGuid}`,
      credentialFormat: 'JWT',
      claims,
      automaticIssuance: true,
      awaitConfirmation: false
    };

    console.log('   Credential Offer:', JSON.stringify(credentialOffer, null, 2));
    console.log();

    const offerResult = await cloudAgentRequest(
      TECHCORP_API_KEY,
      '/issue-credentials/credential-offers',
      {
        method: 'POST',
        body: JSON.stringify(credentialOffer)
      }
    );

    if (!offerResult.success) {
      console.error('❌ Failed to create credential offer');
      console.error('   Error:', offerResult.error);
      process.exit(1);
    }

    const recordId = offerResult.data.recordId;
    console.log(`✅ Credential offer created!`);
    console.log(`   Record ID: ${recordId}`);
    console.log(`   State: ${offerResult.data.protocolState}\n`);

    console.log('📋 Step 5: Updating database record...');

    const updateQuery = `
      UPDATE employee_portal_accounts
      SET
        cis_training_vc_issued = true,
        cis_training_vc_record_id = $1,
        cis_training_completion_date = $2,
        cis_training_vc_issued_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `;

    await dbPool.query(updateQuery, [
      recordId,
      completionDate.toISOString().split('T')[0], // Date only
      employee.id
    ]);

    console.log('✅ Database record updated\n');

    console.log('📋 Step 6: Verifying credential state...');

    // Wait a moment for the credential to be sent
    await new Promise(resolve => setTimeout(resolve, 2000));

    const verifyResult = await cloudAgentRequest(
      TECHCORP_API_KEY,
      `/issue-credentials/records/${recordId}`,
      { method: 'GET' }
    );

    if (verifyResult.success) {
      console.log(`✅ Credential verification:`);
      console.log(`   State: ${verifyResult.data.protocolState}`);
      console.log(`   Record ID: ${verifyResult.data.recordId}`);
      console.log(`   Issuing DID: ${verifyResult.data.issuingDID}\n`);
    } else {
      console.log('⚠️  Could not verify credential state (this is OK if it was sent)\n');
    }

    console.log('========================================================================');
    console.log('✅ CISTraining VC issuance completed!');
    console.log('========================================================================');
    console.log('');
    console.log('Next Steps:');
    console.log('1. Alice should see the credential offer in her edge wallet');
    console.log('2. Alice needs to accept the credential in her wallet');
    console.log('3. The credential will be stored in Alice\'s wallet for Enterprise mode');
    console.log('');

  } catch (error) {
    console.error('\n❌ Test failed:');
    console.error(error);
    process.exit(1);
  } finally {
    await dbPool.end();
  }
}

main().catch(console.error);
