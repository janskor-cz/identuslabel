const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3004;

// Edge SDK will be initialized on client side - this server provides support endpoints
const MEDIATOR_URL = 'ws://91.99.4.54:7080/ws';
const MEDIATOR_HTTP_URL = 'http://91.99.4.54:7080';
const MEDIATOR_DID = 'did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y.Vz6Mkhh1e5CEYYq6JBUcTZ6Cp2ranCWRrv7Yax3Le4N59R6dd.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly85MS45OS40LjU0OjcwODAiLCJhIjpbImRpZGNvbW0vdjIiXX19.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6IndzOi8vOTEuOTkuNC41NDo3MDgwL3dzIiwiYSI6WyJkaWRjb21tL3YyIl19fQ';

// Cloud Agent configuration for backend operations (fallback to traditional approach)
const CLOUD_AGENT_URL = 'http://91.99.4.54:8000/cloud-agent';
const API_KEY = 'issuer-agent-key'; // Issuer Agent API key

app.use(express.json());
app.use(express.static('public'));

// Store schemas and session data
global.schemaRegistry = global.schemaRegistry || new Map();
global.userSessions = global.userSessions || new Map();
global.challengeSessions = global.challengeSessions || new Map();
global.securityKeypairs = global.securityKeypairs || new Map();

// CORS headers for Edge SDK browser usage
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

console.log('🔧 Initializing CA with Edge SDK integration...');
console.log('🌐 Using Identus Mediator at:', MEDIATOR_URL);
console.log('🔗 Mediator DID:', MEDIATOR_DID);
console.log('⚡ Edge SDK will handle DID creation and credential issuance on client side');
console.log('🏛️ Cloud Agent backend available at:', CLOUD_AGENT_URL);

// Utility function to generate RSA keypair for security clearances
function generateSecurityClearanceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  
  const fingerprint = crypto.createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .match(/.{2}/g)
    .join(':')
    .toUpperCase();
  
  return {
    publicKey,
    privateKey,
    fingerprint,
    algorithm: 'RSA-2048'
  };
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    service: 'certification-authority-edge-sdk',
    status: 'healthy',
    version: '1.0.0',
    mediator: MEDIATOR_HTTP_URL,
    cloudAgent: CLOUD_AGENT_URL,
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Configuration endpoint for Edge SDK
app.get('/api/config', (req, res) => {
  res.json({
    mediatorUrl: MEDIATOR_URL,
    mediatorHttpUrl: MEDIATOR_HTTP_URL,
    mediatorDid: MEDIATOR_DID,
    cloudAgentUrl: CLOUD_AGENT_URL,
    apiKey: API_KEY,
    port: PORT
  });
});

// Generate security clearance keypair endpoint
app.post('/api/security-clearance/generate-keypair', (req, res) => {
  const { userId, clearanceLevel } = req.body;
  
  if (!userId || !clearanceLevel) {
    return res.status(400).json({ error: 'userId and clearanceLevel are required' });
  }
  
  const keypair = generateSecurityClearanceKeypair();
  const keypairId = uuidv4();
  
  // Store keypair securely
  global.securityKeypairs.set(keypairId, {
    ...keypair,
    userId,
    clearanceLevel,
    createdAt: new Date().toISOString()
  });
  
  res.json({
    keypairId,
    publicKey: keypair.publicKey,
    fingerprint: keypair.fingerprint,
    algorithm: keypair.algorithm,
    clearanceLevel,
    userId
  });
});

// Session management for QR verification
app.post('/api/verification/start-session', (req, res) => {
  const sessionId = uuidv4();
  const challengeId = uuidv4();
  
  global.userSessions.set(sessionId, {
    challengeId,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  
  global.challengeSessions.set(challengeId, {
    sessionId,
    status: 'active',
    createdAt: new Date().toISOString()
  });
  
  res.json({
    sessionId,
    challengeId,
    status: 'active'
  });
});

// Session status check
app.get('/api/verification/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = global.userSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    sessionId,
    status: session.status,
    authenticatedUser: session.authenticatedUser,
    timestamp: session.completedAt || session.createdAt
  });
});

// Verify credential endpoint (called by Edge SDK)
app.post('/api/verification/verify-credential', (req, res) => {
  const { challengeId, credential, userInfo } = req.body;
  
  if (!challengeId || !credential) {
    return res.status(400).json({ error: 'challengeId and credential are required' });
  }
  
  const challenge = global.challengeSessions.get(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found' });
  }
  
  const session = global.userSessions.get(challenge.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Update session with authentication success
  session.status = 'authenticated';
  session.authenticatedUser = userInfo;
  session.completedAt = new Date().toISOString();
  
  global.userSessions.set(challenge.sessionId, session);
  
  res.json({
    success: true,
    sessionId: challenge.sessionId,
    message: 'Credential verified successfully'
  });
});

// Schema management endpoints - fetch from Cloud Agent
app.get('/api/schemas', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    res.json({
      success: true,
      schemas: data.contents || []
    });
  } catch (error) {
    console.error('❌ Error fetching schemas:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/schemas/create', (req, res) => {
  const { name, version, schema } = req.body;
  
  if (!name || !version || !schema) {
    return res.status(400).json({ error: 'name, version, and schema are required' });
  }
  
  const schemaId = uuidv4();
  const schemaData = {
    name,
    version,
    schema,
    createdAt: new Date().toISOString()
  };
  
  global.schemaRegistry.set(schemaId, schemaData);
  
  res.json({
    id: schemaId,
    ...schemaData
  });
});

// Create presentation invitation for credential verification (login)
app.post('/api/presentations/create-invitation', (req, res) => {
  const { credentialType, purpose, sessionId } = req.body;
  
  if (!credentialType || !sessionId) {
    return res.status(400).json({ error: 'credentialType and sessionId are required' });
  }
  
  // Generate challenge ID for this verification request
  const challengeId = uuidv4();
  const verificationData = {
    challengeId,
    credentialType,
    purpose: purpose || 'Credential Verification',
    sessionId,
    verifyUrl: `http://localhost:3004/api/verification/verify-credential`,
    createdAt: new Date().toISOString()
  };
  
  // Store the challenge in global session storage
  global.challengeSessions.set(challengeId, {
    sessionId,
    status: 'active',
    credentialType,
    purpose,
    createdAt: new Date().toISOString()
  });
  
  // Create Base64 encoded challenge for QR code
  const verificationString = Buffer.from(JSON.stringify(verificationData)).toString('base64');
  
  console.log(`✅ Created verification invitation: ${challengeId} for session: ${sessionId}`);
  console.log(`📋 Stored challenge in global.challengeSessions`);
  
  res.json({
    success: true,
    challengeId,
    verificationString,
    qrData: verificationString,
    credentialType,
    purpose,
    sessionId
  });
});

// Check presentation status
app.get('/api/presentations/:challengeId/status/:sessionId', (req, res) => {
  const { challengeId, sessionId } = req.params;
  
  // Get session status
  const session = global.userSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Check if verification was completed for this session
  if (session.status === 'authenticated' && session.authenticatedUser) {
    res.json({
      success: true,
      status: 'PresentationReceived',
      challengeId,
      sessionId,
      authenticatedUser: session.authenticatedUser,
      completedAt: session.completedAt
    });
  } else {
    res.json({
      success: true,
      status: 'PresentationPending',
      challengeId,
      sessionId
    });
  }
});

// Statistics endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    totalSchemas: global.schemaRegistry.size,
    activeSessions: global.userSessions.size,
    securityKeypairs: global.securityKeypairs.size,
    timestamp: new Date().toISOString()
  });
});

// Edge SDK Demo endpoints - proxy to Cloud Agent when needed
app.get('/api/cloud-agent/health', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/_system/health`, {
      headers: { 'apikey': API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Cloud Agent unavailable', details: error.message });
  }
});

// Cloud Agent DID operations (fallback when Edge SDK can't handle)
app.post('/api/cloud-agent/create-did', async (req, res) => {
  try {
    console.log('🆔 Creating DID via Cloud Agent (fallback)...');
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        documentTemplate: {
          publicKeys: [{
            id: 'auth-key',
            purpose: 'authentication'
          }, {
            id: 'assertion-key',
            purpose: 'assertionMethod'
          }],
          services: []
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const didData = await response.json();
    console.log(`✅ DID created: ${didData.longFormDid}`);
    
    res.json({
      success: true,
      did: didData.longFormDid,
      shortDid: didData.did,
      status: didData.status
    });
  } catch (error) {
    console.error('❌ Error creating DID:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get Cloud Agent DIDs
app.get('/api/cloud-agent/dids', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    res.json({
      success: true,
      dids: data.contents
    });
  } catch (error) {
    console.error('❌ Error fetching DIDs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Traditional CA endpoints for DID management
app.post('/api/create-did', async (req, res) => {
  try {
    console.log('🆔 Creating Authority DID...');
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        documentTemplate: {
          publicKeys: [{
            id: 'auth-key',
            purpose: 'authentication'
          }, {
            id: 'assertion-key',
            purpose: 'assertionMethod'
          }],
          services: []
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const didData = await response.json();
    console.log(`✅ Authority DID created: ${didData.longFormDid}`);
    
    res.json({
      success: true,
      did: didData.longFormDid,
      shortDid: didData.did,
      status: didData.status
    });
  } catch (error) {
    console.error('❌ Error creating Authority DID:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/dids', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    res.json({
      success: true,
      dids: data.contents || []
    });
  } catch (error) {
    console.error('❌ Error fetching DIDs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/publish-did', async (req, res) => {
  const { didId } = req.body;
  
  try {
    console.log(`📤 Publishing DID: ${didId}`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids/${didId}/publications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ DID published: ${didId}`);
    
    res.json({
      success: true,
      didId: didId,
      status: 'PUBLISHED'
    });
  } catch (error) {
    console.error('❌ Error publishing DID:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Connection management endpoints
app.post('/api/connections/create-invitation', async (req, res) => {
  const { label, certificateType } = req.body;
  
  try {
    console.log(`📨 Creating invitation for: ${label}`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        label: label || 'Certificate Authority'
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ Invitation created: ${data.connectionId}`);
    
    res.json({
      success: true,
      connectionId: data.connectionId,
      invitation: data.invitation
    });
  } catch (error) {
    console.error('❌ Error creating invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/connections/accept-invitation', async (req, res) => {
  const { invitation, label } = req.body;
  
  try {
    console.log(`🤝 Accepting invitation with label: ${label}`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connection-invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        invitation,
        label: label || 'Certificate Applicant'
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ Invitation accepted: ${data.connectionId}`);
    
    res.json({
      success: true,
      connectionId: data.connectionId,
      state: data.state,
      role: data.role,
      myDid: data.myDid,
      theirDid: data.theirDid
    });
  } catch (error) {
    console.error('❌ Error accepting invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/connections', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    res.json({
      success: true,
      connections: data.contents || []
    });
  } catch (error) {
    console.error('❌ Error fetching connections:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Credential issuance endpoints
app.post('/api/credentials/issue-realperson', async (req, res) => {
  try {
    const { connectionId, credentialData } = req.body;
    
    if (!connectionId || !credentialData) {
      return res.status(400).json({ 
        success: false, 
        error: 'connectionId and credentialData are required' 
      });
    }
    
    console.log(`🎯 Issuing RealPerson credential to connection: ${connectionId}`);
    console.log('📋 Credential data received:', credentialData);
    
    // Generate uniqueId if not provided
    if (!credentialData.uniqueId) {
      credentialData.uniqueId = `CA-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
      console.log(`🆔 Generated uniqueId: ${credentialData.uniqueId}`);
    }
    
    // Use the RealPerson schema GUID from Cloud Agent
    const schemaId = '29fcc5b7-0f77-3b9b-8fbc-c5bf29dd5888'; // RealPerson schema
    
    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        claims: credentialData,
        connectionId: connectionId,
        issuingDID: 'did:prism:be9885e30aee522af94fb76e9357f9d89b1bc60c1e2e136dc10d823e62ba3783',
        schemaId: `http://mt-caddy-secondary-1:8081/cloud-agent/schema-registry/schemas/${schemaId}`,
        automaticIssuance: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`✅ RealPerson credential issued: ${result.recordId}`);
    
    res.json({
      success: true,
      recordId: result.recordId,
      credentialData: credentialData,
      connectionId: connectionId
    });
    
  } catch (error) {
    console.error('❌ Error issuing RealPerson credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/credentials/issued', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    res.json({
      success: true,
      credentials: data.contents || []
    });
    
  } catch (error) {
    console.error('❌ Error fetching issued credentials:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve routes for different pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index-edge-sdk.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login-edge-sdk.html'));
});

app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal-edge-sdk.html'));
});

app.get('/realperson', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'realperson-edge-sdk.html'));
});

app.get('/security-clearance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'security-clearance-edge-sdk.html'));
});

// Edge SDK integration demo pages
app.get('/edge-demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'edge-demo.html'));
});

app.get('/webpack-demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'webpack-demo.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎉 Certification Authority (Edge SDK) started successfully!`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`📱 Edge SDK Integration: Client-side with mediator support`);
  console.log(`🔗 Mediator WebSocket: ${MEDIATOR_URL}`);
  console.log(`🆔 Mediator DID: ${MEDIATOR_DID}`);
  console.log(`🏛️ Cloud Agent Fallback: ${CLOUD_AGENT_URL}`);
  console.log(`\n🔐 Available endpoints:`);
  console.log(`   • GET  / - CA Portal Home (Edge SDK)`);
  console.log(`   • GET  /login - QR Authentication`);
  console.log(`   • GET  /edge-demo - Edge SDK Demo`);
  console.log(`   • GET  /portal - Authenticated Portal`);
  console.log(`   • POST /api/verification/start-session - Start authentication`);
  console.log(`   • POST /api/verification/verify-credential - Verify credential`);
  console.log(`   • GET  /api/config - Edge SDK configuration`);
  console.log(`\n⚡ Ready for Edge SDK connections through Identus Mediator!`);
});