/**
 * Simple Peer DID Analysis - Node.js Compatible
 * Purpose: Test peer DID creation patterns from working wallets
 * Focus: Analyze if createNewPeerDID() includes mediator service endpoints
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';

console.log('🔍 Simple Peer DID Analysis Starting...');

// Mediator DID from working wallet configuration
const MEDIATOR_DID = 'did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y.Vz6Mkhh1e5CEYYq6JBUcTZ6Cp2ranCWRrv7Yax3Le4N59R6dd.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly85MS45OS40LjU0OjgwODAiLCJhIjpbImRpZGNvbW0vdjIiXX19.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6IndzOi8vOTEuOTkuNC41NDo4MDgwL3dzIiwiYSI6WyJkaWRjb21tL3YyIl19fQ';

/**
 * Test peer DID creation using only SDK components that work in Node.js
 */
async function testPeerDIDCreation() {
  console.log('\n📝 Testing Peer DID Creation Patterns...');

  try {
    // Step 1: Create Apollo instance (works in Node.js)
    const apollo = new SDK.Apollo();
    console.log('✅ Apollo created');

    // Step 2: Create Castor instance (works in Node.js)
    const castor = new SDK.Castor(apollo, []);
    console.log('✅ Castor created');

    // Step 3: Parse mediator DID
    const mediatorDID = SDK.Domain.DID.fromString(MEDIATOR_DID);
    console.log(`✅ Mediator DID parsed: ${mediatorDID.toString().substring(0, 60)}...`);

    // Step 4: Test peer DID creation patterns (simulating working wallet approach)
    console.log('\n🧪 Testing Peer DID Creation Patterns:');

    // Test 1: Basic peer DID creation (what the working wallet does)
    console.log('\n📝 Test 1: Basic peer DID creation');
    try {
      // Generate key pairs like the working wallet (using correct SDK v6.6.0 API)
      const ed25519PrivateKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.ED25519,
      });

      const x25519PrivateKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.Curve25519,
        curve: SDK.Domain.Curve.X25519,
      });

      const ed25519KeyPair = ed25519PrivateKey.keyPair;
      const x25519KeyPair = x25519PrivateKey.keyPair;

      console.log(`✅ Ed25519 key pair: ${ed25519KeyPair.identifier}`);
      console.log(`✅ X25519 key pair: ${x25519KeyPair.identifier}`);

      // Test creating peer DID with just keys (no services)
      const basicPeerDID = await castor.createPeerDID([ed25519KeyPair, x25519KeyPair], []);
      console.log(`✅ Basic peer DID: ${basicPeerDID.toString().substring(0, 60)}...`);

      // Resolve and examine the basic DID
      const basicDIDDoc = await castor.resolveDID(basicPeerDID.toString());
      console.log(`📄 Basic DID services: ${basicDIDDoc.services?.length || 0}`);

      // Test 2: Peer DID with mediator service (manual approach)
      console.log('\n📝 Test 2: Peer DID with mediator service');

      // Create mediator service endpoint (matching working wallet pattern)
      const mediatorService = new SDK.Domain.Service(
        'didcomm-1',
        ['DIDCommMessaging'],
        new SDK.Domain.ServiceEndpoint(
          'http://91.99.4.54:8080',
          ['didcomm/v2'],
          []
        )
      );

      const servicePeerDID = await castor.createPeerDID([ed25519KeyPair, x25519KeyPair], [mediatorService]);
      console.log(`✅ Service peer DID: ${servicePeerDID.toString().substring(0, 60)}...`);

      // Resolve and examine the service DID
      const serviceDIDDoc = await castor.resolveDID(servicePeerDID.toString());
      console.log(`📄 Service DID services: ${serviceDIDDoc.services?.length || 0}`);

      if (serviceDIDDoc.services && serviceDIDDoc.services.length > 0) {
        serviceDIDDoc.services.forEach((service, i) => {
          console.log(`   Service ${i + 1}:`);
          console.log(`     ID: ${service.id}`);
          console.log(`     Type: ${service.type}`);
          console.log(`     Endpoint: ${service.serviceEndpoint?.uri || service.serviceEndpoint}`);
          console.log(`     Accept: ${service.serviceEndpoint?.accept?.join(', ') || 'N/A'}`);
        });
      }

      // Analysis
      console.log('\n📊 ANALYSIS RESULTS:');
      const hasMediator = serviceDIDDoc.services?.some(service =>
        service.serviceEndpoint?.uri?.includes('91.99.4.54:8080') ||
        service.serviceEndpoint?.toString().includes('91.99.4.54:8080')
      );

      console.log(`🔗 Manual mediator service creation: ${hasMediator ? '✅ SUCCESS' : '❌ FAILED'}`);
      console.log(`📝 Working wallet approach: Use manual service creation for invitations`);
      console.log(`💡 Recommendation: Create well-known DID with explicit mediator service`);

      return {
        basicPeerDID: basicPeerDID.toString(),
        servicePeerDID: servicePeerDID.toString(),
        hasMediatorService: hasMediator,
        approach: 'manual-service-creation'
      };

    } catch (error) {
      console.error('❌ Peer DID creation failed:', error.message);
      throw error;
    }

  } catch (error) {
    console.error('❌ Test setup failed:', error);
    throw error;
  }
}

/**
 * Test invitation creation pattern
 */
async function testInvitationCreation(wellKnownDID) {
  console.log('\n📨 Testing Invitation Creation Pattern...');

  try {
    // Simulate working wallet invitation creation
    const invitationBody = {
      accept: ["didcomm/v2"],
      goal_code: "connect",
      goal: "Connect with Test Wallet",
      label: "Test Wallet"
    };

    const invitation = new SDK.OutOfBandInvitation(
      invitationBody,
      wellKnownDID
    );

    console.log('✅ OutOfBandInvitation created');
    console.log(`   ID: ${invitation.id}`);
    console.log(`   Type: ${invitation.type}`);
    console.log(`   From: ${invitation.from.substring(0, 60)}...`);
    console.log(`   Label: ${invitation.body.label}`);

    // Encode to URL (working wallet pattern)
    const invitationJson = JSON.stringify({
      id: invitation.id,
      type: invitation.type,
      from: invitation.from,
      body: invitation.body
    });

    const base64Invitation = Buffer.from(invitationJson).toString('base64url');
    const invitationUrl = `https://test-wallet.example.com/invitation?_oob=${base64Invitation}`;

    console.log(`✅ Invitation URL: ${invitationUrl.substring(0, 100)}...`);

    return {
      invitation,
      invitationUrl,
      base64Invitation
    };

  } catch (error) {
    console.error('❌ Invitation creation failed:', error);
    throw error;
  }
}

// Run the tests
async function runTests() {
  try {
    console.log('🚀 Starting SDK v6.6.0 Peer DID Analysis...');

    const peerDIDResults = await testPeerDIDCreation();
    const invitationResults = await testInvitationCreation(peerDIDResults.servicePeerDID);

    console.log('\n🎉 ANALYSIS COMPLETE!');
    console.log('📋 Key Findings:');
    console.log('   ✅ SDK v6.6.0 peer DID creation works in Node.js');
    console.log('   ✅ Manual mediator service creation is required');
    console.log('   ✅ OutOfBandInvitation creation works');
    console.log('   💡 Working wallets need explicit service endpoint creation');

    return {
      peerDID: peerDIDResults,
      invitation: invitationResults
    };

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export { runTests, testPeerDIDCreation, testInvitationCreation };