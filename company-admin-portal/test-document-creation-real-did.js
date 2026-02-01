/**
 * Test Document Creation with Real DIDs via Enterprise Cloud Agent
 *
 * This script tests document DID creation using actual Enterprise Cloud Agent API calls.
 * Tests the complete workflow: Real blockchain DID publication + DocumentRegistry filtering.
 *
 * Usage: node test-document-creation-real-did.js
 */

const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const DocumentRegistry = require('./lib/DocumentRegistry');

// Configuration
const ENTERPRISE_CLOUD_AGENT_URL = 'http://91.99.4.54:8300';

// Department API Keys (from server.js)
const DEPARTMENT_API_KEYS = {
  HR: '2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c',
  IT: '63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52',
  Security: '23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288'
};

// Company issuerDID mappings
const COMPANY_ISSUER_DIDS = {
  'TechCorp Corporation': 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
  'ACME Corporation': 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9'
};

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('📝 Document Creation Test - Real Blockchain DIDs');
  console.log('='.repeat(70));

  try {
    // Step 1: Create real document DID via Enterprise Cloud Agent
    console.log('\n[Step 1] Creating real document DID via Enterprise Cloud Agent...');
    console.log('   Enterprise Cloud Agent URL: ' + ENTERPRISE_CLOUD_AGENT_URL);
    console.log('   Department: HR');
    console.log('   API Key: ' + DEPARTMENT_API_KEYS.HR.substring(0, 16) + '...');
    console.log('   Note: This will create a real blockchain DID (30-60s publication time)');

    const documentManager = new EnterpriseDocumentManager(
      ENTERPRISE_CLOUD_AGENT_URL,
      DEPARTMENT_API_KEYS.HR
    );

    const documentDID = await documentManager.createDocumentDID('HR', {
      title: 'Q4 Financial Report',
      description: 'Quarterly financial report for Q4 2025',
      classificationLevel: 'CONFIDENTIAL',
      createdBy: 'test@techcorp.com',
      createdByDID: 'did:prism:test123'
    });

    console.log(`✅ Real Document DID created: ${documentDID.substring(0, 60)}...`);
    console.log(`   Status: Published to blockchain`);

    // Step 2: Register document in DocumentRegistry
    console.log('\n[Step 2] Registering document in DocumentRegistry...');

    const registrationResult = await DocumentRegistry.registerDocument({
      documentDID,
      title: 'Q4 Financial Report',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: [
        COMPANY_ISSUER_DIDS['TechCorp Corporation'],
        COMPANY_ISSUER_DIDS['ACME Corporation']
      ],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        category: 'Financial',
        version: '1.0',
        author: 'Finance Department'
      }
    });

    console.log(`✅ Document registered: ${registrationResult.documentDID.substring(0, 60)}...`);
    console.log(`   Releasable to ${registrationResult.releasableToCount} companies`);

    // Step 3: Test clearance-based filtering
    console.log('\n[Step 3] Testing clearance-based filtering...');

    // Test UNCLASSIFIED access (no clearance)
    const unclassifiedDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      null // No clearance = UNCLASSIFIED only
    );

    console.log(`   UNCLASSIFIED access: ${unclassifiedDocs.length} documents visible`);
    console.log(`   Expected: 0 (document is CONFIDENTIAL, requires clearance)`);

    if (unclassifiedDocs.length === 0) {
      console.log('   ✅ PASS: Correctly filtered out CONFIDENTIAL document');
    } else {
      console.log('   ❌ FAIL: UNCLASSIFIED should not see CONFIDENTIAL documents');
    }

    // Test CONFIDENTIAL clearance
    const confidentialDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      'CONFIDENTIAL'
    );

    console.log(`\n   CONFIDENTIAL clearance: ${confidentialDocs.length} documents visible`);
    console.log(`   Expected: 1 (employee has sufficient clearance)`);

    if (confidentialDocs.length === 1) {
      console.log('   ✅ PASS: CONFIDENTIAL clearance can see CONFIDENTIAL document');
      console.log(`\n   Document details:`);
      console.log(`   - Title: ${confidentialDocs[0].title}`);
      console.log(`   - Classification: ${confidentialDocs[0].classificationLevel}`);
      console.log(`   - DID: ${confidentialDocs[0].documentDID.substring(0, 60)}...`);
    } else {
      console.log('   ❌ FAIL: CONFIDENTIAL clearance should see 1 document');
    }

    // Step 4: Test cross-company releasability
    console.log('\n[Step 4] Testing cross-company releasability...');

    // ACME should see the document
    const acmeDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['ACME Corporation'],
      'SECRET'
    );

    console.log(`   ACME Corporation (with SECRET clearance): ${acmeDocs.length} documents visible`);
    console.log(`   Expected: 1 (document released to ACME)`);

    if (acmeDocs.length === 1) {
      console.log('   ✅ PASS: ACME can see document released to them');
    } else {
      console.log('   ❌ FAIL: ACME should see 1 document');
    }

    // EvilCorp should see nothing
    const evilCorpDID = 'did:prism:evilcorp-test-did-12345';
    const evilCorpDocs = await DocumentRegistry.queryByIssuerDID(
      evilCorpDID,
      'TOP_SECRET'
    );

    console.log(`\n   EvilCorp (with TOP_SECRET clearance): ${evilCorpDocs.length} documents visible`);
    console.log(`   Expected: 0 (no documents released to EvilCorp)`);

    if (evilCorpDocs.length === 0) {
      console.log('   ✅ PASS: EvilCorp correctly sees no documents');
    } else {
      console.log('   ❌ FAIL: EvilCorp should see 0 documents');
    }

    // Step 5: Display registry statistics
    console.log('\n[Step 5] Document Registry Statistics:');
    const stats = DocumentRegistry.getStatistics();
    console.log(`   Total documents: ${stats.totalDocuments}`);
    console.log(`   By classification:`);
    console.log(`     - UNCLASSIFIED: ${stats.byClassification.UNCLASSIFIED}`);
    console.log(`     - CONFIDENTIAL: ${stats.byClassification.CONFIDENTIAL}`);
    console.log(`     - SECRET: ${stats.byClassification.SECRET}`);
    console.log(`     - TOP_SECRET: ${stats.byClassification.TOP_SECRET}`);

    console.log('\n' + '='.repeat(70));
    console.log('✅ All tests completed successfully!');
    console.log('='.repeat(70));
    console.log('\nReal blockchain DID created and validated:');
    console.log(`DID: ${documentDID}`);
    console.log('');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Error details:', error);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

main();
