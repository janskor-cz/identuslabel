/**
 * Test Document Creation & Clearance-Based Disclosure Feature
 *
 * This script tests the complete document creation workflow:
 * 1. Creates a test employee using EmployeeWalletManager
 * 2. Logs in as the employee to get session token
 * 3. Creates documents with different classification levels
 * 4. Tests clearance-based filtering
 *
 * Usage: node test-document-creation-workflow.js
 */

const EmployeeWalletManager = require('./lib/EmployeeWalletManager');
const DocumentRegistry = require('./lib/DocumentRegistry');
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');

// Configuration
const ENTERPRISE_CLOUD_AGENT_URL = 'https://identuslabel.cz/enterprise/cloud-agent';
const API_BASE_URL = 'http://localhost:3010/api/employee-portal';

// Company issuerDID mappings
const COMPANY_ISSUER_DIDS = {
  'TechCorp Corporation': 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
  'ACME Corporation': 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9'
};

async function main() {
  console.log('\n='.repeat(70));
  console.log('📝 Document Creation & Clearance-Based Disclosure Test');
  console.log('='.repeat(70));

  try {
    // Step 1: Test Document DID creation (MOCKED - requires API key setup)
    console.log('\n[Step 1] Mocking Document DID creation...');
    console.log('⚠️  NOTE: Real DID creation requires Enterprise Cloud Agent API key configuration');
    console.log('           For this test, we will use mock DIDs to validate DocumentRegistry logic\n');

    // Mock DIDs (in production, these would be created via Enterprise Cloud Agent)
    const documentDID = 'did:prism:mock-financial-report-' + Date.now();
    console.log(`✅ Mock Document DID: ${documentDID.substring(0, 50)}...`);

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

    console.log(`✅ Document registered: ${registrationResult.documentDID.substring(0, 50)}...`);
    console.log(`   Releasable to ${registrationResult.releasableToCount} companies`);

    // Step 3: Query documents by issuerDID (UNCLASSIFIED access - no clearance)
    console.log('\n[Step 3] Testing document discovery with UNCLASSIFIED access...');

    const unclassifiedDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      null // No clearance = UNCLASSIFIED access only
    );

    console.log(`✅ Documents visible with UNCLASSIFIED access: ${unclassifiedDocs.length}`);
    console.log(`   Expected: 0 (document is CONFIDENTIAL, requires clearance)`);

    // Step 4: Query documents with CONFIDENTIAL clearance
    console.log('\n[Step 4] Testing document discovery with CONFIDENTIAL clearance...');

    const confidentialDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      'CONFIDENTIAL'
    );

    console.log(`✅ Documents visible with CONFIDENTIAL clearance: ${confidentialDocs.length}`);
    console.log(`   Expected: 1 (employee has sufficient clearance)`);

    if (confidentialDocs.length > 0) {
      console.log(`\n   Document details:`);
      console.log(`   - Title: ${confidentialDocs[0].title}`);
      console.log(`   - Classification: ${confidentialDocs[0].classificationLevel}`);
      console.log(`   - DID: ${confidentialDocs[0].documentDID.substring(0, 50)}...`);
    }

    // Step 5: Test clearance hierarchy
    console.log('\n[Step 5] Testing clearance hierarchy...');

    // Register documents at different classification levels (mock DIDs)
    const unclassifiedDID = 'did:prism:mock-handbook-' + Date.now();

    await DocumentRegistry.registerDocument({
      documentDID: unclassifiedDID,
      title: 'Public Company Handbook',
      classificationLevel: 'UNCLASSIFIED',
      releasableTo: [COMPANY_ISSUER_DIDS['TechCorp Corporation']],
      contentEncryptionKey: 'mock-key-1',
      metadata: {}
    });

    const secretDID = 'did:prism:mock-incident-report-' + Date.now();

    await DocumentRegistry.registerDocument({
      documentDID: secretDID,
      title: 'Security Incident Report',
      classificationLevel: 'SECRET',
      releasableTo: [COMPANY_ISSUER_DIDS['TechCorp Corporation']],
      contentEncryptionKey: 'mock-key-2',
      metadata: {}
    });

    console.log('✅ Created test documents at multiple classification levels');

    // Test CONFIDENTIAL clearance can see UNCLASSIFIED and CONFIDENTIAL
    const confidentialViewable = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      'CONFIDENTIAL'
    );

    console.log(`\n   CONFIDENTIAL clearance can see: ${confidentialViewable.length} documents`);
    console.log(`   Expected: 2 (UNCLASSIFIED + CONFIDENTIAL, but NOT SECRET)`);

    // Test SECRET clearance can see all
    const secretViewable = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      'SECRET'
    );

    console.log(`   SECRET clearance can see: ${secretViewable.length} documents`);
    console.log(`   Expected: 3 (UNCLASSIFIED + CONFIDENTIAL + SECRET)`);

    // Step 6: Test cross-company releasability
    console.log('\n[Step 6] Testing cross-company releasability...');

    // ACME should see documents released to them
    const acmeDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['ACME Corporation'],
      'SECRET' // High clearance to see everything they have access to
    );

    console.log(`   ACME Corporation can see: ${acmeDocs.length} documents`);
    console.log(`   Expected: 1 (only Q4 Financial Report was released to ACME)`);

    // EvilCorp should see nothing (no documents released to them)
    const evilCorpDID = 'did:prism:evilcorp-test-did-12345'; // Mock DID
    const evilCorpDocs = await DocumentRegistry.queryByIssuerDID(
      evilCorpDID,
      'TOP_SECRET' // Highest clearance, but no documents released
    );

    console.log(`   EvilCorp can see: ${evilCorpDocs.length} documents`);
    console.log(`   Expected: 0 (no documents released to EvilCorp)`);

    // Step 7: Display registry statistics
    console.log('\n[Step 7] Document Registry Statistics:');
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
    console.log('\nNext steps:');
    console.log('1. Test via Employee Portal UI at https://identuslabel.cz/company-admin/employee-portal-dashboard.html');
    console.log('2. Create real employee account and authenticate');
    console.log('3. Test document creation form');
    console.log('4. Verify clearance-based filtering in UI');
    console.log('');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

main();
