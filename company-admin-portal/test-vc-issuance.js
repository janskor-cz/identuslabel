/**
 * Test DocumentMetadata VC Issuance
 *
 * Validates that DocumentMetadata VCs are correctly issued when creating documents
 * via the document creation endpoint. Tests both UNCLASSIFIED and CONFIDENTIAL
 * documents to ensure all classification levels work correctly.
 *
 * Usage: node test-vc-issuance.js
 */

const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const DocumentMetadataVC = require('./lib/DocumentMetadataVC');
const DocumentRegistry = require('./lib/DocumentRegistry');

// Configuration
const ENTERPRISE_CLOUD_AGENT_URL = 'http://91.99.4.54:8300';
const HR_API_KEY = '2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c';
const SECURITY_API_KEY = '23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288';

const TECHCORP_ISSUER_DID = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';

async function testVCIssuance() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 Testing DocumentMetadata VC Issuance');
  console.log('='.repeat(80) + '\n');

  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };

  // Test 1: Create UNCLASSIFIED document with VC
  console.log('[Test 1] Creating UNCLASSIFIED document with VC issuance...');
  try {
    // Step 1: Create document DID
    const docManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, HR_API_KEY);
    const unclassifiedDID = await docManager.createDocumentDID('HR', {
      title: 'Test UNCLASSIFIED Document',
      description: 'Testing VC issuance for UNCLASSIFIED documents',
      classificationLevel: 'UNCLASSIFIED',
      createdBy: 'test@techcorp.com',
      createdByDID: 'did:prism:test'
    });

    console.log(`   ✓ Document DID created: ${unclassifiedDID.substring(0, 50)}...`);

    // Step 2: Issue DocumentMetadata VC
    const vcIssuer = new DocumentMetadataVC(ENTERPRISE_CLOUD_AGENT_URL, HR_API_KEY);
    const vcResult = await vcIssuer.issueDocumentMetadataVC({
      issuerDID: TECHCORP_ISSUER_DID,
      documentDID: unclassifiedDID,
      title: 'Test UNCLASSIFIED Document',
      description: 'Testing VC issuance for UNCLASSIFIED documents',
      classificationLevel: 'UNCLASSIFIED',
      releasableTo: [TECHCORP_ISSUER_DID],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        department: 'HR',
        author: 'test@techcorp.com',
        category: 'Test',
        createdBy: 'test@techcorp.com',
        createdByDID: 'did:prism:test'
      }
    });

    console.log(`   ✓ DocumentMetadata VC issued successfully`);
    console.log(`   ✓ VC Record ID: ${vcResult.recordId}`);

    // Step 3: Register in DocumentRegistry
    await DocumentRegistry.registerDocument({
      documentDID: unclassifiedDID,
      title: 'Test UNCLASSIFIED Document',
      classificationLevel: 'UNCLASSIFIED',
      releasableTo: [TECHCORP_ISSUER_DID],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        description: 'Testing VC issuance for UNCLASSIFIED documents',
        createdBy: 'test@techcorp.com',
        department: 'HR'
      },
      metadataVCRecordId: vcResult.recordId
    });

    console.log(`   ✓ Document registered in DocumentRegistry`);
    console.log('   ✅ Test 1 PASSED: UNCLASSIFIED document with VC\n');
    results.passed++;
    results.tests.push({ name: 'UNCLASSIFIED Document VC Issuance', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 1 FAILED: ${error.message}`);
    console.error(`   Stack: ${error.stack}\n`);
    results.failed++;
    results.tests.push({ name: 'UNCLASSIFIED Document VC Issuance', status: 'FAILED', error: error.message });
  }

  // Test 2: Create CONFIDENTIAL document with VC
  console.log('[Test 2] Creating CONFIDENTIAL document with VC issuance...');
  try {
    // Step 1: Create document DID
    const docManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, SECURITY_API_KEY);
    const confidentialDID = await docManager.createDocumentDID('Security', {
      title: 'Test CONFIDENTIAL Document',
      description: 'Testing VC issuance for CONFIDENTIAL documents',
      classificationLevel: 'CONFIDENTIAL',
      createdBy: 'security@techcorp.com',
      createdByDID: 'did:prism:security'
    });

    console.log(`   ✓ Document DID created: ${confidentialDID.substring(0, 50)}...`);

    // Step 2: Issue DocumentMetadata VC
    const vcIssuer = new DocumentMetadataVC(ENTERPRISE_CLOUD_AGENT_URL, SECURITY_API_KEY);
    const vcResult = await vcIssuer.issueDocumentMetadataVC({
      issuerDID: TECHCORP_ISSUER_DID,
      documentDID: confidentialDID,
      title: 'Test CONFIDENTIAL Document',
      description: 'Testing VC issuance for CONFIDENTIAL documents',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: [TECHCORP_ISSUER_DID],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        department: 'Security',
        author: 'security@techcorp.com',
        category: 'Test',
        createdBy: 'security@techcorp.com',
        createdByDID: 'did:prism:security'
      }
    });

    console.log(`   ✓ DocumentMetadata VC issued successfully`);
    console.log(`   ✓ VC Record ID: ${vcResult.recordId}`);

    // Step 3: Register in DocumentRegistry
    await DocumentRegistry.registerDocument({
      documentDID: confidentialDID,
      title: 'Test CONFIDENTIAL Document',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: [TECHCORP_ISSUER_DID],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        description: 'Testing VC issuance for CONFIDENTIAL documents',
        createdBy: 'security@techcorp.com',
        department: 'Security'
      },
      metadataVCRecordId: vcResult.recordId
    });

    console.log(`   ✓ Document registered in DocumentRegistry`);
    console.log('   ✅ Test 2 PASSED: CONFIDENTIAL document with VC\n');
    results.passed++;
    results.tests.push({ name: 'CONFIDENTIAL Document VC Issuance', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 2 FAILED: ${error.message}`);
    console.error(`   Stack: ${error.stack}\n`);
    results.failed++;
    results.tests.push({ name: 'CONFIDENTIAL Document VC Issuance', status: 'FAILED', error: error.message });
  }

  // Test 3: Query VCs from Enterprise Cloud Agent
  console.log('[Test 3] Querying DocumentMetadata VCs from Enterprise Cloud Agent...');
  try {
    const vcIssuer = new DocumentMetadataVC(ENTERPRISE_CLOUD_AGENT_URL, HR_API_KEY);
    const allVCs = await vcIssuer.queryAllDocumentMetadataVCs();

    console.log(`   ✓ Retrieved ${allVCs.length} credential records`);

    // Filter for our test documents
    const testVCs = allVCs.filter(vc => {
      const claims = vc.claims || {};
      return claims.title && claims.title.includes('Test');
    });

    console.log(`   ✓ Found ${testVCs.length} test DocumentMetadata VCs`);

    if (testVCs.length >= 2) {
      console.log('   ✅ Test 3 PASSED: VC query successful\n');
      results.passed++;
      results.tests.push({ name: 'Query DocumentMetadata VCs', status: 'PASSED' });
    } else {
      throw new Error(`Expected at least 2 test VCs, found ${testVCs.length}`);
    }

  } catch (error) {
    console.error(`   ❌ Test 3 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Query DocumentMetadata VCs', status: 'FAILED', error: error.message });
  }

  // Test 4: Validate VC parsing
  console.log('[Test 4] Testing VC parsing to registry format...');
  try {
    const vcIssuer = new DocumentMetadataVC(ENTERPRISE_CLOUD_AGENT_URL, HR_API_KEY);
    const allVCs = await vcIssuer.queryAllDocumentMetadataVCs();

    if (allVCs.length === 0) {
      throw new Error('No VCs found to parse');
    }

    const firstVC = allVCs[0];
    const parsedDoc = vcIssuer.parseDocumentMetadataVC(firstVC);

    console.log(`   ✓ Parsed VC successfully`);
    console.log(`   ✓ Document DID: ${parsedDoc.documentDID ? parsedDoc.documentDID.substring(0, 40) + '...' : 'N/A'}`);
    console.log(`   ✓ Title: ${parsedDoc.title || 'N/A'}`);
    console.log(`   ✓ Classification: ${parsedDoc.classificationLevel || 'N/A'}`);
    console.log(`   ✓ Releasable to: ${parsedDoc.releasableTo ? parsedDoc.releasableTo.length : 0} companies`);

    console.log('   ✅ Test 4 PASSED: VC parsing successful\n');
    results.passed++;
    results.tests.push({ name: 'Parse DocumentMetadata VC', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 4 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Parse DocumentMetadata VC', status: 'FAILED', error: error.message });
  }

  // Display summary
  console.log('='.repeat(80));
  console.log('📊 Test Summary');
  console.log('='.repeat(80));
  console.log(`\nTotal Tests: ${results.passed + results.failed}`);
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log('\nTest Results:');
  results.tests.forEach((test, index) => {
    const icon = test.status === 'PASSED' ? '✅' : '❌';
    console.log(`  ${icon} ${index + 1}. ${test.name}: ${test.status}`);
    if (test.error) {
      console.log(`     Error: ${test.error}`);
    }
  });

  console.log('\n' + '='.repeat(80));
  if (results.failed === 0) {
    console.log('✅ All tests passed! DocumentMetadata VC issuance is working correctly.');
  } else {
    console.log(`⚠️  ${results.failed} test(s) failed. Please review errors above.`);
  }
  console.log('='.repeat(80) + '\n');

  // Return exit code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
testVCIssuance().catch(error => {
  console.error('\n❌ Fatal error during testing:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});
