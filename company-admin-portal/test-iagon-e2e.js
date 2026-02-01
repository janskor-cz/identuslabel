/**
 * End-to-end test for Iagon storage integration
 * Tests upload, file ID capture, and download via file ID
 */

const { IagonStorageClient } = require('./lib/IagonStorageClient');

async function testIagonE2E() {
  console.log('=== Iagon Storage End-to-End Test ===\n');

  // Initialize client
  const client = new IagonStorageClient({
    accessToken: process.env.IAGON_ACCESS_TOKEN,
    nodeId: process.env.IAGON_NODE_ID,
    downloadBaseUrl: 'https://gw.iagon.com/api/v2'
  });

  // Check configuration
  if (!client.isConfigured()) {
    console.error('❌ Iagon client not configured. Set IAGON_ACCESS_TOKEN and IAGON_NODE_ID.');
    process.exit(1);
  }
  console.log('✅ Iagon client configured');
  console.log(`   Node ID: ${client.nodeId}`);
  console.log(`   Download Base URL: ${client.downloadBaseUrl}\n`);

  // Step 1: Create test content
  const testContent = `Test document created at ${new Date().toISOString()}\nThis is a test of the Iagon storage integration.`;
  const testBuffer = Buffer.from(testContent);
  const testFilename = `iagon-e2e-test-${Date.now()}.txt`;

  console.log(`📄 Test document: ${testFilename}`);
  console.log(`   Size: ${testBuffer.length} bytes`);
  console.log(`   Content: "${testContent.substring(0, 50)}..."\n`);

  try {
    // Step 2: Upload file
    console.log('📤 Step 1: Uploading file to Iagon...');
    const uploadResult = await client.uploadFile(testBuffer, testFilename, {
      classificationLevel: 'UNCLASSIFIED'
    });

    console.log('✅ Upload successful!');
    console.log(`   File ID: ${uploadResult.fileId}`);
    console.log(`   Content Hash: ${uploadResult.contentHash}`);
    console.log(`   Iagon URL: ${uploadResult.iagonUrl}`);
    console.log(`   File Size: ${uploadResult.fileSize} bytes`);
    console.log(`   Original Size: ${uploadResult.originalSize} bytes\n`);

    // Verify file ID was captured
    if (!uploadResult.fileId) {
      console.error('❌ File ID not captured from upload response!');
      process.exit(1);
    }

    // Step 3: Download file using file ID
    console.log(`📥 Step 2: Downloading file using file ID (${uploadResult.fileId})...`);
    const downloadedContent = await client.downloadFile(
      uploadResult.fileId,
      uploadResult.encryptionInfo
    );

    console.log('✅ Download successful!');
    console.log(`   Downloaded Size: ${downloadedContent.length} bytes`);

    // Step 4: Verify content
    console.log('\n🔍 Step 3: Verifying content integrity...');
    const originalHash = client.calculateContentHash(testBuffer);
    const downloadedHash = client.calculateContentHash(downloadedContent);

    if (originalHash === downloadedHash) {
      console.log('✅ Content verification PASSED!');
      console.log(`   Original Hash:   ${originalHash}`);
      console.log(`   Downloaded Hash: ${downloadedHash}`);
    } else {
      console.error('❌ Content verification FAILED!');
      console.error(`   Original Hash:   ${originalHash}`);
      console.error(`   Downloaded Hash: ${downloadedHash}`);
      console.error(`   Original Content: "${testContent}"`);
      console.error(`   Downloaded Content: "${downloadedContent.toString('utf8')}"`);
      process.exit(1);
    }

    // Step 5: Test encrypted document (CONFIDENTIAL classification)
    console.log('\n📤 Step 4: Testing encrypted document upload (CONFIDENTIAL)...');
    const confidentialContent = Buffer.from('This is a CONFIDENTIAL document for testing encryption.');
    const confidentialFilename = `iagon-e2e-encrypted-${Date.now()}.txt`;

    const encryptedUploadResult = await client.uploadFile(confidentialContent, confidentialFilename, {
      classificationLevel: 'CONFIDENTIAL'
    });

    console.log('✅ Encrypted upload successful!');
    console.log(`   File ID: ${encryptedUploadResult.fileId}`);
    console.log(`   Encryption Algorithm: ${encryptedUploadResult.encryptionInfo.algorithm}`);
    console.log(`   Key ID: ${encryptedUploadResult.encryptionInfo.keyId}`);

    // Download and decrypt
    console.log(`\n📥 Step 5: Downloading and decrypting encrypted file...`);
    const decryptedContent = await client.downloadFile(
      encryptedUploadResult.fileId,
      encryptedUploadResult.encryptionInfo
    );

    const confidentialDecrypted = decryptedContent.toString('utf8');
    if (confidentialDecrypted === 'This is a CONFIDENTIAL document for testing encryption.') {
      console.log('✅ Encrypted document round-trip PASSED!');
      console.log(`   Content: "${confidentialDecrypted}"`);
    } else {
      console.error('❌ Encrypted document verification FAILED!');
      console.error(`   Expected: "This is a CONFIDENTIAL document for testing encryption."`);
      console.error(`   Got: "${confidentialDecrypted}"`);
      process.exit(1);
    }

    console.log('\n' + '='.repeat(50));
    console.log('🎉 ALL TESTS PASSED!');
    console.log('='.repeat(50));
    console.log('\nSummary:');
    console.log('  ✅ Upload with file ID capture: WORKING');
    console.log('  ✅ Download using file ID: WORKING');
    console.log('  ✅ Content integrity verification: WORKING');
    console.log('  ✅ Encrypted document round-trip: WORKING');

    // Return test results for programmatic use
    return {
      success: true,
      unencryptedFileId: uploadResult.fileId,
      encryptedFileId: encryptedUploadResult.fileId
    };

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Run test
testIagonE2E().then(result => {
  console.log('\nTest result:', result);
  process.exit(0);
}).catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
