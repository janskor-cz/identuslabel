/**
 * End-to-End Test for Clearance-Based Document Redaction System
 *
 * Tests the complete flow:
 * 1. Parse HTML document with section-level clearance markers
 * 2. Encrypt sections with clearance-based keys
 * 3. Decrypt with different clearance levels
 * 4. Verify redaction works correctly
 *
 * Usage: node test-classified-document-e2e.js
 */

const fs = require('fs');
const path = require('path');

// Import function-based services
const {
  parseClearanceSections,
  validateDocument,
  determineOverallClassification,
  CLEARANCE_LEVELS
} = require('./lib/ClearanceDocumentParser');

const {
  encryptSections,
  decryptSectionsForUser,
  getSectionMetadata
} = require('./lib/SectionEncryptionService');

const {
  generateRedactedDocument,
  applyRedactionToHtml,
  generateRedactedView
} = require('./lib/RedactionEngine');

const {
  createEphemeralDID,
  checkEphemeralDIDValidity,
  createDocumentCopyVCClaims,
  DEFAULT_TTL_MS
} = require('./lib/EphemeralDIDService');

// DocumentRegistry is a singleton instance
const documentRegistry = require('./lib/DocumentRegistry');

// Test document with mixed clearance levels
const TEST_HTML_DOCUMENT = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="document-type" content="classified-document">
  <meta name="document-title" content="Q4 Security Briefing">
</head>
<body>
  <h1>Q4 Security Briefing - TechCorp</h1>

  <!-- Public section - no clearance marker = UNCLASSIFIED -->
  <section>
    <h2>General Announcements</h2>
    <p>All employees must complete annual security training by December 31st.</p>
    <p>New badge readers installed in Building A lobby.</p>
  </section>

  <!-- CONFIDENTIAL section -->
  <section data-clearance="CONFIDENTIAL">
    <h2>Network Security Updates</h2>
    <p>Firewall rules updated for Q4. New VPN server deployed at datacenter-2.</p>
    <p>Security patches deployed to all production servers.</p>
  </section>

  <!-- SECRET section -->
  <section data-clearance="SECRET">
    <h2>Incident Response Summary</h2>
    <p>Three security incidents investigated this quarter:</p>
    <ul>
      <li>Phishing attempt blocked on October 15</li>
      <li>Unauthorized access attempt from IP 192.168.x.x</li>
      <li>Data exfiltration attempt detected and prevented</li>
    </ul>
  </section>

  <!-- TOP_SECRET section -->
  <section data-clearance="TOP_SECRET">
    <h2>Classified Operations</h2>
    <p>Project Phoenix status: ACTIVE</p>
    <p>Authorization codes: ALPHA-7392-OMEGA</p>
    <p>Next operation window: January 15-20, 2026</p>
  </section>

  <!-- Mixed content with inline clearance -->
  <section>
    <h2>Budget Overview</h2>
    <p>Total security budget: $500,000</p>
    <p data-clearance="CONFIDENTIAL">Allocated breakdown: Personnel $200K, Equipment $150K, Training $100K, Reserve $50K</p>
    <p>All department heads approved the budget allocation.</p>
  </section>

</body>
</html>`;

// Track test results
const testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${status}: ${name}${details ? ` - ${details}` : ''}`);
  testResults.tests.push({ name, passed, details });
  if (passed) testResults.passed++;
  else testResults.failed++;
}

async function testDocumentParsing() {
  console.log('\n' + '='.repeat(70));
  console.log('📝 TEST 1: Document Parsing');
  console.log('='.repeat(70));

  try {
    const parsed = parseClearanceSections(TEST_HTML_DOCUMENT);

    // Test: Document parsed successfully
    logTest('Document parsed without errors', !!parsed);

    // Test: Title extracted
    logTest('Document title extracted', parsed.metadata.title === 'Q4 Security Briefing',
      `Got: "${parsed.metadata.title}"`);

    // Test: Has sections (note: parser only extracts marked sections)
    const sectionCount = parsed.sections.length;
    logTest('Sections detected', sectionCount >= 4,
      `Found ${sectionCount} sections (marked only)`);

    // Test: Section clearance levels correct
    const clearanceCounts = {
      UNCLASSIFIED: 0,
      CONFIDENTIAL: 0,
      SECRET: 0,
      TOP_SECRET: 0
    };
    parsed.sections.forEach(s => {
      if (clearanceCounts[s.clearance] !== undefined) {
        clearanceCounts[s.clearance]++;
      }
    });

    console.log(`\n  Section breakdown (marked sections only):`);
    console.log(`    UNCLASSIFIED: ${clearanceCounts.UNCLASSIFIED}`);
    console.log(`    CONFIDENTIAL: ${clearanceCounts.CONFIDENTIAL}`);
    console.log(`    SECRET: ${clearanceCounts.SECRET}`);
    console.log(`    TOP_SECRET: ${clearanceCounts.TOP_SECRET}`);

    // Parser only captures elements WITH data-clearance attributes
    // Unmarked sections are handled separately as UNCLASSIFIED remainder
    logTest('Has CONFIDENTIAL sections', clearanceCounts.CONFIDENTIAL >= 1);
    logTest('Has SECRET section', clearanceCounts.SECRET >= 1);
    logTest('Has TOP_SECRET section', clearanceCounts.TOP_SECRET >= 1);

    // Overall classification (highest in doc)
    console.log(`\n  Overall classification: ${parsed.metadata.overallClassification}`);
    logTest('Overall classification detected',
      ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'].includes(parsed.metadata.overallClassification));

    return parsed;

  } catch (error) {
    logTest('Document parsing', false, error.message);
    console.error('  Error stack:', error.stack);
    return null;
  }
}

// Fixed company secret for consistent testing
const TEST_COMPANY_SECRET = 'test-company-secret-for-e2e-testing';

async function testSectionEncryption(parsed) {
  console.log('\n' + '='.repeat(70));
  console.log('🔐 TEST 2: Section Encryption');
  console.log('='.repeat(70));

  if (!parsed) {
    logTest('Skip - no parsed document', false);
    return null;
  }

  try {
    // encryptSections expects the full parsed document object
    const encrypted = encryptSections(parsed, TEST_COMPANY_SECRET);

    // Test: Encryption succeeded
    logTest('Document encryption succeeded', !!encrypted);

    // Test: Document ID generated
    logTest('Document ID generated', !!encrypted.documentId,
      `ID: ${encrypted.documentId?.substring(0, 30)}...`);

    // Test: All sections encrypted
    logTest('All sections encrypted',
      encrypted.encryptedSections.length === parsed.sections.length,
      `${encrypted.encryptedSections.length} encrypted sections`);

    // Test: Keyring has clearance levels
    const keyringLevels = Object.keys(encrypted.keyring || {});
    console.log(`\n  Keyring contains keys for: ${keyringLevels.join(', ')}`);

    logTest('Keyring has clearance keys', keyringLevels.length >= 1);

    // Test: Each encrypted section has required fields
    if (encrypted.encryptedSections.length > 0) {
      const firstSection = encrypted.encryptedSections[0];
      logTest('Encrypted sections have ciphertext', !!firstSection.ciphertext);
      logTest('Encrypted sections have IV', !!firstSection.iv);
      logTest('Encrypted sections have authTag', !!firstSection.authTag);
    }

    console.log(`\n  Encrypted package size: ${JSON.stringify(encrypted).length} bytes`);

    return encrypted;

  } catch (error) {
    logTest('Section encryption', false, error.message);
    console.error('  Error stack:', error.stack);
    return null;
  }
}

async function testSectionDecryption(encrypted) {
  console.log('\n' + '='.repeat(70));
  console.log('🔓 TEST 3: Section Decryption (Clearance-Based)');
  console.log('='.repeat(70));

  if (!encrypted) {
    logTest('Skip - no encrypted document', false);
    return null;
  }

  try {
    // decryptSectionsForUser expects: (encryptedPackage, userClearance, companySecret)
    // The encrypted package must include metadata.title for key derivation

    // Test decryption at each clearance level
    const clearanceLevels = [
      { name: 'UNCLASSIFIED', level: 1 },
      { name: 'CONFIDENTIAL', level: 2 },
      { name: 'SECRET', level: 3 },
      { name: 'TOP_SECRET', level: 4 }
    ];

    const decryptionResults = {};

    for (const { name, level } of clearanceLevels) {
      console.log(`\n  Testing ${name} clearance (level ${level}):`);

      // Pass full encrypted package, clearance name, and company secret
      const decrypted = decryptSectionsForUser(encrypted, name, TEST_COMPANY_SECRET);

      // Store the FULL decryption result (needed by RedactionEngine)
      decryptionResults[name] = decrypted;

      const accessible = (decrypted.decryptedSections || []).length;
      const redacted = (decrypted.redactedSections || []).length;

      console.log(`    Accessible: ${accessible} sections`);
      console.log(`    Redacted: ${redacted} sections`);

      // Verify clearance hierarchy
      if (name === 'TOP_SECRET') {
        const totalSections = encrypted.encryptedSections.length;
        logTest(`${name}: Can access all content`, accessible === totalSections,
          `${accessible}/${totalSections}`);
        logTest(`${name}: No sections redacted`, redacted === 0);
      }
    }

    // Test that lower clearances see fewer sections
    const unclassifiedAccessible = (decryptionResults['UNCLASSIFIED'].decryptedSections || []).length;
    const topSecretAccessible = (decryptionResults['TOP_SECRET'].decryptedSections || []).length;

    logTest('Higher clearance sees more content',
      topSecretAccessible >= unclassifiedAccessible,
      `UNCLASSIFIED: ${unclassifiedAccessible}, TOP_SECRET: ${topSecretAccessible}`);

    return decryptionResults;

  } catch (error) {
    logTest('Section decryption', false, error.message);
    console.error('  Error stack:', error.stack);
    return null;
  }
}

async function testRedactionEngine(decryptionResults) {
  console.log('\n' + '='.repeat(70));
  console.log('⬛ TEST 4: Redaction Engine');
  console.log('='.repeat(70));

  if (!decryptionResults) {
    logTest('Skip - no decryption results', false);
    return;
  }

  try {
    // generateRedactedDocument expects the FULL decryption result from decryptSectionsForUser
    // which includes: { decryptedSections, redactedSections, metadata, userClearance, userClearanceLevel }

    // Use the stored CONFIDENTIAL decryption result
    const confidentialDecryptResult = decryptionResults['CONFIDENTIAL'];

    const redactedHtml = generateRedactedDocument(
      confidentialDecryptResult,
      { includeWatermark: true, includeHeader: true }
    );

    // Test: HTML generated
    logTest('Redacted HTML generated', !!redactedHtml && redactedHtml.length > 0);

    // Test: Contains redaction markers (check for common redaction patterns)
    const hasRedactionMarkers = redactedHtml.includes('REDACTED') ||
      redactedHtml.includes('redacted') ||
      redactedHtml.includes('redaction-block') ||
      redactedHtml.includes('insufficient clearance');

    logTest('Contains redaction markers', hasRedactionMarkers);

    console.log(`\n  Redacted HTML size: ${redactedHtml.length} bytes`);

    // Show snippet of redacted HTML
    console.log(`\n  Sample redacted output (first 1000 chars):`);
    console.log('  ' + '-'.repeat(50));
    console.log(redactedHtml.substring(0, 1000).replace(/\n/g, '\n  '));

  } catch (error) {
    logTest('Redaction engine', false, error.message);
    console.error('  Error stack:', error.stack);
  }
}

async function testEphemeralDID() {
  console.log('\n' + '='.repeat(70));
  console.log('🔑 TEST 5: Ephemeral DID Service');
  console.log('='.repeat(70));

  try {
    // createEphemeralDID uses ttlMs, not ttlHours
    const result = createEphemeralDID({
      originalDocumentDID: 'did:prism:test-document-123',
      recipientDID: 'did:prism:test-recipient-456',
      clearanceLevel: 'CONFIDENTIAL',
      redactedSections: [{ sectionId: 'sec-003' }, { sectionId: 'sec-004' }],
      ttlMs: DEFAULT_TTL_MS // 1 hour
    });

    // Function returns { didDocument, metadata }
    const { didDocument, metadata } = result;

    // Test: Ephemeral DID created
    logTest('Ephemeral DID created', !!metadata);

    // Test: DID format correct
    logTest('DID format is did:ephemeral:*',
      metadata?.ephemeralDID?.startsWith('did:ephemeral:'),
      metadata?.ephemeralDID?.substring(0, 40));

    // Test: Expiration set
    logTest('Expiration timestamp set', !!metadata?.expiresAt);

    // Test: Expiration is ~1 hour from now
    if (metadata?.expiresAt) {
      const expiresAt = new Date(metadata.expiresAt);
      const now = new Date();
      const diffHours = (expiresAt - now) / (1000 * 60 * 60);
      logTest('Expiration is ~1 hour from now',
        diffHours >= 0.9 && diffHours <= 1.1,
        `${diffHours.toFixed(2)} hours`);
    }

    // Test: Metadata preserved
    logTest('Original document DID preserved',
      metadata?.originalDocumentDID === 'did:prism:test-document-123');
    logTest('Clearance level preserved',
      metadata?.clearanceLevel === 'CONFIDENTIAL');
    logTest('Redacted sections recorded',
      metadata?.redactedSections?.length === 2);

    console.log(`\n  Ephemeral DID: ${metadata?.ephemeralDID}`);
    console.log(`  Expires at: ${metadata?.expiresAt}`);

    // Test validity check - checkEphemeralDIDValidity expects metadata object
    const validityResult = checkEphemeralDIDValidity(metadata);
    logTest('Validity check works',
      typeof validityResult === 'object' && 'valid' in validityResult,
      `valid: ${validityResult?.valid}`);

    // Test DID Document structure
    logTest('DID Document has @context', Array.isArray(didDocument?.['@context']));
    logTest('DID Document has verificationMethod', Array.isArray(didDocument?.verificationMethod));

    return { didDocument, metadata };

  } catch (error) {
    logTest('Ephemeral DID creation', false, error.message);
    console.error('  Error stack:', error.stack);
    return null;
  }
}

async function testDocumentRegistry() {
  console.log('\n' + '='.repeat(70));
  console.log('📚 TEST 6: Document Registry');
  console.log('='.repeat(70));

  try {
    // DocumentRegistry is a singleton with async methods
    logTest('DocumentRegistry loaded', !!documentRegistry);

    // Test register and retrieve document
    // DocumentRegistry requires: documentDID, title, classificationLevel, releasableTo, contentEncryptionKey
    const testDoc = {
      documentDID: 'did:prism:test-e2e-' + Date.now(),
      title: 'Test Document for E2E',
      classificationLevel: 'CONFIDENTIAL',
      releasableTo: ['TechCorp Corporation'],
      contentEncryptionKey: Buffer.from('test-encryption-key-32-bytes!!!').toString('base64'),
      company: 'TechCorp',
      companyDID: 'did:prism:techcorp',
      department: 'IT',
      sectionMetadata: {
        totalSections: 5,
        byClearance: {
          UNCLASSIFIED: 2,
          CONFIDENTIAL: 2,
          SECRET: 1,
          TOP_SECRET: 0
        }
      },
      iagonStorage: {
        fileId: 'test-file-id',
        uploadedAt: new Date().toISOString()
      },
      metadata: {
        createdBy: 'test@example.com',
        createdAt: new Date().toISOString()
      }
    };

    // Register document
    if (typeof documentRegistry.registerDocument === 'function') {
      await documentRegistry.registerDocument(testDoc);
      logTest('Document registered successfully', true);

      // Retrieve it
      if (typeof documentRegistry.getDocument === 'function') {
        // getDocument(documentDID, requestingCompany) - company name from releasableTo
        const retrieved = await documentRegistry.getDocument(testDoc.documentDID, 'TechCorp Corporation');
        logTest('Document retrievable', !!retrieved);

        if (retrieved) {
          logTest('Document title preserved', retrieved.title === testDoc.title);
          // sectionMetadata is stored but may be in encrypted metadata, check classification instead
          logTest('Document classification preserved',
            retrieved.classificationLevel === testDoc.classificationLevel);
        }
      } else {
        logTest('getDocument method exists', false, 'Method not found');
      }
    } else {
      logTest('registerDocument method exists', false, 'Method not found');
    }

    // Check if getStats exists
    if (typeof documentRegistry.getStats === 'function') {
      const stats = await documentRegistry.getStats();
      logTest('Registry stats available', !!stats);
    } else {
      console.log('  Note: getStats method not available');
    }

  } catch (error) {
    logTest('Document registry', false, error.message);
    console.error('  Error stack:', error.stack);
  }
}

async function testAPIEndpoints() {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 TEST 7: API Endpoint Check');
  console.log('='.repeat(70));

  try {
    const fetch = (await import('node-fetch')).default;

    // Test health endpoint
    const healthResponse = await fetch('http://localhost:3010/api/health');
    const healthData = await healthResponse.json();
    logTest('Health endpoint responds', healthResponse.ok, healthData.service);

    // Test classified document endpoints (they require session, so expect 401/403)
    console.log('\n  Checking classified document endpoints (require session)...');

    // Test upload endpoint without session
    const uploadCheck = await fetch('http://localhost:3010/api/classified-documents/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    // 401/403 means endpoint exists but requires auth, 404 means not found
    const uploadExists = uploadCheck.status !== 404;
    logTest('Upload endpoint exists', uploadExists,
      `Status: ${uploadCheck.status} (${uploadCheck.status === 401 || uploadCheck.status === 403 ? 'requires auth' : uploadCheck.statusText})`);

    // Test download endpoint without session
    const downloadCheck = await fetch('http://localhost:3010/api/classified-documents/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const downloadExists = downloadCheck.status !== 404;
    logTest('Download endpoint exists', downloadExists,
      `Status: ${downloadCheck.status} (${downloadCheck.status === 401 || downloadCheck.status === 403 ? 'requires auth' : downloadCheck.statusText})`);

    // Test templates endpoint (may not require auth)
    const templatesCheck = await fetch('http://localhost:3010/api/classified-documents/templates');
    logTest('Templates endpoint exists', templatesCheck.status !== 404,
      `Status: ${templatesCheck.status}`);

    console.log('\n  Note: Full upload/download tests require authenticated session');

  } catch (error) {
    logTest('API endpoints', false, error.message);
    console.error('  Error:', error.message);
  }
}

// Main test runner
async function runAllTests() {
  console.log('\n' + '═'.repeat(70));
  console.log('🧪 CLEARANCE-BASED DOCUMENT REDACTION SYSTEM - E2E TESTS');
  console.log('═'.repeat(70));
  console.log(`Started: ${new Date().toISOString()}`);

  // Run tests in sequence
  const parsed = await testDocumentParsing();
  const encrypted = await testSectionEncryption(parsed);
  const decryptionResults = await testSectionDecryption(encrypted);
  await testRedactionEngine(decryptionResults);
  await testEphemeralDID();
  await testDocumentRegistry();
  await testAPIEndpoints();

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total tests: ${testResults.passed + testResults.failed}`);
  console.log(`  ✅ Passed: ${testResults.passed}`);
  console.log(`  ❌ Failed: ${testResults.failed}`);
  console.log(`  Success rate: ${((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(1)}%`);

  if (testResults.failed > 0) {
    console.log('\n  Failed tests:');
    testResults.tests.filter(t => !t.passed).forEach(t => {
      console.log(`    - ${t.name}${t.details ? `: ${t.details}` : ''}`);
    });
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`Completed: ${new Date().toISOString()}`);

  // Exit with appropriate code
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run
runAllTests().catch(error => {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
});
