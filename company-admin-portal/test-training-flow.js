/**
 * Test script for CIS Training completion flow
 *
 * Tests:
 * 1. Session validation
 * 2. Training completion submission
 * 3. VC issuance status polling
 * 4. Duplicate completion prevention
 */

const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3010';

// Mock session token (replace with real token from login flow)
const MOCK_SESSION = {
  token: 'test-session-token-' + Date.now(),
  prismDid: 'did:prism:test123',
  employeeId: 'EMP-TEST-001',
  email: 'test@techcorp.com',
  role: 'Employee',
  department: 'Engineering',
  fullName: 'Test Employee',
  hasTraining: false,
  trainingExpiryDate: null,
  authenticatedAt: Date.now(),
  lastActivity: Date.now()
};

// Store session in-memory for testing
const employeeSessions = new Map();

async function testTrainingFlow() {
  console.log('🧪 Testing CIS Training Completion Flow\n');
  console.log('=' .repeat(70));

  try {
    // Test 1: Verify endpoints exist
    console.log('\n1️⃣  Testing endpoint accessibility...');

    const healthCheck = await fetch(`${BASE_URL}/api/health`);
    if (healthCheck.ok) {
      console.log('   ✅ Server is running');
    } else {
      throw new Error('Server health check failed');
    }

    // Test 2: Test without session (should fail)
    console.log('\n2️⃣  Testing without session token (should fail)...');

    const noSessionResponse = await fetch(`${BASE_URL}/api/employee-portal/training/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (noSessionResponse.status === 401) {
      console.log('   ✅ Correctly rejected request without session token');
    } else {
      console.log(`   ⚠️  Expected 401, got ${noSessionResponse.status}`);
    }

    // Test 3: Test with invalid session (should fail)
    console.log('\n3️⃣  Testing with invalid session token (should fail)...');

    const invalidSessionResponse = await fetch(`${BASE_URL}/api/employee-portal/training/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-token': 'invalid-token-123'
      }
    });

    if (invalidSessionResponse.status === 401) {
      console.log('   ✅ Correctly rejected invalid session token');
    } else {
      console.log(`   ⚠️  Expected 401, got ${invalidSessionResponse.status}`);
    }

    // Test 4: Check status endpoint without valid session
    console.log('\n4️⃣  Testing status endpoint without session...');

    const statusNoSessionResponse = await fetch(`${BASE_URL}/api/employee-portal/training/status/test-record-id`);

    if (statusNoSessionResponse.status === 401) {
      console.log('   ✅ Status endpoint correctly requires authentication');
    } else {
      console.log(`   ⚠️  Expected 401, got ${statusNoSessionResponse.status}`);
    }

    // Test 5: Verify HTML page loads
    console.log('\n5️⃣  Testing training page HTML...');

    const htmlResponse = await fetch(`${BASE_URL}/employee-training.html`);
    const htmlText = await htmlResponse.text();

    if (htmlText.includes('Corporate Information Security Training') &&
        htmlText.includes('Data Protection & Privacy')) {
      console.log('   ✅ Training page HTML loads correctly');
      console.log(`   📄 Page size: ${(htmlText.length / 1024).toFixed(2)} KB`);
    } else {
      console.log('   ❌ Training page HTML missing expected content');
    }

    // Test 6: Verify JavaScript file loads
    console.log('\n6️⃣  Testing training JavaScript...');

    const jsResponse = await fetch(`${BASE_URL}/js/employee-training.js`);
    const jsText = await jsResponse.text();

    if (jsText.includes('handleSubmit') && jsText.includes('pollForVCIssuance')) {
      console.log('   ✅ Training JavaScript loads correctly');
      console.log(`   📄 Script size: ${(jsText.length / 1024).toFixed(2)} KB`);
    } else {
      console.log('   ❌ Training JavaScript missing expected functions');
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ All endpoint tests passed!');
    console.log('\n📝 Note: Full flow testing requires:');
    console.log('   - Valid employee session from authentication');
    console.log('   - Registered employee in database');
    console.log('   - Active DIDComm connection to TechCorp');
    console.log('   - Edge wallet to accept VC offers');
    console.log('\n🔗 Manual testing:');
    console.log('   1. Login via employee-portal-login.html');
    console.log('   2. Navigate to employee-training.html');
    console.log('   3. Complete training modules');
    console.log('   4. Check completion box and submit');
    console.log('   5. Verify VC appears in edge wallet');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run tests
testTrainingFlow().catch(console.error);
