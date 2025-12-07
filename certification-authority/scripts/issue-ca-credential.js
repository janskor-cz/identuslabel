#!/usr/bin/env node

/**
 * Two-Agent CA Authority Identity Credential Script
 *
 * This script uses a two-agent connectionless credential issuance flow:
 * - Issuer: Top-level issuer Cloud Agent (port 8100)
 * - Holder: Main CA Cloud Agent (port 8000)
 *
 * This architecture avoids self-connection issues by using separate Cloud Agent instances.
 *
 * Usage: node issue-ca-credential.js
 */

// Top-level issuer agent constants
const TOP_LEVEL_ISSUER_URL = 'https://identuslabel.cz/top-level-issuer';
const TOP_LEVEL_ISSUER_DID = 'did:prism:a7244aad36ab32de81da6f275d515508de5b29dbc1f753a5bda62e4455a6e4cd';  // Fixed: single assertion key only
const TOP_LEVEL_SCHEMA_REGISTRY = 'https://identuslabel.cz/top-level-issuer/schema-registry';

// CA holder agent constants
const CA_HOLDER_URL = 'https://identuslabel.cz/cloud-agent';

// Helper function for API calls to top-level issuer
async function callTopLevelIssuer(endpoint, method = 'GET', body = null) {
  const url = endpoint.startsWith('http') ? endpoint : `${TOP_LEVEL_ISSUER_URL}${endpoint}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': 'default'  // Auto-provisioned API key
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  console.log(`\n📡 [TOP-LEVEL ISSUER] ${method} ${endpoint}`);
  if (body) {
    console.log(`📤 Payload:`, JSON.stringify(body, null, 2));
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    console.error(`❌ Error:`, data);
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }

  console.log(`✅ Response:`, JSON.stringify(data, null, 2));
  return data;
}

// Helper function for API calls to CA holder agent
async function callCAHolder(endpoint, method = 'GET', body = null) {
  const url = endpoint.startsWith('http') ? endpoint : `${CA_HOLDER_URL}${endpoint}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  console.log(`\n📡 [CA HOLDER] ${method} ${endpoint}`);
  if (body) {
    console.log(`📤 Payload:`, JSON.stringify(body, null, 2));
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    console.error(`❌ Error:`, data);
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }

  console.log(`✅ Response:`, JSON.stringify(data, null, 2));
  return data;
}

// Helper to wait
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  try {
    console.log('🏛️  CA Authority Identity - Two-Agent Credential Generator');
    console.log('================================================================\n');

    // Step 1: Verify top-level issuer DID
    console.log('📋 Step 1: Verifying top-level issuer DID...');
    console.log(`✅ Top-Level Issuer DID (Pre-configured): ${TOP_LEVEL_ISSUER_DID}`);
    console.log(`✅ Top-Level Issuer URL: ${TOP_LEVEL_ISSUER_URL}\n`);

    // Step 2: Create a holder DID for CA on CA Cloud Agent (to receive the credential)
    console.log('📋 Step 2: Creating holder DID on CA Cloud Agent...');
    const createDIDPayload = {
      documentTemplate: {
        publicKeys: [
          {
            id: 'auth-key',
            purpose: 'authentication'
          },
          {
            id: 'assertion-key',
            purpose: 'assertionMethod'
          }
        ],
        services: []
      }
    };

    const createDIDResponse = await callCAHolder(
      '/did-registrar/dids',
      'POST',
      createDIDPayload
    );

    const holderDID = createDIDResponse.longFormDid;
    console.log(`✅ CA Holder DID (unpublished): ${holderDID}\n`);

    // Step 3: Find CertificationAuthorityIdentity schema on top-level issuer
    console.log('📋 Step 3: Finding CertificationAuthorityIdentity schema on top-level issuer...');
    const schemas = await callTopLevelIssuer(`${TOP_LEVEL_SCHEMA_REGISTRY}/schemas`, 'GET');
    const caSchema = schemas.contents.find(
      s => s.name === 'CertificationAuthorityIdentity' && s.version === '1.0.0'
    );

    if (!caSchema) {
      throw new Error('CertificationAuthorityIdentity schema not found on top-level issuer. Schema must be created on port 8100.');
    }

    const schemaUrl = `https://identuslabel.cz/top-level-issuer${caSchema.self}`;
    console.log(`✅ Schema ID: ${caSchema.guid}`);
    console.log(`✅ Schema URL: ${schemaUrl}\n`);

    // Step 4: Prepare credential claims
    console.log('📋 Step 4: Preparing credential claims...');
    const issuedDate = new Date().toISOString().split('T')[0];
    const credentialId = `ca-authority-${Date.now()}`;

    const claims = {
      credentialType: 'CertificationAuthorityIdentity',
      organizationName: 'Hyperledger Identus Certification Authority',
      organizationType: 'Root Certification Authority',
      jurisdiction: 'Czech Republic',
      registrationNumber: 'CA-CZ-2025-001',
      establishedDate: '2025-01-01',
      website: 'https://identuslabel.cz',
      authorityLevel: 'Root Certificate Authority',
      authorizationScope: 'Issue and verify Verifiable Credentials for identity verification, security clearance, and organizational attestation within the Hyperledger Identus ecosystem',
      accreditationDate: '2025-01-01',
      accreditingBody: 'Self-Accredited',
      cloudAgentEndpoint: 'https://identuslabel.cz/cloud-agent',
      didcommEndpoint: 'https://identuslabel.cz/didcomm',
      mediatorEndpoint: 'https://identuslabel.cz/mediator',
      supportedProtocols: ['DIDComm v2', 'W3C Verifiable Credentials', 'StatusList2021', 'X25519 Encryption'],
      issuedDate: issuedDate,
      credentialId: credentialId
    };

    console.log('✅ Claims prepared\n');

    // Step 5: Create credential offer invitation on top-level issuer
    console.log('📋 Step 5: Creating credential offer invitation on top-level issuer...');
    const offerPayload = {
      claims: claims,
      credentialFormat: 'JWT',
      issuingDID: TOP_LEVEL_ISSUER_DID,
      schemaId: schemaUrl,
      automaticIssuance: false
    };

    const offerResponse = await callTopLevelIssuer(
      '/issue-credentials/credential-offers/invitation',
      'POST',
      offerPayload
    );

    const issuerRecordId = offerResponse.recordId;
    const invitationUrl = offerResponse.invitation.invitationUrl;

    console.log(`✅ Issuer Record ID: ${issuerRecordId}`);
    console.log(`✅ Invitation URL generated\n`);

    // Step 6: Accept invitation on CA holder agent
    console.log('📋 Step 6: Accepting invitation on CA holder agent...');

    // Extract the _oob parameter value from the invitation URL
    // The URL format is: https://my.domain.com/path?_oob=<base64_encoded_invitation>
    const oobMatch = invitationUrl.match(/[?&]_oob=([^&]+)/);
    if (!oobMatch) {
      throw new Error('Invalid invitation URL: missing _oob parameter');
    }
    const oobInvitation = oobMatch[1];
    console.log(`✅ Extracted OOB invitation (length: ${oobInvitation.length} chars)\n`);

    const acceptInvitationPayload = {
      invitation: oobInvitation  // Use only the base64-encoded invitation, not full URL
    };

    const acceptInvitationResponse = await callCAHolder(
      '/issue-credentials/credential-offers/accept-invitation',
      'POST',
      acceptInvitationPayload
    );

    const holderRecordId = acceptInvitationResponse.recordId;
    console.log(`✅ Holder Record ID: ${holderRecordId}\n`);

    // Wait for state to settle
    console.log('⏳ Waiting 3 seconds for state to settle...');
    await wait(3000);

    // Step 7: Accept offer on CA holder agent
    console.log('📋 Step 7: Accepting offer on CA holder agent...');
    const acceptOfferPayload = {
      subjectId: holderDID  // Use holder DID as subject
    };

    await callCAHolder(
      `/issue-credentials/records/${holderRecordId}/accept-offer`,
      'POST',
      acceptOfferPayload
    );

    console.log('✅ Offer accepted\n');

    // Wait for request to reach issuer
    console.log('⏳ Waiting 3 seconds for request to reach issuer...');
    await wait(3000);

    // Step 8: Issue credential on top-level issuer
    console.log('📋 Step 8: Issuing credential on top-level issuer...');
    await callTopLevelIssuer(
      `/issue-credentials/records/${issuerRecordId}/issue-credential`,
      'POST'
    );

    console.log('✅ Credential issuance initiated\n');

    // Step 9: Poll for credential completion on top-level issuer
    console.log('📋 Step 9: Waiting for credential to be generated on top-level issuer...');
    let credential = null;
    let attempts = 0;
    const maxAttempts = 20;

    while (!credential && attempts < maxAttempts) {
      await wait(2000);
      attempts++;

      const record = await callTopLevelIssuer(`/issue-credentials/records/${issuerRecordId}`);

      console.log(`⏳ Attempt ${attempts}/${maxAttempts} - State: ${record.protocolState}`);

      if (record.credential) {
        credential = record.credential;
        console.log('✅ Credential generated!\n');
        break;
      }
    }

    if (!credential) {
      throw new Error('Credential generation timed out');
    }

    // Step 10: Save credential to file
    console.log('📋 Step 10: Saving credential to file...');
    const fs = require('fs');
    const path = require('path');

    const dataDir = path.join(__dirname, '..', 'data');
    const credentialPath = path.join(dataDir, 'ca-authority-credential.json');

    const credentialData = {
      recordId: issuerRecordId,
      credentialType: 'CertificationAuthorityIdentity',
      issuer: TOP_LEVEL_ISSUER_DID,
      subject: holderDID,
      holderDID: holderDID,
      issuerDID: TOP_LEVEL_ISSUER_DID,
      issuedDate: issuedDate,
      credentialId: credentialId,
      schemaId: caSchema.guid,
      credential: credential,
      claims: claims,
      createdAt: new Date().toISOString(),
      architecture: {
        issuerAgent: TOP_LEVEL_ISSUER_URL,
        holderAgent: CA_HOLDER_URL,
        flow: 'Two-Agent Connectionless'
      }
    };

    fs.writeFileSync(credentialPath, JSON.stringify(credentialData, null, 2));
    console.log(`✅ Credential saved to: ${credentialPath}\n`);

    // Summary
    console.log('================================================================');
    console.log('🎉 SUCCESS! CA Authority Identity credential issued (Two-Agent Flow)');
    console.log('================================================================');
    console.log(`Issuer DID (Top-Level): ${TOP_LEVEL_ISSUER_DID}`);
    console.log(`Issuer Agent URL: ${TOP_LEVEL_ISSUER_URL}`);
    console.log(`Holder DID (CA): ${holderDID}`);
    console.log(`Holder Agent URL: ${CA_HOLDER_URL}`);
    console.log(`Subject DID in credential: ${holderDID}`);
    console.log(`Credential ID: ${credentialId}`);
    console.log(`Issuer Record ID: ${issuerRecordId}`);
    console.log(`Holder Record ID: ${holderRecordId}`);
    console.log(`\nCredential file: ${credentialPath}`);
    console.log(`\nPublic endpoint: https://identuslabel.cz/ca/api/well-known/ca-authority`);
    console.log('================================================================\n');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
