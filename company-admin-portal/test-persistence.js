/**
 * Test DocumentRegistry Persistence
 *
 * Validates that DocumentRegistry persistence works correctly:
 * - Save registry state to disk
 * - Load registry state from disk
 * - Verify cryptographic integrity (signature validation)
 * - Test crash recovery scenario
 *
 * Usage: node test-persistence.js
 */

const DocumentRegistry = require('./lib/DocumentRegistry');
const DocumentRegistryPersistence = require('./lib/DocumentRegistryPersistence');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const TECHCORP_ISSUER_DID = 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';

async function testPersistence() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 Testing DocumentRegistry Persistence');
  console.log('='.repeat(80) + '\n');

  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };

  // Test 1: Initialize DocumentRegistry
  console.log('[Test 1] Initializing DocumentRegistry...');
  try {
    await DocumentRegistry.initialize();

    const initialStats = DocumentRegistry.getStatistics();
    console.log(`   ✓ Registry initialized with ${initialStats.totalDocuments} documents`);
    console.log('   ✅ Test 1 PASSED: Registry initialization\n');
    results.passed++;
    results.tests.push({ name: 'Registry Initialization', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 1 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Registry Initialization', status: 'FAILED', error: error.message });
  }

  // Test 2: Register test documents
  console.log('[Test 2] Registering test documents...');
  try {
    const testDocuments = [
      {
        documentDID: 'did:prism:test-persistence-1',
        title: 'Persistence Test Document 1',
        classificationLevel: 'UNCLASSIFIED',
        releasableTo: [TECHCORP_ISSUER_DID],
        contentEncryptionKey: 'mock-key-1',
        metadata: { test: 'persistence-test-1' }
      },
      {
        documentDID: 'did:prism:test-persistence-2',
        title: 'Persistence Test Document 2',
        classificationLevel: 'CONFIDENTIAL',
        releasableTo: [TECHCORP_ISSUER_DID],
        contentEncryptionKey: 'mock-key-2',
        metadata: { test: 'persistence-test-2' }
      }
    ];

    for (const doc of testDocuments) {
      await DocumentRegistry.registerDocument(doc);
      console.log(`   ✓ Registered: ${doc.title}`);
    }

    const stats = DocumentRegistry.getStatistics();
    console.log(`   ✓ Total documents after registration: ${stats.totalDocuments}`);
    console.log('   ✅ Test 2 PASSED: Document registration with auto-save\n');
    results.passed++;
    results.tests.push({ name: 'Document Registration', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 2 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Document Registration', status: 'FAILED', error: error.message });
  }

  // Test 3: Verify persistence file exists
  console.log('[Test 3] Verifying persistence file...');
  try {
    const storagePath = DocumentRegistryPersistence.getStoragePath();
    console.log(`   ✓ Storage path: ${storagePath}`);

    const fileExists = await DocumentRegistryPersistence.registryExists();
    if (!fileExists) {
      throw new Error('Registry file does not exist');
    }

    console.log('   ✓ Persistence file exists');

    // Read and verify file structure
    const fileContent = await fs.readFile(storagePath, 'utf8');
    const persistedData = JSON.parse(fileContent);

    if (!persistedData.registryState || !persistedData.signature) {
      throw new Error('Invalid persistence file structure');
    }

    console.log(`   ✓ File contains signature: ${persistedData.signature.substring(0, 16)}...`);
    console.log(`   ✓ Saved at: ${persistedData.signedAt}`);
    console.log(`   ✓ Document count: ${persistedData.registryState.documentCount}`);
    console.log('   ✅ Test 3 PASSED: Persistence file verification\n');
    results.passed++;
    results.tests.push({ name: 'Persistence File Verification', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 3 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Persistence File Verification', status: 'FAILED', error: error.message });
  }

  // Test 4: Simulate crash recovery
  console.log('[Test 4] Simulating crash recovery...');
  try {
    // Save current document count
    const beforeCrashStats = DocumentRegistry.getStatistics();
    console.log(`   ✓ Documents before "crash": ${beforeCrashStats.totalDocuments}`);

    // Simulate crash by clearing in-memory storage
    DocumentRegistry.documents.clear();
    console.log('   ✓ Simulated crash (cleared in-memory registry)');

    // Reinitialize from disk (simulates server restart)
    DocumentRegistry.initialized = false;
    await DocumentRegistry.initialize();

    const afterRecoveryStats = DocumentRegistry.getStatistics();
    console.log(`   ✓ Documents after recovery: ${afterRecoveryStats.totalDocuments}`);

    // Verify recovery
    if (afterRecoveryStats.totalDocuments !== beforeCrashStats.totalDocuments) {
      throw new Error(`Recovery mismatch: expected ${beforeCrashStats.totalDocuments}, got ${afterRecoveryStats.totalDocuments}`);
    }

    // Verify we can still query documents
    const discoverableDocuments = await DocumentRegistry.queryByIssuerDID(TECHCORP_ISSUER_DID, null);
    console.log(`   ✓ Query after recovery returned ${discoverableDocuments.length} documents`);

    console.log('   ✅ Test 4 PASSED: Crash recovery\n');
    results.passed++;
    results.tests.push({ name: 'Crash Recovery', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 4 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Crash Recovery', status: 'FAILED', error: error.message });
  }

  // Test 5: Verify signature validation
  console.log('[Test 5] Testing signature validation (tamper detection)...');
  try {
    const storagePath = DocumentRegistryPersistence.getStoragePath();

    // Save current data
    const fileContent = await fs.readFile(storagePath, 'utf8');
    const persistedData = JSON.parse(fileContent);

    // Tamper with data (change document count)
    const tamperedData = JSON.parse(fileContent);
    tamperedData.registryState.documentCount = 999999;

    // Write tampered data
    await fs.writeFile(storagePath, JSON.stringify(tamperedData, null, 2), 'utf8');
    console.log('   ✓ Created tampered registry file');

    // Try to load tampered data
    try {
      await DocumentRegistryPersistence.loadRegistry();
      // If this succeeds, the test should fail
      throw new Error('Tampered data was accepted (signature validation failed)');
    } catch (error) {
      if (error.message.includes('Signature verification failed')) {
        console.log('   ✓ Tampered data rejected correctly');
      } else {
        throw error;
      }
    }

    // Restore original data
    await fs.writeFile(storagePath, fileContent, 'utf8');
    console.log('   ✓ Restored original registry file');

    console.log('   ✅ Test 5 PASSED: Signature validation (tamper detection)\n');
    results.passed++;
    results.tests.push({ name: 'Signature Validation', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 5 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Signature Validation', status: 'FAILED', error: error.message });
  }

  // Test 6: Clean up test documents
  console.log('[Test 6] Cleaning up test documents...');
  try {
    // Remove test documents
    DocumentRegistry.documents.delete('did:prism:test-persistence-1');
    DocumentRegistry.documents.delete('did:prism:test-persistence-2');

    // Save cleaned registry
    await DocumentRegistryPersistence.saveRegistry(DocumentRegistry.documents);

    const finalStats = DocumentRegistry.getStatistics();
    console.log(`   ✓ Final document count: ${finalStats.totalDocuments}`);
    console.log('   ✅ Test 6 PASSED: Cleanup\n');
    results.passed++;
    results.tests.push({ name: 'Cleanup', status: 'PASSED' });

  } catch (error) {
    console.error(`   ❌ Test 6 FAILED: ${error.message}\n`);
    results.failed++;
    results.tests.push({ name: 'Cleanup', status: 'FAILED', error: error.message });
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
    console.log('✅ All tests passed! DocumentRegistry persistence is working correctly.');
  } else {
    console.log(`⚠️  ${results.failed} test(s) failed. Please review errors above.`);
  }
  console.log('='.repeat(80) + '\n');

  // Return exit code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
testPersistence().catch(error => {
  console.error('\n❌ Fatal error during testing:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});
