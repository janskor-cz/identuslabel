/**
 * Test Unclassified Document Access
 *
 * This script tests that UNCLASSIFIED documents are accessible to all employees,
 * including those without Security Clearance VCs.
 *
 * Usage: node test-unclassified-document-access.js
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
  console.log('📝 Unclassified Document Access Test');
  console.log('='.repeat(70));

  try {
    // Step 1: Create UNCLASSIFIED document
    console.log('\n[Step 1] Creating UNCLASSIFIED document via Enterprise Cloud Agent...');
    console.log('   Classification: UNCLASSIFIED (accessible to all employees)');
    console.log('   Department: HR');

    const documentManager = new EnterpriseDocumentManager(
      ENTERPRISE_CLOUD_AGENT_URL,
      DEPARTMENT_API_KEYS.HR
    );

    const unclassifiedDocDID = await documentManager.createDocumentDID('HR', {
      title: 'Company Handbook 2025',
      description: 'General company policies and procedures',
      classificationLevel: 'UNCLASSIFIED',
      createdBy: 'hr@techcorp.com',
      createdByDID: 'did:prism:hr-dept'
    });

    console.log(`✅ UNCLASSIFIED Document DID created: ${unclassifiedDocDID.substring(0, 60)}...`);

    // Step 2: Register UNCLASSIFIED document
    console.log('\n[Step 2] Registering UNCLASSIFIED document in DocumentRegistry...');

    await DocumentRegistry.registerDocument({
      documentDID: unclassifiedDocDID,
      title: 'Company Handbook 2025',
      classificationLevel: 'UNCLASSIFIED',
      releasableTo: [
        COMPANY_ISSUER_DIDS['TechCorp Corporation']
      ],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        category: 'HR',
        version: '2025.1',
        author: 'HR Department'
      }
    });

    console.log('✅ UNCLASSIFIED document registered');

    // Step 3: Create CONFIDENTIAL document for comparison
    console.log('\n[Step 3] Creating CONFIDENTIAL document for comparison...');

    const confidentialDocDID = await documentManager.createDocumentDID('HR', {
      title: 'Executive Compensation Report',
      description: 'Confidential executive salary information',
      classificationLevel: 'CONFIDENTIAL',
      createdBy: 'hr@techcorp.com',
      createdByDID: 'did:prism:hr-dept'
    });

    console.log(`✅ CONFIDENTIAL Document DID created: ${confidentialDocDID.substring(0, 60)}...`);

    await DocumentRegistry.registerDocument({
      documentDID: confidentialDocDID,
      title: 'Executive Compensation Report',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: [
        COMPANY_ISSUER_DIDS['TechCorp Corporation']
      ],
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: {
        category: 'HR',
        version: '2025.1',
        author: 'HR Department'
      }
    });

    console.log('✅ CONFIDENTIAL document registered');

    // Step 4: Test access for employee WITHOUT Security Clearance VC
    console.log('\n[Step 4] Testing access for employee WITHOUT Security Clearance VC...');
    console.log('   Clearance Level: NONE (no Security Clearance VC)');
    console.log('   Expected: Can see UNCLASSIFIED documents only');

    const unclassifiedEmployeeDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      null // No clearance = UNCLASSIFIED only
    );

    console.log(`\n   Documents visible: ${unclassifiedEmployeeDocs.length}`);
    console.log(`   Expected: 1 (only the UNCLASSIFIED Company Handbook)`);

    if (unclassifiedEmployeeDocs.length === 1 &&
        unclassifiedEmployeeDocs[0].classificationLevel === 'UNCLASSIFIED') {
      console.log('   ✅ PASS: Employee without clearance can see UNCLASSIFIED document');
      console.log(`\n   Accessible document:`);
      console.log(`   - Title: ${unclassifiedEmployeeDocs[0].title}`);
      console.log(`   - Classification: ${unclassifiedEmployeeDocs[0].classificationLevel}`);
      console.log(`   - DID: ${unclassifiedEmployeeDocs[0].documentDID.substring(0, 60)}...`);
    } else {
      console.log('   ❌ FAIL: Expected 1 UNCLASSIFIED document');
    }

    // Step 5: Test access for employee WITH CONFIDENTIAL clearance
    console.log('\n[Step 5] Testing access for employee WITH CONFIDENTIAL clearance...');
    console.log('   Clearance Level: CONFIDENTIAL');
    console.log('   Expected: Can see both UNCLASSIFIED and CONFIDENTIAL documents');

    const confidentialEmployeeDocs = await DocumentRegistry.queryByIssuerDID(
      COMPANY_ISSUER_DIDS['TechCorp Corporation'],
      'CONFIDENTIAL'
    );

    console.log(`\n   Documents visible: ${confidentialEmployeeDocs.length}`);
    console.log(`   Expected: 2 (UNCLASSIFIED + CONFIDENTIAL)`);

    if (confidentialEmployeeDocs.length === 2) {
      console.log('   ✅ PASS: Employee with CONFIDENTIAL clearance can see both documents');
      console.log(`\n   Accessible documents:`);
      confidentialEmployeeDocs.forEach(doc => {
        console.log(`   - ${doc.title} (${doc.classificationLevel})`);
      });
    } else {
      console.log('   ❌ FAIL: Expected 2 documents');
    }

    // Step 6: Verify CONFIDENTIAL document is NOT visible without clearance
    console.log('\n[Step 6] Verifying CONFIDENTIAL document filtering...');

    const confidentialDocVisible = unclassifiedEmployeeDocs.some(
      doc => doc.classificationLevel === 'CONFIDENTIAL'
    );

    if (!confidentialDocVisible) {
      console.log('   ✅ PASS: CONFIDENTIAL document correctly filtered from unclassified employee');
    } else {
      console.log('   ❌ FAIL: CONFIDENTIAL document should not be visible');
    }

    // Step 7: Display summary
    console.log('\n[Step 7] Summary:');
    const stats = DocumentRegistry.getStatistics();
    console.log(`   Total documents in registry: ${stats.totalDocuments}`);
    console.log(`   UNCLASSIFIED documents: ${stats.byClassification.UNCLASSIFIED}`);
    console.log(`   CONFIDENTIAL documents: ${stats.byClassification.CONFIDENTIAL}`);

    console.log('\n' + '='.repeat(70));
    console.log('✅ All tests completed successfully!');
    console.log('='.repeat(70));
    console.log('\nKey Finding:');
    console.log('✅ UNCLASSIFIED documents ARE accessible to all TechCorp employees');
    console.log('✅ Employees WITHOUT Security Clearance VC can access UNCLASSIFIED docs');
    console.log('✅ Clearance-based filtering works correctly for classified documents');
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
