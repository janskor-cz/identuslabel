const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// PRISM DID Parser for extracting keys from long-form PRISM DIDs
const {
  extractSecurityClearanceKeysFromPrismDID,
  isLongFormPrismDID
} = require('./lib/prismDIDParser');

const { ServiceAccessService, createTrustRegistry, createIssuerResolver } = require('service-access-didcomm');

const app = express();
const PORT = process.env.PORT || 3005;

// Initialize CA DIDComm identity (generates/loads keypair + peer DID)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://identuslabel.cz/ca';

// Cloud Agent configuration for Certification Authority (Local Simple Agent)
const CLOUD_AGENT_URL = process.env.CLOUD_AGENT_URL || 'https://identuslabel.cz/cloud-agent';
const API_KEY = process.env.CLOUD_AGENT_API_KEY || 'admin';
const WALLET_ID = 'certification-authority-wallet';
const ENTITY_ID = 'certification-authority-entity';
const ORG_NAME = 'Certification Authority';

// Persistent storage for user-connection mappings
const USER_MAPPINGS_FILE = path.join(__dirname, 'data', 'user-connection-mappings.json');

// Persistent storage for soft-deleted connections
const SOFT_DELETED_FILE = path.join(__dirname, 'data', 'soft-deleted-connections.json');

// Persistent storage for photo DIDs (uniqueId → { photoDID, iagonFileId, proxyUrl })
const PHOTO_DIDS_FILE = path.join(__dirname, 'data', 'photo-dids.json');

// Persistent storage for DIDComm chat messages (scoped by connectionId)
const CHAT_MESSAGES_FILE = path.join(__dirname, 'data', 'chat-messages.json');

function loadChatMessages() {
  try {
    if (fs.existsSync(CHAT_MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(CHAT_MESSAGES_FILE, 'utf8'));
    }
    return {};
  } catch (e) {
    console.error('[Chat] Failed to load chat messages:', e.message);
    return {};
  }
}

function saveChatMessages(store) {
  try {
    fs.writeFileSync(CHAT_MESSAGES_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('[Chat] Failed to save chat messages:', e.message);
  }
}

let chatMessageStore = loadChatMessages();

/**
 * Load user-connection mappings from persistent storage
 * @returns {Map} User-connection mappings
 */
function loadUserMappings() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(USER_MAPPINGS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load mappings file if it exists
    if (fs.existsSync(USER_MAPPINGS_FILE)) {
      const data = fs.readFileSync(USER_MAPPINGS_FILE, 'utf8');
      const mappingsObj = JSON.parse(data);
      const mappingsMap = new Map(Object.entries(mappingsObj));
      console.log(`✅ [PERSISTENCE] Loaded ${mappingsMap.size} user-connection mappings from disk`);
      return mappingsMap;
    } else {
      console.log('📝 [PERSISTENCE] No existing mappings file found, starting fresh');
      return new Map();
    }
  } catch (error) {
    console.error('❌ [PERSISTENCE] Error loading user mappings:', error.message);
    return new Map();
  }
}

/**
 * Save user-connection mappings to persistent storage
 * @param {Map} mappings - User-connection mappings to save
 */
function saveUserMappings(mappings) {
  try {
    // Convert Map to plain object for JSON serialization
    const mappingsObj = Object.fromEntries(mappings);
    const data = JSON.stringify(mappingsObj, null, 2);

    fs.writeFileSync(USER_MAPPINGS_FILE, data, 'utf8');
    console.log(`💾 [PERSISTENCE] Saved ${mappings.size} user-connection mappings to disk`);
  } catch (error) {
    console.error('❌ [PERSISTENCE] Error saving user mappings:', error.message);
  }
}

/**
 * Load soft-deleted connection IDs from persistent storage
 * @returns {Set} Set of soft-deleted connection IDs
 */
function loadSoftDeletedConnections() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(SOFT_DELETED_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load soft-deleted file if it exists
    if (fs.existsSync(SOFT_DELETED_FILE)) {
      const data = fs.readFileSync(SOFT_DELETED_FILE, 'utf8');
      const deletedArray = JSON.parse(data);
      const deletedSet = new Set(deletedArray);
      console.log(`✅ [SOFT-DELETE] Loaded ${deletedSet.size} soft-deleted connections from disk`);
      return deletedSet;
    } else {
      console.log('📝 [SOFT-DELETE] No existing soft-deleted file found, starting fresh');
      return new Set();
    }
  } catch (error) {
    console.error('❌ [SOFT-DELETE] Error loading soft-deleted connections:', error.message);
    return new Set();
  }
}

/**
 * Save soft-deleted connection IDs to persistent storage
 * @param {Set} deletedConnections - Set of soft-deleted connection IDs
 */
function saveSoftDeletedConnections(deletedConnections) {
  try {
    // Convert Set to array for JSON serialization
    const deletedArray = Array.from(deletedConnections);
    const data = JSON.stringify(deletedArray, null, 2);

    fs.writeFileSync(SOFT_DELETED_FILE, data, 'utf8');
    console.log(`💾 [SOFT-DELETE] Saved ${deletedConnections.size} soft-deleted connections to disk`);
  } catch (error) {
    console.error('❌ [SOFT-DELETE] Error saving soft-deleted connections:', error.message);
  }
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// Utility function to generate RSA keypair for security clearances
// ✅ SECURITY FIX: Removed insecure private key generation
// Keys are now generated by wallets using Ed25519 and only public keys are submitted

/**
 * Generate fingerprint from Ed25519 public key (base64url encoded)
 * @param {string} publicKeyBase64url - Base64url encoded Ed25519 public key
 * @returns {string} Formatted fingerprint (XX:XX:XX...)
 */
function generateEd25519Fingerprint(publicKeyBase64url) {
  try {
    // Decode base64url to buffer
    const publicKeyBuffer = Buffer.from(publicKeyBase64url, 'base64url');

    // Generate SHA256 hash and format as fingerprint
    const fingerprint = crypto.createHash('sha256')
      .update(publicKeyBuffer)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)
      .join(':');

    return fingerprint;
  } catch (error) {
    console.error('Error generating Ed25519 fingerprint:', error);
    throw new Error('Invalid Ed25519 public key format');
  }
}

/**
 * Validate Ed25519 public key format
 * @param {string} publicKeyBase64url - Base64url encoded public key
 * @returns {boolean} True if valid
 */
function validateEd25519PublicKey(publicKeyBase64url) {
  try {
    const buffer = Buffer.from(publicKeyBase64url, 'base64url');
    // Ed25519 public keys are always 32 bytes
    return buffer.length === 32;
  } catch (error) {
    return false;
  }
}

/**
 * Validate X25519 public key format
 * @param {string} publicKeyBase64url - Base64url encoded public key
 * @returns {boolean} True if valid
 */
function validateX25519PublicKey(publicKeyBase64url) {
  try {
    if (typeof publicKeyBase64url !== 'string') return false;
    const buffer = Buffer.from(publicKeyBase64url, 'base64url');
    // X25519 public keys are always 32 bytes
    return buffer.length === 32;
  } catch (error) {
    console.error('Error validating X25519 public key:', error);
    return false;
  }
}

/**
 * Generate fingerprint from X25519 public key (base64url encoded)
 * @param {string} publicKeyBase64url - Base64url encoded X25519 public key
 * @returns {string} Formatted fingerprint (XX:XX:XX...)
 */
function generateX25519Fingerprint(publicKeyBase64url) {
  try {
    // Decode base64url to buffer
    const publicKeyBuffer = Buffer.from(publicKeyBase64url, 'base64url');

    // Generate SHA256 hash and format as fingerprint
    const fingerprint = crypto.createHash('sha256')
      .update(publicKeyBuffer)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)
      .join(':');

    return fingerprint;
  } catch (error) {
    console.error('Error generating X25519 fingerprint:', error);
    throw new Error('Invalid X25519 public key format');
  }
}

/**
 * Generate Ed25519 keypair for Security Clearance credentials
 * @returns {Object} Object containing publicKey and privateKey in base64url format
 */
function generateEd25519Keypair() {
  try {
    // Generate Ed25519 keypair using Node.js crypto
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: {
        type: 'spki',
        format: 'der'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'der'
      }
    });

    // Extract raw 32-byte public key from DER-encoded SPKI format
    // SPKI format has a 12-byte header for Ed25519
    const rawPublicKey = publicKey.slice(-32);

    // Extract raw 32-byte private key from DER-encoded PKCS8 format
    // PKCS8 format has a 16-byte header for Ed25519
    const rawPrivateKey = privateKey.slice(-32);

    return {
      publicKey: rawPublicKey.toString('base64url'),
      privateKey: rawPrivateKey.toString('base64url')
    };
  } catch (error) {
    console.error('Error generating Ed25519 keypair:', error);
    throw new Error('Failed to generate Ed25519 keypair');
  }
}

function generateX25519Keypair() {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });
    const rawPublicKey = publicKey.slice(-32);
    const rawPrivateKey = privateKey.slice(-32);
    return {
      publicKey: rawPublicKey.toString('base64url'),
      privateKey: rawPrivateKey.toString('base64url')
    };
  } catch (error) {
    console.error('Error generating X25519 keypair:', error);
    throw new Error('Failed to generate X25519 keypair');
  }
}

// ✅ SECURE: Store only public key metadata (no private keys)
global.securityPublicKeys = global.securityPublicKeys || new Map();

// Store user-to-connection mappings with persistent storage
global.userConnectionMappings = loadUserMappings();

// Store soft-deleted connection IDs with persistent storage
global.softDeletedConnections = loadSoftDeletedConnections();

// ── Photo DID storage (uniqueId → { photoDID, iagonFileId, proxyUrl, createdAt }) ──
let photoDIDs = {};
try {
  photoDIDs = JSON.parse(fs.readFileSync(PHOTO_DIDS_FILE, 'utf8'));
  console.log(`📸 [PHOTO-DIDS] Loaded ${Object.keys(photoDIDs).length} photo DID mappings`);
} catch (e) {
  photoDIDs = {};
  console.log('📸 [PHOTO-DIDS] Starting with empty photo DID store');
}

function savePhotoDIDs() {
  try {
    fs.writeFileSync(PHOTO_DIDS_FILE, JSON.stringify(photoDIDs, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ [PHOTO-DIDS] Error saving photo DIDs:', e.message);
  }
}

/**
 * Filter published DIDs to exclude photo DIDs (which only have auth keys, not assertionMethod).
 * Photo DIDs cannot sign credentials and must never be used as issuingDID.
 * @param {Array} allDIDs - array of DID objects from Cloud Agent (with .did and .status)
 * @returns {Array} published non-photo DIDs
 */
function filterIssuingDIDs(allDIDs) {
  const photoDIDShortForms = new Set(
    Object.values(photoDIDs).map(e => e.photoDID.split(':').slice(0, 3).join(':'))
  );
  return (allDIDs || []).filter(d =>
    d.status === 'PUBLISHED' && !photoDIDShortForms.has(d.did)
  );
}

/**
 * DIDs this CA currently controls and can issue credentials from, for use as
 * `trustIssuers` on proof requests. An empty trustIssuers array constrains a proof
 * request by schema only, letting a self-issued or attacker-controlled credential of the
 * right schema satisfy the request — a real auth bypass for login/access-control flows.
 * Fetched live (rather than a hardcoded DID) so it stays correct across DID rotation.
 */
async function getTrustedIssuerDIDs() {
  try {
    const didsResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      headers: { 'apikey': API_KEY }
    });
    if (!didsResponse.ok) return [];
    const dids = await didsResponse.json();
    return filterIssuingDIDs(dids.contents).map(d => d.did);
  } catch (e) {
    console.error('❌ [TRUST-ISSUERS] Failed to fetch CA issuer DIDs:', e.message);
    return [];
  }
}

/**
 * Upload a raw JPEG buffer to Iagon (no encryption — photos are served publicly via CA proxy)
 * @param {Buffer} jpegBuffer
 * @param {string} filename
 * @returns {Promise<string>} iagonFileId
 */
async function uploadPhotoToIagon(jpegBuffer, filename) {
  const IAGON_BASE = 'https://gw.iagon.com/api/v2';
  const form = new FormData();
  form.append('file', jpegBuffer, { filename, contentType: 'image/jpeg' });
  form.append('node_id', process.env.IAGON_NODE_ID);

  const response = await axios.post(`${IAGON_BASE}/storage/upload`, form, {
    headers: {
      ...form.getHeaders(),
      'x-api-key': process.env.IAGON_ACCESS_TOKEN
    },
    timeout: 60000,
    maxContentLength: 10 * 1024 * 1024,
    maxBodyLength: 10 * 1024 * 1024
  });

  const fileId = response.data?.data?._id;
  if (!fileId) throw new Error(`Iagon upload returned no fileId: ${JSON.stringify(response.data)}`);
  console.log(`📸 [IAGON] Uploaded photo: ${fileId}`);
  return fileId;
}

/**
 * Download a raw file from Iagon
 * @param {string} iagonFileId
 * @returns {Promise<Buffer>}
 */
async function downloadPhotoFromIagon(iagonFileId) {
  const IAGON_BASE = 'https://gw.iagon.com/api/v2';
  const response = await axios.post(`${IAGON_BASE}/storage/download`, {
    id: iagonFileId,
    files: [iagonFileId]
  }, {
    headers: {
      'x-api-key': process.env.IAGON_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer',
    timeout: 60000
  });
  return Buffer.from(response.data);
}

/**
 * Enhanced connection resolution that tries multiple strategies to find the right connection
 * @param {Object} holderPersonalInfo - Personal info of the credential holder
 * @param {string} explicitConnectionId - Explicitly provided connection ID (optional)
 * @returns {Promise<string>} - Resolved connection ID
 */
async function resolveConnectionId(holderPersonalInfo, explicitConnectionId = null) {
  console.log(`🔍 [CONNECTION RESOLVER] Starting resolution for user: ${holderPersonalInfo.uniqueId}`);
  console.log(`🔍 [CONNECTION RESOLVER] Personal info: ${holderPersonalInfo.firstName} ${holderPersonalInfo.lastName}`);

  // Strategy 1: Use explicit connection ID if provided
  if (explicitConnectionId && explicitConnectionId.trim() && explicitConnectionId !== 'undefined') {
    console.log(`🎯 [CONNECTION RESOLVER] Using explicit connection: ${explicitConnectionId}`);
    return explicitConnectionId;
  }

  // Strategy 2: Direct mapping lookup
  let userMapping = global.userConnectionMappings.get(holderPersonalInfo.uniqueId);
  if (userMapping) {
    console.log(`✅ [CONNECTION RESOLVER] Found direct mapping: ${holderPersonalInfo.uniqueId} → ${userMapping.connectionId}`);
    return userMapping.connectionId;
  }

  // Strategy 3: Search by personal info (first name + last name match)
  if (global.userConnectionMappings) {
    console.log(`🔍 [CONNECTION RESOLVER] No direct mapping found, searching by personal info...`);

    for (const [mappedUserId, mappingData] of global.userConnectionMappings.entries()) {
      if (mappingData.holderInfo &&
          mappingData.holderInfo.firstName?.toLowerCase() === holderPersonalInfo.firstName?.toLowerCase() &&
          mappingData.holderInfo.lastName?.toLowerCase() === holderPersonalInfo.lastName?.toLowerCase()) {
        console.log(`✅ [CONNECTION RESOLVER] Found matching user by name: ${mappedUserId} → ${mappingData.connectionId}`);

        // Create alias mapping for this user ID and persist to disk
        global.userConnectionMappings.set(holderPersonalInfo.uniqueId, {
          ...mappingData,
          aliasFor: mappedUserId,
          registeredAt: new Date().toISOString()
        });
        saveUserMappings(global.userConnectionMappings);
        console.log(`🔗 [CONNECTION RESOLVER] Created alias mapping: ${holderPersonalInfo.uniqueId} → ${mappingData.connectionId}`);
        return mappingData.connectionId;
      }
    }
  }

  // Strategy 4: Use most recent active connection as fallback
  console.log(`⚠️ [CONNECTION RESOLVER] No connection mapping found, searching for available CA connections...`);

  const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
    headers: {}
  });

  if (connectionsResponse.ok) {
    const connectionsData = await connectionsResponse.json();
    const activeConnections = connectionsData.contents?.filter(conn =>
      conn.state === 'ConnectionResponseReceived' ||
      conn.state === 'ConnectionResponseSent' ||
      conn.state === 'Active'
    );

    if (activeConnections && activeConnections.length > 0) {
      const sortedConnections = activeConnections.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const fallbackConnectionId = sortedConnections[0].connectionId;
      console.log(`🔗 [CONNECTION RESOLVER] Using fallback CA connection: ${fallbackConnectionId} (${sortedConnections[0].state})`);

      // Create mapping with real connection and persist to disk
      global.userConnectionMappings.set(holderPersonalInfo.uniqueId, {
        connectionId: fallbackConnectionId,
        holderInfo: holderPersonalInfo,
        registeredAt: new Date().toISOString(),
        fallbackConnection: true
      });
      saveUserMappings(global.userConnectionMappings);

      return fallbackConnectionId;
    } else {
      throw new Error('No active connections available for credential issuance');
    }
  } else {
    throw new Error('Failed to fetch connections from Cloud Agent');
  }
}

/**
 * Resolve DID-based connection identifier to actual Cloud Agent connection UUID
 * @param {string} didConnectionId - DID identifier from wallet (e.g., did:peer:2.Ez6LSr...)
 * @returns {Promise<string|null>} - Cloud Agent connection UUID or null if not found
 */
async function resolveDIDToConnectionId(didConnectionId) {
  try {
    console.log(`🔄 Resolving DID-based connection identifier: ${didConnectionId.substring(0, 50)}...`);

    // If it's already a UUID format, return as-is
    if (didConnectionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(didConnectionId)) {
      console.log(`✅ Connection ID is already UUID format: ${didConnectionId}`);
      return didConnectionId;
    }

    // Check if it's a known DID pattern
    if (!didConnectionId || !didConnectionId.startsWith('did:peer:')) {
      console.log(`⚠️ Invalid DID format: ${didConnectionId}`);
      return null;
    }

    // Fetch all connections from Cloud Agent
    const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      headers: { 'apikey': API_KEY }
    });

    if (!connectionsResponse.ok) {
      console.error(`❌ Failed to fetch connections: ${connectionsResponse.status}`);
      return null;
    }

    const connectionsData = await connectionsResponse.json();

    // Look for a connection where either myDid or theirDid matches the provided DID
    const matchingConnection = connectionsData.contents?.find(conn => {
      const myDid = conn.myDid?.toString();
      const theirDid = conn.theirDid?.toString();

      console.log(`🔍 Checking connection ${conn.connectionId}:`);
      console.log(`   MyDid: ${myDid?.substring(0, 50)}...`);
      console.log(`   TheirDid: ${theirDid?.substring(0, 50)}...`);
      console.log(`   Target: ${didConnectionId.substring(0, 50)}...`);

      return myDid === didConnectionId || theirDid === didConnectionId;
    });

    if (matchingConnection) {
      console.log(`✅ Found matching connection: ${matchingConnection.connectionId} (${matchingConnection.state})`);
      return matchingConnection.connectionId;
    } else {
      console.log(`❌ No connection found matching DID: ${didConnectionId.substring(0, 50)}...`);
      return null;
    }

  } catch (error) {
    console.error('❌ Error resolving DID to connection ID:', error);
    return null;
  }
}

// Secure session management for authentication (prevents race conditions)
global.userSessions = global.userSessions || new Map();      // sessionId -> session data
global.challengeSessions = global.challengeSessions || new Map();  // challengeId -> sessionId

// Enable CORS for cross-origin requests from wallet
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, apikey');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// ============================================================================
// PHOTO DID ENDPOINTS
// ============================================================================

// Proxy: serve Iagon-stored photos without exposing the Iagon API key to clients
app.get('/photo-proxy/:iagonFileId', async (req, res) => {
  try {
    const { iagonFileId } = req.params;
    // Only serve files we uploaded (prevents arbitrary Iagon access)
    const known = Object.values(photoDIDs).some(e => e.iagonFileId === iagonFileId);
    if (!known) return res.status(404).json({ error: 'Photo not found' });

    const imageBuffer = await downloadPhotoFromIagon(iagonFileId);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000'); // 1 year — changes only via new DID service update
    res.send(imageBuffer);
  } catch (error) {
    console.error('❌ [PHOTO-PROXY] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch photo' });
  }
});

// Stable per-user photo endpoint — always returns the current photo, bypassing DID resolution.
// The wallet uses this to show photo updates immediately without waiting for PRISM on-chain confirmation.
// X-Photo-Cache-Key header carries the iagonFileId so the wallet can key its local image cache correctly:
// when the photo is updated a new iagonFileId is created, cache miss forces a fresh fetch.
app.get('/photo-current/:uniqueId', async (req, res) => {
  const entry = photoDIDs[req.params.uniqueId];
  if (!entry) return res.status(404).json({ error: 'No photo for this user' });
  try {
    const imageBuffer = await downloadPhotoFromIagon(entry.iagonFileId);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('X-Photo-Cache-Key', entry.iagonFileId);
    res.send(imageBuffer);
  } catch (error) {
    console.error('❌ [PHOTO-CURRENT] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch photo' });
  }
});

// Return the proxy URL for a given uniqueId (used by portal.html which has no SDK)
app.get('/api/photos/proxy-url/:uniqueId', (req, res) => {
  const entry = photoDIDs[req.params.uniqueId];
  if (!entry) return res.status(404).json({ error: 'No photo found for this user' });
  res.json({ proxyUrl: entry.proxyUrl, photoDID: entry.photoDID });
});

// Return current identity info for a uniqueId (used by company portals for login enrichment)
app.get('/api/user-info/:uniqueId', (req, res) => {
  const { uniqueId } = req.params;
  const mapping = global.userConnectionMappings.get(uniqueId);
  if (!mapping) return res.status(404).json({ error: 'User not found' });
  const { firstName, lastName } = mapping.holderInfo || {};
  const photoEntry = photoDIDs[uniqueId];
  res.json({
    firstName: firstName || null,
    lastName: lastName || null,
    photoDID: photoEntry?.photoDID || null,
    proxyUrl: photoEntry?.proxyUrl || null
  });
});

// Update photo: upload new version to Iagon + PATCH DID Document service endpoint
app.post('/api/photos/update/:uniqueId', async (req, res) => {
  try {
    const { uniqueId } = req.params;
    const { photo } = req.body; // base64 data URI

    if (!photo) return res.status(400).json({ error: 'photo is required' });

    const existing = photoDIDs[uniqueId];
    if (!existing) return res.status(404).json({ error: 'No photo DID registered for this user' });

    // Decode base64 to buffer
    const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const iagonFileId = await uploadPhotoToIagon(buffer, `photo-${uniqueId}-${Date.now()}.jpg`);
    const proxyUrl = `${PUBLIC_BASE_URL}/photo-proxy/${iagonFileId}`;

    // POST to /updates endpoint to update the DID document service endpoint
    const patchResp = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(existing.photoDID)}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify({
        actions: [{
          actionType: 'UPDATE_SERVICE',
          updateService: { id: 'photo', type: 'LinkedPhoto', serviceEndpoint: proxyUrl }
        }]
      })
    });
    if (!patchResp.ok) {
      const errText = await patchResp.text();
      console.warn(`⚠️ [PHOTO-UPDATE] DID PATCH failed: ${patchResp.status} ${errText} (continuing anyway)`);
    }

    // Update local mapping
    existing.iagonFileId = iagonFileId;
    existing.proxyUrl = proxyUrl;
    existing.updatedAt = new Date().toISOString();
    savePhotoDIDs();

    console.log(`📸 [PHOTO-UPDATE] Updated photo for ${uniqueId}: ${iagonFileId}`);
    res.json({ success: true, proxyUrl, photoDID: existing.photoDID });
  } catch (error) {
    console.error('❌ [PHOTO-UPDATE] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// END: PHOTO DID ENDPOINTS
// ============================================================================

// Create DID for Certification Authority
app.post('/api/create-did', async (req, res) => {
  try {
    console.log(`🆔 Creating DID for ${ORG_NAME}...`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
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

// Get all DIDs
app.get('/api/dids', async (req, res) => {
  try {
    console.log(`📋 Fetching DIDs for ${ORG_NAME}...`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ Found ${data.contents.length} DIDs`);
    
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

// Publish DID
app.post('/api/publish-did', async (req, res) => {
  try {
    const { didId } = req.body;
    
    if (!didId) {
      return res.status(400).json({
        success: false,
        error: 'DID ID is required'
      });
    }
    
    console.log(`📤 Publishing DID: ${didId}...`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(didId)}/publications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const publicationData = await response.json();
    console.log(`✅ DID published successfully: ${didId}`);
    
    res.json({
      success: true,
      didId: didId,
      operationHash: publicationData.operationHash,
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

// Create connection invitation for certificate issuance
app.post('/api/cloud-agent/connections/create-invitation', async (req, res) => {
  try {
    const { label, certificateType } = req.body;
    
    console.log(`📜 Creating DIDComm connection invitation for: ${label || 'Unknown'}`);
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        label: label || `${ORG_NAME} Connection`,
        goal: "Connection from CA"
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const invitation = await response.json();
    console.log(`✅ Certificate invitation created: ${invitation.connectionId}`);

    // ✅ ENHANCEMENT: Add goal field to Cloud Agent invitation for Edge Wallet detection
    // Since Cloud Agent doesn't support custom goal fields in OOB invitations,
    // we manually add it to the invitation object after receiving it
    if (invitation.invitation && invitation.invitation.invitationUrl) {
      try {
        // Extract and decode the _oob parameter
        const invitationUrl = new URL(invitation.invitation.invitationUrl);
        const oobParam = invitationUrl.searchParams.get('_oob');

        if (oobParam) {
          // Decode the base64 invitation
          const invitationJson = Buffer.from(oobParam, 'base64').toString('utf-8');
          const invitationObj = JSON.parse(invitationJson);

          // Add goal field to invitation body
          if (!invitationObj.body) {
            invitationObj.body = {};
          }
          invitationObj.body.goal = "Connection from CA";

          // Re-encode the modified invitation
          const modifiedInvitationJson = JSON.stringify(invitationObj);
          const modifiedOobParam = Buffer.from(modifiedInvitationJson).toString('base64');

          // Reconstruct the invitation URL with modified _oob parameter
          invitationUrl.searchParams.set('_oob', modifiedOobParam);
          invitation.invitation.invitationUrl = invitationUrl.toString();

          console.log('✅ Added goal field to Cloud Agent invitation');
        }
      } catch (error) {
        console.warn('⚠️ Failed to add goal field to invitation:', error.message);
        // Continue with original invitation if modification fails
      }
    }

    res.json({
      success: true,
      invitation: invitation.invitation,
      connectionId: invitation.connectionId,
      certificateType: certificateType
    });
  } catch (error) {
    console.error('❌ Error creating invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Well-known invitation endpoint - creates fresh single-use invitation per request
// DIDComm OOB invitations are single-use by protocol design
// Each wallet connection gets its own unique invitation
app.get('/api/well-known/invitation', async (req, res) => {
  try {
    // Extract userName from query parameter
    const { userName } = req.query;
    console.log('📋 [WELL-KNOWN] Fresh invitation requested');
    if (userName) {
      console.log('👤 [WELL-KNOWN] User name provided:', userName);
    }

    const fs = require('fs');
    const path = require('path');

    // Read CA Authority credential from file
    const credentialPath = path.join(__dirname, 'data', 'ca-authority-credential.json');

    let caCredentialData = null;
    let jwtCredential = null;

    if (fs.existsSync(credentialPath)) {
      caCredentialData = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
      jwtCredential = Buffer.from(caCredentialData.credential, 'base64').toString('utf8');
      console.log('📋 [WELL-KNOWN] CA credential loaded:', caCredentialData.credentialType);
    } else {
      console.log('⚠️  [WELL-KNOWN] CA Authority credential not found - invitation will not include credential');
    }

    // Get current CA DID (Cloud Agent 2.0.0 uses /did-registrar/dids)
    const didsResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      headers: { 'apikey': API_KEY }
    });

    if (!didsResponse.ok) {
      throw new Error(`Failed to fetch DIDs: ${didsResponse.status}`);
    }

    const dids = await didsResponse.json();
    const caDID = dids.contents?.[0];

    if (!caDID) {
      throw new Error('CA DID not found - CA may not be initialized');
    }

    console.log('📋 [WELL-KNOWN] Current CA DID:', caDID.did);
    console.log('🆕 [WELL-KNOWN] Creating fresh single-use invitation for wallet connection');

    // Always create fresh invitation (DIDComm OOB invitations are single-use by design)
    // 🔧 FIX: Pre-populate label with userName since Cloud Agent doesn't extract it from HandshakeRequest
    // Cloud Agent 2.0.0 sets connection label ONLY at invitation creation time, never updates it
    const connectionLabel = userName ? `CA Connection: ${userName}` : `CA Connection - ${new Date().toISOString()}`;
    console.log('🏷️  [WELL-KNOWN] Connection label:', connectionLabel);

    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        label: connectionLabel  // 🔧 FIX: Include label at invitation creation
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create invitation: ${response.status}`);
    }

    const invitation = await response.json();

    console.log('✅ [WELL-KNOWN] Fresh invitation created:', invitation.connectionId);
    console.log('📊 [WELL-KNOWN] This invitation is single-use and will expire after acceptance');

    // If CA credential exists, embed it in the invitation
    let finalInvitation = invitation.invitation;

    if (caCredentialData && jwtCredential) {
      try {
        // Extract and decode the _oob parameter from invitation URL
        const invitationUrl = new URL(invitation.invitation.invitationUrl);
        const oobParam = invitationUrl.searchParams.get('_oob');

        if (!oobParam) {
          throw new Error('Invalid invitation URL: missing _oob parameter');
        }

        // Decode the base64 invitation
        const invitationJson = Buffer.from(oobParam, 'base64').toString('utf-8');
        const invitationObj = JSON.parse(invitationJson);

        // Embed CA Authority credential in invitation's requests_attach
        if (!invitationObj.body) {
          invitationObj.body = {};
        }
        invitationObj.body.goal_code = 'ca-identity-verification';
        invitationObj.body.goal = 'Establish trust with Certification Authority';

        // Add CA credential as attachment
        invitationObj.requests_attach = [{
          '@id': 'ca-authority-credential',
          'mime-type': 'application/json',
          'data': {
            'json': {
              credential: jwtCredential, // JWT (decoded from base64)
              claims: caCredentialData.claims,
              issuerDID: caCredentialData.issuerDID,
              holderDID: caCredentialData.holderDID,
              credentialType: caCredentialData.credentialType,
              issuedDate: caCredentialData.issuedDate
            }
          }
        }];

        // Re-encode the modified invitation
        const modifiedInvitationJson = JSON.stringify(invitationObj);
        const modifiedOobParam = Buffer.from(modifiedInvitationJson).toString('base64');

        // Update invitation URL with modified _oob parameter
        invitationUrl.searchParams.set('_oob', modifiedOobParam);

        // Create modified invitation object
        finalInvitation = {
          ...invitation.invitation,
          invitationUrl: invitationUrl.toString()
        };

        console.log('✅ [WELL-KNOWN] CA credential embedded in invitation');
      } catch (embedError) {
        console.error('⚠️  [WELL-KNOWN] Failed to embed CA credential:', embedError.message);
        // Continue with original invitation without credential
      }
    }

    // Return invitation (with or without CA credential)
    res.json({
      success: true,
      invitation: finalInvitation,
      connectionId: invitation.connectionId,
      caDID: caDID.did,
      caName: ORG_NAME,
      caUrl: PUBLIC_BASE_URL,
      hasCACredential: !!caCredentialData
    });

  } catch (error) {
    console.error('❌ [WELL-KNOWN] Error creating invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DIDComm invitation endpoint - provides user-friendly page for browser access
// Wallet apps extract the _oob parameter directly without fetching this URL
app.get('/invitation', (req, res) => {
  const oobParam = req.query._oob;

  if (!oobParam) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invalid Invitation</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 500px;
            text-align: center;
          }
          h1 { color: #e53e3e; margin-bottom: 20px; }
          p { color: #4a5568; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⚠️ Invalid Invitation</h1>
          <p>This invitation link is missing required parameters.</p>
          <p>Please scan the QR code from the CA initialization page.</p>
        </div>
      </body>
      </html>
    `);
  }

  // Return simple HTML page - NO JavaScript to avoid errors
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CA Connection Invitation</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 600px;
          padding: 40px;
        }
        h1 {
          color: #2d3748;
          font-size: 28px;
          margin-bottom: 20px;
          text-align: center;
        }
        .info-box {
          background: #ebf8ff;
          border-left: 4px solid #3182ce;
          padding: 20px;
          margin: 20px 0;
          border-radius: 4px;
        }
        .info-box h3 {
          color: #2c5282;
          font-size: 18px;
          margin-bottom: 10px;
        }
        .info-box p {
          color: #2c5282;
          line-height: 1.6;
          font-size: 14px;
        }
        .warning-box {
          background: #fff5f5;
          border-left: 4px solid #f56565;
          padding: 20px;
          margin: 20px 0;
          border-radius: 4px;
        }
        .warning-box h3 {
          color: #c53030;
          font-size: 16px;
          margin-bottom: 10px;
        }
        .warning-box p {
          color: #742a2a;
          line-height: 1.6;
          font-size: 14px;
        }
        .url-box {
          background: #f7fafc;
          padding: 15px;
          border-radius: 8px;
          word-break: break-all;
          font-family: 'Courier New', monospace;
          font-size: 12px;
          color: #4a5568;
          margin: 15px 0;
          max-height: 200px;
          overflow-y: auto;
        }
        ol {
          padding-left: 20px;
          margin: 10px 0;
        }
        ol li {
          color: #4a5568;
          line-height: 1.8;
          margin-bottom: 8px;
        }
        @media (max-width: 640px) {
          .container { padding: 25px; }
          h1 { font-size: 24px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏛️ CA Connection Invitation</h1>

        <div class="info-box">
          <h3>📱 For Wallet Apps</h3>
          <p>If you're using a mobile wallet app, please:</p>
          <ol>
            <li>Open your wallet app (Alice or Bob)</li>
            <li>Navigate to the "Connect to CA" or "OOB" section</li>
            <li>Use the wallet's built-in QR scanner</li>
            <li>Scan the QR code from the CA initialization page</li>
          </ol>
        </div>

        <div class="warning-box">
          <h3>⚠️ Browser Access</h3>
          <p>You've opened this invitation in a web browser. DIDComm invitations are designed for wallet applications, not browsers.</p>
          <p><strong>This page is for informational purposes only.</strong></p>
        </div>

        <div class="info-box">
          <h3>🔗 Invitation URL</h3>
          <p>Full invitation URL (for manual paste into wallet):</p>
          <div class="url-box">${req.protocol}://${req.get('host')}${req.originalUrl}</div>
        </div>

        <div class="info-box">
          <h3>📋 Next Steps</h3>
          <ol>
            <li>Visit <strong>${PUBLIC_BASE_URL}/init.html</strong> on your desktop</li>
            <li>Scan the QR code with your wallet app's built-in scanner</li>
            <li>Or copy the invitation URL above and paste it into your wallet</li>
          </ol>
        </div>
      </div>
    </body>
    </html>
  `);
});

// URL shortener redirect endpoint for CA invitations
app.get('/i/:shortId', (req, res) => {
  const { shortId } = req.params;
  global.invitationStore = global.invitationStore || new Map();

  const invitationUrl = global.invitationStore.get(shortId);

  if (!invitationUrl) {
    return res.status(404).send('Invitation not found or expired');
  }

  console.log(`🔗 [URL-SHORTENER] Redirecting short ID ${shortId} to invitation`);

  // Redirect to the full invitation URL
  res.redirect(302, invitationUrl);
});

// Wallet initialization endpoint - provides CA identity verification
// Returns OOB invitation with embedded CA Authority credential for trust establishment
app.get('/api/wallet-init/ca-invitation', async (req, res) => {
  try {
    console.log('🏛️ [WALLET-INIT] CA identity verification invitation requested');

    const fs = require('fs');
    const path = require('path');

    // Read CA Authority credential from file
    const credentialPath = path.join(__dirname, 'data', 'ca-authority-credential.json');

    if (!fs.existsSync(credentialPath)) {
      return res.status(404).json({
        success: false,
        error: 'CA Authority credential not found. Please issue the credential first.'
      });
    }

    const caCredentialData = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    console.log('📋 [WALLET-INIT] CA credential loaded:', caCredentialData.credentialType);

    // Decode the base64-encoded credential to get the JWT string
    const jwtCredential = Buffer.from(caCredentialData.credential, 'base64').toString('utf8');
    console.log('🔓 [WALLET-INIT] Decoded JWT credential for invitation');

    // Create fresh DIDComm connection invitation
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        label: `Wallet Init - ${new Date().toISOString()}`,
        goal: 'Establish trust with Certification Authority'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create invitation: ${response.status}`);
    }

    const invitation = await response.json();
    console.log('✅ [WALLET-INIT] Invitation created:', invitation.connectionId);

    // Extract and decode the _oob parameter from invitation URL
    const invitationUrl = new URL(invitation.invitation.invitationUrl);
    const oobParam = invitationUrl.searchParams.get('_oob');

    if (!oobParam) {
      throw new Error('Invalid invitation URL: missing _oob parameter');
    }

    // Decode the base64 invitation
    const invitationJson = Buffer.from(oobParam, 'base64').toString('utf-8');
    const invitationObj = JSON.parse(invitationJson);

    // Embed CA Authority credential in invitation's requests_attach
    if (!invitationObj.body) {
      invitationObj.body = {};
    }
    invitationObj.body.goal_code = 'ca-identity-verification';
    invitationObj.body.goal = 'Establish trust with Certification Authority';

    // Add CA credential as attachment
    invitationObj.requests_attach = [{
      '@id': 'ca-authority-credential',
      'mime-type': 'application/json',
      'data': {
        'json': {
          credential: jwtCredential, // JWT (decoded from base64)
          claims: caCredentialData.claims,
          issuerDID: caCredentialData.issuerDID,
          holderDID: caCredentialData.holderDID,
          credentialType: caCredentialData.credentialType,
          issuedDate: caCredentialData.issuedDate
        }
      }
    }];

    // Re-encode the modified invitation
    const modifiedInvitationJson = JSON.stringify(invitationObj);
    const modifiedOobParam = Buffer.from(modifiedInvitationJson).toString('base64');

    // Reconstruct the invitation URL with correct domain
    invitationUrl.hostname = 'identuslabel.cz';
    invitationUrl.pathname = '/ca/invitation';
    invitationUrl.searchParams.set('_oob', modifiedOobParam);
    const finalInvitationUrl = invitationUrl.toString();

    console.log('✅ [WALLET-INIT] CA credential embedded in invitation');

    // Store invitation in memory for URL shortening (for QR code)
    const shortId = require('crypto').randomBytes(4).toString('hex'); // 8-char short ID
    global.invitationStore = global.invitationStore || new Map();
    global.invitationStore.set(shortId, finalInvitationUrl);

    // Clean up old invitations (keep last 100)
    if (global.invitationStore.size > 100) {
      const firstKey = global.invitationStore.keys().next().value;
      global.invitationStore.delete(firstKey);
    }

    // Create short URL for QR code
    const shortUrl = `${PUBLIC_BASE_URL}/i/${shortId}`;
    console.log(`✅ [WALLET-INIT] Short URL created: ${shortUrl}`);

    // Return invitation with embedded CA credential
    res.json({
      success: true,
      invitationUrl: finalInvitationUrl,
      shortUrl: shortUrl, // Short URL for QR code
      oobInvitation: modifiedOobParam, // For QR code generation
      connectionId: invitation.connectionId,
      caInfo: {
        organizationName: caCredentialData.claims.organizationName,
        website: caCredentialData.claims.website,
        jurisdiction: caCredentialData.claims.jurisdiction,
        registrationNumber: caCredentialData.claims.registrationNumber,
        authorityLevel: caCredentialData.claims.authorityLevel,
        holderDID: caCredentialData.holderDID
      }
    });

  } catch (error) {
    console.error('❌ [WALLET-INIT] Error creating CA invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Accept connection invitation from certificate applicants
app.post('/api/cloud-agent/connections/accept-invitation', async (req, res) => {
  try {
    const { invitation } = req.body;
    
    if (!invitation) {
      return res.status(400).json({
        success: false,
        error: 'Invitation is required'
      });
    }
    
    console.log('📥 Accepting certificate applicant invitation...');
    
    let invitationString;
    if (typeof invitation === 'string') {
      invitationString = invitation;
    } else {
      invitationString = btoa(JSON.stringify(invitation));
    }
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connection-invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        invitation: invitationString
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const connectionData = await response.json();
    console.log(`✅ Certificate applicant connected: ${connectionData.connectionId}`);
    
    res.json({
      success: true,
      connectionId: connectionData.connectionId,
      state: connectionData.state,
      role: connectionData.role
    });
  } catch (error) {
    console.error('❌ Error accepting invitation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get connections (certificate applicants)
app.get('/api/cloud-agent/connections', async (req, res) => {
  try {
    console.log('🔗 Fetching certificate applicant connections...');
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ Found ${data.contents.length} connections from Cloud Agent`);

    // Filter out soft-deleted connections
    const activeConnections = data.contents.filter(conn =>
      !global.softDeletedConnections.has(conn.connectionId)
    );

    const filteredCount = data.contents.length - activeConnections.length;
    if (filteredCount > 0) {
      console.log(`🗑️ Filtered out ${filteredCount} soft-deleted connections`);
    }
    console.log(`✅ Returning ${activeConnections.length} active connections`);

    res.json({
      success: true,
      connections: activeConnections
    });
  } catch (error) {
    console.error('❌ Error fetching connections:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete a connection
app.delete('/api/cloud-agent/connections/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    console.log('🗑️ Deleting connection:', connectionId);

    // Delete connection from Cloud Agent
    const response = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Cloud Agent responded with ${response.status}:`, errorText);

      // Cloud Agent may return 404 if connection doesn't exist
      if (response.status === 404) {
        return res.status(404).json({
          success: false,
          error: 'Connection not found in Cloud Agent'
        });
      }

      // If 403, connection is in protected state - do soft delete instead
      if (response.status === 403) {
        console.warn(`⚠️ Cloud Agent rejected delete (403) - connection in protected state`);
        console.warn(`⚠️ Performing soft delete - removing from CA mappings only`);

        // Remove from userConnectionMappings
        let removedFromMappings = false;
        if (global.userConnectionMappings) {
          for (const [identifier, mapping] of global.userConnectionMappings.entries()) {
            if (mapping.connectionId === connectionId) {
              global.userConnectionMappings.delete(identifier);
              saveUserMappings(global.userConnectionMappings);
              console.log(`✅ Removed ${identifier} → ${connectionId} from mappings`);
              removedFromMappings = true;
              break;
            }
          }
        }

        // Remove from permanent invitation cache
        if (global.permanentInvitation && global.permanentInvitation.connectionId === connectionId) {
          console.log('🔄 Removed from permanent invitation cache');
          delete global.permanentInvitation;
        }

        // Add to soft-deleted connections set
        global.softDeletedConnections.add(connectionId);
        saveSoftDeletedConnections(global.softDeletedConnections);
        console.log(`🗑️ Added ${connectionId} to soft-deleted connections (total: ${global.softDeletedConnections.size})`);

        return res.json({
          success: true,
          message: 'Connection soft-deleted (removed from CA mappings)',
          softDelete: true,
          note: 'Connection still exists in Cloud Agent but removed from CA active connections',
          removedFromMappings: removedFromMappings
        });
      }

      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }

    console.log('✅ Connection deleted successfully from Cloud Agent');

    // Check if this connection was part of our global permanent invitation cache
    if (global.permanentInvitation && global.permanentInvitation.connectionId === connectionId) {
      console.log('🔄 Deleted connection was the permanent invitation, clearing cache');
      delete global.permanentInvitation;
    }

    // Add to soft-deleted connections set (for filtering in GET endpoint)
    global.softDeletedConnections.add(connectionId);
    saveSoftDeletedConnections(global.softDeletedConnections);
    console.log(`🗑️ Added ${connectionId} to soft-deleted connections (total: ${global.softDeletedConnections.size})`);

    res.json({
      success: true,
      message: 'Connection deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create Confidential Security Clearance schema
app.post('/api/schemas/create-confidential-clearance', async (req, res) => {
  try {
    console.log('📋 Creating Confidential Security Clearance schema...');
    
    // First, get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }
    
    const didData = await didResponse.json();
    // Use the newest (last) DID which should have assertionMethod key
    const authorityDID = didData.contents.length > 0 ? didData.contents[didData.contents.length - 1].did : null;
    
    if (!authorityDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }
    
    console.log(`📋 Using authority DID: ${authorityDID}`);
    
    const schemaDefinition = {
      name: 'ConfidentialSecurityClearance',
      version: '1.0.0',
      description: 'Confidential level security clearance credential with embedded cryptographic keypair',
      type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
      author: authorityDID,
      authored: new Date().toISOString(),
      tags: ['security', 'clearance', 'confidential', 'cryptographic'],
      schema: {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': 'https://certification-authority.org/schemas/ConfidentialSecurityClearance/1.0.0',
        'type': 'object',
        'properties': {
          'clearanceLevel': { 'type': 'string', 'enum': ['CONFIDENTIAL'] },
          'holderName': { 'type': 'string' },
          'holderUniqueId': { 'type': 'string' },
          'publicKey': { 'type': 'string' },
          'keyAlgorithm': { 'type': 'string' },
          'keyFingerprint': { 'type': 'string' },
          'issuedDate': { 'type': 'string', 'format': 'date' },
          'expiryDate': { 'type': 'string', 'format': 'date' },
          'clearanceId': { 'type': 'string' }
        },
        'required': ['clearanceLevel', 'holderName', 'holderUniqueId', 'publicKey', 'keyAlgorithm', 'keyFingerprint', 'issuedDate', 'expiryDate', 'clearanceId']
      }
    };
    
    console.log('📋 Sending Confidential schema definition:', JSON.stringify(schemaDefinition, null, 2));
    
    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(schemaDefinition)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Confidential schema creation failed:', errorText);
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }
    
    const schemaData = await response.json();
    console.log(`✅ Confidential Security Clearance schema created: ${schemaData.guid}`);
    
    res.json({
      success: true,
      schemaId: schemaData.guid,
      schemaData: schemaData
    });
  } catch (error) {
    console.error('❌ Error creating Confidential schema:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create Restricted Security Clearance schema
app.post('/api/schemas/create-restricted-clearance', async (req, res) => {
  try {
    console.log('📋 Creating Restricted Security Clearance schema...');
    
    // First, get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }
    
    const didData = await didResponse.json();
    // Use the newest (last) DID which should have assertionMethod key
    const authorityDID = didData.contents.length > 0 ? didData.contents[didData.contents.length - 1].did : null;
    
    if (!authorityDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }
    
    console.log(`📋 Using authority DID: ${authorityDID}`);
    
    const schemaDefinition = {
      name: 'RestrictedSecurityClearance',
      version: '1.0.0',
      description: 'Restricted level security clearance credential with embedded cryptographic keypair',
      type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
      author: authorityDID,
      authored: new Date().toISOString(),
      tags: ['security', 'clearance', 'restricted', 'cryptographic'],
      schema: {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': 'https://certification-authority.org/schemas/RestrictedSecurityClearance/1.0.0',
        'type': 'object',
        'properties': {
          'clearanceLevel': { 'type': 'string', 'enum': ['RESTRICTED'] },
          'holderName': { 'type': 'string' },
          'holderUniqueId': { 'type': 'string' },
          'publicKey': { 'type': 'string' },
          'keyAlgorithm': { 'type': 'string' },
          'keyFingerprint': { 'type': 'string' },
          'issuedDate': { 'type': 'string', 'format': 'date' },
          'expiryDate': { 'type': 'string', 'format': 'date' },
          'clearanceId': { 'type': 'string' }
        },
        'required': ['clearanceLevel', 'holderName', 'holderUniqueId', 'publicKey', 'keyAlgorithm', 'keyFingerprint', 'issuedDate', 'expiryDate', 'clearanceId']
      }
    };
    
    console.log('📋 Sending Restricted schema definition:', JSON.stringify(schemaDefinition, null, 2));
    
    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(schemaDefinition)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Restricted schema creation failed:', errorText);
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }
    
    const schemaData = await response.json();
    console.log(`✅ Restricted Security Clearance schema created: ${schemaData.guid}`);
    
    res.json({
      success: true,
      schemaId: schemaData.guid,
      schemaData: schemaData
    });
  } catch (error) {
    console.error('❌ Error creating Restricted schema:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create RealPerson credential schema v4 (with photo support)
app.post('/api/schemas/create-realperson-v4', async (req, res) => {
  try {
    console.log('📋 Creating RealPerson v4 schema (with photo support)...');

    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'realperson-schema-v4.json');
    if (!fs.existsSync(schemaPath)) {
      throw new Error('realperson-schema-v4.json not found in server directory');
    }
    const schemaTemplate = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!didResponse.ok) throw new Error('Failed to fetch authority DIDs');

    const didData = await didResponse.json();
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const authorityDID = publishedDIDs.length > 0
      ? publishedDIDs[publishedDIDs.length - 1].did
      : (didData.contents.length > 0 ? didData.contents[didData.contents.length - 1].did : null);

    if (!authorityDID) throw new Error('No DID found. Please create and publish a DID first.');

    const schemaDefinition = {
      ...schemaTemplate,
      author: authorityDID,
      authored: new Date().toISOString()
    };

    console.log(`📋 Registering RealPerson v4 schema with DID: ${authorityDID.substring(0, 50)}...`);

    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify(schemaDefinition)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }

    const schemaData = await response.json();
    console.log(`✅ RealPerson v4 schema registered: ${schemaData.guid}`);

    res.json({ success: true, schemaId: schemaData.guid, schemaData });
  } catch (error) {
    console.error('❌ Error creating RealPerson v4 schema:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create RealPerson credential schema
app.post('/api/schemas/create-realperson', async (req, res) => {
  try {
    console.log('📋 Creating RealPerson credential schema...');
    
    // First, get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }
    
    const didData = await didResponse.json();
    // Use the newest (last) DID which should have assertionMethod key
    const authorityDID = didData.contents.length > 0 ? didData.contents[didData.contents.length - 1].did : null;
    
    if (!authorityDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }
    
    console.log(`📋 Using authority DID: ${authorityDID}`);
    
    // Schema definition from REALPERSON-SCHEMA.md
    const schemaDefinition = {
      name: 'RealPerson',
      version: '1.0.0',
      description: 'Simplified identity credential for real persons',
      type: 'https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json',
      author: authorityDID,
      authored: new Date().toISOString(),
      tags: ['identity', 'official'],
      schema: {
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
        '$id': 'https://certification-authority.org/schemas/RealPerson/1.0.0',
        'type': 'object',
        'properties': {
          'firstName': { 'type': 'string' },
          'lastName': { 'type': 'string' },
          'gender': { 'type': 'string' },
          'dateOfBirth': { 'type': 'string' },
          'uniqueId': { 'type': 'string' }
        },
        'required': ['firstName', 'lastName', 'gender', 'dateOfBirth', 'uniqueId']
      }
    };
    
    console.log('📋 Sending schema definition:', JSON.stringify(schemaDefinition, null, 2));
    
    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(schemaDefinition)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Schema creation failed:', errorText);
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }
    
    const schemaData = await response.json();
    console.log(`✅ RealPerson schema created: ${schemaData.guid}`);
    
    res.json({
      success: true,
      schemaId: schemaData.guid,
      schemaData: schemaData
    });
  } catch (error) {
    console.error('❌ Error creating schema:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create CA Authority Identity schema (self-issued organizational credential)
app.post('/api/schemas/create-ca-authority', async (req, res) => {
  try {
    console.log('📋 Creating CertificationAuthorityIdentity schema...');

    // Load schema definition from file
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'ca-authority-schema-v1.json');

    if (!fs.existsSync(schemaPath)) {
      throw new Error('CA Authority schema file not found');
    }

    const schemaTemplate = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // Get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }

    const didData = await didResponse.json();
    // Use the PUBLISHED DID as author (excluding photo DIDs which lack assertionMethod)
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const authorityDID = publishedDIDs.length > 0 ? publishedDIDs[0].did : null;

    if (!authorityDID) {
      throw new Error('No PUBLISHED DID found for Certification Authority. Please publish a DID first.');
    }

    console.log(`📋 Using authority DID: ${authorityDID}`);

    // Update schema with actual authority DID
    const schemaDefinition = {
      ...schemaTemplate,
      author: authorityDID,
      authored: new Date().toISOString()
    };

    console.log('📋 Registering CA Authority Identity schema with Cloud Agent...');

    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(schemaDefinition)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Schema creation failed:', errorText);
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }

    const schemaData = await response.json();
    console.log(`✅ CA Authority Identity schema created: ${schemaData.guid}`);

    res.json({
      success: true,
      schemaId: schemaData.guid,
      schemaData: schemaData,
      message: 'CertificationAuthorityIdentity schema registered successfully'
    });
  } catch (error) {
    console.error('❌ Error creating CA Authority schema:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Issue self-issued CA Authority Identity credential
app.post('/api/credentials/issue-ca-authority', async (req, res) => {
  try {
    console.log('🏛️ Issuing self-issued CA Authority Identity credential...');

    // Step 1: Get CA's published DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!didResponse.ok) {
      throw new Error('Failed to fetch CA DIDs');
    }

    const didData = await didResponse.json();
    const publishedDIDs = filterIssuingDIDs(didData.contents);

    if (publishedDIDs.length === 0) {
      throw new Error('No PUBLISHED DID found for CA. Please publish a DID first.');
    }

    const caDID = publishedDIDs[0].did;
    console.log(`🏛️ Using CA DID: ${caDID}`);

    // Step 2: Find CertificationAuthorityIdentity schema
    const schemasResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!schemasResponse.ok) {
      throw new Error('Failed to fetch schemas');
    }

    const schemasData = await schemasResponse.json();
    const caSchema = schemasData.contents.find(
      schema => schema.name === 'CertificationAuthorityIdentity' && schema.version === '1.0.0'
    );

    if (!caSchema) {
      throw new Error('CertificationAuthorityIdentity schema not found. Please create it first via POST /api/schemas/create-ca-authority');
    }

    console.log(`📋 Using schema: ${caSchema.guid}`);

    // Step 3: Auto-populate credential claims
    const issuedDate = new Date().toISOString().split('T')[0];
    const credentialId = `ca-authority-${Date.now()}`;

    const claims = {
      credentialType: 'CertificationAuthorityIdentity',
      organizationName: 'Hyperledger Identus Certification Authority',
      organizationType: 'Root Certification Authority',
      jurisdiction: 'Czech Republic',
      registrationNumber: 'CA-CZ-2025-001',
      establishedDate: '2025-01-01',
      website: 'https://identuslabel.cz',
      authorityLevel: 'Root Certificate Authority',
      authorizationScope: 'Issue and verify Verifiable Credentials for identity verification, security clearance, and organizational attestation within the Hyperledger Identus ecosystem',
      accreditationDate: '2025-01-01',
      accreditingBody: 'Self-Accredited',
      cloudAgentEndpoint: 'https://identuslabel.cz/cloud-agent',
      didcommEndpoint: 'https://identuslabel.cz/didcomm',
      mediatorEndpoint: 'https://identuslabel.cz/mediator',
      supportedProtocols: [
        'DIDComm v2',
        'W3C Verifiable Credentials',
        'StatusList2021',
        'X25519 Encryption'
      ],
      issuedDate: issuedDate,
      credentialId: credentialId
    };

    console.log('📋 Credential claims prepared');

    // Step 4: Create self-connection (CA connects to itself)
    // This is necessary because Cloud Agent requires a connectionId for credential issuance
    console.log('🔗 Creating self-connection for CA...');

    // Create OOB invitation from CA to itself
    const invitationResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'CA Self-Issuance Connection'
      })
    });

    if (!invitationResponse.ok) {
      throw new Error(`Failed to create self-invitation: ${await invitationResponse.text()}`);
    }

    const invitationData = await invitationResponse.json();
    const invitationUrl = invitationData.invitation.invitationUrl;
    console.log(`🔗 Created invitation: ${invitationData.invitationId}`);

    // Accept the invitation from CA's perspective (self-accept)
    const acceptResponse = await fetch(`${CLOUD_AGENT_URL}/connection-invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitation: invitationUrl
      })
    });

    if (!acceptResponse.ok) {
      throw new Error(`Failed to accept self-invitation: ${await acceptResponse.text()}`);
    }

    const acceptData = await acceptResponse.json();
    const connectionId = acceptData.connectionId;
    console.log(`🔗 Self-connection established: ${connectionId}`);

    // Wait for connection to reach active state
    console.log('⏳ Waiting for connection to become active...');
    let connectionReady = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!connectionReady && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      const connCheckResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (connCheckResponse.ok) {
        const connData = await connCheckResponse.json();
        console.log(`🔗 Connection state: ${connData.state}`);

        if (connData.state === 'ConnectionResponseSent' || connData.state === 'ConnectionResponseReceived') {
          connectionReady = true;
        }
      }

      attempts++;
    }

    if (!connectionReady) {
      throw new Error('Self-connection did not reach active state within timeout');
    }

    // Step 5: Issue credential via Cloud Agent
    console.log('📋 Issuing credential via Cloud Agent...');

    const credentialOffer = {
      connectionId: connectionId,
      issuingDID: caDID,
      claims: claims,
      credentialFormat: 'JWT',
      automaticIssuance: true, // Auto-approve for self-issuance
      schemaId: `${CLOUD_AGENT_URL}${caSchema.self}`
      // No validityPeriod = no expiration (permanent credential)
    };

    const issueResponse = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentialOffer)
    });

    if (!issueResponse.ok) {
      const errorText = await issueResponse.text();
      throw new Error(`Failed to issue credential: ${errorText}`);
    }

    const credentialData = await issueResponse.json();
    console.log(`✅ Credential issued: ${credentialData.recordId}`);

    // Step 6: Store credential metadata for public access
    const fs = require('fs');
    const path = require('path');
    const dataDir = path.join(__dirname, 'data');
    const credentialPath = path.join(dataDir, 'ca-authority-credential.json');

    const credentialMetadata = {
      recordId: credentialData.recordId,
      credentialType: 'CertificationAuthorityIdentity',
      issuer: caDID,
      subject: caDID,
      issuedDate: issuedDate,
      credentialId: credentialId,
      schemaId: caSchema.guid,
      claims: claims,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(credentialPath, JSON.stringify(credentialMetadata, null, 2));
    console.log(`💾 Credential metadata stored at: ${credentialPath}`);

    res.json({
      success: true,
      recordId: credentialData.recordId,
      credentialId: credentialId,
      issuer: caDID,
      subject: caDID,
      message: 'CA Authority Identity credential issued successfully',
      metadata: credentialMetadata
    });

  } catch (error) {
    console.error('❌ Error issuing CA Authority credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Public endpoint to retrieve CA Authority Identity credential
// This allows anyone to verify the CA's organizational identity and authority
app.get('/api/well-known/ca-authority', async (req, res) => {
  try {
    console.log('🔍 Public CA Authority credential requested');

    const fs = require('fs');
    const path = require('path');
    const credentialPath = path.join(__dirname, 'data', 'ca-authority-credential.json');

    // Check if credential exists
    if (!fs.existsSync(credentialPath)) {
      return res.status(404).json({
        success: false,
        error: 'CA Authority credential not found. Please issue the credential first via POST /api/credentials/issue-ca-authority'
      });
    }

    // Read credential data from file
    const credentialData = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));

    // The credential JWT is already stored in the file (issued by top-level issuer)
    if (!credentialData.credential) {
      return res.status(500).json({
        success: false,
        error: 'Credential JWT not found in file. Please re-issue the credential.'
      });
    }

    console.log('✅ CA Authority credential retrieved from file');

    // Return credential in standard format
    res.json({
      success: true,
      credential: credentialData.credential,
      metadata: {
        recordId: credentialData.recordId,
        credentialType: credentialData.credentialType,
        issuer: credentialData.issuerDID,
        subject: credentialData.holderDID,
        issuedDate: credentialData.issuedDate,
        credentialId: credentialData.credentialId,
        schemaId: credentialData.schemaId,
        architecture: credentialData.architecture
      },
      claims: credentialData.claims
    });

  } catch (error) {
    console.error('❌ Error retrieving CA Authority credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all schemas
app.get('/api/schemas', async (req, res) => {
  try {
    console.log('📋 Fetching credential schemas...');
    
    const response = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log(`✅ Found ${data.contents.length} schemas`);
    
    res.json({
      success: true,
      schemas: data.contents
    });
  } catch (error) {
    console.error('❌ Error fetching schemas:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create credential definition for RealPerson
app.post('/api/credential-definitions/create', async (req, res) => {
  try {
    const { schemaId } = req.body;
    
    console.log(`📋 Creating credential definition for schema: ${schemaId}`);
    
    // Get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }
    
    const didData = await didResponse.json();
    // Use the newest (last) DID which should have assertionMethod key
    const authorityDID = didData.contents.length > 0 ? didData.contents[didData.contents.length - 1].did : null;
    
    if (!authorityDID) {
      throw new Error('No DID found for Certification Authority');
    }

    const response = await fetch(`${CLOUD_AGENT_URL}/credential-definition-registry/definitions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'RealPerson Identity Credential',
        description: 'Official identity credential definition for real persons',
        version: '1.0.0',
        tag: 'official',
        author: authorityDID,
        schemaId: schemaId,
        signatureType: 'CL',
        supportRevocation: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const definitionData = await response.json();
    console.log(`✅ Credential definition created: ${definitionData.guid}`);
    
    res.json({
      success: true,
      definitionId: definitionData.guid,
      definitionData: definitionData
    });
  } catch (error) {
    console.error('❌ Error creating credential definition:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get connections for a specific user (by unique ID)
async function getUserConnections(holderUniqueId) {
  try {
    // First check if we have a stored mapping for this user
    if (global.userConnectionMappings && global.userConnectionMappings.has(holderUniqueId)) {
      const mapping = global.userConnectionMappings.get(holderUniqueId);
      console.log(`🔍 [DEBUG] Found stored connection mapping for ${holderUniqueId}: ${mapping.connectionId}`);
      
      // Verify the connection still exists and is active
      const response = await fetch(`${CLOUD_AGENT_URL}/connections/${mapping.connectionId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          }
      });
      
      if (response.ok) {
        const connection = await response.json();
        if (connection.state === 'ConnectionResponseSent' || 
            connection.state === 'ConnectionResponseReceived' || 
            connection.state === 'Active') {
          console.log(`✅ Using stored connection for ${holderUniqueId}: ${connection.connectionId}`);
          return connection;
        }
      }
    }
    
    // If no stored mapping or connection is invalid, try to find by label
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch connections: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`🔍 [DEBUG] Found ${data.contents.length} total connections in CA`);
    
    // Filter active connections
    const activeConnections = data.contents.filter(conn => 
      conn.state === 'ConnectionResponseSent' || 
      conn.state === 'ConnectionResponseReceived' || 
      conn.state === 'Active'
    );
    
    console.log(`🔍 [DEBUG] Found ${activeConnections.length} active connections`);
    
    // Try to find connection by user's unique ID in the label
    const userConnection = activeConnections.find(conn => 
      conn.label && conn.label.includes(holderUniqueId)
    );
    
    if (userConnection) {
      console.log(`✅ Found connection by unique ID in label: ${userConnection.connectionId}`);
      // Store this mapping for future use and persist to disk
      global.userConnectionMappings.set(holderUniqueId, {
        connectionId: userConnection.connectionId,
        registeredAt: new Date().toISOString()
      });
      saveUserMappings(global.userConnectionMappings);
      return userConnection;
    }
    
    // No specific connection found for this user
    console.log(`⚠️ No specific connection found for user ${holderUniqueId}`);
    return null;
    
  } catch (error) {
    console.error('Error getting user connections:', error);
    return null;
  }
}

// Issue Confidential Security Clearance credential
app.post('/api/credentials/issue-confidential-clearance', async (req, res) => {
  try {
    const { 
      connectionId,
      holderPersonalInfo
    } = req.body;
    
    // ✅ ENHANCED: Use improved connection resolution
    let actualConnectionId;
    try {
      actualConnectionId = await resolveConnectionId(holderPersonalInfo, connectionId);
      console.log(`🎯 [CONFIDENTIAL] Resolved connection: ${actualConnectionId}`);
    } catch (error) {
      console.error(`❌ [CONFIDENTIAL] Connection resolution failed:`, error);
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    if (connectionId && connectionId.trim() && connectionId !== 'undefined') {
      // Use explicitly provided connection ID
      actualConnectionId = connectionId;
      console.log(`🎯 Using explicitly provided connection: ${actualConnectionId}`);

      // Validate the connection exists and is active
      const connectionCheckResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${actualConnectionId}`, {
        headers: {}
      });

      if (connectionCheckResponse.ok) {
        const connectionData = await connectionCheckResponse.json();
        console.log(`📊 Explicit connection state: ${connectionData.state}`);

        // Update or create user mapping with explicit connection and persist to disk
        global.userConnectionMappings.set(holderPersonalInfo.uniqueId, {
          connectionId: actualConnectionId,
          holderInfo: holderPersonalInfo,
          registeredAt: new Date().toISOString(),
          explicitConnection: true
        });
        saveUserMappings(global.userConnectionMappings);
      } else {
        return res.status(400).json({
          success: false,
          error: `Invalid connection ID provided: ${actualConnectionId}`
        });
      }
    } else {
      // Fallback to existing logic for backward compatibility
      const userMapping = global.userConnectionMappings.get(holderPersonalInfo.uniqueId);

      if (!userMapping) {
        console.log(`⚠️ No connection mapping found for user: ${holderPersonalInfo.uniqueId}, searching for available CA connections...`);

        // Get CA's connections to find a suitable one
        const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
          headers: {}
        });

        if (connectionsResponse.ok) {
          const connectionsData = await connectionsResponse.json();
          const activeConnections = connectionsData.contents?.filter(conn =>
            conn.state === 'ConnectionResponseReceived' ||
            conn.state === 'ConnectionResponseSent' ||
            conn.state === 'Active'
          );

          if (activeConnections && activeConnections.length > 0) {
            // Use the most recent connection
            const sortedConnections = activeConnections.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            actualConnectionId = sortedConnections[0].connectionId;
            console.log(`🔗 Using CA connection: ${actualConnectionId} (${sortedConnections[0].state})`);

            // Create mapping with real connection and persist to disk
            global.userConnectionMappings.set(holderPersonalInfo.uniqueId, {
              connectionId: actualConnectionId,
              holderInfo: holderPersonalInfo,
              registeredAt: new Date().toISOString()
            });
            saveUserMappings(global.userConnectionMappings);
          }
        }

        if (!actualConnectionId) {
          return res.status(400).json({
            success: false,
            error: 'No active DIDComm connections found. Please establish a connection with the wallet first.'
          });
        }
      } else {
        actualConnectionId = userMapping.connectionId;
      }
    }
    
    console.log(`🔐 Issuing Confidential Security Clearance to user ${holderPersonalInfo.uniqueId}`);
    console.log(`🔗 Using user's mapped connection: ${actualConnectionId}`);
    
    // Check connection state before issuing
    const connectionCheckResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${actualConnectionId}`, {
      headers: {
      }
    });
    
    if (connectionCheckResponse.ok) {
      const connectionData = await connectionCheckResponse.json();
      console.log(`📊 Connection state: ${connectionData.state}`);
      
      // If connection is not active, wait or return error
      if (connectionData.state === 'InvitationGenerated' || connectionData.state === 'InvitationReceived') {
        return res.status(400).json({
          success: false,
          error: 'DIDComm connection not yet established. The wallet needs to complete the connection handshake. Please wait a few seconds and try again.'
        });
      }
    }

    // Accept clearanceLevel from body or holderPersonalInfo, default to CONFIDENTIAL
    const selectedClearanceLevel = (req.body.clearanceLevel || holderPersonalInfo.clearanceLevel || 'CONFIDENTIAL').toUpperCase();
    const validLevels = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
    const effectiveClearanceLevel = validLevels.includes(selectedClearanceLevel) ? selectedClearanceLevel : 'CONFIDENTIAL';

    // Generate Ed25519 + X25519 keypairs for Security Clearance credential
    const edKeypair = generateEd25519Keypair();
    const xKeypair = generateX25519Keypair();
    const publicKey = edKeypair.publicKey;
    const privateKey = edKeypair.privateKey;

    // Generate unique clearance ID
    const timestamp = Date.now().toString();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const clearanceId = `${effectiveClearanceLevel.substring(0, 4)}-${timestamp}-${randomSuffix}`;

    const expiryYearsMap = { INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, SECRET: 5 };
    const issuedDate = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + (expiryYearsMap[effectiveClearanceLevel] || 2));

    const fingerprint = generateEd25519Fingerprint(publicKey);
    const x25519Fingerprint = generateX25519Fingerprint(xKeypair.publicKey);
    global.securityPublicKeys.set(clearanceId, {
      publicKey: publicKey,
      fingerprint: fingerprint,
      algorithm: 'Ed25519',
      clearanceLevel: effectiveClearanceLevel,
      holderUniqueId: holderPersonalInfo.uniqueId
    });

    // Get the authority's DID for credential issuance
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs for credential issuance');
    }

    const didData = await didResponse.json();
    // Filter for published DIDs only (excluding photo DIDs which lack assertionMethod keys)
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const issuingDID = publishedDIDs.length > 0 ? publishedDIDs[publishedDIDs.length - 1].did : null;

    if (!issuingDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }

    const credentialData = {
      credentialType: 'SecurityClearance',
      clearanceLevel: effectiveClearanceLevel,
      holderName: `${holderPersonalInfo.firstName} ${holderPersonalInfo.lastName}`,
      holderUniqueId: holderPersonalInfo.uniqueId,
      ed25519PublicKey: publicKey,
      ed25519Fingerprint: fingerprint,
      x25519PublicKey: xKeypair.publicKey,
      x25519Fingerprint: x25519Fingerprint,
      issuedDate: issuedDate.toISOString().split('T')[0],
      expiryDate: expiryDate.toISOString().split('T')[0],
      clearanceId: clearanceId
    };
    
    // Get the unified Security Clearance schema
    const schemasResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: {
      }
    });

    if (!schemasResponse.ok) {
      throw new Error('Failed to fetch schemas');
    }

    const schemasData = await schemasResponse.json();
    const allClearanceSchemas = schemasData.contents.filter(schema =>
      schema.name === 'SecurityClearanceLevel'
    );
    const securityClearanceSchema = allClearanceSchemas.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    )[0];

    if (!securityClearanceSchema) {
      throw new Error('SecurityClearanceLevel schema not found. Please create the schema first.');
    }

    const credentialOffer = {
      connectionId: actualConnectionId,
      credentialFormat: 'JWT',
      claims: credentialData,
      automaticIssuance: false,  // Allow manual review and acceptance
      issuingDID: issuingDID,
      schemaId: `${CLOUD_AGENT_URL}${securityClearanceSchema.self}`
    };

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });

    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }

    const offerData = await response.json();
    console.log(`✅ Confidential Security Clearance offered: ${offerData.recordId}`);
    
    res.json({
      success: true,
      recordId: offerData.recordId,
      thid: offerData.thid,
      credentialData: credentialData,
      clearanceId: clearanceId,
      ed25519PublicKey: publicKey,
      ed25519PrivateKey: privateKey,  // ⚠️ User must securely store this!
      x25519PublicKey: xKeypair.publicKey,
      x25519PrivateKey: xKeypair.privateKey,  // ⚠️ User must securely store this!
      message: `${effectiveClearanceLevel} Security Clearance issued successfully`
    });
  } catch (error) {
    console.error('❌ Error issuing clearance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Issue Restricted Security Clearance credential
app.post('/api/credentials/issue-restricted-clearance', async (req, res) => {
  try {
    const { 
      connectionId,
      holderPersonalInfo
    } = req.body;
    
    // ✅ ENHANCED: Use resolveConnectionId helper function for robust connection resolution
    let actualConnectionId;
    try {
      actualConnectionId = await resolveConnectionId(holderPersonalInfo, connectionId);
      console.log(`🔗 [RESTRICTED CLEARANCE] Final resolved connection ID: ${actualConnectionId}`);
    } catch (error) {
      console.error(`❌ [RESTRICTED CLEARANCE] Connection resolution failed:`, error);
      return res.status(400).json({
        success: false,
        error: `Unable to resolve connection for Security Clearance issuance: ${error.message}`
      });
    }

    console.log(`🔐 Issuing Restricted Security Clearance to user ${holderPersonalInfo.uniqueId}`);
    console.log(`🔗 Using user's mapped connection: ${actualConnectionId}`);
    
    // Accept clearanceLevel from body or holderPersonalInfo
    const selectedClearanceLevel = (req.body.clearanceLevel || holderPersonalInfo.clearanceLevel || 'RESTRICTED').toUpperCase();
    const validLevels = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
    const effectiveClearanceLevel = validLevels.includes(selectedClearanceLevel) ? selectedClearanceLevel : 'RESTRICTED';

    // Generate Ed25519 + X25519 keypairs
    const edKeypair = generateEd25519Keypair();
    const xKeypair = generateX25519Keypair();
    const publicKey = edKeypair.publicKey;
    const privateKey = edKeypair.privateKey;

    const timestamp = Date.now().toString();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const clearanceId = `${effectiveClearanceLevel.substring(0, 4)}-${timestamp}-${randomSuffix}`;

    const expiryYearsMap = { INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, SECRET: 5 };
    const issuedDate = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + (expiryYearsMap[effectiveClearanceLevel] || 3));

    const fingerprint = generateEd25519Fingerprint(publicKey);
    const x25519Fingerprint = generateX25519Fingerprint(xKeypair.publicKey);
    global.securityPublicKeys.set(clearanceId, {
      publicKey: publicKey,
      fingerprint: fingerprint,
      algorithm: 'Ed25519',
      clearanceLevel: effectiveClearanceLevel,
      holderUniqueId: holderPersonalInfo.uniqueId
    });

    // Get the authority's DID for credential issuance
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs for credential issuance');
    }

    const didData = await didResponse.json();
    // Filter for published DIDs only (excluding photo DIDs which lack assertionMethod keys)
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const issuingDID = publishedDIDs.length > 0 ? publishedDIDs[publishedDIDs.length - 1].did : null;

    if (!issuingDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }

    const credentialData = {
      credentialType: 'SecurityClearance',
      clearanceLevel: effectiveClearanceLevel,
      holderName: `${holderPersonalInfo.firstName} ${holderPersonalInfo.lastName}`,
      holderUniqueId: holderPersonalInfo.uniqueId,
      ed25519PublicKey: publicKey,
      ed25519Fingerprint: fingerprint,
      x25519PublicKey: xKeypair.publicKey,
      x25519Fingerprint: x25519Fingerprint,
      issuedDate: issuedDate.toISOString().split('T')[0],
      expiryDate: expiryDate.toISOString().split('T')[0],
      clearanceId: clearanceId
    };

    // Get the unified Security Clearance schema
    const schemasResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: {
      }
    });

    if (!schemasResponse.ok) {
      throw new Error('Failed to fetch schemas');
    }

    const schemasData = await schemasResponse.json();
    const allClearanceSchemas = schemasData.contents.filter(schema =>
      schema.name === 'SecurityClearanceLevel'
    );
    const securityClearanceSchema = allClearanceSchemas.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    )[0];

    if (!securityClearanceSchema) {
      throw new Error('SecurityClearanceLevel schema not found. Please create the schema first.');
    }

    const credentialOffer = {
      connectionId: actualConnectionId,
      credentialFormat: 'JWT',
      claims: credentialData,
      automaticIssuance: false,  // Allow manual review and acceptance
      issuingDID: issuingDID,
      schemaId: `${CLOUD_AGENT_URL}${securityClearanceSchema.self}`
    };

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });

    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }

    const offerData = await response.json();
    console.log(`✅ Restricted Security Clearance offered: ${offerData.recordId}`);
    
    res.json({
      success: true,
      recordId: offerData.recordId,
      thid: offerData.thid,
      credentialData: credentialData,
      clearanceId: clearanceId,
      ed25519PublicKey: publicKey,
      ed25519PrivateKey: privateKey,  // ⚠️ User must securely store this!
      x25519PublicKey: xKeypair.publicKey,
      x25519PrivateKey: xKeypair.privateKey,  // ⚠️ User must securely store this!
      message: `${effectiveClearanceLevel} Security Clearance issued successfully`
    });
  } catch (error) {
    console.error('❌ Error issuing clearance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Issue RealPerson credential
app.post('/api/credentials/issue-realperson', async (req, res) => {
  try {
    const {
      connectionId,
      credentialData,
      selectedDID,
      selectedSchemaGuid,
      photo
    } = req.body;
    
    console.log(`🎫 Issuing RealPerson credential to connection: ${connectionId}`);
    console.log(`🆔 Using DID: ${selectedDID || 'auto-selected'}`);
    console.log(`📋 Using Schema: ${selectedSchemaGuid || 'auto-selected'}`);
    
    // Generate unique CA ID
    const timestamp = Date.now().toString();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    credentialData.uniqueId = `CA-${timestamp}-${randomSuffix}`;
    
    // Use selected DID or fall back to automatic selection
    let issuingDID = selectedDID;
    
    if (!issuingDID) {
      // Get the authority's DID for credential issuance
      const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      if (!didResponse.ok) {
        throw new Error('Failed to fetch authority DIDs for credential issuance');
      }
      
      const didData = await didResponse.json();
      // Filter for published DIDs only (excluding photo DIDs which lack assertionMethod)
      const publishedDIDs = filterIssuingDIDs(didData.contents);
      // Use the first published DID which is known to work for credential issuance
      const workingDID = 'did:prism:976a9472646282e667c2536e1d202620cf3b78a06693d67c277b33d2afbcfca4';
      issuingDID = publishedDIDs.find(did => did.did === workingDID)?.did || 
                   (publishedDIDs.length > 0 ? publishedDIDs[0].did : null);
    }
    
    if (!issuingDID) {
      throw new Error('No DID selected and no DID found for Certification Authority. Please select a DID or create and publish one first.');
    }
    
    // Use selected schema or fall back to automatic selection
    let realPersonSchema = null;
    
    if (selectedSchemaGuid) {
      // Find the selected schema
      const schemaResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY,
        }
      });
      
      if (schemaResponse.ok) {
        const schemaData = await schemaResponse.json();
        realPersonSchema = schemaData.contents.find(schema => schema.guid === selectedSchemaGuid);
      }
      
      if (!realPersonSchema) {
        throw new Error(`Selected schema with GUID ${selectedSchemaGuid} not found.`);
      }
    } else {
      // Get the RealPerson schema ID automatically
      const schemaResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY,
        }
      });
      
      if (!schemaResponse.ok) {
        throw new Error('Failed to fetch schemas');
      }
      
      const schemaData = await schemaResponse.json();
      // Find all RealPerson schemas; prefer v4.0.0 when photo is present, otherwise v3.0.0
      const realPersonSchemas = schemaData.contents.filter(schema => schema.name === 'RealPerson');
      const preferredVersion = photo ? '4.0.0' : '3.0.0';
      realPersonSchema = realPersonSchemas.find(schema => schema.version === preferredVersion)
                      || realPersonSchemas.find(schema => schema.version === '3.0.0')
                      || realPersonSchemas[realPersonSchemas.length - 1];
      
      if (!realPersonSchema) {
        throw new Error('RealPerson schema not found. Please create the schema first.');
      }
    }
    
    console.log(`📋 Using RealPerson schema v${realPersonSchema.version}: ${realPersonSchema.guid}`);

    // Generate auto-populated metadata
    const issuedDate = new Date().toISOString().split('T')[0];
    const expiryDate = new Date(Date.now() + 63072000000).toISOString().split('T')[0]; // 2 years
    const credentialId = `REALPERSON-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    // Handle photo: upload to Iagon → create photo PRISM DID → store DID reference in VC
    let photoDIDRef = null;
    if (photo) {
      try {
        const uniqueId = credentialData.uniqueId;

        // Reuse existing photo DID if one exists for this uniqueId
        if (photoDIDs[uniqueId]) {
          photoDIDRef = photoDIDs[uniqueId].photoDID;
          console.log(`📸 Reusing existing photo DID for ${uniqueId}: ${photoDIDRef.substring(0, 60)}...`);
        } else {
          // 1. Upload photo to Iagon (raw JPEG bytes, no encryption)
          const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');
          const iagonFileId = await uploadPhotoToIagon(buffer, `photo-${uniqueId}-${Date.now()}.jpg`);
          const proxyUrl = `${PUBLIC_BASE_URL}/photo-proxy/${iagonFileId}`;

          // 2. Create PRISM DID with #photo service endpoint
          const didCreateResp = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
            body: JSON.stringify({
              documentTemplate: {
                publicKeys: [{ id: 'auth-0', purpose: 'authentication' }],
                services: [{
                  id: 'photo',
                  type: 'LinkedPhoto',
                  serviceEndpoint: proxyUrl
                }]
              }
            })
          });
          if (!didCreateResp.ok) throw new Error(`DID create failed: ${await didCreateResp.text()}`);
          const didData = await didCreateResp.json();
          const longFormDid = didData.longFormDid;

          // 3. Publish to blockchain (async fire-and-forget)
          fetch(`${CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': API_KEY }
          }).then(r => console.log(`📸 [PHOTO-DID] Published: ${r.status}`))
            .catch(e => console.warn(`⚠️ [PHOTO-DID] Publish error (non-fatal): ${e.message}`));

          // 4. Store mapping
          photoDIDs[uniqueId] = { photoDID: longFormDid, iagonFileId, proxyUrl, createdAt: new Date().toISOString() };
          savePhotoDIDs();
          photoDIDRef = longFormDid;
          console.log(`📸 [PHOTO-DID] Created for ${uniqueId}: ${longFormDid.substring(0, 60)}...`);
        }
      } catch (photoErr) {
        console.error('❌ [PHOTO-DID] Photo processing failed (issuing VC without photo):', photoErr.message);
        photoDIDRef = null;
      }
    }

    const enrichedClaims = {
      ...credentialData,
      credentialType: 'RealPersonIdentity',
      issuedDate: issuedDate,
      expiryDate: expiryDate,
      credentialId: credentialId,
      ...(photoDIDRef ? { photo: photoDIDRef } : {})
    };

    // Create credential offer using Cloud Agent documented API structure
    const credentialOffer = {
      // REQUIRED fields
      connectionId: connectionId,
      issuingDID: issuingDID,  // From dropdown selection or auto-selected
      claims: enrichedClaims,

      // OPTIONAL fields
      credentialFormat: 'JWT',
      automaticIssuance: false,  // Require manual approval
      schemaId: `${CLOUD_AGENT_URL}${realPersonSchema.self}`,
      validityPeriod: 63072000  // 2 years in seconds (will set JWT exp claim)
    };

    console.log('📤 Sending credential offer to Cloud Agent:', JSON.stringify(credentialOffer, null, 2));

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }
    
    const offerData = await response.json();
    console.log(`✅ RealPerson credential offered: ${offerData.recordId}`);

    // Store uniqueId → connectionId mapping immediately for authentication lookups
    // This prevents the need for credential-based name discovery which can return wrong connections
    global.userConnectionMappings.set(credentialData.uniqueId, {
      connectionId: connectionId,
      holderInfo: {
        firstName: credentialData.firstName,
        lastName: credentialData.lastName,
        uniqueId: credentialData.uniqueId,
        dateOfBirth: credentialData.dateOfBirth,
        gender: credentialData.gender,
        ...(photoDIDRef ? { photo: photoDIDRef } : {})
      },
      registeredAt: new Date().toISOString()
    });
    saveUserMappings(global.userConnectionMappings);
    console.log(`🔗 Stored connection mapping: ${credentialData.uniqueId} → ${connectionId}`);

    res.json({
      success: true,
      recordId: offerData.recordId,
      thid: offerData.thid,
      credentialData: credentialData,
      issuedDate,
      expiryDate,
      photoDID: photoDIDRef || null,
      message: 'RealPerson credential issued successfully'
    });
  } catch (error) {
    console.error('❌ Error issuing credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get issued credentials
app.get('/api/credentials/issued', async (req, res) => {
  try {
    console.log('📋 Fetching issued credentials...');

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });

    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();

    // Filter for CredentialSent state (issued credentials)
    const issuedCredentials = data.contents.filter(record =>
      record.protocolState === 'CredentialSent'
    );

    console.log(`✅ Found ${data.contents.length} total credential records, ${issuedCredentials.length} issued (CredentialSent)`);

    res.json({
      success: true,
      contents: issuedCredentials
    });
  } catch (error) {
    console.error('❌ Error fetching credentials:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all revocable credentials (credentials with credentialStatusId)
app.get('/api/credentials/revocable', async (req, res) => {
  try {
    console.log('📋 [REVOCATION] Fetching revocable credentials...');

    // Paginate through all records (cloud agent default limit is 100)
    let allContents = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records?limit=${pageSize}&offset=${offset}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY,
        }
      });
      if (!response.ok) {
        throw new Error(`Cloud Agent responded with ${response.status}: ${await response.text()}`);
      }
      const page = await response.json();
      const contents = page.contents || [];
      allContents = allContents.concat(contents);
      if (contents.length < pageSize) break;
      offset += pageSize;
    }
    const data = { contents: allContents };

    // Filter for credentials that have credentialStatus in the JWT (revocable credentials)
    // Also filter for CredentialSent or CredentialRevoked states
    const revocableCredentials = data.contents.filter(record => {
      const isRelevantState = ['CredentialSent', 'CredentialRevoked'].includes(record.protocolState);

      // If not in relevant state, skip
      if (!isRelevantState || !record.credential) {
        return false;
      }

      try {
        // Decode base64 JWT to get the payload
        const jwtBase64 = record.credential;
        const jwtString = Buffer.from(jwtBase64, 'base64').toString('utf-8');
        const payload = jwtString.split('.')[1];
        const decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));

        // Check if the VC contains credentialStatus property
        const hasCredentialStatus = decodedPayload.vc && decodedPayload.vc.credentialStatus;

        if (hasCredentialStatus) {
          // Attach credentialStatus info to the record for easier access in UI
          record.credentialStatusId = decodedPayload.vc.credentialStatus.id;
          record.statusListIndex = decodedPayload.vc.credentialStatus.statusListIndex;
          record.statusListCredential = decodedPayload.vc.credentialStatus.statusListCredential;
          // Attach subject fields for update UI
          const subj = decodedPayload.vc.credentialSubject || {};
          record.uniqueId = subj.uniqueId || null;
          record.credentialType = subj.credentialType || null;
          record.holderLastName = subj.lastName || null;
          record.holderFirstName = subj.firstName || null;
        }

        return hasCredentialStatus;
      } catch (err) {
        console.error(`⚠️ [REVOCATION] Failed to decode credential ${record.recordId}:`, err.message);
        return false;
      }
    });

    console.log(`✅ [REVOCATION] Found ${data.contents.length} total credential records, ${revocableCredentials.length} revocable`);

    // Transform data to return only relevant fields
    const transformedCredentials = revocableCredentials.map(record => ({
      recordId: record.recordId,
      subjectId: record.subjectId,
      protocolState: record.protocolState,
      credentialStatusId: record.credentialStatusId,
      claims: record.claims || {},
      issuedAt: record.createdAt,
      updatedAt: record.updatedAt,
      schemaId: record.schemaId,
      connectionId: record.connectionId,
      uniqueId: record.uniqueId || null,
      credentialType: record.credentialType || null,
      holderFirstName: record.holderFirstName || null,
      holderLastName: record.holderLastName || null
    }));

    res.json({
      success: true,
      contents: transformedCredentials,
      count: transformedCredentials.length
    });
  } catch (error) {
    console.error('❌ [REVOCATION] Error fetching revocable credentials:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch revocable credentials',
      details: error.message
    });
  }
});

// Create secure user session (prevents race conditions in authentication)
app.post('/api/auth/create-session', (req, res) => {
  try {
    // Generate cryptographically secure session ID
    const sessionId = crypto.randomUUID();
    const sessionData = {
      sessionId: sessionId,
      createdAt: new Date().toISOString(),
      userAgent: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
      challenges: [],  // Track challenges created by this session
      authenticated: false,
      userData: null
    };
    
    // Store session securely
    global.userSessions.set(sessionId, sessionData);
    
    console.log(`🔐 Created secure session: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId: sessionId,
      message: 'Secure session created for authentication'
    });
    
    // Clean up old sessions (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const [id, session] of global.userSessions.entries()) {
      if (new Date(session.createdAt) < oneHourAgo) {
        global.userSessions.delete(id);
        console.log(`🧹 Cleaned up expired session: ${id}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error creating session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create verification invitation (QR code approach - uses existing DIDComm if available)
// ⚠️ DEPRECATED: Old connectionless QR code endpoint removed
// Use /api/auth/didcomm/initiate instead for secure DIDComm Present Proof authentication

// Register user-connection mapping during authentication
app.post('/api/auth/register-connection', async (req, res) => {
  try {
    const { userUniqueId, connectionId, holderInfo, presentationId } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [REGISTER-CONNECTION] ENDPOINT CALLED`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   📋 User Unique ID: ${userUniqueId}`);
    console.log(`   🔗 Connection ID (from request): ${connectionId}`);
    console.log(`   👤 Holder Info: ${holderInfo ? `${holderInfo.firstName} ${holderInfo.lastName}` : 'N/A'}`);
    console.log(`   📝 Presentation ID: ${presentationId || 'N/A'}`);
    console.log(`   ⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    // Validation: Check if connectionId is valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (connectionId && connectionId !== 'unknown' && !uuidRegex.test(connectionId)) {
      console.warn(`⚠️ [REGISTER-CONNECTION] ConnectionId is not a valid UUID: ${connectionId}`);
      console.warn(`   This may be a DID-based identifier that needs resolution`);
    }

    // Try to find the specific connection for this user
    let actualConnectionId = connectionId;
    
    // If we already have a mapping for this user, use it
    if (global.userConnectionMappings && global.userConnectionMappings.has(userUniqueId)) {
      const existingMapping = global.userConnectionMappings.get(userUniqueId);
      console.log(`🔗 Found existing connection mapping for ${userUniqueId}: ${existingMapping.connectionId}`);
      actualConnectionId = existingMapping.connectionId;
    } else if (connectionId && connectionId !== 'unknown' && connectionId !== 'wallet-submission') {
      // First try to resolve DID-based connection identifier to Cloud Agent UUID
      console.log(`🔗 Processing connection identifier from wallet: ${connectionId.substring(0, 50)}...`);

      const resolvedConnectionId = await resolveDIDToConnectionId(connectionId);

      if (resolvedConnectionId) {
        // Verify the resolved connection ID exists on Cloud Agent
        console.log(`🔗 Verifying resolved connection ID: ${resolvedConnectionId}`);

        const connCheckResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${resolvedConnectionId}`, {
          headers: { 'apikey': API_KEY }
        });

        if (connCheckResponse.ok) {
          console.log(`✅ Resolved connection ID ${resolvedConnectionId} is valid`);
          actualConnectionId = resolvedConnectionId;
        } else {
          console.log(`⚠️ Resolved connection ID ${resolvedConnectionId} does not exist on CA's agent, will search for alternative`);
          actualConnectionId = null; // Force search for valid connection
        }
      } else {
        console.log(`⚠️ Could not resolve DID-based connection identifier: ${connectionId.substring(0, 50)}...`);
        actualConnectionId = null; // Force search for valid connection
      }
    }
    
    // If we don't have a valid connection yet, search for one
    if (!actualConnectionId || actualConnectionId === null || actualConnectionId === 'unknown') {
      console.log(`🔍 Searching for active connections to find Alice's connection...`);
      
      const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
        headers: { 'apikey': API_KEY }
      });
      
      if (connectionsResponse.ok) {
        const connectionsData = await connectionsResponse.json();
        
        // Try to find a connection that matches the holder's name or recent connections
        // Sort by creation date to get the most recent connection
        // CRITICAL: Only use connections that are in proper states for credential issuance
        const sortedConnections = connectionsData.contents
          ?.filter(conn => {
            const validStates = ['ConnectionResponseReceived', 'ConnectionResponseSent', 'Active'];
            const isValidState = validStates.includes(conn.state);

            if (!isValidState) {
              console.log(`❌ Filtering out connection ${conn.connectionId} in invalid state: ${conn.state}`);
            } else {
              console.log(`✅ Valid connection found: ${conn.connectionId} (${conn.state}) - ${conn.label || 'no label'}`);
            }

            return isValidState;
          })
          ?.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        if (sortedConnections && sortedConnections.length > 0) {
          // Look for a connection with matching label if holder info is provided
          let matchingConnection = null;
          if (holderInfo && holderInfo.firstName && holderInfo.lastName) {
            const holderName = `${holderInfo.firstName} ${holderInfo.lastName}`;
            matchingConnection = sortedConnections.find(conn => 
              conn.label && conn.label.toLowerCase().includes(holderName.toLowerCase())
            );
          }
          
          // Use matching connection or the most recent one
          const selectedConnection = matchingConnection || sortedConnections[0];
          actualConnectionId = selectedConnection.connectionId;
          console.log(`🔗 Selected connection: ${actualConnectionId} (${selectedConnection.state}, label: ${selectedConnection.label || 'no label'})`);
        }
      }
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔗 [REGISTER-CONNECTION] STORING MAPPING`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   📋 User Unique ID: ${userUniqueId}`);
    console.log(`   🔗 Connection ID: ${actualConnectionId}`);
    console.log(`   👤 Holder Info: ${holderInfo ? JSON.stringify(holderInfo) : 'N/A'}`);
    console.log(`   ⏰ Registered At: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    // Store the mapping with the real DIDComm connection ID and persist to disk
    global.userConnectionMappings.set(userUniqueId, {
      connectionId: actualConnectionId,
      holderInfo: holderInfo,
      registeredAt: new Date().toISOString()
    });
    saveUserMappings(global.userConnectionMappings);

    // Log current state of all mappings for debugging
    console.log(`\n📊 [REGISTER-CONNECTION] Current User-Connection Mappings:`);
    for (const [userId, mapping] of global.userConnectionMappings.entries()) {
      console.log(`   ${userId} → ${mapping.connectionId} (${mapping.holderInfo?.firstName} ${mapping.holderInfo?.lastName})`);
    }
    console.log(``);

    console.log(`✅ [REGISTER-CONNECTION] Mapping successfully registered for user: ${userUniqueId}\n`);

    res.json({
      success: true,
      message: 'User-connection mapping registered successfully'
    });
    
  } catch (error) {
    console.error('❌ Error registering connection mapping:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get user's connection information
app.get('/api/user-connection/:uniqueId', async (req, res) => {
  try {
    const { uniqueId } = req.params;

    console.log(`🔗 Looking up connection for user: ${uniqueId}`);

    // ✅ ENHANCED: Use resolveConnectionId to find real connection
    let actualConnectionId;
    try {
      // Create minimal holderPersonalInfo object for resolveConnectionId
      const holderPersonalInfo = { uniqueId };
      actualConnectionId = await resolveConnectionId(holderPersonalInfo);
      console.log(`🔗 [USER-CONNECTION API] Resolved connection ID: ${actualConnectionId}`);
    } catch (error) {
      console.error(`❌ [USER-CONNECTION API] Connection resolution failed for user ${uniqueId}:`, error);
      return res.status(404).json({
        success: false,
        error: `No active DIDComm connection found for user: ${uniqueId}`
      });
    }

    // If we have a real connection ID, fetch it from Cloud Agent
    const response = await fetch(`${CLOUD_AGENT_URL}/connections/${actualConnectionId}`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });
    
    if (response.ok) {
      const connection = await response.json();
      return res.json({
        success: true,
        connections: [connection]
      });
    } else {
      // Return virtual connection if lookup fails
      return res.json({
        success: true,
        connections: [{
          connectionId: 'virtual-connection-' + uniqueId,
          state: 'Active',
          label: 'User Wallet Connection',
          role: 'Inviter',
          createdAt: new Date().toISOString()
        }]
      });
    }
  } catch (error) {
    console.error('❌ Error getting user connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// NEW: SECURE DIDCOMM PRESENT PROOF AUTHENTICATION ENDPOINTS
// ============================================================================

// Global state for DIDComm proof requests
global.proofRequests = global.proofRequests || new Map(); // proofId -> {proofId, connectionId, challenge, domain, sessionId, createdAt, status}
global.rateLimits = global.rateLimits || new Map(); // identifier -> {count, resetAt}

/**
 * POST /api/auth/didcomm/initiate
 * Create DIDComm Present Proof request for authentication
 * Security: Uses Cloud Agent's present-proof protocol with challenge/domain binding
 */
app.post('/api/auth/didcomm/initiate', async (req, res) => {
  try {
    const { identifier, sessionId } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [DIDCOMM-AUTH-INITIATE] Starting DIDComm Present Proof authentication`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   📋 Identifier: ${identifier}`);
    console.log(`   🔑 Session ID: ${sessionId ? sessionId.substring(0, 12) + '...' : 'N/A'}`);
    console.log(`   ⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    // 1. Validate session exists
    if (!sessionId || !global.userSessions || !global.userSessions.has(sessionId)) {
      console.error(`❌ [DIDCOMM-AUTH] Invalid or expired session: ${sessionId}`);
      return res.status(401).json({
        success: false,
        error: 'InvalidSession',
        message: 'Session not found or expired. Please refresh and try again.'
      });
    }

    const session = global.userSessions.get(sessionId);

    // 2. Prevent re-authentication of already authenticated sessions
    if (session.authenticated) {
      console.warn(`⚠️ [DIDCOMM-AUTH] Session already authenticated: ${sessionId}`);
      return res.status(409).json({
        success: false,
        error: 'AlreadyAuthenticated',
        message: 'This session is already authenticated.'
      });
    }

    // 3. Rate limiting: max 5 proof requests per minute per identifier
    const now = Date.now();
    if (!global.rateLimits.has(identifier)) {
      global.rateLimits.set(identifier, { count: 0, resetAt: now + 60000 });
    }

    const rateLimit = global.rateLimits.get(identifier);
    if (now > rateLimit.resetAt) {
      // Reset counter
      rateLimit.count = 0;
      rateLimit.resetAt = now + 60000;
    }

    if (rateLimit.count >= 5) {
      console.warn(`⚠️ [DIDCOMM-AUTH] Rate limit exceeded for identifier: ${identifier}`);
      return res.status(429).json({
        success: false,
        error: 'RateLimitExceeded',
        message: 'Too many authentication attempts. Please wait 1 minute and try again.'
      });
    }

    rateLimit.count++;

    // 4. Look up connectionId from user-connection mapping
    let connectionId = null;

    if (global.userConnectionMappings && global.userConnectionMappings.has(identifier)) {
      const mapping = global.userConnectionMappings.get(identifier);
      connectionId = mapping.connectionId;
      console.log(`✅ [DIDCOMM-AUTH] Found connection mapping: ${identifier} → ${connectionId}`);
    } else {
      // Fallback: Search Cloud Agent connections by label
      console.log(`🔍 [DIDCOMM-AUTH] No mapping found, searching Cloud Agent connections for: ${identifier}`);

      const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
        headers: { 'apikey': API_KEY }
      });

      if (connectionsResponse.ok) {
        const connectionsData = await connectionsResponse.json();

        // Search for connection with label containing identifier
        const matchingConnection = connectionsData.contents?.find(conn => {
          const isActive = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active'].includes(conn.state);
          const labelMatches = conn.label && (
            conn.label.toLowerCase().includes(identifier.toLowerCase()) ||
            identifier.toLowerCase().includes(conn.label.toLowerCase())
          );
          return isActive && labelMatches;
        });

        if (matchingConnection) {
          connectionId = matchingConnection.connectionId;
          console.log(`✅ [DIDCOMM-AUTH] Found connection via label search: ${connectionId}`);

          // Cache this mapping for future use and persist to disk
          global.userConnectionMappings.set(identifier, {
            connectionId: connectionId,
            establishedAt: matchingConnection.createdAt
          });
          saveUserMappings(global.userConnectionMappings);
        } else {
          // Enhanced fallback: Query issued credentials to discover holder name from uniqueId
          console.log(`🔍 [DIDCOMM-AUTH] Label search failed, trying credential-based discovery...`);

          try {
            const credentialsResponse = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records`, {
              headers: { 'apikey': API_KEY }
            });

            if (credentialsResponse.ok) {
              const credentialsData = await credentialsResponse.json();

              // Find credential with matching uniqueId in claims
              const matchingCredential = credentialsData.contents?.find(cred =>
                cred.claims && cred.claims.uniqueId === identifier
              );

              if (matchingCredential) {
                const firstName = matchingCredential.claims.firstName;
                const lastName = matchingCredential.claims.lastName;
                console.log(`✅ [DIDCOMM-AUTH] Found credential for uniqueId: ${identifier} → ${firstName} ${lastName}`);

                // Now search connections using the discovered name
                const nameConnection = connectionsData.contents?.find(conn => {
                  const isActive = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active'].includes(conn.state);
                  const labelMatches = conn.label && (
                    conn.label.toLowerCase().includes(firstName.toLowerCase()) ||
                    conn.label.toLowerCase().includes(lastName.toLowerCase())
                  );
                  return isActive && labelMatches;
                });

                if (nameConnection) {
                  connectionId = nameConnection.connectionId;
                  console.log(`✅ [DIDCOMM-AUTH] Found connection via credential-based discovery: ${connectionId}`);

                  // Cache this mapping with full holder info and persist to disk
                  global.userConnectionMappings.set(identifier, {
                    connectionId: connectionId,
                    holderInfo: {
                      firstName: firstName,
                      lastName: lastName,
                      uniqueId: identifier
                    },
                    discoveredVia: 'credential-lookup',
                    registeredAt: new Date().toISOString()
                  });
                  saveUserMappings(global.userConnectionMappings);
                  console.log(`💾 [DIDCOMM-AUTH] Saved credential-discovered mapping: ${identifier} → ${connectionId}`);
                }
              } else {
                console.log(`⚠️ [DIDCOMM-AUTH] No credential found with uniqueId: ${identifier}`);
              }
            }
          } catch (credError) {
            console.error(`❌ [DIDCOMM-AUTH] Error during credential-based discovery:`, credError.message);
          }
        }
      }
    }

    // 5. Verify connectionId found
    if (!connectionId) {
      console.error(`❌ [DIDCOMM-AUTH] No DIDComm connection found for identifier: ${identifier}`);
      return res.status(404).json({
        success: false,
        error: 'NoConnectionFound',
        message: 'No DIDComm connection found for this user. Please establish a connection first.',
        setupUrl: '/setup-connection?identifier=' + encodeURIComponent(identifier)
      });
    }

    // 6. Verify connection is active on Cloud Agent
    const connCheckResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}`, {
      headers: { 'apikey': API_KEY }
    });

    if (!connCheckResponse.ok) {
      console.error(`❌ [DIDCOMM-AUTH] Connection ${connectionId} not found on Cloud Agent`);
      return res.status(404).json({
        success: false,
        error: 'ConnectionNotFound',
        message: 'DIDComm connection no longer exists. Please re-establish connection.'
      });
    }

    const connection = await connCheckResponse.json();
    const validStates = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active'];

    if (!validStates.includes(connection.state)) {
      console.error(`❌ [DIDCOMM-AUTH] Connection ${connectionId} in invalid state: ${connection.state}`);
      return res.status(400).json({
        success: false,
        error: 'ConnectionNotActive',
        message: `Connection is in state "${connection.state}", must be Active. Please re-establish connection.`
      });
    }

    // 7. Generate cryptographic challenge and domain binding
    const challenge = crypto.randomUUID();
    // The Cloud Agent doesn't forward goalCode/goal/claims into the actual wire message for
    // JWT-format requests (verified live) — options.domain is the one field confirmed to
    // survive, so it doubles as the wallet-side schema hint (see actions/index.ts).
    const domain = 'realperson.identuslabel.cz';

    console.log(`🔐 [DIDCOMM-AUTH] Generating proof request with challenge: ${challenge.substring(0, 12)}...`);

    // 8. Create DIDComm Present Proof request via Cloud Agent
    const proofRequestPayload = {
      connectionId: connectionId,
      // Constrains by schema (was the unused `proofs: []` + unrecognized `proofTypes` field,
      // which produced presentation requests with empty input_descriptors — verified against
      // a live Cloud Agent record. `proofs[].schemaId` is what the Cloud Agent actually reads.
      proofs: [
        {
          // RealPerson v4.0.0 (the photo-carrying version) — the Cloud Agent enforces this
          // schemaId as a POST-HOC check against whatever VC the wallet actually presents
          // (verified live: a v3.0.0-requested schemaId against a v4.0.0-issued credential
          // produced status PresentationVerificationFailed, matching the Identus error-
          // handling ADR's documented "V6 Schema Mismatch" scenario). v4.0.0 is what
          // /api/credentials/issue-realperson actually issues whenever a photo is supplied.
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/4755a426-b80b-3f6a-b9ea-ca202bd7ce16',
          trustIssuers: await getTrustedIssuerDIDs() // constrain to DIDs this CA actually controls
        }
      ],
      options: {
        challenge: challenge,
        domain: domain
      },
      credentialFormat: 'JWT',
      goalCode: 'schema:RealPerson',
      goal: 'Please provide your RealPerson Identity Credential for authentication',
      // Per the Cloud Agent's own OpenAPI spec, `claims` (not `proofs[].schemaId` alone) is
      // what specifies which fields to disclose and populates presentation_definition's
      // input_descriptors — omitting it is what caused empty input_descriptors even with
      // a valid proofs[].schemaId.
      claims: {
        firstName: {},
        lastName: {},
        uniqueId: {},
        dateOfBirth: {},
        gender: {}
      }
    };

    console.log(`📤 [DIDCOMM-AUTH] Creating proof request via Cloud Agent:`, JSON.stringify(proofRequestPayload, null, 2));

    const proofResponse = await fetch(`${CLOUD_AGENT_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify(proofRequestPayload)
    });

    if (!proofResponse.ok) {
      const errorText = await proofResponse.text();
      console.error(`❌ [DIDCOMM-AUTH] Cloud Agent error creating proof request:`, errorText);
      return res.status(500).json({
        success: false,
        error: 'CloudAgentError',
        message: 'Failed to create proof request. Please try again.'
      });
    }

    const proofData = await proofResponse.json();
    const presentationId = proofData.presentationId || proofData.id;

    console.log(`✅ [DIDCOMM-AUTH] Proof request created: ${presentationId}`);

    // 9. Store proof request metadata
    global.proofRequests.set(presentationId, {
      proofId: presentationId,
      connectionId: connectionId,
      challenge: challenge,
      domain: domain,
      sessionId: sessionId,
      identifier: identifier,
      createdAt: Date.now(),
      status: 'RequestSent'
    });

    // Link session to presentation
    session.presentationId = presentationId;
    session.state = 'ProofRequestSent';

    // 10. Return proof ID for polling
    console.log(`✅ [DIDCOMM-AUTH] Authentication initiated successfully`);
    console.log(`   Proof ID: ${presentationId}`);
    console.log(`   Connection ID: ${connectionId}`);
    console.log(`   Challenge: ${challenge.substring(0, 12)}...`);
    console.log(`${'='.repeat(80)}\n`);

    res.json({
      success: true,
      presentationId: presentationId,
      connectionId: connectionId,
      status: 'RequestSent',
      message: 'Proof request sent to your wallet. Please check your wallet and approve the request.',
      pollUrl: `/api/auth/didcomm/status/${presentationId}`
    });

  } catch (error) {
    console.error('❌ [DIDCOMM-AUTH-INITIATE] Error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: 'An error occurred during authentication initiation.'
    });
  }
});

/**
 * GET /api/auth/didcomm/status/:proofId
 * Poll DIDComm Present Proof request status
 * Security: Validates session ownership of proof request
 */
app.get('/api/auth/didcomm/status/:proofId', async (req, res) => {
  try {
    const { proofId } = req.params;
    const { sessionId } = req.query;

    // 1. Validate session
    if (!sessionId || !global.userSessions || !global.userSessions.has(sessionId)) {
      return res.status(401).json({
        success: false,
        error: 'InvalidSession',
        message: 'Session not found or expired.'
      });
    }

    // 2. Verify proof request exists and belongs to this session
    if (!global.proofRequests || !global.proofRequests.has(proofId)) {
      return res.status(404).json({
        success: false,
        error: 'ProofRequestNotFound',
        message: 'Proof request not found.'
      });
    }

    const proofRequest = global.proofRequests.get(proofId);

    if (proofRequest.sessionId !== sessionId) {
      console.warn(`⚠️ [DIDCOMM-STATUS] Proof request ${proofId} does not belong to session ${sessionId}`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'This proof request does not belong to your session.'
      });
    }

    // 3. Query Cloud Agent for current presentation status
    const cloudAgentResponse = await fetch(`${CLOUD_AGENT_URL}/present-proof/presentations/${proofId}`, {
      headers: { 'apikey': API_KEY }
    });

    if (!cloudAgentResponse.ok) {
      console.error(`❌ [DIDCOMM-STATUS] Cloud Agent error fetching proof ${proofId}`);
      return res.status(500).json({
        success: false,
        error: 'CloudAgentError',
        message: 'Failed to query proof request status.'
      });
    }

    const presentationData = await cloudAgentResponse.json();
    const currentState = presentationData.state || presentationData.status;

    console.log(`📊 [DIDCOMM-STATUS] Proof ${proofId}: state=${currentState}`);

    // Update local tracking
    proofRequest.status = currentState;

    // 4. Check if presentation has been received
    if (currentState === 'PresentationReceived' || currentState === 'PresentationVerified') {
      // Extract claims from presentation
      const presentation = presentationData.data?.presentation || presentationData.presentation;
      let verifiedClaims = null;

      if (presentation && presentation.verifiableCredential && presentation.verifiableCredential.length > 0) {
        verifiedClaims = presentation.verifiableCredential[0].credentialSubject;
      }

      proofRequest.verifiedClaims = verifiedClaims;
      proofRequest.presentation = presentation;

      return res.json({
        success: true,
        presentationId: proofId,
        state: currentState,
        status: 'PresentationReceived',
        verifiedClaims: verifiedClaims,
        connectionId: proofRequest.connectionId,
        message: 'Presentation received. Ready for verification.'
      });
    } else if (currentState === 'RequestSent' || currentState === 'RequestPending') {
      return res.json({
        success: true,
        presentationId: proofId,
        state: currentState,
        status: 'AwaitingPresentation',
        message: 'Waiting for user to approve proof request in wallet.'
      });
    } else {
      return res.json({
        success: true,
        presentationId: proofId,
        state: currentState,
        status: currentState,
        message: `Proof request is in state: ${currentState}`
      });
    }

  } catch (error) {
    console.error('❌ [DIDCOMM-STATUS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: 'An error occurred while checking proof status.'
    });
  }
});

/**
 * POST /api/auth/didcomm/verify/:proofId
 * Verify DIDComm Present Proof and create authenticated session
 * Security: Validates challenge, domain, and creates session with verified connectionId
 */
app.post('/api/auth/didcomm/verify/:proofId', async (req, res) => {
  try {
    const { proofId } = req.params;
    const { sessionId } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [DIDCOMM-AUTH-VERIFY] Verifying presentation`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   📋 Proof ID: ${proofId}`);
    console.log(`   🔑 Session ID: ${sessionId ? sessionId.substring(0, 12) + '...' : 'N/A'}`);
    console.log(`   ⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    // 1. Validate session
    if (!sessionId || !global.userSessions || !global.userSessions.has(sessionId)) {
      return res.status(401).json({
        success: false,
        error: 'InvalidSession',
        message: 'Session not found or expired.'
      });
    }

    const session = global.userSessions.get(sessionId);

    // 2. Verify proof request exists and belongs to session
    if (!global.proofRequests || !global.proofRequests.has(proofId)) {
      return res.status(404).json({
        success: false,
        error: 'ProofRequestNotFound',
        message: 'Proof request not found.'
      });
    }

    const proofRequest = global.proofRequests.get(proofId);

    if (proofRequest.sessionId !== sessionId) {
      console.warn(`⚠️ [DIDCOMM-VERIFY] Proof request ${proofId} does not belong to session ${sessionId}`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'This proof request does not belong to your session.'
      });
    }

    // 3. Prevent double-verification
    if (session.authenticated) {
      console.warn(`⚠️ [DIDCOMM-VERIFY] Session already authenticated: ${sessionId}`);
      return res.status(409).json({
        success: false,
        error: 'AlreadyAuthenticated',
        message: 'Session is already authenticated.'
      });
    }

    // 4. Get presentation from Cloud Agent
    const cloudAgentResponse = await fetch(`${CLOUD_AGENT_URL}/present-proof/presentations/${proofId}`, {
      headers: { 'apikey': API_KEY }
    });

    if (!cloudAgentResponse.ok) {
      console.error(`❌ [DIDCOMM-VERIFY] Cloud Agent error fetching proof ${proofId}`);
      return res.status(500).json({
        success: false,
        error: 'CloudAgentError',
        message: 'Failed to retrieve presentation data.'
      });
    }

    const presentationData = await cloudAgentResponse.json();
    const currentState = presentationData.state || presentationData.status;

    console.log(`📊 [DIDCOMM-VERIFY] Presentation state: ${currentState}`);

    // 5. Verify state is PresentationReceived or PresentationVerified
    if (currentState !== 'PresentationReceived' && currentState !== 'PresentationVerified') {
      console.warn(`⚠️ [DIDCOMM-VERIFY] Invalid state for verification: ${currentState}`);
      return res.status(400).json({
        success: false,
        error: 'InvalidState',
        message: `Presentation is in state "${currentState}", cannot verify yet.`
      });
    }

    // 6. Extract and decode presentation JWT
    let presentation = null;

    // Cloud Agent returns presentation as JWT in data array
    if (presentationData.data && Array.isArray(presentationData.data) && presentationData.data.length > 0) {
      try {
        const presentationJWT = presentationData.data[0];
        console.log(`📝 [DIDCOMM-VERIFY] Decoding presentation JWT...`);

        // Decode JWT (base64url decode the payload)
        const parts = presentationJWT.split('.');
        if (parts.length === 3) {
          const payloadBase64 = parts[1];
          // Replace URL-safe characters and add padding
          const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
          const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
          const payload = JSON.parse(payloadJson);

          console.log(`✅ [DIDCOMM-VERIFY] JWT decoded successfully`);
          presentation = payload.vp; // Extract Verifiable Presentation from JWT payload
        }
      } catch (decodeError) {
        console.error(`❌ [DIDCOMM-VERIFY] Failed to decode presentation JWT:`, decodeError.message);
      }
    } else {
      // Try legacy format
      presentation = presentationData.data?.presentation || presentationData.presentation;
    }

    if (!presentation) {
      console.error(`❌ [DIDCOMM-VERIFY] No presentation data in Cloud Agent response`);
      return res.status(400).json({
        success: false,
        error: 'NoPresentationData',
        message: 'Presentation data not found.'
      });
    }

    // Verify challenge matches (if present in presentation proof)
    if (presentation.proof && presentation.proof.challenge) {
      if (presentation.proof.challenge !== proofRequest.challenge) {
        console.error(`❌ [DIDCOMM-VERIFY] Challenge mismatch! Expected: ${proofRequest.challenge}, Got: ${presentation.proof.challenge}`);
        return res.status(403).json({
          success: false,
          error: 'ChallengeMismatch',
          message: 'Presentation challenge does not match request. Possible replay attack.'
        });
      }
      console.log(`✅ [DIDCOMM-VERIFY] Challenge verified: ${presentation.proof.challenge.substring(0, 12)}...`);
    }

    // Verify domain matches (if present in presentation proof)
    if (presentation.proof && presentation.proof.domain) {
      if (presentation.proof.domain !== proofRequest.domain) {
        console.error(`❌ [DIDCOMM-VERIFY] Domain mismatch! Expected: ${proofRequest.domain}, Got: ${presentation.proof.domain}`);
        return res.status(403).json({
          success: false,
          error: 'DomainMismatch',
          message: 'Presentation domain does not match request.'
        });
      }
      console.log(`✅ [DIDCOMM-VERIFY] Domain verified: ${presentation.proof.domain}`);
    }

    // 7. Extract verified claims from verifiable credential
    let verifiedClaims = null;

    if (presentation.verifiableCredential && presentation.verifiableCredential.length > 0) {
      const credentialJWT = presentation.verifiableCredential[0];

      // Check if credential is a JWT string
      if (typeof credentialJWT === 'string' && credentialJWT.includes('.')) {
        try {
          console.log(`📝 [DIDCOMM-VERIFY] Decoding credential JWT...`);

          // Decode JWT (base64url decode the payload)
          const parts = credentialJWT.split('.');
          if (parts.length === 3) {
            const payloadBase64 = parts[1];
            const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
            const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
            const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
            const payload = JSON.parse(payloadJson);

            console.log(`✅ [DIDCOMM-VERIFY] Credential JWT decoded successfully`);

            // Extract credential subject from VC
            if (payload.vc && payload.vc.credentialSubject) {
              verifiedClaims = payload.vc.credentialSubject;
              console.log(`✅ [DIDCOMM-VERIFY] Claims extracted from VC`);
            }
          }
        } catch (decodeError) {
          console.error(`❌ [DIDCOMM-VERIFY] Failed to decode credential JWT:`, decodeError.message);
        }
      } else if (credentialJWT.credentialSubject) {
        // Legacy format - credential is already an object
        verifiedClaims = credentialJWT.credentialSubject;
      }
    } else if (proofRequest.verifiedClaims) {
      // Use cached claims from status polling
      console.log(`📝 [DIDCOMM-VERIFY] Using cached claims from proof request`);
      verifiedClaims = proofRequest.verifiedClaims;
    }

    if (!verifiedClaims) {
      console.error(`❌ [DIDCOMM-VERIFY] No verified claims found in presentation`);
      return res.status(400).json({
        success: false,
        error: 'NoClaimsFound',
        message: 'No claims found in presentation.'
      });
    }

    // 8. Validate required claims are present
    const requiredClaims = ['firstName', 'lastName', 'uniqueId'];
    for (const claim of requiredClaims) {
      if (!verifiedClaims[claim]) {
        console.error(`❌ [DIDCOMM-VERIFY] Missing required claim: ${claim}`);
        return res.status(400).json({
          success: false,
          error: 'MissingRequiredClaim',
          message: `Required claim "${claim}" not found in presentation.`
        });
      }
    }

    console.log(`✅ [DIDCOMM-VERIFY] Verified claims extracted:`, JSON.stringify(verifiedClaims, null, 2));

    // 9. Accept presentation via Cloud Agent
    const acceptResponse = await fetch(`${CLOUD_AGENT_URL}/present-proof/presentations/${proofId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({
        action: 'presentation-accept'
      })
    });

    if (!acceptResponse.ok) {
      console.warn(`⚠️ [DIDCOMM-VERIFY] Failed to accept presentation on Cloud Agent (non-fatal)`);
    } else {
      console.log(`✅ [DIDCOMM-VERIFY] Presentation accepted on Cloud Agent`);
    }

    // 10. Create authenticated session with verified connectionId
    session.authenticated = true;
    session.state = 'Authenticated';
    session.connectionId = proofRequest.connectionId; // ✅ Verified by Cloud Agent DIDComm
    session.userData = verifiedClaims;
    session.authenticatedAt = new Date().toISOString();
    session.authMethod = 'DIDComm-Present-Proof';

    // 11. Store user-connection mapping for credential delivery and persist to disk
    global.userConnectionMappings.set(verifiedClaims.uniqueId, {
      connectionId: proofRequest.connectionId,
      holderInfo: verifiedClaims,
      registeredAt: new Date().toISOString()
    });
    saveUserMappings(global.userConnectionMappings);

    console.log(`✅ [DIDCOMM-VERIFY] User-connection mapping created: ${verifiedClaims.uniqueId} → ${proofRequest.connectionId}`);

    // 12. Cleanup: Remove proof request from tracking
    global.proofRequests.delete(proofId);

    console.log(`✅ [DIDCOMM-AUTH-VERIFY] Authentication successful!`);
    console.log(`   User: ${verifiedClaims.firstName} ${verifiedClaims.lastName}`);
    console.log(`   Unique ID: ${verifiedClaims.uniqueId}`);
    console.log(`   Connection ID: ${proofRequest.connectionId}`);
    console.log(`   Session ID: ${sessionId.substring(0, 12)}...`);
    console.log(`${'='.repeat(80)}\n`);

    // 13. Automatic clearance request removed (user must click button in dashboard)
    console.log(`📋 [AUTH] User can request clearance via dashboard button`);

    // 14. Return success response with redirect to dashboard
    // Include the holder's PRISM DID (from credentialSubject.id) for key extraction
    const holderPrismDID = verifiedClaims.id || null;
    if (holderPrismDID) {
      console.log(`🔑 [DIDCOMM-AUTH-VERIFY] Holder PRISM DID: ${holderPrismDID.substring(0, 50)}...`);
    }

    res.json({
      success: true,
      authenticated: true,
      sessionId: sessionId,
      userData: {
        firstName: verifiedClaims.firstName,
        lastName: verifiedClaims.lastName,
        uniqueId: verifiedClaims.uniqueId,
        dateOfBirth: verifiedClaims.dateOfBirth,
        gender: verifiedClaims.gender,
        photo: verifiedClaims.photo || null,
        id: holderPrismDID  // Include holder's PRISM DID for key extraction
      },
      connectionId: proofRequest.connectionId,
      redirectUrl: `/ca/dashboard?session=${sessionId}`,
      message: 'Authentication successful! Redirecting to dashboard...'
    });

  } catch (error) {
    console.error('❌ [DIDCOMM-AUTH-VERIFY] Error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: 'An error occurred during verification.'
    });
  }
});

// ============================================================================
// END: SECURE DIDCOMM PRESENT PROOF AUTHENTICATION ENDPOINTS
// ============================================================================

// ===========================================================================
// DUAL-VC AUTHENTICATION: Security Clearance VC Verification
// ===========================================================================

/**
 * Endpoint to handle Security Clearance VC presentation after RealPerson authentication
 * Part of dual-VC authentication flow
 */
app.post('/api/didcomm-clearance-verify', async (req, res) => {
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [CLEARANCE-VERIFY] Received clearance VC presentation`);
    console.log(`${'='.repeat(80)}`);

    const { proofId, presentationId } = req.body;

    if (!proofId || !presentationId) {
      console.error('❌ [CLEARANCE-VERIFY] Missing required parameters');
      return res.status(400).json({
        success: false,
        error: 'MissingParameters',
        message: 'proofId and presentationId are required'
      });
    }

    // 1. Check if we have a pending clearance proof request
    if (!global.clearanceProofRequests || !global.clearanceProofRequests.has(proofId)) {
      console.error(`❌ [CLEARANCE-VERIFY] Clearance proof request not found: ${proofId}`);
      return res.status(404).json({
        success: false,
        error: 'ProofRequestNotFound',
        message: 'Clearance proof request not found or expired'
      });
    }

    const clearanceRequest = global.clearanceProofRequests.get(proofId);
    console.log(`📋 [CLEARANCE-VERIFY] Found clearance request for session: ${clearanceRequest.sessionId.substring(0, 8)}...`);

    // 2. Retrieve the presentation from Cloud Agent
    console.log(`🔍 [CLEARANCE-VERIFY] Fetching presentation from Cloud Agent...`);

    const presentationResponse = await fetch(
      `${CLOUD_AGENT_URL}/present-proof/presentations/${presentationId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY
        }
      }
    );

    if (!presentationResponse.ok) {
      const errorText = await presentationResponse.text();
      console.error(`❌ [CLEARANCE-VERIFY] Cloud Agent error fetching presentation:`, errorText);
      return res.status(500).json({
        success: false,
        error: 'CloudAgentError',
        message: 'Failed to retrieve presentation from Cloud Agent'
      });
    }

    const presentation = await presentationResponse.json();
    console.log(`✅ [CLEARANCE-VERIFY] Retrieved presentation. Status: ${presentation.status}`);

    // 3. Verify presentation status
    if (presentation.status !== 'PresentationVerified' && presentation.status !== 'Verified') {
      console.error(`❌ [CLEARANCE-VERIFY] Presentation not verified. Status: ${presentation.status}`);
      return res.status(400).json({
        success: false,
        error: 'PresentationNotVerified',
        message: `Presentation status: ${presentation.status}`
      });
    }

    // 4. Extract clearance level AND X25519 key from the verified credential
    console.log(`🔍 [CLEARANCE-VERIFY] Extracting clearance data from credential...`);

    let clearanceLevel = null;
    let x25519PublicKey = null;
    let clearanceData = null;

    // Try to extract from verifiableCredential in the presentation
    if (presentation.verifiableCredential && Array.isArray(presentation.verifiableCredential)) {
      for (const vc of presentation.verifiableCredential) {
        let credentialSubject = null;
        let vcMetadata = { issuanceDate: null, expirationDate: null, issuer: null, id: null };

        // Handle JWT format (most common for DIDComm)
        if (typeof vc === 'string' && vc.includes('.')) {
          console.log(`🔍 [CLEARANCE-VERIFY] Decoding JWT credential...`);
          const parts = vc.split('.');
          if (parts.length === 3) {
            try {
              // Decode JWT payload (base64url decode)
              const payloadBase64 = parts[1];
              const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
              const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
              const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
              const payload = JSON.parse(payloadJson);

              // Extract credential subject from VC
              if (payload.vc && payload.vc.credentialSubject) {
                credentialSubject = payload.vc.credentialSubject;
                vcMetadata.issuanceDate = payload.vc.issuanceDate || payload.iat;
                vcMetadata.expirationDate = payload.vc.expirationDate || payload.exp;
                vcMetadata.issuer = payload.iss || payload.vc.issuer;
                vcMetadata.id = payload.jti || payload.vc.id;
                console.log(`✅ [CLEARANCE-VERIFY] JWT decoded successfully`);
              }
            } catch (jwtError) {
              console.error(`❌ [CLEARANCE-VERIFY] JWT decode error:`, jwtError.message);
            }
          }
        } else {
          // Handle object format
          credentialSubject = vc.credentialSubject || {};
          vcMetadata.issuanceDate = vc.issuanceDate || vc.issued;
          vcMetadata.expirationDate = vc.expirationDate || vc.validUntil;
          vcMetadata.issuer = vc.issuer;
          vcMetadata.id = vc.id || vc.credentialId;
        }

        if (!credentialSubject) continue;

        // Extract clearanceLevel (various possible field names)
        clearanceLevel = credentialSubject.clearanceLevel ||
                        credentialSubject.securityLevel ||
                        credentialSubject.level ||
                        null;

        // Extract X25519 public key for encryption
        x25519PublicKey = credentialSubject.x25519PublicKey ||
                         credentialSubject.publicKey ||
                         credentialSubject.encryptionKey ||
                         null;

        if (clearanceLevel) {
          clearanceData = {
            level: clearanceLevel.toUpperCase(),
            verified: true,
            issuedAt: vcMetadata.issuanceDate || new Date().toISOString(),
            validUntil: vcMetadata.expirationDate || null,
            issuer: vcMetadata.issuer || 'Unknown',
            credentialId: vcMetadata.id || 'Unknown',
            x25519PublicKey: x25519PublicKey // ✅ Store X25519 key
          };

          console.log(`✅ [CLEARANCE-VERIFY] Extracted clearance level: ${clearanceLevel}`);
          console.log(`   Issuer: ${clearanceData.issuer}`);
          console.log(`   Valid Until: ${clearanceData.validUntil || 'No expiration'}`);
          console.log(`   X25519 Key: ${x25519PublicKey ? x25519PublicKey.substring(0, 20) + '...' : '❌ NOT FOUND'}`);
          break;
        }
      }
    }

    // If not found in verifiableCredential, try data field
    if (!clearanceLevel && presentation.data) {
      const claims = presentation.data.claims || presentation.data;
      clearanceLevel = claims.clearanceLevel || claims.securityLevel || claims.level || null;

      if (clearanceLevel) {
        clearanceData = {
          level: clearanceLevel.toUpperCase(),
          verified: true,
          issuedAt: claims.issuedAt || new Date().toISOString(),
          validUntil: claims.validUntil || null
        };
        console.log(`✅ [CLEARANCE-VERIFY] Extracted clearance level from claims: ${clearanceLevel}`);
      }
    }

    if (!clearanceLevel) {
      console.error(`❌ [CLEARANCE-VERIFY] Could not extract clearance level from presentation`);
      return res.status(400).json({
        success: false,
        error: 'ClearanceLevelNotFound',
        message: 'Could not extract clearance level from credential'
      });
    }

    // 5. Update session with clearance data
    const sessionId = clearanceRequest.sessionId;

    if (!global.userSessions || !global.userSessions.has(sessionId)) {
      console.error(`❌ [CLEARANCE-VERIFY] Session not found: ${sessionId}`);
      return res.status(404).json({
        success: false,
        error: 'SessionNotFound',
        message: 'User session not found or expired'
      });
    }

    const session = global.userSessions.get(sessionId);
    session.clearanceData = clearanceData;
    session.clearanceVerifiedAt = new Date().toISOString();

    // ✅ Upgrade session with X25519 public key for encryption capability
    if (clearanceData.x25519PublicKey) {
      session.x25519PublicKey = clearanceData.x25519PublicKey;
      session.hasEncryptionCapability = true;
      console.log(`🔐 [CLEARANCE-VERIFY] Session upgraded with X25519 encryption capability`);
      console.log(`   Session ID: ${sessionId}`);
      console.log(`   X25519 Key: ${clearanceData.x25519PublicKey.substring(0, 20)}...`);
    } else {
      console.warn(`⚠️ [CLEARANCE-VERIFY] No X25519 key found - encrypted content mode unavailable`);
      session.hasEncryptionCapability = false;
    }

    global.userSessions.set(sessionId, session);

    console.log(`✅ [CLEARANCE-VERIFY] Session updated with clearance data`);
    console.log(`   Session ID: ${sessionId.substring(0, 12)}...`);
    console.log(`   User: ${session.userData.firstName} ${session.userData.lastName}`);
    console.log(`   Clearance Level: ${clearanceData.level}`);

    // 6. Cleanup clearance proof request
    global.clearanceProofRequests.delete(proofId);

    console.log(`✅ [CLEARANCE-VERIFY] Clearance verification complete!`);
    console.log(`${'='.repeat(80)}\n`);

    // 7. Return success response
    res.json({
      success: true,
      clearanceVerified: true,
      sessionId: sessionId,
      clearanceData: {
        level: clearanceData.level,
        verified: true
      },
      message: 'Security clearance verified successfully'
    });

  } catch (error) {
    console.error('❌ [CLEARANCE-VERIFY] Error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: 'An error occurred during clearance verification.'
    });
  }
});

// ===========================================================================
// END: DUAL-VC AUTHENTICATION
// ===========================================================================

// API endpoint to receive verification submissions from wallet
app.post('/api/presentations/verify', async (req, res) => {
  try {
    const { presentationId, status, claims, connectionId } = req.body;

    console.log(`📨 Received credential verification for: ${presentationId}`);
    console.log(`🔍 Status: ${status}, Claims:`, claims);

    // Find the challenge in memory
    if (global.authChallenges && global.authChallenges.has(presentationId)) {
      const challenge = global.authChallenges.get(presentationId);

      // Extract Security Clearance VC fields for secure dashboard
      const clearanceLevel = claims?.clearanceLevel;
      const x25519PublicKey = claims?.x25519PublicKey;
      const firstName = claims?.firstName;
      const lastName = claims?.lastName;
      const credentialId = claims?.credentialId;

      console.log(`🔍 [X25519] Extracted data:`, {
        clearanceLevel,
        firstName,
        lastName,
        hasX25519Key: !!x25519PublicKey,
        x25519KeyLength: x25519PublicKey ? x25519PublicKey.length : 0
      });

      // Update the challenge status
      challenge.status = 'PresentationReceived';
      challenge.verifiedAt = new Date().toISOString();
      challenge.presentation = {
        claims: claims,
        connectionId: connectionId || 'wallet-submission'
      };
      challenge.connectionId = connectionId;  // Store the wallet's connection ID

      // If this is a Security Clearance VC with X25519 key, upgrade/create session
      if (clearanceLevel && x25519PublicKey) {
        const crypto = require('crypto');
        const expiresAt = new Date(Date.now() + 3600000); // 1 hour

        // Try to find existing session by connectionId
        let existingSessionId = null;
        if (connectionId) {
          for (const [sessionId, session] of global.userSessions.entries()) {
            if (session.connectionId === connectionId) {
              existingSessionId = sessionId;
              console.log(`🔄 [Session] Found existing session to upgrade: ${sessionId}`);
              break;
            }
          }
        }

        let finalSessionId;
        if (existingSessionId) {
          // Upgrade existing session with encryption capability
          const existingSession = global.userSessions.get(existingSessionId);
          const upgradedSession = {
            ...existingSession,
            clearanceLevel: clearanceLevel,
            x25519PublicKey: x25519PublicKey,
            firstName: firstName || existingSession.firstName || 'Unknown',
            lastName: lastName || existingSession.lastName || 'User',
            credentialId: credentialId,
            presentationId: presentationId,
            authenticatedAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString(),
            authenticated: true,
            hasEncryptionCapability: true,
            userData: {
              ...(existingSession.userData || {}),
              clearanceLevel,
              firstName: firstName || existingSession.firstName,
              lastName: lastName || existingSession.lastName
            }
          };

          global.userSessions.set(existingSessionId, upgradedSession);
          finalSessionId = existingSessionId;
          console.log(`✅ [Session] Upgraded existing session: ${finalSessionId}`);
        } else {
          // Create new session (original behavior)
          finalSessionId = crypto.randomUUID();
          const sessionData = {
            sessionId: finalSessionId,
            clearanceLevel: clearanceLevel,
            x25519PublicKey: x25519PublicKey,
            firstName: firstName || 'Unknown',
            lastName: lastName || 'User',
            credentialId: credentialId,
            presentationId: presentationId,
            connectionId: connectionId,
            authenticatedAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString(),
            createdAt: new Date().toISOString(),
            authenticated: true,
            hasEncryptionCapability: true,
            userData: { clearanceLevel, firstName, lastName }
          };

          global.userSessions.set(finalSessionId, sessionData);
          console.log(`🔐 [Session] Created new authenticated session: ${finalSessionId}`);
        }

        challenge.sessionId = finalSessionId;
        console.log(`🔐 [Session] User: ${firstName} ${lastName} (${clearanceLevel})`);
        console.log(`🔐 [Session] Expires: ${expiresAt.toISOString()}`);

        global.authChallenges.set(presentationId, challenge);

        return res.json({
          success: true,
          message: 'Verification received successfully',
          presentationId: presentationId,
          sessionId: finalSessionId,
          upgraded: !!existingSessionId,
          redirectUrl: `/ca/dashboard?session=${finalSessionId}`
        });
      }

      global.authChallenges.set(presentationId, challenge);

      console.log(`✅ Credential verification submitted: ${presentationId}`);

      res.json({
        success: true,
        message: 'Verification received successfully',
        presentationId: presentationId
      });
    } else {
      console.log(`❌ Challenge not found: ${presentationId}`);
      res.status(404).json({
        success: false,
        error: 'Verification challenge not found or expired'
      });
    }
  } catch (error) {
    console.error('❌ Error processing verification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Submit credential verification (from wallet)
app.post('/api/presentations/:presentationId/submit', async (req, res) => {
  try {
    const { presentationId } = req.params;
    // Accept both formats: old format with credentialData and new format from Alice wallet
    const { credentialData, credential, userInfo, challengeId } = req.body;
    
    console.log(`📨 Received credential verification for: ${presentationId}`);
    console.log(`🔍 [DEBUG] Request body keys:`, Object.keys(req.body));
    
    // Use credential or credentialData based on what's provided
    const actualCredential = credential || credentialData || userInfo;
    
    if (!actualCredential) {
      console.error('❌ No credential data found in request');
      return res.status(400).json({
        success: false,
        error: 'No credential data provided'
      });
    }
    
    console.log(`🔍 [DEBUG] Using credential data:`, actualCredential);
    
    // Check our stored invitations
    global.authChallenges = global.authChallenges || new Map();
    const invitation = global.authChallenges.get(presentationId);
    
    if (!invitation) {
      return res.status(404).json({
        success: false,
        error: 'Verification invitation not found'
      });
    }
    
    // Update invitation with received credential (FIXED: proper format)
    invitation.status = 'PresentationReceived';
    invitation.claims = actualCredential;
    invitation.presentation = { claims: actualCredential };  // FIXED: Add presentation format expected by status endpoint
    invitation.verifiedAt = new Date().toISOString();
    
    console.log(`✅ Credential verification submitted: ${presentationId}`);
    console.log(`🔍 [DEBUG] Stored presentation:`, invitation.presentation);
    
    res.json({
      success: true,
      message: 'Credential verification received successfully',
      status: invitation.status
    });
  } catch (error) {
    console.error('❌ Error submitting credential verification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Request credential verification for authentication (simplified approach)
app.post('/api/presentations/request', async (req, res) => {
  try {
    const { connectionId, credentialType } = req.body;
    
    console.log(`🔐 Requesting ${credentialType} credential verification from connection: ${connectionId}`);
    
    // Since presentation proof APIs are not available in this Cloud Agent version,
    // we'll simulate the authentication request by creating a special message
    // and expecting the user to respond via a different mechanism
    
    // For now, create a simple authentication challenge that can be verified
    const authChallenge = {
      challengeId: `auth-${Date.now()}-${Math.random().toString(36).substring(2)}`,
      connectionId: connectionId,
      requestedCredential: credentialType,
      challenge: `Please verify your ${credentialType} credential to login`,
      timestamp: new Date().toISOString(),
      status: 'RequestSent'
    };
    
    // Store this challenge temporarily (in production, use a proper database)
    global.authChallenges = global.authChallenges || new Map();
    global.authChallenges.set(authChallenge.challengeId, authChallenge);
    
    console.log(`✅ Authentication challenge created: ${authChallenge.challengeId}`);
    
    res.json({
      success: true,
      presentationId: authChallenge.challengeId,
      connectionId: connectionId,
      status: 'RequestSent',
      message: 'Authentication challenge created. Please verify your credential in your wallet.'
    });
  } catch (error) {
    console.error('❌ Error creating authentication request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check authentication challenge status (SECURE - prevents race conditions)
app.get('/api/presentations/:presentationId/status/:sessionId', async (req, res) => {
  try {
    const { presentationId, sessionId } = req.params;
    
    console.log(`🔍 [SECURE] Status check for: ${presentationId} by session: ${sessionId.substring(0, 8)}...`);
    
    // SECURITY: Validate session exists
    if (!global.userSessions.has(sessionId)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid session. Please refresh the page.',
        requiresNewSession: true
      });
    }
    
    // SECURITY: Check if this session owns the challenge
    const expectedSessionId = global.challengeSessions.get(presentationId);
    if (expectedSessionId !== sessionId) {
      console.log(`🚨 [SECURITY] Session ${sessionId.substring(0, 8)}... tried to access challenge owned by ${expectedSessionId ? expectedSessionId.substring(0, 8) + '...' : 'unknown'}`);
      return res.status(403).json({
        success: false,
        error: 'Unauthorized: This challenge belongs to a different session.',
        status: 'Unauthorized'
      });
    }
    
    // Get the challenge (now safely validated)
    global.authChallenges = global.authChallenges || new Map();
    const challenge = global.authChallenges.get(presentationId);
    
    if (!challenge) {
      return res.status(404).json({
        success: false,
        error: 'Challenge not found',
        status: 'NotFound'
      });
    }
    
    console.log(`🔍 [DEBUG] Challenge found for session ${sessionId.substring(0, 8)}...`);
    console.log(`🔍 [DEBUG] Challenge status: ${challenge.status}`);
    console.log(`🔍 [DEBUG] Challenge verifiedAt: ${challenge.verifiedAt}`);
    
    // Update session if authentication successful
    if (challenge.status === 'PresentationReceived' && challenge.presentation) {
      let session = global.userSessions.get(sessionId);

      // Create session if it doesn't exist (fix for session bridging)
      if (!session) {
        console.log(`🔧 [FIX] Creating missing session for ${sessionId.substring(0, 8)}...`);
        session = {
          sessionId: sessionId,
          authenticated: false,
          userData: null,
          createdAt: new Date().toISOString()
        };
        global.userSessions.set(sessionId, session);
      }

      // Mark session as authenticated
      session.authenticated = true;
      session.userData = challenge.presentation.claims;
      session.authenticatedAt = new Date().toISOString();
      console.log(`✅ [SECURE] Session ${sessionId.substring(0, 8)}... successfully authenticated`);
      console.log(`📊 [DEBUG] Total sessions in memory: ${global.userSessions.size}`);
    }
    
    // Return the status for THIS session's challenge only (secure)
    res.json({
      success: true,
      status: challenge.status,
      presentation: challenge.status === 'PresentationReceived' ? {
        claims: challenge.presentation?.claims || {},  // FIX: Use challenge.presentation.claims, not challenge.claims
        connectionId: challenge.connectionId  // ✅ Include connectionId from challenge
      } : null
    });
    
  } catch (error) {
    console.error('❌ Error checking authentication status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DEPRECATED: Old insecure status check (kept for backward compatibility during transition)
app.get('/api/presentations/:presentationId/status', async (req, res) => {
  console.log('⚠️ [DEPRECATED] Using old insecure status endpoint. Client should upgrade to session-based authentication.');
  res.status(400).json({
    success: false,
    error: 'This endpoint is deprecated due to security vulnerabilities. Please refresh the page to use secure session-based authentication.',
    deprecated: true,
    requiresNewSession: true
  });
});

// Simulate credential verification acceptance (for demonstration)
// ⚠️ DEPRECATED: Insecure connectionless verification endpoint removed
// This endpoint had CRITICAL security vulnerabilities (CVSS 7.3-9.1):
//   - No challenge-response validation (replay attacks)
//   - No domain binding (phishing vulnerability)
//   - ConnectionId guessing via DID/label matching (MitM attacks)
//   - No rate limiting (DoS vulnerability)
//
// Use the new DIDComm Present Proof authentication system instead:
//   - POST /api/auth/didcomm/initiate - Initiate proof request
//   - GET /api/auth/didcomm/status/:proofId - Poll for completion
//   - POST /api/auth/didcomm/verify/:proofId - Verify presentation
//
// Security improvements with new system:
//   - Challenge-response with crypto.randomUUID() (replay protection)
//   - Domain binding to "ca.identus.org" (phishing protection)
//   - Verified connectionId from Cloud Agent DIDComm (no guessing)
//   - Rate limiting: 5 requests/minute (DoS protection)
//   - End-to-end DIDComm encryption (confidentiality)
//
// For implementation details, see:
//   - https://hyperledger-identus.github.io/docs/tutorials/credentials/didcomm/present-proof
//   - Security audit report: 81% risk reduction with DIDComm

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});


// Serve protected portal page
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Serve dashboard page (clearance-based)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Session Info API - returns session capabilities
app.get('/api/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    // Validate session exists
    if (!sessionId || !global.userSessions || !global.userSessions.has(sessionId)) {
      return res.status(404).json({
        error: 'Session not found',
        message: 'Invalid session ID'
      });
    }

    const session = global.userSessions.get(sessionId);

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      global.userSessions.delete(sessionId);
      return res.status(401).json({
        error: 'Session expired',
        message: 'Please authenticate again'
      });
    }

    console.log(`[Session Info] Request for session: ${sessionId.substring(0, 8)}...`);
    console.log(`[Session Info] User: ${session.firstName} ${session.lastName}`);
    console.log(`[Session Info] Clearance Level: ${session.clearanceLevel || 'None'}`);
    console.log(`[Session Info] Has Encryption: ${session.hasEncryptionCapability || false}`);

    // Return session capabilities
    return res.json({
      success: true,
      session: {
        sessionId: sessionId,
        authenticated: session.authenticated,
        hasEncryptionCapability: session.hasEncryptionCapability || false,
        clearanceLevel: session.clearanceLevel || null,
        firstName: session.firstName,
        lastName: session.lastName,
        authenticatedAt: session.authenticatedAt,
        loginTime: session.loginTime,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        userData: session.userData || session.personalInfo || {},
        connectionId: session.connectionId || null
      }
    });
  } catch (error) {
    console.error('❌ [Session Info] Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// NEW: Encrypted Content API with BroadcastChannel Decryption
app.get('/api/secure-content', async (req, res) => {
  try {
    const sessionId = req.query.session;

    // Validate session
    if (!sessionId || !global.userSessions || !global.userSessions.has(sessionId)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing session token'
      });
    }

    const session = global.userSessions.get(sessionId);

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      global.userSessions.delete(sessionId);
      return res.status(401).json({
        error: 'Session expired',
        message: 'Please authenticate again'
      });
    }

    // Validate X25519 public key exists
    if (!session.x25519PublicKey) {
      return res.status(400).json({
        error: 'Missing encryption key',
        message: 'Session does not contain X25519 public key'
      });
    }

    console.log(`[Secure Content API] Request from: ${session.firstName} ${session.lastName} (${session.clearanceLevel})`);

    // Get accessible content based on clearance
    const { getAccessibleContent } = require('./lib/contentDatabase');
    const accessibleSections = getAccessibleContent(session.clearanceLevel);

    console.log(`[Secure Content API] Returning ${accessibleSections.length} sections`);

    // Encrypt each section for user
    const { encryptForUser } = require('./lib/encryption');

    const encryptedSections = await Promise.all(
      accessibleSections.map(async (section, index) => {
        console.log(`[Secure Content API] Encrypting section ${index + 1}/${accessibleSections.length}: ${section.title}`);

        return {
          id: section.id,
          title: section.title,
          clearanceBadge: section.clearanceBadge,
          badgeColor: section.badgeColor,
          encryptedContent: await encryptForUser(
            section.content,
            session.x25519PublicKey
          )
        };
      })
    );

    res.json({
      success: true,
      user: {
        firstName: session.firstName,
        lastName: session.lastName,
        clearanceLevel: session.clearanceLevel
      },
      sections: encryptedSections,
      sessionExpiresAt: session.expiresAt
    });

  } catch (error) {
    console.error('[Secure Content API] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Progressive Disclosure Content API
app.get('/api/dashboard/content', async (req, res) => {
  try {
    const sessionId = req.query.session;

    // Default: public content only (unauthenticated)
    let userClearanceLevel = null;
    let userName = 'Guest';
    let firstName = null;
    let lastName = null;
    let authenticated = false;
    let hasEncryptionCapability = false;

    // If session provided, check authentication
    if (sessionId && global.userSessions) {
      const session = global.userSessions.get(sessionId);

      if (session && session.authenticated) {
        // Extract user name
        if (session.userData) {
          firstName = session.userData.firstName;
          lastName = session.userData.lastName;
          userName = `${firstName} ${lastName}`;
        }

        authenticated = true;

        // Check if session has X25519 public key (encryption capability)
        hasEncryptionCapability = !!session.x25519PublicKey;

        // Check if clearance already verified
        if (session.clearanceData?.verified) {
          userClearanceLevel = session.clearanceData.level;
          console.log(`[Dashboard API] Using cached clearance: ${userClearanceLevel}`);
        } else {
          // Check for pending clearance proof request and auto-update session
          console.log(`[Dashboard API] No cached clearance, checking for updates...`);

          let clearanceProofData = null;
          if (global.clearanceProofRequests) {
            for (const [proofId, data] of global.clearanceProofRequests.entries()) {
              if (data.sessionId === sessionId) {
                clearanceProofData = { proofId, ...data };
                break;
              }
            }
          }

          if (clearanceProofData && clearanceProofData.presentationId) {
            console.log(`[Dashboard API] Found pending clearance request, checking Cloud Agent...`);

            try {
              // Poll Cloud Agent for presentation status
              const cloudAgentResponse = await fetch(
                `${CLOUD_AGENT_URL}/present-proof/presentations/${clearanceProofData.presentationId}`,
                {
                  method: 'GET',
                  headers: {
                    'Content-Type': 'application/json',
                    'apikey': API_KEY
                  }
                }
              );

              if (cloudAgentResponse.ok) {
                const presentationData = await cloudAgentResponse.json();
                const presentationStatus = presentationData.status;

                console.log(`[Dashboard API] Clearance presentation status: ${presentationStatus}`);

                // Check if presentation is verified
                if (presentationStatus === 'PresentationVerified' || presentationStatus === 'Verified') {
                  console.log(`[Dashboard API] Clearance verified! Extracting claims...`);

                  // Extract and decode presentation JWT
                  let presentation = null;

                  if (presentationData.data && Array.isArray(presentationData.data) && presentationData.data.length > 0) {
                    const presentationJWT = presentationData.data[0];
                    const parts = presentationJWT.split('.');
                    if (parts.length === 3) {
                      const payloadBase64 = parts[1];
                      const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
                      const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
                      const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
                      const payload = JSON.parse(payloadJson);
                      presentation = payload.vp;
                    }
                  }

                  // Extract credential and claims
                  let verifiedClaims = null;
                  if (presentation?.verifiableCredential?.[0]) {
                    const credentialJWT = presentation.verifiableCredential[0];
                    if (typeof credentialJWT === 'string' && credentialJWT.includes('.')) {
                      const parts = credentialJWT.split('.');
                      if (parts.length === 3) {
                        const payloadBase64 = parts[1];
                        const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
                        const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
                        const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
                        const payload = JSON.parse(payloadJson);
                        verifiedClaims = payload.vc?.credentialSubject;
                      }
                    } else if (credentialJWT.credentialSubject) {
                      verifiedClaims = credentialJWT.credentialSubject;
                    }
                  }

                  // Extract clearance level
                  if (verifiedClaims) {
                    const clearanceLevel = verifiedClaims.clearanceLevel ||
                                          verifiedClaims.securityLevel ||
                                          verifiedClaims.level ||
                                          null;

                    if (clearanceLevel) {
                      console.log(`[Dashboard API] Found clearance level: ${clearanceLevel}`);

                      // Update session with clearance data AND X25519 key
                      session.clearanceData = {
                        level: clearanceLevel.toUpperCase(),
                        verified: true,
                        issuedAt: verifiedClaims.issuanceDate || new Date().toISOString(),
                        validUntil: verifiedClaims.expirationDate || null,
                        x25519PublicKey: verifiedClaims.x25519PublicKey || null
                      };

                      // Also update session.x25519PublicKey for compatibility with encrypted endpoint
                      if (verifiedClaims.x25519PublicKey) {
                        session.x25519PublicKey = verifiedClaims.x25519PublicKey;
                        session.hasEncryptionCapability = true;
                        console.log(`[Dashboard API] X25519 public key stored in session: ${verifiedClaims.x25519PublicKey.substring(0, 20)}...`);
                      }

                      session.clearanceVerifiedAt = new Date().toISOString();
                      global.userSessions.set(sessionId, session);

                      // Remove from pending requests
                      global.clearanceProofRequests.delete(clearanceProofData.proofId);

                      userClearanceLevel = clearanceLevel.toUpperCase();
                      console.log(`[Dashboard API] Session updated with clearance: ${userClearanceLevel}`);
                    }
                  }
                }
              }
            } catch (cloudAgentError) {
              console.error(`[Dashboard API] Error checking clearance:`, cloudAgentError.message);
              // Continue with no clearance - non-fatal
            }
          }
        }

        console.log(`[Dashboard API] Authenticated user: ${userName} (${userClearanceLevel || 'No clearance'})`);
      } else if (!session) {
        console.log(`[Dashboard API] Session not found: ${sessionId}`);
      } else if (!session.authenticated) {
        console.log(`[Dashboard API] Session not authenticated: ${sessionId}`);
      }
    }

    // PHASE 2 FIX: This endpoint ALWAYS returns ONLY PUBLIC sections (requiredLevel = 0)
    // Higher clearance sections come from /api/dashboard/encrypted-content (encrypted)
    const contentDB = require('./lib/contentDatabase');
    const allSections = await contentDB.getAccessibleContent(null); // Get all sections
    const sections = allSections.filter(section => {
      const requiredLevel = section.requiredLevel || 0;
      return requiredLevel === 0; // PUBLIC only
    });

    console.log(`[Dashboard API] Returning ${sections.length} PUBLIC sections (clearance: ${userClearanceLevel || 'none'})`);

    res.json({
      success: true,
      user: {
        name: userName,
        firstName: firstName,
        lastName: lastName,
        clearanceLevel: userClearanceLevel,
        authenticated: authenticated,
        hasEncryptionCapability: hasEncryptionCapability
      },
      sections: sections.map(section => ({
        id: section.id,
        title: section.title,
        content: section.content,
        clearanceBadge: section.clearanceBadge,
        badgeColor: contentDB.getClearanceBadgeColor(section.clearanceBadge),
        category: section.category
      }))
    });

  } catch (error) {
    console.error('[Dashboard API] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ===========================================================================
// Phase 2: Encrypted Dashboard Content API (Client-Side Decryption)
// ===========================================================================

/**
 * GET /api/dashboard/encrypted-content
 *
 * Returns dashboard content sections encrypted with X25519 keys for client-side decryption.
 * Server sends encrypted content, wallet decrypts locally using X25519 private key.
 *
 * Query Parameters:
 *   - session (required): Session ID from VC authentication
 *
 * Response:
 *   - success: boolean
 *   - user: {name, clearanceLevel, authenticated, x25519PublicKey}
 *   - sections: Array of sections with encryptedContent objects
 *
 * Error Responses:
 *   - 401: No active session or session expired
 *   - 400: User's VC lacks X25519 keys (old credential format)
 *   - 500: Encryption failure or internal server error
 */
app.get('/api/dashboard/encrypted-content', async (req, res) => {
  try {
    const sessionId = req.query.session;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [Dashboard Encrypted] ENCRYPTED CONTENT REQUEST`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   Session ID: ${sessionId ? sessionId.substring(0, 12) + '...' : 'MISSING'}`);

    // 1. Validate session parameter
    if (!sessionId) {
      console.error(`❌ [Dashboard Encrypted] No session ID provided`);
      return res.status(401).json({
        success: false,
        error: 'AuthenticationRequired',
        message: 'No active session. Please authenticate with Security Clearance VC.'
      });
    }

    if (!global.userSessions || !global.userSessions.has(sessionId)) {
      console.error(`❌ [Dashboard Encrypted] Session not found: ${sessionId}`);
      return res.status(401).json({
        success: false,
        error: 'InvalidSession',
        message: 'No active session. Please authenticate with Security Clearance VC.'
      });
    }

    const session = global.userSessions.get(sessionId);

    // 2. Check session expiration
    if (session.expiresAt && new Date() > new Date(session.expiresAt)) {
      global.userSessions.delete(sessionId);
      console.error(`⏰ [Dashboard Encrypted] Session expired at: ${session.expiresAt}`);
      return res.status(401).json({
        success: false,
        error: 'SessionExpired',
        message: 'Session expired. Please re-authenticate.'
      });
    }

    console.log(`✅ [Dashboard Encrypted] Valid session found`);
    console.log(`   User: ${session.firstName || session.userData?.firstName} ${session.lastName || session.userData?.lastName}`);
    console.log(`   Clearance Level: ${session.clearanceLevel || session.clearanceData?.level || 'NONE'}`);
    console.log(`   Expires At: ${session.expiresAt}`);

    // 3. Extract X25519 public key from session
    // Session can have x25519PublicKey directly or nested in clearanceData
    let userX25519PublicKey = session.x25519PublicKey || session.clearanceData?.x25519PublicKey;

    if (!userX25519PublicKey) {
      console.error(`❌ [Dashboard Encrypted] No X25519 public key found in session`);
      console.error(`   Session structure:`, {
        hasX25519Key: !!session.x25519PublicKey,
        hasClearanceData: !!session.clearanceData,
        clearanceDataKeys: session.clearanceData ? Object.keys(session.clearanceData) : []
      });

      return res.status(400).json({
        success: false,
        error: 'MissingEncryptionKeys',
        message: 'Your Security Clearance credential does not contain X25519 encryption keys. Please request a new credential with dual-key support.'
      });
    }

    console.log(`🔑 [Dashboard Encrypted] User X25519 Public Key: ${userX25519PublicKey.substring(0, 20)}...`);

    // 4. Get user's clearance level
    // Clearance can be directly in session or nested in clearanceData
    const userClearanceLevel = session.clearanceLevel || session.clearanceData?.level || null;

    console.log(`📊 [Dashboard Encrypted] Fetching content for clearance level: ${userClearanceLevel || 'PUBLIC'}`);

    // 5. Get content sections based on clearance level
    const contentDB = require('./lib/contentDatabase');
    const allSections = await contentDB.getAccessibleContent(userClearanceLevel);

    // CRITICAL: Exclude PUBLIC sections (requiredLevel = 0)
    // PUBLIC content should NEVER be encrypted - only sent via /api/dashboard/content
    // Only encrypt sections with requiredLevel > 0 (INTERNAL, CONFIDENTIAL, RESTRICTED, SECRET)
    const sections = allSections.filter(section => {
      const requiredLevel = section.requiredLevel || 0;
      return requiredLevel > 0;
    });

    console.log(`📦 [Dashboard Encrypted] Retrieved ${allSections.length} sections total, ${sections.length} require encryption (excluding PUBLIC)`);

    // 6. Encrypt each section's content
    const encryption = require('./lib/encryption');
    const encryptedSections = [];

    for (const section of sections) {
      try {
        console.log(`🔐 [Dashboard Encrypted] Encrypting section: ${section.id} (${section.title})`);

        const encryptedContent = await encryption.encryptForUser(
          section.content,
          userX25519PublicKey
        );

        encryptedSections.push({
          id: section.id,
          title: section.title,
          clearanceBadge: section.clearanceBadge,
          badgeColor: contentDB.getClearanceBadgeColor(section.clearanceBadge),
          category: section.category,
          encryptedContent: encryptedContent
        });

        console.log(`✅ [Dashboard Encrypted] Section ${section.id} encrypted successfully`);
        console.log(`   Original size: ${section.content.length} bytes`);
        console.log(`   Ciphertext size: ${encryptedContent.ciphertext.length} characters (base64url)`);

      } catch (encryptError) {
        console.error(`❌ [Dashboard Encrypted] Failed to encrypt section ${section.id}:`, encryptError);
        return res.status(500).json({
          success: false,
          error: 'EncryptionFailed',
          message: `Encryption failed for section ${section.id}: ${encryptError.message}`
        });
      }
    }

    // 7. Prepare user info for response
    const userName = `${session.firstName || session.userData?.firstName || 'Unknown'} ${session.lastName || session.userData?.lastName || 'User'}`;

    console.log(`✅ [Dashboard Encrypted] Successfully encrypted ${encryptedSections.length} sections`);
    console.log(`   User: ${userName}`);
    console.log(`   Clearance Level: ${userClearanceLevel || 'PUBLIC'}`);
    console.log(`${'='.repeat(80)}\n`);

    // 8. Return encrypted content
    res.json({
      success: true,
      user: {
        name: userName,
        clearanceLevel: userClearanceLevel,
        authenticated: true,
        x25519PublicKey: userX25519PublicKey
      },
      sections: encryptedSections
    });

  } catch (error) {
    console.error('❌ [Dashboard Encrypted] Unexpected error:', error);
    console.error('   Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: 'Failed to retrieve encrypted content'
    });
  }
});

// ===========================================================================
// END: Phase 2 Encrypted Dashboard Content API
// ===========================================================================

// TEMPORARY: Test endpoint to create authenticated session for verification
app.post('/api/test/create-authenticated-session', (req, res) => {
  const sessionId = `test-session-${Date.now()}`;
  const sessionData = {
    sessionId: sessionId,
    authenticated: true,
    userData: {
      firstName: 'Alice',
      lastName: 'Cooper',
      uniqueId: 'CA-1758383272383-O2F257',
      dateOfBirth: '1996-06-16',
      gender: 'Female'
    },
    createdAt: new Date().toISOString(),
    authenticatedAt: new Date().toISOString()
  };

  global.userSessions.set(sessionId, sessionData);
  console.log(`🔧 [TEST] Created authenticated session: ${sessionId}`);
  console.log(`📊 [DEBUG] Total sessions in memory: ${global.userSessions.size}`);

  res.json({
    success: true,
    sessionId: sessionId,
    message: 'Test authenticated session created for Security Clearance testing',
    userData: sessionData.userData
  });
});

// TEMPORARY: Test endpoint to create authenticated session WITH clearance level
app.post('/api/test/create-session-with-clearance', (req, res) => {
  const { clearanceLevel } = req.body;

  // Validate clearance level
  const validLevels = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
  if (!clearanceLevel || !validLevels.includes(clearanceLevel.toUpperCase())) {
    return res.status(400).json({
      success: false,
      error: 'Invalid clearance level. Must be one of: INTERNAL, CONFIDENTIAL, RESTRICTED, SECRET'
    });
  }

  const sessionId = `test-session-${Date.now()}`;
  const sessionData = {
    sessionId: sessionId,
    authenticated: true,
    userData: {
      firstName: 'Alice',
      lastName: 'Cooper',
      uniqueId: 'CA-1758383272383-O2F257',
      dateOfBirth: '1996-06-16',
      gender: 'Female'
    },
    clearanceData: {
      level: clearanceLevel.toUpperCase(),
      verified: true,
      issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 1 year validity
    },
    createdAt: new Date().toISOString(),
    authenticatedAt: new Date().toISOString()
  };

  global.userSessions.set(sessionId, sessionData);
  console.log(`🔧 [TEST] Created authenticated session with ${clearanceLevel.toUpperCase()} clearance: ${sessionId}`);
  console.log(`📊 [DEBUG] Total sessions in memory: ${global.userSessions.size}`);

  res.json({
    success: true,
    sessionId: sessionId,
    message: `Test authenticated session created with ${clearanceLevel.toUpperCase()} clearance`,
    userData: sessionData.userData,
    clearanceLevel: sessionData.clearanceData.level
  });
});

// TEMPORARY: Test endpoint to create session with X25519 keys for encrypted content testing
app.post('/api/test/create-session-with-encryption', (req, res) => {
  const { clearanceLevel } = req.body;

  // Validate clearance level
  const validLevels = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
  if (!clearanceLevel || !validLevels.includes(clearanceLevel.toUpperCase())) {
    return res.status(400).json({
      success: false,
      error: 'Invalid clearance level. Must be one of: INTERNAL, CONFIDENTIAL, RESTRICTED, SECRET'
    });
  }

  const sessionId = `test-encrypted-session-${Date.now()}`;

  // Generate a test X25519 public key (base64url encoded)
  // In production, this comes from the user's Security Clearance VC
  // This is a valid test key for demonstration purposes
  const testX25519PublicKey = 'QJYjq8oYQr-z8EvpWx1-NzaVLg9H6K3_5wW2x9y3B5g';

  const sessionData = {
    sessionId: sessionId,
    authenticated: true,
    firstName: 'Alice',
    lastName: 'TestUser',
    clearanceLevel: clearanceLevel.toUpperCase(),
    x25519PublicKey: testX25519PublicKey,
    hasEncryptionCapability: true,
    userData: {
      firstName: 'Alice',
      lastName: 'TestUser',
      uniqueId: 'TEST-ENCRYPTED-001',
      dateOfBirth: '1990-01-01',
      gender: 'Female',
      clearanceLevel: clearanceLevel.toUpperCase()
    },
    clearanceData: {
      level: clearanceLevel.toUpperCase(),
      verified: true,
      x25519PublicKey: testX25519PublicKey,
      issuedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    },
    createdAt: new Date().toISOString(),
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString() // 1 hour from now
  };

  global.userSessions.set(sessionId, sessionData);
  console.log(`🔧 [TEST] Created encrypted session with ${clearanceLevel.toUpperCase()} clearance: ${sessionId}`);
  console.log(`🔑 [TEST] X25519 Public Key: ${testX25519PublicKey}`);
  console.log(`📊 [DEBUG] Total sessions in memory: ${global.userSessions.size}`);

  res.json({
    success: true,
    sessionId: sessionId,
    message: `Test encrypted session created with ${clearanceLevel.toUpperCase()} clearance and X25519 encryption keys`,
    userData: sessionData.userData,
    clearanceLevel: sessionData.clearanceLevel,
    x25519PublicKey: testX25519PublicKey,
    expiresAt: sessionData.expiresAt,
    testEndpoint: `/api/dashboard/encrypted-content?session=${sessionId}`
  });
});

// Session Bridge API - Convert browser sessionStorage to server-side session
app.post('/api/session/bridge', async (req, res) => {
  try {
    console.log('🌉 Session bridge request received');
    console.log('🔍 [DEBUG] Session bridge request body keys:', Object.keys(req.body));
    console.log('🔍 [DEBUG] Session bridge request body:', JSON.stringify(req.body, null, 2));

    const {
      sessionId,
      userData,
      authenticatedAt,
      createdAt
    } = req.body;

    console.log('🔍 [DEBUG] Extracted values:');
    console.log('🔍 [DEBUG] - sessionId:', sessionId);
    console.log('🔍 [DEBUG] - userData:', userData);
    console.log('🔍 [DEBUG] - userData.uniqueId:', userData?.uniqueId);

    // Validate required session data (generate sessionId if missing)
    if (!userData || !userData.uniqueId) {
      console.log('❌ [DEBUG] Session bridge validation failed:');
      console.log('❌ [DEBUG] - userData missing:', !userData);
      console.log('❌ [DEBUG] - userData.uniqueId missing:', !userData?.uniqueId);

      return res.status(400).json({
        success: false,
        error: 'Missing required session data (userData, userData.uniqueId)'
      });
    }

    // Generate session ID if not provided
    const finalSessionId = sessionId || crypto.randomUUID();
    console.log('🔍 [DEBUG] Using session ID:', finalSessionId, sessionId ? '(provided)' : '(generated)');

    console.log(`🌉 Creating server session for user: ${userData.uniqueId}`);

    // Also ensure user connection mapping exists
    let connectionInfo = null;
    if (global.userConnectionMappings && global.userConnectionMappings.has(userData.uniqueId)) {
      connectionInfo = global.userConnectionMappings.get(userData.uniqueId);
      console.log(`🔗 Found existing connection mapping: ${connectionInfo.connectionId}`);
    }

    // Create or update server-side session
    const session = {
      sessionId: finalSessionId,
      authenticated: true,
      userData: userData,
      connectionId: connectionInfo?.connectionId || null,
      createdAt: createdAt || new Date().toISOString(),
      authenticatedAt: authenticatedAt || new Date().toISOString(),
      bridgedAt: new Date().toISOString()
    };

    // Store in global sessions
    global.userSessions.set(finalSessionId, session);

    console.log(`✅ Session bridge successful for session: ${finalSessionId.substring(0, 8)}...`);
    console.log(`✅ Session stored for user: ${userData.firstName} ${userData.lastName} (${userData.uniqueId}), connectionId: ${session.connectionId || 'none'}`);

    // Check if userData contains holder's PRISM DID (from credentialSubject.id)
    const holderPrismDID = userData.id || null;
    const isLongFormDID = holderPrismDID && holderPrismDID.startsWith('did:prism:') && holderPrismDID.split(':').length >= 4;

    if (holderPrismDID) {
      console.log(`🔑 [SESSION-BRIDGE] Holder PRISM DID found: ${holderPrismDID.substring(0, 50)}...`);
      console.log(`   Long-form DID: ${isLongFormDID ? 'YES (can extract keys)' : 'NO (short-form)'}`);
    }

    res.json({
      success: true,
      message: 'Session bridge successful',
      sessionId: finalSessionId,
      userData: {
        firstName: userData.firstName,
        lastName: userData.lastName,
        uniqueId: userData.uniqueId
      },
      hasConnection: !!connectionInfo,
      connectionId: connectionInfo?.connectionId || null,
      // NEW: Include holder's PRISM DID for automatic key extraction
      holderPrismDID: holderPrismDID,
      canAutoExtractKeys: isLongFormDID
    });

  } catch (error) {
    console.error('❌ Session bridge error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during session bridge'
    });
  }
});

// Trigger clearance proof request on-demand
app.post('/api/request-clearance', async (req, res) => {
  try {
    const { sessionId } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [REQUEST-CLEARANCE] Manual clearance request triggered`);
    console.log(`${'='.repeat(80)}`);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    // Get session data
    const session = global.userSessions?.get(sessionId);
    if (!session || !session.authenticated) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or unauthenticated session'
      });
    }

    console.log(`📋 [REQUEST-CLEARANCE] Session found for: ${session.userData.firstName} ${session.userData.lastName}`);

    // Check if clearance already verified
    if (session.clearanceData?.verified) {
      console.log(`✅ [REQUEST-CLEARANCE] Clearance already verified: ${session.clearanceData.level}`);
      return res.json({
        success: true,
        message: 'Clearance already verified',
        clearanceLevel: session.clearanceData.level,
        alreadyVerified: true
      });
    }

    // Check if there's already a pending request for this session
    let existingProofData = null;
    if (global.clearanceProofRequests) {
      for (const [proofId, data] of global.clearanceProofRequests.entries()) {
        if (data.sessionId === sessionId) {
          existingProofData = { proofId, ...data };
          console.log(`🔍 [REQUEST-CLEARANCE] Found existing proof request: ${proofId}`);
          break;
        }
      }
    }

    // If existing request found, check its actual status from Cloud Agent
    if (existingProofData && existingProofData.presentationId) {
      try {
        console.log(`🔍 [REQUEST-CLEARANCE] Checking status of existing request...`);

        const statusResponse = await fetch(
          `${CLOUD_AGENT_URL}/present-proof/presentations/${existingProofData.presentationId}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'apikey': API_KEY
            }
          }
        );

        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          const status = statusData.status;

          console.log(`📊 [REQUEST-CLEARANCE] Existing request status: ${status}`);

          // If request is still pending/active, don't send new one
          if (status === 'RequestSent' || status === 'RequestPending' || status === 'RequestReceived') {
            return res.json({
              success: true,
              message: 'Clearance proof request already sent. Please check your wallet.',
              proofId: existingProofData.proofId,
              alreadyRequested: true
            });
          }

          // If request was declined/rejected/problem-report, remove it and send new one
          if (status === 'ProblemReportReceived' || status === 'Rejected' || status === 'Declined') {
            console.log(`🗑️ [REQUEST-CLEARANCE] Previous request was declined/rejected. Removing and sending new one.`);
            global.clearanceProofRequests.delete(existingProofData.proofId);
            // Continue to send new request below
          }

          // If verified, just return success
          if (status === 'PresentationVerified' || status === 'Verified') {
            console.log(`✅ [REQUEST-CLEARANCE] Request already verified!`);
            // The dashboard polling will pick this up
            return res.json({
              success: true,
              message: 'Clearance already verified. Refreshing dashboard...',
              alreadyVerified: true
            });
          }
        }
      } catch (statusError) {
        console.warn(`⚠️ [REQUEST-CLEARANCE] Could not check existing request status:`, statusError.message);
        // Continue to send new request if status check fails
        global.clearanceProofRequests.delete(existingProofData.proofId);
      }
    }

    // Get connectionId from session
    const connectionId = session.connectionId;
    if (!connectionId) {
      return res.status(400).json({
        success: false,
        error: 'No connection ID found in session. Please authenticate first.'
      });
    }

    console.log(`🔗 [REQUEST-CLEARANCE] Using connection: ${connectionId}`);

    // Create presentation request for Security Clearance VC
    const clearanceProofId = `clearance-proof-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const clearancePresentationRequest = {
      connectionId: connectionId,
      proofs: [
        {
          // SecurityClearanceLevel v5.0.0 — the current preferred issuance version (see the
          // ['5.0.0','4.0.0','3.0.0'] preference order used when issuing). A stale version
          // GUID here causes the Cloud Agent's post-hoc schema check to reject a real,
          // correctly-typed credential as PresentationVerificationFailed (verified live).
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/78f56570-1405-3847-9e5c-87f582722711',
          trustIssuers: await getTrustedIssuerDIDs() // constrain to DIDs this CA actually controls
        }
      ],
      options: {
        challenge: clearanceProofId,
        // Wallet-side schema hint — see the domain comment on the DIDComm identity-auth
        // proof request above (Cloud Agent doesn't forward goalCode/claims to the wallet).
        domain: 'clearance.identuslabel.cz'
      },
      credentialFormat: 'JWT',
      goalCode: 'schema:SecurityClearance',
      goal: 'Please provide your Security Clearance Credential to access restricted content',
      claims: {
        clearanceLevel: {},
        issuedDate: {},
        expiryDate: {}
      }
    };

    // Send presentation request via Cloud Agent
    const presentationResponse = await fetch(
      `${CLOUD_AGENT_URL}/present-proof/presentations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY
        },
        body: JSON.stringify(clearancePresentationRequest)
      }
    );

    if (!presentationResponse.ok) {
      const errorText = await presentationResponse.text();
      console.error(`❌ [REQUEST-CLEARANCE] Cloud Agent error:`, errorText);
      return res.status(500).json({
        success: false,
        error: 'Failed to send clearance proof request',
        details: errorText
      });
    }

    const presentationData = await presentationResponse.json();
    const presentationId = presentationData.presentationId || presentationData.id;

    console.log(`✅ [REQUEST-CLEARANCE] Clearance proof request sent successfully`);
    console.log(`   Proof ID: ${clearanceProofId}`);
    console.log(`   Presentation ID: ${presentationId}`);

    // Store clearance proof request in tracking
    if (!global.clearanceProofRequests) {
      global.clearanceProofRequests = new Map();
    }

    global.clearanceProofRequests.set(clearanceProofId, {
      sessionId: sessionId,
      connectionId: connectionId,
      uniqueId: session.userData.uniqueId,
      presentationId: presentationId,
      status: 'requested',
      requestedAt: new Date().toISOString()
    });

    console.log(`📋 [REQUEST-CLEARANCE] Proof request stored for session ${sessionId.substring(0, 8)}...`);
    console.log(`${'='.repeat(80)}\n`);

    res.json({
      success: true,
      message: 'Clearance proof request sent to your wallet. Please check your wallet to submit your Security Clearance credential.',
      proofId: clearanceProofId,
      presentationId: presentationId
    });

  } catch (error) {
    console.error('❌ [REQUEST-CLEARANCE] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Get clearance level for a session (used by dashboard)
app.get('/api/session/clearance-level', async (req, res) => {
  try {
    const { sessionId } = req.query;

    console.log('🔐 [CLEARANCE-CHECK] Request for session:', sessionId?.substring(0, 8) + '...');

    // Validate sessionId
    if (!sessionId) {
      console.log('❌ Missing sessionId parameter');
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    // Get session data from userSessions
    const sessionData = global.userSessions?.get(sessionId);
    if (!sessionData) {
      console.log('❌ Invalid or expired session:', sessionId?.substring(0, 8) + '...');
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired session'
      });
    }

    console.log('✅ [CLEARANCE-CHECK] Session found for user:', sessionData.userData?.firstName, sessionData.userData?.lastName);

    // If clearance already verified, return cached data
    if (sessionData.clearanceData && sessionData.clearanceData.verified) {
      console.log('✅ [CLEARANCE-CHECK] Returning cached clearance:', sessionData.clearanceData.level);
      return res.json({
        success: true,
        userData: {
          firstName: sessionData.userData?.firstName || 'Unknown',
          lastName: sessionData.userData?.lastName || 'User'
        },
        clearanceLevel: sessionData.clearanceData.level,
        clearanceValid: true
      });
    }

    // Check if there's a pending clearance proof request for this session
    let clearanceProofData = null;
    if (global.clearanceProofRequests) {
      for (const [proofId, data] of global.clearanceProofRequests.entries()) {
        if (data.sessionId === sessionId) {
          clearanceProofData = { proofId, ...data };
          break;
        }
      }
    }

    if (!clearanceProofData || !clearanceProofData.presentationId) {
      console.log('⏳ [CLEARANCE-CHECK] No clearance request found yet');
      return res.json({
        success: true,
        userData: {
          firstName: sessionData.userData?.firstName || 'Unknown',
          lastName: sessionData.userData?.lastName || 'User'
        },
        clearanceLevel: null,
        clearanceValid: false
      });
    }

    console.log('🔍 [CLEARANCE-CHECK] Checking Cloud Agent for presentation:', clearanceProofData.presentationId);

    // Poll Cloud Agent for presentation status
    const cloudAgentResponse = await fetch(
      `${CLOUD_AGENT_URL}/present-proof/presentations/${clearanceProofData.presentationId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY
        }
      }
    );

    if (!cloudAgentResponse.ok) {
      console.error('❌ [CLEARANCE-CHECK] Cloud Agent error:', await cloudAgentResponse.text());
      return res.json({
        success: true,
        userData: {
          firstName: sessionData.userData?.firstName || 'Unknown',
          lastName: sessionData.userData?.lastName || 'User'
        },
        clearanceLevel: null,
        clearanceValid: false
      });
    }

    const presentationData = await cloudAgentResponse.json();
    const presentationStatus = presentationData.status;

    console.log('📊 [CLEARANCE-CHECK] Presentation status:', presentationStatus);

    // Check if presentation is verified
    if (presentationStatus === 'PresentationVerified' || presentationStatus === 'Verified') {
      console.log('✅ [CLEARANCE-CHECK] Clearance presentation verified! Extracting claims...');

      // Extract and decode presentation JWT (same pattern as RealPerson VC)
      let presentation = null;
      let verifiedClaims = null;

      // Cloud Agent returns presentation as JWT in data array
      if (presentationData.data && Array.isArray(presentationData.data) && presentationData.data.length > 0) {
        try {
          const presentationJWT = presentationData.data[0];
          console.log('📝 [CLEARANCE-CHECK] Decoding presentation JWT...');

          // Decode JWT (base64url decode the payload)
          const parts = presentationJWT.split('.');
          if (parts.length === 3) {
            const payloadBase64 = parts[1];
            const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
            const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
            const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
            const payload = JSON.parse(payloadJson);

            console.log('✅ [CLEARANCE-CHECK] Presentation JWT decoded successfully');
            presentation = payload.vp; // Extract Verifiable Presentation from JWT payload
          }
        } catch (decodeError) {
          console.error('❌ [CLEARANCE-CHECK] Failed to decode presentation JWT:', decodeError.message);
        }
      } else {
        // Try legacy format
        presentation = presentationData.data?.presentation || presentationData.presentation;
      }

      // Extract verified claims from verifiable credential
      if (presentation && presentation.verifiableCredential && presentation.verifiableCredential.length > 0) {
        const credentialJWT = presentation.verifiableCredential[0];

        // Check if credential is a JWT string
        if (typeof credentialJWT === 'string' && credentialJWT.includes('.')) {
          try {
            console.log('📝 [CLEARANCE-CHECK] Decoding credential JWT...');

            // Decode JWT (base64url decode the payload)
            const parts = credentialJWT.split('.');
            if (parts.length === 3) {
              const payloadBase64 = parts[1];
              const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
              const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
              const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
              const payload = JSON.parse(payloadJson);

              console.log('✅ [CLEARANCE-CHECK] Credential JWT decoded successfully');

              // Extract credential subject from VC
              if (payload.vc && payload.vc.credentialSubject) {
                verifiedClaims = payload.vc.credentialSubject;
                console.log('✅ [CLEARANCE-CHECK] Claims extracted from VC');
              }
            }
          } catch (decodeError) {
            console.error('❌ [CLEARANCE-CHECK] Failed to decode credential JWT:', decodeError.message);
          }
        } else if (credentialJWT.credentialSubject) {
          // Legacy format - credential is already an object
          verifiedClaims = credentialJWT.credentialSubject;
        }
      }

      // Extract clearance level from verified claims
      let clearanceLevel = null;
      if (verifiedClaims) {
        clearanceLevel = verifiedClaims.clearanceLevel ||
                        verifiedClaims.securityLevel ||
                        verifiedClaims.level ||
                        null;

        if (clearanceLevel) {
          console.log('🎯 [CLEARANCE-CHECK] Found clearance level:', clearanceLevel);

          // Store in session
          sessionData.clearanceData = {
            level: clearanceLevel.toUpperCase(),
            verified: true,
            issuedAt: verifiedClaims.issuanceDate || verifiedClaims.issued || new Date().toISOString(),
            validUntil: verifiedClaims.expirationDate || verifiedClaims.validUntil || null,
            issuer: verifiedClaims.issuer || 'Unknown',
            credentialId: verifiedClaims.id || verifiedClaims.credentialId || 'Unknown',
            allClaims: verifiedClaims // Store all claims for reference
          };
          sessionData.clearanceVerifiedAt = new Date().toISOString();
          global.userSessions.set(sessionId, sessionData);

          // Remove from pending requests
          global.clearanceProofRequests.delete(clearanceProofData.proofId);

          console.log('💾 [CLEARANCE-CHECK] Clearance data saved to session');
        } else {
          console.warn('⚠️ [CLEARANCE-CHECK] Clearance level field not found in claims:', Object.keys(verifiedClaims));
        }
      } else {
        console.error('❌ [CLEARANCE-CHECK] Failed to extract verified claims from presentation');
      }

      if (clearanceLevel) {
        return res.json({
          success: true,
          userData: {
            firstName: sessionData.userData?.firstName || 'Unknown',
            lastName: sessionData.userData?.lastName || 'User'
          },
          clearanceLevel: clearanceLevel.toUpperCase(),
          clearanceValid: true
        });
      }
    }

    // Still waiting for presentation
    console.log('⏳ [CLEARANCE-CHECK] Still waiting for clearance submission');
    return res.json({
      success: true,
      userData: {
        firstName: sessionData.userData?.firstName || 'Unknown',
        lastName: sessionData.userData?.lastName || 'User'
      },
      clearanceLevel: null,
      clearanceValid: false
    });

  } catch (error) {
    console.error('❌ [CLEARANCE-CHECK] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Issue Security Clearance using new SecurityClearanceLevel schema (requires RealPerson authentication)
app.post('/api/credentials/issue-security-clearance', async (req, res) => {
  try {
    const {
      sessionId,
      connectionId,
      clearanceLevel,
      publicKey,           // Legacy: Ed25519 public key from wallet (v2.0.0)
      ed25519PublicKey,    // New: Ed25519 public key (v3.0.0)
      x25519PublicKey,     // New: X25519 public key (v3.0.0)
      holderPrismDID       // NEW: Optional PRISM DID to auto-extract keys from
    } = req.body;

    // ✅ NEW: Support PRISM DID-based automatic key extraction
    let extractedKeys = null;
    let finalEd25519Key = ed25519PublicKey;
    let finalX25519Key = x25519PublicKey;

    if (holderPrismDID && isLongFormPrismDID(holderPrismDID)) {
      console.log('🔑 [WEB-ISSUANCE] PRISM DID provided - attempting automatic key extraction');
      console.log(`   PRISM DID: ${holderPrismDID.substring(0, 60)}...`);

      extractedKeys = extractSecurityClearanceKeysFromPrismDID(holderPrismDID);

      if (extractedKeys.complete) {
        // Both keys extracted from PRISM DID - use them
        finalEd25519Key = extractedKeys.ed25519.publicKey;
        finalX25519Key = extractedKeys.x25519.publicKey;
        console.log('✅ [WEB-ISSUANCE] Successfully extracted both keys from PRISM DID');
        console.log(`   Ed25519: ${finalEd25519Key.substring(0, 16)}...`);
        console.log(`   X25519: ${finalX25519Key.substring(0, 16)}...`);
      } else {
        console.warn('⚠️ [WEB-ISSUANCE] PRISM DID does not contain complete key set');
        console.log(`   Ed25519: ${extractedKeys.ed25519 ? 'found' : 'MISSING'}`);
        console.log(`   X25519: ${extractedKeys.x25519 ? 'found' : 'MISSING'}`);
        // Fall back to manually provided keys if available
        if (extractedKeys.x25519 && !finalX25519Key) {
          finalX25519Key = extractedKeys.x25519.publicKey;
          console.log('   Using X25519 from PRISM DID, Ed25519 from manual input');
        }
        if (extractedKeys.ed25519 && !finalEd25519Key) {
          finalEd25519Key = extractedKeys.ed25519.publicKey;
          console.log('   Using Ed25519 from PRISM DID, X25519 from manual input');
        }
      }
    }

    // Early log - format detection will be done AFTER session-based extraction
    console.log('🔍 [WEB-ISSUANCE] Security Clearance request received');
    console.log(`   Clearance Level: ${clearanceLevel}`);

    // Validate session and authentication
    if (!sessionId || !global.userSessions.has(sessionId)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired session. Please authenticate with RealPerson VC first.'
      });
    }

    const session = global.userSessions.get(sessionId);

    // Check if session is authenticated with RealPerson VC
    if (!session.authenticated || !session.userData) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated. Please present your RealPerson VC first.'
      });
    }

    // ✅ AUTO-EXTRACT: If no holderPrismDID provided, try to get it from session.userData.id
    // This is the credentialSubject.id from the RealPerson VC (holder's PRISM DID)
    let effectiveHolderPrismDID = holderPrismDID;
    if (!effectiveHolderPrismDID && session.userData.id) {
      effectiveHolderPrismDID = session.userData.id;
      console.log('🔑 [WEB-ISSUANCE] Using holder PRISM DID from session (RealPerson VC credentialSubject.id)');
      console.log(`   PRISM DID: ${effectiveHolderPrismDID.substring(0, 60)}...`);
    }

    // Re-run key extraction with the effective holder PRISM DID
    if (effectiveHolderPrismDID && isLongFormPrismDID(effectiveHolderPrismDID) && !extractedKeys) {
      console.log('🔑 [WEB-ISSUANCE] Attempting automatic key extraction from session PRISM DID');
      extractedKeys = extractSecurityClearanceKeysFromPrismDID(effectiveHolderPrismDID);

      if (extractedKeys.x25519) {
        finalX25519Key = extractedKeys.x25519.publicKey;
        console.log(`✅ [WEB-ISSUANCE] X25519 key extracted from session PRISM DID: ${finalX25519Key.substring(0, 16)}...`);
      }
      if (extractedKeys.ed25519) {
        finalEd25519Key = extractedKeys.ed25519.publicKey;
        console.log(`✅ [WEB-ISSUANCE] Ed25519 key extracted from session PRISM DID: ${finalEd25519Key.substring(0, 16)}...`);
      }
    }

    // Validate clearance level
    const validLevels = ['internal', 'confidential', 'restricted', 'secret'];
    if (!validLevels.includes(clearanceLevel)) {
      return res.status(400).json({
        success: false,
        error: `Invalid clearance level. Must be one of: ${validLevels.join(', ')}`
      });
    }

    // Re-compute format detection AFTER potential session-based extraction
    const isDualKeyFormat = !!(finalEd25519Key && finalX25519Key);
    const isPrismDIDX25519Only = !!(extractedKeys && extractedKeys.x25519 && !extractedKeys.ed25519);
    const isPrismDIDExtracted = !!(extractedKeys && (extractedKeys.complete || isPrismDIDX25519Only));
    const isValidFormat = isDualKeyFormat || isPrismDIDX25519Only || !!finalX25519Key;

    console.log('🔍 [WEB-ISSUANCE] Format detection (after session extraction):');
    console.log(`   isDualKeyFormat: ${isDualKeyFormat}`);
    console.log(`   isPrismDIDX25519Only: ${isPrismDIDX25519Only}`);
    console.log(`   isPrismDIDExtracted: ${isPrismDIDExtracted}`);
    console.log(`   isValidFormat: ${isValidFormat}`);
    console.log(`   finalX25519Key: ${finalX25519Key ? finalX25519Key.substring(0, 16) + '...' : 'null'}`);
    console.log(`   finalEd25519Key: ${finalEd25519Key ? finalEd25519Key.substring(0, 16) + '...' : 'null'}`);

    // ✅ ENFORCE X25519 REQUIRED - Either dual-key format OR PRISM DID with X25519
    if (!isValidFormat) {
      console.error('❌ [WEB-ISSUANCE] Security Clearance requires X25519 encryption keys');
      return res.status(400).json({
        success: false,
        error: 'Security Clearance credentials REQUIRE X25519 encryption keys',
        message: 'Please provide holderPrismDID (with X25519 key) OR both ed25519PublicKey and x25519PublicKey.',
        required: {
          holderPrismDID: 'Long-form PRISM DID containing X25519 key (PREFERRED - Ed25519 optional)',
          ed25519PublicKey: 'Ed25519 public key for digital signatures (32 bytes, base64url) - optional for PRISM DID mode',
          x25519PublicKey: 'X25519 public key for encryption (32 bytes, base64url) - REQUIRED'
        }
      });
    }

    // Validate cryptographic keys
    if (isPrismDIDX25519Only) {
      console.log('✅ [WEB-ISSUANCE] Processing PRISM-DID-X25519-ONLY mode - Ed25519 NOT required');
    } else {
      console.log('✅ [WEB-ISSUANCE] Processing DUAL-KEY format (v3.0.0/v4.0.0) - X25519 REQUIRED');
    }

    // Validate Ed25519 key (only required for dual-key format, optional for PRISM DID X25519-only mode)
    if (finalEd25519Key && !validateEd25519PublicKey(finalEd25519Key)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Ed25519 public key format',
        message: 'Ed25519 public key must be 32 bytes base64url encoded.'
      });
    }

    // Validate X25519 key (MANDATORY for all modes)
    if (!finalX25519Key || !validateX25519PublicKey(finalX25519Key)) {
      console.error('❌ [WEB-ISSUANCE] Invalid or missing X25519 public key - REQUIRED for Security Clearance');
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing X25519 public key',
        message: 'X25519 encryption key is REQUIRED for all Security Clearance credentials. Must be 32 bytes base64url encoded.'
      });
    }

    const validatedEd25519Key = finalEd25519Key || null;  // Can be null in X25519-only mode
    const ed25519Fingerprint = finalEd25519Key ? generateEd25519Fingerprint(finalEd25519Key) : null;
    const validatedX25519Key = finalX25519Key;
    const x25519Fingerprint = generateX25519Fingerprint(finalX25519Key);

    if (ed25519Fingerprint) {
      console.log(`🔐 [WEB-ISSUANCE] Ed25519 Fingerprint: ${ed25519Fingerprint}`);
    } else {
      console.log(`🔐 [WEB-ISSUANCE] Ed25519: NOT PROVIDED (X25519-only mode)`);
    }
    console.log(`🔐 [WEB-ISSUANCE] X25519 Fingerprint: ${x25519Fingerprint} ✅ ENCRYPTION ENABLED`);
    if (isPrismDIDExtracted) {
      console.log(`🔐 [WEB-ISSUANCE] Keys extracted from PRISM DID: ${holderPrismDID.substring(0, 50)}...`);
    }
    
    console.log(`🔐 Issuing ${clearanceLevel.toUpperCase()} Security Clearance to authenticated user: ${session.userData.firstName} ${session.userData.lastName}`);

    // Simple: Use connectionId directly from URL parameter
    if (!connectionId) {
      return res.status(400).json({
        success: false,
        error: 'No connectionId provided. Please access this page with ?connectionId=your-connection-id'
      });
    }

    console.log(`🔗 Using connectionId from URL parameter: ${connectionId}`);
    
    // Get the authority's DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DID');
    }
    
    const dids = await didResponse.json();
    const issuingDID = dids.contents[0].did;
    
    // Get the appropriate Security Clearance schema based on level
    // Fallback to existing schemas until SecurityClearanceLevel v2.0.0 is created
    const schemaResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      }
    });

    if (!schemaResponse.ok) {
      throw new Error('Failed to fetch schemas');
    }

    const schemaData = await schemaResponse.json();
    const schemas = schemaData.contents || schemaData;

    // Select appropriate schema version (DUAL-KEY ONLY - v4.0.0 preferred, v3.0.0 fallback)
    let selectedSchema = null;
    let schemaVersion = null;

    // Try v5.0.0 first (SECRET replaces TOP-SECRET), then v4.0.0, then v3.0.0
    for (const ver of ['5.0.0', '4.0.0', '3.0.0']) {
      selectedSchema = schemas.find(s => s.name === 'SecurityClearanceLevel' && s.version === ver);
      if (selectedSchema) { schemaVersion = ver; break; }
    }

    if (!selectedSchema) {
      throw new Error('SecurityClearanceLevel dual-key schema (v5.0.0/v4.0.0/v3.0.0) not found. Legacy format (v2.0.0) is no longer supported.');
    }

    console.log(`📋 [WEB-ISSUANCE] Using schema: SecurityClearanceLevel v${schemaVersion} (DUAL-KEY with X25519)`);
    
    // Set expiry based on clearance level
    const expiryYears = {
      'internal': 1,
      'confidential': 2,
      'restricted': 3,
      'secret': 5
    };

    const issuedDate = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + expiryYears[clearanceLevel]);

    // Generate unique clearance ID
    const clearanceId = `SC-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Prepare credential claims based on schema version and format
    let credentialData = {};

    if ((isDualKeyFormat || isPrismDIDX25519Only) && (schemaVersion === '3.0.0' || schemaVersion === '4.0.0' || schemaVersion === '5.0.0')) {
      // Dual-key or X25519-only format with v3.0.0/v4.0.0/v5.0.0 schema (FLAT structure - Cloud Agent doesn't support nested objects)
      const formatMode = isPrismDIDX25519Only ? 'X25519-ONLY (PRISM DID auto-extracted)' : 'DUAL-KEY';
      console.log(`📝 [WEB-ISSUANCE] Building ${formatMode} credential claims (v${schemaVersion} - flat)`);

      credentialData = {
        credentialType: 'SecurityClearance',
        clearanceLevel: clearanceLevel.toUpperCase(),
        holderName: `${session.userData.firstName} ${session.userData.lastName}`,
        holderUniqueId: session.userData.uniqueId,
        // Ed25519 fields - omit if null (X25519-only mode)
        ...(validatedEd25519Key && { ed25519PublicKey: validatedEd25519Key }),
        ...(ed25519Fingerprint && { ed25519Fingerprint: ed25519Fingerprint }),
        // X25519 fields - always present
        x25519PublicKey: validatedX25519Key,
        x25519Fingerprint: x25519Fingerprint,
        keyDerivationRelationship: isPrismDIDX25519Only ? 'prism-did-key-agreement' : 'derived-from-same-seed',
        issuedDate: issuedDate.toISOString().split('T')[0],
        expiryDate: expiryDate.toISOString().split('T')[0],
        clearanceId: clearanceId,
        issuingAuthority: 'Certification Authority',
        requiresMultiFactorAuth: clearanceLevel === 'secret' || clearanceLevel === 'restricted',
        allowsDigitalSigning: !!validatedEd25519Key,  // Only if Ed25519 provided
        allowsEncryption: true
      };

      // Add holder PRISM DID if available (for X25519-only mode, it's always available)
      if (holderPrismDID) {
        credentialData.holderPrismDID = holderPrismDID;
      }

      console.log(`🔑 [WEB-ISSUANCE] Keys included in credential:`);
      if (ed25519Fingerprint) {
        console.log(`   Ed25519: ${ed25519Fingerprint}`);
      } else {
        console.log(`   Ed25519: NOT INCLUDED (X25519-only mode)`);
      }
      console.log(`   X25519: ${x25519Fingerprint}`);

    } else {
      // Legacy format with v2.0.0 schema (flat structure)
      console.log('📝 [WEB-ISSUANCE] Building LEGACY credential claims (v2.0.0)');

      credentialData = {
        clearanceLevel: clearanceLevel.toLowerCase(),
        clearanceId: clearanceId,
        issuedDate: issuedDate.toISOString(),
        expiryDate: expiryDate.toISOString(),
        publicKey: validatedEd25519Key,
        keyAlgorithm: 'Ed25519',
        keyFingerprint: ed25519Fingerprint,
        holderUniqueId: session.userData.uniqueId,
        holderName: `${session.userData.firstName} ${session.userData.lastName}`,
        issuingAuthority: 'Certification Authority',
        requiresMultiFactorAuth: clearanceLevel === 'secret' || clearanceLevel === 'restricted',
        allowsDigitalSigning: true,
        allowsEncryption: true
      };

      console.log(`🔑 [WEB-ISSUANCE] Ed25519 key included in credential: ${ed25519Fingerprint}`);
    }

    // CRITICAL: Final validation of connection state before credential offer
    console.log(`🔍 Final validation - Using connection ID: ${connectionId}`);
    const finalConnValidation = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}`, {
      headers: {
        'apikey': API_KEY
      }
    });

    if (finalConnValidation.ok) {
      const finalConnData = await finalConnValidation.json();
      console.log(`🔍 Final connection state: ${finalConnData.state}`);

      if (!['ConnectionResponseReceived', 'ConnectionResponseSent', 'Active'].includes(finalConnData.state)) {
        throw new Error(`Connection ${connectionId} is in invalid state for credential issuance: ${finalConnData.state}. Please ensure DIDComm connection is properly established.`);
      }
    } else {
      throw new Error(`Failed to validate connection ${connectionId} before credential issuance`);
    }

    // Enrich claims with W3C-compliant metadata
    const validityPeriods = {
      'confidential': 63072000,    // 2 years
      'secret': 31536000,          // 1 year
      'restricted': 15768000,      // 6 months
      'internal': 31536000         // 1 year
    };

    const validitySeconds = validityPeriods[clearanceLevel] || 31536000;

    const enrichedClaims = {
      ...credentialData,
      credentialType: 'SecurityClearance'
    };

    // Create credential offer using Cloud Agent documented API structure
    const credentialOffer = {
      // REQUIRED fields
      connectionId: connectionId,
      issuingDID: issuingDID,  // From Cloud Agent DID registry
      claims: enrichedClaims,

      // OPTIONAL fields
      credentialFormat: 'JWT',
      automaticIssuance: false,  // Require manual approval
      schemaId: `${CLOUD_AGENT_URL}${selectedSchema.self}`,
      validityPeriod: validitySeconds  // Will set JWT exp claim
    };

    console.log('📋 [WEB-ISSUANCE] Sending clearance credential offer:', JSON.stringify(credentialOffer, null, 2));

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ [WEB-ISSUANCE] Cloud Agent credential offer failed:', response.status, errorText);
      throw new Error(`Cloud Agent error: ${response.status} - ${errorText}`);
    }

    const offerData = await response.json();
    console.log(`✅ [WEB-ISSUANCE] Security Clearance credential offered: ${offerData.recordId}`);

    // Store cryptographic keys securely (server-side)
    if (!global.securityPublicKeys) {
      global.securityPublicKeys = new Map();
    }

    if (isDualKeyFormat) {
      // Store dual keys
      global.securityPublicKeys.set(clearanceId, {
        format: 'dual-key',
        schemaVersion: schemaVersion,
        ed25519: {
          publicKey: validatedEd25519Key,
          fingerprint: ed25519Fingerprint
        },
        x25519: {
          publicKey: validatedX25519Key,
          fingerprint: x25519Fingerprint
        },
        holderInfo: session.userData,
        clearanceLevel: clearanceLevel,
        connectionId: connectionId,
        issuedAt: issuedDate.toISOString()
      });

      console.log(`🔐 [WEB-ISSUANCE] Dual-key pair stored securely for clearance: ${clearanceId}`);
      console.log(`   Ed25519: ${ed25519Fingerprint}`);
      console.log(`   X25519: ${x25519Fingerprint}`);

    } else {
      // Store legacy single key
      global.securityPublicKeys.set(clearanceId, {
        format: 'legacy',
        schemaVersion: schemaVersion,
        publicKey: validatedEd25519Key,
        fingerprint: ed25519Fingerprint,
        algorithm: 'Ed25519',
        holderInfo: session.userData,
        clearanceLevel: clearanceLevel,
        connectionId: connectionId,
        issuedAt: issuedDate.toISOString()
      });

      console.log(`🔐 [WEB-ISSUANCE] Ed25519 public key stored securely for clearance: ${clearanceId} (legacy format)`);
    }

    // Build response object
    const responseData = {
      success: true,
      recordId: offerData.recordId,
      thid: offerData.thid,
      clearanceId: clearanceId,
      clearanceLevel: clearanceLevel,
      issuedTo: `${session.userData.firstName} ${session.userData.lastName}`,
      validUntil: expiryDate.toISOString(),
      schemaVersion: schemaVersion,
      format: isDualKeyFormat ? 'dual-key' : 'legacy',
      message: `${clearanceLevel.toUpperCase()} Security Clearance issued successfully`
    };

    // Add key information based on format
    if (isDualKeyFormat) {
      responseData.keys = {
        ed25519: {
          fingerprint: ed25519Fingerprint,
          algorithm: 'Ed25519'
        },
        x25519: {
          fingerprint: x25519Fingerprint,
          algorithm: 'X25519'
        }
      };
    } else {
      responseData.keyFingerprint = ed25519Fingerprint;
      responseData.keyAlgorithm = 'Ed25519';
    }

    res.json(responseData);
  } catch (error) {
    console.error('❌ Error issuing security clearance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DIDComm Security Clearance Service - Direct wallet-to-CA credential requests
app.post('/api/didcomm/request-security-clearance', async (req, res) => {
  try {
    console.log('🔐 DIDComm Security Clearance request received');
    console.log('🔍 Request body:', JSON.stringify(req.body, null, 2));

    const {
      walletDID,           // Wallet's DID used for the connection
      clearanceLevel,      // confidential, restricted, etc.
      publicKey,           // Legacy: Ed25519 public key from wallet (v2.0.0)
      ed25519PublicKey,    // New: Ed25519 public key (v3.0.0)
      x25519PublicKey,     // New: X25519 public key (v3.0.0)
      userInfo             // Optional: additional user context
    } = req.body;

    // Detect format version
    const isDualKeyFormat = !!(ed25519PublicKey && x25519PublicKey);
    const isLegacyFormat = !!(publicKey && !ed25519PublicKey && !x25519PublicKey);

    console.log('🔍 Extracted fields:');
    console.log(`   walletDID: ${walletDID}`);
    console.log(`   clearanceLevel: ${clearanceLevel}`);
    console.log(`   🆕 Format: ${isDualKeyFormat ? 'DUAL-KEY (v3.0.0)' : isLegacyFormat ? 'LEGACY (v2.0.0)' : 'UNKNOWN'}`);

    if (isDualKeyFormat) {
      console.log(`   ed25519PublicKey: ${ed25519PublicKey?.substring(0, 20)}...`);
      console.log(`   x25519PublicKey: ${x25519PublicKey?.substring(0, 20)}...`);
    } else if (isLegacyFormat) {
      console.log(`   publicKey (legacy): ${publicKey?.substring(0, 20)}...`);
    }
    console.log(`   userInfo: ${JSON.stringify(userInfo)}`);

    // Validate required fields based on format
    if (!walletDID || !clearanceLevel) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: walletDID, clearanceLevel'
      });
    }

    // ✅ ENFORCEMENT: Only dual-key format accepted (X25519 required)
    if (!isDualKeyFormat) {
      return res.status(400).json({
        success: false,
        error: 'Security Clearance credentials REQUIRE X25519 encryption keys',
        message: 'Please provide both ed25519PublicKey and x25519PublicKey. Legacy format is no longer supported.',
        required: {
          ed25519PublicKey: 'Ed25519 public key for digital signatures (32 bytes, base64url)',
          x25519PublicKey: 'X25519 public key for encryption (32 bytes, base64url) - REQUIRED'
        }
      });
    }

    // Validate clearance level
    const validLevels = ['internal', 'confidential', 'restricted', 'secret'];
    if (!validLevels.includes(clearanceLevel.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid clearance level. Must be one of: ${validLevels.join(', ')}`
      });
    }

    // Validate keys based on format
    let validatedEd25519Key = null;
    let ed25519Fingerprint = null;
    let validatedX25519Key = null;
    let x25519Fingerprint = null;

    // ✅ Validate dual-key format (MANDATORY)
    console.log('✅ Processing DUAL-KEY format with X25519 encryption');

    // Validate Ed25519 public key
    if (!validateEd25519PublicKey(ed25519PublicKey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Ed25519 public key format',
        message: 'Ed25519 public key must be 32 bytes base64url encoded'
      });
    }

    // Validate X25519 public key (MANDATORY)
    if (!x25519PublicKey || !validateX25519PublicKey(x25519PublicKey)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing X25519 public key',
        message: 'X25519 encryption key is REQUIRED for all Security Clearance credentials. Must be 32 bytes base64url encoded.'
      });
    }

    validatedEd25519Key = ed25519PublicKey;
    ed25519Fingerprint = generateEd25519Fingerprint(ed25519PublicKey);
    validatedX25519Key = x25519PublicKey;
    x25519Fingerprint = generateX25519Fingerprint(x25519PublicKey);

    console.log(`🔐 Ed25519 Fingerprint: ${ed25519Fingerprint}`);
    console.log(`🔐 X25519 Fingerprint: ${x25519Fingerprint}`);

    console.log(`🔐 Processing security clearance request:`);
    console.log(`   📋 Level: ${clearanceLevel}`);
    console.log(`   🔑 Ed25519 Key: ${validatedEd25519Key.substring(0, 20)}...`);
    if (validatedX25519Key) {
      console.log(`   🔐 X25519 Key: ${validatedX25519Key.substring(0, 20)}...`);
    }
    console.log(`   👤 Wallet DID: ${walletDID.substring(0, 60)}...`);

    // Find connection by wallet DID (search through theirDid field)
    let connectionId = null;
    let userUniqueId = null;

    // Check if we have a direct connection mapping
    console.log(`🔍 [DIDCOMM DEBUG] Checking connection mappings for walletDID: ${walletDID}`);
    console.log(`🔍 [DIDCOMM DEBUG] Available mappings:`, global.userConnectionMappings ? Array.from(global.userConnectionMappings.entries()) : 'None');

    if (global.userConnectionMappings) {
      for (const [userId, mapping] of global.userConnectionMappings.entries()) {
        console.log(`🔍 [DIDCOMM DEBUG] Checking mapping: ${userId} -> ${mapping.connectionId} (walletDID: ${mapping.walletDID})`);
        if (mapping.walletDID === walletDID) {
          connectionId = mapping.connectionId;
          userUniqueId = userId;
          console.log(`🔗 [DIDCOMM DEBUG] Found connection mapping: ${connectionId} for user: ${userUniqueId}`);
          break;
        }
      }
    }

    console.log(`🔍 [DIDCOMM DEBUG] After mapping search - connectionId: ${connectionId}, userUniqueId: ${userUniqueId}`);

    // If no direct mapping, get connections from Cloud Agent and search
    if (!connectionId) {
      console.log('🔍 [DIDCOMM DEBUG] No direct mapping found, searching Cloud Agent connections for wallet DID...');

      const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
        method: 'GET',
        headers: {
          'apikey': API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!connectionsResponse.ok) {
        throw new Error(`Failed to fetch connections: ${connectionsResponse.status}`);
      }

      const connectionsData = await connectionsResponse.json();
      const connections = connectionsData.contents || connectionsData;

      console.log(`🔍 [DIDCOMM DEBUG] Found ${connections.length} total connections`);

      // Log all connections for debugging
      connections.forEach((conn, index) => {
        console.log(`🔍 [DIDCOMM DEBUG] Connection ${index + 1}: ${conn.connectionId} - State: ${conn.state} - TheirDID: ${conn.theirDid ? conn.theirDid.substring(0, 60) + '...' : 'None'}`);
      });

      // Find connection where theirDid matches the wallet DID with broader state acceptance
      const validStates = ['ConnectionResponseReceived', 'ConnectionResponseSent', 'Connected'];
      const matchingConnection = connections.find(conn =>
        conn.theirDid === walletDID && validStates.includes(conn.state)
      );

      console.log(`🔍 [DIDCOMM DEBUG] Searching for walletDID: ${walletDID}`);
      console.log(`🔍 [DIDCOMM DEBUG] Valid states: ${validStates.join(', ')}`);
      console.log(`🔍 [DIDCOMM DEBUG] Matching connection found:`, matchingConnection ? {
        connectionId: matchingConnection.connectionId,
        state: matchingConnection.state,
        theirDid: matchingConnection.theirDid.substring(0, 60) + '...'
      } : 'None');

      if (matchingConnection) {
        connectionId = matchingConnection.connectionId;
        console.log(`🔗 [DIDCOMM DEBUG] Found matching connection: ${connectionId} in state: ${matchingConnection.state}`);

        // Look for user info in existing sessions or mappings
        if (global.userConnectionMappings) {
          for (const [userId, mapping] of global.userConnectionMappings.entries()) {
            console.log(`🔍 [DIDCOMM DEBUG] Checking user mapping: ${userId} -> ${mapping.connectionId}`);
            if (mapping.connectionId === connectionId) {
              userUniqueId = userId;
              console.log(`👤 [DIDCOMM DEBUG] Found user mapping: ${userUniqueId}`);
              break;
            }
          }
        }
      } else {
        console.log(`❌ [DIDCOMM DEBUG] No connection found for wallet DID: ${walletDID}`);
        console.log(`❌ [DIDCOMM DEBUG] Checked ${connections.length} connections with valid states: ${validStates.join(', ')}`);
      }
    }

    console.log(`🎯 [DIDCOMM DEBUG] Final selection:`);
    console.log(`   🔗 Connection ID: ${connectionId}`);
    console.log(`   👤 User Unique ID: ${userUniqueId}`);
    console.log(`   💼 Wallet DID: ${walletDID.substring(0, 60)}...`);

    if (!connectionId) {
      return res.status(404).json({
        success: false,
        error: 'No established DIDComm connection found for your wallet. Please establish a connection first.'
      });
    }

    // Validate connection state before proceeding
    console.log(`🔍 [DIDCOMM DEBUG] Validating connection state for: ${connectionId}`);
    const connValidationResponse = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}`, {
      method: 'GET',
      headers: {
        'apikey': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (connValidationResponse.ok) {
      const connData = await connValidationResponse.json();
      console.log(`🔍 [DIDCOMM DEBUG] Connection ${connectionId} state: ${connData.state}`);

      if (connData.state === 'InvitationGenerated') {
        console.log(`❌ [DIDCOMM DEBUG] Connection ${connectionId} is in InvitationGenerated state - invalid for credential issuance`);
        throw new Error(`Connection ${connectionId} is in invalid state for credential issuance: ${connData.state}. Please ensure DIDComm connection is properly established.`);
      }

      if (!['ConnectionResponseReceived', 'ConnectionResponseSent', 'Connected'].includes(connData.state)) {
        console.log(`❌ [DIDCOMM DEBUG] Connection ${connectionId} is in unsupported state: ${connData.state}`);
        throw new Error(`Connection ${connectionId} is in unsupported state for credential issuance: ${connData.state}. Supported states: ConnectionResponseReceived, ConnectionResponseSent, Connected`);
      }

      console.log(`✅ [DIDCOMM DEBUG] Connection ${connectionId} validated successfully in state: ${connData.state}`);
    } else {
      console.log(`❌ [DIDCOMM DEBUG] Failed to validate connection ${connectionId}: ${connValidationResponse.status}`);
      throw new Error(`Failed to validate connection ${connectionId}`);
    }

    // Create Security Clearance credential offer directly via Cloud Agent
    console.log(`📋 Creating Security Clearance credential offer for connection: ${connectionId}`);

    // Fetch schemas from Cloud Agent
    const schemasResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: {
        'apikey': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!schemasResponse.ok) {
      throw new Error('Failed to fetch schemas from Cloud Agent');
    }

    const schemasData = await schemasResponse.json();
    const schemas = schemasData.contents || schemasData;

    // Get issuing DID
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      headers: {
        'apikey': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs');
    }

    const didData = await didResponse.json();
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const issuingDID = publishedDIDs.length > 0 ? publishedDIDs[publishedDIDs.length - 1].did : null;

    if (!issuingDID) {
      throw new Error('No published DID found for Certification Authority');
    }

    // ✅ Select dual-key schema (v4.0.0 or v3.0.0 ONLY)
    // v2.0.0 legacy schema is NO LONGER SUPPORTED
    let selectedSchema = null;
    let schemaVersion = null;

    // Try v5.0.0 first (SECRET replaces TOP-SECRET), then v4.0.0, then v3.0.0
    for (const ver of ['5.0.0', '4.0.0', '3.0.0']) {
      selectedSchema = schemas.find(s => s.name === 'SecurityClearanceLevel' && s.version === ver);
      if (selectedSchema) { schemaVersion = ver; break; }
    }

    // No v2.0.0 fallback - throw error if dual-key schema not found
    if (!selectedSchema) {
      throw new Error('SecurityClearanceLevel dual-key schema (v5.0.0/v4.0.0/v3.0.0) not found. Legacy format (v2.0.0) is no longer supported.');
    }

    console.log(`📋 Using schema: SecurityClearanceLevel v${schemaVersion}`);

    // Generate unique clearance ID
    const clearanceId = `SC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const issuedDate = new Date();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // 1 year validity

    // Prepare credential claims based on schema version and format
    let credentialClaims = {};

    if (isDualKeyFormat && schemaVersion === '3.0.0') {
      // Dual-key format with v3.0.0 schema (nested cryptographicKeys object)
      console.log('📝 Building DUAL-KEY credential claims (v3.0.0)');

      credentialClaims = {
        clearanceLevel: clearanceLevel.toLowerCase(),
        holderName: userInfo?.name || 'DIDComm Wallet User',
        holderUniqueId: userUniqueId || 'UNKNOWN',
        cryptographicKeys: {
          ed25519PublicKey: validatedEd25519Key,
          ed25519Fingerprint: ed25519Fingerprint,
          x25519PublicKey: validatedX25519Key,
          x25519Fingerprint: x25519Fingerprint,
          keyDerivationRelationship: 'derived-from-same-seed'
        },
        issuedDate: issuedDate.toISOString().split('T')[0],
        expiryDate: expiryDate.toISOString().split('T')[0],
        clearanceId: clearanceId,
        issuingAuthority: 'Certification Authority',
        requiresMultiFactorAuth: clearanceLevel === 'secret' || clearanceLevel === 'restricted',
        allowsDigitalSigning: true,
        allowsEncryption: true
      };

    } else {
      // Legacy format with v2.0.0 schema (flat structure)
      console.log('📝 Building LEGACY credential claims (v2.0.0)');

      credentialClaims = {
        clearanceLevel: clearanceLevel.toLowerCase(),
        clearanceId: clearanceId,
        issuedAt: issuedDate.toISOString(),
        validUntil: expiryDate.toISOString(),
        publicKey: validatedEd25519Key,
        keyAlgorithm: 'Ed25519',
        keyFingerprint: ed25519Fingerprint,
        // Include user info if available
        ...(userUniqueId && { holderUniqueId: userUniqueId }),
        ...(userInfo && {
          holderName: userInfo.name || 'DIDComm Wallet User',
          requestedAt: issuedDate.toISOString()
        })
      };
    }

    // Create credential offer via Cloud Agent
    const credentialOffer = {
      connectionId: connectionId,
      credentialFormat: 'JWT',
      claims: credentialClaims,
      automaticIssuance: false,  // Allow manual review
      issuingDID: issuingDID,
      schemaId: `${CLOUD_AGENT_URL}${selectedSchema.self}`
    };

    console.log('📋 Sending clearance credential offer via DIDComm:', JSON.stringify(credentialOffer, null, 2));

    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Cloud Agent credential offer failed:', response.status, errorText);
      throw new Error(`Cloud Agent error: ${response.status} - ${errorText}`);
    }

    const offerData = await response.json();
    console.log('✅ Security clearance credential offer created:', offerData.recordId);

    // Store cryptographic keys securely (server-side)
    if (!global.securityPublicKeys) {
      global.securityPublicKeys = new Map();
    }

    if (isDualKeyFormat) {
      // Store dual keys
      global.securityPublicKeys.set(clearanceId, {
        format: 'dual-key',
        schemaVersion: schemaVersion,
        ed25519: {
          publicKey: validatedEd25519Key,
          fingerprint: ed25519Fingerprint
        },
        x25519: {
          publicKey: validatedX25519Key,
          fingerprint: x25519Fingerprint
        },
        walletDID: walletDID,
        connectionId: connectionId,
        issuedAt: issuedDate.toISOString()
      });

      console.log(`🔐 Dual-key pair stored securely for clearance: ${clearanceId}`);
      console.log(`   Ed25519: ${ed25519Fingerprint}`);
      console.log(`   X25519: ${x25519Fingerprint}`);

    } else {
      // Store legacy single key
      global.securityPublicKeys.set(clearanceId, {
        format: 'legacy',
        schemaVersion: schemaVersion,
        publicKey: validatedEd25519Key,
        fingerprint: ed25519Fingerprint,
        algorithm: 'Ed25519',
        walletDID: walletDID,
        connectionId: connectionId,
        issuedAt: issuedDate.toISOString()
      });

      console.log(`🔐 Ed25519 public key stored securely for clearance: ${clearanceId} (legacy format)`);
    }

    // Build response object
    const responseObj = {
      success: true,
      message: `${clearanceLevel.toUpperCase()} Security Clearance offer sent to your wallet`,
      recordId: offerData.recordId,
      thid: offerData.thid,
      clearanceId: clearanceId,
      clearanceLevel: clearanceLevel,
      connectionId: connectionId,
      schemaVersion: schemaVersion,
      format: isDualKeyFormat ? 'dual-key' : 'legacy',
      validUntil: expiryDate.toISOString(),
      instructions: 'Check your wallet Messages section for the credential offer and click Accept to complete the process.'
    };

    // Add key information based on format
    if (isDualKeyFormat) {
      responseObj.keys = {
        ed25519: {
          fingerprint: ed25519Fingerprint,
          algorithm: 'Ed25519'
        },
        x25519: {
          fingerprint: x25519Fingerprint,
          algorithm: 'X25519'
        }
      };
    } else {
      responseObj.keyFingerprint = ed25519Fingerprint;
      responseObj.keyAlgorithm = 'Ed25519';
    }

    res.json(responseObj);

  } catch (error) {
    console.error('❌ DIDComm Security Clearance request error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error during DIDComm security clearance request'
    });
  }
});

// ===========================================================================
// ENTERPRISE API: Security Clearance Verification for Employee Portal
// Called by Company Admin Portal to verify employee Security Clearance VCs
// ===========================================================================

// Store enterprise clearance proof requests (separate from CA internal use)
if (!global.enterpriseClearanceRequests) {
  global.enterpriseClearanceRequests = new Map();
}

/**
 * POST /api/enterprise/request-clearance
 * Enterprise API for Company Admin Portal to request Security Clearance verification
 * via DIDComm to employee's personal wallet
 *
 * Request body:
 *   - employeeEmail: Employee email to find connection
 *   - employeeId: Alternative identifier
 *   - enterpriseCallbackUrl: (optional) URL to call when verification complete
 */
app.post('/api/enterprise/request-clearance', async (req, res) => {
  try {
    const { employeeEmail, employeeId, enterpriseCallbackUrl } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🏢 [ENTERPRISE-CLEARANCE] Request from Company Admin Portal`);
    console.log(`   Employee Email: ${employeeEmail}`);
    console.log(`   Employee ID: ${employeeId}`);
    console.log(`${'='.repeat(80)}`);

    if (!employeeEmail && !employeeId) {
      return res.status(400).json({
        success: false,
        error: 'MissingParameters',
        message: 'Either employeeEmail or employeeId is required'
      });
    }

    // Find connection by searching through CA's connections
    // Look for connections with label containing employee identifier
    const identifier = employeeEmail || employeeId;
    let connectionId = null;

    try {
      const connectionsResponse = await fetch(
        `${CLOUD_AGENT_URL}/connections`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'apikey': API_KEY
          }
        }
      );

      if (connectionsResponse.ok) {
        const connectionsData = await connectionsResponse.json();
        const connections = connectionsData.contents || [];

        // Search for connection with matching label
        for (const conn of connections) {
          const label = (conn.label || '').toLowerCase();
          const theirLabel = (conn.theirLabel || '').toLowerCase();
          const searchTerm = identifier.toLowerCase();

          // Check if connection label contains employee identifier
          // Look for patterns like "CA Connection: Bob Johnson" or "bob.johnson@techcorp.test"
          if (label.includes(searchTerm) ||
              theirLabel.includes(searchTerm) ||
              // Also check by name parts (e.g., "bob" or "johnson")
              (searchTerm.includes('@') && (
                label.includes(searchTerm.split('@')[0]) ||
                theirLabel.includes(searchTerm.split('@')[0])
              ))) {
            connectionId = conn.connectionId;
            console.log(`🔗 [ENTERPRISE-CLEARANCE] Found connection: ${connectionId}`);
            console.log(`   Label: ${conn.label}`);
            break;
          }
        }
      }
    } catch (connError) {
      console.error(`❌ [ENTERPRISE-CLEARANCE] Error fetching connections:`, connError.message);
    }

    if (!connectionId) {
      console.log(`❌ [ENTERPRISE-CLEARANCE] No connection found for: ${identifier}`);
      return res.status(404).json({
        success: false,
        error: 'ConnectionNotFound',
        message: `No DIDComm connection found for employee: ${identifier}. Employee must first connect to CA via Alice Wallet.`
      });
    }

    // Generate unique proof request ID
    const proofRequestId = `enterprise-clearance-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const challenge = require('crypto').randomBytes(32).toString('hex');

    // Create presentation request for Security Clearance VC
    const clearancePresentationRequest = {
      connectionId: connectionId,
      proofs: [
        {
          // SecurityClearanceLevel v5.0.0 — the current preferred issuance version (see the
          // ['5.0.0','4.0.0','3.0.0'] preference order used when issuing). A stale version
          // GUID here causes the Cloud Agent's post-hoc schema check to reject a real,
          // correctly-typed credential as PresentationVerificationFailed (verified live).
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/78f56570-1405-3847-9e5c-87f582722711',
          trustIssuers: await getTrustedIssuerDIDs() // constrain to DIDs this CA actually controls
        }
      ],
      options: {
        challenge: challenge,
        // Wallet-side schema hint — see the domain comment on the DIDComm identity-auth
        // proof request above (Cloud Agent doesn't forward goalCode/claims to the wallet).
        domain: 'clearance.identuslabel.cz'
      },
      credentialFormat: 'JWT',
      goalCode: 'schema:SecurityClearance',
      goal: 'TechCorp Employee Portal requests your Security Clearance credential to verify authorization level',
      claims: {
        clearanceLevel: {},
        issuedDate: {},
        expiryDate: {}
      }
    };

    console.log(`📤 [ENTERPRISE-CLEARANCE] Sending proof request to wallet...`);

    // Send presentation request via Cloud Agent
    const presentationResponse = await fetch(
      `${CLOUD_AGENT_URL}/present-proof/presentations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY
        },
        body: JSON.stringify(clearancePresentationRequest)
      }
    );

    if (!presentationResponse.ok) {
      const errorText = await presentationResponse.text();
      console.error(`❌ [ENTERPRISE-CLEARANCE] Cloud Agent error:`, errorText);
      return res.status(500).json({
        success: false,
        error: 'CloudAgentError',
        message: 'Failed to send clearance proof request to personal wallet'
      });
    }

    const presentationData = await presentationResponse.json();
    const presentationId = presentationData.presentationId || presentationData.id;

    console.log(`✅ [ENTERPRISE-CLEARANCE] Proof request sent!`);
    console.log(`   Proof Request ID: ${proofRequestId}`);
    console.log(`   Presentation ID: ${presentationId}`);
    console.log(`   Connection: ${connectionId}`);

    // Store request for status polling
    global.enterpriseClearanceRequests.set(proofRequestId, {
      proofRequestId,
      presentationId,
      connectionId,
      employeeEmail,
      employeeId,
      challenge,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      enterpriseCallbackUrl,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    console.log(`${'='.repeat(80)}\n`);

    res.json({
      success: true,
      proofRequestId,
      presentationId,
      status: 'pending',
      message: 'Security Clearance proof request sent to employee wallet. Poll /api/enterprise/clearance-status/:proofRequestId for updates.',
      expiresIn: 300 // 5 minutes
    });

  } catch (error) {
    console.error(`❌ [ENTERPRISE-CLEARANCE] Error:`, error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to initiate clearance verification'
    });
  }
});

/**
 * GET /api/enterprise/clearance-status/:proofRequestId
 * Poll for Security Clearance verification status
 */
app.get('/api/enterprise/clearance-status/:proofRequestId', async (req, res) => {
  try {
    const { proofRequestId } = req.params;

    const request = global.enterpriseClearanceRequests.get(proofRequestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'NotFound',
        message: 'Proof request not found or expired'
      });
    }

    // Check if expired
    if (request.expiresAt < Date.now()) {
      global.enterpriseClearanceRequests.delete(proofRequestId);
      return res.status(410).json({
        success: false,
        error: 'Expired',
        message: 'Proof request has expired. Please initiate a new verification.'
      });
    }

    // Check Cloud Agent for presentation status
    const presentationResponse = await fetch(
      `${CLOUD_AGENT_URL}/present-proof/presentations/${request.presentationId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': API_KEY
        }
      }
    );

    if (!presentationResponse.ok) {
      return res.json({
        success: true,
        proofRequestId,
        status: 'pending',
        message: 'Waiting for employee to respond in their wallet'
      });
    }

    const presentationData = await presentationResponse.json();
    const status = presentationData.status;

    console.log(`🔍 [ENTERPRISE-CLEARANCE-STATUS] ${proofRequestId}: ${status}`);

    // If verified, extract clearance data
    if (status === 'PresentationVerified' || status === 'Verified') {
      let clearanceLevel = null;

      // Extract clearance level from verified presentation
      if (presentationData.data && presentationData.data.length > 0) {
        const vpData = presentationData.data[0];
        // Try to extract from JWT presentation
        if (typeof vpData === 'string' && vpData.includes('.')) {
          try {
            const parts = vpData.split('.');
            if (parts.length >= 2) {
              const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
              const padding = '='.repeat((4 - (payloadBase64.length % 4)) % 4);
              const payloadJson = Buffer.from(payloadBase64 + padding, 'base64').toString('utf-8');
              const payload = JSON.parse(payloadJson);

              // Look for clearanceLevel in vp.verifiableCredential
              if (payload.vp && payload.vp.verifiableCredential) {
                for (const vc of payload.vp.verifiableCredential) {
                  if (typeof vc === 'string' && vc.includes('.')) {
                    const vcParts = vc.split('.');
                    const vcPayloadBase64 = vcParts[1].replace(/-/g, '+').replace(/_/g, '/');
                    const vcPadding = '='.repeat((4 - (vcPayloadBase64.length % 4)) % 4);
                    const vcPayloadJson = Buffer.from(vcPayloadBase64 + vcPadding, 'base64').toString('utf-8');
                    const vcPayload = JSON.parse(vcPayloadJson);
                    if (vcPayload.vc && vcPayload.vc.credentialSubject) {
                      clearanceLevel = vcPayload.vc.credentialSubject.clearanceLevel;
                      if (clearanceLevel) break;
                    }
                  }
                }
              }
            }
          } catch (parseError) {
            console.error(`⚠️ [ENTERPRISE-CLEARANCE-STATUS] JWT parse error:`, parseError.message);
          }
        }
      }

      // Update stored request
      request.status = 'verified';
      request.clearanceLevel = clearanceLevel;
      request.verifiedAt = new Date().toISOString();

      console.log(`✅ [ENTERPRISE-CLEARANCE-STATUS] Verified! Clearance: ${clearanceLevel || 'UNKNOWN'}`);

      // Clean up after verification
      setTimeout(() => {
        global.enterpriseClearanceRequests.delete(proofRequestId);
      }, 60000); // Keep for 1 minute after verification

      return res.json({
        success: true,
        proofRequestId,
        status: 'verified',
        clearanceLevel: clearanceLevel,
        verifiedAt: request.verifiedAt,
        message: 'Security Clearance verified successfully'
      });
    }

    // Handle declined/rejected
    if (status === 'ProblemReportReceived' || status === 'Rejected' || status === 'Declined') {
      global.enterpriseClearanceRequests.delete(proofRequestId);
      return res.json({
        success: true,
        proofRequestId,
        status: 'declined',
        message: 'Employee declined the Security Clearance verification request'
      });
    }

    // Still pending
    res.json({
      success: true,
      proofRequestId,
      status: 'pending',
      cloudAgentStatus: status,
      message: 'Waiting for employee to respond in their wallet'
    });

  } catch (error) {
    console.error(`❌ [ENTERPRISE-CLEARANCE-STATUS] Error:`, error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

// ===========================================================================
// END: ENTERPRISE API
// ===========================================================================

// Serve security clearance request page
app.get('/security-clearance', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'security-clearance.html'));
});

// Serve RealPerson issuance page
app.get('/realperson', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'realperson.html'));
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const response = await fetch(`${CLOUD_AGENT_URL}/_system/health`, {
      method: 'GET',
      headers: {
      }
    });
    
    const cloudAgentHealth = await response.json();
    
    res.json({
      organization: ORG_NAME,
      status: 'healthy',
      cloudAgent: cloudAgentHealth,
      walletId: WALLET_ID,
      entityId: ENTITY_ID,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      organization: ORG_NAME,
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Issue company credential to organization
app.post('/api/credentials/company/issue', async (req, res) => {
  try {
    const { connectionId, companyData } = req.body;
    
    if (!connectionId || !companyData) {
      return res.status(400).json({
        success: false,
        error: 'Connection ID and company data are required'
      });
    }
    
    console.log(`🏢 Issuing company credential to connection: ${connectionId}`);
    console.log(`📋 Company data:`, companyData);
    
    // Get the authority's DID for credential issuance
    const didResponse = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    if (!didResponse.ok) {
      throw new Error('Failed to fetch authority DIDs for credential issuance');
    }
    
    const didData = await didResponse.json();
    const publishedDIDs = filterIssuingDIDs(didData.contents);
    const issuingDID = publishedDIDs.length > 0 ? publishedDIDs[publishedDIDs.length - 1].did : null;

    if (!issuingDID) {
      throw new Error('No DID found for Certification Authority. Please create and publish a DID first.');
    }
    
    // Create company credential claims
    const credentialClaims = {
      companyName: companyData.name,
      legalName: companyData.legalName || companyData.name,
      domain: companyData.domain,
      email: companyData.email,
      address: companyData.address,
      country: companyData.country,
      registrationNumber: companyData.registrationNumber,
      vatNumber: companyData.vatNumber,
      incorporationDate: companyData.incorporationDate,
      businessType: companyData.businessType,
      industry: companyData.industry,
      authorizedBy: ORG_NAME,
      issuingAuthority: ORG_NAME,
      authorityDID: issuingDID,
      credentialType: 'CompanyCredential',
      issuedDate: new Date().toISOString(),
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year from now
      status: 'Active'
    };
    
    console.log(`📝 Creating company credential offer with claims:`, credentialClaims);
    
    const credentialOffer = {
      connectionId: connectionId,
      credentialFormat: 'JWT',
      claims: credentialClaims,
      automaticIssuance: true,
      issuingDID: issuingDID
    };
    
    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
      },
      body: JSON.stringify(credentialOffer)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud Agent responded with ${response.status}: ${errorText}`);
    }
    
    const offerData = await response.json();
    console.log(`✅ Company credential offered: ${offerData.recordId}`);
    
    res.json({
      success: true,
      recordId: offerData.recordId,
      thid: offerData.thid,
      claims: credentialClaims,
      message: `Company credential offered to ${companyData.name}`
    });
    
  } catch (error) {
    console.error('❌ Error issuing company credential:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Cloud Agent proxy endpoint for fetching connections
app.get('/api/cloud-agent/cloud-agent/connections', async (req, res) => {
  try {
    console.log('📡 Fetching CA connections from Cloud Agent...');
    
    const response = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Cloud Agent responded with ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ Found ${data.contents?.length || 0} connections`);
    
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, apikey');
    
    res.json(data);

  } catch (error) {
    console.error('❌ Error fetching connections:', error);
    res.status(500).json({
      error: 'Failed to fetch connections',
      details: error.message
    });
  }
});

// ── Cloud Agent Webhook Probe ─────────────────────────────────────────────────

// Capture all webhook payloads from the Cloud Agent for inspection
// Registered at: POST /events/webhooks → url: https://identuslabel.cz/ca/api/webhook-probe
let webhookProbeLog = []; // in-memory ring buffer (last 50)

app.post('/api/webhook-probe', express.json(), async (req, res) => {
  const entry = {
    receivedAt: new Date().toISOString(),
    headers: req.headers,
    body: req.body
  };
  webhookProbeLog.push(entry);
  if (webhookProbeLog.length > 50) webhookProbeLog.shift();

  const type = req.body?.type || req.body?.piuri || '(unknown)';
  console.log(`🔔 [WebhookProbe] Received event — type: ${type}`);

  // Handle BasicMessageReceived events from the custom Cloud Agent build
  if (type === 'BasicMessageReceived' && req.body?.data) {
    const { id, content, from: senderId, sentTime } = req.body.data;

    // Wallet wraps all messages in StandardMessageBody: {"content":"...","timestamp":...,"encrypted":false}
    // Unwrap to get the actual message text or protocol JSON
    let actualContent = content || '';
    try {
      const stdBody = JSON.parse(actualContent);
      if (stdBody && typeof stdBody.content === 'string') {
        actualContent = stdBody.content;
      }
    } catch (_) { /* not JSON, use as-is */ }

    // Look up connectionId by theirDid == senderId
    let connectionId = 'unknown';
    try {
      const connResp = await fetch(`${CLOUD_AGENT_URL}/connections?limit=100`, {
        headers: { 'apikey': API_KEY }
      });
      if (connResp.ok) {
        const connData = await connResp.json();
        const match = (connData.contents || []).find(c => c.theirDid === senderId);
        if (match) connectionId = match.connectionId;
      }
    } catch (_) { /* non-fatal */ }

    const msgData = {
      id: id || `webhook-${Date.now()}`,
      timestamp: sentTime ? new Date(sentTime * 1000).toISOString() : new Date().toISOString(),
      direction: 'received',
      content: actualContent,
      sender: senderId || '',
      connectionId
    };

    if (!chatMessageStore[connectionId]) chatMessageStore[connectionId] = [];
    // Deduplicate by id
    if (!chatMessageStore[connectionId].find(m => m.id === msgData.id)) {
      chatMessageStore[connectionId].push(msgData);
      saveChatMessages(chatMessageStore);
      console.log(`📥 [Webhook] BasicMessage from ${senderId?.slice(0, 40)}... stored under connection ${connectionId}`);
    }

    // Dispatch to command service (non-blocking; errors are caught internally)
    didCommCmdService.handleIncomingMessage(senderId, actualContent).catch(e =>
      console.error('[DIDCommCmd] handleIncomingMessage error:', e.message)
    );
  }

  res.status(200).json({ received: true });
});

app.get('/api/webhook-probe', (req, res) => {
  res.json({ count: webhookProbeLog.length, entries: webhookProbeLog.slice(-20) });
});

// ── DIDComm Messaging endpoints ───────────────────────────────────────────────
// Wallet→CA: Cloud Agent receives BasicMessage, fires webhook → POST /api/webhook-probe
// CA→Wallet: POST /api/send-didcomm-message → Cloud Agent POST /connections/{id}/basic-messages

// Get DIDComm chat messages for a specific connection (scoped by connectionId)
app.get('/api/didcomm-messages', (req, res) => {
  try {
    const { connectionId } = req.query;
    if (!connectionId) {
      return res.status(400).json({ error: 'connectionId query parameter is required' });
    }
    const messages = (chatMessageStore[connectionId] || [])
      .slice()
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ success: true, messages, count: messages.length, connectionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send DIDComm BasicMessage from CA to wallet via mediator
app.post('/api/send-didcomm-message', async (req, res) => {
  try {
    const { connectionId, content } = req.body;
    if (!connectionId || !content) {
      return res.status(400).json({ error: 'connectionId and content are required' });
    }

    // Delegate to Cloud Agent's built-in DIDComm stack via new sendBasicMessage endpoint
    const agentResp = await fetch(`${CLOUD_AGENT_URL}/connections/${connectionId}/basic-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify({ content })
    });
    if (!agentResp.ok) {
      const errText = await agentResp.text().catch(() => '');
      return res.status(agentResp.status).json({ error: `Cloud Agent sendBasicMessage failed: ${errText.slice(0, 200)}` });
    }
    const agentResult = await agentResp.json();
    const messageId = agentResult.id || `ca-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    console.log(`📤 [DIDComm] Sent BasicMessage via Cloud Agent to connection ${connectionId}, msgId=${messageId}`);

    const msgData = {
      id: messageId,
      timestamp: new Date().toISOString(),
      direction: 'sent',
      content,
      sender: 'Certification Authority',
      connectionId
    };
    if (!chatMessageStore[connectionId]) chatMessageStore[connectionId] = [];
    chatMessageStore[connectionId].push(msgData);
    saveChatMessages(chatMessageStore);

    console.log(`✅ [DIDComm] Message ${messageId} delivered`);
    res.json({ success: true, messageId, status: 'sent' });
  } catch (error) {
    console.error('[DIDComm] Error sending message:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// API endpoint to get pending credential requests (waiting for admin approval)
app.get('/api/credentials/pending', async (req, res) => {
  try {
    // Fetch all pages to avoid missing records beyond the default limit
    let allRecords = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records?limit=${pageSize}&offset=${offset}`, {
        headers: {
        }
      });
      if (!response.ok) {
        throw new Error(`Cloud Agent error: ${response.status}`);
      }
      const data = await response.json();
      const page = data.contents || [];
      allRecords = allRecords.concat(page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    const data = { contents: allRecords };

    // Filter for credentials that are waiting for admin approval (only RequestReceived state)
    // and exclude any that have been rejected by admin
    const pendingRequests = data.contents?.filter(record => {
      const isPendingApproval = record.protocolState === 'RequestReceived';
      const isNotRejected = !global.rejectedCredentials?.has(record.recordId);
      return isPendingApproval && isNotRejected;
    }) || [];
    
    // Enhance with holder information if available
    const enhancedRequests = pendingRequests.map(record => {
      // Try to find holder info from our mappings
      let holderInfo = null;
      for (const [uniqueId, mapping] of global.userConnectionMappings.entries()) {
        if (mapping.connectionId === record.connectionId) {
          holderInfo = mapping.holderInfo;
          break;
        }
      }
      
      return {
        ...record,
        holderInfo: holderInfo
      };
    });
    
    res.json({
      success: true,
      pendingRequests: enhancedRequests,
      count: enhancedRequests.length
    });
    
  } catch (error) {
    console.error('Error fetching pending credentials:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending credential requests',
      details: error.message
    });
  }
});

// API endpoint for configuration (used by Edge SDK demo)
app.get('/api/config', (req, res) => {
  res.json({
    mediatorUrl: 'ws://localhost:7080/ws',
    mediatorDid: 'did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y',
    cloudAgentUrl: CLOUD_AGENT_URL,
    apiKey: API_KEY.substring(0, 10) + '...',
    walletId: WALLET_ID,
    entityId: ENTITY_ID
  });
});

// API endpoint for statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Get schemas count
    const schemasResponse = await fetch(`${CLOUD_AGENT_URL}/schema-registry/schemas`, {
      headers: { 'apikey': API_KEY }
    });
    const schemasData = schemasResponse.ok ? await schemasResponse.json() : { contents: [] };
    
    // Get connections count  
    const connectionsResponse = await fetch(`${CLOUD_AGENT_URL}/connections`, {
      headers: { 'apikey': API_KEY }
    });
    const connectionsData = connectionsResponse.ok ? await connectionsResponse.json() : { contents: [] };
    
    res.json({
      totalSchemas: schemasData.contents?.length || 0,
      activeSessions: global.verificationSessions?.size || 0,
      securityKeypairs: global.securityKeypairs?.size || 0,
      activeConnections: connectionsData.contents?.length || 0
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.json({
      totalSchemas: 0,
      activeSessions: 0,
      securityKeypairs: 0,
      activeConnections: 0
    });
  }
});

// API endpoint to revoke a credential
app.post('/api/credentials/revoke/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;

    console.log(`🚫 [REVOCATION] Attempting to revoke credential: ${recordId}`);

    // Call Cloud Agent to revoke the credential
    const response = await fetch(`${CLOUD_AGENT_URL}/credential-status/revoke-credential/${recordId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [REVOCATION] Cloud Agent error: ${response.status} - ${errorText}`);
      throw new Error(`Cloud Agent error: ${response.status} - ${errorText}`);
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : { success: true, revoked: true };

    console.log(`✅ [REVOCATION] Successfully revoked credential: ${recordId}`);
    console.log(`📋 [REVOCATION] Credential state: ${data.protocolState}`);

    res.json({
      success: true,
      message: 'Credential revoked successfully',
      recordId: recordId,
      data: data
    });

  } catch (error) {
    console.error(`❌ [REVOCATION] Error revoking credential ${req.params.recordId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke credential',
      details: error.message
    });
  }
});

// Update RealPerson VC: photo-only update via in-place DID document mutation (no re-issuance)
app.post('/api/credentials/update-realperson', async (req, res) => {
  try {
    const { uniqueId, newPhoto } = req.body;
    if (!uniqueId) return res.status(400).json({ success: false, error: 'uniqueId is required' });
    if (!newPhoto) return res.status(400).json({ success: false, error: 'newPhoto is required' });

    const mapping = global.userConnectionMappings.get(uniqueId);
    if (!mapping) return res.status(404).json({ success: false, error: `No user mapping found for uniqueId: ${uniqueId}` });

    const existingPhotoDID = photoDIDs[uniqueId];
    if (!existingPhotoDID) return res.status(400).json({ success: false, error: 'No photo DID exists for this user — photo was not included in the original credential' });

    console.log(`📸 [UPDATE] Updating photo for ${uniqueId} (in-place DID mutation)`);
    const base64 = newPhoto.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const iagonFileId = await uploadPhotoToIagon(buffer, `photo-${uniqueId}-${Date.now()}.jpg`);
    const proxyUrl = `${PUBLIC_BASE_URL}/photo-proxy/${iagonFileId}`;

    const patchResp = await fetch(`${CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(existingPhotoDID.photoDID)}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify({
        actions: [{
          actionType: 'UPDATE_SERVICE',
          updateService: { id: 'photo', type: 'LinkedPhoto', serviceEndpoint: proxyUrl }
        }]
      })
    });
    if (!patchResp.ok) throw new Error(`DID update failed: ${await patchResp.text()}`);

    existingPhotoDID.iagonFileId = iagonFileId;
    existingPhotoDID.proxyUrl = proxyUrl;
    existingPhotoDID.updatedAt = new Date().toISOString();
    savePhotoDIDs();
    console.log(`✅ [UPDATE] Photo updated for ${uniqueId}: ${iagonFileId}`);

    res.json({ success: true, action: 'photo-updated', message: 'Photo updated in place — no re-issuance needed' });

  } catch (error) {
    console.error('❌ [UPDATE] Error updating RealPerson photo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get detailed information about a credential record
app.get('/api/credentials/details/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    
    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records/${recordId}`, {
      headers: {
      }
    });
    
    if (!response.ok) {
      throw new Error(`Cloud Agent error: ${response.status}`);
    }
    
    const data = await response.json();
    
    res.json({
      success: true,
      credential: data
    });
    
  } catch (error) {
    console.error('Error fetching credential details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credential details',
      details: error.message
    });
  }
});

// API endpoint to approve/issue a pending credential
app.post('/api/credentials/approve/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    const { approve = true, notes = '' } = req.body;
    
    if (!approve) {
      // Log the rejection locally (Cloud Agent v2.0.0 doesn't have cancel endpoint)
      console.log(`❌ Admin rejected credential ${recordId}: ${notes || 'No reason provided'}`);
      
      // Store rejection in local tracking
      if (!global.rejectedCredentials) {
        global.rejectedCredentials = new Map();
      }
      global.rejectedCredentials.set(recordId, {
        rejectedAt: new Date().toISOString(),
        reason: notes || 'Rejected by administrator',
        recordId: recordId
      });
      
      return res.json({
        success: true,
        message: 'Credential request rejected successfully',
        recordId: recordId,
        reason: notes || 'Rejected by administrator',
        note: 'Credential marked as rejected locally. It will not appear in pending requests.'
      });
    }
    
    // Issue the credential by completing the flow
    const response = await fetch(`${CLOUD_AGENT_URL}/issue-credentials/records/${recordId}/issue-credential`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({})
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Cloud Agent error: ${response.status} - ${errorData}`);
    }
    
    const data = await response.json();
    
    res.json({
      success: true,
      message: 'Credential approved and issued successfully',
      recordId: recordId,
      data: data
    });
    
  } catch (error) {
    console.error('Error approving credential:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to approve credential',
      details: error.message
    });
  }
});

// Proxy endpoint for fetching StatusList credentials from Cloud Agent
// This avoids mixed content issues when CA portal is accessed via HTTPS
app.get('/api/proxy-statuslist', async (req, res) => {
  try {
    const { path: statusListPath } = req.query;

    if (!statusListPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing path parameter'
      });
    }

    console.log(`📋 [PROXY] Fetching StatusList from Cloud Agent: ${statusListPath}`);

    // The statusListPath is a full pathname like /cloud-agent/credential-status/...
    // CLOUD_AGENT_URL already ends with /cloud-agent, so strip that prefix to avoid doubling.
    const agentPrefix = new URL(CLOUD_AGENT_URL).pathname; // e.g. /cloud-agent
    const relativePath = statusListPath.startsWith(agentPrefix)
      ? statusListPath.slice(agentPrefix.length)
      : statusListPath;
    const cloudAgentUrl = `${CLOUD_AGENT_URL}${relativePath}`;
    console.log(`📋 [PROXY] Resolved URL: ${cloudAgentUrl}`);
    const response = await fetch(cloudAgentUrl, {
      headers: { 'apikey': API_KEY }
    });

    if (!response.ok) {
      throw new Error(`Cloud Agent returned ${response.status}`);
    }

    const statusListCredential = await response.json();
    console.log(`✅ [PROXY] StatusList fetched successfully`);

    res.json(statusListCredential);
  } catch (error) {
    console.error('❌ [PROXY] Error fetching StatusList:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch StatusList',
      details: error.message
    });
  }
});

// ── Service Access (service-access/1.0) ───────────────────────────────────────
//
// Migrated from the standalone lib/DIDCommCommandService.js onto the shared
// service-access-didcomm package (see packages/service-access-didcomm/PROTOCOL.md and
// ../company-admin-portal/server.js, which uses the same library for its own targets).
//
// SECURITY IMPROVEMENT vs. the prior implementation: the old DIDCommCommandService trusted
// Cloud Agent's `PresentationVerified` status alone — it never independently verified the
// VC-JWT signature or checked the issuer DID against a trust list post-hoc (the `trustIssuers`
// array only constrains the *request* sent to the Cloud Agent, which — per this file's own
// documented finding — doesn't reliably survive to the actual wire message). The shared library
// now does real ES256K signature verification (resolving the issuer's DID) plus an explicit,
// fail-closed trust-registry check on every grant, for defense in depth.

// CA is both issuer and verifier for its own credentials, so trust registry entries are this
// CA's own currently-registered issuing DIDs (refreshed periodically — DIDs can rotate), each
// trusted for both VC types it issues. Reproduces the same "self-trust" model as
// getTrustedIssuerDIDs() previously provided to the proof *request* only.
let caTrustRegistry = createTrustRegistry([]);
async function refreshCaTrustRegistry() {
  try {
    const issuingDIDs = await getTrustedIssuerDIDs();
    caTrustRegistry = createTrustRegistry(
      issuingDIDs.map(did => ({ did, vcTypes: ['RealPerson', 'SecurityClearanceGrant'] }))
    );
  } catch (e) {
    console.error('[ServiceAccess] Failed to refresh CA trust registry:', e.message);
  }
}
refreshCaTrustRegistry();
setInterval(refreshCaTrustRegistry, 60 * 1000).unref();

const didCommCmdService = new ServiceAccessService({
  cloudAgentUrl: CLOUD_AGENT_URL,
  apiKey:        API_KEY,
  publicBaseUrl: PUBLIC_BASE_URL,
  accessPath:    '/api/access',
  verifiedEventAdapter: 'polling', // no PresentationVerified webhook wired for this Cloud Agent yet

  async resolveConnection(fromDid) {
    return resolveDIDToConnectionId(fromDid);
  },

  resolveIssuerDID: createIssuerResolver({ cloudAgentUrl: CLOUD_AGENT_URL, apiKey: API_KEY }),
  // `trustRegistry` is dereferenced fresh on every call, so reassigning `caTrustRegistry` above
  // is picked up without needing to reconstruct this service.
  get trustRegistry() { return caTrustRegistry; },

  capabilities: {
    'portal': {
      label: 'CA Dashboard', icon: '🏛️', mode: 'redirect', redirectPath: '/ca/dashboard',
      trustedIssuerVcType: 'RealPerson',
      proofSpec: {
        proofs: [{
          // RealPerson v4.0.0 (the photo-carrying version) — the Cloud Agent enforces this
          // schemaId as a POST-HOC check against whatever VC the wallet actually presents
          // (verified live: a v3.0.0-requested schemaId against a v4.0.0-issued credential
          // produced status PresentationVerificationFailed, matching the Identus error-
          // handling ADR's documented "V6 Schema Mismatch" scenario). v4.0.0 is what
          // /api/credentials/issue-realperson actually issues whenever a photo is supplied.
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/4755a426-b80b-3f6a-b9ea-ca202bd7ce16',
          trustIssuers: [] // filled in dynamically at request time from the trust registry
        }],
        goalCode: 'schema:RealPerson',
        goal:     'Please provide your RealPerson Identity Credential for portal access',
        claims:   { firstName: {}, lastName: {}, uniqueId: {}, dateOfBirth: {}, gender: {} },
        // Wallet-side schema hint — see PROTOCOL.md / ServiceAccessService._handleAccessRequest.
        domain:   'realperson.identuslabel.cz'
      }
    },
    'login': {
      label: 'CA Dashboard', icon: '🔑', mode: 'redirect', redirectPath: '/ca/dashboard',
      trustedIssuerVcType: 'RealPerson',
      proofSpec: {
        proofs: [{
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/4755a426-b80b-3f6a-b9ea-ca202bd7ce16',
          trustIssuers: []
        }],
        goalCode: 'schema:RealPerson',
        goal:     'Please provide your RealPerson Identity Credential for login',
        claims:   { firstName: {}, lastName: {}, uniqueId: {}, dateOfBirth: {}, gender: {} },
        domain:   'realperson.identuslabel.cz'
      }
    },
    'security-clearance': {
      label: 'Security Clearance', icon: '🔐', mode: 'redirect', redirectPath: '/ca/security-clearance',
      trustedIssuerVcType: 'SecurityClearanceGrant',
      proofSpec: {
        // SecurityClearanceLevel v5.0.0 — the current preferred issuance version (see the
        // ['5.0.0','4.0.0','3.0.0'] preference order used when issuing). A stale version
        // GUID here causes the Cloud Agent's post-hoc schema check to reject a real,
        // correctly-typed credential as PresentationVerificationFailed (verified live).
        proofs: [{
          schemaId: 'https://identuslabel.cz/cloud-agent/schema-registry/schemas/78f56570-1405-3847-9e5c-87f582722711',
          trustIssuers: []
        }],
        goalCode: 'schema:SecurityClearance',
        goal:     'Please provide your Security Clearance Credential to access the dashboard',
        claims:   { clearanceLevel: {}, issuedDate: {}, expiryDate: {} },
        domain:   'clearance.identuslabel.cz'
      }
    }
  }
});

// One-time access token redemption endpoint.
// dashboard.html reads the session from ?session=<id> URL param and fetches content
// from /api/dashboard/content?session=<id>. We redirect there directly after registering
// the session server-side — no sessionStorage needed.
app.get('/api/access', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send(accessErrorPage('Missing token parameter.'));
  }

  const entry = didCommCmdService.getToken(token);
  if (!entry) {
    return res.status(404).send(accessErrorPage('Token not found. It may have expired or never existed.'));
  }
  if (entry.used) {
    return res.status(410).send(accessErrorPage('This access link has already been used. Request a new one from your wallet.'));
  }
  if (Date.now() > entry.expiresAt) {
    return res.status(410).send(accessErrorPage('This access link has expired. Request a new one from your wallet.'));
  }

  // Mark as used (single-use enforcement)
  entry.used = true;

  // Register server-side session in the format /api/dashboard/content expects
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  global.userSessions = global.userSessions || new Map();
  global.userSessions.set(sessionId, {
    sessionId,
    authenticated:   true,
    state:           'Authenticated',
    connectionId:    entry.connectionId,
    userData:        entry.userClaims,
    personalInfo:    entry.userClaims,
    loginTime:       now,
    authenticatedAt: now,
    authMethod:      'DIDComm-AccessToken',
    createdAt:       now
  });

  console.log(`[DIDCommAccess] Token redeemed: ${token.slice(0, 12)}... → session ${sessionId.slice(0, 12)}... → ${entry.redirectPath}`);

  // dashboard.html reads ?session=<id> from URL — redirect directly, no bridge needed
  const targetUrl = `${entry.redirectPath}?session=${encodeURIComponent(sessionId)}`;
  res.redirect(302, targetUrl);
});

function accessErrorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2rem;max-width:480px;text-align:center}
h2{color:#f87171;margin-top:0}p{color:#94a3b8;margin-bottom:0}</style></head>
<body><div class="box"><h2>⛔ Access Denied</h2><p>${msg}</p></div></body></html>`;
}

// ── Serve main page ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🏛️  Certification Authority Portal');
  console.log('=' .repeat(50));
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`🔗 Connected to Cloud Agent: ${CLOUD_AGENT_URL}`);
  console.log(`🔑 Using API key: ${API_KEY.substring(0, 10)}...`);
  console.log(`💼 Wallet ID: ${WALLET_ID}`);
  console.log(`🏢 Entity ID: ${ENTITY_ID}`);
  console.log('=' .repeat(50));

  // Register DIDComm command service webhook with Cloud Agent (idempotent)
  const webhookUrl = `${PUBLIC_BASE_URL}/api/webhook-probe`;
  didCommCmdService.registerWebhook(webhookUrl).catch(e =>
    console.error('[DIDCommCmd] Webhook registration error on startup:', e.message)
  );
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Certification Authority Portal...');
  process.exit(0);
});