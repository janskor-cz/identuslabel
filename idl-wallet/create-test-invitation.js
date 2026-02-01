/**
 * Manual Test Invitation Creator
 * Creates a properly formatted OOB invitation for testing
 */

// Create a manual test invitation following SDK v6.6.0 format
function createTestInvitation() {
  const testInvitation = {
    id: "test-invitation-" + Date.now(),
    type: "https://didcomm.org/out-of-band/2.0/invitation",
    from: "did:peer:2.Ez6LSms555YhFthn1WV8ciDBpZm86hK9tp83WojJUmxPGk1hZ.Vz6MkmdBjMyB4TS5UbbQw54szm8yvMMf1ftGV2sQVYAxaeWhE.SeyJpZCI6Im5ldy1pZCIsInQiOiJkbSIsInMiOiJodHRwOi8vOTEuOTkuNC41NDo4MDgwIiwiYSI6WyJkaWRjb21tL3YyIl19",
    body: {
      accept: ["didcomm/v2"],
      goal_code: "connect",
      goal: "Connect with Test Server on Port 3003",
      label: "Test Server 3003"
    }
  };

  // Encode to base64url format
  const invitationJson = JSON.stringify(testInvitation);
  const base64Invitation = Buffer.from(invitationJson).toString('base64url');
  const invitationUrl = `https://test-server-3003.example.com/invitation?_oob=${base64Invitation}`;

  return {
    invitation: testInvitation,
    invitationUrl,
    base64Invitation
  };
}

// Create and display the invitation
const result = createTestInvitation();

console.log('🎉 Test Invitation Created for Port 3003 Simulation!');
console.log('');
console.log('📋 Invitation Details:');
console.log(`   ID: ${result.invitation.id}`);
console.log(`   Type: ${result.invitation.type}`);
console.log(`   From DID: ${result.invitation.from.substring(0, 60)}...`);
console.log(`   Label: ${result.invitation.body.label}`);
console.log('');
console.log('🔗 Invitation URL (Copy this for testing):');
console.log('========================================');
console.log(result.invitationUrl);
console.log('========================================');
console.log('');
console.log('📝 Instructions for testing:');
console.log('1. Copy the invitation URL above');
console.log('2. Open Alice wallet: http://91.99.4.54:3001');
console.log('3. Connect database and start agent');
console.log('4. Go to Connections page');
console.log('5. Click "📥 Accept Invitation" tab');
console.log('6. Paste the invitation URL');
console.log('7. Enter connection name: "Test Server 3003"');
console.log('8. Click "🚀 Accept Invitation"');
console.log('');
console.log('✅ This tests the enhanced OOB invitation acceptance functionality!');