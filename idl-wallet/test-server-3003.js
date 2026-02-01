/**
 * Direct Function Testing Server - Port 3003
 * Purpose: Test peer DID creation and invitation functionality without web interface
 * Uses: SDK v6.6.0 only, same configuration as working wallets
 */

import express from 'express';
import cors from 'cors';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import IndexDB from '@pluto-encrypted/indexdb';
import { sha512 } from '@noble/hashes/sha512';

console.log('🧪 Starting Direct Function Test Server on port 3003...');

const app = express();
app.use(cors());
app.use(express.json());

// Test environment configuration
const TEST_CONFIG = {
  port: 3003,
  walletId: 'test-invitation-wallet',
  mediatorDID: 'did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y.Vz6Mkhh1e5CEYYq6JBUcTZ6Cp2ranCWRrv7Yax3Le4N59R6dd.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly85MS45OS40LjU0OjgwODAiLCJhIjpbImRpZGNvbW0vdjIiXX19.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6IndzOi8vOTEuOTkuNC41NDo4MDgwL3dzIiwiYSI6WyJkaWRjb21tL3YyIl19fQ'
};

// Global agent instance for testing
let testAgent = null;
let testPluto = null;

/**
 * Initialize test agent exactly like working wallets (ports 3001/3002)
 */
async function initializeTestAgent() {
  console.log('🔧 Initializing test agent with SDK v6.6.0...');

  try {
    // Step 1: Create Apollo instance
    const apollo = new SDK.Apollo();

    // Step 2: Create database configuration (same as working wallets)
    const passwordKey = `${TEST_CONFIG.walletId}-database-key`;
    const randomSeed = apollo.createRandomSeed();
    const passwordBuffer = new Uint8Array(randomSeed.seed);
    const hashedPassword = sha512(passwordBuffer);
    const password = Buffer.from(hashedPassword).toString('hex');

    console.log(`📦 Database: identus-wallet-${TEST_CONFIG.walletId}`);

    // Step 3: Initialize IndexedDB store (same as working wallets)
    const store = new SDK.Store({
      name: `identus-wallet-${TEST_CONFIG.walletId}`,
      storage: IndexDB,
      password: password
    });
    const pluto = new SDK.Pluto(store, apollo);
    testPluto = pluto;

    // Step 4: Create Castor with same resolvers as working wallets
    const castor = new SDK.Castor(apollo, []);

    // Step 5: Create mediator DID (same as working wallets)
    const mediatorDID = SDK.Domain.DID.fromString(TEST_CONFIG.mediatorDID);
    console.log(`🔗 Mediator DID: ${mediatorDID.toString().substring(0, 60)}...`);

    // Step 6: Create seed (same pattern as working wallets)
    const defaultSeed = apollo.createRandomSeed();
    console.log('🌱 Random seed created for test agent');

    // Step 7: Initialize agent exactly like working wallets
    testAgent = await SDK.Agent.initialize({
      apollo,
      castor,
      mediatorDID,
      pluto,
      seed: defaultSeed
    });

    console.log('✅ Test agent initialized successfully');

    // Step 8: Start the agent
    await testAgent.start();
    console.log('🚀 Test agent started and ready for testing');

    return testAgent;

  } catch (error) {
    console.error('❌ Failed to initialize test agent:', error);
    throw error;
  }
}

/**
 * Analyze peer DID creation and service endpoints
 */
async function analyzePeerDID() {
  console.log('\n🔍 PEER DID ANALYSIS STARTING...');

  if (!testAgent) {
    throw new Error('Test agent not initialized');
  }

  const results = {
    tests: [],
    summary: {}
  };

  try {
    // Test 1: Default peer DID creation
    console.log('\n📝 Test 1: Default peer DID creation');
    const defaultPeerDID = await testAgent.createNewPeerDID();
    console.log(`✅ Default peer DID: ${defaultPeerDID.toString().substring(0, 60)}...`);

    // Resolve and examine default DID
    const defaultDIDDoc = await testAgent.castor.resolveDID(defaultPeerDID.toString());
    console.log(`📄 Default DID services: ${defaultDIDDoc.services?.length || 0}`);

    if (defaultDIDDoc.services && defaultDIDDoc.services.length > 0) {
      defaultDIDDoc.services.forEach((service, i) => {
        console.log(`   Service ${i + 1}:`);
        console.log(`     ID: ${service.id}`);
        console.log(`     Type: ${service.type}`);
        console.log(`     Endpoint: ${service.serviceEndpoint?.uri || service.serviceEndpoint}`);
        console.log(`     Accept: ${service.serviceEndpoint?.accept?.join(', ') || 'N/A'}`);
        console.log(`     Routing Keys: ${service.serviceEndpoint?.routingKeys?.length || 0}`);
      });
    }

    results.tests.push({
      test: 'Default peer DID creation',
      did: defaultPeerDID.toString(),
      servicesCount: defaultDIDDoc.services?.length || 0,
      services: defaultDIDDoc.services || []
    });

    // Test 2: Peer DID with services parameter (true)
    console.log('\n📝 Test 2: Peer DID with services=true');
    const servicesPeerDID = await testAgent.createNewPeerDID([], true);
    console.log(`✅ Services peer DID: ${servicesPeerDID.toString().substring(0, 60)}...`);

    // Resolve and examine services DID
    const servicesDIDDoc = await testAgent.castor.resolveDID(servicesPeerDID.toString());
    console.log(`📄 Services DID services: ${servicesDIDDoc.services?.length || 0}`);

    if (servicesDIDDoc.services && servicesDIDDoc.services.length > 0) {
      servicesDIDDoc.services.forEach((service, i) => {
        console.log(`   Service ${i + 1}:`);
        console.log(`     ID: ${service.id}`);
        console.log(`     Type: ${service.type}`);
        console.log(`     Endpoint: ${service.serviceEndpoint?.uri || service.serviceEndpoint}`);
        console.log(`     Accept: ${service.serviceEndpoint?.accept?.join(', ') || 'N/A'}`);
        console.log(`     Routing Keys: ${service.serviceEndpoint?.routingKeys?.length || 0}`);
      });
    }

    results.tests.push({
      test: 'Peer DID with services=true',
      did: servicesPeerDID.toString(),
      servicesCount: servicesDIDDoc.services?.length || 0,
      services: servicesDIDDoc.services || []
    });

    // Test 3: Peer DID with services parameter (false)
    console.log('\n📝 Test 3: Peer DID with services=false');
    const noServicesPeerDID = await testAgent.createNewPeerDID([], false);
    console.log(`✅ No services peer DID: ${noServicesPeerDID.toString().substring(0, 60)}...`);

    // Resolve and examine no-services DID
    const noServicesDIDDoc = await testAgent.castor.resolveDID(noServicesPeerDID.toString());
    console.log(`📄 No services DID services: ${noServicesDIDDoc.services?.length || 0}`);

    results.tests.push({
      test: 'Peer DID with services=false',
      did: noServicesPeerDID.toString(),
      servicesCount: noServicesDIDDoc.services?.length || 0,
      services: noServicesDIDDoc.services || []
    });

    // Analysis summary
    console.log('\n📊 ANALYSIS SUMMARY:');
    const hasMediator = results.tests.some(test =>
      test.services.some(service =>
        service.serviceEndpoint?.uri?.includes('91.99.4.54:8080') ||
        service.serviceEndpoint?.toString().includes('91.99.4.54:8080')
      )
    );

    console.log(`🔗 Mediator service found: ${hasMediator ? '✅ YES' : '❌ NO'}`);
    console.log(`📝 Best candidate for well-known DID: ${hasMediator ? 'Services=true peer DID' : 'Need manual service creation'}`);

    results.summary = {
      hasMediatorService: hasMediator,
      recommendedApproach: hasMediator ? 'use-services-true-peer-did' : 'manual-service-creation',
      totalTests: results.tests.length
    };

    console.log('✅ Peer DID analysis completed');
    return results;

  } catch (error) {
    console.error('❌ Peer DID analysis failed:', error);
    throw error;
  }
}

/**
 * Test manual invitation creation using SDK v6.6.0 components
 */
async function createTestInvitation(label = 'Test Invitation') {
  console.log(`\n📨 CREATING INVITATION: "${label}"`);

  if (!testAgent) {
    throw new Error('Test agent not initialized');
  }

  try {
    // Step 1: Create well-known DID (use services=true based on analysis)
    console.log('🔑 Creating well-known DID for invitation...');
    const wellKnownDID = await testAgent.createNewPeerDID([], true);
    console.log(`✅ Well-known DID: ${wellKnownDID.toString().substring(0, 60)}...`);

    // Step 2: Validate well-known DID has proper service endpoints
    console.log('🔍 Validating well-known DID service endpoints...');
    const didDoc = await testAgent.castor.resolveDID(wellKnownDID.toString());
    console.log(`📄 Services found: ${didDoc.services?.length || 0}`);

    if (didDoc.services && didDoc.services.length > 0) {
      didDoc.services.forEach((service, i) => {
        console.log(`   Service ${i + 1}: ${service.id} -> ${service.serviceEndpoint?.uri || service.serviceEndpoint}`);
      });
    }

    // Step 3: Create OutOfBandInvitation object using SDK v6.6.0
    console.log('📋 Creating OutOfBandInvitation object...');
    const invitationBody = {
      accept: ["didcomm/v2"],
      goal_code: "connect",
      goal: `Connect with ${label}`,
      label: label
    };

    const invitation = new SDK.OutOfBandInvitation(
      invitationBody,
      wellKnownDID.toString()
    );

    console.log('✅ OutOfBandInvitation object created');
    console.log(`   ID: ${invitation.id}`);
    console.log(`   Type: ${invitation.type}`);
    console.log(`   From: ${invitation.from.substring(0, 60)}...`);
    console.log(`   Label: ${invitation.body.label}`);

    // Step 4: Encode invitation to URL format
    console.log('🔗 Encoding invitation to URL format...');
    const invitationJson = JSON.stringify({
      id: invitation.id,
      type: invitation.type,
      from: invitation.from,
      body: invitation.body
    });

    const base64Invitation = Buffer.from(invitationJson).toString('base64url');
    const invitationUrl = `https://example.com/invitation?_oob=${base64Invitation}`;

    console.log('✅ Invitation URL created');
    console.log(`   Base64 length: ${base64Invitation.length} characters`);
    console.log(`   URL: ${invitationUrl.substring(0, 100)}...`);

    const result = {
      invitation: {
        id: invitation.id,
        type: invitation.type,
        from: invitation.from,
        body: invitation.body
      },
      wellKnownDID: wellKnownDID.toString(),
      invitationUrl,
      base64Invitation,
      didDocument: didDoc
    };

    console.log('🎉 Invitation creation completed successfully!');
    return result;

  } catch (error) {
    console.error('❌ Invitation creation failed:', error);
    throw error;
  }
}

// REST API Endpoints for testing

app.get('/test/status', (req, res) => {
  res.json({
    server: 'Direct Function Test Server',
    port: TEST_CONFIG.port,
    agent: testAgent ? 'initialized' : 'not initialized',
    timestamp: new Date().toISOString()
  });
});

app.post('/test/init-agent', async (req, res) => {
  try {
    if (testAgent) {
      return res.json({ message: 'Agent already initialized', status: 'ready' });
    }

    await initializeTestAgent();
    res.json({ message: 'Agent initialized successfully', status: 'ready' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test/peer-did-analysis', async (req, res) => {
  try {
    if (!testAgent) {
      return res.status(400).json({ error: 'Agent not initialized' });
    }

    const results = await analyzePeerDID();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/test/create-invitation', async (req, res) => {
  try {
    if (!testAgent) {
      return res.status(400).json({ error: 'Agent not initialized' });
    }

    const { label } = req.body;
    const result = await createTestInvitation(label || 'Test Invitation');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test/connections', async (req, res) => {
  try {
    if (!testAgent) {
      return res.status(400).json({ error: 'Agent not initialized' });
    }

    const connections = await testPluto.getAllDidPairs();
    res.json({
      count: connections.length,
      connections: connections.map(conn => ({
        host: conn.host?.toString(),
        receiver: conn.receiver?.toString(),
        name: conn.name
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the test server
const server = app.listen(TEST_CONFIG.port, '0.0.0.0', () => {
  console.log(`🚀 Direct Function Test Server running on http://0.0.0.0:${TEST_CONFIG.port}`);
  console.log('📋 Available endpoints:');
  console.log('   GET  /test/status              - Server status');
  console.log('   POST /test/init-agent          - Initialize test agent');
  console.log('   GET  /test/peer-did-analysis   - Analyze peer DID creation');
  console.log('   POST /test/create-invitation   - Create invitation (body: {label})');
  console.log('   GET  /test/connections         - List stored connections');
  console.log('\n🔧 To start testing:');
  console.log('   1. curl -X POST http://91.99.4.54:3003/test/init-agent');
  console.log('   2. curl http://91.99.4.54:3003/test/peer-did-analysis');
  console.log('   3. curl -X POST http://91.99.4.54:3003/test/create-invitation -H "Content-Type: application/json" -d \'{"label": "My Test Invitation"}\'');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down test server...');

  if (testAgent) {
    try {
      await testAgent.stop();
      console.log('✅ Test agent stopped');
    } catch (error) {
      console.log('⚠️ Error stopping agent:', error.message);
    }
  }

  server.close(() => {
    console.log('✅ Test server stopped');
    process.exit(0);
  });
});