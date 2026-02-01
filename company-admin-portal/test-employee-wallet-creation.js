/**
 * Test Employee Wallet Creation
 *
 * Tests the new employee wallet creation workflow using the
 * EmployeeWalletManager and Company Admin Portal API endpoints.
 *
 * Workflow:
 * 1. Create Alice's wallet on Employee Cloud Agent (port 8300)
 * 2. Verify wallet created with PRISM DID
 * 3. List all employee wallets
 * 4. Verify Alice's wallet appears in list
 *
 * Run: node test-employee-wallet-creation.js
 */

const fetch = require('node-fetch');

// Configuration
const COMPANY_ADMIN_PORTAL_URL = 'http://localhost:3010';
const EMPLOYEE_CLOUD_AGENT_URL = 'https://identuslabel.cz/enterprise';

// Test employee data
const TEST_EMPLOYEE = {
  email: 'alice.smith@company.com',
  name: 'Alice Smith',
  department: 'IT'
};

/**
 * Test 1: Create employee wallet via API
 */
async function testCreateEmployeeWallet() {
  console.log('\n🧪 TEST 1: Create Employee Wallet\n');
  console.log(`Creating wallet for: ${TEST_EMPLOYEE.name} (${TEST_EMPLOYEE.email})`);

  try {
    const response = await fetch(`${COMPANY_ADMIN_PORTAL_URL}/api/admin/create-employee-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_EMPLOYEE)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error ${response.status}: ${error}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Wallet creation failed: ${result.error}`);
    }

    const wallet = result.wallet;

    console.log('\n✅ Wallet Created Successfully!\n');
    console.log('Wallet Details:');
    console.log(`  - Employee: ${wallet.name} (${wallet.email})`);
    console.log(`  - Department: ${wallet.department}`);
    console.log(`  - Wallet ID: ${wallet.walletId}`);
    console.log(`  - Entity ID: ${wallet.entityId}`);
    console.log(`  - API Key: ${wallet.apiKey.substring(0, 20)}...`);
    console.log(`  - PRISM DID: ${wallet.prismDid.substring(0, 60)}...`);
    console.log(`  - Created: ${wallet.created}`);

    // Verify all fields present
    const requiredFields = ['walletId', 'entityId', 'apiKey', 'prismDid', 'email', 'name', 'department'];
    const missingFields = requiredFields.filter(field => !wallet[field]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    console.log('\n✅ TEST 1 PASSED: All required fields present');

    return wallet;

  } catch (error) {
    console.error('\n❌ TEST 1 FAILED:', error.message);
    throw error;
  }
}

/**
 * Test 2: List all employee wallets
 */
async function testListEmployeeWallets() {
  console.log('\n\n🧪 TEST 2: List Employee Wallets\n');

  try {
    const response = await fetch(`${COMPANY_ADMIN_PORTAL_URL}/api/admin/list-employee-wallets`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error ${response.status}: ${error}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Wallet listing failed: ${result.error}`);
    }

    console.log(`\n✅ Found ${result.count} employee wallet(s):\n`);

    result.wallets.forEach((wallet, index) => {
      console.log(`${index + 1}. ${wallet.name || 'Unknown'}`);
      console.log(`   ID: ${wallet.id}`);
      console.log(`   Created: ${wallet.createdAt}`);
      console.log('');
    });

    console.log('✅ TEST 2 PASSED: Wallet listing successful');

    return result.wallets;

  } catch (error) {
    console.error('\n❌ TEST 2 FAILED:', error.message);
    throw error;
  }
}

/**
 * Test 3: Verify Alice's wallet exists in list
 */
async function testVerifyAliceWallet(walletId, wallets) {
  console.log('\n\n🧪 TEST 3: Verify Alice Wallet in List\n');

  try {
    const aliceWallet = wallets.find(w => w.id === walletId || w.name?.includes('Alice'));

    if (!aliceWallet) {
      throw new Error(`Alice's wallet (${walletId}) not found in wallet list`);
    }

    console.log('✅ Alice\'s wallet found in list:');
    console.log(`   Name: ${aliceWallet.name}`);
    console.log(`   ID: ${aliceWallet.id}`);

    if (aliceWallet.id !== walletId) {
      throw new Error(`Wallet ID mismatch! Expected: ${walletId}, Got: ${aliceWallet.id}`);
    }

    console.log('\n✅ TEST 3 PASSED: Wallet ID matches');

    return aliceWallet;

  } catch (error) {
    console.error('\n❌ TEST 3 FAILED:', error.message);
    throw error;
  }
}

/**
 * Test 4: Verify PRISM DID format
 */
function testVerifyPrismDidFormat(prismDid) {
  console.log('\n\n🧪 TEST 4: Verify PRISM DID Format\n');

  try {
    // Check DID format
    if (!prismDid.startsWith('did:prism:')) {
      throw new Error(`Invalid DID prefix. Expected "did:prism:", got: ${prismDid.substring(0, 20)}`);
    }

    // Check minimum length (PRISM DIDs are long)
    if (prismDid.length < 50) {
      throw new Error(`DID too short. Expected >50 chars, got: ${prismDid.length}`);
    }

    console.log(`✅ PRISM DID format valid: ${prismDid.substring(0, 60)}...`);
    console.log(`   Prefix: did:prism:`);
    console.log(`   Length: ${prismDid.length} chars`);

    console.log('\n✅ TEST 4 PASSED: PRISM DID format correct');

  } catch (error) {
    console.error('\n❌ TEST 4 FAILED:', error.message);
    throw error;
  }
}

/**
 * Test 5: Verify API key format
 */
function testVerifyApiKeyFormat(apiKey) {
  console.log('\n\n🧪 TEST 5: Verify API Key Format\n');

  try {
    // Check API key is 64-char hex
    const hexPattern = /^[a-f0-9]{64}$/;

    if (!hexPattern.test(apiKey)) {
      throw new Error(`Invalid API key format. Expected 64-char hex, got: ${apiKey.length} chars`);
    }

    console.log(`✅ API Key format valid: ${apiKey.substring(0, 30)}...`);
    console.log(`   Format: 64-char hex`);
    console.log(`   Length: ${apiKey.length} chars`);

    console.log('\n✅ TEST 5 PASSED: API key format correct');

  } catch (error) {
    console.error('\n❌ TEST 5 FAILED:', error.message);
    throw error;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Employee Wallet Creation Test Suite                 ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Test 1: Create wallet
    const wallet = await testCreateEmployeeWallet();
    testsPassed++;

    // Test 2: List wallets
    const wallets = await testListEmployeeWallets();
    testsPassed++;

    // Test 3: Verify Alice in list
    await testVerifyAliceWallet(wallet.walletId, wallets);
    testsPassed++;

    // Test 4: Verify PRISM DID format
    testVerifyPrismDidFormat(wallet.prismDid);
    testsPassed++;

    // Test 5: Verify API key format
    testVerifyApiKeyFormat(wallet.apiKey);
    testsPassed++;

  } catch (error) {
    testsFailed++;
  }

  // Summary
  console.log('\n\n╔════════════════════════════════════════════════════════╗');
  console.log('║                  TEST SUMMARY                          ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log(`  ✅ Tests Passed: ${testsPassed}`);
  console.log(`  ❌ Tests Failed: ${testsFailed}`);
  console.log(`  📊 Total Tests: ${testsPassed + testsFailed}`);

  if (testsFailed === 0) {
    console.log('\n🎉 ALL TESTS PASSED!\n');
    console.log('Next Steps:');
    console.log('  1. Delete old department wallets from Employee Cloud Agent');
    console.log('  2. Update ServiceConfig issuance to use new wallet creation');
    console.log('  3. Add PRISM DID display to Alice wallet Configuration page');
    console.log('');
    process.exit(0);
  } else {
    console.log('\n❌ SOME TESTS FAILED - Please review errors above\n');
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('\n💥 FATAL ERROR:', error.message);
  process.exit(1);
});
