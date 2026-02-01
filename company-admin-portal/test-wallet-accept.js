const SDK = require('/root/clean-identus-wallet/sdk-v6-test/sdk-ts/build/index.js');
const fetch = require('node-fetch');

const MEDIATOR_DID = "did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y.Vz6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V.Vz6MkgoLTnTypo3tDRwCkZXSccTPHRLhF4ZnjhueYAFpEX6vg.SeyJ0IjoiZG0iLCJzIjoiaHR0cDovLzkxLjk5LjQuNTQ6ODA4MCIsInIiOltdLCJhIjpbImRpZGNvbW0vdjIiXX0";

async function acceptInvitationAndWait() {
  const invitationUrl = process.argv[2];

  console.log('[Wallet] Initializing SDK...');

  const apollo = new SDK.Apollo();
  const castor = new SDK.Castor(apollo);
  const store = new SDK.Store({ name: 'test-wallet-db' });
  const pluto = new SDK.Pluto(store, apollo);

  await pluto.start();

  const agent = SDK.Agent.initialize({
    apollo,
    castor,
    pluto,
    mediatorDID: SDK.Domain.DID.fromString(MEDIATOR_DID),
    seed: null
  });

  console.log('[Wallet] Starting agent...');
  await agent.start();

  console.log('[Wallet] Accepting invitation...');
  const oobUrl = new URL(invitationUrl);
  const parsed = await agent.parseOOBInvitation(oobUrl);
  await agent.acceptDIDCommInvitation(parsed, "IT Department");

  console.log('[Wallet] ✅ Connection established');

  // Listen for credentials
  let credentialReceived = false;

  agent.addListener(SDK.ListenerKey.MESSAGE, async (messages) => {
    for (const message of messages) {
      console.log('[Wallet] 📨 Message received:', message.piuri);

      if (message.piuri === 'https://didcomm.org/issue-credential/3.0/offer-credential') {
        console.log('[Wallet] 🎫 Credential offer - auto-accepting...');
        const requestMessage = await agent.prepareRequestCredentialWithIssuer(message);
        await agent.sendMessage(requestMessage.makeMessage());
        console.log('[Wallet] ✅ Credential request sent');
      }

      if (message.piuri === 'https://didcomm.org/issue-credential/3.0/issue-credential') {
        console.log('[Wallet] 🎉 Credential issued!');
        const credential = await agent.processIssuedCredentialMessage(message);

        const claims = credential.claims || {};
        if (claims.enterpriseAgent && claims.mediator) {
          console.log('[Wallet] ✅ ServiceConfiguration VC received!');
          console.log('[Wallet] - Employee ID:', claims.employeeId);
          console.log('[Wallet] - Department:', claims.department);
          console.log('[Wallet] - Enterprise Agent URL:', claims.enterpriseAgent?.url);
          console.log('[Wallet] - API Key:', claims.enterpriseAgent?.apiKey?.substring(0, 16) + '...');
          credentialReceived = true;
        }
      }
    }
  });

  console.log('[Wallet] ⏳ Waiting for ServiceConfiguration VC (60 seconds)...');

  // Wait for 60 seconds
  await new Promise(resolve => setTimeout(resolve, 60000));

  if (credentialReceived) {
    console.log('[Wallet] 🎉 SUCCESS - ServiceConfiguration VC received and processed!');
    process.exit(0);
  } else {
    console.log('[Wallet] ⚠️  TIMEOUT - No ServiceConfiguration VC received');
    process.exit(1);
  }
}

acceptInvitationAndWait().catch(error => {
  console.error('[Wallet] ❌ Error:', error.message);
  process.exit(1);
});
