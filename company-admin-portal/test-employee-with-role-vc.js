/**
 * Test Employee Onboarding with EmployeeRole VC
 *
 * Tests the complete 12-step employee onboarding workflow:
 * 1. Create wallet
 * 2. Create entity
 * 3. Register API key
 * 4. Create PRISM DID
 * 5. Publish to blockchain
 * 6. Wait for publication
 * 7. Create TechCorp invitation
 * 8. Accept invitation
 * 9. Wait employee connection
 * 10. Wait TechCorp connection
 * 11. Connection established
 * 12. Issue EmployeeRole VC
 */

const { createEmployeeWallet } = require('./lib/EmployeeWalletManager');

async function testEmployeeOnboardingWithRoleVC() {
  console.log('\n🚀 Testing Employee Onboarding with EmployeeRole VC (12 steps)...\n');

  try {
    // Generate unique email for testing
    const timestamp = Date.now();
    const testEmployee = {
      email: `test.employee.${timestamp}@techcorp.com`,
      name: `Test Employee ${timestamp}`,
      department: 'Engineering',
      role: 'Senior Engineer'  // This will be used in the EmployeeRole VC
    };

    console.log('📋 Employee Details:');
    console.log(`  Email: ${testEmployee.email}`);
    console.log(`  Name: ${testEmployee.name}`);
    console.log(`  Department: ${testEmployee.department}`);
    console.log(`  Role: ${testEmployee.role}`);
    console.log('\nStarting onboarding process...\n');

    // Run the complete 12-step workflow
    const startTime = Date.now();
    const result = await createEmployeeWallet(testEmployee);
    const endTime = Date.now();

    // Display results
    console.log('\n✅ Employee Onboarding Complete!\n');
    console.log('📊 Results:');
    console.log('──────────────────────────────────────────────');
    console.log(`Wallet ID:         ${result.walletId}`);
    console.log(`Entity ID:         ${result.entityId}`);
    console.log(`PRISM DID (Long):  ${result.prismDid.substring(0, 60)}...`);
    console.log(`PRISM DID (Canon): ${result.canonicalDid}`);
    console.log(`API Key:           ${result.apiKey.substring(0, 20)}... (SAVE THIS!)`);
    console.log('──────────────────────────────────────────────');
    console.log('DIDComm Connections:');
    console.log(`  TechCorp → Employee: ${result.techCorpConnectionId}`);
    console.log(`  Employee → TechCorp: ${result.employeeConnectionId}`);
    console.log('──────────────────────────────────────────────');
    console.log('Verifiable Credential:');
    console.log(`  EmployeeRole VC ID: ${result.employeeRoleCredentialId}`);
    console.log('──────────────────────────────────────────────');
    console.log(`\n⏱️  Total time: ${((endTime - startTime) / 1000).toFixed(1)} seconds`);

    // Verify the credential was issued
    if (result.employeeRoleCredentialId) {
      console.log('\n🎉 SUCCESS: Employee has been onboarded with EmployeeRole VC!');
      console.log('\nThe employee now has:');
      console.log('  ✓ Personal wallet in Enterprise Cloud Agent');
      console.log('  ✓ PRISM DID published to blockchain');
      console.log('  ✓ Bidirectional connection with TechCorp');
      console.log('  ✓ EmployeeRole VC with their role and department');
    } else {
      console.error('\n⚠️  WARNING: EmployeeRole VC was not issued!');
    }

    // Return result for further testing
    return result;

  } catch (error) {
    console.error('\n❌ Employee onboarding failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run test if executed directly
if (require.main === module) {
  testEmployeeOnboardingWithRoleVC()
    .then(() => {
      console.log('\n✅ Test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    });
}

module.exports = testEmployeeOnboardingWithRoleVC;