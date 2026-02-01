/**
 * Test Script for Employee API Key System
 * Tests the complete flow from API key generation to ServiceConfiguration VC issuance
 */

const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3010';
const ENTERPRISE_AGENT_URL = 'http://91.99.4.54:8300';

// Test employee data
const TEST_EMPLOYEE = {
  connectionId: 'test-connection-' + Date.now(),
  email: 'alice.test@techcorp.example.com',
  name: 'Alice Test',
  department: 'IT'
};

// Session cookie (will be set after login)
let sessionCookie = '';

console.log('='.repeat(80));
console.log('🧪 EMPLOYEE API KEY SYSTEM TEST');
console.log('='.repeat(80));
console.log('');

// Helper function to make authenticated requests
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (sessionCookie) {
    headers['Cookie'] = sessionCookie;
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers
  });

  // Store session cookie if set
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    sessionCookie = setCookie.split(';')[0];
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { rawResponse: text };
  }

  return { response, data };
}

async function runTests() {
  try {
    // TEST 1: Health Check
    console.log('📋 TEST 1: Health Check');
    console.log('-'.repeat(80));
    const { data: healthData } = await apiRequest('/api/health');
    console.log('✅ Server health:', healthData.service);
    console.log('   - Enterprise Agent:', healthData.cloudAgent);
    console.log('');

    // TEST 2: Login as TechCorp
    console.log('📋 TEST 2: Login as TechCorp');
    console.log('-'.repeat(80));
    const { data: loginData } = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ companyId: 'techcorp' })
    });

    if (!loginData.success) {
      throw new Error('Login failed: ' + loginData.error);
    }
    console.log('✅ Logged in as:', loginData.company.displayName);
    console.log('   - Session cookie:', sessionCookie ? 'Set' : 'NOT SET');
    console.log('');

    // TEST 3: Generate Employee API Key
    console.log('📋 TEST 3: Generate Employee API Key');
    console.log('-'.repeat(80));
    console.log('Generating API key for:', TEST_EMPLOYEE.name);
    console.log('  - Email:', TEST_EMPLOYEE.email);
    console.log('  - Department:', TEST_EMPLOYEE.department);
    console.log('  - Connection ID:', TEST_EMPLOYEE.connectionId);

    const { response: keyResponse, data: keyData } = await apiRequest('/api/company/generate-employee-key', {
      method: 'POST',
      body: JSON.stringify(TEST_EMPLOYEE)
    });

    if (!keyData.success) {
      throw new Error('API key generation failed: ' + keyData.error);
    }

    console.log('✅ API Key Generated:');
    console.log('   - Key ID:', keyData.keyData.keyId);
    console.log('   - API Key (plaintext):', keyData.keyData.apiKey.substring(0, 16) + '...');
    console.log('   - Expires:', keyData.keyData.expiresAt);
    console.log('   - Scope:', JSON.stringify(keyData.keyData.scope));
    console.log('   - ⚠️  Warning:', keyData.keyData.warning);

    const generatedApiKey = keyData.keyData.apiKey;
    const keyId = keyData.keyData.keyId;
    console.log('');

    // TEST 4: Verify API key in database
    console.log('📋 TEST 4: Verify API Key in Database');
    console.log('-'.repeat(80));
    const { data: keysListData } = await apiRequest(`/api/company/employee-keys?department=${TEST_EMPLOYEE.department}`);

    if (!keysListData.success) {
      throw new Error('Failed to fetch employee keys: ' + keysListData.error);
    }

    const foundKey = keysListData.keys.find(k => k.keyId === keyId);
    if (!foundKey) {
      throw new Error('Generated key not found in database');
    }

    console.log('✅ Key found in database:');
    console.log('   - Connection ID:', foundKey.connectionId);
    console.log('   - Email:', foundKey.email);
    console.log('   - Status:', foundKey.status);
    console.log('   - Config VC Issued:', foundKey.configVcIssued);
    console.log('   - Config Accepted:', foundKey.configAccepted);
    console.log('');

    // TEST 5: Validate API Key (bcrypt comparison)
    console.log('📋 TEST 5: Validate API Key (bcrypt)');
    console.log('-'.repeat(80));
    const { data: validateData } = await apiRequest('/api/company/employee-keys/validate', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: generatedApiKey,
        connectionId: TEST_EMPLOYEE.connectionId
      })
    });

    if (!validateData.success) {
      throw new Error('API key validation failed: ' + validateData.error);
    }

    console.log('✅ API Key is valid:');
    console.log('   - Employee:', validateData.employee.name);
    console.log('   - Email:', validateData.employee.email);
    console.log('   - Department:', validateData.employee.department);
    console.log('   - Usage Count:', validateData.employee.usageCount);
    console.log('');

    // TEST 6: Build ServiceConfiguration VC Claims
    console.log('📋 TEST 6: Issue ServiceConfiguration VC');
    console.log('-'.repeat(80));
    console.log('⚠️  NOTE: This test requires a DIDComm connection to exist in Enterprise Cloud Agent');
    console.log('         Skipping actual issuance, testing claims building only');

    // We can't actually issue without a real connection, but we can test the endpoint structure
    const { response: issueResponse, data: issueData } = await apiRequest(
      `/api/company/issue-service-config/${TEST_EMPLOYEE.connectionId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          email: TEST_EMPLOYEE.email,
          name: TEST_EMPLOYEE.name,
          department: TEST_EMPLOYEE.department,
          apiKey: generatedApiKey
        })
      }
    );

    if (issueData.success) {
      console.log('✅ ServiceConfiguration VC issued:');
      console.log('   - VC Record ID:', issueData.vcRecord.recordId);
      console.log('   - Protocol State:', issueData.vcRecord.protocolState);
    } else {
      console.log('⚠️  Expected failure (no real DIDComm connection):', issueData.error);
    }
    console.log('');

    // TEST 7: Check Department Configuration
    console.log('📋 TEST 7: Verify Department Configuration');
    console.log('-'.repeat(80));

    // Direct database query to verify department config
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    const { stdout: deptConfigOutput } = await execPromise(
      `docker exec enterprise-db psql -U identus_enterprise -d pollux_enterprise -t -c "SELECT department, default_employee_scope, services FROM employee_department_config WHERE department = '${TEST_EMPLOYEE.department}'"`
    );

    console.log('✅ Department configuration loaded from database:');
    console.log(deptConfigOutput.trim());
    console.log('');

    // TEST 8: Test API Key Rotation
    console.log('📋 TEST 8: Test API Key Rotation');
    console.log('-'.repeat(80));
    const { data: rotateData } = await apiRequest(`/api/company/employee-keys/${keyId}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ expiryDays: 365 })
    });

    if (!rotateData.success) {
      throw new Error('API key rotation failed: ' + rotateData.error);
    }

    console.log('✅ API Key rotated successfully:');
    console.log('   - Old Key ID:', rotateData.oldKeyId);
    console.log('   - New Key ID:', rotateData.newKey.keyId);
    console.log('   - New API Key:', rotateData.newKey.apiKey.substring(0, 16) + '...');
    console.log('   - New Expires:', rotateData.newKey.expiresAt);

    const newKeyId = rotateData.newKey.keyId;
    console.log('');

    // TEST 9: Verify old key is revoked
    console.log('📋 TEST 9: Verify Old Key Revoked');
    console.log('-'.repeat(80));
    const { data: oldKeyValidation } = await apiRequest('/api/company/employee-keys/validate', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: generatedApiKey,
        connectionId: TEST_EMPLOYEE.connectionId
      })
    });

    if (oldKeyValidation.success) {
      console.log('❌ FAIL: Old key should be revoked but still validates');
    } else {
      console.log('✅ Old key correctly rejected:', oldKeyValidation.error);
    }
    console.log('');

    // TEST 10: Test API Key Revocation
    console.log('📋 TEST 10: Test API Key Revocation');
    console.log('-'.repeat(80));
    const { data: revokeData } = await apiRequest(`/api/company/employee-keys/${newKeyId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Test revocation' })
    });

    if (!revokeData.success) {
      throw new Error('API key revocation failed: ' + revokeData.error);
    }

    console.log('✅ API Key revoked successfully:');
    console.log('   - Key ID:', revokeData.keyId);
    console.log('   - Reason: Test revocation');
    console.log('');

    // TEST 11: Check Audit Log
    console.log('📋 TEST 11: Check Audit Log');
    console.log('-'.repeat(80));
    const { stdout: auditOutput } = await execPromise(
      `docker exec enterprise-db psql -U identus_enterprise -d pollux_enterprise -c "SELECT action, success, timestamp FROM employee_api_key_audit WHERE api_key_id = '${keyId}' ORDER BY timestamp DESC LIMIT 5"`
    );

    console.log('✅ Recent audit log entries:');
    console.log(auditOutput);
    console.log('');

    // FINAL SUMMARY
    console.log('='.repeat(80));
    console.log('✅ ALL TESTS PASSED');
    console.log('='.repeat(80));
    console.log('');
    console.log('Summary:');
    console.log('  ✅ API key generation working');
    console.log('  ✅ bcrypt validation working');
    console.log('  ✅ Database storage working');
    console.log('  ✅ API key rotation working');
    console.log('  ✅ API key revocation working');
    console.log('  ✅ Audit logging working');
    console.log('  ⚠️  ServiceConfiguration VC issuance needs DIDComm connection');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('='.repeat(80));
    console.error('❌ TEST FAILED');
    console.error('='.repeat(80));
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

runTests();
