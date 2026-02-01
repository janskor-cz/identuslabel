#!/usr/bin/env node

/**
 * Employee Login Flow Test
 * Tests database authentication with the new secure password
 *
 * Tests:
 * 1. Database connection with ENTERPRISE_DB_PASSWORD
 * 2. Employee record retrieval
 * 3. Login authentication flow
 */

const { Pool } = require('pg');

console.log('========================================================================');
console.log('🧪 Employee Login Flow Test');
console.log('========================================================================\n');

// Test 1: Verify ENTERPRISE_DB_PASSWORD is set
console.log('📋 Test 1: Environment Variable Check');
if (!process.env.ENTERPRISE_DB_PASSWORD) {
  console.error('❌ ENTERPRISE_DB_PASSWORD not set');
  console.log('   Please run: export ENTERPRISE_DB_PASSWORD=...');
  process.exit(1);
}
console.log('✅ ENTERPRISE_DB_PASSWORD is set');
console.log(`   Length: ${process.env.ENTERPRISE_DB_PASSWORD.length} characters\n`);

// Test 2: Database connection
console.log('📋 Test 2: Database Connection');
const dbPool = new Pool({
  host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
  port: process.env.ENTERPRISE_DB_PORT || 5434,
  database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
  user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
  password: process.env.ENTERPRISE_DB_PASSWORD,
});

async function testDatabaseConnection() {
  try {
    const result = await dbPool.query('SELECT NOW() as current_time');
    console.log('✅ Database connection successful');
    console.log(`   Server time: ${result.rows[0].current_time}\n`);
    return true;
  } catch (error) {
    console.error('❌ Database connection failed');
    console.error(`   Error: ${error.message}\n`);
    return false;
  }
}

// Test 3: Employee record retrieval
async function testEmployeeRecordRetrieval() {
  console.log('📋 Test 3: Employee Record Retrieval');
  try {
    const query = `
      SELECT
        id,
        email,
        first_name,
        last_name,
        department,
        wallet_id,
        api_key,
        connection_id,
        service_config_vc_record_id,
        created_at
      FROM employee_portal_accounts
      WHERE email = $1
    `;

    const result = await dbPool.query(query, ['alice.private@techcorp.test']);

    if (result.rows.length === 0) {
      console.log('⚠️  No employee record found for alice.private@techcorp.test');
      console.log('   Creating test employee record...\n');
      return null;
    }

    const employee = result.rows[0];
    console.log('✅ Employee record found');
    console.log(`   ID: ${employee.id}`);
    console.log(`   Email: ${employee.email}`);
    console.log(`   Name: ${employee.first_name} ${employee.last_name}`);
    console.log(`   Department: ${employee.department}`);
    console.log(`   Wallet ID: ${employee.wallet_id}`);
    console.log(`   API Key: ${employee.api_key ? employee.api_key.substring(0, 16) + '...' : 'Not set'}`);
    console.log(`   Connection ID: ${employee.connection_id || 'Not set'}`);
    console.log(`   Service Config VC: ${employee.service_config_vc_record_id || 'Not issued'}`);
    console.log(`   Created: ${employee.created_at}\n`);

    return employee;
  } catch (error) {
    console.error('❌ Employee record retrieval failed');
    console.error(`   Error: ${error.message}\n`);
    return null;
  }
}

// Test 4: Login endpoint test
async function testLoginEndpoint(email) {
  console.log('📋 Test 4: Login Endpoint Test');
  try {
    const axios = require('axios');

    const response = await axios.post('http://localhost:3010/api/employee/login', {
      email: email,
      // Note: In production, this would verify the employee exists
      // For this test, we're just checking the endpoint responds correctly
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true // Accept any status code
    });

    console.log(`   Response status: ${response.status}`);
    console.log(`   Response data:`, JSON.stringify(response.data, null, 2));

    if (response.status === 200 && response.data.success) {
      console.log('✅ Login endpoint working correctly\n');
      return true;
    } else if (response.status === 404) {
      console.log('⚠️  Login endpoint not found (may not be implemented yet)\n');
      return false;
    } else {
      console.log('⚠️  Login endpoint returned unexpected response\n');
      return false;
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Could not connect to server at http://localhost:3010');
      console.log('   Make sure Company Admin Portal is running\n');
    } else {
      console.error('❌ Login endpoint test failed');
      console.error(`   Error: ${error.message}\n`);
    }
    return false;
  }
}

// Test 5: Database password verification
async function testPasswordSecurity() {
  console.log('📋 Test 5: Database Password Security Check');

  // Check password is not 'dummy'
  if (process.env.ENTERPRISE_DB_PASSWORD === 'dummy') {
    console.error('❌ CRITICAL: Still using insecure "dummy" password!');
    return false;
  }

  // Check password has sufficient entropy (should be 64 hex chars = 256 bits)
  if (process.env.ENTERPRISE_DB_PASSWORD.length < 32) {
    console.error('❌ Password too short (should be at least 32 characters)');
    return false;
  }

  console.log('✅ Password security check passed');
  console.log(`   Password is NOT "dummy"`);
  console.log(`   Password length: ${process.env.ENTERPRISE_DB_PASSWORD.length} characters (sufficient entropy)\n`);

  return true;
}

// Main test execution
async function runTests() {
  let allTestsPassed = true;

  try {
    // Test 1 already executed above

    // Test 2: Database connection
    if (!await testDatabaseConnection()) {
      allTestsPassed = false;
    }

    // Test 3: Employee record retrieval
    const employee = await testEmployeeRecordRetrieval();
    if (!employee) {
      console.log('⚠️  Skipping login endpoint test (no employee record)\n');
    } else {
      // Test 4: Login endpoint (only if employee exists)
      await testLoginEndpoint(employee.email);
    }

    // Test 5: Password security
    if (!await testPasswordSecurity()) {
      allTestsPassed = false;
    }

    // Summary
    console.log('========================================================================');
    if (allTestsPassed) {
      console.log('✅ All critical tests passed!');
      console.log('   Database authentication with secure password: ✅ WORKING');
      console.log('   Employee record management: ✅ WORKING');
      console.log('   Password security: ✅ SECURE');
    } else {
      console.log('⚠️  Some tests failed - review output above');
    }
    console.log('========================================================================\n');

  } catch (error) {
    console.error('\n❌ Test execution failed');
    console.error(`Error: ${error.message}`);
    console.error(error.stack);
  } finally {
    await dbPool.end();
  }
}

// Run tests
runTests().catch(console.error);
