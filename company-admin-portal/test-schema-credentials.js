#!/usr/bin/env node

/**
 * Test Script for Issuing EmployeeRole and CISTrainingCertificate Credentials
 *
 * This script tests the complete flow of issuing credentials using the registered schemas.
 * It simulates issuing both EmployeeRole and CISTrainingCertificate credentials to an employee.
 *
 * Prerequisites:
 * - Schemas must be registered (run register-schemas.js first)
 * - Employee wallet must exist with established DIDComm connection
 *
 * Usage:
 *   node test-schema-credentials.js
 */

const fetch = require('node-fetch');
const { COMPANIES, MULTITENANCY_CLOUD_AGENT_URL } = require('./lib/companies');

// Schema GUIDs from registration
const EMPLOYEE_ROLE_SCHEMA_GUID = '1c7eb9ab-a765-3d3a-88b2-c528ea3f6444';
const CIS_TRAINING_SCHEMA_GUID = 'bc954e49-5cb0-38a8-90a6-4142c0222de3';

// TechCorp configuration
const techCorp = COMPANIES.techcorp;
const CLOUD_AGENT_URL = MULTITENANCY_CLOUD_AGENT_URL;

/**
 * Create a credential offer for EmployeeRole
 */
async function createEmployeeRoleOffer(connectionId, employeeData) {
    const now = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Expire in 1 year

    const credentialOffer = {
        connectionId: connectionId,
        credentialFormat: 'JWT',
        claims: {
            prismDid: employeeData.prismDid || 'did:prism:test123',
            employeeId: employeeData.employeeId || 'alice',
            role: employeeData.role || 'Engineer',
            department: employeeData.department || 'Engineering',
            hireDate: employeeData.hireDate || '2025-01-01',
            effectiveDate: now.toISOString(),
            expiryDate: expiryDate.toISOString()
        },
        schemaId: `${CLOUD_AGENT_URL}/schema-registry/schemas/${EMPLOYEE_ROLE_SCHEMA_GUID}`,
        issuingDID: techCorp.didLongForm,
        automaticIssuance: false
    };

    console.log('\n📝 Creating EmployeeRole credential offer...');
    console.log('   Schema ID:', credentialOffer.schemaId);
    console.log('   Claims:', JSON.stringify(credentialOffer.claims, null, 2));

    try {
        const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': techCorp.apiKey
            },
            body: JSON.stringify(credentialOffer)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create EmployeeRole offer: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ EmployeeRole credential offer created!');
        console.log('   Record ID:', result.recordId);
        console.log('   State:', result.protocolState);

        return result;
    } catch (error) {
        console.error('❌ Error creating EmployeeRole offer:', error.message);
        throw error;
    }
}

/**
 * Create a credential offer for CISTrainingCertificate
 */
async function createCISTrainingOffer(connectionId, trainingData) {
    const now = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Expire in 1 year

    const certificateNumber = `CIS-${Date.now()}-${trainingData.employeeId || 'alice'}`;

    const credentialOffer = {
        connectionId: connectionId,
        credentialFormat: 'JWT',
        claims: {
            prismDid: trainingData.prismDid || 'did:prism:test123',
            employeeId: trainingData.employeeId || 'alice',
            trainingYear: trainingData.trainingYear || '2025',
            completionDate: trainingData.completionDate || now.toISOString(),
            certificateNumber: certificateNumber,
            expiryDate: expiryDate.toISOString()
        },
        schemaId: `${CLOUD_AGENT_URL}/schema-registry/schemas/${CIS_TRAINING_SCHEMA_GUID}`,
        issuingDID: techCorp.didLongForm,
        automaticIssuance: false
    };

    console.log('\n🎓 Creating CISTrainingCertificate credential offer...');
    console.log('   Schema ID:', credentialOffer.schemaId);
    console.log('   Claims:', JSON.stringify(credentialOffer.claims, null, 2));

    try {
        const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': techCorp.apiKey
            },
            body: JSON.stringify(credentialOffer)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create CISTraining offer: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ CISTrainingCertificate credential offer created!');
        console.log('   Record ID:', result.recordId);
        console.log('   State:', result.protocolState);

        return result;
    } catch (error) {
        console.error('❌ Error creating CISTraining offer:', error.message);
        throw error;
    }
}

/**
 * Get active connections
 */
async function getActiveConnections() {
    try {
        const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
            method: 'GET',
            headers: {
                'apikey': techCorp.apiKey
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get connections: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const connections = data.contents || [];

        // Filter for active connections
        const activeConnections = connections.filter(conn =>
            conn.state === 'ConnectionResponseSent' ||
            conn.state === 'ConnectionResponseReceived'
        );

        return activeConnections;
    } catch (error) {
        console.error('Error getting connections:', error);
        throw error;
    }
}

/**
 * Main test function
 */
async function testSchemaCredentials() {
    try {
        console.log('\n=== Schema Credential Issuance Test ===');
        console.log(`Cloud Agent: ${CLOUD_AGENT_URL}`);
        console.log(`Issuer: ${techCorp.displayName} (${techCorp.did})`);

        // Get active connections
        console.log('\n🔍 Getting active connections...');
        const connections = await getActiveConnections();

        if (connections.length === 0) {
            console.log('❌ No active connections found.');
            console.log('   Please establish a DIDComm connection with an employee wallet first.');
            return;
        }

        console.log(`✅ Found ${connections.length} active connections:`);
        connections.forEach((conn, index) => {
            console.log(`   ${index + 1}. ${conn.label || 'Unknown'} - ${conn.connectionId}`);
        });

        // Use the first active connection for testing
        const testConnection = connections[0];
        console.log(`\n📎 Using connection: ${testConnection.label || testConnection.connectionId}`);

        // Test EmployeeRole credential
        const employeeData = {
            prismDid: testConnection.theirDid || 'did:prism:employee123',
            employeeId: 'alice',
            role: 'Senior Engineer',
            department: 'Engineering',
            hireDate: '2024-06-15'
        };

        const employeeRoleOffer = await createEmployeeRoleOffer(testConnection.connectionId, employeeData);

        // Test CISTrainingCertificate credential
        const trainingData = {
            prismDid: testConnection.theirDid || 'did:prism:employee123',
            employeeId: 'alice',
            trainingYear: '2025',
            completionDate: new Date().toISOString()
        };

        const cisTrainingOffer = await createCISTrainingOffer(testConnection.connectionId, trainingData);

        // Summary
        console.log('\n=== Test Summary ===');
        console.log('✅ Successfully created credential offers using registered schemas:');
        console.log(`   1. EmployeeRole: ${employeeRoleOffer.recordId}`);
        console.log(`   2. CISTrainingCertificate: ${cisTrainingOffer.recordId}`);
        console.log('\n📋 Next Steps:');
        console.log('   1. Employee accepts offers in their wallet');
        console.log('   2. Admin approves issuance in Company Admin Portal');
        console.log('   3. Credentials are issued to employee wallet');

        // Check credential states
        console.log('\n⏳ Checking credential states...');

        const checkState = async (recordId, type) => {
            const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records/${recordId}`, {
                headers: { 'apikey': techCorp.apiKey }
            });

            if (response.ok) {
                const record = await response.json();
                console.log(`   ${type}: ${record.protocolState}`);
                return record;
            }
            return null;
        };

        await checkState(employeeRoleOffer.recordId, 'EmployeeRole');
        await checkState(cisTrainingOffer.recordId, 'CISTraining');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Error details:', error);
        process.exit(1);
    }
}

// Execute test
testSchemaCredentials().then(() => {
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
}).catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
});