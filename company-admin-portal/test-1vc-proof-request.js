const fetch = require('node-fetch');
const fs = require('fs');

const ENTERPRISE_API_KEY = '21f5830189796cf8657f90f28a6cd407d3e91eab50d9a985723400c06ad11fde';
const ENTERPRISE_URL = 'https://identuslabel.cz/enterprise';
const COMPANY_ADMIN_URL = 'http://localhost:3010';

async function test1VCProofRequest() {
  console.log('\n========================================');
  console.log('TEST 1: Proof Request with 1 VC (EmployeeRole only)');
  console.log('========================================\n');

  // Step 1: Get Alice's email and PRISM DID from database
  const { Client } = require('pg');
  const client = new Client({
    host: 'localhost',
    port: 5434,
    user: 'identus_enterprise',
    password: '71e430bef6ab371e52b1ef4735eeff82010d11d50710185438343d39825e16bc',
    database: 'enterprise_portal'
  });

  await client.connect();

  const employeeQuery = await client.query(
    "SELECT email, prism_did FROM employees WHERE email LIKE 'alice.private%' ORDER BY created_at DESC LIMIT 1"
  );

  if (employeeQuery.rows.length === 0) {
    console.log('❌ No Alice employee found');
    await client.end();
    return;
  }

  const { email, prism_did } = employeeQuery.rows[0];
  console.log(`✓ Found employee: ${email}`);
  console.log(`✓ PRISM DID: ${prism_did}\n`);

  await client.end();

  // Step 2: Create proof request via employee login endpoint
  console.log('Creating proof request...');
  const loginResponse = await fetch(`${COMPANY_ADMIN_URL}/api/employee/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: email,
      prismDid: prism_did
    })
  });

  const loginData = await loginResponse.json();
  console.log(`✓ Login response status: ${loginResponse.status}`);
  console.log(`✓ Proof request created: ${loginData.presentationId}\n`);

  if (!loginData.success || !loginData.presentationId) {
    console.log('❌ Failed to create proof request');
    console.log(JSON.stringify(loginData, null, 2));
    return;
  }

  // Step 3: Query Enterprise Cloud Agent for the actual proof request structure
  console.log('Querying Enterprise Cloud Agent for proof request details...');
  const proofResponse = await fetch(`${ENTERPRISE_URL}/present-proof/presentations/${loginData.presentationId}`, {
    headers: {
      'apikey': ENTERPRISE_API_KEY
    }
  });

  const proofData = await proofResponse.json();
  console.log(`✓ Cloud Agent response status: ${proofResponse.status}\n`);

  // Save full response
  fs.writeFileSync('/tmp/1vc-proof-request-full.json', JSON.stringify(proofData, null, 2));
  console.log('✓ Full response saved to: /tmp/1vc-proof-request-full.json\n');

  // Extract and display critical fields
  console.log('========================================');
  console.log('CRITICAL FIELDS ANALYSIS');
  console.log('========================================\n');

  const requestData = proofData.requestData && proofData.requestData[0] ? JSON.parse(proofData.requestData[0]) : {};

  console.log('1. proofs[] array from Cloud Agent:');
  console.log(JSON.stringify(proofData.proofs || [], null, 2));
  console.log('');

  console.log('2. presentation_definition from Cloud Agent:');
  console.log(JSON.stringify(requestData.presentation_definition || {}, null, 2));
  console.log('');

  console.log('3. input_descriptors from Cloud Agent:');
  const inputDescriptors = requestData.presentation_definition?.input_descriptors || [];
  console.log(JSON.stringify(inputDescriptors, null, 2));
  console.log('');

  // Summary
  console.log('========================================');
  console.log('SUMMARY');
  console.log('========================================\n');
  console.log(`Presentation ID: ${loginData.presentationId}`);
  console.log(`Number of VCs requested in code: 1 (EmployeeRole only)`);
  console.log(`Number of input_descriptors created by Cloud Agent: ${inputDescriptors.length}`);
  console.log(`input_descriptors content: ${inputDescriptors.length === 0 ? '❌ EMPTY' : '✓ POPULATED'}`);

  if (inputDescriptors.length > 0) {
    console.log('\nSchema constraints in input_descriptors:');
    inputDescriptors.forEach((desc, idx) => {
      const schemaPath = desc.constraints?.fields?.find(f => f.path?.[0] === '$.credentialSchema.id');
      if (schemaPath) {
        console.log(`  ${idx + 1}. ${desc.name || desc.id}: ${schemaPath.filter?.const || 'NO SCHEMA FILTER'}`);
      } else {
        console.log(`  ${idx + 1}. ${desc.name || desc.id}: ❌ NO SCHEMA CONSTRAINT`);
      }
    });
  }

  console.log('\n========================================\n');
}

test1VCProofRequest().catch(console.error);
