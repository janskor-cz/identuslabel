/**
 * Company Admin Portal Server
 *
 * Standalone Express application for company DID and employee management.
 * Provides session-based multi-company administration interface with
 * integration to Hyperledger Identus multitenancy Cloud Agent (port 8200).
 */

// PERMANENT FIX: Load .env file automatically at startup
// This ensures ENTERPRISE_DB_PASSWORD and other env vars are always available
// regardless of how the server is started (manual, script, systemd, etc.)
const path = require('path');
const dotenvPath = path.join(__dirname, '.env');
require('dotenv').config({ path: dotenvPath });

const SlackNotifier = require('./lib/SlackNotifier');
const { buildLogEntry, buildLogEntryFromAuditWebhook, VALID_AUDIT_EVENT_TYPES, enrichLogEntryTitle } = require('./lib/AccessGateLogEntry');
const { shouldSkipDuplicateLog } = require('./lib/AccessGateLogDedup');

const ACCESS_GATE_LOG_PATH = path.join(__dirname, 'data', 'access-gate-log.jsonl');

// documentDID -> epoch ms of the last access-gate-log.jsonl write for that document.
// Populated by the /api/access-gate/present grant write and by /api/access-gate/notify itself;
// checked by /api/access-gate/notify to suppress duplicate "cached-key reopen" rows that land
// within DEDUP_WINDOW_MS of an already-logged event for the same document (see AccessGateLogDedup.js).
const recentDocumentLogTimestamps = new Map();

const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
// path already required above for dotenv
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 40 * 1024 * 1024 // 40MB max (Iagon limit)
  },
  fileFilter: (req, file, cb) => {
    // Allow common document types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/json',
      'image/jpeg',
      'image/png',
      'application/octet-stream'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    }
  }
});
// DOCX-only multer instance for document update submissions
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const uploadDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === DOCX_MIME || file.originalname.endsWith('.docx');
    cb(ok ? null : new Error('Only .docx files accepted'), ok);
  }
});

const {
  COMPANIES,
  MULTITENANCY_CLOUD_AGENT_URL,
  getCompany,
  getAllCompanies,
  isValidCompany
} = require('./lib/companies');
const { resolveEmployerCompany } = require('./lib/resolveEmployerCompany');
const { resolveDocumentAccessTenant } = require('./lib/resolveDocumentAccessTenant');

// Employee API Key Management (for Enterprise Cloud Agent)
const EmployeeApiKeyManager = require('./lib/EmployeeApiKeyManager');
const EmployeeWalletManager = require('./lib/EmployeeWalletManager');
const ServiceConfigVCBuilder = require('./lib/ServiceConfigVCBuilder');
const ConnectionEventHandler = require('./lib/ConnectionEventHandler');
const SchemaManager = require('./lib/SchemaManager');
const EmployeePortalDatabase = require('./lib/EmployeePortalDatabase');
const DocumentRegistry = require('./lib/DocumentRegistry');
const FolderRegistry = require('./lib/FolderRegistry');
const ReleasablePartnersRegistry = require('./lib/ReleasablePartnersRegistry');
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const ReEncryptionService = require('./lib/ReEncryptionService');
const { ServiceAccessService, createTrustRegistry, createIssuerResolver, verifyPresentationCredentials, decodeJWT, verifyES256KSignature } = require('service-access-didcomm');

// Task 1: Initialise Classification Master Key (CMK) store — server will not
// start if any CMK env var is missing or has wrong length.
const cmk = require('./lib/ClassificationKeyManager');
try {
  cmk.load();
} catch (err) {
  console.error('[CMK] Failed to load CMK store:', err.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3010;

// Company IssuerDID mapping (extracted from lib/companies.js)
// These DIDs are used for document releasability filtering
const COMPANY_ISSUER_DIDS = {
  'TechCorp Corporation': 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
  'ACME Corporation': 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9',
  'EvilCorp Industries': 'did:prism:1706a8c2adaace6cb5e6b90c94f20991fa7bf4257a9183d69da5c45153f9ca73'
};

// Enterprise Cloud Agent URL (for employee management)
const ENTERPRISE_CLOUD_AGENT_URL = process.env.ENTERPRISE_CLOUD_AGENT_URL || 'http://91.99.4.54:8300';

// Certification Authority base URL (for identity enrichment during login)
const CA_BASE_URL = process.env.CA_BASE_URL || 'https://identuslabel.cz/ca';

// Department API Keys (for issuing ServiceConfiguration VCs to employees)
const DEPARTMENT_API_KEYS = {
  HR: process.env.HR_API_KEY || '2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c',
  IT: process.env.IT_API_KEY || '63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52',
  Security: process.env.SECURITY_API_KEY || '23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288'
};

// Soft-delete storage
const SOFT_DELETED_FILE = path.join(__dirname, 'data', 'soft-deleted-connections.json');

// Employee connection mappings storage
const EMPLOYEE_MAPPINGS_FILE = path.join(__dirname, 'data', 'employee-connection-mappings.json');

// ============================================================================
// URL Shortener (for QR code compatibility with long DIDComm invitation URLs)
// ============================================================================
const shortUrlMap = new Map(); // In-memory storage: shortId → fullUrl
const SHORT_URL_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a random short ID
 * @param {number} length - Length of the ID (default: 8)
 * @returns {string} Random alphanumeric ID
 */
function generateShortId(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // No confusing chars (0,O,1,l,I)
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Clean up expired short URLs (runs periodically)
 */
function cleanupExpiredUrls() {
  const now = Date.now();
  let cleaned = 0;
  for (const [shortId, data] of shortUrlMap.entries()) {
    if (now - data.createdAt > SHORT_URL_EXPIRY_MS) {
      shortUrlMap.delete(shortId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[URL Shortener] Cleaned up ${cleaned} expired URLs`);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredUrls, 60 * 60 * 1000);

/**
 * Load employee-connection mappings from persistent storage
 * @returns {Map} Employee-connection mappings (identifier → connectionId)
 */
function loadEmployeeMappings() {
  try {
    const dataDir = path.dirname(EMPLOYEE_MAPPINGS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(EMPLOYEE_MAPPINGS_FILE)) {
      const data = fs.readFileSync(EMPLOYEE_MAPPINGS_FILE, 'utf8');
      const obj = JSON.parse(data);
      const mappings = new Map(Object.entries(obj));
      console.log(`✅ [EMPLOYEE-MAPPINGS] Loaded ${mappings.size} employee-connection mappings`);
      return mappings;
    } else {
      console.log(`📝 [EMPLOYEE-MAPPINGS] No existing mappings file, starting fresh`);
      return new Map();
    }
  } catch (error) {
    console.error(`❌ [EMPLOYEE-MAPPINGS] Error loading mappings:`, error.message);
    return new Map();
  }
}

/**
 * Save employee-connection mappings to persistent storage
 * @param {Map} mappings - Employee-connection mappings to save
 */
function saveEmployeeMappings(mappings) {
  try {
    const mappingsObj = Object.fromEntries(mappings);
    const data = JSON.stringify(mappingsObj, null, 2);
    fs.writeFileSync(EMPLOYEE_MAPPINGS_FILE, data, 'utf8');
    console.log(`💾 [EMPLOYEE-MAPPINGS] Saved ${mappings.size} mappings to disk`);
  } catch (error) {
    console.error(`❌ [EMPLOYEE-MAPPINGS] Error saving mappings:`, error.message);
  }
}

/**
 * Load soft-deleted connection IDs from persistent storage
 * @returns {Map} Map of company ID to Set of soft-deleted connection IDs
 */
function loadSoftDeletedConnections() {
  try {
    const dataDir = path.dirname(SOFT_DELETED_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(SOFT_DELETED_FILE)) {
      const data = fs.readFileSync(SOFT_DELETED_FILE, 'utf8');
      const dataObj = JSON.parse(data);
      const softDeletedMap = new Map();

      // Convert plain object to Map of Sets
      for (const [companyId, connectionIds] of Object.entries(dataObj)) {
        softDeletedMap.set(companyId, new Set(connectionIds));
      }

      console.log(`✅ [SOFT-DELETE] Loaded soft-deleted connections for ${softDeletedMap.size} companies`);
      return softDeletedMap;
    } else {
      console.log('📝 [SOFT-DELETE] No existing soft-deleted file found, starting fresh');
      return new Map();
    }
  } catch (error) {
    console.error('❌ [SOFT-DELETE] Error loading soft-deleted connections:', error.message);
    return new Map();
  }
}

/**
 * Save soft-deleted connection IDs to persistent storage
 * @param {Map} softDeletedMap - Map of company ID to Set of soft-deleted connection IDs
 */
function saveSoftDeletedConnections(softDeletedMap) {
  try {
    const dataDir = path.dirname(SOFT_DELETED_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Convert Map of Sets to plain object with arrays
    const dataObj = {};
    for (const [companyId, connectionIds] of softDeletedMap.entries()) {
      dataObj[companyId] = Array.from(connectionIds);
    }

    fs.writeFileSync(SOFT_DELETED_FILE, JSON.stringify(dataObj, null, 2));
    console.log('💾 [SOFT-DELETE] Saved soft-deleted connections to disk');
  } catch (error) {
    console.error('❌ [SOFT-DELETE] Error saving soft-deleted connections:', error.message);
  }
}

// Decode the service URI from a did:peer:2 DID's .S segment.
// Returns the uri string or empty string if not decodable.
function decodePeerDidServiceUri(did) {
  if (!did || !did.startsWith('did:peer:')) return '';
  const parts = did.split('.');
  const sPart = parts.find(p => p.startsWith('S'));
  if (!sPart) return '';
  try {
    const raw = sPart.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (raw.length % 4)) % 4;
    const decoded = JSON.parse(Buffer.from(raw + '='.repeat(pad), 'base64').toString());
    return (decoded.s || {}).uri || decoded.uri || '';
  } catch {
    return '';
  }
}

// Returns true if a connection's theirDid points directly to the enterprise agent (not mediator).
// Enterprise wallet peer DIDs encode https://…/enterprise/didcomm as their service endpoint.
// Personal wallet peer DIDs encode a routing did:peer: DID whose service endpoint is the mediator.
function isEnterpriseAgentConnection(theirDid) {
  const uri = decodePeerDidServiceUri(theirDid);
  return uri.startsWith('https://') && uri.includes('enterprise');
}

// Shared helper to get enterprise DB instance (avoids per-function pool creation)
function getEnterpriseDb() {
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
    port: process.env.ENTERPRISE_DB_PORT || 5434,
    database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
    user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
    password: process.env.ENTERPRISE_DB_PASSWORD,
  });
  return new EmployeePortalDatabase(pool);
}

// In-memory stores for colleague chat feature
// Map: invitationId → { id, fromEmail, fromName, toEmail, oobBase64, createdAt }
const colleagueInvitations = new Map();
// Map: recipientEmail → [{ id, fromEmail, fromName, content, timestamp, connectionId }]
const colleagueMessages = new Map();
// Map: `${walletId}:${connectionId}` → { ownerEmail, colleagueEmail, colleagueName }
const connectionColleagueMap = new Map();
// Map: walletId → [{id, fromEmail, fromName, content, timestamp, connectionId}]
// Stores messages sent from the company admin to an employee's enterprise wallet.
const walletAdminMessages = new Map();
// Map: walletId → per-wallet webhook API key (populated at startup from bulk webhook registration)
// Used by the enterprise webhook handler to resolve connectionId from sender Peer DID.
const enterpriseWalletKeyMap = new Map();

// Initialize soft-deleted connections storage
global.softDeletedConnections = loadSoftDeletedConnections();

// Initialize employee-connection mappings storage
global.employeeConnectionMappings = loadEmployeeMappings();

// In-memory store of pending invitations: connectionId → { name, email, role, department, portalUrl }
// Used so issue-service-config can auto-load data without the admin re-entering it.
// Persisted to disk so it survives server restarts.
const PENDING_INVITATIONS_FILE = path.join(__dirname, 'data', 'pending-invitations.json');

function savePendingInvitations() {
  try {
    const obj = {};
    for (const [k, v] of global.pendingInvitations) {
      obj[k] = v;
    }
    fs.writeFileSync(PENDING_INVITATIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('[PendingInvitations] Failed to persist to disk:', e.message);
  }
}

function loadPendingInvitations() {
  try {
    if (fs.existsSync(PENDING_INVITATIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PENDING_INVITATIONS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        global.pendingInvitations.set(k, v);
      }
      console.log(`[PendingInvitations] Loaded ${global.pendingInvitations.size} pending invitation(s) from disk`);
    }
  } catch (e) {
    console.warn('[PendingInvitations] Failed to load from disk:', e.message);
  }
}

global.pendingInvitations = new Map();
loadPendingInvitations();
// Auto-save every 10 seconds so the map survives server restarts
setInterval(savePendingInvitations, 10_000);

/**
 * Generate a unique employee email address from a full name and company slug.
 * Pattern: firstname.lastname@companyslug.test
 * If taken: firstname.lastname.2@..., .3@..., etc.
 *
 * @param {string} fullName - Employee's full name (e.g. "Alice Smith")
 * @param {string} companyId - Company identifier (e.g. "acme")
 * @param {Set<string>} existingEmails - Already-used emails for this company
 * @returns {string} Unique email address
 */
function generateEmployeeEmail(fullName, companyId, existingEmails) {
  const parts = fullName.trim().split(/\s+/);
  const lastName = parts.pop() || 'employee';
  const firstName = parts.join('') || 'employee';

  // Normalize: lowercase, remove accents, keep only a-z0-9
  const normalize = (s) =>
    s.toLowerCase()
     .normalize('NFD')
     .replace(/[\u0300-\u036f]/g, '')
     .replace(/[^a-z0-9]/g, '');

  const slug = companyId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = `${normalize(firstName)}.${normalize(lastName)}`;

  let candidate = `${base}@${slug}.test`;
  if (!existingEmails.has(candidate)) return candidate;

  let n = 2;
  while (existingEmails.has(`${base}.${n}@${slug}.test`)) n++;
  return `${base}.${n}@${slug}.test`;
}

/**
 * Collect all emails already assigned to invitations for a given company.
 * @param {string} companyId
 * @returns {Set<string>}
 */
function getExistingEmailsForCompany(companyId) {
  const emails = new Set();
  for (const inv of global.pendingInvitations.values()) {
    if (inv.companyId === companyId && inv.email) emails.add(inv.email);
  }
  return emails;
}

// Middleware

// CORS configuration - Allow wallet (cross-origin) to send X-Session-ID header
app.use((req, res, next) => {
  // Allow requests from wallet origins
  const allowedOrigins = [
    'https://identuslabel.cz',
    'http://91.99.4.54:3001',
    'http://localhost:3001'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-ID, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
// Trust proxy for reverse proxy setup (Caddy)
app.set('trust proxy', 1);

app.use(session({
  secret: 'company-admin-portal-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  proxy: true, // Trust proxy headers for secure cookies
  cookie: {
    secure: false, // Set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax' // CSRF protection while allowing normal navigation
    // Note: No explicit 'path' - uses default '/' to work with path-stripping reverse proxy
  }
}));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/**
 * Middleware to require company selection
 */
function requireCompany(req, res, next) {
  if (!req.session.companyId) {
    return res.status(401).json({
      success: false,
      error: 'No company selected. Please login first.'
    });
  }

  const company = getCompany(req.session.companyId);
  if (!company) {
    return res.status(401).json({
      success: false,
      error: 'Invalid company session. Please login again.'
    });
  }

  // Attach company to request for convenience
  req.company = company;
  next();
}

/**
 * Helper function to make Cloud Agent API calls (Multitenancy Cloud Agent - port 8200)
 */
async function cloudAgentRequest(apiKey, endpoint, options = {}) {
  const url = `${MULTITENANCY_CLOUD_AGENT_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': apiKey,
    ...options.headers
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers
    });

    const responseText = await response.text();
    let data;

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      data = { rawResponse: responseText };
    }

    if (!response.ok) {
      throw new Error(`Cloud Agent error (${response.status}): ${JSON.stringify(data)}`);
    }

    return { success: true, data };
  } catch (error) {
    console.error(`Cloud Agent request failed: ${error.message}`);
    throw error;
  }
}

/**
 * Helper function to make Enterprise Cloud Agent API calls (port 8300)
 */
async function enterpriseAgentRequest(apiKey, endpoint, options = {}) {
  const url = `${ENTERPRISE_CLOUD_AGENT_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': apiKey,
    ...options.headers
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers
    });

    const responseText = await response.text();
    let data;

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      data = { rawResponse: responseText };
    }

    if (!response.ok) {
      throw new Error(`Enterprise Agent error (${response.status}): ${JSON.stringify(data)}`);
    }

    return { success: true, data };
  } catch (error) {
    console.error(`Enterprise Agent request failed: ${error.message}`);
    throw error;
  }
}

/**
 * Resolve a PRISM photoDID to its LinkedPhoto service endpoint URL.
 * Used as a fallback when the CA's photoDIDs cache doesn't have an entry for the user.
 * The photoDID's service endpoint contains the photo proxy URL per SSI resolution spec.
 */
async function resolveLinkedPhotoDID(photoDID) {
  if (!photoDID || !photoDID.startsWith('did:prism:')) return null;
  // Validate DID format: only alphanumeric, colon, hyphen, underscore — prevents path traversal / SSRF
  if (!/^did:prism:[a-zA-Z0-9:_-]+$/.test(photoDID)) {
    console.warn(`[PhotoDID] Invalid DID format rejected: ${photoDID.substring(0, 40)}`);
    return null;
  }
  try {
    const resp = await fetch(
      `${ENTERPRISE_CLOUD_AGENT_URL}/dids/${encodeURIComponent(photoDID)}`,
      { headers: { 'apikey': process.env.ENTERPRISE_ADMIN_TOKEN || '3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu' } }
    );
    if (!resp.ok) return null;
    const doc = await resp.json();
    const services = doc?.didDocument?.service || [];
    const linkedPhoto = services.find(s => s.type === 'LinkedPhoto');
    return linkedPhoto?.serviceEndpoint || null;
  } catch (e) {
    console.warn(`[PhotoDID] DID resolution failed for ${photoDID.substring(0, 30)}...: ${e.message}`);
    return null;
  }
}

/**
 * Fetch the current KeyManifest VC record for a document from document-service.
 * Returns the full record ({ vcJwt, claims, ... }) or null if not found / unavailable.
 *
 * @param {string} documentDID
 * @param {string} docServiceUrl
 * @param {string} adminKey
 * @returns {Promise<object|null>}
 */
async function fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey) {
  if (!docServiceUrl || !documentDID) return null;
  try {
    const res = await fetch(
      `${docServiceUrl}/vc/key-manifest/${encodeURIComponent(documentDID)}`,
      { headers: { 'x-admin-key': adminKey }, timeout: 5000 }
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Move KeyManifestVCIssuer to module-level (avoids repeated require() in hot paths)
const KeyManifestVCIssuer = require('./lib/KeyManifestVCIssuer');

/** Thrown when a DocumentKeyManifest VC fails signature or claim verification. */
class ManifestVCInvalid extends Error {
  constructor(reason) {
    super(`ManifestVCInvalid: ${reason}`);
    this.name = 'ManifestVCInvalid';
  }
}

// ============================================================================
// Public Routes (no authentication required)
// ============================================================================

/**
 * GET / - Serve frontend
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/employee-portal', (req, res) => {
  res.redirect('/company-admin/employee-portal-login.html');
});

/**
 * GET /api/health - Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'Company Admin Portal',
    version: '1.0.0',
    port: PORT,
    cloudAgent: MULTITENANCY_CLOUD_AGENT_URL,
    uptime: process.uptime()
  });
});

// ============================================================================
// URL Shortener Routes (for QR code compatibility)
// ============================================================================

/**
 * POST /api/shorten - Create a short URL
 * Used to make long DIDComm invitation URLs scannable as QR codes
 */
app.post('/api/shorten', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'URL is required'
    });
  }

  // Generate unique short ID
  let shortId;
  do {
    shortId = generateShortId();
  } while (shortUrlMap.has(shortId));

  // Store the mapping
  shortUrlMap.set(shortId, {
    url: url,
    createdAt: Date.now()
  });

  // Build the short URL using the request's host
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const basePath = req.baseUrl || '/company-admin';
  const shortUrl = `${protocol}://${host}${basePath}/s/${shortId}`;

  console.log(`[URL Shortener] Created: ${shortId} -> ${url.substring(0, 50)}... (${url.length} chars)`);

  res.json({
    success: true,
    shortUrl: shortUrl,
    shortId: shortId,
    expiresIn: '24 hours'
  });
});

/**
 * GET /s/:shortId - Redirect to the full URL
 */
app.get('/s/:shortId', (req, res) => {
  const { shortId } = req.params;
  const data = shortUrlMap.get(shortId);

  if (!data) {
    console.log(`[URL Shortener] Not found: ${shortId}`);
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Link Expired</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>Link Not Found or Expired</h1>
        <p>This invitation link has expired or does not exist.</p>
        <p>Please request a new invitation from your administrator.</p>
      </body>
      </html>
    `);
  }

  // Check if expired
  if (Date.now() - data.createdAt > SHORT_URL_EXPIRY_MS) {
    shortUrlMap.delete(shortId);
    console.log(`[URL Shortener] Expired: ${shortId}`);
    return res.status(410).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Link Expired</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>Invitation Link Expired</h1>
        <p>This invitation link has expired (24 hour limit).</p>
        <p>Please request a new invitation from your administrator.</p>
      </body>
      </html>
    `);
  }

  console.log(`[URL Shortener] Redirect: ${shortId}`);
  res.redirect(302, data.url);
});

/**
 * GET /api/companies - List all available companies
 */
app.get('/api/companies', (req, res) => {
  const companies = getAllCompanies().map(company => ({
    id: company.id,
    name: company.name,
    displayName: company.displayName,
    tagline: company.tagline,
    color: company.color,
    logo: company.logo,
    did: company.did,
    trustedPartners: company.trustedPartners || []
  }));

  res.json({
    success: true,
    companies
  });
});

// ============================================================================
// Authentication Routes
// ============================================================================

/**
 * POST /api/auth/login - Select company and create session
 */
app.post('/api/auth/login', (req, res) => {
  const { companyId } = req.body;

  if (!companyId) {
    return res.status(400).json({
      success: false,
      error: 'Company ID is required'
    });
  }

  if (!isValidCompany(companyId)) {
    return res.status(404).json({
      success: false,
      error: 'Company not found'
    });
  }

  const company = getCompany(companyId);

  // Store company context in session
  req.session.companyId = company.id;
  req.session.companyName = company.name;
  req.session.displayName = company.displayName;

  console.log(`[AUTH] Company selected: ${company.displayName} (${company.id})`);

  res.json({
    success: true,
    message: `Logged in as ${company.displayName}`,
    company: {
      id: company.id,
      name: company.name,
      displayName: company.displayName,
      logo: company.logo,
      color: company.color
    }
  });
});

/**
 * GET /api/auth/current - Get current company from session
 */
app.get('/api/auth/current', (req, res) => {
  if (!req.session.companyId) {
    return res.json({
      success: true,
      authenticated: false,
      company: null
    });
  }

  const company = getCompany(req.session.companyId);

  if (!company) {
    return res.json({
      success: true,
      authenticated: false,
      company: null
    });
  }

  res.json({
    success: true,
    authenticated: true,
    company: {
      id: company.id,
      name: company.name,
      displayName: company.displayName,
      logo: company.logo,
      color: company.color,
      tagline: company.tagline
    }
  });
});

/**
 * POST /api/auth/logout - Clear session
 */
app.post('/api/auth/logout', (req, res) => {
  const companyName = req.session.companyName;

  req.session.destroy(err => {
    if (err) {
      console.error('[AUTH] Session destroy error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to logout'
      });
    }

    console.log(`[AUTH] Logged out: ${companyName}`);

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
});

// ============================================================================
// Company-Scoped Routes (authentication required)
// ============================================================================

/**
 * GET /api/company/info - Get company information including DID
 */
app.get('/api/company/info', requireCompany, (req, res) => {
  const company = req.company;

  res.json({
    success: true,
    company: {
      id: company.id,
      name: company.name,
      displayName: company.displayName,
      tagline: company.tagline,
      did: company.did,
      didLongForm: company.didLongForm,
      website: company.website,
      publicKeys: company.publicKeys,
      services: company.services,
      walletId: company.walletId,
      entityId: company.entityId,
      logo: company.logo,
      color: company.color
    }
  });
});

/**
 * GET /api/company/dids - List company DIDs from Cloud Agent
 */
app.get('/api/company/dids', requireCompany, async (req, res) => {
  try {
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/did-registrar/dids'
    );

    res.json({
      success: true,
      dids: result.data.contents || [],
      totalCount: result.data.totalCount || 0
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

function isEmployeeConnection(conn, softDeletedSet) {
  if (softDeletedSet.has(conn.connectionId)) return false;
  const label = (conn.label || '').toLowerCase();
  const theirLabel = (conn.theirLabel || '').toLowerCase();
  if (label.includes('ca ') || label.includes(' ca') ||
      label.includes('certification') || label.includes('authority') ||
      theirLabel.includes('certification') || theirLabel.includes('authority')) return false;
  if (label.includes('↔') || label.includes('<->') ||
      theirLabel.includes('↔') || theirLabel.includes('<->')) return false;
  if (conn.state === 'InvitationGenerated') return false;
  return true;
}

/**
 * GET /api/company/connections - List all connections (employees)
 */
app.get('/api/company/connections', requireCompany, async (req, res) => {
  try {
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/connections'
    );

    const connections = result.data.contents || [];

    const softDeleted = global.softDeletedConnections.get(req.company.id) || new Set();

    // DB enrichment: fall back to persistent employee records when pendingInvitations is empty
    let dbConnectionMap = new Map();
    if (process.env.ENTERPRISE_DB_PASSWORD) {
      try {
        dbConnectionMap = await getEnterpriseDb().getEmployeeConnectionMap(req.company.id);
      } catch (e) { console.warn('[connections] DB enrich skipped:', e.message); }
    }

    function enrichConn(conn) {
      const pending = global.pendingInvitations.get(conn.connectionId);
      const dbRow = dbConnectionMap.get(conn.connectionId);
      // Parse label "Name (role) - department" as last-resort fallback for old connections
      // whose pendingInvitations entry was lost (e.g. pre-persistence or missed saves)
      let labelName = null, labelRole = null, labelDept = null;
      const lm = (conn.label || '').match(/^(.+?)\s+\(([^)]+)\)\s+-\s+(.+)$/);
      if (lm && lm[1] !== 'Pending') { labelName = lm[1]; labelRole = lm[2]; labelDept = lm[3]; }
      else if (lm) { labelRole = lm[2]; labelDept = lm[3]; }
      return {
        connectionId: conn.connectionId,
        label: conn.label,
        theirLabel: conn.theirLabel || null,
        state: conn.state,
        theirDid: conn.theirDid,
        myDid: conn.myDid,
        createdAt: conn.createdAt,
        updatedAt: conn.updatedAt,
        proofState: pending?.proofState || null,
        proofError: pending?.proofError || null,
        employeeName: pending?.name || dbRow?.full_name || labelName || null,
        employeeEmail: pending?.email || dbRow?.email || null,
        employeeRole: pending?.role || labelRole || null,
        employeeDept: pending?.department || dbRow?.department || labelDept || null,
      };
    }

    // HR-invited connections (non-↔)
    let hrEmployees = connections
      .filter(conn => isEmployeeConnection(conn, softDeleted))
      .map(enrichConn);

    // An employee's techcorp_connection_id (dbConnectionMap) is the DB's canonical connection
    // for that email — same fix as /api/admin/employee-index applies here (see its comment for
    // the full rationale). The old name-based dedup below let any connection resolving to the
    // same employeeEmail (e.g. via a stale pendingInvitations/label match) silently shadow the
    // real DB-canonical connection, hiding the vast majority of a company's actual employees
    // (confirmed: 39 of TechCorp's 43 active employees were being dropped this way).
    const canonicalConnIdByEmail = new Map();
    for (const [connId, row] of dbConnectionMap.entries()) {
      if (row.email) canonicalConnIdByEmail.set(row.email.toLowerCase(), connId);
    }
    hrEmployees = hrEmployees.filter(e => {
      const canonical = e.employeeEmail && canonicalConnIdByEmail.get(e.employeeEmail.toLowerCase());
      return !canonical || canonical === e.connectionId;
    });

    // Add DB-backed canonical connections not already shown
    const shownIds = new Set(hrEmployees.map(e => e.connectionId));
    const connById = new Map(connections.map(c => [c.connectionId, c]));

    const dbEmployees = [];
    for (const [connId, dbRow] of dbConnectionMap.entries()) {
      if (shownIds.has(connId)) continue;
      const conn = connById.get(connId);
      if (!conn) continue;
      if (softDeleted.has(connId)) continue;
      const activeStates = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active', 'ACTIVE', 'active'];
      if (!activeStates.includes(conn.state)) continue;
      dbEmployees.push(enrichConn(conn));
    }

    const employees = [...hrEmployees, ...dbEmployees];

    res.json({
      success: true,
      connections: employees,
      totalCount: employees.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/invite-employee - Create DIDComm invitation for employee
 */
app.post('/api/company/invite-employee', requireCompany, async (req, res) => {
  try {
    // Bounds worst-case resource usage: each pending invitation costs the auto-proof loop a
    // Cloud Agent API call every 4s until it resolves, so an unbounded queue (even from an
    // authenticated admin, accidentally or otherwise) could grow into a real load problem.
    const MAX_PENDING_INVITATIONS = 200;
    if (global.pendingInvitations && global.pendingInvitations.size >= MAX_PENDING_INVITATIONS) {
      return res.status(429).json({
        success: false,
        error: 'TooManyPendingInvitations',
        message: `${MAX_PENDING_INVITATIONS} invitations are already pending onboarding completion. Wait for some to finish (or fail) before creating more.`
      });
    }

    const { employeeName, name, role, department } = req.body;
    const resolvedName = employeeName || name || '';

    // Build label — name is unknown until RealPerson proof is received
    const labelParts = resolvedName ? [resolvedName] : ['Pending'];
    if (role) labelParts.push(`(${role})`);
    if (department) labelParts.push(`- ${department}`);
    const label = labelParts.join(' ');

    // Create goal for invitation
    const goal = resolvedName
      ? `Employee connection for ${resolvedName} at ${req.company.displayName}`
      : `Employee connection at ${req.company.displayName}`;

    // Create invitation via Cloud Agent
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/connections',
      {
        method: 'POST',
        body: JSON.stringify({
          label,
          goal
        })
      }
    );

    const invitation = result.data;

    console.log(`[EMPLOYEE] Created invitation (${req.company.name}) label="${label}"`);

    // Store invitation record — name/email will be filled in after RealPerson proof.
    // triggerEnterpriseOnboarding: auto-proof loop will call createEmployeeWallet() after
    // the RealPerson proof is verified, so the enterprise wallet + EmployeeRole VC are
    // created only after the photo DID is already persisted to DB.
    global.pendingInvitations.set(invitation.connectionId, {
      companyId: req.company.id,
      name: resolvedName,
      email: '',
      role: role || '',
      department: department || '',
      portalUrl: '',
      triggerEnterpriseOnboarding: true,
    });

    // Always modify the OOB invitation to embed the company name and (optionally) company credential
    let finalInvitation = invitation.invitation;
    let hasCompanyCredential = false;

    try {
      const invitationUrl = new URL(invitation.invitation.invitationUrl);
      const oobParam = invitationUrl.searchParams.get('_oob');

      if (!oobParam) throw new Error('Invalid invitation URL: missing _oob parameter');

      const invitationObj = JSON.parse(Buffer.from(oobParam, 'base64').toString('utf-8'));
      if (!invitationObj.body) invitationObj.body = {};

      // Always set company name so wallet shows "TechCorp Corporation" instead of "Unknown connection"
      invitationObj.label = req.company.displayName;
      invitationObj.body.goal = `Connect as employee at ${req.company.displayName}`;

      // Try to embed CompanyIdentity credential if available
      try {
        const credentialsResult = await cloudAgentRequest(req.company.apiKey, '/issue-credentials/records');
        const allRecords = credentialsResult.data.contents || [];

        const companyIdentityCredentials = allRecords.filter(r => {
          const isIssued = r.protocolState === 'CredentialReceived' || r.protocolState === 'CredentialSent';
          if (!isIssued) return false;
          try {
            const decoded = decodeCredential(r);
            return decoded && decoded.credentialType === 'CompanyIdentity';
          } catch { return false; }
        });

        if (companyIdentityCredentials.length > 0) {
          const companyCredential = decodeCredential(companyIdentityCredentials[0]);
          if (companyCredential && companyCredential.jwtCredential) {
            invitationObj.body.goal_code = 'company-employee-verification';
            invitationObj.requests_attach = [{
              '@id': 'company-identity-credential',
              'mime-type': 'application/json',
              data: {
                json: {
                  credential: companyCredential.jwtCredential,
                  claims: companyCredential.claims,
                  issuerDID: companyCredential.issuer,
                  holderDID: companyCredential.subject,
                  credentialType: companyCredential.credentialType,
                  issuedDate: companyCredential.issuanceDate
                }
              }
            }];
            hasCompanyCredential = true;
            console.log(`✅ [EMPLOYEE] Company credential embedded in invitation`);
          }
        } else {
          console.warn(`⚠️ [EMPLOYEE] No CompanyIdentity credential for ${req.company.name} — label-only OOB`);
        }
      } catch (credErr) {
        console.warn(`⚠️ [EMPLOYEE] Could not fetch company credential: ${credErr.message} — label-only OOB`);
      }

      // Re-encode the modified invitation
      const modifiedOobParam = Buffer.from(JSON.stringify(invitationObj)).toString('base64');
      invitationUrl.searchParams.set('_oob', modifiedOobParam);
      finalInvitation = { ...invitation.invitation, invitationUrl: invitationUrl.toString() };
    } catch (embedError) {
      console.error('⚠️ [EMPLOYEE] Failed to modify OOB invitation:', embedError.message);
      // Continue with original invitation
    }

    res.json({
      success: true,
      message: `Invitation created`,
      invitation: {
        connectionId: invitation.connectionId,
        invitationUrl: finalInvitation.invitationUrl,
        label: label,
        state: invitation.state,
        createdAt: invitation.createdAt,
        hasCompanyCredential,
      }
    });
  } catch (error) {
    console.error(`❌ [EMPLOYEE] Error creating invitation:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/company/connections/:id - Remove employee connection
 */
app.delete('/api/company/connections/:id', requireCompany, async (req, res) => {
  try {
    const { id } = req.params;

    try {
      await cloudAgentRequest(
        req.company.apiKey,
        `/connections/${id}`,
        {
          method: 'DELETE'
        }
      );

      console.log(`[EMPLOYEE] ✅ Deleted connection ${id} from Cloud Agent (${req.company.name})`);

      // Add to soft-deleted set even on successful delete (for filtering)
      if (!global.softDeletedConnections.has(req.company.id)) {
        global.softDeletedConnections.set(req.company.id, new Set());
      }
      global.softDeletedConnections.get(req.company.id).add(id);
      saveSoftDeletedConnections(global.softDeletedConnections);

      res.json({
        success: true,
        message: 'Employee connection removed successfully'
      });
    } catch (cloudAgentError) {
      // Handle Cloud Agent 403 Forbidden - InvalidStateForOperation
      if (cloudAgentError.message.includes('403') || cloudAgentError.message.includes('Forbidden') || cloudAgentError.message.includes('InvalidStateForOperation')) {
        console.warn(`⚠️ Cloud Agent rejected delete (403) - connection in protected state`);
        console.warn(`⚠️ Performing soft delete for connection ${id}`);

        // Add to soft-deleted connections
        if (!global.softDeletedConnections.has(req.company.id)) {
          global.softDeletedConnections.set(req.company.id, new Set());
        }
        global.softDeletedConnections.get(req.company.id).add(id);
        saveSoftDeletedConnections(global.softDeletedConnections);

        console.log(`🗑️ Soft-deleted connection ${id} (${req.company.name})`);

        return res.json({
          success: true,
          message: 'Connection removed from view (soft-deleted)',
          softDelete: true,
          note: 'Connection still exists in Cloud Agent but hidden from employee list'
        });
      }

      throw cloudAgentError;
    }
  } catch (error) {
    console.error(`[EMPLOYEE] ❌ Delete failed:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Helper function to decode JWT credential and determine status
 */
function decodeCredential(record) {
  try {
    // Decode base64 credential to get JWT
    const jwtString = Buffer.from(record.credential, 'base64').toString('utf-8');

    // Decode JWT without verification (we trust Cloud Agent issued it)
    const decoded = jwt.decode(jwtString, { complete: true });

    if (!decoded || !decoded.payload || !decoded.payload.vc) {
      return null;
    }

    const vc = decoded.payload.vc;
    const claims = vc.credentialSubject || {};

    // Extract credential type from claims
    const credentialType = claims.credentialType || 'Unknown';

    // Determine status based on expiry and protocol state
    let status = 'active';
    const now = new Date();

    if (claims.expiryDate) {
      const expiryDate = new Date(claims.expiryDate);
      if (expiryDate < now) {
        status = 'expired';
      }
    }

    // Check revocation from credentialStatus
    if (vc.credentialStatus) {
      // Note: Full revocation check would require fetching StatusList2021
      // For now, we'll mark it as potentially revocable
      status = status === 'expired' ? 'expired' : 'active';
    }

    return {
      recordId: record.recordId,
      protocolState: record.protocolState,
      credentialFormat: record.credentialFormat,
      credentialType,
      claims,
      issuedDate: claims.issuedDate || vc.issuanceDate || null,
      expiryDate: claims.expiryDate || null,
      status,
      credentialStatus: vc.credentialStatus || null,
      issuer: decoded.payload.iss || null,
      subject: decoded.payload.sub || null,
      jwtCredential: jwtString,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  } catch (error) {
    console.error('Error decoding credential:', error);
    return null;
  }
}

/**
 * GET /api/company/credentials - List issued Company Identity credentials
 * Query params:
 *   - filter: 'all', 'active', 'revoked', 'expired' (default: 'all')
 */
app.get('/api/company/credentials', requireCompany, async (req, res) => {
  try {
    const filter = req.query.filter || 'all';

    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/issue-credentials/records'
    );

    const allRecords = result.data.contents || [];

    // Filter for CredentialReceived state (holder side) or CredentialSent (issuer side)
    const issuedRecords = allRecords.filter(r =>
      r.protocolState === 'CredentialReceived' || r.protocolState === 'CredentialSent'
    );

    // Decode all credentials
    const decodedCredentials = issuedRecords
      .map(record => decodeCredential(record))
      .filter(cred => cred !== null);

    // Filter for CompanyIdentity credentials only
    const companyCredentials = decodedCredentials.filter(cred =>
      cred.credentialType === 'CompanyIdentity'
    );

    // Apply status filter
    let filteredCredentials = companyCredentials;
    if (filter !== 'all') {
      filteredCredentials = companyCredentials.filter(cred =>
        cred.status === filter
      );
    }

    res.json({
      success: true,
      credentials: filteredCredentials,
      totalCount: filteredCredentials.length,
      filter,
      stats: {
        total: companyCredentials.length,
        active: companyCredentials.filter(c => c.status === 'active').length,
        revoked: companyCredentials.filter(c => c.status === 'revoked').length,
        expired: companyCredentials.filter(c => c.status === 'expired').length
      }
    });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/issue-credential - Issue credential to employee
 */
app.post('/api/company/issue-credential', requireCompany, async (req, res) => {
  try {
    const { connectionId, credentialType, claims } = req.body;

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        error: 'Connection ID is required'
      });
    }

    // Create credential offer
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/issue-credentials/credential-offers',
      {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          credentialFormat: 'JWT',
          claims: claims || {
            organization: req.company.displayName,
            credentialType: credentialType || 'EmployeeCredential',
            issuedAt: new Date().toISOString()
          },
          issuingDID: req.company.did
        })
      }
    );

    console.log(`[CREDENTIAL] Issued ${credentialType || 'credential'} to connection ${connectionId} (${req.company.name})`);

    res.json({
      success: true,
      message: 'Credential offer sent',
      credential: result.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// Employee API Key Management (Enterprise Cloud Agent Integration)
// ============================================================================

/**
 * POST /api/company/generate-employee-key - Generate employee API key
 * Request body: { email, name, department, connectionId }
 */
app.post('/api/company/generate-employee-key', requireCompany, async (req, res) => {
  try {
    const { email, name, department, connectionId } = req.body;

    if (!email || !name || !department || !connectionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, name, department, connectionId'
      });
    }

    // Validate department
    if (!['HR', 'IT', 'Security'].includes(department)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid department. Must be one of: HR, IT, Security'
      });
    }

    // Generate employee API key
    const keyData = await EmployeeApiKeyManager.generateEmployeeApiKey({
      connectionId,
      email,
      name,
      department
    });

    console.log(`[EMPLOYEE-KEY] Generated API key for ${name} (${email}) - Department: ${department}`);

    res.json({
      success: true,
      message: `API key generated for ${name}`,
      keyData: {
        keyId: keyData.keyId,
        apiKey: keyData.apiKey, // Only shown once!
        expiresAt: keyData.expiresAt,
        scope: keyData.scope,
        warning: 'This API key will only be displayed once. Store it securely.'
      }
    });
  } catch (error) {
    console.error('[EMPLOYEE-KEY] Generation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/issue-service-config/:connectionId - Issue ServiceConfiguration VC
 */
app.post('/api/company/issue-service-config/:connectionId', requireCompany, async (req, res) => {
  try {
    const { connectionId } = req.params;

    // Auto-load from stored invitation record if available; fall back to explicit body
    const stored = global.pendingInvitations.get(connectionId);
    const email = stored?.email || req.body.email;
    const name = stored?.name || req.body.name;

    if (!email || !name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email and name. Either create an invitation first or supply them in the request body.'
      });
    }

    const VALID_DEPTS = ['HR', 'IT', 'Security'];
    const rawDept = stored?.department || req.body.department || '';
    const resolvedDepartment = VALID_DEPTS.includes(rawDept) ? rawDept : 'IT';

    // Get department API key for issuing credentials
    const departmentApiKey = DEPARTMENT_API_KEYS[resolvedDepartment];
    if (!departmentApiKey) {
      return res.status(500).json({
        success: false,
        error: `Department API key not configured for ${resolvedDepartment}`
      });
    }

    // ✨ NEW: Build ServiceConfiguration VC claims (auto-creates employee wallet with PRISM DID)
    console.log(`\n📝 [SERVICE-CONFIG] Issuing ServiceConfiguration to ${name} (${email})`);
    const claims = await ServiceConfigVCBuilder.buildServiceConfigClaims({
      email,
      name,
      department: resolvedDepartment,
      connectionId
    }, req.company); // Pass company context for correct enterpriseAgentName

    // ✨ NEW: Log employee wallet details (created during claims build)
    console.log(`\n🎉 [SERVICE-CONFIG] Employee wallet created:`);
    console.log(`   Wallet ID: ${claims.employeeWallet.walletId}`);
    console.log(`   Entity ID: ${claims.employeeWallet.entityId}`);
    console.log(`   PRISM DID: ${claims.employeeWallet.prismDid.substring(0, 60)}...`);
    console.log(`   API Key: ${claims.employeeWallet.apiKey.substring(0, 20)}... (stored in VC)\n`);

    // Get the company's ServiceConfiguration schema ID (registered on multitenancy agent)
    const schemaId = await SchemaManager.ensureServiceConfigSchema(
      MULTITENANCY_CLOUD_AGENT_URL,
      req.company.apiKey,
      req.company.did
    );

    // Build credential offer — issued via the company's multitenancy agent (same agent as the connection)
    const credentialOffer = {
      connectionId,
      credentialFormat: 'JWT',
      claims: claims.credentialSubject,
      automaticIssuance: true,
      issuingDID: req.company.did,
      schemaId,
    };

    // Issue credential via company's multitenancy Cloud Agent (where the connection lives)
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/issue-credentials/credential-offers',
      {
        method: 'POST',
        body: JSON.stringify(credentialOffer)
      }
    );

    // Mark VC as issued in database
    await EmployeeApiKeyManager.markConfigVcIssued(connectionId, result.data.recordId);

    console.log(`[SERVICE-CONFIG] Issued ServiceConfiguration VC to ${name} (${email})`);

    res.json({
      success: true,
      message: `ServiceConfiguration credential issued to ${name}`,
      vcRecord: result.data
    });
  } catch (error) {
    console.error('[SERVICE-CONFIG] Issuance failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/company/connections/:connectionId/invitation-data
 * Returns invitation data (name, email, role, department) for a connection.
 * Uses the in-memory store when available; otherwise derives email from the
 * connection label + company ID so pre-fill works even after a server restart.
 */
app.get('/api/company/connections/:connectionId/invitation-data', requireCompany, async (req, res) => {
  const { connectionId } = req.params;

  // 1. Prefer in-memory store (set when invitation was created this session)
  const stored = global.pendingInvitations.get(connectionId);
  if (stored) {
    return res.json({ success: true, data: stored });
  }

  // 2. Fallback: fetch the connection label from the Cloud Agent and derive email
  try {
    const result = await cloudAgentRequest(req.company.apiKey, `/connections/${connectionId}`);
    const conn = result.data;
    const label = conn?.label || '';

    // Parse label: "Name (Role) - Department"
    let name = label;
    let role = '';
    let department = '';
    const roleMatch = label.match(/^([^(]+)\(([^)]+)\)(.*)$/);
    if (roleMatch) {
      name = roleMatch[1].trim();
      role = roleMatch[2].trim();
      const remainder = roleMatch[3].trim();
      if (remainder.startsWith('- ')) department = remainder.substring(2).trim();
    } else {
      const deptMatch = label.match(/^([^-]+)-(.+)$/);
      if (deptMatch) { name = deptMatch[1].trim(); department = deptMatch[2].trim(); }
    }

    const existingEmails = getExistingEmailsForCompany(req.company.id);
    const email = name ? generateEmployeeEmail(name, req.company.id, existingEmails) : '';
    const portalBase = process.env.COMPANY_PORTAL_BASE_URL || 'https://identuslabel.cz/company-admin';
    const portalUrl = email ? `${portalBase}/employee-portal-login.html?email=${encodeURIComponent(email)}` : '';

    const data = { companyId: req.company.id, name, email, role, department, portalUrl };

    // Cache it so the issue endpoint can use it too
    if (name && email) global.pendingInvitations.set(connectionId, data);

    return res.json({ success: true, data });
  } catch {
    return res.json({ success: true, data: null });
  }
});

/**
 * Shared helper: issue ServiceConfiguration VC to a connection.
 * Extracted so both auto-issue-config and rp-proof-status can call it.
 */
async function issueServiceConfigVC(connectionId, name, email, rawDepartment, company, realPersonClaims = null, existingWallet = null) {
  const VALID_DEPTS = ['HR', 'IT', 'Security'];
  const resolvedDepartment = VALID_DEPTS.includes(rawDepartment) ? rawDepartment : 'IT';

  const departmentApiKey = DEPARTMENT_API_KEYS[resolvedDepartment];
  if (!departmentApiKey) throw new Error(`Department API key not configured for ${resolvedDepartment}`);

  console.log(`\n📝 [AUTO-ISSUE] Issuing ServiceConfiguration to ${name} (${email})`);
  const claims = await ServiceConfigVCBuilder.buildServiceConfigClaims({
    email, name, department: resolvedDepartment, connectionId
  }, company, realPersonClaims, existingWallet);

  const schemaId = await SchemaManager.ensureServiceConfigSchema(
    MULTITENANCY_CLOUD_AGENT_URL,
    company.apiKey,
    company.did
  );

  const credentialOffer = {
    connectionId,
    credentialFormat: 'JWT',
    claims: claims.credentialSubject,
    automaticIssuance: true,
    issuingDID: company.did,
    schemaId,
  };

  const result = await cloudAgentRequest(
    company.apiKey,
    '/issue-credentials/credential-offers',
    { method: 'POST', body: JSON.stringify(credentialOffer) }
  );

  await EmployeeApiKeyManager.markConfigVcIssued(connectionId, result.data.recordId);

  // Persist the personal wallet connectionId so clearance/initiate can find it without label heuristics
  if (email) {
    try {
      const empDb = getEnterpriseDb();
      await empDb.savePersonalWalletConnectionId(email, connectionId);
      console.log(`[AUTO-ISSUE] Saved personal wallet connectionId for ${email}: ${connectionId}`);
    } catch (saveErr) {
      console.warn(`[AUTO-ISSUE] Could not persist personal_wallet_connection_id: ${saveErr.message}`);
    }
  }

  console.log(`[AUTO-ISSUE] Issued ServiceConfiguration VC to ${name} (${email})`);
  return result.data;
}

/**
 * POST /api/company/connections/:connectionId/auto-issue-config
 * Alias for issue-service-config — used by the frontend Issue Credential button.
 */
app.post('/api/company/connections/:connectionId/auto-issue-config', requireCompany, async (req, res) => {
  const { connectionId } = req.params;

  const stored = global.pendingInvitations.get(connectionId);
  const email = stored?.email || req.body.email;
  const name = stored?.name || req.body.name;
  const rawDept = stored?.department || req.body.department || '';

  if (!email || !name) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: email and name.'
    });
  }

  try {
    const data = await issueServiceConfigVC(connectionId, name, email, rawDept, req.company);
    res.json({ success: true, message: `ServiceConfiguration credential issued to ${name}`, data });
  } catch (error) {
    console.error('[AUTO-ISSUE] Issuance failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/company/connections/:connectionId/request-rp-proof
 * Sends a RealPersonIdentity proof request to the employee wallet.
 * Returns { success, presentationId }.
 */
app.post('/api/company/connections/:connectionId/request-rp-proof', requireCompany, async (req, res) => {
  const { connectionId } = req.params;
  try {
    // This endpoint and the auto-proof setInterval loop both key off connectionId into the same
    // global.pendingInvitations map. Without a lock, this call could overwrite the auto-proof
    // loop's in-flight proofChallenge/presentationId for the same connection (or vice versa) —
    // a real race flagged by security review. 'manual-pending' is a state name the auto-loop's
    // own state machine never checks for (only `!proofState` or `proofState === 'requested'`),
    // so setting it here — synchronously, before any await — makes the auto-loop skip this
    // connectionId entirely until this flow releases it, the same way the auto-loop's own
    // 'sending'/'issuing' locks protect it from concurrent ticks.
    const stored = global.pendingInvitations.get(connectionId) || { companyId: req.company.id };
    if (stored.proofState && stored.proofState !== 'failed' && stored.proofState !== 'manual-failed') {
      return res.status(409).json({
        success: false,
        error: 'ProofFlowAlreadyActive',
        message: `This connection's proof flow is already active (state: ${stored.proofState}). Check rp-proof-status instead of requesting a new proof.`
      });
    }
    stored.proofState = 'manual-pending';
    global.pendingInvitations.set(connectionId, stored);

    // Stored (not just generated inline) so /rp-proof-status below can check the presentation's
    // own nonce claim against it — see verifyAndExtractRealPersonClaims. Domain is per-company
    // for the same reason as the auto-proof loop's equivalent request.
    const challenge = crypto.randomBytes(32).toString('hex');
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/present-proof/presentations',
      {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          proofs: [],
          options: {
            challenge,
            domain: `realperson.${req.company.id}.identuslabel.cz`
          },
          goalCode: 'present-vp',
          goal: 'Share your RealPersonIdentity credential for employee onboarding',
          credentialFormat: 'JWT'
        })
      }
    );
    const presentationId = result.data.presentationId || result.data.thid || result.data.id;
    if (!presentationId) throw new Error('No presentationId in response: ' + JSON.stringify(result.data));

    stored.proofChallenge = challenge;
    stored.presentationId = presentationId;
    global.pendingInvitations.set(connectionId, stored);

    console.log(`[RP-PROOF] Proof request sent to connection ${connectionId}, presentationId: ${presentationId}`);
    res.json({ success: true, presentationId });
  } catch (err) {
    console.error('[RP-PROOF] Failed to send proof request:', err);
    // Release the lock so a retry is possible — only if it's still ours and never progressed.
    const stored = global.pendingInvitations.get(connectionId);
    if (stored && stored.proofState === 'manual-pending' && !stored.presentationId) {
      stored.proofState = 'manual-failed';
      global.pendingInvitations.set(connectionId, stored);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/company/connections/:connectionId/rp-proof-status/:presentationId
 * Polls the cloud agent for proof status.
 * On PresentationVerified: extracts RealPerson claims, generates email, issues ServiceConfig VC.
 * Returns { status: 'pending'|'complete'|'failed', name?, email?, error? }
 */
app.get('/api/company/connections/:connectionId/rp-proof-status/:presentationId', requireCompany, async (req, res) => {
  const { connectionId, presentationId } = req.params;
  try {
    const result = await cloudAgentRequest(
      req.company.apiKey,
      `/present-proof/presentations/${presentationId}`
    );
    const pres = result.data;
    const state = pres.status;

    console.log(`[RP-PROOF] Status poll for ${presentationId}: ${state}`);

    if (state === 'PresentationVerified' || state === 'PresentationReceived') {
      // Looked up before verification so the presentation's nonce can be checked against the
      // challenge this specific request-rp-proof call generated (replay protection).
      const stored = global.pendingInvitations.get(connectionId) || { companyId: req.company.id };

      // Extract JWT VP from response — cryptographically verified (signature + trust registry +
      // holder binding + nonce), not just decoded. See verifyAndExtractRealPersonClaims.
      const vpJwt = Array.isArray(pres.data) ? pres.data[0] : (pres.data || pres.presentation || null);
      const claims = await verifyAndExtractRealPersonClaims(vpJwt, stored.proofChallenge);

      const fullName = [claims.firstName, claims.lastName].filter(Boolean).join(' ');
      const existingEmails = getExistingEmailsForCompany(req.company.id);
      const email = generateEmployeeEmail(fullName || 'employee', req.company.id, existingEmails);

      // Update pendingInvitations with real identity data
      const portalBaseUrl = process.env.COMPANY_PORTAL_BASE_URL || 'https://identuslabel.cz/company-admin';
      stored.name = fullName;
      stored.email = email;
      stored.uniqueId = claims.uniqueId;
      stored.photo = claims.photo;
      stored.portalUrl = `${portalBaseUrl}/employee-portal-login.html?email=${encodeURIComponent(email)}`;
      global.pendingInvitations.set(connectionId, stored);

      // Persist uniqueId/photo/credentialStatus into DB metadata so they survive beyond pendingInvitations lifetime
      if (claims.uniqueId || claims.photo) {
        try {
          const empDb = getEnterpriseDb();
          const updated = await empDb.updateEmployeeRealPersonData(email, claims.uniqueId, claims.photo, claims.credentialStatus);
          if (updated) {
            console.log(`[RP-PROOF] Persisted caUniqueId=${claims.uniqueId} for ${email}`);
          } else {
            console.log(`[RP-PROOF] Employee ${email} not yet in DB — RealPerson data stored in pendingInvitations only`);
          }
        } catch (dbErr) {
          console.warn(`[RP-PROOF] Could not persist RealPerson data to DB: ${dbErr.message}`);
        }
      }

      // Issue ServiceConfiguration VC
      await issueServiceConfigVC(connectionId, fullName, email, stored.department || '', req.company);

      return res.json({ status: 'complete', name: fullName, email });
    }

    if (['ProblemReported', 'RequestRejected', 'PresentationRejected'].includes(state)) {
      return res.json({ status: 'failed', error: `Presentation ${state}` });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[RP-PROOF] Status poll error:', err);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

/**
 * GET /api/company/employee-keys - List employee API keys for company
 */
app.get('/api/company/employee-keys', requireCompany, async (req, res) => {
  try {
    const { department } = req.query;

    if (!department) {
      return res.status(400).json({
        success: false,
        error: 'Department query parameter is required'
      });
    }

    // Validate department
    if (!['HR', 'IT', 'Security'].includes(department)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid department. Must be one of: HR, IT, Security'
      });
    }

    // Get API keys for department
    const keys = await EmployeeApiKeyManager.getDepartmentApiKeys(department);

    res.json({
      success: true,
      department,
      keys,
      totalCount: keys.length
    });
  } catch (error) {
    console.error('[EMPLOYEE-KEY] List failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/employee-keys/:keyId/revoke - Revoke employee API key
 */
app.post('/api/company/employee-keys/:keyId/revoke', requireCompany, async (req, res) => {
  try {
    const { keyId } = req.params;
    const { reason } = req.body;

    const revoked = await EmployeeApiKeyManager.revokeApiKey(
      keyId,
      reason || 'Revoked by administrator'
    );

    if (!revoked) {
      return res.status(404).json({
        success: false,
        error: 'API key not found or already revoked'
      });
    }

    console.log(`[EMPLOYEE-KEY] Revoked API key ${keyId}`);

    res.json({
      success: true,
      message: 'API key revoked successfully',
      keyId
    });
  } catch (error) {
    console.error('[EMPLOYEE-KEY] Revoke failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/employee-keys/:keyId/rotate - Rotate employee API key
 */
app.post('/api/company/employee-keys/:keyId/rotate', requireCompany, async (req, res) => {
  try {
    const { keyId } = req.params;
    const { expiryDays } = req.body;

    const newKeyData = await EmployeeApiKeyManager.rotateApiKey(
      keyId,
      expiryDays || 365
    );

    console.log(`[EMPLOYEE-KEY] Rotated API key ${keyId} → ${newKeyData.keyId}`);

    res.json({
      success: true,
      message: 'API key rotated successfully',
      oldKeyId: keyId,
      newKey: {
        keyId: newKeyData.keyId,
        apiKey: newKeyData.apiKey, // Only shown once!
        expiresAt: newKeyData.expiresAt,
        scope: newKeyData.scope,
        warning: 'This API key will only be displayed once. Store it securely.'
      }
    });
  } catch (error) {
    console.error('[EMPLOYEE-KEY] Rotate failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/employee-keys/validate - Validate employee API key
 * (For testing/debugging only - should NOT be exposed in production)
 */
app.post('/api/company/employee-keys/validate', requireCompany, async (req, res) => {
  try {
    const { apiKey, connectionId } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'API key is required'
      });
    }

    const employeeData = await EmployeeApiKeyManager.validateApiKey(apiKey, connectionId);

    if (!employeeData) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired API key'
      });
    }

    res.json({
      success: true,
      message: 'API key is valid',
      employee: employeeData
    });
  } catch (error) {
    console.error('[EMPLOYEE-KEY] Validation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/create-employee-wallet - Create individual employee wallet with PRISM DID
 * Request body: { email, name, department }
 * Response: { walletId, entityId, apiKey, prismDid }
 *
 * Note: This endpoint creates employee wallets on the Employee Cloud Agent (port 8300).
 * It replaces the department wallet model with individual employee wallets.
 */
app.post('/api/admin/create-employee-wallet', async (req, res) => {
  try {
    const { email, name, department } = req.body;

    // Validate required fields
    if (!email || !name || !department) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, name, department'
      });
    }

    // Validate department
    if (!['HR', 'IT', 'Security'].includes(department)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid department. Must be: HR, IT, or Security'
      });
    }

    console.log(`\n🏗️  [CREATE-EMPLOYEE-WALLET] Creating wallet for: ${name} (${email})`);

    // Create employee wallet on Employee Cloud Agent
    const employeeWallet = await EmployeeWalletManager.createEmployeeWallet({
      email,
      name,
      department
    });

    console.log(`✅ [CREATE-EMPLOYEE-WALLET] Wallet created successfully!`);
    console.log(`   Wallet ID: ${employeeWallet.walletId}`);
    console.log(`   PRISM DID: ${employeeWallet.prismDid.substring(0, 50)}...`);
    SlackNotifier.notifyWalletCreated(employeeWallet);

    // Automatically create a personal wallet OOB invitation and deliver it to the employee's
    // enterprise wallet via BasicMessage. The auto-proof loop picks up the pending connection
    // and requests the RealPerson proof once the employee accepts the invitation.
    // This eliminates the manual "Request RealPerson Proof" step entirely.
    try {
      const company = req.company || getAllCompanies().find(c => c.id === 'techcorp');
      if (company && employeeWallet.techCorpConnectionId) {
        const invResp = await cloudAgentRequest(company.apiKey, '/connections', {
          method: 'POST',
          body: JSON.stringify({
            label: `Personal Wallet - ${name} (${email})`,
            goal: 'Connect personal IDL Wallet for identity verification'
          })
        });
        if (invResp.success && invResp.data?.connectionId) {
          const personalConnId = invResp.data.connectionId;
          const rawUrl = invResp.data.invitation?.invitationUrl
            || invResp.data.invitation?.invitation?.invitationUrl
            || null;

          // Rewrite the cloud-agent placeholder domain to the actual wallet URL so the
          // employee can tap the link and have their IDL Wallet handle the _oob param.
          let invitationUrl = rawUrl;
          if (rawUrl) {
            const oobMatch = rawUrl.match(/[?&]_oob=([^&]+)/);
            if (oobMatch) {
              invitationUrl = `https://identuslabel.cz/wallet?_oob=${oobMatch[1]}`;
            }
          }

          // Register in pendingInvitations with known email so the proof loop
          // doesn't regenerate a conflicting email when the proof is verified.
          global.pendingInvitations.set(personalConnId, {
            companyId: company.id,
            email,
            name,
            department
          });

          // Deliver the OOB link to the employee's enterprise wallet via BasicMessage.
          // The employee sees it in their IDL Wallet and taps the link to connect.
          if (invitationUrl) {
            await cloudAgentRequest(company.apiKey, `/connections/${employeeWallet.techCorpConnectionId}/basic-messages`, {
              method: 'POST',
              body: JSON.stringify({
                content: `🔗 To complete your profile setup, please connect your personal IDL Wallet by opening this link:\n${invitationUrl}`
              })
            });
            console.log(`[CREATE-EMPLOYEE-WALLET] Personal wallet invitation delivered via BasicMessage (pendingConn: ${personalConnId.substring(0,8)}...)`);
          }
        }
      }
    } catch (personalInvErr) {
      // Non-fatal — enterprise onboarding succeeded; personal wallet link can be requested manually
      console.warn(`[CREATE-EMPLOYEE-WALLET] Personal wallet auto-invite failed (non-fatal): ${personalInvErr.message}`);
    }

    // Return wallet details (API key visible only once!)
    res.json({
      success: true,
      message: `Employee wallet created for ${name}`,
      wallet: {
        email: employeeWallet.email,
        name: employeeWallet.name,
        department: employeeWallet.department,
        walletId: employeeWallet.walletId,
        entityId: employeeWallet.entityId,
        apiKey: employeeWallet.apiKey, // CRITICAL: Save this! Only visible once
        prismDid: employeeWallet.prismDid,
        created: employeeWallet.created
      }
    });

  } catch (error) {
    console.error('[CREATE-EMPLOYEE-WALLET] Failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack
    });
  }
});

/**
 * GET /api/admin/list-employee-wallets - List all employee wallets
 */
app.get('/api/admin/list-employee-wallets', async (req, res) => {
  try {
    const wallets = await EmployeeWalletManager.listEmployeeWallets();

    res.json({
      success: true,
      count: wallets.length,
      wallets: wallets
    });

  } catch (error) {
    console.error('[LIST-EMPLOYEE-WALLETS] Failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/connect-doc-service - Connect existing employee(s) enterprise wallet to Document Service
 * Body: { email } for single employee, or { all: true } for all active employees
 */
app.post('/api/admin/connect-doc-service', async (req, res) => {
  try {
    const { email, all } = req.body || {};

    const db = getEnterpriseDb();

    if (all) {
      const employees = await db.getAllActiveEmployees?.() ?? [];
      const results = [];
      for (const emp of employees) {
        try {
          const empFull = await db.getEmployeeByEmail(emp.email);
          if (!empFull?.entity_id) {
            results.push({ email: emp.email, status: 'skipped', reason: 'no entity_id' });
            continue;
          }
          const connectionId = await EmployeeWalletManager.connectExistingEmployeeToDocService(empFull.entity_id);
          results.push({ email: emp.email, status: 'ok', connectionId });
        } catch (e) {
          results.push({ email: emp.email, status: 'error', error: e.message });
        }
      }
      return res.json({ success: true, results });
    }

    if (!email) return res.status(400).json({ success: false, error: 'email or all:true required' });
    const emp = await db.getEmployeeByEmail(email);
    if (!emp?.entity_id) return res.status(404).json({ success: false, error: 'Employee not found or missing entity_id' });
    const connectionId = await EmployeeWalletManager.connectExistingEmployeeToDocService(emp.entity_id);
    res.json({ success: true, email, connectionId });
  } catch (error) {
    console.error('[CONNECT-DOC-SERVICE] Failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/company/connections/:connectionId/auto-issue-config - Auto-issue ServiceConfiguration VC
 * Request body: { email, name, department }
 */
app.post('/api/company/connections/:connectionId/auto-issue-config', requireCompany, async (req, res) => {
  try {
    const { connectionId } = req.params;
    const { email, name, department } = req.body;

    if (!email || !name || !department) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, name, department'
      });
    }

    // Get connection state from multitenancy Cloud Agent
    const connectionResult = await cloudAgentRequest(
      req.company.apiKey,
      `/connections/${connectionId}`
    );

    const connection = connectionResult.data;

    // Use ConnectionEventHandler to process and issue config
    const result = await ConnectionEventHandler.handleConnectionEstablished({
      connectionId,
      email,
      name,
      department,
      state: connection.state,
      cloudAgentUrl: MULTITENANCY_CLOUD_AGENT_URL,
      companyApiKey: req.company.apiKey,
      issuerDID: req.company.did
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.message,
        reason: result.reason,
        details: result.keyData
      });
    }

    res.json({
      success: true,
      message: result.message,
      data: result.data
    });

  } catch (error) {
    console.error('[AUTO-ISSUE-CONFIG] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/company/process-pending-connections - Process all pending connections for a department
 * Request body: { department }
 */
app.post('/api/company/process-pending-connections', requireCompany, async (req, res) => {
  try {
    const { department } = req.body;

    if (!department) {
      return res.status(400).json({
        success: false,
        error: 'Department is required'
      });
    }

    // Validate department
    if (!['HR', 'IT', 'Security'].includes(department)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid department. Must be one of: HR, IT, Security'
      });
    }

    // Get all connections from multitenancy Cloud Agent
    const connectionsResult = await cloudAgentRequest(
      req.company.apiKey,
      '/connections'
    );

    const allConnections = connectionsResult.data.contents || [];

    // Filter for employee connections (exclude CA connections)
    const softDeleted = global.softDeletedConnections.get(req.company.id) || new Set();
    const employeeConnections = allConnections.filter(conn => {
      const label = (conn.label || '').toLowerCase();
      const theirLabel = (conn.theirLabel || '').toLowerCase();

      // Exclude soft-deleted connections
      if (softDeleted.has(conn.connectionId)) {
        return false;
      }

      // Exclude CA-related connections
      if (label.includes('ca ') || label.includes(' ca') ||
          label.includes('certification') || label.includes('authority') ||
          theirLabel.includes('certification') || theirLabel.includes('authority')) {
        return false;
      }

      return true;
    });

    console.log(`[PROCESS-PENDING] Found ${employeeConnections.length} employee connections`);

    // Process connections using ConnectionEventHandler
    const results = await ConnectionEventHandler.processPendingConnections(
      department,
      employeeConnections,
      MULTITENANCY_CLOUD_AGENT_URL,
      req.company.apiKey,
      req.company.did
    );

    res.json({
      success: true,
      message: `Processed ${results.processed} connections`,
      summary: {
        processed: results.processed,
        issued: results.issued,
        skipped: results.skipped,
        errors: results.errors
      },
      details: results.details
    });

  } catch (error) {
    console.error('[PROCESS-PENDING] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// Employee Portal Authentication Endpoints
// ============================================================================

// In-memory session stores (replace with Redis in production)
const employeeSessions = new Map();
const pendingEmployeeAuths = new Map();

// ── DIDComm Access Request Protocol ──────────────────────────────────────────
// Mirrors the CA's DIDComm access request flow for TechCorp and ACME dashboards.
// Each company has its own DIDCommCommandService instance polling its Cloud Agent wallet.

const COMPANY_PUBLIC_BASE_URL = process.env.COMPANY_PORTAL_BASE_URL || 'https://identuslabel.cz/company-admin';
// Must match the schema EmployeeRole VCs are actually issued against — see
// EmployeeWalletManager.js's own EMPLOYEE_ROLE_SCHEMA_GUID (v1.4.0) and .schema-cache.json's
// employeeRoleSchemaGuid. This was previously a stale v1.1.0 GUID that no longer matched any
// issued credential, causing every employee-portal login to fail with the Cloud Agent's
// PresentationVerificationFailed status (schema mismatch) — the wallet always presented a real,
// validly-signed EmployeeRole VC, it just didn't match what was being requested.
const EMPLOYEE_ROLE_SCHEMA_ID = '028358d2-1f3b-37cc-ad1c-b8ca48d1e6c3';

function makeEmployeePortalProofSpec(companyLabel, issuerDid) {
  return {
    // Empty, not a schemaId/trustIssuers constraint — the wallet is *supposed* to bundle a
    // second credential (CISTraining, when the employee has it) into this same VP, so the
    // server's ClaimExtractor can read every presented VC and route dashboard-vs-training in
    // one shot (see this file's employee-portal-login docs). A non-empty `proofs` entry here
    // previously named exactly one schema (EmployeeRole) — querying this multitenancy Cloud
    // Agent's own presentation history directly (91.99.4.54:8200) showed every single
    // 'employee-portal.techcorp.com' presentation bundling 2 credentials had failed
    // (PresentationVerificationFailed, 9/9), while single-credential presentations against the
    // same domain succeeded (249/252 historically) and other domains bundling 2-5 credentials
    // with an empty `proofs` succeeded in the hundreds — i.e. the Cloud Agent's own verifier
    // rejects a multi-credential VP when a single-schema proof constraint is attached, even
    // though it has no trouble with multi-credential VPs in general. That constraint bought no
    // real security anyway: `_onProofVerified` (ServiceAccessService.js) already does its own
    // independent, fail-closed trustedIssuerVcType/trustRegistry check on the extracted
    // EmployeeRole credential regardless of what's sent here — this is explicitly "defense in
    // depth, not a replacement" per that function's own comment. issuerDid is kept as a
    // parameter (unused here now) since callers still pass it for that independent check via
    // the capability's trustedIssuerVcType/trustRegistry, not through this proofSpec.
    proofs: [],
    goalCode: 'schema:EmployeeRole',
    goal: `Please present your Employee Role credential for ${companyLabel} access`,
    // Per the Cloud Agent's OpenAPI spec, `claims` (not proofs[].schemaId alone) is what
    // populates presentation_definition's input_descriptors with actual field constraints.
    claims: { email: {}, prismDid: {}, role: {}, department: {} },
    // Wallet-side schema hint: the Cloud Agent does not forward goalCode/goal/claims into
    // the actual DIDComm wire message for JWT-format requests (verified live against this
    // same Cloud Agent — presentation_definition arrives with empty input_descriptors), so
    // options.domain is the one field confirmed to survive and doubles as the schema signal.
    //
    // SECURITY/CORRECTNESS NOTE: this value isn't cosmetic — it's checked by the Cloud Agent
    // itself as part of presentation verification. Querying this multitenancy Cloud Agent's own
    // presentation history directly (91.99.4.54:8200) shows domain 'employee-portal.techcorp.com'
    // has succeeded 249/252 times ever recorded, while a prior, uncommitted (never verified
    // working) change to a single shared 'employeerole.identuslabel.cz' domain for both
    // companies had failed 6/6 times — 100% failure, 0 historical successes. Restored the
    // per-company convention this codebase already uses elsewhere (see e.g.
    // 'resource-authorization.techcorp.com' at this file's enterprise-resource-auth flow).
    domain: `employee-portal.${companyLabel.toLowerCase()}.com`
  };
}

async function resolveConnectionByDID(agentUrl, apiKey, fromDid) {
  try {
    const resp = await fetch(`${agentUrl}/connections?limit=200`, {
      headers: { 'apikey': apiKey }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const match = (data.contents || []).find(c => c.theirDid === fromDid || c.myDid === fromDid);
    return match ? match.connectionId : null;
  } catch (e) {
    console.error(`[DIDCommAccess] resolveConnectionByDID error: ${e.message}`);
    return null;
  }
}

// Migrated from the standalone lib/DIDCommCommandService.js (a hand-forked copy of
// certification-authority's own copy) onto the shared service-access-didcomm package — see
// packages/service-access-didcomm/PROTOCOL.md. Unlike the CA (which is self-trusting against
// its own rotating issuing DIDs), each company's EmployeeRole issuer DID is a fixed, already-known
// config value (COMPANIES.*.did), so the trust registry here is a simple static table.
//
// SECURITY IMPROVEMENTS vs. the prior fork: (1) the old _extractClaims silently dropped the
// RealPerson fallback branch that certification-authority's copy had — the shared ClaimExtractor's
// one rule table restores it; (2) real ES256K signature verification + a fail-closed trust
// registry check are now performed post-hoc, not just relied on via Cloud Agent's internal state.
// Config-driven registry: builds one ServiceAccessService (+ shared trust registry entry) per
// company returned by getAllCompanies(), instead of hand-wiring each tenant at this call site.
// Adding (or fixing, as with evilcorp — defined in lib/companies.js but previously never wired
// up here, so its employee-portal login silently did nothing) a tenant is now a lib/companies.js
// -only change. See lib/companyPortalRegistry.js for the full rationale.
const { buildCompanyPortalRegistry } = require('./lib/companyPortalRegistry');

const companyPortalRegistry = buildCompanyPortalRegistry({
  companies: getAllCompanies(),
  cloudAgentUrl: MULTITENANCY_CLOUD_AGENT_URL,
  publicBaseUrl: COMPANY_PUBLIC_BASE_URL,
  resolveConnectionByDID,
  createIssuerResolver,
  makeEmployeePortalProofSpec,
  ServiceAccessService,
  createTrustRegistry,
  accessPath: '/api/access',
  tokenTTLMs: 5 * 60 * 1000,
  redirectPath: '/company-admin/employee-portal-dashboard.html',
});

// ── Prover-side auto-responder: answer inbound present-proof requests for each company's own
// CompanyIdentity credential ────────────────────────────────────────────────────────────────
//
// This is company-admin-portal's half of the wallet-side live challenge/response added
// alongside liveIdentityVerification.ts's RealPerson/SecurityClearance flow: once a wallet has
// connected to a company (e.g. via the OOB invitation that embeds a one-time PREVIEW of
// CompanyIdentity, until now trusted only via TOFU DID-pinning), it can send a fresh
// present-proof/3.0/request-presentation over the established connection and expect a
// live-signed presentation back — cryptographic proof, not just a cached/pinned claim. The Cloud
// Agent surfaces such an inbound request as a present-proof record with role="Prover",
// status="RequestReceived" — the opposite role from techcorpDIDComm/acmeDIDComm above, which only
// ever act as Verifier (requester) for EmployeeRole presentations. No generic inbound
// present-proof poller existed for this role before; this is it.
//
// Multi-tenant: each company has its own wallet/apiKey on the multitenancy Cloud Agent, so this
// polls and resolves per-company rather than globally (see resolveCompanyIdentityRecord /
// pollInboundProofRequests below, which iterate Object.values(COMPANIES)).
//
// Auto-accept, no human review: CompanyIdentity is each company's own public organizational
// identity, meant to be shown to anyone who asks — unlike techcorpDIDComm/acmeDIDComm's Verifier
// flows above (which gate access to holder-specific employee data behind an explicit wallet
// approval), there's nothing sensitive here for a human to gate. The one defense worth having is
// against a confused-deputy-style request that explicitly constrains by a schema that is clearly
// NOT the company's identity credential — see the schema check in _respondToInboundProofRequest.

const PROVER_RESPONDER_POLL_MS = 10 * 1000;
// `${companyId}:${presentationId}` currently being handled — guards against a slow prior poll
// tick still running when the next interval fires.
const _proverResponderInFlight = new Set();
// companyId -> { recordId, schemaId } once resolved live, so we don't re-resolve every 10s tick.
const _cachedCompanyIdentity = new Map();

/** Best-effort extraction of a decoded credential JWT's `vc.credentialSchema.id`, or null. */
function _decodedCredentialSchemaId(record) {
  try {
    const jwtString = Buffer.from(record.credential, 'base64').toString('utf-8');
    const decoded = jwt.decode(jwtString, { complete: true });
    return decoded?.payload?.vc?.credentialSchema?.id || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a live (still CredentialReceived/CredentialSent) issue-credentials recordId for
 * `company`'s own CompanyIdentity credential, plus its schemaId (used by the confused-deputy
 * check below). Live lookup every time the cache is stale, not from a static file — reuses the
 * exact same filter this codebase already relies on when embedding CompanyIdentity into employee
 * OOB invitations (server.js's employee-invitation handler, ~line 1097-1128), rather than
 * re-deriving the logic.
 */
async function resolveCompanyIdentityRecord(company) {
  const cached = _cachedCompanyIdentity.get(company.id);
  if (cached) {
    try {
      const r = await cloudAgentRequest(company.apiKey, `/issue-credentials/records/${cached.recordId}`);
      if (r.data.protocolState === 'CredentialReceived' || r.data.protocolState === 'CredentialSent') {
        return cached;
      }
    } catch (_) { /* fall through to re-resolve */ }
    console.warn(`[ProverResponder] Cached CompanyIdentity recordId for ${company.displayName} is no longer live — re-resolving`);
    _cachedCompanyIdentity.delete(company.id);
  }

  try {
    const credentialsResult = await cloudAgentRequest(company.apiKey, '/issue-credentials/records?limit=200');
    const allRecords = credentialsResult.data.contents || [];
    for (const r of allRecords) {
      const isIssued = r.protocolState === 'CredentialReceived' || r.protocolState === 'CredentialSent';
      if (!isIssued) continue;
      let decoded;
      try { decoded = decodeCredential(r); } catch (_) { continue; }
      if (decoded && decoded.credentialType === 'CompanyIdentity') {
        const entry = { recordId: r.recordId, schemaId: _decodedCredentialSchemaId(r) };
        _cachedCompanyIdentity.set(company.id, entry);
        console.log(`[ProverResponder] Live search found CompanyIdentity record for ${company.displayName}: ${r.recordId}`);
        return entry;
      }
    }
  } catch (e) {
    console.error(`[ProverResponder] Live search for ${company.displayName}'s CompanyIdentity record failed:`, e.message);
  }

  return null;
}

/**
 * Accept a single inbound present-proof request (role=Prover, status=RequestReceived) using
 * `company`'s own CompanyIdentity credential. Never throws — all failures are logged and
 * swallowed so one bad record (or one company) can't crash the poll loop or block any other
 * request-handling code path.
 */
async function _respondToInboundProofRequest(company, presentationId) {
  const key = `${company.id}:${presentationId}`;
  if (_proverResponderInFlight.has(key)) return;
  _proverResponderInFlight.add(key);
  try {
    // Re-fetch the record fresh — the list-poll summary could be stale by the time we get here,
    // and we need the full `proofs` constraint for the confused-deputy check below.
    const record = (await cloudAgentRequest(company.apiKey, `/present-proof/presentations/${presentationId}`)).data;
    if (record.role !== 'Prover' || record.status !== 'RequestReceived') {
      return; // already handled (by an earlier tick) or moved on for some other reason
    }

    const identity = await resolveCompanyIdentityRecord(company);
    if (!identity) {
      console.error(`[ProverResponder] No live CompanyIdentity credential for ${company.displayName} — cannot respond to ${presentationId}`);
      return;
    }

    // Confused-deputy defense: if the request explicitly constrains by a schemaId that is NOT
    // this company's identity credential's schema, this responder has no business auto-
    // satisfying it — skip rather than attach the wrong credential. An empty/absent proofs
    // constraint (the common case for a "prove who you are" request, matching the schema-less
    // present-proof idiom already used elsewhere in this file, e.g. employee login) is treated
    // as "no constraint" and accepted. Deliberately fail CLOSED (skip) rather than accept when
    // identity.schemaId itself couldn't be resolved — previously `identity.schemaId &&` guarded
    // the whole comparison, so an explicitly-scoped request for an unrelated schema would still
    // get answered with this company's identity credential whenever the schemaId lookup failed.
    const requestedSchemaIds = (record.proofs || []).map(p => p.schemaId).filter(Boolean);
    if (requestedSchemaIds.length > 0 &&
        !requestedSchemaIds.includes(identity.schemaId)) {
      console.log(`[ProverResponder] Skipping ${presentationId} (${company.displayName}) — requested schema(s) [${requestedSchemaIds.join(', ')}] don't match CompanyIdentity schema (${identity.schemaId})`);
      return;
    }

    await cloudAgentRequest(company.apiKey, `/present-proof/presentations/${presentationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'request-accept', proofId: [identity.recordId] })
    });
    console.log(`[ProverResponder] ✅ Accepted inbound present-proof request ${presentationId} for ${company.displayName} using CompanyIdentity record ${identity.recordId}`);
  } catch (e) {
    console.error(`[ProverResponder] Error handling ${presentationId} (${company.displayName}):`, e.message);
  } finally {
    _proverResponderInFlight.delete(key);
  }
}

/**
 * Poll every configured company for inbound present-proof requests where that company is being
 * asked to prove (role=Prover) and hasn't yet responded (status=RequestReceived). Runs
 * per-company sequentially (small, fixed company count — not worth parallelizing). Never throws
 * — errors are logged per-company so one company's outage doesn't stop the others or kill the
 * interval.
 */
async function pollInboundProofRequests() {
  for (const company of Object.values(COMPANIES)) {
    try {
      // No pagination loop: the Cloud Agent's /present-proof/presentations endpoint ignores
      // both `limit` and `offset` and always returns the full collection for the wallet in one
      // response (confirmed: limit=2 still returned all 513 records). The old `while(true) { ...;
      // if (page.length < pageSize) break; }` loop could therefore never observe page.length <
      // pageSize once the wallet held more than `pageSize` records, so it never terminated —
      // spinning forever, re-fetching and re-decoding the entire history on every iteration, for
      // every tick of this 10s interval. That was the dominant source of this process's CPU/GC
      // load, not the polling interval itself.
      const result = await cloudAgentRequest(company.apiKey, `/present-proof/presentations`);
      const page = result.data.contents || [];
      for (const rec of page) {
        if (rec.role === 'Prover' && rec.status === 'RequestReceived') {
          const id = rec.presentationId || rec.id;
          if (id) {
            _respondToInboundProofRequest(company, id).catch(e =>
              console.error('[ProverResponder] Unhandled error:', e.message));
          }
        }
      }
    } catch (e) {
      console.error(`[ProverResponder] Poll error for ${company.displayName}:`, e.message);
    }
  }
}

pollInboundProofRequests();
setInterval(pollInboundProofRequests, PROVER_RESPONDER_POLL_MS).unref();

// Employee authentication configuration - uses Multitenancy Cloud Agent (port 8200)
// This connects to TechCorp's tenant wallet for employee authentication via DIDComm
const TECHCORP_CLOUD_AGENT_URL = process.env.TECHCORP_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const TECHCORP_API_KEY = process.env.TECHCORP_API_KEY || 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const TECHCORP_DID = COMPANIES.techcorp.did; // Used for issuer validation

/// Accept all company DIDs plus legacy backwards-compat DID
const ACCEPTED_ISSUER_DIDS = [
  COMPANIES.techcorp.did,
  COMPANIES.acme.did,
  COMPANIES.evilcorp.did,
  'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c' // Main Cloud Agent (backwards compatibility)
];

// Employee Role schema GUID (v1.1.0 with email field for authentication)
const EMPLOYEE_ROLE_SCHEMA_GUID = process.env.EMPLOYEE_ROLE_SCHEMA_GUID ||
  '6c39cc8e-b292-30aa-bbef-98ca2fdc6abe';

// Compare PRISM DIDs tolerating long-form vs short-form differences.
// Short-form: did:prism:<hash>
// Long-form:  did:prism:<hash>:<base64-key-material>
// One of the two may be short-form; match if the hash segments are equal.
function prismDidsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const hashOf = did => did.startsWith('did:prism:') ? did.split(':')[2] : null;
  const ha = hashOf(a), hb = hashOf(b);
  return ha && hb && ha === hb;
}

// ── RealPersonIdentity presentation verification (auto-proof onboarding gate) ────────────────
//
// Previously, this codebase's `extractRealPersonClaims` did nothing but decode the presented
// VP — no signature check, no issuer trust check, no holder-binding check, no nonce check.
// It relied entirely on the Cloud Agent's own internal `PresentationVerified` status, which this
// project's own investigation (see the service-access/1.0 migration and its
// PresentationVerificationFailed diagnosis) already found to be an unreliable sole source of
// truth. This is a fail-closed, independently-verified replacement, reusing the same
// cryptographic primitives the service-access/1.0 protocol already relies on elsewhere.
//
// The Certification Authority is the sole trusted issuer of RealPersonIdentity — the
// "Main Cloud Agent (backwards compatibility)" entry in ACCEPTED_ISSUER_DIDS.
const realPersonTrustRegistry = createTrustRegistry(
  ACCEPTED_ISSUER_DIDS
    .filter(did => did === 'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c')
    .map(did => ({ did, vcTypes: ['RealPersonIdentity'] }))
);
const realPersonIssuerResolver = createIssuerResolver({ cloudAgentUrl: ENTERPRISE_CLOUD_AGENT_URL });

/**
 * Verify a presented RealPersonIdentity VP before trusting any of its claims:
 *   1. Inner VC-JWT signature verified against the issuer's own resolved DID.
 *   2. Issuer must be the Certification Authority's own known DID (fail-closed trust registry —
 *      an unconfigured/unrecognized issuer is rejected, not silently trusted).
 *   3. Outer VP-JWT signature verified against the presenter's own DID, using their
 *      `authentication` key (holder binding / DID-Auth) — proves whoever is presenting actually
 *      controls the corresponding private key, not just relaying a copy of someone else's VC.
 *   4. The outer VP-JWT's holder DID must match the inner VC's own subject — proves the
 *      presenter IS the credential's subject.
 *   5. The outer VP-JWT's nonce must match the exact challenge issued for *this* presentation
 *      request — rejects replay of a presentation captured for a different request/company.
 *
 * Throws with a descriptive message on any failure; the auto-proof loop's existing catch block
 * already treats a thrown error during the 'issuing' state as a terminal 'failed' (no retry).
 */
async function verifyAndExtractRealPersonClaims(vpJwt, expectedChallenge) {
  if (!vpJwt || typeof vpJwt !== 'string') throw new Error('No JWT VP provided');

  const outerDecoded = decodeJWT(vpJwt);
  if (!outerDecoded) throw new Error('Malformed outer VP JWT');

  const holderDID = outerDecoded.payload.iss;
  if (!holderDID) throw new Error('Outer VP JWT missing iss (holder DID)');
  // Explicit, not accidental: prismDidsMatch happens to reject non-"did:prism:" DIDs today (its
  // hashOf() returns null for any other prefix), which was the only thing stopping a VC whose
  // credentialSubject.id is a non-PRISM DID from passing holder binding. Pinning it here means
  // the constraint survives even if prismDidsMatch is ever generalized to other DID methods.
  if (!holderDID.startsWith('did:prism:')) throw new Error('Holder DID must be a PRISM DID');

  if (expectedChallenge && outerDecoded.payload.nonce !== expectedChallenge) {
    throw new Error('Presentation nonce does not match the challenge issued for this request (possible replay)');
  }

  const holderSigValid = await verifyES256KSignature(outerDecoded, holderDID, realPersonIssuerResolver, 'authentication');
  if (!holderSigValid) throw new Error('Outer VP JWT signature verification failed (holder binding)');

  const vp = { verifiableCredential: outerDecoded.payload?.vp?.verifiableCredential || [] };
  const vpResult = await verifyPresentationCredentials(vp, realPersonIssuerResolver);
  if (!vpResult.success) throw new Error(`RealPersonIdentity VC verification failed: ${vpResult.error} — ${vpResult.message}`);

  const realPersonCred = vpResult.credentials.find(c => c.claims?.credentialType === 'RealPersonIdentity');
  if (!realPersonCred) throw new Error('RealPersonIdentity credential not found in presented VP');

  if (!realPersonTrustRegistry.isTrustedIssuer(realPersonCred.issuerDID, 'RealPersonIdentity')) {
    throw new Error(`Untrusted RealPersonIdentity issuer: ${realPersonCred.issuerDID}`);
  }

  const subjectDID = realPersonCred.subjectDID || realPersonCred.claims?.id;
  if (!prismDidsMatch(subjectDID, holderDID)) {
    throw new Error('Holder binding failed: presenter DID does not match the credential subject');
  }

  const cs = realPersonCred.claims;
  return {
    firstName: cs.firstName || null,
    lastName: cs.lastName || null,
    uniqueId: cs.uniqueId || null,
    photo: cs.photo || null,
    credentialStatus: realPersonCred.credentialStatus
      ? { statusListCredential: realPersonCred.credentialStatus.statusListCredential,
          statusListIndex: realPersonCred.credentialStatus.statusListIndex }
      : null,
  };
}

/**
 * Helper function to check CIS Training status
 * @param {string} prismDid - Employee's PRISM DID
 * @returns {Object} Training status with hasValidTraining and expiryDate
 */
async function checkCISTrainingStatus(prismDid) {
  try {
    // Query TechCorp Cloud Agent for credentials (paginate to get all records)
    const response = await cloudAgentRequest(
      TECHCORP_API_KEY,
      '/issue-credentials/records?limit=200'
    );

    const records = response.data.contents || [];

    // States that confirm training was completed (CredentialSent = delivered,
    // OfferSent/RequestReceived = pending wallet acceptance but training was done)
    const VALID_STATES = ['CredentialSent', 'CredentialReceived', 'OfferSent', 'RequestReceived', 'RequestSent'];

    // Look for CISTraining credential for this DID
    let trainingClaims = null;
    for (const record of records) {
      if (!VALID_STATES.includes(record.protocolState)) continue;

      try {
        let claims = null;

        if (record.credential) {
          // Issued credential: decode JWT
          const decoded = decodeCredential(record);
          if (decoded &&
              decoded.claims.trainingYear !== undefined &&
              decoded.claims.certificateNumber !== undefined &&
              prismDidsMatch(decoded.subject, prismDid)) {
            claims = decoded.claims;
          }
        } else if (record.claims) {
          // Pending offer: claims stored directly on the record
          const c = record.claims;
          if (c.trainingYear !== undefined &&
              c.certificateNumber !== undefined &&
              prismDidsMatch(c.prismDid, prismDid)) {
            claims = c;
          }
        }

        if (claims) {
          trainingClaims = claims;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (trainingClaims) {
      const expiryDate = trainingClaims.expiryDate;
      const hasValidTraining = expiryDate ? new Date(expiryDate) > new Date() : true;

      return {
        hasValidTraining,
        expiryDate: expiryDate || null,
        completionDate: trainingClaims.completionDate || null
      };
    }

    return { hasValidTraining: false, expiryDate: null };
  } catch (error) {
    console.error('[EmployeeAuth] Error checking CIS training status:', error);
    return { hasValidTraining: false, expiryDate: null };
  }
}

// Look up SecurityClearanceGrant VC issued by TechCorp for this PRISM DID.
// Used by the DIDComm access flow which only presents EmployeeRole.
async function checkSecurityClearanceGrant(prismDid) {
  try {
    const response = await cloudAgentRequest(TECHCORP_API_KEY, '/issue-credentials/records?limit=200');
    const records = response.data.contents || [];
    const VALID_STATES = ['CredentialSent', 'CredentialReceived', 'OfferSent', 'RequestReceived'];

    for (const record of records) {
      if (!VALID_STATES.includes(record.protocolState)) continue;
      try {
        let level = null;
        if (record.credential) {
          const decoded = decodeCredential(record);
          if (decoded && decoded.claims.clearanceLevel && prismDidsMatch(decoded.subject, prismDid)) {
            level = decoded.claims.clearanceLevel;
          }
        } else if (record.claims) {
          const c = record.claims;
          if (c.clearanceLevel &&
              (prismDidsMatch(c.holderDID, prismDid) || prismDidsMatch(c.prismDid, prismDid))) {
            level = c.clearanceLevel;
          }
        }
        if (level) return { hasClearance: true, level };
      } catch (e) { continue; }
    }
    return { hasClearance: false, level: null };
  } catch (e) {
    return { hasClearance: false, level: null };
  }
}

/**
 * Middleware to require employee session
 * Validates session token and checks expiration
 */
function requireEmployeeSession(req, res, next) {
  // Accept both X-Session-Token and X-Session-ID for compatibility
  const token = req.headers['x-session-token'] || req.headers['x-session-id'];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'No session token provided'
    });
  }

  const session = employeeSessions.get(token);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired session token'
    });
  }

  // Check session expiration (4 hours)
  const sessionAge = Date.now() - session.authenticatedAt;
  if (sessionAge > 4 * 60 * 60 * 1000) {
    employeeSessions.delete(token);
    return res.status(401).json({
      success: false,
      error: 'SessionExpired',
      message: 'Session has expired. Please authenticate again.'
    });
  }

  // Update last activity
  session.lastActivity = Date.now();
  req.employeeSession = session;

  next();
}

/**
 * Middleware: authenticate IDL wallet requests via enterprise agent API key + walletId.
 * The IDL wallet sends X-Employee-Api-Key (enterprise agent apiKey) and
 * X-Employee-Wallet-Id (enterpriseAgentWalletId from ServiceConfiguration VC).
 */
async function requireEmployeeWalletKey(req, res, next) {
  const apiKey = req.headers['x-employee-api-key'];
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Missing X-Employee-Api-Key' });
  }
  try {
    // GET /wallets with a wallet-level apikey returns only that wallet — validates key and resolves walletId
    // in one call. This is authoritative: avoids trusting X-Employee-Wallet-Id from the client, which may
    // be "undefined" if the employee's ServiceConfiguration VC predates the enterpriseAgentWalletId field.
    const walletResp = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/wallets?limit=1`, {
      headers: { 'apikey': apiKey }
    });
    if (!walletResp.ok) {
      return res.status(401).json({ success: false, error: 'Invalid employee API key' });
    }
    const walletData = await walletResp.json();
    const wallet = (walletData.contents || [])[0];
    if (!wallet) {
      return res.status(401).json({ success: false, error: 'No wallet found for API key' });
    }
    req.employee = { walletId: wallet.id, wallet_id: wallet.id, apiKey };

    // Enrich with employee identity (email/full_name) so downstream colleague-chat
    // endpoints (fromEmail/fromName on invitations, connectionColleagueMap ownership)
    // have real values instead of undefined. Best-effort: proceeds without enrichment
    // if the enterprise DB isn't configured or the lookup fails (e.g. stale wallet_id
    // after a cross-device wallet restore).
    if (process.env.ENTERPRISE_DB_PASSWORD) {
      try {
        const employeeRecord = await getEnterpriseDb().getEmployeeByWalletId(wallet.id);
        if (employeeRecord) {
          req.employee.email = employeeRecord.email;
          req.employee.full_name = employeeRecord.full_name;
          req.employee.company_id = employeeRecord.company_id;
        }
      } catch (e) {
        console.warn('[requireEmployeeWalletKey] Employee lookup failed:', e.message);
      }
    }

    next();
  } catch (err) {
    console.error('[requireEmployeeWalletKey] error:', err.message);
    return res.status(500).json({ success: false, error: 'Auth check failed' });
  }
}

// ─── Colleague Chat Endpoints ───────────────────────────────────────────────

/**
 * GET /api/employee-portal/connection-names
 * Returns { connectionId: name } for the authenticated employee's own colleague connections.
 * The enterprise Cloud Agent doesn't persist the `label` sent on the accept-side
 * /connection-invitations call, so a colleague connection's own connectionId has no name
 * attached at the agent level once established — connectionColleagueMap (populated at both
 * invite-send and invite-accept time, see colleague-invite/colleague-invitations below) is the
 * only place that name still lives.
 */
app.get('/api/employee-portal/connection-names', requireEmployeeWalletKey, (req, res) => {
  const prefix = `${req.employee.wallet_id}:`;
  const names = {};
  for (const [key, mapping] of connectionColleagueMap.entries()) {
    if (key.startsWith(prefix)) {
      names[key.slice(prefix.length)] = mapping.colleagueName || mapping.colleagueEmail;
    }
  }
  res.json({ success: true, names });
});

/**
 * GET /api/employee-portal/colleagues
 * Returns all active employees (excluding self) for the colleague directory.
 */
app.get('/api/employee-portal/colleagues', requireEmployeeWalletKey, async (req, res) => {
  try {
    const db = getEnterpriseDb();
    if (!req.employee.company_id) {
      console.warn(`[colleagues] ${req.employee.email || req.employee.wallet_id} has no company_id on record — returning empty colleague list rather than leaking cross-tenant data`);
      return res.json({ success: true, colleagues: [] });
    }
    const all = await db.getAllActiveEmployees(req.employee.company_id);
    // is_active only means "not soft-deleted at the DB row level" — it says nothing about
    // whether the admin has since removed this employee's connection via Employee Management's
    // "Remove" button, which only records the connectionId in global.softDeletedConnections
    // (a separate, admin-portal-local list) and never touches this table. Cross-reference it so
    // the colleague directory matches what the admin's own employee list actually shows instead
    // of listing everyone ever onboarded, including employees already removed long ago.
    const softDeleted = global.softDeletedConnections.get(req.employee.company_id) || new Set();
    const colleagues = all
      .filter(e => e.wallet_id !== req.employee.wallet_id)
      .filter(e => !e.techcorp_connection_id || !softDeleted.has(e.techcorp_connection_id))
      .map(e => ({ email: e.email, full_name: e.full_name, department: e.department, wallet_id: e.wallet_id }));
    res.json({ success: true, colleagues });
  } catch (err) {
    console.error('[colleagues] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/employee-portal/colleague-invite
 * Store an OOB invitation for delivery to a colleague.
 * Body: { toEmail, oobBase64 }
 */
app.post('/api/employee-portal/colleague-invite', requireEmployeeWalletKey, async (req, res) => {
  try {
    const { toEmail, toName, oobBase64, connectionId } = req.body;
    if (!toEmail || !oobBase64) return res.status(400).json({ success: false, error: 'toEmail and oobBase64 required' });
    const id = require('crypto').randomUUID();
    colleagueInvitations.set(id, {
      id, fromEmail: req.employee.email, fromName: req.employee.full_name,
      toEmail, oobBase64, createdAt: new Date().toISOString()
    });
    // Record the inviter's own side of the connection so their Connections list can
    // show the colleague's name too (mirrors the acceptor-side mapping below).
    if (connectionId) {
      connectionColleagueMap.set(`${req.employee.wallet_id}:${connectionId}`, {
        ownerEmail: req.employee.email, colleagueEmail: toEmail, colleagueName: toName || toEmail
      });
    }
    console.log(`[ColleagueInvite] ${req.employee.email} → ${toEmail} (${id})`);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/employee-portal/colleague-invitations
 * Returns pending OOB invitations addressed to the authenticated employee.
 */
app.get('/api/employee-portal/colleague-invitations', requireEmployeeWalletKey, async (req, res) => {
  const myEmail = req.employee.email;
  const pending = [];
  for (const inv of colleagueInvitations.values()) {
    if (inv.toEmail === myEmail) {
      pending.push({ id: inv.id, fromEmail: inv.fromEmail, fromName: inv.fromName, oobBase64: inv.oobBase64, createdAt: inv.createdAt });
    }
  }
  res.json({ success: true, invitations: pending });
});

/**
 * DELETE /api/employee-portal/colleague-invitations/:id
 * Mark an invitation as consumed after the IDL wallet accepted it.
 * Body: { connectionId } — the connectionId returned by the enterprise agent after accepting
 */
app.delete('/api/employee-portal/colleague-invitations/:id', requireEmployeeWalletKey, async (req, res) => {
  const inv = colleagueInvitations.get(req.params.id);
  if (!inv) return res.status(404).json({ success: false, error: 'Invitation not found' });
  if (inv.toEmail !== req.employee.email) return res.status(403).json({ success: false, error: 'Forbidden' });
  const { connectionId } = req.body || {};
  // Store reverse mapping so webhook can route reply messages
  if (connectionId) {
    connectionColleagueMap.set(`${req.employee.wallet_id}:${connectionId}`, {
      ownerEmail: req.employee.email, colleagueEmail: inv.fromEmail, colleagueName: inv.fromName
    });
  }
  colleagueInvitations.delete(req.params.id);
  res.json({ success: true });
});

// In-memory store for multitenancy test webhook events (ring buffer, max 500)
const multitenancyTestEvents = [];
const MAX_TEST_EVENTS = 500;

// ─── Admin Chat Inbox ────────────────────────────────────────────────────────
// connectionId → [{from, fromLabel, content, timestamp, messageId}]
const adminInbox = new Map();
const MAX_ADMIN_MSGS = 500;
const ADMIN_INBOX_FILE = path.join(__dirname, 'data', 'admin-inbox.json');

function saveAdminInbox() {
  try {
    const obj = {};
    for (const [k, v] of adminInbox) obj[k] = v;
    fs.writeFileSync(ADMIN_INBOX_FILE, JSON.stringify(obj));
  } catch (e) { console.warn('[AdminInbox] Failed to persist:', e.message); }
}

function loadAdminInbox() {
  try {
    if (fs.existsSync(ADMIN_INBOX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ADMIN_INBOX_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) adminInbox.set(k, v);
      console.log(`[AdminInbox] Loaded ${adminInbox.size} conversation(s) from disk`);
    }
  } catch (e) { console.warn('[AdminInbox] Failed to load:', e.message); }
}

loadAdminInbox();
setInterval(saveAdminInbox, 10_000);

/**
 * POST /api/multitenancy-test-webhook
 * Receives all webhook events from the multitenancy cloud agent (for testing).
 * Also routes BasicMessageReceived events to adminInbox so admin chat sees employee messages.
 */
app.post('/api/multitenancy-test-webhook', async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  if (!event) return;
  event._receivedAt = Date.now();

  // Route BasicMessageReceived to adminInbox so admin chat shows employee messages
  if (event.type === 'BasicMessageReceived' && event.data) {
    const { from: senderId, content, id: eventId } = event.data;
    const walletId = event.walletId;
    const company = Object.values(COMPANIES).find(c => c.walletId === walletId);
    if (company && senderId && content) {
      resolveConnectionByDID(MULTITENANCY_CLOUD_AGENT_URL, company.apiKey, senderId)
        .then(connId => {
          if (!connId) return;
          const msgs = adminInbox.get(connId) || [];
          msgs.push({
            from: 'employee',
            fromLabel: connId.slice(0, 8),
            content,
            timestamp: Date.now(),
            messageId: eventId || crypto.randomUUID(),
            sentByAdmin: false
          });
          adminInbox.set(connId, msgs.slice(-MAX_ADMIN_MSGS));
          console.log(`[MultitenancyTestWebhook] BasicMessage → adminInbox[${connId.slice(0, 8)}]: ${content.substring(0, 50)}`);
        })
        .catch(e => console.error('[MultitenancyTestWebhook] resolveConnection error:', e.message));
    }
  }

  multitenancyTestEvents.push(event);
  if (multitenancyTestEvents.length > MAX_TEST_EVENTS) multitenancyTestEvents.shift();
  console.log(`[MultitenancyTestWebhook] event type=${event.type || 'unknown'} wallet=${event.walletId || '-'}`);
});

/**
 * GET /api/multitenancy-test-webhook/events
 * Returns all captured events since ?since=<unix_ms> and clears them.
 */
app.get('/api/multitenancy-test-webhook/events', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const filtered = since
    ? multitenancyTestEvents.filter(e => e._receivedAt > since)
    : multitenancyTestEvents.slice();
  res.json({ events: filtered, total: multitenancyTestEvents.length });
});

/**
 * DELETE /api/multitenancy-test-webhook/events
 * Clears all captured test events.
 */
app.delete('/api/multitenancy-test-webhook/events', (req, res) => {
  multitenancyTestEvents.length = 0;
  res.json({ cleared: true });
});

// ─── Admin Chat API ──────────────────────────────────────────────────────────
// Uses the HR department API key to access the enterprise agent (port 8300).
// Admin chat uses the company's multitenancy agent (port 8200) because that is where
// EmployeeWalletManager creates employee connections (via createTechCorpInvitation).

/**
 * GET /api/admin/connections
 * List all connections from the company's multitenancy agent.
 */
app.get('/api/admin/connections', requireCompany, async (req, res) => {
  try {
    const result = await cloudAgentRequest(req.company.apiKey, '/connections?limit=1000');
    if (!result.success) return res.status(502).json({ error: result.error });
    res.json({ success: true, connections: result.data.contents || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/employee-index
 * Joins enterprise agent connections with employee DB records.
 * Returns [{connectionId, label, state, email, name, department}]
 */
app.get('/api/admin/employee-index', requireCompany, async (req, res) => {
  try {
    const connResult = await cloudAgentRequest(req.company.apiKey, '/connections?limit=1000');
    if (!connResult.success) return res.status(502).json({ error: connResult.error });

    const conns = connResult.data.contents || [];
    const softDeleted = global.softDeletedConnections.get(req.company.id) || new Set();

    // Build connectionId → employee info: colleague map, then pendingInvitations, then DB
    const connToEmployee = {};
    for (const [key, mapping] of connectionColleagueMap.entries()) {
      const connId = key.split(':').slice(1).join(':');
      if (!connToEmployee[connId]) {
        connToEmployee[connId] = { email: mapping.colleagueEmail, name: mapping.colleagueName || mapping.colleagueEmail };
      }
    }
    for (const [connId, inv] of global.pendingInvitations.entries()) {
      if (!connToEmployee[connId] && (inv.name || inv.email)) {
        connToEmployee[connId] = { email: inv.email || null, name: inv.name || inv.email || null };
      }
    }
    let dbConnectionMap = new Map();
    if (process.env.ENTERPRISE_DB_PASSWORD) {
      try {
        dbConnectionMap = await getEnterpriseDb().getEmployeeConnectionMap(req.company.id);
        for (const [connId, row] of dbConnectionMap.entries()) {
          if (!connToEmployee[connId]) {
            connToEmployee[connId] = { email: row.email, name: row.full_name };
          }
        }
      } catch (e) { console.warn('[employee-index] DB enrich skipped:', e.message); }
    }

    function resolveEntry(c) {
      const lm = (c.label || '').match(/^(.+?)\s+\(([^)]+)\)\s+-\s+(.+)$/);
      const labelName = (lm && lm[1] !== 'Pending') ? lm[1] : null;
      const resolvedName = connToEmployee[c.connectionId]?.name || labelName || c.label || null;
      return {
        connectionId: c.connectionId,
        label: resolvedName || c.connectionId.slice(0, 8),
        state: c.state,
        email: connToEmployee[c.connectionId]?.email || null,
        name: resolvedName,
        unreadCount: (adminInbox.get(c.connectionId) || []).filter(m => !m._adminRead).length
      };
    }

    let hrIndex = conns.filter(c => isEmployeeConnection(c, softDeleted)).map(resolveEntry);

    // An employee's techcorp_connection_id (dbConnectionMap) is the DB's canonical connection
    // for that email. Drop any other hrIndex entry resolving to the same email — e.g. a
    // personal-wallet onboarding connection left behind (with a stale pending-invitations.json
    // name/email record) when the employee's flow pivoted to an enterprise wallet — otherwise it
    // shows as an indistinguishable duplicate "employee" and can shadow the canonical one below
    // (same name → treated as "already shown" → the real, listening connection never appears,
    // and admin messages silently go to a connection nothing is watching).
    const canonicalConnIdByEmail = new Map();
    for (const [connId, row] of dbConnectionMap.entries()) {
      if (row.email) canonicalConnIdByEmail.set(row.email.toLowerCase(), connId);
    }
    hrIndex = hrIndex.filter(e => {
      const canonical = e.email && canonicalConnIdByEmail.get(e.email.toLowerCase());
      return !canonical || canonical === e.connectionId;
    });

    // Add DB-backed canonical connections not already shown
    const shownIds = new Set(hrIndex.map(e => e.connectionId));
    const connByIdMap = new Map(conns.map(c => [c.connectionId, c]));
    const activeStates = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active', 'ACTIVE', 'active'];

    for (const [connId, row] of dbConnectionMap.entries()) {
      if (shownIds.has(connId)) continue;
      const conn = connByIdMap.get(connId);
      if (!conn || !activeStates.includes(conn.state)) continue;
      if (softDeleted.has(connId)) continue;
      connToEmployee[connId] = { name: row.full_name, email: row.email };
      hrIndex.push(resolveEntry(conn));
    }

    res.json({ success: true, employees: hrIndex });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/send-message
 * Send a BasicMessage from the admin (HR wallet) to an employee connection.
 * Body: { connectionId, content }
 */
app.post('/api/admin/send-message', requireCompany, async (req, res) => {
  const { connectionId, content } = req.body || {};
  if (!connectionId || !content) return res.status(400).json({ error: 'connectionId and content required' });
  try {
    const result = await cloudAgentRequest(req.company.apiKey, `/connections/${connectionId}/basic-messages`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    if (!result.success) return res.status(502).json({ error: result.error });

    // Store the sent message in admin inbox too (as admin's own sent message)
    const timestamp = Date.now();
    const msgs = adminInbox.get(connectionId) || [];
    msgs.push({ from: 'admin', fromLabel: 'Admin', content, timestamp, messageId: result.data.id || crypto.randomUUID(), sentByAdmin: true });
    adminInbox.set(connectionId, msgs.slice(-MAX_ADMIN_MSGS));

    res.json({ success: true, messageId: result.data.id, timestamp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/messages/:connectionId
 * Return admin inbox for a connection. Supports ?since=<unix_ms>.
 */
app.get('/api/admin/messages/:connectionId', requireCompany, (req, res) => {
  const { connectionId } = req.params;
  const since = parseInt(req.query.since || '0', 10);
  const all = adminInbox.get(connectionId) || [];
  const filtered = since ? all.filter(m => m.timestamp > since) : all;
  // Mark as read
  all.forEach(m => { m._adminRead = true; });
  res.json({ success: true, messages: filtered });
});

/**
 * GET /api/admin/releasable-partners
 * List the caller's own company's admin-managed "Releasable To" partner list.
 */
app.get('/api/admin/releasable-partners', requireCompany, (req, res) => {
  try {
    const partners = ReleasablePartnersRegistry.getPartnersForCompany(req.company.id);
    res.json({ success: true, partners });
  } catch (e) {
    res.status(500).json({ success: false, error: 'InternalServerError', message: e.message });
  }
});

/**
 * POST /api/admin/releasable-partners
 * Add a partner (Name + DID) to the caller's own company's list.
 * Body: { name, did }
 */
app.post('/api/admin/releasable-partners', requireCompany, async (req, res) => {
  try {
    const { name, did } = req.body || {};
    const partner = await ReleasablePartnersRegistry.addPartner(req.company.id, { name, did });
    res.json({ success: true, partner });
  } catch (e) {
    res.status(400).json({ success: false, error: 'BadRequest', message: e.message });
  }
});

/**
 * DELETE /api/admin/releasable-partners/:partnerId
 * Remove a partner from the caller's own company's list (no-op if not found).
 */
app.delete('/api/admin/releasable-partners/:partnerId', requireCompany, async (req, res) => {
  try {
    await ReleasablePartnersRegistry.removePartner(req.company.id, req.params.partnerId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'InternalServerError', message: e.message });
  }
});

/**
 * POST /api/enterprise-messages-webhook
 * Receives BasicMessageReceived webhook events from the enterprise cloud agent.
 */
app.post('/api/enterprise-messages-webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately
  const { type, walletId: bodyWalletId, data } = req.body || {};
  const walletId = req.query.walletId || bodyWalletId;
  console.log(`[EnterpriseWebhook] event type=${type || 'unknown'} wallet=${walletId || '-'}`);
  if (type !== 'BasicMessageReceived' || !data) return;

  // connectionId is absent in enterprise agent per-wallet webhook payloads (only from/to DIDs present).
  // Resolve the enterprise connection UUID by looking up the connection where theirDid === fromDid.
  const { id, content, connectionId: rawConnectionId, from: fromDid } = data;
  if (!content) return;

  let connectionId = rawConnectionId || null;
  if (!connectionId && fromDid) {
    const webhookKey = enterpriseWalletKeyMap.get(walletId);
    if (webhookKey) {
      connectionId = await resolveConnectionByDID(ENTERPRISE_CLOUD_AGENT_URL, webhookKey, fromDid).catch(() => null);
    }
  }
  connectionId = connectionId || fromDid || 'admin';

  // Look up which colleague sent this via the connection map (keyed by walletId:connectionId)
  const mapping = connectionId ? connectionColleagueMap.get(`${walletId}:${connectionId}`) : null;
  if (!mapping) {
    // No colleague mapping → message is from the company admin (sent via multitenancy agent)
    const msg = { id: id || crypto.randomUUID(), fromEmail: 'admin', fromName: 'Company Admin', content, timestamp: Date.now(), connectionId: connectionId || fromDid || 'admin' };
    const inbox = walletAdminMessages.get(walletId) || [];
    inbox.push(msg);
    walletAdminMessages.set(walletId, inbox.slice(-200));
    console.log(`[EnterpriseWebhook] Admin message → wallet=${walletId}: ${content.substring(0, 50)}`);
    return;
  }

  const msg = { id: id || crypto.randomUUID(), fromEmail: mapping.colleagueEmail, fromName: mapping.colleagueName, content, timestamp: Date.now(), connectionId };
  const inbox = colleagueMessages.get(mapping.ownerEmail) || [];
  inbox.push(msg);
  colleagueMessages.set(mapping.ownerEmail, inbox.slice(-200)); // keep last 200
  console.log(`[EnterpriseWebhook] Message from ${mapping.colleagueEmail} → ${mapping.ownerEmail}: ${content.substring(0, 50)}`);

  // Also push into admin inbox so admins can see employee messages (connectionId may be null here)
  if (connectionId) {
    const adminMsgs = adminInbox.get(connectionId) || [];
    adminMsgs.push({ from: mapping.colleagueEmail, fromLabel: mapping.colleagueName || mapping.colleagueEmail, content, timestamp: Date.now(), messageId: msg.id });
    adminInbox.set(connectionId, adminMsgs.slice(-MAX_ADMIN_MSGS));
  }
});

/**
 * POST /api/audit/document-event
 * Unauthenticated inbound receiver (matches the existing convention of
 * /api/enterprise-messages-webhook and /api/didcomm-webhook/:company — trusts
 * network topology, no shared secret) for CRUD/access audit events emitted by
 * identus-document-service's AuditEmitter (see AUDIT_FALLBACK_URL in its .env).
 * Merges into the same access-gate-log.jsonl collector the admin dashboard reads.
 */
app.post('/api/audit/document-event', (req, res) => {
  const { event, documentDID, ownerCompanyDID, title, actorEmail, clearanceLevel } = req.body || {};
  if (!VALID_AUDIT_EVENT_TYPES.includes(event) || !documentDID) {
    return res.status(400).json({ success: false, error: 'BadRequest', message: 'event must be one of ' + VALID_AUDIT_EVENT_TYPES.join('|') + ' and documentDID is required' });
  }
  res.json({ success: true }); // ack immediately, matching /api/enterprise-messages-webhook's fire-and-forget style
  const logEntry = buildLogEntryFromAuditWebhook({
    event, documentDID, ownerCompanyDID, title, actorEmail, clearanceLevel,
    clientIp: req.ip || req.connection?.remoteAddress || null
  });
  fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify(logEntry) + '\n', () => {});
});

/**
 * GET /api/employee-portal/colleague-messages
 * Returns messages received since a given timestamp.
 * Query: ?since=<unix_ms>
 */
app.get('/api/employee-portal/colleague-messages', requireEmployeeWalletKey, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const walletId = req.employee.walletId;
  // Colleague-to-colleague messages (keyed by email, may be absent if no email in req.employee)
  const peerMsgs = req.employee.email ? (colleagueMessages.get(req.employee.email) || []) : [];
  // Admin→employee messages (keyed by walletId, no email needed)
  const adminMsgs = walletAdminMessages.get(walletId) || [];
  const all = [...peerMsgs, ...adminMsgs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const filtered = since ? all.filter(m => m.timestamp > since) : all;
  res.json({ success: true, messages: filtered });
});

// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/employee-portal/auth/initiate
 * Initiate employee authentication via EmployeeRole VC presentation
 */
// Resolve employeeId (email prefix from ?user= param in serviceUrl) → full email.
// Used by login page to pre-fill the email field without embedding email in the VC serviceUrl.
app.get('/api/employee-portal/resolve-user', async (req, res) => {
  const { user } = req.query;
  if (!user || typeof user !== 'string' || user.length > 100) {
    return res.status(400).json({ error: 'Invalid user parameter' });
  }
  try {
    const employeeDb = getEnterpriseDb();
    const employee = await employeeDb.getEmployeeByEmployeeId(user.trim());
    if (!employee) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Return only the email — no other PII
    return res.json({ email: employee.email });
  } catch (err) {
    console.error('[resolve-user]', err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});

app.post('/api/employee-portal/auth/initiate', async (req, res) => {
  try {
    const { identifier } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [EmployeeAuth] Authentication initiated`);
    console.log(`   Identifier: ${identifier}`);
    console.log(`${'='.repeat(80)}\n`);

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'MissingIdentifier',
        message: 'Email or PRISM DID is required'
      });
    }

    // Initialize database connection to enterprise PostgreSQL
    // SECURITY: Database password MUST be set via ENTERPRISE_DB_PASSWORD environment variable
    if (!process.env.ENTERPRISE_DB_PASSWORD) {
      return res.status(500).json({
        success: false,
        error: 'ConfigurationError',
        message: 'Database password not configured. Set ENTERPRISE_DB_PASSWORD environment variable.'
      });
    }

    const { Pool } = require('pg');
    const enterprisePool = new Pool({
      host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
      port: process.env.ENTERPRISE_DB_PORT || 5434,
      database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
      user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
      password: process.env.ENTERPRISE_DB_PASSWORD,
    });
    const employeeDb = new EmployeePortalDatabase(enterprisePool);

    // Look up employee by connection mapping
    let employee = null;

    // Strategy 1: Check stored employee-connection mappings (primary method)
    if (global.employeeConnectionMappings && global.employeeConnectionMappings.has(identifier)) {
      const mapping = global.employeeConnectionMappings.get(identifier);
      console.log(`✅ [EmployeeAuth] Found stored mapping: ${identifier} → ${mapping.connectionId}`);

      employee = {
        techcorp_connection_id: mapping.connectionId,
        email: mapping.email || identifier,
        full_name: mapping.name || 'Employee',
        department: mapping.department || 'Unknown'
      };
    }

    // Strategy 2: Look up employee by email or PRISM DID in database
    if (!employee) {
      if (identifier.includes('@')) {
        // Email lookup
        employee = await employeeDb.getEmployeeByEmail(identifier);
      } else if (identifier.startsWith('did:prism:')) {
        // PRISM DID lookup
        employee = await employeeDb.getEmployeeByDid(identifier);
      }
    }

    if (!employee || !employee.techcorp_connection_id) {
      console.error(`[EmployeeAuth] No employee found with connectionId`);
      return res.status(404).json({
        success: false,
        error: 'EmployeeNotFound',
        message: 'Employee not found. Please ensure you have completed the onboarding process.'
      });
    }

    // Generate challenge and domain
    const challenge = crypto.randomUUID();
    const domain = 'employee-portal.techcorp.com';

    // Always use the stored enterprise connection — the proof request goes to the enterprise
    // wallet where the EmployeeRole VC lives.
    const loginConnectionId = employee.techcorp_connection_id;

    // Reject any stale RequestReceived presentations from previous login attempts
    // so they don't block UX in the enterprise wallet modal.
    if (employee.wallet_id) {
      const enterpriseApiKey = enterpriseWalletKeyMap.get(employee.wallet_id);
      if (enterpriseApiKey) {
        try {
          const staleResp = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/present-proof/presentations?limit=100`, {
            headers: { 'apikey': enterpriseApiKey }
          });
          if (staleResp.ok) {
            const staleData = await staleResp.json();
            const stale = (staleData.contents || []).filter(p =>
              p.status === 'RequestReceived' && p.role === 'Prover'
            );
            await Promise.all(stale.map(p =>
              fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/present-proof/presentations/${p.presentationId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'apikey': enterpriseApiKey },
                body: JSON.stringify({ action: 'request-reject' })
              }).catch(() => {})
            ));
            if (stale.length > 0) {
              console.log(`[EmployeeAuth] Rejected ${stale.length} stale proof request(s) for ${identifier}`);
            }
          }
        } catch (e) {
          console.warn(`[EmployeeAuth] Stale request cleanup failed (non-blocking): ${e.message}`);
        }
      }
    }

    console.log(`[EmployeeAuth] Creating proof request:`);
    console.log(`   Connection ID: ${loginConnectionId}`);
    console.log(`   Challenge: ${challenge.substring(0, 12)}...`);
    console.log(`   Domain: ${domain}`);

    // Create Present Proof request via DIDComm connection
    // Schema-less: accepts ANY verifiable presentation so the user can provide either
    // EmployeeRole or SecurityClearance from whichever wallet they prefer.
    const proofRequestPayload = {
      connectionId: loginConnectionId,
      options: {
        challenge: challenge,
        domain: domain
      },
      proofs: [],  // Empty array = accept ANY credential without schema validation
      goalCode: 'present-vp',
      goal: 'Please provide your employee credentials for authentication',
      credentialFormat: 'JWT'
    };

    console.log(`[EmployeeAuth] Sending proof request via DIDComm connection...`);

    const proofResponse = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'apikey': TECHCORP_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(proofRequestPayload)
    });

    if (!proofResponse.ok) {
      const error = await proofResponse.text();
      throw new Error(`Proof request creation failed: ${proofResponse.status} ${error}`);
    }

    const proofData = await proofResponse.json();
    const presentationId = proofData.presentationId || proofData.id;

    console.log(`[EmployeeAuth] Proof request created: ${presentationId}`);

    // Store pending authentication
    pendingEmployeeAuths.set(presentationId, {
      presentationId,
      connectionId: employee.techcorp_connection_id,
      challenge,
      domain,
      identifier,
      employee,
      timestamp: Date.now(),
      status: 'pending'
    });

    // Clean up old pending auths (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [id, auth] of pendingEmployeeAuths) {
      if (auth.timestamp < fiveMinutesAgo) {
        pendingEmployeeAuths.delete(id);
        console.log(`[EmployeeAuth] Cleaned up expired auth: ${id}`);
      }
    }

    console.log(`[EmployeeAuth] Authentication initiated successfully`);

    res.json({
      success: true,
      presentationId,
      status: 'pending',
      message: 'Proof request sent to your wallet. Please approve it to continue.'
    });

  } catch (error) {
    console.error('[EmployeeAuth] Error initiating authentication:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to initiate authentication'
    });
  }
});

/**
 * GET /api/employee-portal/auth/status/:presentationId
 * Check authentication status
 */
app.get('/api/employee-portal/auth/status/:presentationId', async (req, res) => {
  try {
    const { presentationId } = req.params;

    console.log(`[EmployeeAuth] Checking status for: ${presentationId}`);

    // Check if pending auth exists
    const pendingAuth = pendingEmployeeAuths.get(presentationId);
    if (!pendingAuth) {
      return res.status(404).json({
        success: false,
        error: 'PresentationNotFound',
        message: 'Presentation request not found or expired'
      });
    }

    // Check timeout (5 minutes)
    const age = Date.now() - pendingAuth.timestamp;
    if (age > 5 * 60 * 1000) {
      pendingEmployeeAuths.delete(presentationId);
      return res.status(408).json({
        success: false,
        error: 'RequestTimeout',
        message: 'Authentication request timed out'
      });
    }

    // Query Cloud Agent for presentation status using TechCorp API key
    const presentationResponse = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations/${presentationId}`, {
      method: 'GET',
      headers: {
        'apikey': TECHCORP_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!presentationResponse.ok) {
      const error = await presentationResponse.text();
      throw new Error(`Failed to fetch presentation: ${presentationResponse.status} ${error}`);
    }

    const presentation = await presentationResponse.json();
    const currentState = presentation.status || presentation.state;

    console.log(`[EmployeeAuth] Presentation state: ${currentState}`);

    // Update pending auth status
    pendingAuth.status = currentState;

    // Map Cloud Agent states to our status
    let status = 'pending';
    if (currentState === 'PresentationVerified') {
      status = 'verified';
    } else if (currentState === 'PresentationReceived') {
      status = 'received';
    } else if (currentState === 'RequestRejected' || currentState === 'PresentationFailed') {
      status = 'failed';
    }

    res.json({
      success: true,
      presentationId,
      status,
      state: currentState,
      message: status === 'verified' ? 'Presentation verified, ready for authentication' :
               status === 'received' ? 'Presentation received, verifying...' :
               status === 'failed' ? 'Authentication failed' :
               'Waiting for user to approve proof request'
    });

  } catch (error) {
    console.error('[EmployeeAuth] Error checking status:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to check authentication status'
    });
  }
});

/**
 * POST /api/employee-portal/auth/verify
 * Verify presentation and create session
 */
app.post('/api/employee-portal/auth/verify', async (req, res) => {
  try {
    const { presentationId } = req.body;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔐 [EmployeeAuth] Verifying presentation: ${presentationId}`);
    console.log(`${'='.repeat(80)}\n`);

    if (!presentationId) {
      return res.status(400).json({
        success: false,
        error: 'MissingPresentationId',
        message: 'Presentation ID is required'
      });
    }

    // Get pending auth
    const pendingAuth = pendingEmployeeAuths.get(presentationId);
    if (!pendingAuth) {
      return res.status(404).json({
        success: false,
        error: 'PresentationNotFound',
        message: 'Presentation request not found or expired'
      });
    }

    // Get presentation from Cloud Agent
    const presentationResponse = await cloudAgentRequest(
      TECHCORP_API_KEY,
      `/present-proof/presentations/${presentationId}`
    );

    const presentation = presentationResponse.data;
    const currentState = presentation.status || presentation.state;

    console.log(`[EmployeeAuth] Presentation state: ${currentState}`);

    // Verify presentation is in verified state
    if (currentState !== 'PresentationVerified') {
      return res.status(400).json({
        success: false,
        error: 'PresentationNotVerified',
        message: `Presentation is in state "${currentState}", not verified`
      });
    }

    // Extract and decode presentation data
    let verifiedClaims = null;
    let issuerDID = null;
    let trainingStatus = {
      hasValidTraining: false,
      expiryDate: null,
      completionDate: null,
      certificateNumber: null,
      source: 'not_provided'
    };

    // Credential variables - declared outside nested scope for later use
    let employeeRoleCred = null;
    let cisTrainingCred = null;
    let securityClearanceCred = null;
    let loginRevocationChecks = [];

    if (presentation.data && Array.isArray(presentation.data) && presentation.data.length > 0) {
      try {
        const presentationJWT = presentation.data[0];
        console.log(`[EmployeeAuth] Decoding presentation JWT...`);

        // Decode JWT
        const parts = presentationJWT.split('.');
        if (parts.length === 3) {
          const payloadBase64 = parts[1];
          const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
          const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
          const payload = JSON.parse(payloadJson);

          const vp = payload.vp;

          // Extract the VP presenter's DID (outer JWT iss = holder who signed the VP)
          const vpHolderDID = payload.iss || null;
          if (vpHolderDID) {
            console.log(`[EmployeeAuth] VP presenter (holder) DID: ${vpHolderDID.substring(0, 50)}...`);
          } else {
            console.warn('[EmployeeAuth] No iss field in VP JWT — holder binding cannot be enforced');
          }

          // Verify challenge matches
          if (vp.proof && vp.proof.challenge !== pendingAuth.challenge) {
            console.error(`[EmployeeAuth] Challenge mismatch!`);
            return res.status(403).json({
              success: false,
              error: 'ChallengeMismatch',
              message: 'Security challenge verification failed'
            });
          }

          // Verify domain matches
          if (vp.proof && vp.proof.domain !== pendingAuth.domain) {
            console.error(`[EmployeeAuth] Domain mismatch!`);
            return res.status(403).json({
              success: false,
              error: 'DomainMismatch',
              message: 'Domain verification failed'
            });
          }

          // Helper function to decode a credential JWT
          function decodeCredentialJWT(credentialJWT) {
            try {
              if (typeof credentialJWT === 'string' && credentialJWT.includes('.')) {
                const credParts = credentialJWT.split('.');
                if (credParts.length === 3) {
                  const credPayloadBase64 = credParts[1];
                  const credPayloadBase64Standard = credPayloadBase64.replace(/-/g, '+').replace(/_/g, '/');
                  const credPadding = '='.repeat((4 - (credPayloadBase64Standard.length % 4)) % 4);
                  const credPayloadJson = Buffer.from(credPayloadBase64Standard + credPadding, 'base64').toString('utf-8');
                  const credPayload = JSON.parse(credPayloadJson);

                  if (credPayload.vc && credPayload.vc.credentialSubject) {
                    return {
                      claims: credPayload.vc.credentialSubject,
                      issuer: credPayload.iss,
                      payload: credPayload
                    };
                  }
                }
              }
            } catch (error) {
              console.error(`[EmployeeAuth] Failed to decode credential JWT:`, error);
            }
            return null;
          }

          // Helper function to identify credential type
          function isEmployeeRoleCred(claims) {
            return claims.role !== undefined && claims.department !== undefined;
          }

          function isCISTrainingCred(claims) {
            return claims.trainingYear !== undefined && claims.certificateNumber !== undefined;
          }

          function isSecurityClearanceCred(claims) {
            return claims.clearanceLevel !== undefined;
          }

          // Parse ALL credentials in the presentation

          if (vp.verifiableCredential && vp.verifiableCredential.length > 0) {
            console.log(`[EmployeeAuth] Processing ${vp.verifiableCredential.length} credential(s) in presentation`);

            for (let i = 0; i < vp.verifiableCredential.length; i++) {
              const credentialJWT = vp.verifiableCredential[i];
              const decoded = decodeCredentialJWT(credentialJWT);

              if (decoded) {
                // Holder binding: the VC subject (JWT sub) must match the VP presenter (JWT iss)
                const vcSubject = decoded.payload.sub || decoded.payload.vc?.credentialSubject?.id || null;
                if (vpHolderDID && vcSubject && vcSubject !== vpHolderDID) {
                  console.error(`[EmployeeAuth] HOLDER BINDING FAILED at index ${i}: VC subject=${vcSubject} but VP presenter=${vpHolderDID}`);
                  return res.status(403).json({
                    success: false,
                    error: 'HolderBindingFailed',
                    message: 'Credential was not issued to the presenter — you cannot present someone else\'s credential'
                  });
                }

                // Collect StatusList2021 revocation pointers for check after loop
                const cs = decoded.payload.vc?.credentialStatus || decoded.payload.credentialStatus || null;
                if (cs?.statusListCredential && cs?.statusListIndex != null) {
                  loginRevocationChecks.push({
                    statusListCredential: cs.statusListCredential,
                    statusListIndex:      Number(cs.statusListIndex)
                  });
                } else {
                  console.warn(`[EmployeeAuth] VC at index ${i} has no credentialStatus — revocation cannot be verified`);
                }

                if (isEmployeeRoleCred(decoded.claims)) {
                  console.log(`[EmployeeAuth] Found EmployeeRole credential at index ${i}`);
                  employeeRoleCred = decoded;
                } else if (isCISTrainingCred(decoded.claims)) {
                  console.log(`[EmployeeAuth] Found CISTraining credential at index ${i}`);
                  cisTrainingCred = decoded;
                } else if (isSecurityClearanceCred(decoded.claims)) {
                  console.log(`[EmployeeAuth] Found Security Clearance credential at index ${i}`);
                  securityClearanceCred = decoded;
                } else {
                  console.log(`[EmployeeAuth] Unknown credential type at index ${i}, claims:`, Object.keys(decoded.claims));
                }
              }
            }
          }

          // Validate we have the required EmployeeRole credential
          if (!employeeRoleCred) {
            console.error(`[EmployeeAuth] No EmployeeRole credential found in presentation`);
            return res.status(400).json({
              success: false,
              error: 'NoEmployeeRoleCredential',
              message: 'EmployeeRole credential is required for authentication'
            });
          }

          // Set verified claims and issuer from EmployeeRole
          verifiedClaims = employeeRoleCred.claims;
          // Use company DID stored in VC subject (set per-company during onboarding)
          // Fall back to JWT issuer for backwards compatibility with old VCs
          issuerDID = employeeRoleCred.claims?.issuerDID || employeeRoleCred.issuer;
          console.log(`[EmployeeAuth] EmployeeRole claims extracted successfully`);

          // Process CIS Training credential if provided
          if (cisTrainingCred) {
            console.log(`[EmployeeAuth] Processing CIS Training credential from presentation`);

            // Verify training credential issuer
            if (!ACCEPTED_ISSUER_DIDS.includes(cisTrainingCred.issuer)) {
              console.log(`[EmployeeAuth] CIS Training has invalid issuer: ${cisTrainingCred.issuer}`);
              trainingStatus.source = 'invalid_issuer';
            } else {
              // Extract PRISM DID from both credentials
              const employeePrismDid = verifiedClaims.prismDid || verifiedClaims.id;
              const trainingPrismDid = cisTrainingCred.claims.prismDid || cisTrainingCred.claims.id;

              // Verify PRISM DIDs match
              if (employeePrismDid !== trainingPrismDid) {
                console.log(`[EmployeeAuth] PRISM DID mismatch - Employee: ${employeePrismDid}, Training: ${trainingPrismDid}`);
                trainingStatus.source = 'did_mismatch';
              } else {
                // Check expiry date
                const expiryDate = cisTrainingCred.claims.expiryDate;
                const completionDate = cisTrainingCred.claims.completionDate;
                const certificateNumber = cisTrainingCred.claims.certificateNumber;

                if (expiryDate) {
                  const expiry = new Date(expiryDate);
                  const now = new Date();

                  if (expiry > now) {
                    console.log(`[EmployeeAuth] ✅ Valid CIS Training found in presentation`);
                    console.log(`   Certificate: ${certificateNumber}`);
                    console.log(`   Completed: ${completionDate}`);
                    console.log(`   Expires: ${expiryDate}`);

                    trainingStatus = {
                      hasValidTraining: true,
                      expiryDate: expiryDate,
                      completionDate: completionDate,
                      certificateNumber: certificateNumber,
                      source: 'presentation'
                    };
                  } else {
                    console.log(`[EmployeeAuth] CIS Training expired on ${expiryDate}`);
                    trainingStatus.source = 'expired';
                    trainingStatus.expiryDate = expiryDate;
                    trainingStatus.completionDate = completionDate;
                    trainingStatus.certificateNumber = certificateNumber;
                  }
                } else {
                  console.log(`[EmployeeAuth] CIS Training credential missing expiry date`);
                  trainingStatus.source = 'invalid_issuer';
                }
              }
            }
          } else {
            console.log(`[EmployeeAuth] No CIS Training credential provided in presentation`);
          }
        }
      } catch (decodeError) {
        console.error(`[EmployeeAuth] Failed to decode JWT:`, decodeError);
      }
    }

    if (!verifiedClaims) {
      console.error(`[EmployeeAuth] No claims found in presentation`);
      return res.status(400).json({
        success: false,
        error: 'NoClaimsFound',
        message: 'No verifiable claims found in presentation'
      });
    }

    // Verify issuer is TechCorp (accept multiple issuer DIDs for backwards compatibility)
    if (!ACCEPTED_ISSUER_DIDS.includes(issuerDID)) {
      console.error(`[EmployeeAuth] Invalid issuer: ${issuerDID}`);
      console.error(`[EmployeeAuth] Accepted issuers: ${ACCEPTED_ISSUER_DIDS.join(', ')}`);
      return res.status(403).json({
        success: false,
        error: 'InvalidIssuer',
        message: 'Credential was not issued by TechCorp'
      });
    }
    console.log(`[EmployeeAuth] ✅ Issuer verified: ${issuerDID}`);

    // Revocation check via StatusList2021 bitstring (best-effort — never blocks on fetch failure)
    try {
      const StatusListService = require('./lib/StatusListService');
      await Promise.all(loginRevocationChecks.map(async (cs) => {
        const rev = await StatusListService.checkByCredentialStatus(cs);
        if (rev.isRevoked) {
          console.error(`[EmployeeAuth] DENIED — credential revoked (statusListIndex=${cs.statusListIndex})`);
          throw { code: 'CredentialRevoked', statusListIndex: cs.statusListIndex };
        }
      }));
    } catch (revErr) {
      if (revErr.code === 'CredentialRevoked') {
        return res.status(403).json({
          success: false,
          error: 'CredentialRevoked',
          message: 'One of your credentials has been revoked and can no longer be used to log in'
        });
      }
      console.warn(`[EmployeeAuth] Revocation check failed (non-fatal): ${revErr.message}`);
    }

    // RealPersonIdentity revocation check — the root identity credential was presented during
    // personal onboarding; its credentialStatus pointer is stored in DB metadata. A revoked
    // RealPersonIdentity means the employee's underlying identity is no longer valid.
    try {
      let meta = pendingAuth.employee?.metadata || null;
      if (meta && typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = null; } }
      const rpCs = meta?.realPersonCredentialStatus;
      if (rpCs?.statusListCredential && rpCs?.statusListIndex != null) {
        const StatusListService = require('./lib/StatusListService');
        const rev = await StatusListService.checkByCredentialStatus(rpCs);
        if (rev.isRevoked) {
          console.error(`[EmployeeAuth] DENIED — RealPersonIdentity VC revoked (statusListIndex=${rpCs.statusListIndex})`);
          return res.status(403).json({
            success: false,
            error: 'IdentityCredentialRevoked',
            message: 'Your identity credential has been revoked. Please contact your administrator.'
          });
        }
        console.log(`[EmployeeAuth] ✅ RealPersonIdentity revocation check passed`);
      } else {
        console.warn(`[EmployeeAuth] No RealPersonIdentity credentialStatus in DB — identity revocation not verifiable`);
      }
    } catch (rpRevErr) {
      console.warn(`[EmployeeAuth] RealPersonIdentity revocation check failed (non-fatal): ${rpRevErr.message}`);
    }

    // Extract employee information from claims
    const prismDid = verifiedClaims.prismDid || verifiedClaims.id;
    const employeeId = verifiedClaims.employeeId || pendingAuth.identifier; // Use identifier if VC doesn't have employeeId
    const role = verifiedClaims.role;
    const department = verifiedClaims.department;

    // Use login identifier as email (connection-based authentication)
    // The fact that the VC was submitted through the correct DIDComm connection
    // proves the user identity - no need to validate email field in VC
    const email = pendingAuth.identifier;

    console.log(`[EmployeeAuth] Employee verified through connection-based authentication:`);
    console.log(`   PRISM DID: ${prismDid}`);
    console.log(`   Employee ID: ${employeeId}`);
    console.log(`   Login Email: ${email} (from connection mapping)`);
    console.log(`   Role: ${role}`);
    console.log(`   Department: ${department}`);

    // Use training status from presentation parsing (no separate Cloud Agent query needed)
    console.log(`[EmployeeAuth] CIS Training status: ${trainingStatus.hasValidTraining ? 'Valid' : `Not valid (${trainingStatus.source})`}`);

    // Process Security Clearance credential if provided (optional)
    let clearanceLevel = null;
    let hasClearanceVC = false;

    if (securityClearanceCred) {
      console.log(`[EmployeeAuth] Processing Security Clearance credential from presentation`);

      // Verify clearance credential issuer
      if (!ACCEPTED_ISSUER_DIDS.includes(securityClearanceCred.issuer)) {
        console.log(`[EmployeeAuth] Security Clearance has invalid issuer: ${securityClearanceCred.issuer}`);
      } else {
        // Extract PRISM DID from both credentials
        const employeePrismDid = verifiedClaims.prismDid || verifiedClaims.id;
        const clearancePrismDid = securityClearanceCred.claims.prismDid || securityClearanceCred.claims.id;

        // Verify PRISM DIDs match
        if (employeePrismDid !== clearancePrismDid) {
          console.log(`[EmployeeAuth] PRISM DID mismatch - Employee: ${employeePrismDid}, Clearance: ${clearancePrismDid}`);
        } else {
          // Extract clearance level
          clearanceLevel = securityClearanceCred.claims.clearanceLevel;
          hasClearanceVC = true;

          console.log(`[EmployeeAuth] ✅ Valid Security Clearance found in presentation`);
          console.log(`   Clearance Level: ${clearanceLevel}`);
        }
      }
    } else {
      console.log(`[EmployeeAuth] No Security Clearance credential provided in presentation`);
    }

    // Enrich session with current CA identity data (photo + lastName freshness check)
    let photoUrl = null;
    let lastNameMismatch = false;
    let lastNameCurrent = verifiedClaims.lastName || null;
    const caUniqueId = verifiedClaims.uniqueId || null;
    if (caUniqueId) {
      try {
        const caResp = await fetch(`${CA_BASE_URL}/api/user-info/${encodeURIComponent(caUniqueId)}`);
        if (caResp.ok) {
          const caInfo = await caResp.json();
          photoUrl = caInfo.proxyUrl || null;
          lastNameCurrent = caInfo.lastName || lastNameCurrent;
          if (caInfo.lastName && verifiedClaims.lastName && caInfo.lastName !== verifiedClaims.lastName) {
            lastNameMismatch = true;
            console.log(`[EmployeeAuth] ⚠️ lastName mismatch for ${caUniqueId}: VC="${verifiedClaims.lastName}" CA="${caInfo.lastName}"`);
          }
        }
      } catch (e) {
        console.warn(`[EmployeeAuth] CA user-info lookup failed (non-blocking): ${e.message}`);
      }
    }
    // Fallback: resolve the photoDID from the VC directly if the CA lookup returned no proxyUrl.
    // verifiedClaims.photo is a PRISM DID with a LinkedPhoto service endpoint — resolve it.
    if (!photoUrl && verifiedClaims.photo) {
      photoUrl = await resolveLinkedPhotoDID(verifiedClaims.photo);
      if (photoUrl) {
        console.log(`[EmployeeAuth] PhotoDID resolved via DID document: ${photoUrl}`);
      }
    }
    // Fallback: resolve photo DID stored in DB metadata during personal onboarding.
    // Employees whose EmployeeRole VC lacks the photo field (issued before RealPerson proof
    // was linked) still get their photo by resolving the DID document at every login.
    if (!photoUrl && pendingAuth.employee?.metadata) {
      let meta = pendingAuth.employee.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
      if (meta.photoDid) {
        photoUrl = await resolveLinkedPhotoDID(meta.photoDid);
        if (photoUrl) {
          console.log(`[EmployeeAuth] Photo resolved via stored photoDid DID document`);
        }
      }
    }

    // Create session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const session = {
      sessionToken,
      connectionId: pendingAuth.connectionId, // DIDComm connection for VC issuance
      prismDid,
      employeeId,
      role,
      department,
      fullName: pendingAuth.employee?.full_name || employeeId,
      email: email, // Use cryptographically verified email from VC
      issuerDID, // Save issuerDID for document discovery
      hasTraining: trainingStatus.hasValidTraining,
      trainingExpiryDate: trainingStatus.expiryDate,
      clearanceLevel, // Security clearance level (null if not provided)
      hasClearanceVC, // Flag indicating if employee has security clearance
      photoUrl,         // Photo proxy URL from CA (null if no photo or no uniqueId in VC)
      lastNameMismatch, // true if CA lastName differs from VC lastName
      lastNameCurrent,  // Current lastName from CA
      authenticatedAt: Date.now(),
      lastActivity: Date.now()
    };

    // Store session
    employeeSessions.set(sessionToken, session);
    if (clearanceLevel) {
      SlackNotifier.notifyClearanceVerification(email, clearanceLevel, true);
    }

    // Clean up pending auth
    pendingEmployeeAuths.delete(presentationId);

    console.log(`[EmployeeAuth] Session created successfully`);
    console.log(`   Token: ${sessionToken.substring(0, 20)}...`);

    // Issue SecurityClearanceGrant VC if a valid clearance was provided in the login VP
    // and no active grant already exists for this holder+level combination
    if (hasClearanceVC && clearanceLevel && clearanceLevel !== 'UNKNOWN') {
      // Resolve the employee's actual employer from the session's issuerDID (falls back
      // to techcorp for legacy sessions predating issuerDID storage) — issuance must go
      // through the employer's own tenant wallet/apiKey, not always TechCorp's.
      const employerCompany = resolveEmployerCompany(session.issuerDID);
      const enterpriseConnectionId = session.connectionId;
      if (employerCompany && enterpriseConnectionId) {
        const SECURITY_CLEARANCE_GRANT_SCHEMA_GUID = 'f33eedc7-aa47-3e05-bc80-cf5388d00562';

        // Check if an active SecurityClearanceGrant already exists to avoid duplicate offers
        let alreadyHasGrant = false;
        try {
          const existing = await cloudAgentRequest(employerCompany.apiKey, '/issue-credentials/records?limit=200');
          const records = existing.data?.contents || [];
          alreadyHasGrant = records.some(r =>
            (r.claims?.credentialType === 'SecurityClearanceGrant' || r.claims?.clearanceLevel) &&
            r.claims?.holderDID === prismDid &&
            r.claims?.clearanceLevel === clearanceLevel.toUpperCase() &&
            ['CredentialSent', 'OfferSent', 'OfferReceived', 'RequestReceived', 'CredentialReceived'].includes(r.protocolState)
          );
        } catch (e) {
          console.warn('[EmployeeAuth] Could not check existing grants (non-blocking):', e.message);
        }

        if (alreadyHasGrant) {
          console.log(`[EmployeeAuth] ℹ️ SecurityClearanceGrant already exists for ${email} (${clearanceLevel}), skipping issuance`);
        } else {
          const grantedAt = new Date().toISOString();
          const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
          const credentialOffer = {
            issuingDID: employerCompany.did,
            connectionId: enterpriseConnectionId,
            schemaId: `${MULTITENANCY_CLOUD_AGENT_URL}/schema-registry/schemas/${SECURITY_CLEARANCE_GRANT_SCHEMA_GUID}`,
            credentialFormat: 'JWT',
            // subjectId sets JWT payload.sub to the holder's PRISM DID so that subject
            // consistency checks work correctly when the VC is presented in a VP alongside
            // other enterprise credentials (without it the agent defaults to the peer DID).
            subjectId: prismDid || undefined,
            claims: {
              credentialType: 'SecurityClearanceGrant',
              clearanceLevel: clearanceLevel.toUpperCase(),
              holderDID: prismDid || '',
              issuerDID: employerCompany.did,
              grantedAt,
              validUntil,
            },
            automaticIssuance: true,
            awaitConfirmation: false
          };

          cloudAgentRequest(employerCompany.apiKey, '/issue-credentials/credential-offers', {
            method: 'POST',
            body: JSON.stringify(credentialOffer)
          }).then(result => {
            console.log(`[EmployeeAuth] ✅ SecurityClearanceGrant VC issued for ${email} (${clearanceLevel}), recordId: ${result.data?.recordId}`);
          }).catch(err => {
            console.error(`[EmployeeAuth] ⚠️ SecurityClearanceGrant issuance failed (non-blocking):`, err.message);
          });
        }
      }
    }

    res.json({
      success: true,
      sessionToken,
      employee: {
        prismDid,
        employeeId,
        role,
        department,
        fullName: session.fullName,
        email: session.email
      },
      training: {
        hasValidTraining: trainingStatus.hasValidTraining,
        expiryDate: trainingStatus.expiryDate,
        completionDate: trainingStatus.completionDate
      },
      clearance: {
        hasClearanceVC,
        level: clearanceLevel
      },
      message: 'Authentication successful'
    });

  } catch (error) {
    console.error('[EmployeeAuth] Error verifying presentation:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to verify authentication'
    });
  }
});

/**
 * GET /api/employee-portal/profile
 * Get employee profile (requires authentication)
 */
app.get('/api/employee-portal/profile', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;

  // Training status reflects only what was presented in the login VP.
  // No live cloud-agent fallback — the employee must present the CISTraining VC to gain access.

  res.json({
    success: true,
    employee: {
      prismDid: session.prismDid,
      employeeId: session.employeeId,
      role: session.role,
      department: session.department,
      fullName: session.fullName,
      email: session.email
    },
    employeeRoleVC: {
      credentialSubject: {
        issuerDID: session.issuerDID,
        employeeId: session.employeeId,
        role: session.role,
        department: session.department,
        prismDid: session.prismDid
      }
    },
    clearance: {
      level: session.clearanceLevel || null,
      hasClearanceVC: session.hasClearanceVC || false
    },
    training: {
      hasValidTraining: session.hasTraining,
      expiryDate: session.trainingExpiryDate
    },
    photoUrl: session.photoUrl || null,
    lastNameMismatch: session.lastNameMismatch || false,
    lastNameCurrent: session.lastNameCurrent || null,
    session: {
      authenticatedAt: new Date(session.authenticatedAt).toISOString(),
      lastActivity: new Date(session.lastActivity).toISOString()
    }
  });
});

/**
 * POST /api/employee-portal/auth/logout
 * Logout and destroy session
 */
app.post('/api/employee-portal/auth/logout', requireEmployeeSession, (req, res) => {
  const token = req.headers['x-session-token'];
  const session = req.employeeSession;

  // Remove session
  employeeSessions.delete(token);

  console.log(`[EmployeeAuth] Logout: ${session.email} (${session.employeeId})`);

  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// ── DIDComm Access Request Webhooks ───────────────────────────────────────────

function handleDIDCommWebhook(didCommService, companyLabel) {
  return express.Router().post('/', express.json(), async (req, res) => {
    const type = req.body?.type || '(unknown)';
    console.log(`🔔 [DIDCommWebhook/${companyLabel}] Event: ${type}`);

    if (type === 'BasicMessageReceived' && req.body?.data) {
      const { content, from: senderId, connectionId: eventConnId, id: eventId } = req.body.data;
      let actualContent = content || '';
      try {
        const stdBody = JSON.parse(actualContent);
        if (stdBody && typeof stdBody.content === 'string') actualContent = stdBody.content;
      } catch (_) {}
      didCommService.handleIncomingMessage(senderId, actualContent).catch(e =>
        console.error(`[DIDCommWebhook/${companyLabel}] handleIncomingMessage error:`, e.message)
      );
      // Feed admin inbox so admin chat shows employee messages.
      // connectionId is absent from BasicMessageReceived payloads — resolve from sender DID.
      const resolvedConnId = eventConnId || await didCommService.cfg.resolveConnection(senderId).catch(() => null);
      if (resolvedConnId && actualContent) {
        const adminMsgs = adminInbox.get(resolvedConnId) || [];
        adminMsgs.push({
          from: 'employee',
          fromLabel: resolvedConnId.slice(0, 8),
          content: actualContent,
          timestamp: Date.now(),
          messageId: eventId || crypto.randomUUID(),
          sentByAdmin: false
        });
        adminInbox.set(resolvedConnId, adminMsgs.slice(-MAX_ADMIN_MSGS));
        console.log(`[DIDCommWebhook/${companyLabel}] BasicMessage → adminInbox[${resolvedConnId.slice(0, 8)}]: ${actualContent.substring(0, 50)}`);
      }
      // Also push into test event store so test scripts can poll for delivery
      const testEvent = { ...req.body, _receivedAt: Date.now(), _company: companyLabel };
      multitenancyTestEvents.push(testEvent);
      if (multitenancyTestEvents.length > MAX_TEST_EVENTS) multitenancyTestEvents.shift();
    }

    res.status(200).json({ received: true });
  });
}

companyPortalRegistry.mountAllWebhooks(app, handleDIDCommWebhook);

/**
 * GET /api/enterprise-portal/grant-status?requestId=<the original service-access/1.0/request id>
 * Wallet polls this after sending an access request, for connections managed over the
 * enterprise agent (a REST-only channel the wallet's own DIDComm inbox can't observe messages
 * on — see packages/service-access-didcomm/PROTOCOL.md "Optional alternate transport").
 * ServiceAccessService.consumeGrant stores the outcome keyed by requestId; one-shot.
 */
app.get('/api/enterprise-portal/grant-status', (req, res) => {
  const key = req.query.requestId || req.query.proofId;
  if (!key) return res.status(400).json({ success: false, error: 'Missing requestId' });

  const result = companyPortalRegistry.consumeGrant(key);
  if (result?.grant) {
    console.log(`[EnterprisePortalGrant] Grant consumed for key ${String(key).slice(0, 12)}...: ${result.grant.accessUrl}`);
    return res.json({ success: true, grant: result.grant });
  }
  if (result?.error) {
    console.warn(`[EnterprisePortalGrant] Error result for key ${String(key).slice(0, 12)}...: ${result.error}`);
    return res.json({ success: false, error: result.error, message: result.message });
  }
  res.json({ success: false });
});

// ── DIDComm Access Token Redemption ──────────────────────────────────────────

app.get('/api/access', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(accessDeniedPage('Missing token parameter.'));

  const found = companyPortalRegistry.getToken(token);
  const entry = found ? found.entry : null;
  if (!entry)              return res.status(404).send(accessDeniedPage('Token not found. It may have expired or never existed.'));
  if (entry.used)          return res.status(410).send(accessDeniedPage('This access link has already been used. Request a new one from your wallet.'));
  if (Date.now() > entry.expiresAt) return res.status(410).send(accessDeniedPage('This access link has expired. Request a new one from your wallet.'));
  const entryCompanyId = found ? found.companyId : null;
  const entryCompany = entryCompanyId ? getAllCompanies().find(c => c.id === entryCompanyId) : null;

  entry.used = true;

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const claims = entry.userClaims || {};
  let prismDid = claims.prismDid || null;

  // When _extractClaims doesn't find prismDid/email in the VP, look the employee up by
  // techcorp_connection_id (always present in the token entry).
  const isEmployeePortalTarget = entry.redirectPath?.includes('employee-portal-dashboard');
  if (isEmployeePortalTarget && (!prismDid || !claims.email)) {
    try {
      const { Pool } = require('pg');
      const _pool = new Pool({
        host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
        port: process.env.ENTERPRISE_DB_PORT || 5434,
        database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
        user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
        password: process.env.ENTERPRISE_DB_PASSWORD,
      });
      const empRow = await _pool.query(
        `SELECT email, full_name, prism_did FROM employee_portal_accounts
         WHERE techcorp_connection_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [entry.connectionId]
      );
      await _pool.end();
      const emp = empRow.rows[0];
      if (emp) {
        if (!prismDid)     prismDid       = emp.prism_did || null;
        if (!claims.email) claims.email   = emp.email     || null;
        if (!claims.fullName && !claims.firstName) claims.fullName = emp.full_name || null;
        console.log(`[DIDCommAccess] Resolved employee from DB for ${emp.email}`);
      }
    } catch (e) {
      console.warn(`[DIDCommAccess] DB lookup failed: ${e.message}`);
    }
  }

  // Extract training and clearance from the VP that was presented.
  // _extractClaims now returns { ...employeeRoleClaims, cisTraining: {...}|null, clearance: {...}|null }
  // Fall back to cloud-agent lookups only when the VP carried no such VCs (e.g. older wallets).
  let trainingStatus = { hasValidTraining: false, expiryDate: null };
  let clearanceGrant = { hasClearance: false, level: null };

  if (claims.cisTraining) {
    trainingStatus = { hasValidTraining: claims.cisTraining.hasValidTraining, expiryDate: claims.cisTraining.expiryDate };
    console.log(`[DIDCommAccess] CIS Training from VP: ${trainingStatus.hasValidTraining ? 'valid' : 'expired/missing'}`);
  } else {
    console.log(`[DIDCommAccess] No CIS Training VC in presentation → routing to training page`);
  }

  if (claims.clearance) {
    clearanceGrant = { hasClearance: claims.clearance.hasClearanceVC, level: claims.clearance.level };
    console.log(`[DIDCommAccess] Clearance from VP: ${clearanceGrant.level}`);
  } else {
    console.log(`[DIDCommAccess] No clearance VC in presentation → no clearance access`);
  }

  // Resolve photo from DB metadata (photoDid stored during personal wallet onboarding).
  // Also check RealPersonIdentity revocation before granting access.
  let photoUrl = null;
  const sessionEmail = claims.email || null;
  if (sessionEmail && process.env.ENTERPRISE_DB_PASSWORD) {
    try {
      const empDb = getEnterpriseDb();
      const empRecord = await empDb.getEmployeeByEmail(sessionEmail);
      if (empRecord?.metadata) {
        let meta = empRecord.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }

        // Check RealPersonIdentity revocation before allowing login
        const rpCs = meta?.realPersonCredentialStatus;
        if (rpCs?.statusListCredential && rpCs?.statusListIndex != null) {
          try {
            const StatusListService = require('./lib/StatusListService');
            const rev = await StatusListService.checkByCredentialStatus(rpCs);
            if (rev.isRevoked) {
              console.error(`[DIDCommAccess] DENIED — RealPersonIdentity VC revoked for ${sessionEmail}`);
              return res.status(403).send(accessDeniedPage('Your identity credential has been revoked. Please contact your administrator.'));
            }
          } catch (revErr) {
            console.warn(`[DIDCommAccess] RealPersonIdentity revocation check failed (non-fatal): ${revErr.message}`);
          }
        }

        if (meta.photoDid) {
          photoUrl = await resolveLinkedPhotoDID(meta.photoDid);
          if (photoUrl) console.log(`[DIDCommAccess] Photo resolved via stored photoDid for ${sessionEmail}`);
        }
      }
    } catch (photoErr) {
      console.warn(`[DIDCommAccess] Photo resolution failed (non-fatal): ${photoErr.message}`);
    }
  }

  // Fallback: photo DID embedded directly in the EmployeeRole VC (set when wallet was created
  // with preloadedRealPersonClaims). Covers employees whose DB metadata.photoDid was never
  // persisted due to the ordering bug (UPDATE before INSERT).
  if (!photoUrl && claims.photo) {
    try {
      photoUrl = await resolveLinkedPhotoDID(claims.photo);
      if (photoUrl) console.log(`[DIDCommAccess] Photo resolved via EmployeeRole VC claims.photo for ${sessionEmail}`);
    } catch (e) {
      console.warn(`[DIDCommAccess] claims.photo resolution failed (non-fatal): ${e.message}`);
    }
  }

  employeeSessions.set(sessionToken, {
    sessionToken,
    connectionId:   entry.connectionId,
    prismDid,
    employeeId:     claims.email       || prismDid || 'unknown',
    role:           claims.role        || null,
    department:     claims.department  || null,
    fullName:       claims.fullName    || [claims.firstName, claims.lastName].filter(Boolean).join(' ') || claims.email || 'Employee',
    email:          claims.email       || null,
    issuerDID:      entryCompany?.did || null,
    hasTraining:    trainingStatus.hasValidTraining,
    trainingExpiryDate: trainingStatus.expiryDate || null,
    clearanceLevel: clearanceGrant.level,
    hasClearanceVC: clearanceGrant.hasClearance,
    photoUrl,
    lastNameMismatch: false,
    lastNameCurrent: null,
    authenticatedAt: Date.now(),
    lastActivity:    Date.now(),
    loginMethod:    'didcomm-access-request'
  });

  let redirectPath = entry.redirectPath;
  if (isEmployeePortalTarget && !trainingStatus.hasValidTraining) {
    redirectPath = redirectPath.replace('employee-portal-dashboard.html', 'employee-training.html');
    console.log(`[DIDCommAccess] No CIS training for ${claims.email || prismDid} → redirecting to training page`);
  }

  console.log(`[DIDCommAccess] Token redeemed: ${token.slice(0, 12)}... → session ${sessionToken.slice(0, 12)}... → ${redirectPath}`);
  res.redirect(302, `${redirectPath}?session=${encodeURIComponent(sessionToken)}`);
});

function accessDeniedPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2rem;max-width:480px;text-align:center}
h2{color:#f87171;margin-top:0}p{color:#94a3b8;margin-bottom:0}</style></head>
<body><div class="box"><h2>⛔ Access Denied</h2><p>${msg}</p></div></body></html>`;
}

// Background loop: auto-send proof request when connection establishes, then auto-issue VC
//
// CONCURRENCY NOTE: this loop ticks every 4s, but a single connectionId's processing can take
// far longer than that (createEmployeeWallet's full 13-step flow alone runs ~25s). setInterval
// does not wait for a previous tick's async callback to finish, so without an explicit lock,
// several overlapping ticks can all reach the same connectionId's entry while an earlier tick
// is still mid-flight (suspended at an `await`), each independently passing the in-data
// 'issuing'/'enterpriseOnboardingStarted' checks before any of them has actually written the
// updated flag back — those checks are state written by *this* async body, so they only
// protect against re-entry *after* being set, not concurrent entry *before* that point. This
// previously produced two full createEmployeeWallet() runs (and two live DIDComm connections)
// for the same employee from a single onboarding trigger. _autoProofProcessing below is a
// separate, tick-external lock: acquired synchronously the instant a connectionId is picked up
// (before any `await`), and released in `finally` regardless of outcome — so a later tick can
// only ever see a fully-settled state for that connectionId, never a half-finished one.
const _autoProofProcessing = new Set();

setInterval(async () => {
  if (!global.pendingInvitations || global.pendingInvitations.size === 0) return;

  for (const [connectionId, data] of global.pendingInvitations) {
    // Skip terminal states and 'issuing' (in-progress lock)
    if (data.proofState === 'complete' || data.proofState === 'failed' || data.proofState === 'issuing') continue;

    const company = getCompany(data.companyId);
    if (!company) continue;

    if (_autoProofProcessing.has(connectionId)) continue; // a previous, still-running tick owns this one
    _autoProofProcessing.add(connectionId);

    try {
      if (!data.proofState) {
        // Step 1: check if connection has been established
        const connResult = await cloudAgentRequest(company.apiKey, `/connections/${connectionId}`);
        const connState = connResult.data?.state;

        if (connState === 'ConnectionResponseSent' || connState === 'Active') {
          // Lock immediately so next tick won't send a second proof request
          data.proofState = 'sending';
          global.pendingInvitations.set(connectionId, data);

          // Challenge is stored (not just generated inline) so the presentation's own nonce
          // claim can be checked against it later — see the nonce/replay check below. Domain is
          // per-company (not a single shared 'identuslabel.cz') so a captured presentation for
          // one company's onboarding challenge can't be replayed against another's.
          const challenge = crypto.randomBytes(32).toString('hex');
          const domain = `realperson.${company.id}.identuslabel.cz`;
          const proofResult = await cloudAgentRequest(
            company.apiKey,
            '/present-proof/presentations',
            {
              method: 'POST',
              body: JSON.stringify({
                connectionId,
                proofs: [],
                options: { challenge, domain },
                goalCode: 'present-vp',
                goal: 'Share your RealPersonIdentity credential for employee onboarding',
                credentialFormat: 'JWT'
              })
            }
          );
          data.presentationId = proofResult.data?.presentationId || proofResult.data?.thid || proofResult.data?.id;
          if (!data.presentationId) throw new Error('No presentationId in response');
          data.proofState = 'requested';
          data.proofSentAt = Date.now();
          data.proofChallenge = challenge;
          data.proofResetCount = data.proofResetCount || 0;
          global.pendingInvitations.set(connectionId, data);
          console.log(`[AUTO-PROOF] Proof request sent for connection ${connectionId.substring(0,8)}..., presentationId: ${data.presentationId}`);
        }
      } else if (data.proofState === 'requested') {
        // Step 2: poll for proof completion
        const presResult = await cloudAgentRequest(
          company.apiKey,
          `/present-proof/presentations/${data.presentationId}`
        );
        const state = presResult.data?.status;

        if (state === 'PresentationVerified' || state === 'PresentationReceived') {
          // Lock immediately — prevents concurrent ticks from re-entering this block
          data.proofState = 'issuing';
          global.pendingInvitations.set(connectionId, data);

          const vpJwt = Array.isArray(presResult.data?.data) ? presResult.data.data[0] : (presResult.data?.data || presResult.data?.presentation || null);
          const claims = await verifyAndExtractRealPersonClaims(vpJwt, data.proofChallenge);

          const fullName = [claims.firstName, claims.lastName].filter(Boolean).join(' ');
          const existingEmails = getExistingEmailsForCompany(company.id);
          // Reuse the pre-stored email (set when personal wallet invitation was auto-created after
          // enterprise onboarding) so we don't generate a conflicting second email.
          const email = data.email || generateEmployeeEmail(fullName || 'employee', company.id, existingEmails);
          const portalBaseUrl = process.env.COMPANY_PORTAL_BASE_URL || 'https://identuslabel.cz/company-admin';

          data.name = fullName;
          data.email = email;
          data.uniqueId = claims.uniqueId;
          data.photo = claims.photo;
          data.credentialStatus = claims.credentialStatus || null;
          data.portalUrl = `${portalBaseUrl}/employee-portal-login.html?email=${encodeURIComponent(email)}`;
          global.pendingInvitations.set(connectionId, data);

          // Persist photoDID + credentialStatus so every subsequent login can resolve the photo
          // and check RealPersonIdentity revocation without requiring re-presentation.
          if ((claims.uniqueId || claims.photo) && process.env.ENTERPRISE_DB_PASSWORD) {
            try {
              const empDb = getEnterpriseDb();
              await empDb.updateEmployeeRealPersonData(email, claims.uniqueId, claims.photo, claims.credentialStatus);
              console.log(`[AUTO-PROOF] Persisted RealPerson data (photoDid + credentialStatus) for ${email}`);
            } catch (dbErr) {
              console.warn(`[AUTO-PROOF] Could not persist RealPerson data to DB: ${dbErr.message}`);
            }
          }

          // SSI-compliant enterprise onboarding gate: EmployeeRole VC is only issued AFTER
          // the personal wallet has presented the RealPerson VC and photoDID is in DB.
          // Pass realPersonClaims so photo is embedded directly in the EmployeeRole VC.
          //
          // This wallet creation runs BEFORE issueServiceConfigVC (and its result is passed
          // into that call below) rather than each independently calling createEmployeeWallet.
          // They used to run as two separate full 14-step onboarding flows for the same
          // employee — two wallets, two PRISM DIDs, two EmployeeRole VCs, with whichever DB
          // write landed last silently winning — and the second one always passed
          // companyDID=null (falling back to TECHCORP_PRISM_DID), so every ACME/EvilCorp
          // employee's "canonical" EmployeeRole VC falsely claimed TechCorp as issuer. One
          // wallet, created once with the correct companyDID, fixes both.
          let employeeWallet = null;
          if (data.triggerEnterpriseOnboarding && !data.enterpriseOnboardingStarted) {
            data.enterpriseOnboardingStarted = true;
            global.pendingInvitations.set(connectionId, data);
            const rpClaims = {
              uniqueId:  data.uniqueId  || null,
              photo:     data.photo     || null,
              firstName: claims.firstName || null,
              lastName:  claims.lastName  || null,
            };
            // Awaited (not fire-and-forget): previously this ran without awaiting and
            // `proofState` was set to 'complete' unconditionally right after, regardless of
            // whether wallet creation actually succeeded — a failure here (or the process
            // exiting mid-flight) left the employee permanently marked done with no wallet and
            // no credential, and no way to retry since 'complete' is a terminal state the loop
            // skips forever. Now a thrown error here falls through to this loop's own outer
            // catch block, which already handles the 'issuing' → 'failed' transition correctly.
            employeeWallet = await EmployeeWalletManager.createEmployeeWallet(
              { email, name: fullName, department: data.department || 'IT' },
              company, // full employer config — the EmployeeRole VC is now cryptographically
              // signed with company.did (previously always signed with TechCorp's DID
              // regardless of the employee's real employer; see EmployeeWalletManager.js)
              rpClaims
            );
            console.log(`[AUTO-PROOF] ✅ Enterprise wallet created for ${email}: walletId=${employeeWallet.walletId}`);
            // DB row now exists — persist photoDid (the earlier call found no row). Best-effort:
            // a failure here is logged but doesn't undo the wallet creation that already succeeded.
            if ((data.uniqueId || data.photo) && process.env.ENTERPRISE_DB_PASSWORD) {
              try {
                const empDb = getEnterpriseDb();
                await empDb.updateEmployeeRealPersonData(email, data.uniqueId, data.photo, data.credentialStatus);
                console.log(`[AUTO-PROOF] ✅ photoDid persisted for ${email} (post-wallet-creation)`);
              } catch (e) {
                console.warn(`[AUTO-PROOF] photoDid post-persist failed: ${e.message}`);
              }
            }
          }

          await issueServiceConfigVC(connectionId, fullName, email, data.department || '', company, claims, employeeWallet);

          data.proofState = 'complete';
          global.pendingInvitations.set(connectionId, data);
          console.log(`[AUTO-PROOF] Complete for ${connectionId.substring(0,8)}...: ${fullName} (${email})`);

        } else if (['ProblemReported', 'RequestRejected', 'PresentationRejected'].includes(state)) {
          data.proofState = 'failed';
          data.proofError = `Presentation ${state}`;
          global.pendingInvitations.set(connectionId, data);
          console.warn(`[AUTO-PROOF] Failed for ${connectionId.substring(0,8)}...: ${state}`);
        } else if (state === 'RequestSent' && (!data.proofSentAt || Date.now() - data.proofSentAt > 3 * 60 * 1000)) {
          // Proof request stuck in RequestSent — either no timestamp (legacy) or >3 min old.
          // Wallet likely never received the request (e.g. mediator routing not yet set up).
          // Bounded retry: each reset creates a brand-new presentationId/challenge, so an old,
          // still-outstanding request can no longer succeed against the new challenge (the
          // nonce check in verifyAndExtractRealPersonClaims rejects it) — this is a real retry,
          // not a duplicate-issuance risk. But retrying forever for a permanently-unreachable
          // wallet would poll the Cloud Agent indefinitely, so cap it and mark 'failed' instead.
          data.proofResetCount = (data.proofResetCount || 0) + 1;
          if (data.proofResetCount > 5) {
            data.proofState = 'failed';
            data.proofError = 'Proof request timed out after 5 attempts — wallet never responded';
            global.pendingInvitations.set(connectionId, data);
            console.warn(`[AUTO-PROOF] Giving up on ${connectionId.substring(0,8)}... after ${data.proofResetCount} timed-out attempts`);
          } else {
            data.proofState = null;
            data.presentationId = null;
            data.proofSentAt = null;
            data.proofChallenge = null;
            global.pendingInvitations.set(connectionId, data);
            console.warn(`[AUTO-PROOF] Proof request timed out for ${connectionId.substring(0,8)}... (RequestSent >3min) — retry ${data.proofResetCount}/5`);
          }
        }
      }
    } catch (err) {
      console.error(`[AUTO-PROOF] Error processing ${connectionId.substring(0,8)}...: ${err.message}`);
      // 'sending' lock failed before we got a presentationId — safe to retry
      if (data.proofState === 'sending') {
        data.proofState = null;
        global.pendingInvitations.set(connectionId, data);
      }
      // 'issuing' lock failed during VC issuance — mark failed, do not retry
      if (data.proofState === 'issuing') {
        data.proofState = 'failed';
        data.proofError = err.message;
        global.pendingInvitations.set(connectionId, data);
      }
      // Initial connection-lookup itself failed (data.proofState still falsy — never even
      // reached 'sending'). Unlike the two states above, this path previously had no retry cap:
      // a connection that will never exist (e.g. 404 RecordIdNotFound) was retried every 4s
      // forever, surviving restarts via pending-invitations.json persistence. Bound it the same
      // way the RequestSent-timeout path already bounds itself (5 attempts, then terminal).
      if (!data.proofState) {
        data.lookupFailCount = (data.lookupFailCount || 0) + 1;
        if (data.lookupFailCount > 5) {
          data.proofState = 'failed';
          data.proofError = `Connection lookup failed after 5 attempts: ${err.message}`;
          console.warn(`[AUTO-PROOF] Giving up on ${connectionId.substring(0,8)}... after ${data.lookupFailCount} failed connection lookups`);
        }
        global.pendingInvitations.set(connectionId, data);
      }
    } finally {
      _autoProofProcessing.delete(connectionId);
    }
  }
}, 4000);

// Periodic cleanup of expired sessions
setInterval(() => {
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [token, session] of employeeSessions) {
    if (session.authenticatedAt < fourHoursAgo) {
      employeeSessions.delete(token);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[EmployeeAuth] Cleaned up ${cleaned} expired sessions`);
  }
}, 60 * 60 * 1000); // Run every hour

// ============================================================================
// Employee Training Endpoints
// ============================================================================

/**
 * POST /api/employee-portal/training/complete
 * Submit training completion and issue CIS Training Certificate
 */
app.post('/api/employee-portal/training/complete', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;

  try {
    console.log(`[Training] Completion submitted by: ${session.email} (${session.employeeId})`);

    // Check if already has valid training
    if (session.hasTraining) {
      return res.status(400).json({
        success: false,
        error: 'AlreadyCompleted',
        message: 'You have already completed training'
      });
    }

    // Get employee's DIDComm connection to TechCorp from session
    // (Already verified during login authentication)
    const connectionId = session.connectionId;

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        error: 'NoConnection',
        message: 'No DIDComm connection found. Please log in again.'
      });
    }

    console.log(`[Training] Using connection: ${connectionId}`);

    // Resolve the employee's actual employer from the session's issuerDID (falls back to
    // techcorp for legacy sessions predating issuerDID storage) — the connectionId above
    // lives on the employer's own tenant wallet on the multitenancy Cloud Agent, so
    // issuance must use that same tenant's apiKey/did or it 404s (RecordIdNotFound).
    const employerCompany = resolveEmployerCompany(session.issuerDID);
    if (!employerCompany) {
      throw new Error('Employer company not found');
    }

    // Generate certificate details
    const completionDate = new Date();
    const expiryDate = new Date(completionDate);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Valid for 1 year

    const certificateNumber = `CIS-${Date.now()}-${session.employeeId}`;
    const trainingYear = completionDate.getFullYear().toString();

    // Get cached CIS Training schema GUID
    const schemaManager = new SchemaManager(employerCompany.apiKey, MULTITENANCY_CLOUD_AGENT_URL);
    const schemaCache = await schemaManager.loadCache();

    if (!schemaCache.cisTrainingSchemaGuid) {
      throw new Error('CIS Training schema not registered. Run register-schemas.js first.');
    }

    const schemaGuid = schemaCache.cisTrainingSchemaGuid;

    // Build credential claims
    const claims = {
      prismDid: session.prismDid,
      employeeId: session.employeeId,
      trainingYear,
      completionDate: completionDate.toISOString(),
      certificateNumber,
      expiryDate: expiryDate.toISOString()
    };

    console.log('[Training] Issuing CIS Training Certificate:', {
      employeeId: session.employeeId,
      connectionId,
      certificateNumber,
      expiryDate: expiryDate.toISOString()
    });

    // Issue credential via Cloud Agent
    const credentialOffer = {
      issuingDID: employerCompany.did, // Employer's PRISM DID for signing the credential
      connectionId,
      schemaId: `${MULTITENANCY_CLOUD_AGENT_URL}/schema-registry/schemas/${schemaGuid}`,
      credentialFormat: 'JWT',
      claims,
      automaticIssuance: true, // Auto-approve after employee accepts
      awaitConfirmation: false
    };

    const result = await cloudAgentRequest(
      employerCompany.apiKey,
      '/issue-credentials/credential-offers',
      {
        method: 'POST',
        body: JSON.stringify(credentialOffer)
      }
    );

    if (!result.success) {
      throw new Error('Failed to create credential offer');
    }

    const vcRecordId = result.data.recordId;

    console.log(`[Training] CIS Training VC offer created: ${vcRecordId}`);

    // Update session with training status
    session.hasTraining = true;
    session.trainingExpiryDate = expiryDate.toISOString();
    session.trainingCompletionDate = completionDate.toISOString();
    session.trainingCertificateNumber = certificateNumber;

    res.json({
      success: true,
      message: 'Training completion submitted. Certificate is being issued.',
      vcRecordId,
      certificate: {
        certificateNumber,
        completionDate: completionDate.toISOString(),
        expiryDate: expiryDate.toISOString()
      }
    });

  } catch (error) {
    console.error('[Training] Error submitting training completion:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to submit training completion'
    });
  }
});

/**
 * GET /api/employee-portal/training/status/:recordId
 * Check status of CIS Training Certificate issuance
 */
app.get('/api/employee-portal/training/status/:recordId', requireEmployeeSession, async (req, res) => {
  const { recordId } = req.params;
  const session = req.employeeSession;

  try {
    // Resolve the employee's actual employer from the session's issuerDID (falls back to
    // techcorp for legacy sessions predating issuerDID storage) — must match whichever
    // tenant the credential-offer above was actually created on.
    const employerCompany = resolveEmployerCompany(session.issuerDID);
    if (!employerCompany) {
      throw new Error('Employer company not found');
    }

    // Query Cloud Agent for credential record status
    const result = await cloudAgentRequest(
      employerCompany.apiKey,
      `/issue-credentials/records/${recordId}`
    );

    if (!result.success) {
      throw new Error('Failed to retrieve credential status');
    }

    const record = result.data;

    console.log(`[Training] VC status check: ${recordId} - State: ${record.protocolState}`);

    res.json({
      success: true,
      recordId: record.recordId,
      state: record.protocolState,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });

  } catch (error) {
    console.error('[Training] Error checking training status:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to check training status'
    });
  }
});

/**
 * GET /api/employee-portal/releasable-options
 * Returns the caller's own company plus its admin-managed "Releasable To"
 * partner list, for rendering the document-upload modal's checkbox list.
 * Company identity is derived exclusively from the verified session's
 * issuerDID (via resolveEmployerCompany) — never from client-supplied input.
 *
 * SECURITY: resolveEmployerCompany() silently falls back to techcorp when
 * issuerDID is missing or matches no known company (documented as covering
 * legacy sessions predating issuerDID storage). That fallback is appropriate
 * for the credential-issuance routes it was designed for (they need *some*
 * tenant apiKey to proceed), but this route discloses company-identifying
 * data (another tenant's admin-curated partner names + DIDs) — trusting a
 * silent fallback here would leak techcorp's specific partner list to a
 * session that was never confirmed to belong to techcorp. Only the branch
 * where session.issuerDID actually matches the resolved company's own DID is
 * trusted; anything else returns an empty partner list rather than another
 * tenant's data.
 */
app.get('/api/employee-portal/releasable-options', requireEmployeeSession, (req, res) => {
  try {
    const session = req.employeeSession;
    const employerCompany = resolveEmployerCompany(session.issuerDID);
    if (!employerCompany) {
      throw new Error('Employer company not found');
    }

    const isConfidentMatch = !!session.issuerDID && prismDidsMatch(session.issuerDID, employerCompany.did);
    if (!isConfidentMatch) {
      console.warn(`[ReleasableOptions] issuerDID (${session.issuerDID || 'none'}) did not confidently match a known company — returning empty partner list rather than falling back to ${employerCompany.id}`);
      return res.json({
        success: true,
        ownCompany: { name: 'Your Company', did: session.issuerDID || null },
        partners: []
      });
    }

    const partners = ReleasablePartnersRegistry.getPartnersForCompany(employerCompany.id)
      .filter(p => p.did !== employerCompany.did);

    res.json({
      success: true,
      ownCompany: { name: employerCompany.name, did: employerCompany.did },
      partners
    });
  } catch (error) {
    console.error('[ReleasableOptions] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to load releasable-to options'
    });
  }
});

// ============================================================================
// Employee Portal - Document Creation
// ============================================================================

/**
 * POST /api/employee-portal/documents/create
 * Create a new document DID and register it in the Document Registry
 *
 * Request Body:
 * - title: Document title (required)
 * - description: Document description (required)
 * - classificationLevel: INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET (required)
 * - releasableTo: Array of company names (required) - only TechCorp and ACME allowed
 *
 * Returns: Document DID and registration confirmation
 */
app.post('/api/employee-portal/documents/create', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;

  console.log('\n' + '='.repeat(80));
  console.log('📄 [DocumentCreate] New document creation request');
  console.log('   Employee:', session.email);
  console.log('   Department:', session.department);
  console.log('='.repeat(80));

  try {
    const { title, description, classificationLevel, releasableTo } = req.body;

    // Validate required fields
    if (!title || !description || !classificationLevel || !releasableTo) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Missing required fields: title, description, classificationLevel, releasableTo'
      });
    }

    // Validate classification level
    const validClassifications = ['UNCLASSIFIED', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
    if (!validClassifications.includes(classificationLevel)) {
      return res.status(400).json({
        success: false,
        error: 'InvalidClassification',
        message: `Classification must be one of: ${validClassifications.join(', ')}`
      });
    }

    // Validate releasableTo is an array
    if (!Array.isArray(releasableTo) || releasableTo.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'InvalidReleasability',
        message: 'releasableTo must be a non-empty array of company names'
      });
    }

    // Validate only TechCorp and ACME are allowed
    const allowedCompanies = ['TechCorp Corporation', 'ACME Corporation'];
    const invalidCompanies = releasableTo.filter(company => !allowedCompanies.includes(company));

    if (invalidCompanies.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'InvalidReleasability',
        message: `Only TechCorp Corporation and ACME Corporation are allowed. Invalid: ${invalidCompanies.join(', ')}`
      });
    }

    // Convert company names to issuerDIDs
    const releasableToIssuerDIDs = releasableTo.map(companyName => {
      const did = COMPANY_ISSUER_DIDS[companyName];
      if (!did) {
        throw new Error(`No issuerDID found for company: ${companyName}`);
      }
      return did;
    });

    console.log('[DocumentCreate] Validation passed:');
    console.log(`   Title: ${title}`);
    console.log(`   Classification: ${classificationLevel}`);
    console.log(`   Releasable to: ${releasableTo.join(', ')}`);
    console.log(`   Releasable to DIDs: ${releasableToIssuerDIDs.join(', ')}`);

    // Step 1: Create document DID via Enterprise Cloud Agent
    console.log('[DocumentCreate] Step 1: Creating document DID via Enterprise Cloud Agent...');

    // Get the API key for the employee's department
    const departmentApiKey = DEPARTMENT_API_KEYS[session.department];
    if (!departmentApiKey) {
      throw new Error(`No API key configured for department: ${session.department}`);
    }
    console.log(`[DocumentCreate] Using ${session.department} department API key`);

    const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, departmentApiKey);
    const documentDID = await documentManager.createDocumentDID(session.department, {
      title,
      description,
      classificationLevel,
      createdBy: session.email,
      createdByDID: session.prismDid
    });

    console.log(`[DocumentCreate] ✅ Document DID created: ${documentDID}`);

    // Step 2: Register document in DocumentRegistry
    console.log('[DocumentCreate] Step 2: Registering document in Document Registry...');

    await DocumentRegistry.registerDocument({
      documentDID,
      title,
      classificationLevel,
      releasableTo: releasableToIssuerDIDs,
      ownerCompanyDID: session.issuerDID || null,
      metadata: {
        title,
        description,
        createdBy: session.email,
        createdByDID: session.prismDid,
        department: session.department,
        createdAt: new Date().toISOString()
      },
      metadataVCRecordId: vcResult.recordId // SSI crash recovery link
    });

    console.log('[DocumentCreate] ✅ Document registered in Document Registry');

    console.log('='.repeat(80));
    console.log('✅ [DocumentCreate] Document creation completed successfully');
    console.log(`   Document DID: ${documentDID}`);
    console.log(`   Classification: ${classificationLevel}`);
    console.log(`   Discoverable by: ${releasableTo.join(', ')}`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      documentDID,
      classificationLevel,
      releasableTo,
      releasableToIssuerDIDs,
      metadata: {
        title,
        description,
        createdBy: session.email,
        department: session.department,
        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('[DocumentCreate] ❌ Error creating document:', error);
    console.error('[DocumentCreate] Error stack:', error.stack);

    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to create document'
    });
  }
});

/**
 * POST /api/employee-portal/wrap-dek
 * SSI-aligned: browser generates DEK and encrypts file locally, then calls this
 * endpoint to get the DEK wrapped with the appropriate CMK. The server wraps the
 * 32-byte key and immediately zeros it — it never stores or logs the raw DEK.
 */
app.post('/api/employee-portal/wrap-dek', requireEmployeeSession, (req, res) => {
  const { rawDEK, classificationLevel } = req.body;
  if (!rawDEK || !classificationLevel) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'rawDEK (base64) and classificationLevel are required' });
  }
  let rawBuf;
  try {
    rawBuf = Buffer.from(rawDEK, 'base64');
    if (rawBuf.length !== 32) {
      return res.status(400).json({ error: 'INVALID_DEK', message: 'rawDEK must be a 32-byte (256-bit) key encoded as base64' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'INVALID_DEK', message: 'rawDEK must be valid base64' });
  }
  try {
    const wrapped = cmk.wrapDEK(rawBuf, classificationLevel);
    rawBuf.fill(0); // zero immediately — server never persists or logs raw DEK
    return res.json({
      wrappedKey:        wrapped.wrappedKey,
      iv:                wrapped.iv,
      authTag:           wrapped.authTag,
      wrappingAlgorithm: wrapped.wrappingAlgorithm || 'AES-256-GCM'
    });
  } catch (err) {
    console.error('[wrap-dek] Error wrapping DEK:', err.message);
    return res.status(500).json({ error: 'WRAP_FAILED', message: 'Failed to wrap DEK' });
  }
});

/**
 * POST /api/employee-portal/documents/upload
 * Create a new document DID with file upload to Iagon decentralized storage
 *
 * NEW FLOW (Iagon FIRST, then DID with service endpoint):
 * 1. Upload file to Iagon → Get fileId + download URL
 * 2. Create PRISM DID with Iagon service endpoint (before blockchain publication)
 * 3. Publish DID to blockchain
 * 4. Issue DocumentMetadataVC to employee via DIDComm
 * 5. Register in DocumentRegistry
 *
 * Request: multipart/form-data
 * - file: Document file (required, max 40MB)
 * - title: Document title (required)
 * - description: Document description (required)
 * - documentType: Report | Contract | Policy | Procedure | Memo | Certificate | Other (required)
 * - classificationLevel: INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET (required)
 * - releasableTo: JSON array of company names (required)
 *
 * Returns: Document DID, Iagon storage metadata, VC record ID, and registration confirmation
 */
app.post('/api/employee-portal/documents/upload', requireEmployeeSession, upload.single('file'), async (req, res) => {
  const session = req.employeeSession;

  console.log('\n' + '='.repeat(80));
  console.log('📄 [DocumentUpload] New document upload request (Iagon-first flow)');
  console.log('   Employee:', session.email);
  console.log('   Department:', session.department);
  console.log('   Connection ID:', session.connectionId || 'NOT SET');
  console.log('='.repeat(80));

  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'No file uploaded. Use multipart/form-data with a "file" field.'
      });
    }

    const { title, description, documentType, classificationLevel, releasableTo } = req.body;

    // Parse releasableTo if it's a JSON string
    let releasableToArray;
    try {
      releasableToArray = typeof releasableTo === 'string' ? JSON.parse(releasableTo) : releasableTo;
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'InvalidReleasability',
        message: 'releasableTo must be a valid JSON array of company names'
      });
    }

    // Validate required fields (now includes documentType, description is optional)
    if (!title || !documentType || !classificationLevel || !releasableToArray) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Missing required fields: title, documentType, classificationLevel, releasableTo'
      });
    }

    // Validate document type
    const validDocumentTypes = ['Report', 'Contract', 'Policy', 'Procedure', 'Memo', 'Certificate', 'Other'];
    if (!validDocumentTypes.includes(documentType)) {
      return res.status(400).json({
        success: false,
        error: 'InvalidDocumentType',
        message: `Document type must be one of: ${validDocumentTypes.join(', ')}`
      });
    }

    // Validate classification level
    const validClassifications = ['UNCLASSIFIED', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];
    if (!validClassifications.includes(classificationLevel)) {
      return res.status(400).json({
        success: false,
        error: 'InvalidClassification',
        message: `Classification must be one of: ${validClassifications.join(', ')}`
      });
    }

    // Validate releasableTo is an array
    if (!Array.isArray(releasableToArray) || releasableToArray.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'InvalidReleasability',
        message: 'releasableTo must be a non-empty array of company names'
      });
    }

    // Validate only TechCorp and ACME are allowed
    const allowedCompanies = ['TechCorp Corporation', 'ACME Corporation'];
    const invalidCompanies = releasableToArray.filter(company => !allowedCompanies.includes(company));

    if (invalidCompanies.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'InvalidReleasability',
        message: `Only TechCorp Corporation and ACME Corporation are allowed. Invalid: ${invalidCompanies.join(', ')}`
      });
    }

    // Convert company names to issuerDIDs
    const releasableToIssuerDIDs = releasableToArray.map(companyName => {
      const did = COMPANY_ISSUER_DIDS[companyName];
      if (!did) {
        throw new Error(`No issuerDID found for company: ${companyName}`);
      }
      return did;
    });

    console.log('[DocumentUpload] Validation passed:');
    console.log(`   Title: ${title}`);
    console.log(`   Document Type: ${documentType}`);
    console.log(`   File: ${req.file.originalname} (${req.file.size} bytes)`);
    console.log(`   Classification: ${classificationLevel}`);
    console.log(`   Releasable to: ${releasableToArray.join(', ')}`);

    // Get the API key for the employee's department
    const departmentApiKey = DEPARTMENT_API_KEYS[session.department];
    if (!departmentApiKey) {
      throw new Error(`No API key configured for department: ${session.department}`);
    }
    console.log(`[DocumentUpload] Using ${session.department} department API key`);

    // =========================================================================
    // STEP 1: Upload file to Iagon FIRST (before DID creation)
    // =========================================================================
    console.log('[DocumentUpload] Step 1: Uploading file to Iagon decentralized storage...');

    const { getIagonClient } = require('./lib/IagonStorageClient');
    const iagonClient = getIagonClient();

    if (!iagonClient.isConfigured()) {
      console.warn('[DocumentUpload] ⚠️ Iagon storage not configured, proceeding without file storage');
    }

    let iagonStorage    = null;
    let wrappedManifest = null; // hoisted: needed for KeyManifest VC push in Step 5
    if (iagonClient.isConfigured()) {
      try {
        // For DOCX files: reject if any section is tagged above the uploader's own clearance.
        // The full document is stored on Iagon; per-reader redaction happens server-side
        // inside /api/access-gate/present using DocxRedactionService.
        const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (req.file.mimetype === DOCX_MIME) {
          try {
            const { parseDocxClearanceSections, CLEARANCE_LEVELS } = require('./lib/DocxClearanceParser');
            const parsed = await parseDocxClearanceSections(req.file.buffer);
            const uploaderLevelNum = CLEARANCE_LEVELS[(session.clearanceLevel || 'INTERNAL').toUpperCase()] ?? 1;
            const tooHighSection = (parsed.sections || []).find(s =>
              (CLEARANCE_LEVELS[(s.clearanceLevel || '').toUpperCase()] ?? 0) > uploaderLevelNum
            );
            if (tooHighSection) {
              return res.status(403).json({
                success: false,
                error: 'InsufficientClearance',
                message: `Document contains ${tooHighSection.clearanceLevel} sections but your clearance is ${session.clearanceLevel || 'INTERNAL'}. You cannot upload content above your own clearance level.`
              });
            }
            console.log(`[DocumentUpload] ✅ DOCX clearance check passed (uploader level: ${session.clearanceLevel || 'INTERNAL'})`);
          } catch (parseErr) {
            console.warn('[DocumentUpload] DOCX clearance check skipped (parse error):', parseErr.message);
          }
        }

        const iagonResult = await iagonClient.uploadFile(
          req.file.buffer,
          `${Date.now()}_${req.file.originalname}`,
          { classificationLevel }
        );
        console.log(`[DocumentUpload] ✅ File uploaded to Iagon: ${iagonResult.filename}`);
        console.log(`[DocumentUpload]    File ID: ${iagonResult.fileId}`);
        console.log(`[DocumentUpload]    Download URL: ${iagonResult.iagonUrl}`);

        // Task 2: Wrap DEK with CMK before persisting
        let encryptionManifestId = null;
        if (iagonResult.rawDEK) {
          try {
            wrappedManifest = cmk.wrapDEK(iagonResult.rawDEK, classificationLevel);
            iagonResult.rawDEK.fill(0); // zero raw key from memory (PFS)

            // Upload wrapped manifest to Iagon
            const { manifestFileId } = await iagonClient.uploadKeyManifest(
              wrappedManifest,
              `doc-${Date.now()}`
            );
            encryptionManifestId = manifestFileId;
            console.log(`[DocumentUpload] ✅ Key manifest uploaded to Iagon: ${encryptionManifestId}`);
          } catch (manifestErr) {
            console.error('[DocumentUpload] Failed to upload key manifest to Iagon:', manifestErr.message);
            // Continue — will fall back to legacy path during access
          }
        }

        iagonStorage = {
          fileId: iagonResult.fileId,
          nodeId: iagonResult.nodeId,
          iagonUrl: iagonResult.iagonUrl,
          filename: iagonResult.filename,
          contentHash: iagonResult.contentHash,
          encryptionManifestId: encryptionManifestId,
          encryptionInfo: iagonResult.encryptionInfo, // iv, authTag, algorithm — NO key
          uploadedAt: iagonResult.uploadedAt,
          fileSize: iagonResult.fileSize,
          originalSize: iagonResult.originalSize
        };
      } catch (iagonError) {
        console.error('[DocumentUpload] ⚠️ Iagon upload failed:', iagonError.message);
        // Continue without Iagon storage - DID will be created without service endpoint
      }
    }

    // =========================================================================
    // STEP 2: Create PRISM DID with Iagon service endpoint
    // =========================================================================
    console.log('[DocumentUpload] Step 2: Creating document DID with Iagon service endpoint...');

    const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, departmentApiKey);
    let documentDID;
    let operationId;

    if (iagonStorage && iagonStorage.fileId) {
      // Create DID WITH service endpoint (Iagon URL embedded before blockchain publication)
      const PUBLIC_URL = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
      const didResult = await documentManager.createDocumentDIDWithServiceEndpoint(
        session.department,
        {
          title,
          description,
          documentType,
          classificationLevel,
          releasableTo: releasableToIssuerDIDs,
          filename: req.file.originalname,
          createdBy: session.email,
          createdByDID: session.prismDid
        },
        {
          fileId:         iagonStorage.fileId,
          downloadUrl:    iagonStorage.iagonUrl,
          contentHash:    iagonStorage.contentHash   || null,
          encryptionInfo: iagonStorage.encryptionInfo || null
        },
        [{ id: 'document-access-gate', type: 'DocumentAccessGate', serviceEndpoint: `${PUBLIC_URL}/api/access-gate/challenge` }],
        { documentServiceUrl: req.company?.documentServiceUrl || null }
      );
      documentDID = didResult.documentDID;
      operationId = didResult.operationId;
      console.log(`[DocumentUpload] ✅ Document DID created with Iagon service endpoint: ${documentDID.substring(0, 60)}...`);
    } else {
      // Fallback: Create DID without service endpoint
      documentDID = await documentManager.createDocumentDID(session.department, {
        title,
        description,
        documentType,
        classificationLevel,
        createdBy: session.email,
        createdByDID: session.prismDid
      });
      console.log(`[DocumentUpload] ✅ Document DID created (no service endpoint): ${documentDID.substring(0, 60)}...`);
    }

    // =========================================================================
    // STEP 3: Issue DocumentMetadataVC to employee via DIDComm
    // =========================================================================
    let metadataVCRecordId = null;
    let keyManifestVCId    = null;
    let vcIssuanceWarning  = null;

    if (session.connectionId) {
      console.log('[DocumentUpload] Step 3: Issuing DocumentMetadataVC to employee via DIDComm...');

      try {
        const DocumentMetadataVC = require('./lib/DocumentMetadataVC');
        const vcIssuer = new DocumentMetadataVC(ENTERPRISE_CLOUD_AGENT_URL, departmentApiKey);

        // Get company's issuer DID for the department
        const companyName = 'TechCorp Corporation'; // Default to TechCorp for now
        const companyIssuerDID = COMPANY_ISSUER_DIDS[companyName];

        if (!companyIssuerDID) {
          throw new Error(`No issuer DID found for company: ${companyName}`);
        }

        const vcResult = await vcIssuer.issueDocumentMetadataVCToEmployee({
          connectionId: session.connectionId,
          issuerDID: companyIssuerDID,
          documentDID: documentDID,
          documentTitle: title,
          documentType: documentType,
          classificationLevel: classificationLevel,
          documentDescription: description,
          releasableTo: releasableToArray.join(', '),
          createdBy: session.email,
          createdByDID: session.prismDid,
          encryptionManifestId: iagonStorage?.encryptionManifestId
        });

        metadataVCRecordId = vcResult.recordId;
        console.log(`[DocumentUpload] ✅ DocumentMetadataVC offer created: ${metadataVCRecordId}`);
      } catch (vcError) {
        console.error('[DocumentUpload] ⚠️ Failed to issue DocumentMetadataVC:', vcError.message);
        vcIssuanceWarning = `VC issuance failed: ${vcError.message}`;
      }
    } else {
      console.log('[DocumentUpload] ⚠️ No connectionId in session - skipping VC issuance');
      vcIssuanceWarning = 'No DIDComm connection available for VC issuance';
    }

    // =========================================================================
    // STEP 4: Register document in DocumentRegistry
    // =========================================================================
    console.log('[DocumentUpload] Step 4: Registering document in Document Registry...');

    await DocumentRegistry.registerDocument({
      documentDID: documentDID,
      title,
      classificationLevel,
      releasableTo: releasableToIssuerDIDs,
      contentEncryptionKey: iagonStorage?.encryptionManifestId || 'no-encryption', // Task 2: manifest ID replaces raw key
      ownerCompanyDID: session.issuerDID || null,
      metadata: {
        title,
        description,
        documentType,
        createdBy: session.email,
        createdByDID: session.prismDid,
        department: session.department,
        originalFilename: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        metadataVCRecordId: metadataVCRecordId,
        createdAt: new Date().toISOString()
      },
      iagonStorage: iagonStorage
    });

    console.log('[DocumentUpload] ✅ Document registered in Document Registry');

    // =========================================================================
    // STEP 5: Push KeyManifest VC to document-service (versioned)
    // =========================================================================
    if (wrappedManifest && iagonStorage && documentDID) {
      try {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || null;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcIssuer = new KeyManifestVCIssuer(docServiceUrl, adminKey);

        // Fetch existing VC to derive version chain
        const prevVC = await fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey);
        const versionNumber = (prevVC?.claims?.versionNumber ?? 0) + 1;
        const predecessorHash = prevVC ? KeyManifestVCIssuer.computePredecessorHash(prevVC.vcJwt) : null;

        const vcResult = await vcIssuer.issue({
          documentDID,
          issuerDID:          session.issuerDID || process.env.SERVICE_DID,
          iagonFileId:        iagonStorage.fileId,
          classificationLevel,
          releasableTo:       releasableToIssuerDIDs,
          wrappedKey:         wrappedManifest.wrappedKey,
          iv:                 wrappedManifest.iv,
          authTag:            wrappedManifest.authTag,
          wrappingAlgorithm:  wrappedManifest.wrappingAlgorithm || 'AES-256-GCM',
          fileAlgorithm:      iagonStorage.encryptionInfo?.algorithm || 'AES-256-GCM',
          fileIv:             iagonStorage.encryptionInfo?.iv,
          fileAuthTag:        iagonStorage.encryptionInfo?.authTag,
          contentHash:        iagonStorage.contentHash || null,
          versionNumber,
          updatedBy:          session.prismDid || session.issuerDID || null,
          predecessorHash
        });

        console.log(`[DocumentUpload] ✅ KeyManifest VC v${versionNumber} pushed to document-service: ${vcResult.vcId}`);
        keyManifestVCId = vcResult.vcId;
      } catch (vcPushErr) {
        console.error('[DocumentUpload] ⚠️ Failed to push KeyManifest VC to document-service:', vcPushErr.message);
        // Non-fatal — document is stored, VC can be pushed manually
      }
    }

    // =========================================================================
    // SUCCESS RESPONSE
    // =========================================================================
    console.log('='.repeat(80));
    console.log('✅ [DocumentUpload] Document upload completed successfully');
    console.log(`   Document DID: ${documentDID.substring(0, 60)}...`);
    console.log(`   Document Type: ${documentType}`);
    console.log(`   Classification: ${classificationLevel}`);
    console.log(`   Discoverable by: ${releasableToArray.join(', ')}`);
    if (iagonStorage) {
      console.log(`   Iagon File ID: ${iagonStorage.fileId}`);
      console.log(`   Iagon Service Endpoint: ${iagonStorage.iagonUrl}`);
    }
    if (metadataVCRecordId) {
      console.log(`   DocumentMetadataVC Record ID: ${metadataVCRecordId}`);
    }
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      documentDID: documentDID,
      documentType: documentType,
      classificationLevel,
      releasableTo: releasableToArray,
      releasableToIssuerDIDs,
      iagonStorage: iagonStorage ? {
        fileId: iagonStorage.fileId,
        serviceEndpoint: iagonStorage.iagonUrl,
        filename: iagonStorage.filename,
        contentHash: iagonStorage.contentHash,
        fileSize: iagonStorage.fileSize,
        originalSize: iagonStorage.originalSize,
        uploadedAt: iagonStorage.uploadedAt
      } : null,
      metadataVCRecordId: metadataVCRecordId,
      keyManifestVCId: keyManifestVCId,
      metadata: {
        title,
        description,
        documentType,
        originalFilename: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        createdBy: session.email,
        department: session.department,
        createdAt: new Date().toISOString()
      },
      warning: vcIssuanceWarning || null
    });

  } catch (error) {
    console.error('[DocumentUpload] ❌ Error uploading document:', error);
    console.error('[DocumentUpload] Error stack:', error.stack);

    // Handle multer errors
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'FileTooLarge',
        message: 'File size exceeds maximum limit of 40MB'
      });
    }

    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to upload document'
    });
  }
});

/**
 * GET /api/employee-portal/documents/:documentDID/download
 * Download a document from Iagon decentralized storage
 *
 * Requires:
 * - Valid employee session
 * - Employee's clearance level must meet document classification
 * - Employee's company must be in document's releasableTo list
 *
 * Returns: Document file as binary download
 */
app.get('/api/employee-portal/documents/:documentDID/download', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;
  const { documentDID } = req.params;

  console.log('\n' + '='.repeat(80));
  console.log('📥 [DocumentDownload] Download request');
  console.log(`   Employee: ${session.email}`);
  console.log(`   Document DID: ${documentDID.substring(0, 60)}...`);
  console.log(`   Clearance: ${session.clearanceLevel || 'NONE (INTERNAL only)'}`);

  try {
    // Get the employee's company issuerDID
    // This should come from the session (set during employee authentication)
    const employeeIssuerDID = session.issuerDID;
    if (!employeeIssuerDID) {
      console.log('[DocumentDownload] ❌ No issuerDID in session');
      return res.status(400).json({
        success: false,
        error: 'NoIssuerDID',
        message: 'Employee session does not have a company issuerDID'
      });
    }

    // Get document from registry (includes authorization check)
    let document;
    try {
      document = await DocumentRegistry.getDocument(documentDID, employeeIssuerDID);
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log('[DocumentDownload] ❌ Document not found');
        return res.status(404).json({
          success: false,
          error: 'DocumentNotFound',
          message: 'Document not found in registry'
        });
      }
      if (error.message.includes('Unauthorized')) {
        console.log('[DocumentDownload] ❌ Access denied - company not in releasableTo list');
        return res.status(403).json({
          success: false,
          error: 'AccessDenied',
          message: 'Your company is not authorized to access this document'
        });
      }
      throw error;
    }

    // Check clearance level
    const clearanceLevels = {
      'UNCLASSIFIED': 0,
      'INTERNAL': 1,
      'CONFIDENTIAL': 2,
      'RESTRICTED': 3,
      'SECRET': 4,
      'TOP-SECRET': 4  // legacy alias
    };

    const documentLevel = clearanceLevels[document.classificationLevel] ?? 0;
    const employeeLevel = session.clearanceLevel ? (clearanceLevels[session.clearanceLevel] ?? 0) : 0;

    if (employeeLevel < documentLevel) {
      console.log(`[DocumentDownload] ❌ Insufficient clearance (has: ${session.clearanceLevel || 'NONE'}, needs: ${document.classificationLevel})`);
      return res.status(403).json({
        success: false,
        error: 'InsufficientClearance',
        message: `This document requires ${document.classificationLevel} clearance. You have ${session.clearanceLevel || 'no clearance (INTERNAL only)'}.`
      });
    }

    // Check if document has Iagon storage metadata
    if (!document.iagonStorage) {
      console.log('[DocumentDownload] ❌ Document has no Iagon storage metadata');
      return res.status(404).json({
        success: false,
        error: 'NoStorageMetadata',
        message: 'Document has no file stored on Iagon'
      });
    }

    console.log('[DocumentDownload] ✅ Authorization checks passed');
    console.log(`   Document classification: ${document.classificationLevel}`);
    console.log(`   Employee clearance: ${session.clearanceLevel || 'NONE'}`);
    console.log(`   Iagon filename: ${document.iagonStorage.filename}`);

    // Download from Iagon
    const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL);

    console.log('[DocumentDownload] Downloading from Iagon...');
    const fileContent = await documentManager.downloadDocument(document.iagonStorage);

    console.log(`[DocumentDownload] ✅ File downloaded (${fileContent.length} bytes)`);

    // Determine content type and filename
    const metadata = document.metadata || {};
    const originalFilename = metadata.originalFilename || document.iagonStorage.filename || 'document';
    const mimeType = metadata.mimeType || 'application/octet-stream';

    // Set response headers for file download
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${originalFilename}"`);
    res.setHeader('Content-Length', fileContent.length);
    res.setHeader('X-Document-DID', documentDID);
    res.setHeader('X-Classification-Level', document.classificationLevel);

    console.log('='.repeat(80));
    console.log('✅ [DocumentDownload] Download successful');
    console.log(`   Filename: ${originalFilename}`);
    console.log(`   Size: ${fileContent.length} bytes`);
    console.log(`   MIME type: ${mimeType}`);
    console.log('='.repeat(80) + '\n');

    // Send file
    res.send(fileContent);

  } catch (error) {
    console.error('[DocumentDownload] ❌ Error downloading document:', error);
    console.error('[DocumentDownload] Error stack:', error.stack);

    res.status(500).json({
      success: false,
      error: 'DownloadFailed',
      message: error.message || 'Failed to download document'
    });
  }
});

/**
 * GET /api/iagon/status
 * Check Iagon storage configuration status
 */
app.get('/api/iagon/status', async (req, res) => {
  try {
    const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL);
    const status = await documentManager.checkIagonStatus();

    res.json({
      success: true,
      iagon: status
    });
  } catch (error) {
    console.error('[IagonStatus] Error checking status:', error);
    res.status(500).json({
      success: false,
      error: 'StatusCheckFailed',
      message: error.message
    });
  }
});

// ============================================================================
// Document Registry API (Zero-Knowledge Document Discovery)
// ============================================================================

/**
 * Extract essential info from a long-form PRISM DID without a Cloud Agent round-trip.
 * Returns null if the DID is invalid or unparseable.
 */
function extractDIDInfo(documentDID) {
  try {
    const parts = documentDID.split(':');
    if (parts.length < 4 || parts[1] !== 'prism') return null;
    const encodedState = parts[parts.length - 1];
    const base64 = encodedState.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const binaryStr = Buffer.from(
      pad ? base64 + '='.repeat(4 - pad) : base64, 'base64'
    ).toString('binary');
    const m = binaryStr.match(
      /https:\/\/gw\.iagon\.com\/api\/v2\/download\?fileId=([a-f0-9]+)&filename=([^&\s"\]]+)/
    ) || binaryStr.match(
      /https:\/\/gw\.iagon\.com\/api\/v2\/download\?filename=([^&]+)&nodeId=([a-f0-9]+)/
    );
    return {
      method: 'did:prism',
      short: documentDID.substring(0, 24) + '…' + documentDID.slice(-8),
      serviceType: 'IagonStorage',
      filename: m ? decodeURIComponent(m[2] || m[1]) : null,
      fileId: m ? (m[1] || m[2]) : null
    };
  } catch { return null; }
}

/**
 * GET /api/documents/discover
 * Discover documents released to the caller's own employer.
 *
 * Query Parameters:
 * - sessionId (or x-session-id header): employee session token — required
 *
 * SECURITY: issuerDID is deliberately NOT read from the query string. It used to be, which
 * meant any authenticated employee could ask "show me <any other company>'s documents" simply
 * by changing the query parameter — the server never checked it against who was actually
 * logged in. The company being queried must come from the caller's own authenticated session,
 * exactly like every other per-employer field it exposes (clearanceLevel, department, etc.).
 *
 * Returns: Array of discoverable documents (filtered by clearance level from session)
 */
app.get('/api/documents/discover', async (req, res) => {
  try {
    const sessionIdFromQuery = req.query.sessionId;
    const sessionIdFromHeader = req.headers['x-session-id'];
    console.log(`[DocumentRegistry] Session lookup - query: ${sessionIdFromQuery?.substring(0,20)}..., header: ${sessionIdFromHeader?.substring(0,20)}...`);
    console.log(`[DocumentRegistry] Active sessions: ${employeeSessions.size}`);

    const session = employeeSessions.get(sessionIdFromQuery) || employeeSessions.get(sessionIdFromHeader);
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'A valid employee session is required to discover documents'
      });
    }

    // Authoritative company identifier — the session's own issuerDID, set at login time from
    // the employee's cryptographically-verified EmployeeRole VC. Never the query string.
    const issuerDID = session.issuerDID;
    if (!issuerDID) {
      return res.status(403).json({
        success: false,
        error: 'NoEmployer',
        message: 'Session has no associated employer DID'
      });
    }

    const clearanceLevel = session.clearanceLevel || null;

    console.log(`[DocumentRegistry] Document discovery request for issuerDID: ${issuerDID}`);
    console.log(`[DocumentRegistry] Session found: ${!!session}, clearanceLevel: ${clearanceLevel || 'NONE (INTERNAL only)'}`);

    // Query document registry by issuer DID with clearance-based filtering
    const documents = (await DocumentRegistry.queryByIssuerDID(issuerDID, clearanceLevel))
      .map(doc => ({ ...doc, didInfo: extractDIDInfo(doc.documentDID) }));

    console.log(`[DocumentRegistry] Found ${documents.length} documents for ${issuerDID}`);

    // Attach folder membership map so the frontend can group documents by folder
    const allDIDs = documents.map(d => d.documentDID);
    const folderMembership = FolderRegistry.getMembershipMapForCompany(issuerDID, allDIDs);

    res.json({
      success: true,
      documents,
      count: documents.length,
      issuerDID,
      clearanceLevel: clearanceLevel || 'UNCLASSIFIED',
      folderMembership
    });

  } catch (error) {
    console.error('[DocumentRegistry] Error discovering documents:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to discover documents'
    });
  }
});

/**
 * POST /api/documents/register
 * Register a new document in the zero-knowledge registry
 *
 * Body:
 * - documentDID: PRISM DID for the document
 * - title: Document title (will be encrypted)
 * - classificationLevel: INTERNAL|CONFIDENTIAL|RESTRICTED|TOP-SECRET
 * - releasableTo: Array of company DIDs
 * - contentEncryptionKey: Encrypted content key
 * - metadata: Additional metadata
 */
app.post('/api/documents/register', async (req, res) => {
  try {
    const {
      documentDID,
      title,
      classificationLevel,
      releasableTo,
      contentEncryptionKey,
      iagonStorage,
      ownerCompanyDID,
      metadata
    } = req.body;

    // Validate required fields
    if (!documentDID || !title || !classificationLevel || !releasableTo || !contentEncryptionKey) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Missing required fields: documentDID, title, classificationLevel, releasableTo, contentEncryptionKey'
      });
    }

    console.log(`[DocumentRegistry] Registering document: ${documentDID}`);
    console.log(`[DocumentRegistry] Title: ${title}`);
    console.log(`[DocumentRegistry] Classification: ${classificationLevel}`);
    console.log(`[DocumentRegistry] Releasable to ${releasableTo.length} companies`);
    if (iagonStorage?.fileId) console.log(`[DocumentRegistry] Iagon fileId: ${iagonStorage.fileId}`);

    // Register document in registry
    const result = await DocumentRegistry.registerDocument({
      documentDID,
      title,
      classificationLevel,
      releasableTo,
      contentEncryptionKey,
      iagonStorage:    iagonStorage    || null,
      ownerCompanyDID: ownerCompanyDID || null,
      metadata: metadata || {}
    });

    console.log(`[DocumentRegistry] Document registered successfully: ${documentDID}`);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('[DocumentRegistry] Error registering document:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to register document'
    });
  }
});

/**
 * GET /api/documents/stats
 * Get document registry statistics
 */
app.get('/api/documents/stats', async (req, res) => {
  try {
    const stats = DocumentRegistry.getStatistics();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('[DocumentRegistry] Error getting statistics:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to get statistics'
    });
  }
});

// ============================================================================
// Ephemeral Document Access Control API
// Perfect Forward Secrecy for Document Access
// ============================================================================

/**
 * GET /api/ephemeral-documents
 * List documents accessible to a requestor based on their issuer DID and clearance level
 *
 * Query Parameters:
 * - issuerDID: The issuer DID from the requestor's credential (for releasability filtering)
 * - clearanceLevel: The requestor's security clearance level (1-4)
 */
app.get('/api/ephemeral-documents', async (req, res) => {
  try {
    const { issuerDID, clearanceLevel } = req.query;

    if (!issuerDID) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'issuerDID query parameter is required'
      });
    }

    const level = clearanceLevel ? parseInt(clearanceLevel, 10) : 1;

    console.log(`[EphemeralDocuments] List request: issuerDID=${issuerDID}, clearanceLevel=${level}`);

    const documents = await ReEncryptionService.listAccessibleDocuments(issuerDID, level);

    res.json({
      success: true,
      documents,
      count: documents.length,
      issuerDID,
      clearanceLevel: level
    });

  } catch (error) {
    console.error('[EphemeralDocuments] Error listing documents:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to list documents'
    });
  }
});

/**
 * POST /api/ephemeral-documents/upload
 * Upload a new classified document
 *
 * Request Body (multipart/form-data):
 * - file: The document file
 * - title: Document title
 * - description: Document description (optional)
 * - classificationLevel: 1-4 (INTERNAL to TOP-SECRET)
 * - classificationLabel: INTERNAL|CONFIDENTIAL|RESTRICTED|TOP-SECRET
 * - releasableTo: JSON array of issuer DIDs allowed access
 * - creatorDID: PRISM DID of the document creator
 * - creatorClearanceLevel: Creator's clearance level
 * - enterprise: Enterprise identifier (e.g., 'techcorp')
 */
app.post('/api/ephemeral-documents/upload', upload.single('file'), async (req, res) => {
  try {
    const {
      title,
      description,
      classificationLevel,
      classificationLabel,
      releasableTo,
      creatorDID,
      creatorClearanceLevel,
      enterprise
    } = req.body;

    const file = req.file;

    // Validate required fields
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'File is required'
      });
    }

    if (!title || !classificationLevel || !releasableTo || !creatorDID || !enterprise) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Missing required fields: title, classificationLevel, releasableTo, creatorDID, enterprise'
      });
    }

    const level = parseInt(classificationLevel, 10);
    if (level < 1 || level > 4) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'classificationLevel must be 1-4'
      });
    }

    // Parse releasableTo (can be JSON string or array)
    let releasableArray;
    try {
      releasableArray = typeof releasableTo === 'string' ? JSON.parse(releasableTo) : releasableTo;
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'releasableTo must be a valid JSON array of DIDs'
      });
    }

    console.log(`[EphemeralDocuments] Upload: ${title} (${file.originalname})`);
    console.log(`   Classification: ${classificationLabel || level}`);
    console.log(`   Creator: ${creatorDID}`);
    console.log(`   Enterprise: ${enterprise}`);
    console.log(`   Releasable to: ${releasableArray.length} DIDs`);

    // Store document using ReEncryptionService
    const result = await ReEncryptionService.storeDocument({
      fileBuffer: file.buffer,
      filename: file.originalname,
      title,
      description: description || '',
      classificationLevel: level,
      classificationLabel: classificationLabel || ReEncryptionService.getLevelLabel(level),
      releasableDIDs: releasableArray,
      creatorDID,
      creatorClearanceLevel: parseInt(creatorClearanceLevel || level, 10),
      enterprise
    });

    console.log(`[EphemeralDocuments] Document stored: ${result.documentId}`);

    res.json({
      success: true,
      documentId: result.documentId,
      encryptionKeyId: result.encryptionKeyId,
      iagonFileId: result.iagonFileId,
      originalHash: result.originalHash,
      message: 'Document uploaded and encrypted successfully'
    });

  } catch (error) {
    console.error('[EphemeralDocuments] Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to upload document'
    });
  }
});

/**
 * POST /api/ephemeral-documents/access
 * Request ephemeral access to a document using Document DID
 *
 * Pure SSI Architecture - No Database Required
 * Uses DocumentRegistry (in-memory) + Iagon (decentralized storage)
 *
 * Request Body:
 * - documentDID: The document's PRISM DID (not UUID)
 * - requestorDID: The requestor's PRISM DID
 * - issuerDID: The issuer DID from the requestor's Security Clearance VC
 * - clearanceLevel: The requestor's clearance level (1-4)
 * - ephemeralDID: The ephemeral DID for this request
 * - ephemeralPublicKey: Base64-encoded X25519 public key
 * - signature: Ed25519 signature over the request payload
 * - timestamp: Request timestamp (ISO 8601)
 * - nonce: Random nonce for replay prevention
 */
app.post('/api/ephemeral-documents/access', async (req, res) => {
  try {
    const {
      documentDID,
      requestorDID,
      issuerDID,
      // clearanceLevel intentionally NOT extracted - SECURITY: use session instead
      ephemeralDID,
      ephemeralPublicKey,
      signature,
      timestamp,
      nonce
    } = req.body;

    // SECURITY FIX: Get clearance from VP-verified session, NOT client request
    // The client's clearance was verified during login via VP verification
    const sessionToken = req.query.sessionId || req.headers['x-session-id'];

    // Debug logging for session lookup
    console.log('[EphemeralAccess] Session lookup:');
    console.log(`   Header x-session-id: ${req.headers['x-session-id'] ? req.headers['x-session-id'].substring(0, 20) + '...' : 'NOT PRESENT'}`);
    console.log(`   Query sessionId: ${req.query.sessionId ? req.query.sessionId.substring(0, 20) + '...' : 'NOT PRESENT'}`);
    console.log(`   Active sessions: ${employeeSessions.size}`);

    const session = employeeSessions.get(sessionToken);

    let sessionClearanceLabel;
    let clearanceLevelNumeric;

    if (!session) {
      // No employee session — allow sessionless access for INTERNAL (level 1) documents only.
      // This supports IDL wallet and other SSI-native clients that authenticate via
      // Ed25519 signature rather than VP-presentation login flow.
      // The /discover endpoint already filters documents to the requestor's clearance,
      // so INTERNAL is the safe default for unauthenticated sessions.
      if (!issuerDID) {
        console.log('[EphemeralAccess] DENIED: No session and no issuerDID');
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'No valid session. Please log in first.'
        });
      }
      console.log('[EphemeralAccess] No session — granting UNCLASSIFIED-level sessionless access');
      console.log(`   issuerDID: ${issuerDID.substring(0, 50)}...`);
      sessionClearanceLabel = 'UNCLASSIFIED';
      clearanceLevelNumeric = 0;
    } else {
      // Use clearance from session (set during VP verification at login)
      // Default to UNCLASSIFIED if no clearance verification done yet
      sessionClearanceLabel = session.clearanceLevel || 'UNCLASSIFIED';
      clearanceLevelNumeric = ReEncryptionService.getLevelNumber(sessionClearanceLabel);
    }

    // Validate required fields (clearanceLevel removed - comes from session)
    if (!documentDID || !requestorDID || !issuerDID || !ephemeralDID ||
        !ephemeralPublicKey || !signature || !timestamp || !nonce) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'Missing required fields'
      });
    }

    console.log('\n' + '='.repeat(70));
    console.log('[EphemeralAccess] Document access request (Pure SSI Architecture)');
    console.log(`   Document DID: ${documentDID.substring(0, 50)}...`);
    console.log(`   Requestor: ${requestorDID.substring(0, 40)}...`);
    console.log(`   Issuer: ${issuerDID.substring(0, 40)}...`);
    console.log(`   Session Clearance: ${sessionClearanceLabel} (level ${clearanceLevelNumeric})`);
    console.log(`   Ephemeral DID: ${ephemeralDID.substring(0, 40)}...`);
    console.log('='.repeat(70));

    // Get client info for audit
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // Process the access request through ReEncryptionService
    // Now uses DocumentRegistry (in-memory) instead of PostgreSQL
    const result = await ReEncryptionService.processAccessRequest({
      documentDID,
      requestorDID,
      issuerDID,
      clearanceLevel: clearanceLevelNumeric,
      ephemeralDID,
      ephemeralPublicKey,
      signature,
      timestamp,
      nonce,
      clientIp,
      userAgent
    });

    if (!result.success) {
      console.log(`[EphemeralAccess] Access DENIED: ${result.error}`);
      return res.status(403).json({
        success: false,
        error: 'AccessDenied',
        denialReason: result.error,
        message: result.message || 'Access denied'
      });
    }

    console.log(`[EphemeralAccess] Access GRANTED: copyId=${result.copyId}`);

    res.json({
      success: true,
      documentDID: result.documentDID,
      copyId: result.copyId,
      copyHash: result.copyHash,
      ciphertext: result.ciphertext,
      nonce: result.nonce,
      serverPublicKey: result.serverPublicKey,
      filename: result.filename,
      mimeType: result.mimeType,
      classificationLevel: result.classificationLevel,
      accessedAt: result.accessedAt
    });

  } catch (error) {
    console.error('[EphemeralAccess] Error processing request:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to process access request'
    });
  }
});

/**
 * GET /api/ephemeral-documents/audit/:documentDID
 * Get audit log for a document (admin/forensics)
 *
 * Pure SSI Architecture - Reads from file-based audit log
 *
 * Path Parameters:
 * - documentDID: URL-encoded document DID
 *
 * Query Parameters:
 * - limit: Maximum number of entries (default 100)
 * - offset: Pagination offset (default 0)
 */
app.get('/api/ephemeral-documents/audit/:documentDID', async (req, res) => {
  try {
    const documentDID = decodeURIComponent(req.params.documentDID);
    const limit = parseInt(req.query.limit || '100', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    console.log(`[EphemeralAudit] Audit log request for document: ${documentDID.substring(0, 50)}...`);

    const auditLog = await ReEncryptionService.getDocumentAuditLog(documentDID, limit, offset);

    res.json({
      success: true,
      documentDID,
      entries: auditLog,
      count: auditLog.length,
      limit,
      offset
    });

  } catch (error) {
    console.error('[EphemeralAudit] Error getting audit log:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to get audit log'
    });
  }
});

/**
 * GET /api/admin/access-logs
 * Returns access log for the authenticated company.
 * Query params: limit (default 200), offset (default 0)
 */
app.get('/api/admin/access-logs', requireCompany, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const companyDID = req.company.did;

    const content = await fs.promises.readFile(ACCESS_GATE_LOG_PATH, 'utf8').catch(() => '');
    const entries = content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const filtered = entries.filter(e => e.companyDID === companyDID);
    // Read-time enrichment: backfill documentTitle from the live DocumentRegistry for any
    // entry whose own documentTitle is falsy (covers historical rows written before the
    // write-site field-name bug was fixed — see lib/AccessGateLogEntry.js#enrichLogEntryTitle).
    // Only the returned page is enriched, not the full `filtered` set, to avoid unnecessary
    // registry lookups for rows that are never sent to the client.
    const page = filtered.reverse().slice(offset, offset + limit)
      .map(e => enrichLogEntryTitle(e, (did) => DocumentRegistry.documents.get(did)));
    res.json({ success: true, total: filtered.length, logs: page });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Credential Sync — check personal CA clearance and revoke stale enterprise grants
// ============================================================================

/**
 * POST /api/company/sync-clearance
 * For each active SecurityClearanceGrant issued by TechCorp, checks whether the
 * holder's personal CA SecurityClearance VC has been revoked. If so, revokes the
 * enterprise grant via the TechCorp Cloud Agent.
 */
app.post('/api/company/sync-clearance', requireCompany, async (req, res) => {
  const StatusListService = require('./lib/StatusListService');
  const report = { synced: 0, alreadyRevoked: 0, revoked: 0, personalNotFound: 0, noStatusList: 0, noStatusListDetails: [], errors: [] };

  try {
    // ── 1. Fetch all TechCorp-issued SecurityClearanceGrant records ──────────
    const tcResp = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/issue-credentials/records?limit=1000`, {
      headers: { apikey: TECHCORP_API_KEY }
    });
    const tcData = await tcResp.json();
    const grantRecords = (tcData.contents || []).filter(r =>
      r.role === 'Issuer' &&
      r.protocolState === 'CredentialSent' &&
      (r.claims?.credentialType === 'SecurityClearanceGrant' ||
       r.claims?.credentialType === 'SecurityClearance' ||
       r.claims?.clearanceLevel)  // catch any format with a clearance level
    );

    console.log(`[SyncClearance] Found ${grantRecords.length} active clearance grant records`);
    report.synced = grantRecords.length;

    // ── 2. Fetch all CA SecurityClearance records and build lookup maps ───────
    const caResp = await fetch(`https://identuslabel.cz/cloud-agent/issue-credentials/records?limit=1000`);
    const caData = await caResp.json();
    const personalCsMap = new Map(); // personal CA DID → most-recent credentialStatus

    for (const r of (caData.contents || [])) {
      if (r.protocolState !== 'CredentialSent' || !r.credential) continue;
      try {
        const raw = Buffer.from(r.credential, 'base64').toString('utf-8');
        const parts = raw.split('.');
        if (parts.length < 2) continue;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const holderDID = payload.sub;
        const cs = payload.vc?.credentialStatus;
        const subject = payload.vc?.credentialSubject || {};
        // Only care about clearance VCs from the CA
        if (!subject.clearanceLevel && !String(subject.credentialType || '').includes('Clearance')) continue;
        if (holderDID && cs?.statusListCredential && cs?.statusListIndex != null) {
          // Keep highest-index entry (most recently issued) per holderDID
          const existing = personalCsMap.get(holderDID);
          if (!existing || Number(cs.statusListIndex) > existing.statusListIndex) {
            personalCsMap.set(holderDID, {
              statusListCredential: cs.statusListCredential,
              statusListIndex: Number(cs.statusListIndex),
              statusPurpose: cs.statusPurpose || 'Revocation'
            });
          }
        }
      } catch (_) { /* skip undecodable records */ }
    }

    // ── 2b. Build holderName → personal CA DID map (fallback for old grants) ──
    // Old grants don't have caPersonalDID, but we can match via holderName from CA VCs.
    // The long-form enterprise PRISM DID encodes the email; we derive a canonical name from it.
    const holderNameToPersonalDID = new Map();
    for (const r of (caData.contents || [])) {
      if (r.protocolState !== 'CredentialSent' || !r.credential) continue;
      try {
        const raw = Buffer.from(r.credential, 'base64').toString('utf-8');
        const parts = raw.split('.');
        if (parts.length < 2) continue;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const holderDID = payload.sub;
        const subject = payload.vc?.credentialSubject || {};
        const holderName = subject.holderName; // e.g. "Vaclav Confidential"
        if (holderName && holderDID && personalCsMap.has(holderDID)) {
          holderNameToPersonalDID.set(holderName.toLowerCase(), holderDID);
        }
      } catch (_) {}
    }

    console.log(`[SyncClearance] Built personal credentialStatus map for ${personalCsMap.size} holders, holderName map: ${holderNameToPersonalDID.size} entries`);

    // ── 3. Check each enterprise grant against the personal CA status ─────────
    for (const grant of grantRecords) {
      const holderDID = grant.claims?.holderDID;
      if (!holderDID) { report.errors.push({ recordId: grant.recordId, error: 'no holderDID in claims' }); continue; }

      // caPersonalDID links the enterprise DID to the CA personal DID (added since this fix)
      const caPersonalDID = grant.claims?.caPersonalDID || null;
      let lookupDID = caPersonalDID || holderDID;

      // Fallback for old grants without caPersonalDID: derive name from long-form PRISM DID email
      if (!caPersonalDID) {
        try {
          // Long-form PRISM DIDs encode service endpoints as base64url segments.
          // The employee email is in a segment decoding to '["mailto:user@domain"]'.
          const didSuffix = holderDID.includes(':') ? holderDID.split(':').slice(2).join(':') : '';
          const emailMatch = Buffer.from(didSuffix, 'base64url').toString('utf-8')
            .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) {
            const email = emailMatch[0].toLowerCase();
            // Derive canonical name: "vaclav.confidential@..." → "vaclav confidential"
            const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
            const resolvedDID = holderNameToPersonalDID.get(namePart);
            if (resolvedDID) {
              lookupDID = resolvedDID;
              console.log(`[SyncClearance] Resolved caPersonalDID via name '${namePart}': ${resolvedDID.substring(0,30)}...`);
            }
          }
        } catch (_) {}
      }

      // Decode enterprise grant JWT to check if already revoked at enterprise level
      let enterpriseCs = null;
      try {
        const raw = Buffer.from(grant.credential, 'base64').toString('utf-8');
        const parts = raw.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
          enterpriseCs = payload.vc?.credentialStatus;
        }
      } catch (_) {}

      // Check enterprise revocation status
      if (enterpriseCs?.statusListCredential) {
        const entRev = await StatusListService.checkByCredentialStatus({
          statusListCredential: enterpriseCs.statusListCredential,
          statusListIndex: Number(enterpriseCs.statusListIndex)
        });
        console.log(`[SyncClearance] Enterprise grant ${grant.recordId} statusList check: isRevoked=${entRev.isRevoked} status=${entRev.status}`);
        if (entRev.isRevoked) {
          report.alreadyRevoked++;
          continue; // enterprise VC already revoked, nothing to do
        }
      } else {
        // Non-revocable JWT — cannot be revoked via Cloud Agent; must be deleted from wallet
        console.log(`[SyncClearance] Grant ${grant.recordId} has no credentialStatus (non-revocable JWT) — will check personal VC and flag if needed`);
      }

      // Find personal CA credentialStatus — prefer caPersonalDID, fall back to holderDID
      const personalCs = personalCsMap.get(lookupDID) || (!caPersonalDID ? personalCsMap.get(holderDID) : null);
      console.log(`[SyncClearance] personalCs for ${grant.recordId}: ${personalCs ? `index=${personalCs.statusListIndex}` : 'NOT FOUND'} lookupDID=${lookupDID.substring(0,30)}...`);
      if (!personalCs) {
        console.log(`[SyncClearance] No personal CA VC found for ${caPersonalDID ? 'caPersonalDID' : 'holderDID'}: ${lookupDID.substring(0, 30)}... (caPersonalDID=${!!caPersonalDID})`);
        report.personalNotFound++;
        continue;
      }

      // Check if personal CA VC is revoked
      const personalRev = await StatusListService.checkByCredentialStatus(personalCs);
      console.log(`[SyncClearance] Personal CA VC revocation check for ${grant.recordId}: isRevoked=${personalRev.isRevoked} status=${personalRev.status}`);
      if (!personalRev.isRevoked) continue; // personal VC still valid

      // Personal VC is revoked → revoke the enterprise grant
      if (!enterpriseCs?.statusListCredential) {
        // Cannot revoke: no status list — employee must delete this VC from their wallet
        console.log(`[SyncClearance] ⚠️ Grant ${grant.recordId} personal VC revoked but enterprise has no status list — cannot revoke, needs manual wallet deletion`);
        report.noStatusList++;
        report.noStatusListDetails.push({
          recordId: grant.recordId,
          holderName: grant.claims?.holderName,
          holderDID: holderDID?.substring(0, 40) + '...',
          clearanceLevel: grant.claims?.clearanceLevel,
          credentialType: grant.claims?.credentialType,
          note: 'No StatusList2021 in this VC — delete from wallet manually'
        });
        continue;
      }
      console.log(`[SyncClearance] 🚫 Revoking enterprise grant ${grant.recordId} — personal clearance revoked`);
      try {
        const revokeResp = await fetch(
          `${TECHCORP_CLOUD_AGENT_URL}/credential-status/revoke-credential/${grant.recordId}`,
          { method: 'PATCH', headers: { apikey: TECHCORP_API_KEY } }
        );
        if (revokeResp.ok) {
          report.revoked++;
          console.log(`[SyncClearance] ✅ Revoked enterprise grant: ${grant.recordId}`);
        } else {
          const errText = await revokeResp.text();
          report.errors.push({ recordId: grant.recordId, error: `Revoke HTTP ${revokeResp.status}: ${errText}` });
        }
      } catch (revokeErr) {
        report.errors.push({ recordId: grant.recordId, error: revokeErr.message });
      }
    }

    res.json({ success: true, report });
  } catch (err) {
    console.error('[SyncClearance] Fatal error:', err.message);
    res.status(500).json({ success: false, error: err.message, report });
  }
});

// ============================================================================
// Folder Registry API
//
// SECURITY: every route below used to take `ownerCompanyDID` from the client
// (query string or request body) and trust it verbatim. FolderRegistry's own
// mutators (renameFolder/deleteFolder/addDocumentToFolder) do check that a
// folder actually belongs to the given ownerCompanyDID — but nothing stopped
// an authenticated employee of one company from simply passing a DIFFERENT
// company's DID in the request and reading or mutating that company's
// folders. All routes now require a valid employee session (requireEmployeeSession)
// and take the company identifier from req.employeeSession.issuerDID only.
// ============================================================================

/**
 * GET /api/folders
 * List all folders for the caller's own company, with document counts.
 */
app.get('/api/folders', requireEmployeeSession, async (req, res) => {
  try {
    const ownerCompanyDID = req.employeeSession.issuerDID;
    const folders = FolderRegistry.getFoldersForCompany(ownerCompanyDID);
    res.json({ success: true, folders });
  } catch (err) {
    console.error('[FolderRegistry] GET /api/folders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/folders
 * Create a new folder for the caller's own company.
 * Body: { name, parentFolderId? }
 */
app.post('/api/folders', requireEmployeeSession, async (req, res) => {
  try {
    const { name, parentFolderId } = req.body;
    const ownerCompanyDID = req.employeeSession.issuerDID;
    if (!name) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'name is required' });
    }
    const folder = await FolderRegistry.createFolder({ name, parentFolderId: parentFolderId || null, ownerCompanyDID });
    res.json({ success: true, folder });
  } catch (err) {
    console.error('[FolderRegistry] POST /api/folders error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/folders/:folderId
 * Delete a folder owned by the caller's own company (children re-parented,
 * documents moved to root).
 */
app.delete('/api/folders/:folderId', requireEmployeeSession, async (req, res) => {
  try {
    const { folderId } = req.params;
    const ownerCompanyDID = req.employeeSession.issuerDID;
    const result = await FolderRegistry.deleteFolder(folderId, ownerCompanyDID);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FolderRegistry] DELETE /api/folders error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/folders/:folderId
 * Rename a folder owned by the caller's own company.
 * Body: { name }
 */
app.patch('/api/folders/:folderId', requireEmployeeSession, async (req, res) => {
  try {
    const { folderId } = req.params;
    const { name } = req.body;
    const ownerCompanyDID = req.employeeSession.issuerDID;
    if (!name) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'name is required' });
    }
    const folder = await FolderRegistry.renameFolder(folderId, name.trim(), ownerCompanyDID);
    res.json({ success: true, folder });
  } catch (err) {
    console.error('[FolderRegistry] PATCH /api/folders error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/folders/:folderId/documents/:documentDID
 * Move a document into a folder. Both the folder and the document must
 * belong to the caller's own company — FolderRegistry checks the folder;
 * DocumentRegistry.getDocument (releasableTo check) validates the document.
 */
app.put('/api/folders/:folderId/documents/:documentDID', requireEmployeeSession, async (req, res) => {
  try {
    const { folderId, documentDID } = req.params;
    const ownerCompanyDID = req.employeeSession.issuerDID;
    const decodedDID = decodeURIComponent(documentDID);
    await DocumentRegistry.getDocument(decodedDID, ownerCompanyDID); // throws if not released to this company
    await FolderRegistry.addDocumentToFolder(decodedDID, folderId, ownerCompanyDID);
    res.json({ success: true });
  } catch (err) {
    console.error('[FolderRegistry] PUT folder document error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/folders/root/documents/:documentDID
 * Remove a document from any folder (move back to root/uncategorized).
 * Validates the document belongs to the caller's own company before mutating —
 * FolderRegistry's membership map has no per-document company field of its own.
 */
app.delete('/api/folders/root/documents/:documentDID', requireEmployeeSession, async (req, res) => {
  try {
    const ownerCompanyDID = req.employeeSession.issuerDID;
    const decodedDID = decodeURIComponent(req.params.documentDID);
    await DocumentRegistry.getDocument(decodedDID, ownerCompanyDID); // throws if not released to this company
    await FolderRegistry.removeDocumentFromFolder(decodedDID);
    res.json({ success: true });
  } catch (err) {
    console.error('[FolderRegistry] DELETE folder document error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DIDComm-Based Document Access (preferred — cryptographic holder binding)
// ============================================================================
// Flow:
//   1. POST /api/document-access/initiate   — wallet sends employeeIdentifier + ephemeralPublicKey
//      Server looks up DIDComm connectionId, creates present-proof request via Cloud Agent.
//      Returns sessionId (= presentationId).
//   2. GET  /api/document-access/status/:sessionId — wallet polls until 'authorized'
//      Meanwhile the wallet receives DIDComm RequestPresentation and user approves it.
//   3. POST /api/document-access/complete   — wallet submits { sessionId }
//      Server fetches verified VP from Cloud Agent, runs full verification pipeline,
//      downloads + redacts + re-encrypts document, returns same shape as access-gate/present.

const pendingDocumentAccessSessions = new Map(); // sessionId → session state

/**
 * POST /api/document-access/initiate
 * Body: { documentDID, employeeIdentifier, ephemeralPublicKey }
 */
app.post('/api/document-access/initiate', async (req, res) => {
  try {
    const { documentDID, employeeIdentifier, ephemeralPublicKey } = req.body;

    if (!documentDID || !employeeIdentifier || !ephemeralPublicKey) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'documentDID, employeeIdentifier, and ephemeralPublicKey are required' });
    }

    // Stable email fallback (see Strategy 3 below). The wallet sends this from its EmployeeRole
    // VC; it survives re-onboarding because email is the DB upsert key, whereas the PRISM DID in
    // an old cached VC drifts away from the DB after the same employee is re-onboarded. Accept it
    // from the dedicated field, or derive it if the identifier itself is already an email.
    const employeeEmail =
      (typeof req.body.employeeEmail === 'string' && req.body.employeeEmail.includes('@'))
        ? req.body.employeeEmail
        : (employeeIdentifier.includes('@') ? employeeIdentifier : null);

    // Validate document exists
    const document = DocumentRegistry.documents.get(documentDID);
    if (!document) {
      return res.status(404).json({ success: false, error: 'DocumentNotFound', message: 'Document not found' });
    }

    // Look up DIDComm connection for this employee (mirrors the employee login flow)
    let connectionId = null;
    // Only Strategy 1 (the mapping file) carries any tenant hint — capture it so we can resolve
    // the owning company below instead of hardcoding TechCorp (see resolveDocumentAccessTenant).
    let mappingCompanyLabel = null;

    // Strategy 1: in-memory mapping file
    if (global.employeeConnectionMappings && global.employeeConnectionMappings.has(employeeIdentifier)) {
      const mappingEntry = global.employeeConnectionMappings.get(employeeIdentifier);
      connectionId = mappingEntry.connectionId;
      mappingCompanyLabel = mappingEntry.company || null;
      console.log(`[DocumentAccess] Found connection via mapping: ${employeeIdentifier} → ${connectionId}`);
    }

    // Strategy 2: database lookup by the presented identifier (PRISM DID or email)
    // Strategy 3: stable-email fallback when the DID has drifted (re-onboarding)
    if (!connectionId && process.env.ENTERPRISE_DB_PASSWORD) {
      const { Pool } = require('pg');
      const enterprisePool = new Pool({
        host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
        port: process.env.ENTERPRISE_DB_PORT || 5434,
        database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
        user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
        password: process.env.ENTERPRISE_DB_PASSWORD,
      });
      try {
        const employeeDb = new EmployeePortalDatabase(enterprisePool);
        let employee = null;
        if (employeeIdentifier.includes('@')) {
          employee = await employeeDb.getEmployeeByEmail(employeeIdentifier);
        } else if (employeeIdentifier.startsWith('did:prism:')) {
          employee = await employeeDb.getEmployeeByDid(employeeIdentifier);
        }

        // Strategy 3: the DID lookup found no row (common after re-onboarding leaves the wallet
        // holding an EmployeeRole VC whose PRISM DID the DB has since overwritten). Fall back to
        // the stable email, which still points at the current row. Safe: this only selects which
        // DIDComm connection receives the proof request — the VP verification that follows is the
        // real access gate, so routing by email cannot grant access to anyone who can't also
        // present a valid, holder-bound VP over that connection.
        if (!employee?.techcorp_connection_id && employeeEmail && employeeEmail !== employeeIdentifier) {
          const byEmail = await employeeDb.getEmployeeByEmail(employeeEmail);
          if (byEmail?.techcorp_connection_id) {
            employee = byEmail;
            console.warn(`[DocumentAccess] Identifier ${employeeIdentifier} not found in DB; resolved via stable email ${employeeEmail} (wallet VC likely predates a re-onboarding)`);
          }
        }

        if (employee?.techcorp_connection_id) {
          connectionId = employee.techcorp_connection_id;
          console.log(`[DocumentAccess] Found connection via DB: ${employeeIdentifier} → ${connectionId}`);
        }
      } catch (dbErr) {
        console.warn('[DocumentAccess] DB fallback error:', dbErr.message);
      } finally {
        await enterprisePool.end();
      }
    }

    if (!connectionId) {
      return res.status(404).json({ success: false, error: 'ConnectionNotFound', message: 'No DIDComm connection found for this employee. Please complete onboarding first.' });
    }

    // Resolve which tenant's wallet actually owns this connectionId — each company has an
    // isolated wallet/apiKey on the shared multitenancy Cloud Agent, and a present-proof request
    // created with the wrong tenant's apiKey against this connectionId will fail (or silently
    // never resolve) since each tenant only sees its own connections. Strategy 1 (mapping file)
    // carries a company label; Strategy 2/3 (DB) carries none, so we probe each tenant in turn.
    // Fails closed (404) rather than defaulting to TechCorp — see lib/resolveDocumentAccessTenant.js.
    const tenant = await resolveDocumentAccessTenant({
      connectionId,
      mappingCompanyLabel,
      cloudAgentUrl: MULTITENANCY_CLOUD_AGENT_URL
    });
    if (!tenant) {
      return res.status(404).json({ success: false, error: 'TenantNotFound', message: 'Could not determine which company tenant owns this DIDComm connection.' });
    }

    const challenge  = crypto.randomUUID();
    const domain     = 'document-access.company-admin';

    // Create DIDComm present-proof request via Cloud Agent — using the resolved tenant's own
    // apiKey (not TechCorp's) against the shared multitenancy Cloud Agent.
    const proofResponse = await fetch(`${MULTITENANCY_CLOUD_AGENT_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: { 'apikey': tenant.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        options: { challenge, domain },
        proofs: [],
        goalCode: 'present-vp',
        goal: 'Please provide your employee credentials for document access',
        credentialFormat: 'JWT'
      })
    });

    if (!proofResponse.ok) {
      const errText = await proofResponse.text();
      throw new Error(`Proof request creation failed: ${proofResponse.status} ${errText}`);
    }

    const proofData       = await proofResponse.json();
    const presentationId  = proofData.presentationId || proofData.id;
    const sessionId       = presentationId;

    // Store session — including the resolved tenant's apiKey/cloudAgentUrl, so /status and
    // /complete reuse the exact same tenant that created this presentation rather than
    // re-resolving independently (which could pick a different/wrong tenant if ambiguous).
    pendingDocumentAccessSessions.set(sessionId, {
      presentationId, documentDID, connectionId, ephemeralPublicKey, challenge, domain,
      employeeIdentifier, timestamp: Date.now(), status: 'pending',
      tenantApiKey: tenant.apiKey, tenantCloudAgentUrl: MULTITENANCY_CLOUD_AGENT_URL, tenantId: tenant.id
    });

    // Clean up sessions older than 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, s] of pendingDocumentAccessSessions) {
      if (s.timestamp < cutoff) pendingDocumentAccessSessions.delete(id);
    }

    console.log(`[DocumentAccess] DIDComm proof request created: ${sessionId} for ${employeeIdentifier}`);
    res.json({ success: true, sessionId });

  } catch (err) {
    console.error('[DocumentAccess] Initiate error:', err.message);
    res.status(500).json({ success: false, error: 'InternalServerError', message: err.message });
  }
});

/**
 * GET /api/document-access/status/:sessionId
 */
app.get('/api/document-access/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = pendingDocumentAccessSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'SessionNotFound', message: 'Session not found or expired' });
    }

    const stateRes = await fetch(
      `${session.tenantCloudAgentUrl}/present-proof/presentations/${session.presentationId}`,
      { headers: { 'apikey': session.tenantApiKey } }
    );

    if (!stateRes.ok) {
      return res.json({ success: true, status: 'pending' });
    }

    const stateData     = await stateRes.json();
    const currentState  = stateData.status || stateData.state || '';

    let status = 'pending';
    if (currentState === 'PresentationVerified') status = 'authorized';
    else if (currentState === 'PresentationReceived') status = 'verifying';
    else if (currentState === 'PresentationRejected' || currentState === 'RequestRejected') status = 'rejected';

    res.json({ success: true, status });

  } catch (err) {
    console.error('[DocumentAccess] Status error:', err.message);
    res.status(500).json({ success: false, error: 'InternalServerError', message: err.message });
  }
});

/**
 * POST /api/document-access/complete
 * Body: { sessionId }
 */
app.post('/api/document-access/complete', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'sessionId is required' });
    }

    const session = pendingDocumentAccessSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'SessionNotFound', message: 'Session not found or expired' });
    }

    // Consume session (one-time use)
    pendingDocumentAccessSessions.delete(sessionId);

    const { documentDID, ephemeralPublicKey, challenge, domain, presentationId, tenantApiKey, tenantCloudAgentUrl } = session;

    // Fetch the verified presentation from Cloud Agent — using the same tenant apiKey that
    // /initiate used to create this presentation (Cloud Agent presentations, like connections,
    // are tenant-scoped, so this must not be re-resolved independently).
    const presentationRes = await fetch(
      `${tenantCloudAgentUrl}/present-proof/presentations/${presentationId}`,
      { headers: { 'apikey': tenantApiKey } }
    );
    if (!presentationRes.ok) {
      return res.status(502).json({ success: false, error: 'AgentError', message: 'Could not retrieve presentation from Cloud Agent' });
    }
    const presentation = await presentationRes.json();
    const currentState = presentation.status || presentation.state || '';

    if (currentState !== 'PresentationVerified' && currentState !== 'PresentationReceived') {
      return res.status(403).json({ success: false, error: 'PresentationNotVerified', message: `Presentation is in state "${currentState}", not verified` });
    }

    // Decode the VP JWT
    if (!presentation.data || !Array.isArray(presentation.data) || presentation.data.length === 0) {
      return res.status(400).json({ success: false, error: 'NoPresentationData', message: 'No presentation data found' });
    }

    const presentationJWT = presentation.data[0];
    const parts = presentationJWT.split('.');
    if (parts.length !== 3) {
      return res.status(400).json({ success: false, error: 'InvalidJWT', message: 'Presentation JWT is malformed' });
    }
    const payloadB64  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = Buffer.from(payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4), 'base64').toString('utf-8');
    const payload     = JSON.parse(payloadJson);
    const vp          = payload.vp;

    // Verify challenge and domain (only when VP has an embedded proof; JWT VPs are verified by the cloud agent)
    if (vp.proof && vp.proof.challenge !== challenge) {
      return res.status(403).json({ success: false, error: 'ChallengeMismatch', message: 'Security challenge verification failed' });
    }
    if (vp.proof && vp.proof.domain !== domain) {
      return res.status(403).json({ success: false, error: 'DomainMismatch', message: 'Domain verification failed' });
    }

    // Verify VP and extract claims (includes holder binding + subject consistency)
    const vpResult = VPVerificationService.verifyVPAndExtractClaims(vp, ACCEPTED_ISSUER_DIDS);
    if (!vpResult.success) {
      return res.status(403).json({ success: false, error: vpResult.error, message: vpResult.message });
    }

    // VP is valid — delegate all document checks (registry, releasability, clearance,
    // revocation, iagonStorage) and the download+redact+encrypt pipeline to
    // access-gate/present via loopback.  This keeps all business logic in one place.
    const loopbackBase = `http://127.0.0.1:${PORT || 3010}`;
    const challengeRes = await fetch(`${loopbackBase}/api/access-gate/challenge?documentDID=${encodeURIComponent(documentDID)}`);
    const challengeJson = await challengeRes.json();
    if (!challengeRes.ok || !challengeJson.success) {
      return res.status(500).json({ success: false, error: 'InternalError', message: 'Failed to obtain internal challenge' });
    }
    const internalChallenge = challengeJson.challenge;

    // Forward the VP to access-gate/present unmodified.
    // The internal challenge was issued by access-gate/challenge above and is valid
    // for this documentDID; access-gate/present validates it from pendingDocumentAccessChallenges.
    // VP proof integrity is not violated — the Identus JWT VP has no .proof field
    // (the signature lives in the JWT envelope, already verified by the cloud agent).
    const presentRes = await fetch(`${loopbackBase}/api/access-gate/present`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentDID, vp, challenge: internalChallenge, ephemeralPublicKey })
    });

    const presentJson = await presentRes.json();
    if (!presentRes.ok || !presentJson.success) {
      return res.status(presentRes.status).json(presentJson);
    }

    console.log(`[DocumentAccess] DIDComm presentation verified and document delivered: ${documentDID}`);
    res.status(presentRes.status).json(presentJson);

  } catch (err) {
    console.error('[DocumentAccess] Complete error:', err.message);
    res.status(500).json({ success: false, error: 'InternalServerError', message: err.message });
  }
});

// ============================================================================
// VC-Based Document Access Gate
// ============================================================================

/**
 * GET /api/access-gate/challenge?documentDID=...
 *
 * Step 4 of the VC-based document access flow.
 * Returns an OID4VP-style presentationDefinition and a time-limited challenge
 * UUID that the wallet must include when presenting its VP.
 *
 * The wallet should call POST /api/access-gate/present with:
 *   { documentDID, vp, challenge, ephemeralPublicKey }
 *
 * Challenge TTL: 5 minutes.
 */
app.get('/api/access-gate/challenge', async (req, res) => {
  try {
    const documentDID = req.query.documentDID;
    if (!documentDID) {
      return res.status(400).json({ success: false, error: 'MissingDocumentDID', message: 'documentDID query param required' });
    }

    // Verify document exists in registry
    const document = DocumentRegistry.documents.get(documentDID);
    if (!document) {
      return res.status(404).json({ success: false, error: 'DocumentNotFound', message: 'Document not found in registry' });
    }

    // Generate challenge
    const challenge = crypto.randomUUID();

    // Store challenge with 5-min TTL
    pendingDocumentAccessChallenges.set(challenge, {
      documentDID,
      challenge,
      timestamp: Date.now()
    });

    // Clean up stale challenges (> 5 min)
    const now = Date.now();
    for (const [ch, entry] of pendingDocumentAccessChallenges) {
      if (now - entry.timestamp > 5 * 60 * 1000) pendingDocumentAccessChallenges.delete(ch);
    }

    console.log(`[AccessGate] Challenge issued for document: ${documentDID.substring(0, 50)}...`);

    res.json({
      success: true,
      challenge,
      documentDID,
      presentationDefinition: {
        id: challenge,
        input_descriptors: [
          {
            id: 'enterprise_vc',
            name: 'Enterprise Employee Credential',
            purpose: 'Prove you are an authorized employee',
            constraints: {
              fields: [
                { path: ['$.vc.credentialSubject.role'], filter: { type: 'string' } },
                { path: ['$.vc.credentialSubject.department'], filter: { type: 'string' } }
              ]
            }
          },
          {
            id: 'clearance_vc',
            name: 'Security Clearance Credential',
            purpose: 'Prove your security clearance level',
            constraints: {
              fields: [
                { path: ['$.vc.credentialSubject.clearanceLevel'], filter: { type: 'string' } }
              ]
            }
          }
        ]
      },
      expiresIn: 300 // seconds
    });

  } catch (error) {
    console.error('[AccessGate] Challenge error:', error);
    res.status(500).json({ success: false, error: 'InternalServerError', message: error.message });
  }
});

/**
 * POST /api/access-gate/present
 *
 * Step 5 of the VC-based document access flow.
 *
 * Request body:
 *   - documentDID: string
 *   - vp: object  { verifiableCredential: string[] }  — raw JWT credential array
 *   - challenge: string  — UUID from /challenge endpoint
 *   - ephemeralPublicKey: string  — Base64 X25519 public key for PFS encryption
 *
 * Verification steps:
 *   1. Challenge valid and not expired
 *   2. VP contains EmployeeRole VC with trusted issuer
 *   3. companyDID (issuerDID) in document.releasableTo
 *   4. clearanceLevel >= document.classificationLevel
 *   5. StatusList2021 revocation check (best-effort)
 *   6. Create EphemeralDID as access grant
 *   7. Download from Iagon, decrypt, redact, re-encrypt for ephemeralPublicKey
 *
 * Returns the same shape as /api/ephemeral-documents/access so the wallet
 * decryptAndDestroy() helper works unchanged.
 */
app.post('/api/access-gate/present', async (req, res) => {
  console.log('\n' + '='.repeat(70));
  console.log('[AccessGate] VP presentation received');
  console.log('='.repeat(70));

  try {
    const { documentDID, vp, challenge, ephemeralPublicKey } = req.body;

    // --- 1. Validate inputs ---
    if (!documentDID || !vp || !challenge || !ephemeralPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'documentDID, vp, challenge, and ephemeralPublicKey are required'
      });
    }

    // --- 2. Validate challenge ---
    const pendingChallenge = pendingDocumentAccessChallenges.get(challenge);
    if (!pendingChallenge) {
      return res.status(403).json({ success: false, error: 'InvalidChallenge', message: 'Challenge not found or expired' });
    }
    if (pendingChallenge.documentDID !== documentDID) {
      return res.status(403).json({ success: false, error: 'ChallengeMismatch', message: 'Challenge was issued for a different document' });
    }
    const challengeAge = Date.now() - pendingChallenge.timestamp;
    if (challengeAge > 5 * 60 * 1000) {
      pendingDocumentAccessChallenges.delete(challenge);
      return res.status(403).json({ success: false, error: 'ChallengeExpired', message: 'Challenge has expired' });
    }
    // Consume challenge (one-time use)
    pendingDocumentAccessChallenges.delete(challenge);

    // --- 3. Verify VP and extract claims ---
    const vpResult = VPVerificationService.verifyVPAndExtractClaims(vp, ACCEPTED_ISSUER_DIDS);
    if (!vpResult.success) {
      console.log(`[AccessGate] VP verification failed: ${vpResult.error}`);
      return res.status(403).json({ success: false, error: vpResult.error, message: vpResult.message });
    }

    const { companyDID, clearanceLevel, issuerDID, viewerName } = vpResult;
    console.log(`[AccessGate] VP verified — issuerDID: ${issuerDID?.substring(0, 50)}...`);
    console.log(`[AccessGate] Clearance from VC: ${clearanceLevel}`);

    // --- 4. Get document from registry ---
    const document = DocumentRegistry.documents.get(documentDID);
    if (!document) {
      return res.status(404).json({ success: false, error: 'DocumentNotFound', message: 'Document not found in registry' });
    }

    // --- 5. Releasability check ---
    // Empty/absent releasableTo = no restriction (open to any trusted issuer).
    // Non-empty = issuerDID must be in the list.
    const releasabilityOk = !document.releasableTo || document.releasableTo.length === 0 || document.releasableTo.includes(issuerDID);
    if (!releasabilityOk) {
      console.log(`[AccessGate] DENIED — issuerDID not in releasableTo`);
      fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
        timestamp: new Date().toISOString(),
        viewerName: viewerName || null,
        documentDID,
        documentTitle: document?.title || null,
        clearanceLevel: clearanceLevel || null,
        companyDID: document.ownerCompanyDID || null,
        accessGranted: false,
        denialReason: 'RELEASABILITY_DENIED',
        copyId: null,
        clientIp: req.ip || req.connection?.remoteAddress || null
      }) + '\n', () => {});
      return res.status(403).json({ success: false, error: 'ReleasabilityDenied', message: 'Your credential issuer is not authorized for this document' });
    }

    // --- 6. Clearance check ---
    const CLEARANCE_NUMERIC = { 'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2, 'RESTRICTED': 3, 'SECRET': 4, 'TOP-SECRET': 4, 'TOP_SECRET': 4 };
    const docLevel = CLEARANCE_NUMERIC[document.classificationLevel] ?? 1;
    const userLevel = clearanceLevel ? (CLEARANCE_NUMERIC[clearanceLevel.toUpperCase()] ?? 0) : 0;
    if (userLevel < docLevel) {
      console.log(`[AccessGate] DENIED — clearance ${clearanceLevel} (${userLevel}) < required ${document.classificationLevel} (${docLevel})`);
      fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
        timestamp: new Date().toISOString(),
        viewerName: viewerName || null,
        documentDID,
        documentTitle: document?.title || null,
        clearanceLevel: clearanceLevel || null,
        companyDID: document.ownerCompanyDID || null,
        accessGranted: false,
        denialReason: 'CLEARANCE_DENIED',
        copyId: null,
        clientIp: req.ip || req.connection?.remoteAddress || null
      }) + '\n', () => {});
      return res.status(403).json({
        success: false,
        error: 'ClearanceDenied',
        message: `Document requires ${document.classificationLevel}, your clearance is ${clearanceLevel || 'UNCLASSIFIED'}`
      });
    }

    // --- 7. Revocation check via StatusList2021 bitstring (best-effort) ---
    // Uses the statusListCredential URL embedded in the VC itself — no agent API needed.
    try {
      const StatusListService = require('./lib/StatusListService');
      for (const cs of (vpResult.credentialStatuses || [])) {
        const rev = await StatusListService.checkByCredentialStatus(cs);
        if (rev.isRevoked) {
          console.log(`[AccessGate] DENIED — credential revoked (index ${cs.statusListIndex})`);
          fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
            timestamp: new Date().toISOString(),
            viewerName: viewerName || null,
            documentDID,
            documentTitle: document?.title || null,
            clearanceLevel: clearanceLevel || null,
            companyDID: document.ownerCompanyDID || null,
            accessGranted: false,
            denialReason: 'CREDENTIAL_REVOKED',
            copyId: null,
            clientIp: req.ip || req.connection?.remoteAddress || null
          }) + '\n', () => {});
          return res.status(403).json({ success: false, error: 'CredentialRevoked', message: 'Your security clearance credential has been revoked' });
        }
      }
    } catch (revErr) {
      console.warn(`[AccessGate] Revocation check failed (non-fatal): ${revErr.message}`);
    }

    // --- 8. Download document from Iagon ---
    if (!document.iagonStorage || !document.iagonStorage.fileId) {
      // Fall back to DID resolution to find iagonFileId for documents whose
      // registry entry predates the iagonStorage field in registration payloads.
      try {
        const didRes  = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/dids/${encodeURIComponent(documentDID)}`);
        if (didRes.ok) {
          const didData  = await didRes.json();
          const didDoc   = didData.didDocument || didData.did || didData;
          const services = didDoc.services || didDoc.service || [];
          const metaSvc  = services.find(s => s.type === 'DocumentMetadata');
          let meta = metaSvc?.serviceEndpoint;
          if (Array.isArray(meta)) meta = meta[0];
          if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) {} }
          if (meta?.iagonFileId) {
            document.iagonStorage = { fileId: meta.iagonFileId, filename: meta.originalFilename || meta.iagonFilename || null };
            DocumentRegistry.documents.set(documentDID, document);
            console.log(`[AccessGate] Resolved iagonStorage from DID for: ${documentDID.substring(0, 50)}`);
          }
        }
      } catch (didErr) {
        console.warn(`[AccessGate] DID resolution fallback failed: ${didErr.message}`);
      }
      if (!document.iagonStorage || !document.iagonStorage.fileId) {
        return res.status(404).json({ success: false, error: 'NoStorage', message: 'Document has no Iagon storage record' });
      }
    }

    const iagonClient = getIagonClient();
    const isDocxDoc = document.metadata?.sourceFormat === 'docx' ||
                      !!document.iagonStorage.originalDocxFileId ||
                      (document.iagonStorage.filename || '').toLowerCase().endsWith('.docx');
    let redactedContent;

    // CMK-unwrap helper — VC-first, then Iagon manifest, then legacy fallback
    // Pass docDIDForVC to enable VC-first path (omit for originalDocx downloads).
    async function decryptFromIagon(storage, classLevel, docDIDForVC = null) {
      // ── VC-first path ─────────────────────────────────────────────────────
      if (docDIDForVC) {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcRecord = await fetchCurrentManifestVC(docDIDForVC, docServiceUrl, adminKey);
        if (vcRecord) {
          const verifier = new (require('./lib/KeyManifestVCVerifier'))({
            inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
          });
          const result = await verifier.verify(vcRecord);
          if (!result.valid) throw new ManifestVCInvalid(result.reason);
          const { claims } = result;
          const rawDEK = cmk.unwrapDEK(claims, classLevel);
          const fullEncInfo = {
            algorithm: claims.fileAlgorithm || 'AES-256-GCM',
            iv:        claims.fileIv,
            authTag:   claims.fileAuthTag,
            key:       rawDEK.toString('base64')
          };
          const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
          rawDEK.fill(0);
          return content;
        }
        // No VC found — fall through to Iagon manifest path
      }
      // ── Iagon manifest path ────────────────────────────────────────────────
      if (storage.encryptionManifestId) {
        const wrappedManifest = await iagonClient.downloadKeyManifest(storage.encryptionManifestId);
        const rawDEK = cmk.unwrapDEK(wrappedManifest, classLevel);
        const fullEncInfo = { ...storage.encryptionInfo, key: rawDEK.toString('base64') };
        const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
        rawDEK.fill(0);
        return content;
      }
      // ── Legacy path ────────────────────────────────────────────────────────
      if (storage.encryptionInfo && !storage.encryptionInfo.key) {
        throw new Error('DocumentKeyUnavailable: encryption key missing from registry — document must be re-uploaded');
      }
      return iagonClient.downloadFile(storage.fileId, storage.encryptionInfo || null);
    }

    if (isDocxDoc) {
      // Full-fidelity DOCX redaction — use originalDocxFileId when available, fallback to fileId
      let originalDocx;
      if (document.iagonStorage.originalDocxFileId) {
        // Updated DOCX — use Iagon manifest if available, else VC-first path
        const docxStorage = {
          fileId: document.iagonStorage.originalDocxFileId,
          encryptionManifestId: document.iagonStorage.originalDocxManifestId || null,
          encryptionInfo: document.iagonStorage.originalDocxEncryptionInfo || null
        };
        // Pass documentDID for VC-first fallback when originalDocxManifestId is absent
        const docxDIDForVC = docxStorage.encryptionManifestId ? null : documentDID;
        originalDocx = await decryptFromIagon(docxStorage, document.classificationLevel, docxDIDForVC);
      } else {
        // Original (no update yet) — use VC-first path
        originalDocx = await decryptFromIagon(document.iagonStorage, document.classificationLevel, documentDID);
      }
      redactedContent = await DocxRedactionService.applyRedactions(
        originalDocx,
        clearanceLevel || 'UNCLASSIFIED',
        document.metadata?.sectionMetadata || []
      );
    } else {
      // HTML section-based redaction — use VC-first path
      const packageBuffer = await decryptFromIagon(document.iagonStorage, document.classificationLevel, documentDID);
      const encryptedPackage = JSON.parse(packageBuffer.toString('utf8'));
      const decryptionResult = SectionEncryptionService.decryptSectionsForUser(
        encryptedPackage,
        clearanceLevel || 'UNCLASSIFIED',
        COMPANY_SECRET
      );
      redactedContent = RedactionEngine.generateRedactedDocument({
        metadata: encryptedPackage?.metadata || document.metadata,
        decryptedSections: decryptionResult.decryptedSections,
        redactedSections:  decryptionResult.redactedSections,
        userClearance: clearanceLevel || 'UNCLASSIFIED'
      }, { viewerName: viewerName || 'Unknown' });
    }

    // --- 9. Create EphemeralDID as access grant / audit token ---
    const { metadata: ephemeralMetadata } = EphemeralDIDService.createEphemeralDID({
      originalDocumentDID: documentDID,
      clearanceLevel: clearanceLevel || 'UNCLASSIFIED',
      issuerDID,
      ttlMs: EphemeralDIDService.DEFAULT_TTL_MS,
      viewsAllowed: -1
    });
    ephemeralDIDStore.set(ephemeralMetadata.ephemeralDID, ephemeralMetadata);

    // --- 10. Re-encrypt for wallet's ephemeral X25519 key (PFS) ---
    const contentBytes = Buffer.isBuffer(redactedContent) ? redactedContent : Buffer.from(redactedContent, 'utf8');
    const encrypted = ReEncryptionService.encryptForEphemeralKey(contentBytes, ephemeralPublicKey);

    // --- 11. Generate copyId for audit ---
    const copyId = crypto.randomUUID();
    const copyHash = crypto.createHash('sha256').update(contentBytes).update(copyId).digest('hex');

    fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
      timestamp: new Date().toISOString(),
      viewerName: viewerName || null,
      documentDID,
      documentTitle: document?.title || null,
      clearanceLevel: clearanceLevel || null,
      companyDID: document.ownerCompanyDID || null,
      accessGranted: true,
      denialReason: null,
      copyId,
      clientIp: req.ip || req.connection?.remoteAddress || null
    }) + '\n', () => {});
    // Record for /api/access-gate/notify's dedup check — the wallet's first cached-key
    // decrypt (right after this grant) must not produce a second "reopen" log row.
    recentDocumentLogTimestamps.set(documentDID, Date.now());

    console.log(`[AccessGate] ✅ Access GRANTED — ephemeralDID: ${ephemeralMetadata.ephemeralDID.substring(0, 50)}...`);

    res.json({
      success: true,
      granted: true,
      documentDID,
      copyId,
      copyHash,
      ephemeralDID: ephemeralMetadata.ephemeralDID,
      clearanceLevel: clearanceLevel || 'UNCLASSIFIED',
      documentMetadata: {
        title: document.metadata?.title || document.metadata?.name || `Document ${copyId}`,
        overallClassification: document.classificationLevel || 'UNCLASSIFIED'
      },
      encryptedDocument: {
        ciphertext:       encrypted.ciphertext,
        nonce:            encrypted.nonce,
        serverPublicKey:  encrypted.serverPublicKey,
        copyId,
        filename:         document.iagonStorage?.filename || `document-${copyId}`,
        mimeType:         isDocxDoc
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/html',
        classificationLevel: document.classificationLevel
      },
      ciphertext:       encrypted.ciphertext,
      nonce:            encrypted.nonce,
      serverPublicKey:  encrypted.serverPublicKey,
      filename:         document.iagonStorage?.filename || `document-${copyId}`,
      mimeType:         isDocxDoc
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/html',
      classificationLevel: document.classificationLevel,
      accessedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[AccessGate] Error processing VP presentation:', error);
    if (error.name === 'ManifestVCInvalid' || (error.message && error.message.includes('ManifestVCInvalid'))) {
      return res.status(403).json({
        success: false,
        error: 'ManifestVCInvalid',
        message: 'Document key manifest VC is invalid or has been tampered with.'
      });
    }
    if (error.message && error.message.includes('DocumentKeyUnavailable')) {
      return res.status(503).json({
        success: false,
        error: 'DocumentKeyUnavailable',
        message: 'This document\'s encryption key is unavailable. The document must be re-uploaded by an administrator.'
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to process VP presentation'
    });
  }
});

/**
 * POST /api/access-gate/notify
 * Lightweight audit endpoint for cached-key document re-opens.
 * Called by the wallet when a document is decrypted using a cached ephemeral key
 * (no VP re-verification needed; access was already granted on first open).
 */
app.post('/api/access-gate/notify', async (req, res) => {
  try {
    const { documentDID, ephemeralDID, clearanceLevel } = req.body;
    if (!documentDID) {
      return res.status(400).json({ success: false, error: 'MissingDocumentDID' });
    }

    // Dedup: skip the write if this documentDID was already logged (grant or a previous
    // reopen) within the last DEDUP_WINDOW_MS — see lib/AccessGateLogDedup.js. This is what
    // keeps the very first /notify call (fired immediately after a fresh grant) from
    // producing a second, viewerName:null noise row alongside the grant's own "Granted" entry.
    const now = Date.now();
    if (shouldSkipDuplicateLog(recentDocumentLogTimestamps.get(documentDID), now)) {
      console.log(`[AccessGate] 📖 Cached-key reopen suppressed (recently logged) — documentDID: ${String(documentDID).substring(0, 50)}...`);
      return res.json({ success: true });
    }

    const document = DocumentRegistry.documents.get(documentDID);

    fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify({
      timestamp: new Date().toISOString(),
      viewerName: null,
      documentDID,
      documentTitle: document?.title || null,
      clearanceLevel: clearanceLevel || null,
      companyDID: document?.ownerCompanyDID || null,
      accessGranted: true,
      denialReason: null,
      copyId: ephemeralDID || null,
      clientIp: req.ip || req.connection?.remoteAddress || null,
      accessType: 'CACHED_KEY_REOPEN'
    }) + '\n', () => {});
    recentDocumentLogTimestamps.set(documentDID, now);

    console.log(`[AccessGate] 📖 Cached-key reopen logged — documentDID: ${String(documentDID).substring(0, 50)}...`);
    res.json({ success: true });
  } catch (error) {
    console.error('[AccessGate] Notify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// DOCUMENT UPDATE / VERSIONING ENDPOINTS
// =============================================================================

/**
 * Resolve the highest clearance level actually present in a document's DOCX.
 *
 * Precedence:
 *  1. sectionMetadata already stored in the registry (cheap, no Iagon round-trip).
 *  2. Parse the original DOCX from Iagon (expensive but authoritative — required when
 *     the document was uploaded via the plain-upload endpoint that skips section parsing).
 *  3. Fall back to document.classificationLevel.
 *
 * Returns a numeric level (0–4).
 */
async function resolveDocumentHighestLevel(document, documentDID) {
  const LEVEL = { 'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2, 'RESTRICTED': 3, 'SECRET': 4, 'TOP-SECRET': 4, 'TOP_SECRET': 4 };

  // 1. sectionMetadata path (classified-upload documents)
  const regLevels = (document.metadata?.sectionMetadata || [])
    .map(s => LEVEL[s.clearance?.toUpperCase()] ?? 0);
  if (regLevels.length > 0) return Math.max(...regLevels);

  // 2. Parse original DOCX from Iagon
  try {
    const srcFileId       = document.iagonStorage?.originalDocxFileId || document.iagonStorage?.fileId;
    const srcManifestId   = document.iagonStorage?.originalDocxManifestId || document.iagonStorage?.encryptionManifestId || null;
    const srcEncInfo      = document.iagonStorage?.originalDocxEncryptionInfo || document.iagonStorage?.encryptionInfo || null;
    if (!srcFileId) throw new Error('no fileId');

    const iagonClient = getIagonClient();
    let docxBuf;

    if (srcManifestId) {
      const wrapped  = await iagonClient.downloadKeyManifest(srcManifestId);
      const rawDEK   = cmk.unwrapDEK(wrapped, document.classificationLevel);
      docxBuf        = await iagonClient.downloadFile(srcFileId, { ...srcEncInfo, key: rawDEK.toString('base64') });
      rawDEK.fill(0);
    } else {
      // VC-first path
      const docServiceUrl = process.env.DOCUMENT_SERVICE_URL;
      const adminKey      = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
      const vcRecord      = await fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey);
      if (vcRecord) {
        const verifier = new (require('./lib/KeyManifestVCVerifier'))({ inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC });
        const vr = await verifier.verify(vcRecord);
        if (vr.valid) {
          const rawDEK = cmk.unwrapDEK(vr.claims, document.classificationLevel);
          docxBuf      = await iagonClient.downloadFile(srcFileId, {
            algorithm: vr.claims.fileAlgorithm || 'AES-256-GCM',
            iv: vr.claims.fileIv, authTag: vr.claims.fileAuthTag,
            key: rawDEK.toString('base64')
          });
          rawDEK.fill(0);
        }
      }
      if (!docxBuf) docxBuf = await iagonClient.downloadFile(srcFileId, srcEncInfo || null);
    }

    const parsed = await DocxClearanceParser.parseDocxClearanceSections(docxBuf);
    const highest = parsed.sections.reduce((m, s) => Math.max(m, s.clearanceLevel ?? 0), 0);
    console.log(`[resolveDocumentHighestLevel] Parsed DOCX for ${documentDID?.substring(0,40)}: highest section = ${highest}`);
    return highest;
  } catch (err) {
    console.warn('[resolveDocumentHighestLevel] DOCX parse fallback failed:', err.message);
  }

  // 3. Fallback to classificationLevel
  return LEVEL[document.classificationLevel?.toUpperCase()] ?? 1;
}

/**
 * POST /api/document-update/request-edit
 * Request an editable (redacted) version of a DOCX document for editing.
 *
 * Body: { documentDID, vp, challenge, ephemeralPublicKey }
 * Returns: { editToken, encryptedEditableDocument, filename, mimeType, expiresIn }
 */
app.post('/api/document-update/request-edit', async (req, res) => {
  console.log('\n' + '='.repeat(70));
  console.log('[DocumentUpdate] Edit request received');
  console.log('='.repeat(70));

  try {
    const { documentDID, vp, challenge, ephemeralPublicKey } = req.body;

    // 1. Validate inputs
    if (!documentDID || !vp || !challenge) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'documentDID, vp, and challenge are required'
      });
    }

    // 2. Consume challenge (one-time use)
    const pendingChallenge = pendingDocumentAccessChallenges.get(challenge);
    if (!pendingChallenge) {
      return res.status(403).json({ success: false, error: 'InvalidChallenge', message: 'Challenge not found or expired' });
    }
    if (pendingChallenge.documentDID !== documentDID) {
      return res.status(403).json({ success: false, error: 'ChallengeMismatch', message: 'Challenge was issued for a different document' });
    }
    const challengeAge = Date.now() - pendingChallenge.timestamp;
    if (challengeAge > 5 * 60 * 1000) {
      pendingDocumentAccessChallenges.delete(challenge);
      return res.status(403).json({ success: false, error: 'ChallengeExpired', message: 'Challenge has expired' });
    }
    pendingDocumentAccessChallenges.delete(challenge);

    // 3. Verify VP and extract claims
    const vpResult = VPVerificationService.verifyVPAndExtractClaims(vp, ACCEPTED_ISSUER_DIDS);
    if (!vpResult.success) {
      return res.status(403).json({ success: false, error: vpResult.error, message: vpResult.message });
    }

    const { companyDID, clearanceLevel, issuerDID, viewerName } = vpResult;
    console.log(`[DocumentUpdate] VP verified — issuerDID: ${issuerDID?.substring(0, 50)}...`);

    // 4. Look up document
    const document = DocumentRegistry.documents.get(documentDID);
    if (!document) {
      return res.status(404).json({ success: false, error: 'DocumentNotFound', message: 'Document not found in registry' });
    }

    // 5. Releasability check
    if (!document.releasableTo || !document.releasableTo.includes(issuerDID)) {
      return res.status(403).json({ success: false, error: 'ReleasabilityDenied', message: 'Your credential issuer is not authorized for this document' });
    }

    // 6. Clearance check — editor must cover the highest section (no merge needed)
    // Uses resolveDocumentHighestLevel which parses the original DOCX when sectionMetadata
    // is absent (plain-upload documents), preventing lower-clearance editors from overwriting
    // with a redacted copy that strips content from higher-clearance users.
    const CLEARANCE_NUMERIC = { 'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2, 'RESTRICTED': 3, 'SECRET': 4, 'TOP-SECRET': 4, 'TOP_SECRET': 4 };
    const highestSectionLevel = await resolveDocumentHighestLevel(document, documentDID);
    const userLevel = CLEARANCE_NUMERIC[clearanceLevel?.toUpperCase()] ?? 0;
    if (userLevel < highestSectionLevel) {
      const requiredLabel = Object.keys(CLEARANCE_NUMERIC).find(k => CLEARANCE_NUMERIC[k] === highestSectionLevel) || String(highestSectionLevel);
      return res.status(403).json({
        success: false,
        error: 'InsufficientClearance',
        message: `Editing requires clearance covering all sections. Required: ${requiredLabel}, yours: ${clearanceLevel || 'UNCLASSIFIED'}`
      });
    }

    // 7. Check document is DOCX (allow pre-encrypted uploads by filename, not just originalDocxFileId)
    const isDocxEdit = document.iagonStorage?.originalDocxFileId ||
      (document.iagonStorage?.filename || '').toLowerCase().endsWith('.docx') ||
      document.metadata?.sourceFormat === 'docx';
    if (!isDocxEdit) {
      return res.status(400).json({ success: false, error: 'NotDocxDocument', message: 'Document is not a DOCX file' });
    }

    // 8. Sign edit token (5-minute expiry)
    const editToken = jwt.sign({
      sub:            'document-edit',
      documentDID,
      editorDID:      viewerName || issuerDID,
      companyDID:     companyDID || issuerDID,
      clearanceLevel: clearanceLevel || 'INTERNAL',
      exp:            Math.floor(Date.now() / 1000) + 300
    }, COMPANY_SECRET, { algorithm: 'HS256' });

    console.log(`[DocumentUpdate] ✅ Edit token issued for ${documentDID}`);

    res.json({
      success: true,
      editToken,
      expiresIn: 300
    });

  } catch (error) {
    console.error('[DocumentUpdate] Error in request-edit:', error);
    res.status(500).json({ success: false, error: 'InternalServerError', message: error.message });
  }
});

/**
 * POST /api/document-update/submit
 * Submit an edited DOCX for merging and versioning.
 *
 * Multipart form: file (DOCX), editToken (JWT string)
 */
app.post('/api/document-update/submit', uploadDocx.single('file'), async (req, res) => {
  console.log('\n' + '='.repeat(70));
  console.log('[DocumentUpdate] Edit submission received');
  console.log('='.repeat(70));

  try {
    // 1. Validate inputs
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'file is required' });
    }
    if (!req.body.editToken) {
      return res.status(400).json({ success: false, error: 'BadRequest', message: 'editToken is required' });
    }

    // 2. Verify token
    let decoded;
    try {
      decoded = jwt.verify(req.body.editToken, COMPANY_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(403).json({ success: false, error: 'InvalidEditToken', message: 'Edit token is invalid or expired' });
    }

    const { documentDID, clearanceLevel, editorDID, companyDID } = decoded;

    // 3. Look up document
    const document = DocumentRegistry.documents.get(documentDID);
    if (!document) {
      return res.status(404).json({ success: false, error: 'DocumentNotFound', message: 'Document not found in registry' });
    }

    // 3.5. Re-validate editor clearance against actual document section levels.
    // Defence-in-depth: request-edit already does this check, but the submit endpoint
    // must independently verify so a lower-clearance user cannot bypass it (e.g. by
    // replaying an old token or exploiting a gap where sectionMetadata was absent at
    // request-edit time).  resolveDocumentHighestLevel downloads and parses the original
    // DOCX when sectionMetadata is missing, which is the only reliable way to detect
    // SECRET-styled paragraphs inside a document whose classificationLevel was set lower.
    const CLEARANCE_NUMERIC_SUBMIT = { 'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2, 'RESTRICTED': 3, 'SECRET': 4, 'TOP-SECRET': 4, 'TOP_SECRET': 4 };
    const editorNumericLevel = CLEARANCE_NUMERIC_SUBMIT[clearanceLevel?.toUpperCase()] ?? 0;
    const docHighestLevel = await resolveDocumentHighestLevel(document, documentDID);
    if (editorNumericLevel < docHighestLevel) {
      const requiredLabel = Object.keys(CLEARANCE_NUMERIC_SUBMIT).find(k => CLEARANCE_NUMERIC_SUBMIT[k] === docHighestLevel) || String(docHighestLevel);
      console.warn(`[DocumentUpdate] ❌ Submit rejected: editor clearance ${clearanceLevel} (${editorNumericLevel}) < document highest level ${requiredLabel} (${docHighestLevel})`);
      return res.status(403).json({
        success: false,
        error: 'InsufficientClearance',
        message: `Submitting an update requires ${requiredLabel} clearance (document contains ${requiredLabel}-classified sections). Your clearance: ${clearanceLevel || 'UNCLASSIFIED'}`
      });
    }

    // 4. Use submitted file directly — editor had full clearance, no merge needed
    const iagonClient = getIagonClient();
    const mergedDocx = req.file.buffer;

    // 6. Compute content hash
    const contentHash = 'sha256:' + crypto.createHash('sha256').update(mergedDocx).digest('hex');

    // 7. Upload merged DOCX to Iagon
    const newResult = await iagonClient.uploadFile(
      mergedDocx,
      `updated-${Date.now()}.docx`,
      { classificationLevel: document.classificationLevel }
    );

    // 7b. Verify the upload round-trips correctly before committing to registry.
    // Iagon occasionally returns a stale fileId that points to a different file,
    // causing AES-GCM authentication failures on the next download.
    // Task 2: build a temporary encryptionInfo with the raw DEK for verification only.
    const verifyEncryptionInfo = newResult.encryptionInfo && newResult.rawDEK
      ? { ...newResult.encryptionInfo, key: newResult.rawDEK.toString('base64') }
      : newResult.encryptionInfo;
    try {
      await iagonClient.downloadFile(newResult.fileId, verifyEncryptionInfo);
      console.log(`[DocumentUpdate] ✅ Upload verified (fileId=${newResult.fileId})`);
    } catch (verifyErr) {
      console.error(`[DocumentUpdate] ❌ Upload verification failed: ${verifyErr.message}`);
      return res.status(502).json({
        success: false,
        error: 'UploadVerificationFailed',
        message: 'Document was uploaded but could not be read back from storage — Iagon may have returned a stale file ID. Please try again.'
      });
    }

    // Task 2: Wrap DEK with CMK before persisting
    let updateManifestId = null;
    let updateWrappedManifest = null;
    if (newResult.rawDEK) {
      try {
        updateWrappedManifest = cmk.wrapDEK(newResult.rawDEK, document.classificationLevel);
        newResult.rawDEK.fill(0); // zero raw key from memory (PFS)

        const { manifestFileId } = await iagonClient.uploadKeyManifest(
          updateWrappedManifest,
          `update-${Date.now()}`
        );
        updateManifestId = manifestFileId;
        console.log(`[DocumentUpdate] ✅ Key manifest uploaded to Iagon: ${updateManifestId}`);
      } catch (manifestErr) {
        console.error('[DocumentUpdate] Failed to upload key manifest to Iagon:', manifestErr.message);
        // Continue — will fall back to legacy path during access
      }
    }

    // Push versioned KeyManifest VC to document-service
    let updateVCId = null;
    if (updateWrappedManifest && newResult.fileId && documentDID) {
      try {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || null;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcIssuer = new KeyManifestVCIssuer(docServiceUrl, adminKey);
        const prevVC = await fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey);
        const versionNumber = (prevVC?.claims?.versionNumber ?? 0) + 1;
        const predecessorHash = prevVC ? KeyManifestVCIssuer.computePredecessorHash(prevVC.vcJwt) : null;

        const vcResult = await vcIssuer.issue({
          documentDID,
          issuerDID:          process.env.SERVICE_DID,
          iagonFileId:        newResult.fileId,
          classificationLevel: document.classificationLevel,
          releasableTo:       document.releasableTo || [],
          wrappedKey:         updateWrappedManifest.wrappedKey,
          iv:                 updateWrappedManifest.iv,
          authTag:            updateWrappedManifest.authTag,
          wrappingAlgorithm:  updateWrappedManifest.wrappingAlgorithm || 'AES-256-GCM',
          fileAlgorithm:      newResult.encryptionInfo?.algorithm || 'AES-256-GCM',
          fileIv:             newResult.encryptionInfo?.iv,
          fileAuthTag:        newResult.encryptionInfo?.authTag,
          contentHash:        contentHash || null,
          versionNumber,
          updatedBy:          editorDID || null,
          predecessorHash
        });
        updateVCId = vcResult.vcId;
        console.log(`[DocumentUpdate] ✅ KeyManifest VC v${versionNumber} pushed: ${updateVCId}`);
      } catch (vcErr) {
        console.error('[DocumentUpdate] ⚠️ KeyManifest VC push failed (non-fatal):', vcErr.message);
      }
    }

    // Capture previousFileId before addDocumentVersion overwrites it (for audit trail recovery)
    const previousDocxFileId = document.iagonStorage?.originalDocxFileId || document.iagonStorage?.fileId || null;

    // 8. Update registry with immutable version chain (including new encryption key)
    const newVersion = await DocumentRegistry.addDocumentVersion(documentDID, {
      newDocxFileId:       newResult.fileId,
      encryptionManifestId: updateManifestId,              // Task 2: manifest replaces raw key
      encryptionInfo:      newResult.encryptionInfo || null, // iv, authTag, algorithm — NO key
      contentHash,
      editorDID,
      clearanceLevel,
      manifestVcId:        updateVCId
    });

    // 9. On-chain anchoring (fire-and-forget, non-fatal)
    const enterpriseApiKey = process.env.ENTERPRISE_API_KEY || process.env.COMPANY_SECRET;
    if (enterpriseApiKey) {
      (async () => {
        try {
          const serviceEndpoint = `https://identuslabel.cz/company-admin/api/document-versions/${encodeURIComponent(documentDID)}`;
          // Check if service endpoint already exists
          let actionType = 'ADD_SERVICE';
          try {
            const didInfoResult = await enterpriseAgentRequest(enterpriseApiKey, `/did-registrar/dids/${encodeURIComponent(documentDID)}`, {});
            const services = didInfoResult?.data?.didDocument?.service || [];
            if (services.some(s => s.id === 'document-version')) {
              actionType = 'UPDATE_SERVICE';
            }
          } catch (_) { /* proceed with ADD_SERVICE */ }

          await enterpriseAgentRequest(enterpriseApiKey, `/did-registrar/dids/${encodeURIComponent(documentDID)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              actions: [{
                actionType,
                updateService: {
                  id:              'document-version',
                  type:            'LinkedDomains',
                  serviceEndpoint: [serviceEndpoint]
                }
              }]
            })
          });
          await enterpriseAgentRequest(enterpriseApiKey, `/did-registrar/dids/${encodeURIComponent(documentDID)}/publications`, {
            method: 'POST'
          });
          console.log(`[UpdateDID] On-chain anchoring submitted for ${documentDID} version ${newVersion.versionId}`);
        } catch (err) {
          console.error(`[UpdateDID] On-chain anchoring failed for ${documentDID}:`, err.message);
        }
      })();
    }

    // 10. Audit log — eventType "UPDATED" so it renders as "✏️ Updated" in the admin
    // Document Access Logs table (public/app.js switches on eventType), matching the
    // convention already used by the CREATE-event log writes above.
    // companyDID MUST be the document's own ownerCompanyDID, not the editor's token companyDID —
    // the edit token's companyDID reflects the *presenting editor's* employer (set at
    // /api/document-update/request-edit time), which can legitimately differ from the
    // document's actual owning company now that cross-company edit access is possible via
    // Releasable-To-Partners. Attributing the update to the editor's company instead of the
    // document's owning company would misfile it in the wrong admin's log.
    fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify(buildLogEntry({
      eventType:      'UPDATED',
      viewerName:     editorDID,
      documentDID,
      documentTitle:  document.title || null,
      clearanceLevel: document.classificationLevel || null,
      companyDID:     document.ownerCompanyDID || null,
      accessGranted:  true,
      denialReason:   null,
      copyId:         null,
      clientIp:       req.ip || req.connection?.remoteAddress || null
    })) + '\n', () => {});

    console.log(`[DocumentUpdate] ✅ Version ${newVersion.versionId} created for ${documentDID}`);

    res.json({
      success:       true,
      documentDID,
      versionId:     newVersion.versionId,
      newFileId:     newResult.fileId,
      previousFileId:  document.iagonStorage?.originalDocxFileId || document.iagonStorage?.fileId || null,
      contentHash,
      onChainStatus: 'anchoring_submitted',
      updatedAt:     newVersion.createdAt
    });

  } catch (error) {
    console.error('[DocumentUpdate] Error in submit:', error);
    res.status(500).json({ success: false, error: 'InternalServerError', message: error.message });
  }
});

/**
 * GET /api/document-versions/:documentDID
 * Public endpoint — returns version history without raw Iagon fileIds.
 * URL is embedded in the DID Document service endpoint after versioning.
 */
app.get('/api/document-versions/:documentDID', (req, res) => {
  const documentDID = decodeURIComponent(req.params.documentDID);
  const versions = DocumentRegistry.getDocumentVersions(documentDID);
  if (!versions.length) {
    return res.status(404).json({ error: 'NoVersionHistory', documentDID });
  }
  // Strip raw fileIds from public response
  const publicVersions = versions.map(({ fileId: _omit, ...v }) => v);
  res.json({ documentDID, versions: publicVersions });
});

/**
 * GET /api/documents/:documentDID/vc-history
 * Proxy: fetch the KeyManifest VC version history from document-service.
 * Returns { documentDID, current: vcRecord, history: vcRecord[] }.
 * Strips vcJwt from history entries (sensitive — only current VC has it).
 */
app.get('/api/documents/:documentDID/vc-history', async (req, res) => {
  const documentDID = decodeURIComponent(req.params.documentDID);
  const docServiceUrl = process.env.DOCUMENT_SERVICE_URL;
  const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;

  if (!docServiceUrl) {
    return res.status(503).json({ error: 'DocumentServiceUnavailable', message: 'Document service URL not configured' });
  }

  try {
    const upstream = await fetch(
      `${docServiceUrl}/vc/key-manifest/${encodeURIComponent(documentDID)}/history`,
      { headers: { 'x-admin-key': adminKey }, timeout: 5000 }
    );
    if (upstream.status === 404) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No VC history for this document' });
    }
    if (!upstream.ok) {
      return res.status(502).json({ error: 'UpstreamError', message: `Document service returned ${upstream.status}` });
    }
    const data = await upstream.json();

    // Include vcJwt in history entries so the wallet can verify the predecessor hash chain
    res.json({
      documentDID,
      current: data.current,
      history: data.history || []
    });
  } catch (err) {
    console.error('[VCHistory] Error fetching from document-service:', err.message);
    res.status(500).json({ error: 'InternalServerError', message: err.message });
  }
});

/**
 * GET /api/ephemeral-documents/metadata/:documentDID
 * Get document metadata by Document DID (without content)
 *
 * Pure SSI Architecture - No Database Required
 * Uses DocumentRegistry (in-memory) to lookup document metadata
 *
 * @param {string} documentDID - URL-encoded Document DID (e.g., did:prism:...)
 */
app.get('/api/ephemeral-documents/metadata/:documentDID', async (req, res) => {
  try {
    // URL-decode the documentDID since DIDs contain special characters
    const documentDID = decodeURIComponent(req.params.documentDID);

    if (!documentDID || !documentDID.startsWith('did:')) {
      return res.status(400).json({
        success: false,
        error: 'InvalidRequest',
        message: 'Valid document DID is required (must start with did:)'
      });
    }

    const document = ReEncryptionService.getDocumentMetadata(documentDID);

    if (!document) {
      return res.status(404).json({
        success: false,
        error: 'NotFound',
        message: 'Document not found in registry'
      });
    }

    // Enrich with VC history (version number + updatedBy)
    let versionNumber = null;
    let lastUpdatedBy = null;
    let lastUpdatedAt = null;
    try {
      const docServiceUrl = process.env.DOCUMENT_SERVICE_URL;
      const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
      if (docServiceUrl) {
        const histRes = await fetch(
          `${docServiceUrl}/vc/key-manifest/${encodeURIComponent(documentDID)}/history`,
          { headers: { 'x-admin-key': adminKey } }
        );
        if (histRes.ok) {
          const hist = await histRes.json();
          const current = hist.current;
          if (current) {
            versionNumber = current.claims?.versionNumber ?? null;
            lastUpdatedAt = current.issuedAt || null;
            // Decode email from long-form PRISM DID — email is base64url-encoded in state portion
            const updatedByDID = current.claims?.updatedBy || '';
            if (updatedByDID) {
              let emailMatch = null;
              try {
                const didParts = updatedByDID.split(':');
                if (didParts.length >= 4) {
                  const decoded = Buffer.from(didParts[3], 'base64').toString('latin1');
                  emailMatch = decoded.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
                }
              } catch (_) {}
              lastUpdatedBy = emailMatch ? emailMatch[1] : updatedByDID.split(':').slice(0, 3).join(':');
            }
          }
        }
      }
    } catch (_) { /* VC history enrichment is best-effort */ }

    res.json({
      success: true,
      document: { ...document, versionNumber, lastUpdatedBy, lastUpdatedAt }
    });

  } catch (error) {
    console.error('[EphemeralDocuments] Error getting document metadata:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to get document metadata'
    });
  }
});

/**
 * GET /api/ephemeral-documents/content/:ephemeralId
 * Service endpoint for retrieving encrypted document content by ephemeral ID.
 *
 * This is the service endpoint URL embedded in the ephemeral DID.
 * The document is already encrypted for the specific wallet's X25519 key.
 *
 * SSI Architecture:
 * - DocumentCopy VC delivered via DIDComm (contains ephemeralDID with this URL)
 * - Browser wallet fetches encrypted content from this endpoint
 * - Browser wallet decrypts locally using its X25519 private key
 *
 * No authentication required - document is encrypted for specific wallet.
 *
 * @param {string} ephemeralId - UUID portion of did:ephemeral:{uuid}
 * @returns {Object} { encryptedContent, nonce, serverPublicKey, contentType }
 */
app.get('/api/ephemeral-documents/content/:ephemeralId', async (req, res) => {
  const EphemeralDocumentStore = require('./lib/EphemeralDocumentStore');

  try {
    const { ephemeralId } = req.params;

    console.log(`[EphemeralContent] Service endpoint request for: ${ephemeralId}`);

    // Validate ephemeral ID format (should be UUID)
    if (!ephemeralId || ephemeralId.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'InvalidRequest',
        message: 'Valid ephemeral ID is required'
      });
    }

    // Get encrypted document from store
    const document = await EphemeralDocumentStore.get(ephemeralId);

    if (!document) {
      console.log(`[EphemeralContent] Document not found or expired: ${ephemeralId}`);
      return res.status(404).json({
        success: false,
        error: 'NotFound',
        message: 'Document not found or expired'
      });
    }

    // Check expiry
    if (new Date(document.expiresAt) < new Date()) {
      console.log(`[EphemeralContent] Document expired: ${ephemeralId}`);
      await EphemeralDocumentStore.delete(ephemeralId);
      return res.status(410).json({
        success: false,
        error: 'Expired',
        message: 'Document has expired'
      });
    }

    console.log(`[EphemeralContent] Serving encrypted document: ${ephemeralId}`);
    console.log(`[EphemeralContent] Content type: ${document.contentType}, Size: ${document.contentSize} bytes`);

    // Return encrypted document for client-side decryption
    res.json({
      success: true,
      encryptedContent: document.encryptedContent,
      nonce: document.nonce,
      serverPublicKey: document.serverPublicKey,
      contentType: document.contentType || 'text/html',
      expiresAt: document.expiresAt
    });

  } catch (error) {
    console.error('[EphemeralContent] Error serving document:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to serve document'
    });
  }
});

/**
 * GET /api/documents/download-by-did/:documentDID
 * Download document content by parsing the PRISM DID to extract Iagon file ID
 *
 * This endpoint acts as a proxy to work around Iagon's POST-only download API.
 * The document DID contains the Iagon file URL in its service endpoint.
 */
app.get('/api/documents/download-by-did/:documentDID', async (req, res) => {
  try {
    const documentDID = decodeURIComponent(req.params.documentDID);

    console.log('[DocumentDownload] Download request for DID:', documentDID.substring(0, 50) + '...');

    // Parse the PRISM DID to extract Iagon URL info
    // DID format: did:prism:[stateHash]:[base64urlEncodedState]
    const parts = documentDID.split(':');
    if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'prism') {
      return res.status(400).json({
        success: false,
        error: 'InvalidDID',
        message: 'Invalid PRISM DID format'
      });
    }

    // Extract and decode the state part (last segment)
    const encodedState = parts[parts.length - 1];

    // Base64url decode
    let stateJson;
    try {
      const base64 = encodedState.replace(/-/g, '+').replace(/_/g, '/');
      const padding = base64.length % 4;
      const paddedBase64 = padding > 0 ? base64 + '='.repeat(4 - padding) : base64;
      const binaryStr = Buffer.from(paddedBase64, 'base64').toString('binary');

      // Look for Iagon URL pattern in the binary data
      // The URL is embedded in the service endpoint
      // Support both old format (filename&nodeId) and new format (fileId&filename)
      const iagonPatternNew = /https:\/\/gw\.iagon\.com\/api\/v2\/download\?fileId=([a-f0-9]+)&filename=([^&\s"\]]+)/;
      const iagonPatternOld = /https:\/\/gw\.iagon\.com\/api\/v2\/download\?filename=([^&]+)&nodeId=([a-f0-9]+)/;

      let fileId, filename;
      const matchNew = binaryStr.match(iagonPatternNew);
      const matchOld = binaryStr.match(iagonPatternOld);

      if (matchNew) {
        fileId = matchNew[1];
        filename = decodeURIComponent(matchNew[2]);
        console.log('[DocumentDownload] Extracted from DID (new format):', { fileId, filename });
      } else if (matchOld) {
        // Old format - nodeId was actually the file ID
        fileId = matchOld[2];
        filename = decodeURIComponent(matchOld[1]);
        console.log('[DocumentDownload] Extracted from DID (old format):', { fileId, filename });
      } else {
        console.error('[DocumentDownload] No Iagon URL found in DID state');
        return res.status(400).json({
          success: false,
          error: 'NoIagonUrl',
          message: 'Could not extract Iagon URL from document DID'
        });
      }

      // Use IagonStorageClient to download the file
      const { IagonStorageClient } = require('./lib/IagonStorageClient');
      const iagonClient = new IagonStorageClient({
        accessToken: process.env.IAGON_ACCESS_TOKEN,
        nodeId: process.env.IAGON_NODE_ID,
        downloadBaseUrl: 'https://gw.iagon.com/api/v2'
      });

      // Look up document in registry to get encryption info
      // First try by exact DID match, then fallback to fileId lookup
      let documentRecord = DocumentRegistry.documents.get(documentDID);

      // If DID lookup fails (common when URL DID has service endpoints that don't match stored DID),
      // use fileId as fallback lookup key
      if (!documentRecord && fileId) {
        console.log('[DocumentDownload] DID not found, trying fileId lookup:', fileId);
        documentRecord = DocumentRegistry.findByFileId(fileId);
        if (documentRecord) {
          console.log('[DocumentDownload] Found document via fileId lookup');
        }
      }

      let encryptionInfo = null;

      if (documentRecord && documentRecord.iagonStorage && documentRecord.iagonStorage.encryptionInfo) {
        encryptionInfo = documentRecord.iagonStorage.encryptionInfo;
        console.log('[DocumentDownload] Found encryption info in registry:', {
          algorithm: encryptionInfo.algorithm,
          keyId: encryptionInfo.keyId
        });
      } else {
        console.log('[DocumentDownload] No encryption info found in registry (INTERNAL document or legacy)');
      }

      // Use the extracted fileId for Iagon download
      console.log('[DocumentDownload] Downloading from Iagon with file ID:', fileId);

      const fileContent = await iagonClient.downloadFile(fileId, encryptionInfo);

      // Determine content type from filename
      let contentType = 'application/octet-stream';
      if (filename.endsWith('.pdf')) {
        contentType = 'application/pdf';
      } else if (filename.endsWith('.txt')) {
        contentType = 'text/plain';
      } else if (filename.endsWith('.json')) {
        contentType = 'application/json';
      } else if (filename.endsWith('.doc') || filename.endsWith('.docx')) {
        contentType = 'application/msword';
      } else if (filename.endsWith('.png')) {
        contentType = 'image/png';
      } else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
        contentType = 'image/jpeg';
      }

      // Set headers for file download
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', fileContent.length);

      console.log('[DocumentDownload] Sending file:', { filename, contentType, size: fileContent.length });

      res.send(fileContent);

    } catch (parseError) {
      console.error('[DocumentDownload] Error parsing DID or downloading:', parseError);
      throw parseError;
    }

  } catch (error) {
    console.error('[DocumentDownload] Error:', error);
    res.status(500).json({
      success: false,
      error: 'DownloadError',
      message: error.message || 'Failed to download document'
    });
  }
});

// ============================================================================
// Security Clearance Verification - Employee Portal
// ============================================================================

// Pending clearance verification requests (verificationId -> data)
const pendingClearanceVerifications = new Map();

/**
 * POST /api/employee-portal/clearance/initiate
 * Initiate Security Clearance VC verification via DIDComm.
 *
 * ARCHITECTURE: SecurityClearance VC lives in the employee's PERSONAL wallet (SDK/Pluto/IndexedDB),
 * not the enterprise wallet. The personal wallet connects to the company's 8200 multitenancy tenant
 * separately from the enterprise wallet connection (session.connectionId is the enterprise connection
 * and is explicitly excluded from the search below).
 *
 * Flow: Employee Portal → Company Admin Portal → searches 8200 connections for personal wallet →
 *       sends proof request to personal wallet connection → IDL Wallet (personal mode) receives it
 */
app.post('/api/employee-portal/clearance/initiate', requireEmployeeSession, async (req, res) => {
  try {
    const session = req.employeeSession;
    const token = req.headers['x-session-token'];

    console.log('\n' + '='.repeat(70));
    console.log('[ClearanceVerification] Initiating Security Clearance verification');
    console.log(`   Employee: ${session.email} (${session.employeeId})`);
    console.log(`   PRISM DID: ${session.prismDid}`);
    console.log(`   Enterprise connectionId (excluded): ${session.connectionId}`);
    console.log('='.repeat(70));

    const MULTITENANCY_URL = process.env.MULTITENANCY_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
    const enterpriseConnectionId = session.connectionId; // exclude this — it routes to enterprise wallet

    // Fetch stored personal_wallet_connection_id from DB (email-keyed)
    let storedConnId = null;
    try {
      const empDb = getEnterpriseDb();
      const storedEmployee = await empDb.getEmployeeByEmail(session.email);
      storedConnId = storedEmployee?.personal_wallet_connection_id || null;
      if (storedConnId) console.log(`[ClearanceVerification] DB stored connection ID: ${storedConnId}`);
    } catch (dbErr) {
      console.warn(`[ClearanceVerification] DB lookup failed: ${dbErr.message}`);
    }

    // Search ALL company tenants for the personal wallet connection.
    // session.issuerDID is unreliable (EmployeeWalletManager hardcodes TechCorp as JWT issuer
    // for all employees regardless of company), so we cannot use it to select a single company.
    // The connection exists in exactly one company's 8200 agent — finding it there IS the proof
    // of which company to use.
    const emailUsername = session.email.split('@')[0];
    const fullNamePart = emailUsername.replace(/\./g, ' ').toLowerCase();
    const emailLC = session.email.toLowerCase();

    let foundCompany = null;
    let employeeConnection = null;

    for (const candidate of getAllCompanies()) {
      console.log(`[ClearanceVerification] Searching ${candidate.id} (${candidate.apiKey.slice(0, 8)}...) for personal wallet connection`);
      let connections = [];
      try {
        const resp = await fetch(`${MULTITENANCY_URL}/connections`, {
          headers: { 'apikey': candidate.apiKey }
        });
        if (!resp.ok) { console.warn(`  ${candidate.id}: HTTP ${resp.status}`); continue; }
        connections = (await resp.json()).contents || [];
      } catch (fetchErr) {
        console.warn(`  ${candidate.id}: fetch failed — ${fetchErr.message}`); continue;
      }

      // Keep only established personal-wallet connections
      const personalWalletConns = connections.filter(conn =>
        (conn.state === 'ConnectionResponseSent' || conn.state === 'ConnectionResponseReceived') &&
        !(enterpriseConnectionId && conn.connectionId === enterpriseConnectionId) &&
        !isEnterpriseAgentConnection(conn.theirDid)
      );
      console.log(`  ${candidate.id}: ${connections.length} total, ${personalWalletConns.length} personal-wallet`);

      // Try DB-stored ID first (most reliable)
      let conn = storedConnId
        ? (personalWalletConns.find(c => c.connectionId === storedConnId) ||
           connections.find(c => c.connectionId === storedConnId && !isEnterpriseAgentConnection(c.theirDid)))
        : null;
      if (conn) console.log(`  ${candidate.id}: ✅ Found via stored connection ID: ${storedConnId}`);

      // Fallback: label contains employee email or name
      if (!conn) {
        conn = personalWalletConns.find(c => c.label && c.label.toLowerCase().includes(emailLC))
            || personalWalletConns.find(c => c.label && c.label.toLowerCase().includes(fullNamePart));
        if (conn) console.log(`  ${candidate.id}: ✅ Found via label search: ${conn.connectionId} (${conn.label})`);
      }

      if (conn) { foundCompany = candidate; employeeConnection = conn; break; }
    }

    // No personal wallet connection found in any company tenant → generate OOB invitation
    if (!employeeConnection) {
      console.log('[ClearanceVerification] No personal wallet connection found in any agent');

      // Use email domain to select the right company for OOB — email is server-generated
      // (generateEmployeeEmail produces name@{companyId}.test) so domain is reliable here
      const emailDomain = (session.email || '').split('@')[1] || '';
      const companyIdFromDomain = emailDomain.split('.')[0].toLowerCase();
      const oobCompany = getAllCompanies().find(c => c.id === companyIdFromDomain) || getAllCompanies()[0];

      let oobUrl = null;
      try {
        const label = `${oobCompany.displayName} ↔ ${session.fullName || session.email} Personal (${session.email})`;
        const oobResult = await cloudAgentRequest(oobCompany.apiKey, '/connections', {
          method: 'POST',
          body: JSON.stringify({ label })
        });
        const rawUrl = oobResult.data?.invitation?.invitationUrl || null;
        if (rawUrl) {
          try {
            const oobParam = new URL(rawUrl).searchParams.get('_oob');
            oobUrl = oobParam
              ? `https://identuslabel.cz/wallet/oob?_oob=${encodeURIComponent(oobParam)}`
              : rawUrl;
          } catch (_) { oobUrl = rawUrl; }
        }
        console.log(`[ClearanceVerification] OOB invitation created for ${oobCompany.id}: ${oobUrl ? 'OK' : 'null'}`);
      } catch (oobErr) {
        console.warn('[ClearanceVerification] Could not generate OOB:', oobErr.message);
      }

      return res.status(400).json({
        success: false,
        error: 'NoPersonalWalletConnection',
        message: `Your personal wallet is not yet connected to ${oobCompany.displayName}. Please connect it first, then try again.`,
        oobUrl,
        instructions: [
          '1. Copy the invitation link below',
          '2. Open your IDL Wallet (personal mode)',
          '3. Go to Connections → paste the invitation',
          '4. Accept the connection request',
          '5. Return here and click "Verify Clearance" again'
        ]
      });
    }

    // Send proof request via the found personal wallet connection in foundCompany's 8200 tenant
    console.log(`[ClearanceVerification] Sending proof request via ${foundCompany.id} connection ${employeeConnection.connectionId}`);
    console.log(`   Label: ${employeeConnection.label}  apiKey: ${foundCompany.apiKey.slice(0, 8)}...`);

    const proofResponse = await fetch(`${MULTITENANCY_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': foundCompany.apiKey
      },
      body: JSON.stringify({
        connectionId: employeeConnection.connectionId,
        proofs: [],
        options: {
          challenge: require('crypto').randomBytes(16).toString('hex'),
          // Must contain the 'clearance' token — the wallet's DOMAIN_SCHEMA_HINTS matcher
          // (idl-wallet/src/actions/index.ts) uses this to filter credential selection down
          // to SecurityClearance; without it the wallet offers all shareable credential types
          // and may present the wrong one (e.g. RealPersonIdentity).
          domain: 'clearance.identuslabel.cz'
        }
      })
    });

    if (!proofResponse.ok) {
      const errorText = await proofResponse.text();
      console.error(`[ClearanceVerification] Proof request failed (${foundCompany.id}): ${proofResponse.status} - ${errorText}`);
      return res.status(500).json({
        success: false,
        error: 'ProofRequestFailed',
        message: `Failed to create proof request: ${proofResponse.status}`
      });
    }

    const proofResult = await proofResponse.json();
    const verificationId = proofResult.presentationId || proofResult.id;

    pendingClearanceVerifications.set(verificationId, {
      verificationId,
      presentationId: verificationId,
      connectionId: employeeConnection.connectionId,
      employeeId: session.employeeId,
      email: session.email,
      prismDid: session.prismDid,
      companyId: foundCompany.id,
      companyApiKey: foundCompany.apiKey,  // status polling reads enterpriseApiKey || companyApiKey
      sessionToken: token,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    console.log(`[ClearanceVerification] ✅ Proof request sent via ${foundCompany.id}. Presentation ID: ${verificationId}`);
    console.log('='.repeat(70));

    return res.json({
      success: true,
      verificationId,
      presentationId: verificationId,
      message: 'Security Clearance proof request sent to your personal IDL Wallet. Please open it and approve.',
      instructions: [
        '1. Open your IDL Wallet (personal mode)',
        '2. Go to the Messages or Credentials tab',
        '3. Approve the proof request — select your Security Clearance credential',
        '4. Your clearance will be verified automatically'
      ],
      walletUrl: 'https://identuslabel.cz/wallet',
      expiresIn: 300
    });

  } catch (error) {
    console.error('[ClearanceVerification] Initiate error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

/**
 * GET /api/employee-portal/clearance/status/:verificationId
 * Check status of a pending clearance verification by polling Cloud Agent 8200 directly
 *
 * ARCHITECTURE: Polls TechCorp's Cloud Agent directly for presentation status.
 * No CA intermediary needed.
 */
app.get('/api/employee-portal/clearance/status/:verificationId', requireEmployeeSession, async (req, res) => {
  const { verificationId } = req.params;
  const session = req.employeeSession;
  const token = req.headers['x-session-token'];

  const verification = pendingClearanceVerifications.get(verificationId);

  if (!verification) {
    return res.status(404).json({
      success: false,
      error: 'VerificationNotFound',
      message: 'Verification request not found or expired'
    });
  }

  // Verify this verification belongs to the current session
  if (verification.employeeId !== session.employeeId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'This verification request does not belong to you'
    });
  }

  // Check if expired
  if (verification.expiresAt < Date.now()) {
    pendingClearanceVerifications.delete(verificationId);
    return res.status(410).json({
      success: false,
      error: 'VerificationExpired',
      message: 'Verification request has expired. Please initiate a new one.'
    });
  }

  // If already verified, return cached result
  if (verification.status === 'verified') {
    return res.json({
      success: true,
      verificationId,
      status: 'verified',
      clearanceLevel: verification.clearanceLevel,
      verifiedAt: verification.verifiedAt
    });
  }

  // Poll multitenancy agent 8200 (same agent where the proof request was created)
  try {
    const MULTITENANCY_URL = process.env.MULTITENANCY_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
    const presentationResponse = await fetch(
      `${MULTITENANCY_URL}/present-proof/presentations/${verification.presentationId}`,
      {
        method: 'GET',
        headers: {
          'apikey': verification.enterpriseApiKey || verification.companyApiKey
        }
      }
    );

    if (!presentationResponse.ok) {
      console.error(`[ClearanceVerification] Presentation status check failed: ${presentationResponse.status}`);
      return res.json({
        success: true,
        verificationId,
        status: 'pending',
        clearanceLevel: null,
        verifiedAt: null,
        message: 'Waiting for wallet response...'
      });
    }

    const presentationData = await presentationResponse.json();
    console.log(`[ClearanceVerification] Presentation status:`, presentationData.status);

    // Check presentation status
    if (presentationData.status === 'PresentationVerified' || presentationData.status === 'PresentationReceived') {
      // Extract clearance level from the presentation
      let clearanceLevel = 'UNKNOWN';

      // Parse the credential data from the presentation
      // Cloud Agent returns data[] as array of VP JWT strings
      let caPersonalDID = null; // personal CA DID extracted from the presented SecurityClearance VC
      if (presentationData.data && presentationData.data.length > 0) {
        for (const vpJwtOrObject of presentationData.data) {
          try {
            // Check if it's a raw JWT string (the VP)
            if (typeof vpJwtOrObject === 'string' && vpJwtOrObject.split('.').length === 3) {
              console.log('[ClearanceVerification] Parsing VP JWT from data array');
              const vpParts = vpJwtOrObject.split('.');
              const vpPayload = JSON.parse(Buffer.from(vpParts[1], 'base64url').toString());

              // VP contains vp.verifiableCredential[] array of VC JWTs
              if (vpPayload.vp && vpPayload.vp.verifiableCredential) {
                for (const vcJwt of vpPayload.vp.verifiableCredential) {
                  try {
                    const vcParts = vcJwt.split('.');
                    if (vcParts.length === 3) {
                      const vcPayload = JSON.parse(Buffer.from(vcParts[1], 'base64url').toString());
                      console.log('[ClearanceVerification] Parsed VC credentialSubject:',
                        vcPayload.vc?.credentialSubject?.credentialType || 'unknown type');

                      // Check if this is a SecurityClearance VC. Issuer must be trusted — same
                      // ACCEPTED_ISSUER_DIDS check the login flow applies to this VC type
                      // (see isSecurityClearanceCred handling above) — otherwise any VC carrying
                      // a self-asserted clearanceLevel/securityLevel claim from an untrusted
                      // issuer would be accepted as a real clearance.
                      if (vcPayload.vc && vcPayload.vc.credentialSubject) {
                        const subject = vcPayload.vc.credentialSubject;
                        if (!ACCEPTED_ISSUER_DIDS.includes(vcPayload.iss)) {
                          if (subject.clearanceLevel || subject.securityLevel) {
                            console.warn(`[ClearanceVerification] Ignoring clearanceLevel/securityLevel claim from untrusted issuer: ${vcPayload.iss}`);
                          }
                        } else if (subject.clearanceLevel) {
                          // Capture the personal CA DID (sub of VC JWT) for sync linkage
                          if (vcPayload.sub && !caPersonalDID) {
                            caPersonalDID = vcPayload.sub;
                            console.log(`[ClearanceVerification] Captured caPersonalDID: ${caPersonalDID.substring(0, 40)}...`);
                          }
                          clearanceLevel = subject.clearanceLevel;
                          console.log('[ClearanceVerification] ✅ Found clearanceLevel:', clearanceLevel);
                        } else if (subject.securityLevel) {
                          clearanceLevel = subject.securityLevel;
                          console.log('[ClearanceVerification] ✅ Found securityLevel:', clearanceLevel);
                        }
                      }
                    }
                  } catch (vcErr) {
                    console.error('[ClearanceVerification] Error parsing nested VC JWT:', vcErr.message);
                  }
                }
              }
            } else if (typeof vpJwtOrObject === 'object') {
              // Legacy object format with claims or credential property
              if (vpJwtOrObject.claims) {
                clearanceLevel = vpJwtOrObject.claims.clearanceLevel || vpJwtOrObject.claims.securityLevel || clearanceLevel;
              }
              if (vpJwtOrObject.credential) {
                const parts = vpJwtOrObject.credential.split('.');
                if (parts.length === 3) {
                  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
                  if (payload.vc && payload.vc.credentialSubject) {
                    clearanceLevel = payload.vc.credentialSubject.clearanceLevel ||
                                     payload.vc.credentialSubject.securityLevel ||
                                     clearanceLevel;
                  }
                }
              }
            }
          } catch (e) {
            console.error('[ClearanceVerification] Error parsing presentation data:', e.message);
          }
        }
      }

      // The wallet may have presented a credential other than SecurityClearance (e.g. the
      // request wasn't scoped tightly enough, or the user picked the wrong VC) — 'UNKNOWN' is
      // a not-found sentinel, not a real clearance level. Treat it as a failed verification
      // rather than silently marking the session as cleared.
      if (clearanceLevel === 'UNKNOWN') {
        console.error('[ClearanceVerification] Presentation verified but no SecurityClearance credential (with clearanceLevel/securityLevel claim) was found among the presented credentials');
        verification.status = 'failed';
        return res.status(422).json({
          success: false,
          error: 'NoClearanceCredentialPresented',
          message: 'The presented credential was not a Security Clearance credential. Please select your Security Clearance VC when approving the request in your wallet.'
        });
      }

      // Update local verification record
      verification.status = 'verified';
      verification.clearanceLevel = clearanceLevel;
      verification.verifiedAt = new Date().toISOString();

      // Also update the session clearance
      const employeeSession = employeeSessions.get(token);
      if (employeeSession) {
        employeeSession.hasClearanceVC = true;
        employeeSession.clearanceLevel = clearanceLevel;
        console.log(`[ClearanceVerification] Session updated with clearance: ${clearanceLevel}`);
      }

      // Issue SecurityClearanceGrant VC to the employee's enterprise wallet (IDL Wallet)
      // This VC appears in the employee's credential list as company confirmation of their clearance
      //
      // Resolve the employee's actual employer from the session's issuerDID (falls back to
      // techcorp for legacy sessions predating issuerDID storage) — enterpriseConnectionId
      // below lives on the employer's own tenant wallet, so issuance must use that same
      // tenant's apiKey/did or it 404s (RecordIdNotFound).
      const employerCompany = resolveEmployerCompany(employeeSession?.issuerDID);
      const enterpriseConnectionId = employeeSession?.connectionId;
      if (employerCompany && enterpriseConnectionId && clearanceLevel !== 'UNKNOWN') {
        const SECURITY_CLEARANCE_GRANT_SCHEMA_GUID = 'f33eedc7-aa47-3e05-bc80-cf5388d00562';

        // Check if an active SecurityClearanceGrant already exists
        let alreadyHasGrant = false;
        try {
          const existing = await cloudAgentRequest(employerCompany.apiKey, '/issue-credentials/records?limit=200');
          const records = existing.data?.contents || [];
          alreadyHasGrant = records.some(r =>
            (r.claims?.credentialType === 'SecurityClearanceGrant' || r.claims?.clearanceLevel) &&
            r.claims?.holderDID === (verification.prismDid || '') &&
            r.claims?.clearanceLevel === clearanceLevel.toUpperCase() &&
            ['CredentialSent', 'OfferSent', 'OfferReceived', 'RequestReceived', 'CredentialReceived'].includes(r.protocolState)
          );
        } catch (e) {
          console.warn('[ClearanceVerification] Could not check existing grants (non-blocking):', e.message);
        }

        if (alreadyHasGrant) {
          console.log(`[ClearanceVerification] ℹ️ SecurityClearanceGrant already exists for ${clearanceLevel}, skipping issuance`);
        } else {
        const grantedAt = new Date().toISOString();
        const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

        const credentialOffer = {
          issuingDID: employerCompany.did,
          connectionId: enterpriseConnectionId,
          schemaId: `${MULTITENANCY_CLOUD_AGENT_URL}/schema-registry/schemas/${SECURITY_CLEARANCE_GRANT_SCHEMA_GUID}`,
          credentialFormat: 'JWT',
          claims: {
            credentialType: 'SecurityClearanceGrant',
            clearanceLevel: clearanceLevel.toUpperCase(),
            holderDID: verification.prismDid || '',
            issuerDID: employerCompany.did,
            grantedAt,
            validUntil,
          },
          automaticIssuance: true,
          awaitConfirmation: false
        };

        cloudAgentRequest(employerCompany.apiKey, '/issue-credentials/credential-offers', {
          method: 'POST',
          body: JSON.stringify(credentialOffer)
        }).then(async result => {
          const recordId = result.data?.recordId;
          console.log(`[ClearanceVerification] ✅ SecurityClearanceGrant VC offer created: ${recordId}`);
          // Persist recordId so the sync endpoint can revoke this grant if personal clearance is revoked
          if (recordId && process.env.ENTERPRISE_DB_PASSWORD) {
            try {
              const { Pool } = require('pg');
              const _pool = new Pool({
                host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
                port: process.env.ENTERPRISE_DB_PORT || 5434,
                database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
                user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
                password: process.env.ENTERPRISE_DB_PASSWORD,
              });
              await _pool.query(
                `INSERT INTO employee_credential_history
                   (employee_account_id, credential_type, credential_record_id, issued_at, issued_by, credential_claims, status)
                 SELECT ea.id, 'SecurityClearanceGrant', $1, CURRENT_TIMESTAMP, 'techcorp-enterprise', $2::jsonb, 'active'
                 FROM employee_accounts ea
                 WHERE ea.email = $3 OR ea.prism_did = $4
                 LIMIT 1`,
                [recordId, JSON.stringify(credentialOffer.claims), verification.email || '', verification.prismDid || '']
              );
              await _pool.end();
              console.log(`[ClearanceVerification] ✅ Saved SecurityClearanceGrant recordId to DB: ${recordId}`);
            } catch (dbErr) {
              console.warn(`[ClearanceVerification] ⚠️ Could not save recordId to DB: ${dbErr.message}`);
            }
          }
        }).catch(err => {
          console.error(`[ClearanceVerification] ❌ Failed to issue SecurityClearanceGrant VC:`, err.message);
        });
        } // end else (!alreadyHasGrant)
      } else {
        console.warn(`[ClearanceVerification] Skipping SecurityClearanceGrant VC issuance: employerCompany=${!!employerCompany}, connectionId=${enterpriseConnectionId}, clearanceLevel=${clearanceLevel}`);
      }

      return res.json({
        success: true,
        verificationId,
        status: 'verified',
        clearanceLevel: clearanceLevel,
        verifiedAt: verification.verifiedAt
      });
    } else if (presentationData.status === 'PresentationRejected' || presentationData.status === 'RequestRejected') {
      verification.status = 'declined';
      return res.json({
        success: true,
        verificationId,
        status: 'declined',
        clearanceLevel: null,
        verifiedAt: null,
        message: 'User declined the proof request'
      });
    } else {
      // Still pending (RequestSent, etc.)
      return res.json({
        success: true,
        verificationId,
        status: 'pending',
        clearanceLevel: null,
        verifiedAt: null,
        message: `Waiting for wallet response... (${presentationData.status})`
      });
    }

  } catch (error) {
    console.error('[ClearanceVerification] Error polling presentation status:', error);
    return res.json({
      success: true,
      verificationId,
      status: 'pending',
      clearanceLevel: null,
      verifiedAt: null,
      message: 'Waiting for wallet response...'
    });
  }
});

/**
 * POST /api/employee-portal/clearance/submit
 * Submit Security Clearance VP (called from Alice wallet or via manual entry)
 *
 * For simplicity, this endpoint accepts the clearance level directly
 * In a full implementation, it would verify a VP JWT
 */
app.post('/api/employee-portal/clearance/submit', requireEmployeeSession, async (req, res) => {
  try {
    const session = req.employeeSession;
    const token = req.headers['x-session-token'];
    const { verificationId, clearanceLevel, vpJwt } = req.body;

    console.log('\n' + '='.repeat(70));
    console.log('[ClearanceVerification] Receiving Security Clearance submission');
    console.log(`   Employee: ${session.email}`);
    console.log(`   Verification ID: ${verificationId}`);
    console.log(`   Clearance Level: ${clearanceLevel}`);
    console.log('='.repeat(70));

    // If verificationId provided, validate against pending verification
    if (verificationId) {
      const verification = pendingClearanceVerifications.get(verificationId);

      if (!verification) {
        return res.status(404).json({
          success: false,
          error: 'VerificationNotFound',
          message: 'Verification request not found or expired'
        });
      }

      if (verification.employeeId !== session.employeeId) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'This verification request does not belong to you'
        });
      }

      if (verification.expiresAt < Date.now()) {
        pendingClearanceVerifications.delete(verificationId);
        return res.status(410).json({
          success: false,
          error: 'VerificationExpired',
          message: 'Verification request has expired'
        });
      }

      // Update verification status
      verification.status = 'verified';
      verification.clearanceLevel = clearanceLevel;
      verification.verifiedAt = new Date().toISOString();
    }

    // Validate clearance level
    const validLevels = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET', 'TOP-SECRET'];
    if (!validLevels.includes(clearanceLevel)) {
      return res.status(400).json({
        success: false,
        error: 'InvalidClearanceLevel',
        message: `Invalid clearance level. Must be one of: ${validLevels.join(', ')}`
      });
    }

    // Update the employee session with clearance information
    session.hasClearanceVC = true;
    session.clearanceLevel = clearanceLevel;
    session.clearanceVerifiedAt = new Date().toISOString();

    console.log(`[ClearanceVerification] ✅ Clearance verified: ${clearanceLevel}`);
    console.log(`[ClearanceVerification] Session updated for ${session.email}`);

    // Clean up the verification request
    if (verificationId) {
      pendingClearanceVerifications.delete(verificationId);
    }

    res.json({
      success: true,
      message: 'Security Clearance verified successfully',
      clearanceLevel,
      verifiedAt: session.clearanceVerifiedAt
    });

  } catch (error) {
    console.error('[ClearanceVerification] Submit error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

// Periodic cleanup of expired clearance verifications
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [verificationId, verification] of pendingClearanceVerifications) {
    if (verification.expiresAt < now) {
      pendingClearanceVerifications.delete(verificationId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[ClearanceVerification] Cleaned up ${cleaned} expired verification requests`);
  }
}, 60 * 1000); // Run every minute

// ============================================================================
// Resource Authorization - Dual-VP Flow
// ============================================================================

// Pending resource authorizations (sessionId -> authorization data)
const pendingResourceAuthorizations = new Map();

// Mock resources with clearance requirements
const PROTECTED_RESOURCES = {
  'project-alpha': {
    id: 'project-alpha',
    name: 'Project Alpha Documents',
    description: 'Classified project documentation',
    requiredClearance: 'CONFIDENTIAL',
    requiredRole: 'Engineer'
  },
  'financial-reports': {
    id: 'financial-reports',
    name: 'Financial Reports Q4',
    description: 'Quarterly financial analysis',
    requiredClearance: 'RESTRICTED',
    requiredRole: null // Any role allowed
  },
  'employee-records': {
    id: 'employee-records',
    name: 'Employee Records Database',
    description: 'HR employee records access',
    requiredClearance: 'CONFIDENTIAL',
    requiredRole: 'HR'
  },
  'infrastructure-plans': {
    id: 'infrastructure-plans',
    name: 'Infrastructure Architecture',
    description: 'IT infrastructure documentation',
    requiredClearance: 'TOP-SECRET',
    requiredRole: 'IT'
  }
};

// Clearance level hierarchy for comparison
const CLEARANCE_HIERARCHY = {
  'UNCLASSIFIED': 0,
  'INTERNAL': 1,
  'CONFIDENTIAL': 2,
  'RESTRICTED': 3,
  'SECRET': 4,
  'TOP-SECRET': 4  // legacy alias
};

/**
 * GET /api/resources - List available protected resources
 */
app.get('/api/resources', (req, res) => {
  res.json({
    success: true,
    resources: Object.values(PROTECTED_RESOURCES)
  });
});

/**
 * POST /api/resource/authorize/initiate
 * Step 1: Initiate dual-VP authorization flow
 *
 * Request: { resourceId, employeeId (email or PRISM DID) }
 *
 * Flow:
 * 1. Verify employee exists and has enterprise connection
 * 2. Send enterprise proof request for EmployeeRole VC via Cloud Agent
 * 3. Return sessionId for correlation
 */
app.post('/api/resource/authorize/initiate', async (req, res) => {
  try {
    const { resourceId, employeeId } = req.body;

    console.log('\n' + '='.repeat(80));
    console.log('🔐 [ResourceAuth] Initiating dual-VP authorization');
    console.log(`   Resource: ${resourceId}`);
    console.log(`   Employee: ${employeeId}`);
    console.log('='.repeat(80));

    // Validate resource exists
    const resource = PROTECTED_RESOURCES[resourceId];
    if (!resource) {
      return res.status(404).json({
        success: false,
        error: 'ResourceNotFound',
        message: `Resource ${resourceId} not found`
      });
    }

    // Look up employee connection
    let employeeConnection = null;

    // Check stored employee-connection mappings
    if (global.employeeConnectionMappings && global.employeeConnectionMappings.has(employeeId)) {
      const mapping = global.employeeConnectionMappings.get(employeeId);
      console.log(`[ResourceAuth] Found employee mapping: ${employeeId} → ${mapping.connectionId}`);
      employeeConnection = {
        connectionId: mapping.connectionId,
        email: mapping.email || employeeId,
        name: mapping.name || 'Employee',
        department: mapping.department || 'Unknown',
        personalWalletConnectionId: mapping.personalWalletConnectionId || null // May be stored if known
      };
    }

    // Fallback: Try database lookup
    if (!employeeConnection && process.env.ENTERPRISE_DB_PASSWORD) {
      const { Pool } = require('pg');
      const enterprisePool = new Pool({
        host: process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
        port: process.env.ENTERPRISE_DB_PORT || 5434,
        database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
        user: process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
        password: process.env.ENTERPRISE_DB_PASSWORD,
      });
      const employeeDb = new EmployeePortalDatabase(enterprisePool);

      let employee = null;
      if (employeeId.includes('@')) {
        employee = await employeeDb.getEmployeeByEmail(employeeId);
      } else if (employeeId.startsWith('did:prism:')) {
        employee = await employeeDb.getEmployeeByDid(employeeId);
      }

      if (employee && employee.techcorp_connection_id) {
        employeeConnection = {
          connectionId: employee.techcorp_connection_id,
          email: employee.email,
          name: employee.full_name,
          department: employee.department,
          personalWalletConnectionId: employee.personal_wallet_connection_id || null
        };
      }
    }

    if (!employeeConnection) {
      return res.status(404).json({
        success: false,
        error: 'EmployeeNotFound',
        message: 'Employee not found or missing enterprise connection'
      });
    }

    // Generate session and challenge
    const sessionId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('hex');
    const domain = 'resource-authorization.techcorp.com';

    console.log(`[ResourceAuth] Session created: ${sessionId.substring(0, 12)}...`);
    console.log(`[ResourceAuth] Challenge: ${challenge.substring(0, 20)}...`);

    // Step 1: Send enterprise proof request for EmployeeRole VC
    console.log('[ResourceAuth] Step 1: Sending enterprise proof request via DIDComm...');

    const enterpriseProofPayload = {
      connectionId: employeeConnection.connectionId,
      options: {
        challenge: challenge,
        domain: domain
      },
      proofs: [], // Schema-less: accept any credential
      goalCode: 'resource-authorization',
      goal: `Authorization for ${resource.name} - Please provide EmployeeRole credential`,
      credentialFormat: 'JWT'
    };

    const proofResponse = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'apikey': TECHCORP_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(enterpriseProofPayload)
    });

    if (!proofResponse.ok) {
      const error = await proofResponse.text();
      throw new Error(`Enterprise proof request failed: ${proofResponse.status} ${error}`);
    }

    const proofData = await proofResponse.json();
    const enterprisePresentationId = proofData.presentationId || proofData.id;

    console.log(`[ResourceAuth] Enterprise proof request created: ${enterprisePresentationId}`);

    // Store pending authorization
    pendingResourceAuthorizations.set(sessionId, {
      sessionId,
      resourceId,
      resource,
      challenge,
      domain,
      employeeConnection,
      enterprisePresentationId,
      enterpriseVPVerified: false,
      enterpriseVPClaims: null,
      personalVPPresentationId: null,
      personalVPReceived: false,
      personalVPClaims: null,
      status: 'awaiting_enterprise_vp',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minute timeout
    });

    // Cleanup expired authorizations
    const now = Date.now();
    for (const [id, auth] of pendingResourceAuthorizations) {
      if (auth.expiresAt < now) {
        pendingResourceAuthorizations.delete(id);
        console.log(`[ResourceAuth] Cleaned up expired session: ${id}`);
      }
    }

    console.log('[ResourceAuth] Authorization initiated, waiting for enterprise VP...');

    res.json({
      success: true,
      sessionId,
      enterprisePresentationId,
      status: 'awaiting_enterprise_vp',
      message: 'Enterprise proof request sent. Please approve EmployeeRole credential in your wallet.',
      resource: {
        id: resource.id,
        name: resource.name,
        requiredClearance: resource.requiredClearance
      }
    });

  } catch (error) {
    console.error('[ResourceAuth] Initiate error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to initiate authorization'
    });
  }
});

/**
 * GET /api/resource/authorize/status/:sessionId
 * Check authorization status and handle state transitions
 */
app.get('/api/resource/authorize/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const pending = pendingResourceAuthorizations.get(sessionId);
    if (!pending) {
      return res.status(404).json({
        success: false,
        error: 'SessionNotFound',
        message: 'Authorization session not found or expired'
      });
    }

    // Check expiration
    if (pending.expiresAt < Date.now()) {
      pendingResourceAuthorizations.delete(sessionId);
      return res.status(408).json({
        success: false,
        error: 'SessionExpired',
        message: 'Authorization session expired'
      });
    }

    // Check enterprise VP status if still awaiting
    if (pending.status === 'awaiting_enterprise_vp') {
      const presentationResponse = await fetch(
        `${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations/${pending.enterprisePresentationId}`,
        {
          method: 'GET',
          headers: {
            'apikey': TECHCORP_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );

      if (presentationResponse.ok) {
        const presentation = await presentationResponse.json();
        const state = presentation.status || presentation.state;

        console.log(`[ResourceAuth] Enterprise VP state: ${state}`);

        if (state === 'PresentationVerified') {
          // Enterprise VP verified! Extract claims
          pending.enterpriseVPVerified = true;
          pending.status = 'enterprise_vp_verified';

          // Extract claims from presentation
          if (presentation.data && presentation.data.length > 0) {
            const claims = extractClaimsFromPresentation(presentation.data[0]);
            if (claims) {
              pending.enterpriseVPClaims = claims;
              console.log('[ResourceAuth] Enterprise VP claims extracted:', {
                role: claims.role,
                department: claims.department,
                employeeId: claims.employeeId
              });
            }
          }
        } else if (state === 'RequestRejected' || state === 'PresentationFailed') {
          pending.status = 'enterprise_vp_failed';
        }
      }
    }

    // Check personal VP status if awaiting
    if (pending.status === 'awaiting_personal_vp' && pending.personalVPPresentationId) {
      // TODO: Check personal VP status via CA's DIDComm or mediator
      // For now, this would be handled by a webhook or polling from CA side
    }

    res.json({
      success: true,
      sessionId,
      status: pending.status,
      enterpriseVPVerified: pending.enterpriseVPVerified,
      personalVPReceived: pending.personalVPReceived,
      resource: {
        id: pending.resource.id,
        name: pending.resource.name
      },
      authorizationResult: pending.authorizationResult || null
    });

  } catch (error) {
    console.error('[ResourceAuth] Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

/**
 * POST /api/resource/authorize/request-clearance/:sessionId
 * Step 2: After enterprise VP verified, request Security Clearance from personal wallet
 *
 * This endpoint sends a DIDComm proof request to the employee's personal wallet
 * asking for their Security Clearance VC (issued by CA).
 *
 * Note: This requires:
 * 1. Enterprise server has DIDComm connection to personal wallet (via CA connection)
 * 2. Personal wallet peer DID is known
 */
app.post('/api/resource/authorize/request-clearance/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { personalWalletConnectionId } = req.body; // Optional: pass if known

    const pending = pendingResourceAuthorizations.get(sessionId);
    if (!pending) {
      return res.status(404).json({
        success: false,
        error: 'SessionNotFound',
        message: 'Authorization session not found or expired'
      });
    }

    // Verify enterprise VP was already received
    if (!pending.enterpriseVPVerified) {
      return res.status(400).json({
        success: false,
        error: 'EnterpriseVPRequired',
        message: 'Enterprise VP must be verified before requesting clearance'
      });
    }

    // Get personal wallet connection ID
    let connectionId = personalWalletConnectionId ||
                       pending.employeeConnection.personalWalletConnectionId;

    if (!connectionId) {
      // Try to look up from database or mapping
      // In a real system, this would be stored during employee onboarding
      console.log('[ResourceAuth] Personal wallet connection ID not found');

      // For demo purposes, return error asking for connection
      return res.status(400).json({
        success: false,
        error: 'PersonalConnectionRequired',
        message: 'Personal wallet connection ID required. Please establish connection first.',
        hint: 'The employee must have a DIDComm connection from their personal wallet to the enterprise.'
      });
    }

    console.log(`[ResourceAuth] Step 2: Requesting Security Clearance from personal wallet...`);
    console.log(`   Personal wallet connection: ${connectionId}`);

    // Send proof request to personal wallet via TechCorp Cloud Agent
    // (assuming TechCorp also has DIDComm connections to personal wallets)
    const personalProofPayload = {
      connectionId: connectionId,
      options: {
        challenge: pending.challenge, // Same challenge for correlation
        domain: pending.domain
      },
      proofs: [], // Schema-less: accept Security Clearance
      goalCode: 'clearance-verification',
      goal: `Security Clearance verification for ${pending.resource.name}`,
      credentialFormat: 'JWT'
    };

    const proofResponse = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'apikey': TECHCORP_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(personalProofPayload)
    });

    if (!proofResponse.ok) {
      const error = await proofResponse.text();
      throw new Error(`Personal proof request failed: ${proofResponse.status} ${error}`);
    }

    const proofData = await proofResponse.json();
    const personalPresentationId = proofData.presentationId || proofData.id;

    // Update pending authorization
    pending.personalVPPresentationId = personalPresentationId;
    pending.status = 'awaiting_personal_vp';

    console.log(`[ResourceAuth] Personal VP request sent: ${personalPresentationId}`);

    res.json({
      success: true,
      sessionId,
      personalPresentationId,
      status: 'awaiting_personal_vp',
      message: 'Security Clearance proof request sent to personal wallet. Please approve.'
    });

  } catch (error) {
    console.error('[ResourceAuth] Request clearance error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

/**
 * POST /api/resource/authorize/verify/:sessionId
 * Final step: Verify both VPs and make authorization decision
 */
app.post('/api/resource/authorize/verify/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    console.log('\n' + '='.repeat(80));
    console.log('🔐 [ResourceAuth] Verifying authorization');
    console.log(`   Session: ${sessionId}`);
    console.log('='.repeat(80));

    const pending = pendingResourceAuthorizations.get(sessionId);
    if (!pending) {
      return res.status(404).json({
        success: false,
        error: 'SessionNotFound',
        message: 'Authorization session not found or expired'
      });
    }

    // Check both VPs
    // First, verify/refresh enterprise VP status
    if (pending.enterprisePresentationId && !pending.enterpriseVPVerified) {
      const presentationResponse = await fetch(
        `${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations/${pending.enterprisePresentationId}`,
        {
          method: 'GET',
          headers: {
            'apikey': TECHCORP_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );

      if (presentationResponse.ok) {
        const presentation = await presentationResponse.json();
        const state = presentation.status || presentation.state;

        if (state === 'PresentationVerified') {
          pending.enterpriseVPVerified = true;
          if (presentation.data && presentation.data.length > 0) {
            pending.enterpriseVPClaims = extractClaimsFromPresentation(presentation.data[0]);
          }
        }
      }
    }

    // Verify/refresh personal VP status
    if (pending.personalVPPresentationId && !pending.personalVPReceived) {
      const presentationResponse = await fetch(
        `${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations/${pending.personalVPPresentationId}`,
        {
          method: 'GET',
          headers: {
            'apikey': TECHCORP_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );

      if (presentationResponse.ok) {
        const presentation = await presentationResponse.json();
        const state = presentation.status || presentation.state;

        if (state === 'PresentationVerified') {
          pending.personalVPReceived = true;
          if (presentation.data && presentation.data.length > 0) {
            pending.personalVPClaims = extractClaimsFromPresentation(presentation.data[0]);
          }
        }
      }
    }

    // Verify enterprise VP is present
    if (!pending.enterpriseVPVerified) {
      return res.status(400).json({
        success: false,
        error: 'EnterpriseVPMissing',
        message: 'Enterprise EmployeeRole VP not yet verified',
        status: pending.status
      });
    }

    // Verify personal VP is present
    if (!pending.personalVPReceived) {
      return res.status(400).json({
        success: false,
        error: 'PersonalVPMissing',
        message: 'Personal Security Clearance VP not yet received',
        status: pending.status
      });
    }

    console.log('[ResourceAuth] Both VPs verified, making authorization decision...');

    // Extract claims
    const enterpriseClaims = pending.enterpriseVPClaims || {};
    const personalClaims = pending.personalVPClaims || {};

    const employeeRole = enterpriseClaims.role;
    const employeeDepartment = enterpriseClaims.department;
    const clearanceLevel = personalClaims.clearanceLevel;

    console.log(`[ResourceAuth] Employee Role: ${employeeRole}`);
    console.log(`[ResourceAuth] Department: ${employeeDepartment}`);
    console.log(`[ResourceAuth] Clearance Level: ${clearanceLevel}`);
    console.log(`[ResourceAuth] Required Clearance: ${pending.resource.requiredClearance}`);
    console.log(`[ResourceAuth] Required Role: ${pending.resource.requiredRole || 'Any'}`);

    // Authorization logic
    let authorized = false;
    let reason = '';

    // Check clearance level
    const employeeClearanceLevel = CLEARANCE_HIERARCHY[clearanceLevel] || 0;
    const requiredClearanceLevel = CLEARANCE_HIERARCHY[pending.resource.requiredClearance] || 0;

    if (employeeClearanceLevel < requiredClearanceLevel) {
      reason = `Insufficient clearance: ${clearanceLevel || 'NONE'} < ${pending.resource.requiredClearance}`;
    } else if (pending.resource.requiredRole && employeeRole !== pending.resource.requiredRole) {
      // Check role requirement if specified
      reason = `Role mismatch: ${employeeRole} ≠ ${pending.resource.requiredRole}`;
    } else {
      authorized = true;
      reason = 'All requirements satisfied';
    }

    // Update authorization result
    pending.status = authorized ? 'authorized' : 'denied';
    pending.authorizationResult = {
      authorized,
      reason,
      employeeRole,
      employeeDepartment,
      clearanceLevel,
      resourceId: pending.resource.id,
      resourceName: pending.resource.name,
      requiredClearance: pending.resource.requiredClearance,
      requiredRole: pending.resource.requiredRole,
      verifiedAt: new Date().toISOString()
    };

    console.log(`[ResourceAuth] Authorization result: ${authorized ? '✅ GRANTED' : '❌ DENIED'}`);
    console.log(`[ResourceAuth] Reason: ${reason}`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      sessionId,
      authorized,
      reason,
      result: pending.authorizationResult
    });

  } catch (error) {
    console.error('[ResourceAuth] Verify error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message
    });
  }
});

/**
 * Helper function to extract claims from a VP JWT
 */
function extractClaimsFromPresentation(presentationJWT) {
  try {
    const parts = presentationJWT.split('.');
    if (parts.length !== 3) return null;

    const payloadBase64 = parts[1];
    const payloadBase64Standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (payloadBase64Standard.length % 4)) % 4);
    const payloadJson = Buffer.from(payloadBase64Standard + padding, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    const vp = payload.vp;
    if (!vp || !vp.verifiableCredential || vp.verifiableCredential.length === 0) {
      return null;
    }

    // Extract claims from first credential (or merge all)
    const allClaims = {};

    for (const credentialJWT of vp.verifiableCredential) {
      const credParts = credentialJWT.split('.');
      if (credParts.length !== 3) continue;

      const credPayloadBase64 = credParts[1];
      const credPayloadBase64Standard = credPayloadBase64.replace(/-/g, '+').replace(/_/g, '/');
      const credPadding = '='.repeat((4 - (credPayloadBase64Standard.length % 4)) % 4);
      const credPayloadJson = Buffer.from(credPayloadBase64Standard + credPadding, 'base64').toString('utf-8');
      const credPayload = JSON.parse(credPayloadJson);

      if (credPayload.vc && credPayload.vc.credentialSubject) {
        Object.assign(allClaims, credPayload.vc.credentialSubject);
      }
    }

    return allClaims;
  } catch (error) {
    console.error('[ResourceAuth] Error extracting claims:', error);
    return null;
  }
}

// Periodic cleanup of expired authorization sessions
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, auth] of pendingResourceAuthorizations) {
    if (auth.expiresAt < now) {
      pendingResourceAuthorizations.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[ResourceAuth] Cleaned up ${cleaned} expired authorization sessions`);
  }
}, 60 * 1000); // Run every minute

// ============================================================================
// Classified Document with Section-Level Clearance
// ============================================================================

// Import new services (add to top of file requires section in production)
const ClearanceDocumentParser = require('./lib/ClearanceDocumentParser');
const DocxClearanceParser = require('./lib/DocxClearanceParser');
const DocxRedactionService = require('./lib/DocxRedactionService');
const SectionEncryptionService = require('./lib/SectionEncryptionService');
const RedactionEngine = require('./lib/RedactionEngine');
const EphemeralDIDService = require('./lib/EphemeralDIDService');
const DocumentCopyVCIssuer = require('./lib/DocumentCopyVCIssuer');
const { getIagonClient } = require('./lib/IagonStorageClient');
const nacl = require('tweetnacl');
const VPVerificationService = require('./lib/VPVerificationService');
const DocxMergeService = require('./lib/DocxMergeService');

// Company secret for key derivation (in production, use secure key management)
const COMPANY_SECRET = process.env.COMPANY_SECRET || 'default-company-secret-change-in-production';

// In-memory storage for ephemeral DIDs (in production, use persistent storage)
const ephemeralDIDStore = new Map();

// Pending document access gate challenges: presentationId → { documentDID, ephemeralPublicKey, challenge, timestamp }
// TTL: 5 minutes (matching the challenge lifetime)
const pendingDocumentAccessChallenges = new Map();

/**
 * POST /api/classified-documents/upload
 * Upload a classified document with section-level clearance markers
 *
 * Supports:
 * - HTML files with data-clearance attributes
 * - DOCX files with Content Controls tagged clearance:LEVEL
 *
 * Request: multipart/form-data
 * - file: HTML or DOCX file with clearance markers
 * - title: Document title (optional, extracted from file if not provided)
 * - releasableTo: JSON array of company names or issuer DIDs
 * - department: Originating department
 */
app.post('/api/classified-documents/upload', requireEmployeeSession, upload.single('file'), async (req, res) => {
  const session = req.employeeSession;

  console.log('\n' + '='.repeat(80));
  console.log('[ClassifiedUpload] New classified document upload');
  console.log('   Employee:', session.email);
  console.log('   Department:', session.department);
  console.log('='.repeat(80));

  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'File is required'
      });
    }

    const { releasableTo, department, classificationLevel: userClassificationLevel } = req.body;

    // ─────────────────────────────────────────────────────────────────────────
    // PRE-ENCRYPTED PATH (SSI-aligned)
    // Browser already encrypted the file with WebCrypto AES-256-GCM.
    // Server never sees plaintext — just stores the encrypted bytes on Iagon,
    // creates the document DID, and pushes the KeyManifest VC.
    // ─────────────────────────────────────────────────────────────────────────
    if (req.body.preEncrypted === 'true') {
      console.log(`   [ClassifiedUpload/preEncrypted] file size=${file.buffer?.length || 0} bytes, name=${file.originalname}`);
      const {
        wrappedKey, wrapIv, wrapAuthTag, wrappingAlgorithm,
        fileIv, fileAuthTag, fileAlgorithm, contentHash
      } = req.body;

      if (!wrappedKey || !wrapIv || !wrapAuthTag || !fileIv || !fileAuthTag) {
        return res.status(400).json({ success: false, error: 'MISSING_ENCRYPTION_FIELDS',
          message: 'Pre-encrypted upload requires wrappedKey, wrapIv, wrapAuthTag, fileIv, fileAuthTag' });
      }

      const classLevel = userClassificationLevel || 'INTERNAL';

      // Parse releasableTo
      let releasableArray = [];
      try {
        releasableArray = releasableTo ? (typeof releasableTo === 'string' ? JSON.parse(releasableTo) : releasableTo) : [];
      } catch (_) { releasableArray = releasableTo ? [releasableTo] : []; }
      const releasableDIDs = releasableArray.map(item => {
        if (item.startsWith('did:')) return item;
        return COMPANY_ISSUER_DIDS[item] || item;
      }).filter(Boolean);

      // Upload pre-encrypted bytes to Iagon without re-encryption (classificationLevel: 'UNCLASSIFIED' skips Iagon DEK)
      const iagonClient = getIagonClient();
      // Prefix with timestamp to guarantee uniqueness — Iagon rejects duplicate paths
      const iagonFilename = `${Date.now()}_${file.originalname}`;
      const iagonResult = await iagonClient.uploadFile(
        file.buffer,
        iagonFilename,
        { preEncrypted: true } // browser-encrypted — server must not add another DEK layer
      );
      console.log(`   [ClassifiedUpload/preEncrypted] Uploaded to Iagon: ${iagonResult.fileId}`);

      // Create PRISM DID
      const PUBLIC_URL = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
      const deptKey = DEPARTMENT_API_KEYS[department || session.department] || DEPARTMENT_API_KEYS['Security'];
      const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, deptKey);
      const didResult = await documentManager.createDocumentDIDWithServiceEndpoint(
        department || session.department || 'Security',
        { title: req.body.title || file.originalname, classificationLevel: classLevel, releasableTo: releasableDIDs },
        { fileId: iagonResult.fileId, downloadUrl: iagonResult.iagonUrl || '', contentHash: contentHash || iagonResult.contentHash, encryptionInfo: null },
        [{ id: 'document-access-gate', type: 'DocumentAccessGate', serviceEndpoint: `${PUBLIC_URL}/api/access-gate/challenge` }],
        { documentServiceUrl: req.company?.documentServiceUrl || null }
      );
      const documentDID = didResult.documentDID;

      // Register in DocumentRegistry
      await DocumentRegistry.registerDocument({
        documentDID,
        title: req.body.title || file.originalname,
        classificationLevel: classLevel,
        releasableTo: releasableDIDs,
        ownerCompanyDID: session.issuerDID || null,
        metadata: { originalFilename: file.originalname, fileSize: file.size, mimeType: file.mimetype, createdBy: session.email, department: session.department, createdAt: new Date().toISOString() },
        iagonStorage: { fileId: iagonResult.fileId, nodeId: iagonResult.nodeId, filename: file.originalname, encryptionInfo: { algorithm: fileAlgorithm || 'AES-256-GCM', iv: fileIv, authTag: fileAuthTag } }
      });

      fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify(buildLogEntry({
        eventType: 'CREATED',
        viewerName: session.email,
        documentDID,
        documentTitle: req.body.title || file.originalname,
        clearanceLevel: classLevel,
        companyDID: session.issuerDID || null,
        accessGranted: true,
        clientIp: req.ip || req.connection?.remoteAddress || null
      })) + '\n', () => {});

      // Push KeyManifest VC to document service (versioned)
      let preEncVCId = null;
      try {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || null;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcIssuer = new KeyManifestVCIssuer(docServiceUrl, adminKey);
        const prevVC = await fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey);
        const versionNumber = (prevVC?.claims?.versionNumber ?? 0) + 1;
        const predecessorHash = prevVC ? KeyManifestVCIssuer.computePredecessorHash(prevVC.vcJwt) : null;

        const vcResult = await vcIssuer.issue({
          documentDID,
          issuerDID:          session.issuerDID || process.env.SERVICE_DID,
          iagonFileId:        iagonResult.fileId,
          classificationLevel: classLevel,
          releasableTo:       releasableDIDs,
          wrappedKey,
          iv:                 wrapIv,
          authTag:            wrapAuthTag,
          wrappingAlgorithm:  wrappingAlgorithm || 'AES-256-GCM',
          fileAlgorithm:      fileAlgorithm     || 'AES-256-GCM',
          fileIv,
          fileAuthTag,
          contentHash:        contentHash || iagonResult.contentHash || null,
          versionNumber,
          updatedBy:          session.prismDid || session.issuerDID || null,
          predecessorHash
        });
        preEncVCId = vcResult.vcId;
        console.log(`   [ClassifiedUpload/preEncrypted] ✅ KeyManifest VC v${versionNumber} pushed: ${preEncVCId}`);
      } catch (vcErr) {
        console.error('   [ClassifiedUpload/preEncrypted] ⚠️ KeyManifest VC push failed:', vcErr.message);
      }

      return res.json({
        success: true,
        documentDID,
        title:              req.body.title || file.originalname,
        overallClassification: classLevel,
        sectionCount:       1,
        iagonFileId:        iagonResult.fileId,
        keyManifestVCId:    preEncVCId,
        message: 'Document uploaded (browser-encrypted, SSI-aligned)'
      });
    }
    // ─────────────────────────────────────────────────────────────────────────
    // END PRE-ENCRYPTED PATH — legacy section-based path continues below
    // ─────────────────────────────────────────────────────────────────────────

    // Determine file type
    const filename = file.originalname.toLowerCase();
    const isHtml = filename.endsWith('.html') || filename.endsWith('.htm');
    const isDocx = filename.endsWith('.docx');

    console.log(`   [ClassifiedUpload] ===== FILE TYPE DETECTION =====`);
    console.log(`   [ClassifiedUpload] Original filename: ${file.originalname}`);
    console.log(`   [ClassifiedUpload] Lowercase filename: ${filename}`);
    console.log(`   [ClassifiedUpload] isHtml: ${isHtml}`);
    console.log(`   [ClassifiedUpload] isDocx: ${isDocx}`);
    console.log(`   [ClassifiedUpload] File buffer size: ${file.buffer?.length || 0} bytes`);

    if (!isHtml && !isDocx) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'File must be HTML (.html) or Word (.docx)'
      });
    }

    // Parse the document based on type
    let parsedDocument;

    if (isHtml) {
      const htmlContent = file.buffer.toString('utf8');
      const validation = ClearanceDocumentParser.validateDocument(htmlContent);

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Invalid HTML document',
          errors: validation.errors,
          warnings: validation.warnings
        });
      }

      parsedDocument = ClearanceDocumentParser.parseClearanceSections(htmlContent);
      console.log(`   [ClassifiedUpload] Parsed HTML: ${parsedDocument.sections.length} sections`);

    } else {
      // DOCX file
      const isValid = await DocxClearanceParser.isValidDocx(file.buffer);
      if (!isValid) {
        return res.status(400).json({
          success: false,
          error: 'ValidationError',
          message: 'Invalid DOCX file'
        });
      }

      parsedDocument = await DocxClearanceParser.parseDocxClearanceSections(file.buffer);
      console.log(`   [ClassifiedUpload] Parsed DOCX: ${parsedDocument.sections.length} sections`);
    }

    // Use provided title, or fall back to title extracted from document, then filename
    const filenameWithoutExt = file.originalname.replace(/\.(docx|html?)$/i, '');
    const providedTitle = req.body.title?.trim();
    parsedDocument.metadata.title = providedTitle || parsedDocument.metadata.title || filenameWithoutExt;
    parsedDocument.metadata.originalFilename = file.originalname;

    // Log section statistics
    const stats = parsedDocument.metadata.clearanceLevelStats;
    console.log('   Section breakdown:');
    console.log(`     INTERNAL: ${stats['INTERNAL'] || 0}`);
    console.log(`     CONFIDENTIAL: ${stats['CONFIDENTIAL'] || 0}`);
    console.log(`     RESTRICTED: ${stats['RESTRICTED'] || 0}`);
    console.log(`     SECRET: ${stats['SECRET'] || 0}`);
    console.log(`     TOP-SECRET: ${stats['TOP-SECRET'] || 0}`);
    console.log(`   Overall classification: ${parsedDocument.metadata.overallClassification}`);

    // Use user-selected classification level for document discovery (who can see it in their list)
    if (userClassificationLevel) {
      console.log(`   [ClassifiedUpload] Document classification set to: ${userClassificationLevel}`);
      parsedDocument.metadata.overallClassification = userClassificationLevel;
    }

    // Enforce: user cannot upload a document with sections above their own clearance
    const CLEARANCE_NUMERIC = {
      'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2,
      'RESTRICTED': 3, 'SECRET': 4, 'TOP-SECRET': 4
    };
    const userClearanceNum = session.clearanceLevel ? (CLEARANCE_NUMERIC[session.clearanceLevel] ?? 0) : 0;
    const maxSectionLevel = parsedDocument.sections.reduce((max, s) => Math.max(max, s.clearanceLevel ?? 0), 0);

    if (maxSectionLevel > userClearanceNum) {
      const maxSectionName = Object.entries(CLEARANCE_NUMERIC).find(([, v]) => v === maxSectionLevel)?.[0] || 'UNKNOWN';
      console.log(`   [ClassifiedUpload] ❌ Rejected: highest section ${maxSectionName} exceeds user clearance ${session.clearanceLevel || 'NONE'}`);
      return res.status(403).json({
        success: false,
        error: 'InsufficientClearance',
        message: `You cannot upload a document containing ${maxSectionName} sections. Your clearance level is ${session.clearanceLevel || 'UNCLASSIFIED'}.`
      });
    }

    // Encrypt sections
    const encryptedPackage = SectionEncryptionService.encryptSections(
      parsedDocument,
      COMPANY_SECRET
    );

    console.log(`   [ClassifiedUpload] Encrypted ${encryptedPackage.encryptedSections.length} sections`);
    console.log(`   Document ID: ${encryptedPackage.documentId}`);

    // Parse releasableTo
    let releasableArray = [];
    if (releasableTo) {
      try {
        releasableArray = typeof releasableTo === 'string' ? JSON.parse(releasableTo) : releasableTo;
      } catch (e) {
        releasableArray = [releasableTo];
      }
    }

    // Convert company names to DIDs if needed
    const releasableDIDs = releasableArray.map(item => {
      if (item.startsWith('did:')) return item;
      const companyDID = COMPANY_ISSUER_DIDS[item];
      return companyDID || item;
    }).filter(Boolean);

    // Upload encrypted package to Iagon
    const packageJson = JSON.stringify(encryptedPackage);
    const packageBuffer = Buffer.from(packageJson, 'utf8');

    const iagonClient = getIagonClient();
    const iagonResult = await iagonClient.uploadFile(
      packageBuffer,
      `${encryptedPackage.documentId}.json`,
      { classificationLevel: parsedDocument.metadata.overallClassification }
    );

    console.log(`   [ClassifiedUpload] Uploaded encrypted package to Iagon: ${iagonResult.fileId}`);

    // Task 2: Wrap DEK with CMK before persisting
    let encryptionManifestId = null;
    let classifiedUploadWrappedManifest = null;
    if (iagonResult.rawDEK) {
      try {
        classifiedUploadWrappedManifest = cmk.wrapDEK(iagonResult.rawDEK, parsedDocument.metadata.overallClassification);
        const wrappedManifest = classifiedUploadWrappedManifest;
        iagonResult.rawDEK.fill(0); // zero raw key from memory (PFS)

        // Upload wrapped manifest to Iagon
        const { manifestFileId } = await iagonClient.uploadKeyManifest(
          wrappedManifest,
          encryptedPackage.documentId
        );
        encryptionManifestId = manifestFileId;
        console.log(`   [ClassifiedUpload] ✅ Key manifest uploaded to Iagon: ${encryptionManifestId}`);
      } catch (manifestErr) {
        console.error('[ClassifiedUpload] Failed to upload key manifest to Iagon:', manifestErr.message);
        // Continue — will fall back to legacy path during access
      }
    }

    // For DOCX files, also upload the original file for full-fidelity redacted viewing
    let originalDocxResult = null;
    let originalDocxManifestId = null;
    console.log(`   [ClassifiedUpload] ===== ORIGINAL DOCX UPLOAD CHECK =====`);
    console.log(`   [ClassifiedUpload] isDocx value: ${isDocx}`);
    if (isDocx) {
      console.log(`   [ClassifiedUpload] ✅ DOCX detected - uploading original for redacted viewing...`);
      try {
        originalDocxResult = await iagonClient.uploadFile(
          file.buffer,
          `original-${encryptedPackage.documentId}.docx`,
          {
            classificationLevel: parsedDocument.metadata.overallClassification,
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          }
        );
        console.log(`   [ClassifiedUpload] ✅ Uploaded original DOCX: ${originalDocxResult?.fileId}`);
        console.log(`   [ClassifiedUpload] Full result:`, JSON.stringify(originalDocxResult, null, 2));

        // Task 2: Wrap DOCX DEK with CMK before persisting
        if (originalDocxResult?.rawDEK) {
          try {
            const wrappedDocxManifest = cmk.wrapDEK(originalDocxResult.rawDEK, parsedDocument.metadata.overallClassification);
            originalDocxResult.rawDEK.fill(0); // zero raw key from memory (PFS)

            const { manifestFileId: docxManifestFileId } = await iagonClient.uploadKeyManifest(
              wrappedDocxManifest,
              `original-${encryptedPackage.documentId}`
            );
            originalDocxManifestId = docxManifestFileId;
            console.log(`   [ClassifiedUpload] ✅ Original DOCX key manifest uploaded: ${originalDocxManifestId}`);
          } catch (docxManifestErr) {
            console.error('[ClassifiedUpload] Failed to upload original DOCX key manifest:', docxManifestErr.message);
          }
        }
      } catch (docxUploadError) {
        console.error(`   [ClassifiedUpload] ❌ Failed to upload original DOCX:`, docxUploadError.message);
        // Continue without original - will fall back to HTML rendering
      }
    } else {
      console.log(`   [ClassifiedUpload] Not DOCX - skipping original upload`);
    }

    // Create real PRISM DID with DocumentAccessGate + DocumentPolicy service entries
    const PUBLIC_URL = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
    const deptKey = DEPARTMENT_API_KEYS[department || session.department] || DEPARTMENT_API_KEYS['Security'];
    const documentManager = new EnterpriseDocumentManager(ENTERPRISE_CLOUD_AGENT_URL, deptKey);
    let documentDID;
    try {
      const accessGateService = {
        id: 'document-access-gate',
        type: 'DocumentAccessGate',
        serviceEndpoint: `${PUBLIC_URL}/api/access-gate/challenge`
      };
      const didResult = await documentManager.createDocumentDIDWithServiceEndpoint(
        department || session.department || 'Security',
        {
          title: parsedDocument.metadata.title,
          classificationLevel: parsedDocument.metadata.overallClassification,
          releasableTo: releasableDIDs
        },
        {
          fileId:         iagonResult.fileId,
          downloadUrl:    iagonResult.iagonUrl || iagonResult.url || '',
          contentHash:    iagonResult.contentHash    || null,
          encryptionInfo: iagonResult.encryptionInfo || null
        },
        [accessGateService],
        { documentServiceUrl: req.company?.documentServiceUrl || null }
      );
      documentDID = didResult.documentDID;
      console.log(`   [ClassifiedUpload] ✅ Real PRISM DID created: ${documentDID.substring(0, 60)}...`);
    } catch (didError) {
      console.error(`   [ClassifiedUpload] ❌ PRISM DID creation failed: ${didError.message}`);
      throw new Error(`Failed to create PRISM DID for classified document: ${didError.message}`);
    }

    // Register in DocumentRegistry
    const registryEntry = {
      documentDID,
      title: parsedDocument.metadata.title,
      classificationLevel: parsedDocument.metadata.overallClassification, // DocumentRegistry requires this field name
      contentEncryptionKey: encryptedPackage.keyring?.INTERNAL || 'classified-section-keys', // Required by registry
      releasableTo: releasableDIDs,
      ownerCompanyDID: session.issuerDID || null,
      metadata: {
        sectionCount: encryptedPackage.encryptedSections.length,
        sectionMetadata: SectionEncryptionService.getSectionMetadata(encryptedPackage),
        createdBy: session.email,
        createdByDID: session.prismDID,
        creatorRole: session.role,
        department: department || session.department,
        sourceFormat: isDocx ? 'docx' : 'html',
        originalFilename: file.originalname
      },
      iagonStorage: {
        fileId: iagonResult.fileId,
        nodeId: iagonResult.nodeId,
        url: iagonResult.url,
        filename: file.originalname,
        encryptionManifestId: encryptionManifestId,         // Task 2: manifest replaces raw key
        encryptionInfo: iagonResult.encryptionInfo || null, // iv, authTag, algorithm — NO key
        // For DOCX: store original file ID + decryption info for full-fidelity redacted viewing
        originalDocxFileId: originalDocxResult?.fileId || null,
        originalDocxManifestId: originalDocxManifestId || null, // Task 2: DOCX key manifest
        originalDocxEncryptionInfo: originalDocxResult?.encryptionInfo || null
      }
    };

    console.log(`   [ClassifiedUpload] ===== REGISTRY ENTRY =====`);
    console.log(`   [ClassifiedUpload] iagonStorage:`, JSON.stringify(registryEntry.iagonStorage, null, 2));
    console.log(`   [ClassifiedUpload] metadata.sourceFormat: ${registryEntry.metadata.sourceFormat}`);
    console.log(`   [ClassifiedUpload] originalDocxFileId: ${registryEntry.iagonStorage.originalDocxFileId}`);

    // Store in DocumentRegistry (add to existing registry)
    await DocumentRegistry.registerDocument(registryEntry);

    console.log(`   [ClassifiedUpload] Registered document: ${documentDID}`);

    fs.appendFile(ACCESS_GATE_LOG_PATH, JSON.stringify(buildLogEntry({
      eventType: 'CREATED',
      viewerName: session.email,
      documentDID,
      documentTitle: parsedDocument.metadata.title,
      clearanceLevel: parsedDocument.metadata.overallClassification,
      companyDID: session.issuerDID || null,
      accessGranted: true,
      clientIp: req.ip || req.connection?.remoteAddress || null
    })) + '\n', () => {});

    // =========================================================================
    // STEP 5: Push KeyManifest VC to document-service
    // =========================================================================
    let classifiedUploadVCId = null;
    if (classifiedUploadWrappedManifest && iagonResult && documentDID) {
      try {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || null;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcIssuer = new KeyManifestVCIssuer(docServiceUrl, adminKey);
        const prevVC = await fetchCurrentManifestVC(documentDID, docServiceUrl, adminKey);
        const versionNumber = (prevVC?.claims?.versionNumber ?? 0) + 1;
        const predecessorHash = prevVC ? KeyManifestVCIssuer.computePredecessorHash(prevVC.vcJwt) : null;

        const vcResult = await vcIssuer.issue({
          documentDID,
          issuerDID:          session.issuerDID || process.env.SERVICE_DID,
          iagonFileId:        iagonResult.fileId,
          classificationLevel: parsedDocument.metadata.overallClassification,
          releasableTo:       releasableDIDs,
          wrappedKey:         classifiedUploadWrappedManifest.wrappedKey,
          iv:                 classifiedUploadWrappedManifest.iv,
          authTag:            classifiedUploadWrappedManifest.authTag,
          wrappingAlgorithm:  classifiedUploadWrappedManifest.wrappingAlgorithm || 'AES-256-GCM',
          fileAlgorithm:      iagonResult.encryptionInfo?.algorithm || 'AES-256-GCM',
          fileIv:             iagonResult.encryptionInfo?.iv,
          fileAuthTag:        iagonResult.encryptionInfo?.authTag,
          contentHash:        iagonResult.contentHash || null,
          versionNumber,
          updatedBy:          session.prismDid || session.issuerDID || null,
          predecessorHash
        });

        console.log(`   [ClassifiedUpload] ✅ KeyManifest VC v${versionNumber} pushed to document-service: ${vcResult.vcId}`);
        classifiedUploadVCId = vcResult.vcId;
      } catch (vcPushErr) {
        console.error('   [ClassifiedUpload] ⚠️ Failed to push KeyManifest VC to document-service:', vcPushErr.message);
        // Non-fatal — document is stored, VC can be pushed manually
      }
    }

    res.json({
      success: true,
      documentDID,
      title: parsedDocument.metadata.title,
      overallClassification: parsedDocument.metadata.overallClassification,
      sectionCount: encryptedPackage.encryptedSections.length,
      clearanceLevelStats: parsedDocument.metadata.clearanceLevelStats,
      iagonFileId: iagonResult.fileId,
      keyManifestVCId: classifiedUploadVCId,
      message: 'Classified document uploaded and encrypted successfully'
    });

  } catch (error) {
    console.error('[ClassifiedUpload] Error:', error);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to upload classified document'
    });
  }
});

/**
 * POST /api/classified-documents/download
 * Download a classified document with section-level redaction
 * Creates an ephemeral DID with 1-hour TTL and delivers encrypted document to wallet
 *
 * Request Body:
 * - documentDID: The document's DID
 * - recipientDID: Recipient's PRISM DID (optional, from session if not provided)
 * - recipientPublicKey: Base64-encoded X25519 public key for encryption
 * - connectionId: DIDComm connection ID for sending document (optional)
 *
 * Flow:
 * 1. Validate user authorization and clearance
 * 2. Download encrypted package from Iagon
 * 3. Decrypt sections user is authorized to see
 * 4. Generate redacted HTML for unauthorized sections
 * 5. Create ephemeral DID with 1-hour TTL
 * 6. Encrypt document for recipient's wallet
 * 7. Return encrypted document (or send via DIDComm if connectionId provided)
 */
app.post('/api/classified-documents/download', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;

  console.log('\n' + '='.repeat(80));
  console.log('[ClassifiedDownload] Document download request');
  console.log('   Employee:', session.email);
  console.log('   Clearance:', session.clearanceLevel || 'UNCLASSIFIED');
  console.log('='.repeat(80));

  try {
    const { documentDID, recipientDID, recipientPublicKey, connectionId } = req.body;

    if (!documentDID || !recipientPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'documentDID and recipientPublicKey are required'
      });
    }

    // Get user clearance from session
    const userClearance = session.clearanceLevel || 'UNCLASSIFIED';
    const userClearanceLevel = ClearanceDocumentParser.CLEARANCE_LEVELS[userClearance] ?? 0;
    const employeeIssuerDID = session.issuerDID;

    console.log(`   Document DID: ${documentDID}`);
    console.log(`   User clearance: ${userClearance} (level ${userClearanceLevel})`);

    // =========================================================================
    // STEP 1: Get document from registry and verify authorization
    // =========================================================================
    let documentRecord;
    try {
      documentRecord = await DocumentRegistry.getClassifiedDocument(
        documentDID,
        employeeIssuerDID,
        userClearance
      );
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log('[ClassifiedDownload] ❌ Document not found');
        return res.status(404).json({
          success: false,
          error: 'DocumentNotFound',
          message: 'Document not found in registry'
        });
      }
      if (error.message.includes('Unauthorized')) {
        console.log('[ClassifiedDownload] ❌ Access denied - company not authorized');
        return res.status(403).json({
          success: false,
          error: 'AccessDenied',
          message: 'Your company is not authorized to access this document'
        });
      }
      throw error;
    }

    console.log(`   [ClassifiedDownload] Document found: ${documentRecord.title}`);
    console.log(`   Overall classification: ${documentRecord.overallClassification}`);
    console.log(`   Visible sections: ${documentRecord.sectionSummary.visibleCount}`);
    console.log(`   Redacted sections: ${documentRecord.sectionSummary.redactedCount}`);

    // =========================================================================
    // STEP 2: Determine document format and download accordingly
    // =========================================================================
    if (!documentRecord.iagonStorage || !documentRecord.iagonStorage.fileId) {
      console.log('[ClassifiedDownload] ❌ Document has no Iagon storage');
      return res.status(404).json({
        success: false,
        error: 'NoStorageMetadata',
        message: 'Document has no file stored on Iagon'
      });
    }

    const iagonClient = getIagonClient();
    const isDocx = documentRecord.metadata?.sourceFormat === 'docx' &&
                   documentRecord.iagonStorage.originalDocxFileId;

    let redactedDocument;
    let documentFormat = 'html';
    let encryptedPackage;
    let decryptionResult;

    if (isDocx) {
      // =========================================================================
      // DOCX Flow: Full-fidelity redaction on original document
      // =========================================================================
      console.log(`   [ClassifiedDownload] DOCX document - using full-fidelity redaction`);
      console.log(`   [ClassifiedDownload] Downloading original DOCX: ${documentRecord.iagonStorage.originalDocxFileId}`);

      try {
        // Download original DOCX
        const originalDocx = await iagonClient.downloadFile(documentRecord.iagonStorage.originalDocxFileId);
        console.log(`   [ClassifiedDownload] Downloaded original DOCX (${originalDocx.length} bytes)`);

        // Apply redactions in-place
        redactedDocument = await DocxRedactionService.applyRedactions(
          originalDocx,
          userClearance,
          documentRecord.metadata?.sectionMetadata || []
        );

        documentFormat = 'docx';
        console.log(`   [ClassifiedDownload] Generated redacted DOCX (${redactedDocument.length} bytes)`);

        // For section summary, calculate from metadata
        decryptionResult = {
          decryptedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
            s => s.clearanceLevel <= userClearanceLevel
          ),
          redactedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
            s => s.clearanceLevel > userClearanceLevel
          )
        };

      } catch (docxError) {
        console.error('[ClassifiedDownload] ❌ Failed to process DOCX:', docxError.message);
        return res.status(500).json({
          success: false,
          error: 'DocxProcessingFailed',
          message: 'Failed to apply redactions to DOCX document'
        });
      }

    } else {
      // =========================================================================
      // HTML Flow: Decrypt sections and generate HTML with redactions
      // =========================================================================
      console.log(`   [ClassifiedDownload] HTML document - using section-based redaction`);
      console.log(`   [ClassifiedDownload] Downloading from Iagon: ${documentRecord.iagonStorage.fileId}`);

      try {
        const packageBuffer = await iagonClient.downloadFile(documentRecord.iagonStorage.fileId);
        encryptedPackage = JSON.parse(packageBuffer.toString('utf8'));
        console.log(`   [ClassifiedDownload] Downloaded encrypted package (${encryptedPackage.encryptedSections?.length || 0} sections)`);
      } catch (iagonError) {
        console.error('[ClassifiedDownload] ❌ Failed to download from Iagon:', iagonError.message);
        return res.status(500).json({
          success: false,
          error: 'DownloadFailed',
          message: 'Failed to download document from storage'
        });
      }

      // Decrypt authorized sections
      console.log(`   [ClassifiedDownload] Decrypting sections for ${userClearance} clearance...`);

      decryptionResult = SectionEncryptionService.decryptSectionsForUser(
        encryptedPackage,
        userClearance,
        COMPANY_SECRET
      );

      console.log(`   [ClassifiedDownload] Decrypted ${decryptionResult.decryptedSections.length} sections`);
      console.log(`   [ClassifiedDownload] Redacted ${decryptionResult.redactedSections.length} sections`);

      // Generate redacted HTML document
      console.log(`   [ClassifiedDownload] Generating redacted HTML...`);

      redactedDocument = RedactionEngine.generateRedactedDocument({
        metadata: encryptedPackage?.metadata || documentRecord.metadata,
        decryptedSections: decryptionResult.decryptedSections,
        redactedSections: decryptionResult.redactedSections,
        userClearance
      });

      console.log(`   [ClassifiedDownload] Generated HTML document (${redactedDocument.length} bytes)`);
    }

    // =========================================================================
    // STEP 5: Create ephemeral DID with 1-hour TTL
    // =========================================================================
    const redactedSectionIds = decryptionResult.redactedSections.map(s => ({
      sectionId: s.sectionId,
      clearance: s.clearance
    }));

    const { didDocument, metadata: ephemeralMetadata } = EphemeralDIDService.createEphemeralDID({
      originalDocumentDID: documentDID,
      recipientDID: recipientDID || session.prismDID,
      recipientPublicKey,
      clearanceLevel: userClearance,
      redactedSections: redactedSectionIds,
      ttlMs: EphemeralDIDService.DEFAULT_TTL_MS, // 1 hour
      viewsAllowed: -1, // Unlimited views within TTL
      issuerDID: session.issuerDID
    });

    // Store ephemeral DID metadata for status checking
    ephemeralDIDStore.set(ephemeralMetadata.ephemeralDID, ephemeralMetadata);

    console.log(`   [ClassifiedDownload] Created ephemeral DID: ${ephemeralMetadata.ephemeralDID.substring(0, 50)}...`);
    console.log(`   Expires at: ${ephemeralMetadata.expiresAt}`);

    // =========================================================================
    // STEP 6: Encrypt document for recipient's wallet using X25519
    // =========================================================================
    console.log(`   [ClassifiedDownload] Encrypting document for wallet...`);

    // Generate server ephemeral X25519 key pair for this delivery
    const serverKeyPair = nacl.box.keyPair();

    // Decode recipient's public key
    let recipientPubKeyBytes;
    try {
      recipientPubKeyBytes = Buffer.from(recipientPublicKey, 'base64');
      if (recipientPubKeyBytes.length !== 32) {
        throw new Error('Invalid key length');
      }
    } catch (keyErr) {
      return res.status(400).json({
        success: false,
        error: 'InvalidPublicKey',
        message: 'recipientPublicKey must be a valid Base64-encoded 32-byte X25519 public key'
      });
    }

    // Encrypt document content
    // For DOCX: redactedDocument is already a Buffer
    // For HTML: redactedDocument is a string that needs encoding
    const documentBytes = Buffer.isBuffer(redactedDocument)
      ? redactedDocument
      : Buffer.from(redactedDocument, 'utf8');
    const nonce = nacl.randomBytes(24);

    const encryptedDocument = nacl.box(
      documentBytes,
      nonce,
      recipientPubKeyBytes,
      serverKeyPair.secretKey
    );

    // Prepare encryption info for recipient
    const encryptionInfo = {
      algorithm: 'x25519-xsalsa20-poly1305',
      serverPublicKey: Buffer.from(serverKeyPair.publicKey).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64')
    };

    console.log(`   [ClassifiedDownload] Encrypted document (${encryptedDocument.length} bytes)`);

    // =========================================================================
    // STEP 7: Generate content hash and prepare response
    // =========================================================================
    const contentHash = DocumentCopyVCIssuer.generateContentHash(documentBytes);

    // Prepare document copy data for response/DIDComm
    const documentCopyData = {
      originalDocumentDID: documentDID,
      ephemeralDID: ephemeralMetadata.ephemeralDID,
      ephemeralServiceEndpoint: null, // Document delivered via DIDComm — no separate fetch endpoint
      title: documentRecord.title,
      classification: documentRecord.overallClassification || documentRecord.classificationLevel,
      clearanceLevelGranted: userClearance,
      redactedSections: redactedSectionIds,
      sectionSummary: {
        totalSections: (decryptionResult.decryptedSections.length + decryptionResult.redactedSections.length),
        visibleCount: decryptionResult.decryptedSections.length,
        redactedCount: decryptionResult.redactedSections.length
      },
      sourceInfo: {
        filename: documentRecord.metadata?.originalFilename || (documentFormat === 'docx' ? 'classified-document.docx' : 'classified-document.html'),
        format: documentFormat,
        contentType: documentFormat === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/html',
        originalSize: documentBytes.length
      },
      accessRights: {
        expiresAt: ephemeralMetadata.expiresAt,
        viewsAllowed: -1,
        downloadAllowed: false,
        printAllowed: false
      },
      contentHash,
      encryptionKeyId: `${ephemeralMetadata.ephemeralDID}#key-1`
    };

    // =========================================================================
    // STEP 8: Send via DIDComm if connectionId provided, otherwise return directly
    // =========================================================================
    if (connectionId && session.connectionId) {
      console.log(`   [ClassifiedDownload] Sending document via DIDComm to connection: ${connectionId}`);

      try {
        // Get department API key for DIDComm
        const departmentApiKey = DEPARTMENT_API_KEYS[session.department] || DEPARTMENT_API_KEYS['IT'];

        await DocumentCopyVCIssuer.issueAndSendDocument({
          holderDID: recipientDID || session.prismDID,
          connectionId: connectionId || session.connectionId,
          encryptedContent: Buffer.from(encryptedDocument),
          encryptionInfo,
          documentCopyData,
          apiKey: departmentApiKey
        });

        console.log(`   [ClassifiedDownload] ✅ Document sent via DIDComm`);
      } catch (didcommError) {
        console.error('[ClassifiedDownload] ⚠️ DIDComm send failed, returning document directly:', didcommError.message);
        // Fall through to direct response
      }
    }

    // Generate access token for status checking
    const accessToken = EphemeralDIDService.generateAccessToken(ephemeralMetadata);

    // Record access in registry
    try {
      await DocumentRegistry.recordSectionAccess(documentDID, session.prismDID || session.email,
        decryptionResult.decryptedSections.map(s => s.sectionId));
    } catch (logErr) {
      console.warn('[ClassifiedDownload] Failed to record access:', logErr.message);
    }

    console.log('='.repeat(80));
    console.log('✅ [ClassifiedDownload] Document prepared successfully');
    console.log(`   Ephemeral DID: ${ephemeralMetadata.ephemeralDID.substring(0, 50)}...`);
    console.log(`   Visible sections: ${decryptionResult.decryptedSections.length}`);
    console.log(`   Redacted sections: ${decryptionResult.redactedSections.length}`);
    console.log(`   Expires: ${ephemeralMetadata.expiresAt}`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      ephemeralDID: ephemeralMetadata.ephemeralDID,
      didDocument,
      expiresAt: ephemeralMetadata.expiresAt,
      ttlMinutes: 60,
      accessToken,
      userClearance,
      documentCopy: documentCopyData,
      encryptedDocument: Buffer.from(encryptedDocument).toString('base64'),
      encryptionInfo,
      message: 'Document prepared. Decrypt with your wallet private key.',
      sectionSummary: {
        total: decryptionResult.decryptedSections.length + decryptionResult.redactedSections.length,
        visible: decryptionResult.decryptedSections.length,
        redacted: decryptionResult.redactedSections.length,
        redactedSections: redactedSectionIds
      }
    });

  } catch (error) {
    console.error('[ClassifiedDownload] Error:', error);
    console.error('[ClassifiedDownload] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to process download request'
    });
  }
});

// In-memory storage for pending downloads (storageId -> prepared document data)
// In production, use Redis or database
const pendingDownloads = new Map();

/**
 * POST /api/employee-portal/documents/prepare-download/:documentDID
 *
 * SSI-COMPLIANT DOCUMENT DELIVERY - STEP 1
 *
 * Prepares a document for download and returns storage details.
 * The wallet should then create an ephemeral DID via Employee Cloud Agent (8300)
 * with the service endpoint URL provided.
 *
 * Returns:
 * - storageId: Unique ID for this download
 * - serviceEndpointUrl: URL to embed in ephemeral DID's service endpoint
 * - documentMetadata: Title, classification, section info
 * - expiresAt: When this prepared download expires
 */
app.post('/api/employee-portal/documents/prepare-download/:documentDID', requireEmployeeSession, async (req, res) => {
  const session = req.employeeSession;
  const { documentDID } = req.params;

  console.log('\n' + '='.repeat(80));
  console.log('[PrepareDownload] SSI-compliant document delivery - Step 1');
  console.log('   Employee:', session.email);
  console.log('   Document DID:', documentDID);
  console.log('   Clearance:', session.clearanceLevel || 'UNCLASSIFIED');
  console.log('='.repeat(80));

  try {
    // Get user clearance from session
    const userClearance = session.clearanceLevel || 'UNCLASSIFIED';
    const userClearanceLevel = ClearanceDocumentParser.CLEARANCE_LEVELS[userClearance] ?? 0;
    const employeeIssuerDID = session.issuerDID;

    // =========================================================================
    // STEP 1: Get document from registry and verify authorization
    // =========================================================================
    let documentRecord;
    try {
      documentRecord = await DocumentRegistry.getClassifiedDocument(
        documentDID,
        employeeIssuerDID,
        userClearance
      );
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: 'DocumentNotFound',
          message: 'Document not found in registry'
        });
      }
      if (error.message.includes('Unauthorized')) {
        return res.status(403).json({
          success: false,
          error: 'AccessDenied',
          message: 'Your company is not authorized to access this document'
        });
      }
      throw error;
    }

    console.log(`   [PrepareDownload] Document found: ${documentRecord.title}`);
    console.log(`   Classification: ${documentRecord.overallClassification}`);

    // =========================================================================
    // STEP 2: Download and prepare redacted document (but don't encrypt yet)
    // =========================================================================
    const iagonClient = getIagonClient();
    // Match the same isDocx logic as /api/access-gate/present: OR not AND, so
    // documents with originalDocxFileId but null metadata are correctly detected.
    // Also check filename extension as fallback for records with no metadata/originalDocxFileId.
    const isDocx = documentRecord.metadata?.sourceFormat === 'docx' ||
                   !!documentRecord.iagonStorage?.originalDocxFileId ||
                   (documentRecord.iagonStorage?.filename || '').toLowerCase().endsWith('.docx');

    let redactedDocument;
    let documentFormat = 'html';
    let decryptionResult;

    // CMK-unwrap helper — VC-first, then Iagon manifest, then legacy fallback
    // Pass docDIDForVC to enable VC-first path (omit for originalDocx downloads).
    async function decryptFromIagon(storage, classLevel, docDIDForVC = null) {
      // ── VC-first path ─────────────────────────────────────────────────────
      if (docDIDForVC) {
        const docServiceUrl = process.env.DOCUMENT_SERVICE_URL;
        const adminKey = process.env.DOCUMENT_SERVICE_ADMIN_KEY;
        const vcRecord = await fetchCurrentManifestVC(docDIDForVC, docServiceUrl, adminKey);
        if (vcRecord) {
          const verifier = new (require('./lib/KeyManifestVCVerifier'))({
            inlineJwk: process.env.MANIFEST_SIGNING_KEY_PUBLIC
          });
          const result = await verifier.verify(vcRecord);
          if (!result.valid) throw new ManifestVCInvalid(result.reason);
          const { claims } = result;
          const rawDEK = cmk.unwrapDEK(claims, classLevel);
          const fullEncInfo = {
            algorithm: claims.fileAlgorithm || 'AES-256-GCM',
            iv:        claims.fileIv,
            authTag:   claims.fileAuthTag,
            key:       rawDEK.toString('base64')
          };
          const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
          rawDEK.fill(0);
          return content;
        }
        // No VC found — fall through to Iagon manifest path
      }
      // ── Iagon manifest path ────────────────────────────────────────────────
      if (storage.encryptionManifestId) {
        const wrappedManifest = await iagonClient.downloadKeyManifest(storage.encryptionManifestId);
        const rawDEK = cmk.unwrapDEK(wrappedManifest, classLevel);
        const fullEncInfo = { ...storage.encryptionInfo, key: rawDEK.toString('base64') };
        const content = await iagonClient.downloadFile(storage.fileId, fullEncInfo);
        rawDEK.fill(0);
        return content;
      }
      // ── Legacy path ────────────────────────────────────────────────────────
      if (storage.encryptionInfo && !storage.encryptionInfo.key) {
        throw new Error('DocumentKeyUnavailable: encryption key missing from registry — document must be re-uploaded');
      }
      return iagonClient.downloadFile(storage.fileId, storage.encryptionInfo || null);
    }

    if (isDocx) {
      // DOCX Flow
      try {
        let originalDocx;
        if (documentRecord.iagonStorage.originalDocxFileId) {
          const docxStorage = {
            fileId: documentRecord.iagonStorage.originalDocxFileId,
            encryptionManifestId: documentRecord.iagonStorage.originalDocxManifestId || null,
            encryptionInfo: documentRecord.iagonStorage.originalDocxEncryptionInfo || null
          };
          const docxDIDForVC = docxStorage.encryptionManifestId ? null : documentDID;
          originalDocx = await decryptFromIagon(docxStorage, documentRecord.overallClassification, docxDIDForVC);
        } else {
          originalDocx = await decryptFromIagon(documentRecord.iagonStorage, documentRecord.overallClassification, documentDID);
        }
        redactedDocument = await DocxRedactionService.applyRedactions(
          originalDocx,
          userClearance,
          documentRecord.metadata?.sectionMetadata || []
        );
        documentFormat = 'docx';
        decryptionResult = {
          decryptedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
            s => s.clearanceLevel <= userClearanceLevel
          ),
          redactedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
            s => s.clearanceLevel > userClearanceLevel
          )
        };
      } catch (docxError) {
        console.error('[PrepareDownload] DOCX corrupted or invalid:', docxError.message);
        return res.status(503).json({
          success: false,
          error: 'DocumentCorrupted',
          message: 'The stored document file is corrupted. Please re-upload the document through the admin portal.'
        });
      }
    } else {
      // HTML Flow
      const packageBuffer = await decryptFromIagon(documentRecord.iagonStorage, documentRecord.overallClassification, documentDID);
      const encryptedPackage = JSON.parse(packageBuffer.toString('utf8'));
      decryptionResult = SectionEncryptionService.decryptSectionsForUser(
        encryptedPackage,
        userClearance,
        COMPANY_SECRET
      );
      redactedDocument = RedactionEngine.generateRedactedDocument({
        metadata: encryptedPackage?.metadata || documentRecord.metadata,
        decryptedSections: decryptionResult.decryptedSections,
        redactedSections: decryptionResult.redactedSections,
        userClearance
      });
    }

    console.log(`   [PrepareDownload] Prepared ${documentFormat.toUpperCase()} document`);
    console.log(`   Visible sections: ${decryptionResult.decryptedSections.length}`);
    console.log(`   Redacted sections: ${decryptionResult.redactedSections.length}`);

    // =========================================================================
    // STEP 3: Generate storage ID and service endpoint URL
    // =========================================================================
    const storageId = crypto.randomUUID();
    const baseUrl = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
    const serviceEndpointUrl = `${baseUrl}/api/ephemeral-documents/content/${storageId}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour TTL

    console.log(`   [PrepareDownload] Generated storage ID: ${storageId}`);
    console.log(`   Service endpoint URL: ${serviceEndpointUrl}`);

    // =========================================================================
    // STEP 4: CREATE EPHEMERAL DID ON SERVER (FIX: Dec 13, 2025)
    // Server creates the ephemeral DID instead of wallet, because:
    // - Wallet's ServiceConfiguration VC points to Enterprise Agent (8200)
    // - 8200 is for company wallets (issues credentials FROM)
    // - Server has access to Employee Agent (8300) for employee DIDs
    // =========================================================================
    const redactedSectionIds = decryptionResult.redactedSections.map(s => ({
      sectionId: s.sectionId,
      clearance: s.clearance
    }));

    const ephemeralDIDResult = EphemeralDIDService.createEphemeralDID({
      originalDocumentDID: documentDID,
      recipientDID: session.prismDID,
      clearanceLevel: userClearance,
      redactedSections: redactedSectionIds,
      ttlMs: 60 * 60 * 1000, // 1 hour
      viewsAllowed: -1, // unlimited views
      issuerDID: employeeIssuerDID
    });

    const ephemeralDID = ephemeralDIDResult.metadata.ephemeralDID;
    const ephemeralX25519PublicKey = ephemeralDIDResult.metadata.keyPair.publicKey;

    console.log(`   [PrepareDownload] Created ephemeral DID: ${ephemeralDID}`);
    console.log(`   [PrepareDownload] Ephemeral X25519 public key generated`);

    // =========================================================================
    // STEP 5: Store prepared data temporarily (waiting for wallet to complete)
    // =========================================================================
    pendingDownloads.set(storageId, {
      redactedDocument,
      documentFormat,
      documentRecord,
      decryptionResult,
      redactedSectionIds,
      ephemeralDIDResult, // Include ephemeral DID metadata for complete-download
      session: {
        email: session.email,
        prismDID: session.prismDID,
        clearanceLevel: userClearance,
        department: session.department,
        issuerDID: session.issuerDID,
        connectionId: session.connectionId,
        companyConnectionId: session.companyConnectionId
      },
      documentDID,
      expiresAt,
      createdAt: new Date().toISOString()
    });

    // Auto-cleanup after 10 minutes (wallet has time to complete)
    setTimeout(() => {
      if (pendingDownloads.has(storageId)) {
        console.log(`[PrepareDownload] Cleanup expired pending download: ${storageId}`);
        pendingDownloads.delete(storageId);
      }
    }, 10 * 60 * 1000);

    console.log(`   [PrepareDownload] Server created ephemeral DID - wallet just needs to generate keypair`);

    res.json({
      success: true,
      storageId,
      serviceEndpointUrl,
      expiresAt,
      // NEW: Server provides ephemeral DID - wallet doesn't need to create it
      ephemeralDID,
      ephemeralX25519PublicKey, // Server's ephemeral key (for reference)
      documentMetadata: {
        title: documentRecord.title,
        classification: documentRecord.overallClassification,
        format: documentFormat,
        sectionSummary: {
          visibleCount: decryptionResult.decryptedSections.length,
          redactedCount: decryptionResult.redactedSections.length
        },
        redactedSections: redactedSectionIds
      },
      instructions: 'Generate your own X25519 keypair, then call complete-download with your public key. Server will encrypt document for your key.'
    });

  } catch (error) {
    console.error('[PrepareDownload] Error:', error);
    if (error.name === 'ManifestVCInvalid' || (error.message && error.message.includes('ManifestVCInvalid'))) {
      return res.status(403).json({
        success: false,
        error: 'ManifestVCInvalid',
        message: 'Document key manifest VC is invalid or has been tampered with.'
      });
    }
    if (error.message && error.message.includes('DocumentKeyUnavailable')) {
      return res.status(503).json({
        success: false,
        error: 'DocumentKeyUnavailable',
        message: 'This document\'s encryption key is unavailable. The document must be re-uploaded by an administrator.'
      });
    }
    res.status(500).json({
      success: false,
      error: 'ServerError',
      message: error.message
    });
  }
});

/**
 * POST /api/employee-portal/documents/complete-download/:storageId
 *
 * SSI-COMPLIANT DOCUMENT DELIVERY - STEP 2
 *
 * Completes the download using server-created ephemeral DID from prepare-download.
 * Encrypts document for wallet's public key and issues credential offer.
 *
 * Request Body:
 * - x25519PublicKey: Base64-encoded X25519 public key from wallet (for encryption)
 * - connectionId: (optional) Override connection ID for credential offer
 *
 * NOTE (Dec 13, 2025): ephemeralDID is now created by server in prepare-download,
 * not by wallet. Wallet just provides its X25519 public key for encryption.
 */
app.post('/api/employee-portal/documents/complete-download/:storageId', requireEmployeeSession, async (req, res) => {
  const EphemeralDocumentStore = require('./lib/EphemeralDocumentStore');
  const { storageId } = req.params;
  const { x25519PublicKey, connectionId } = req.body;

  console.log('\n' + '='.repeat(80));
  console.log('[CompleteDownload] SSI-compliant document delivery - Step 2');
  console.log('   Storage ID:', storageId);
  console.log('='.repeat(80));

  try {
    // Validate required fields - only wallet's public key needed now
    if (!x25519PublicKey) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'x25519PublicKey is required'
      });
    }

    // =========================================================================
    // STEP 1: Retrieve pending download data (includes server-created ephemeral DID)
    // =========================================================================
    const pendingData = pendingDownloads.get(storageId);
    if (!pendingData) {
      return res.status(404).json({
        success: false,
        error: 'NotFound',
        message: 'Prepared download not found or expired. Please start over with prepare-download.'
      });
    }

    // Verify session matches
    if (pendingData.session.email !== req.employeeSession.email) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Session mismatch - prepared download belongs to different employee'
      });
    }

    console.log(`   [CompleteDownload] Found pending download for: ${pendingData.documentRecord.title}`);

    // Get ephemeral DID from server-created data (Dec 13, 2025 fix)
    const ephemeralDID = pendingData.ephemeralDIDResult?.metadata?.ephemeralDID;
    if (!ephemeralDID) {
      return res.status(500).json({
        success: false,
        error: 'InternalError',
        message: 'Ephemeral DID not found in pending data. Please retry prepare-download.'
      });
    }
    console.log(`   [CompleteDownload] Using server-created ephemeral DID: ${ephemeralDID}`);

    // =========================================================================
    // STEP 2: Validate X25519 public key
    // =========================================================================
    let recipientPubKeyBytes;
    try {
      recipientPubKeyBytes = Buffer.from(x25519PublicKey, 'base64');
      if (recipientPubKeyBytes.length !== 32) {
        throw new Error('Invalid key length');
      }
    } catch (keyErr) {
      return res.status(400).json({
        success: false,
        error: 'InvalidPublicKey',
        message: 'x25519PublicKey must be a valid Base64-encoded 32-byte X25519 public key'
      });
    }

    // =========================================================================
    // STEP 3: Encrypt document for wallet's public key
    // =========================================================================
    const serverKeyPair = nacl.box.keyPair();
    const documentBytes = Buffer.isBuffer(pendingData.redactedDocument)
      ? pendingData.redactedDocument
      : Buffer.from(pendingData.redactedDocument, 'utf8');
    const nonce = nacl.randomBytes(24);

    const encryptedDocument = nacl.box(
      documentBytes,
      nonce,
      recipientPubKeyBytes,
      serverKeyPair.secretKey
    );

    console.log(`   [CompleteDownload] Encrypted document (${encryptedDocument.length} bytes)`);

    // =========================================================================
    // STEP 4: Store encrypted document in EphemeralDocumentStore
    // =========================================================================
    await EphemeralDocumentStore.save(storageId, {
      encryptedContent: Buffer.from(encryptedDocument).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      serverPublicKey: Buffer.from(serverKeyPair.publicKey).toString('base64'),
      expiresAt: pendingData.expiresAt,
      walletDID: pendingData.session.prismDID,
      documentDID: pendingData.documentDID,
      ephemeralDID: ephemeralDID,
      contentType: pendingData.documentFormat === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/html'
    });

    console.log(`   [CompleteDownload] Stored encrypted document in EphemeralDocumentStore`);

    // =========================================================================
    // STEP 5: Build service endpoint URL (same as prepare step)
    // =========================================================================
    const baseUrl = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
    const serviceEndpointUrl = `${baseUrl}/api/ephemeral-documents/content/${storageId}`;

    // =========================================================================
    // STEP 6: Issue DocumentCopy VC via Cloud Agent credential offer
    // =========================================================================
    const contentHash = DocumentCopyVCIssuer.generateContentHash(documentBytes);

    // Get connection ID for credential offer
    let targetConnectionId = connectionId || pendingData.session.connectionId;
    if (!targetConnectionId && pendingData.session.companyConnectionId) {
      targetConnectionId = pendingData.session.companyConnectionId;
    }

    let credentialOfferResult = null;
    if (targetConnectionId) {
      try {
        const departmentApiKey = DEPARTMENT_API_KEYS[pendingData.session.department] || DEPARTMENT_API_KEYS['IT'];

        credentialOfferResult = await DocumentCopyVCIssuer.createDocumentCopyCredentialOffer({
          holderDID: pendingData.session.prismDID,
          connectionId: targetConnectionId,
          documentCopyData: {
            originalDocumentDID: pendingData.documentDID,
            ephemeralDID: ephemeralDID,
            ephemeralServiceEndpoint: serviceEndpointUrl,
            title: pendingData.documentRecord.title,
            classification: pendingData.documentRecord.overallClassification,
            clearanceLevelGranted: pendingData.session.clearanceLevel,
            redactedSections: pendingData.redactedSectionIds,
            sectionSummary: {
              visibleCount: pendingData.decryptionResult.decryptedSections.length,
              redactedCount: pendingData.decryptionResult.redactedSections.length
            },
            accessRights: {
              expiresAt: pendingData.expiresAt,
              viewsAllowed: -1
            },
            contentHash
          },
          apiKey: departmentApiKey
        });

        console.log(`   [CompleteDownload] DocumentCopy credential offer created: ${credentialOfferResult.recordId}`);

      } catch (vcError) {
        console.warn('[CompleteDownload] Failed to create credential offer:', vcError.message);
        // Continue - document is still accessible via service endpoint
      }
    } else {
      console.warn('[CompleteDownload] No connection ID - skipping credential offer');
    }

    // =========================================================================
    // STEP 7: Cleanup pending download
    // =========================================================================
    pendingDownloads.delete(storageId);

    console.log(`   [CompleteDownload] Complete! Document delivery via SSI successful.`);

    res.json({
      success: true,
      message: 'Document encrypted and stored. Credential offer sent via DIDComm.',
      delivery: {
        method: 'SSI_CREDENTIAL_OFFER',
        ephemeralDID: ephemeralDID,
        serviceEndpoint: serviceEndpointUrl,
        expiresAt: pendingData.expiresAt
      },
      credentialOffer: credentialOfferResult ? {
        recordId: credentialOfferResult.recordId,
        state: credentialOfferResult.state
      } : null,
      document: {
        title: pendingData.documentRecord.title,
        classification: pendingData.documentRecord.overallClassification,
        format: pendingData.documentFormat,
        sectionSummary: {
          visibleCount: pendingData.decryptionResult.decryptedSections.length,
          redactedCount: pendingData.decryptionResult.redactedSections.length
        }
      }
    });

  } catch (error) {
    console.error('[CompleteDownload] Error:', error);
    res.status(500).json({
      success: false,
      error: 'ServerError',
      message: error.message
    });
  }
});

/**
 * POST /api/employee-portal/documents/download-to-wallet/:documentDID
 *
 * LEGACY ENDPOINT (kept for backward compatibility)
 *
 * Downloads a classified document and delivers it via proper SSI/DIDComm:
 * 1. Stores encrypted document on server (indexed by ephemeral ID)
 * 2. Issues DocumentCopy VC via Cloud Agent credential offer
 * 3. Wallet receives VC via DIDComm, fetches document from service endpoint
 *
 * Request Body:
 * - recipientPublicKey: Base64-encoded X25519 public key for encryption
 * - connectionId: (optional) Employee's connection ID to Company Cloud Agent
 *
 * Flow:
 * Company Admin → Cloud Agent (8200) → Employee Cloud Agent (8300) → Browser Wallet
 */
app.post('/api/employee-portal/documents/download-to-wallet/:documentDID', requireEmployeeSession, async (req, res) => {
  const EphemeralDocumentStore = require('./lib/EphemeralDocumentStore');
  const session = req.employeeSession;
  const { documentDID } = req.params;

  console.log('\n' + '='.repeat(80));
  console.log('[DownloadToWallet] SSI-compliant document delivery');
  console.log('   Employee:', session.email);
  console.log('   Document DID:', documentDID);
  console.log('   Clearance:', session.clearanceLevel || 'UNCLASSIFIED');
  console.log('='.repeat(80));

  try {
    const { recipientPublicKey, connectionId } = req.body;

    if (!recipientPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'recipientPublicKey is required'
      });
    }

    // Get user clearance from session
    const userClearance = session.clearanceLevel || 'UNCLASSIFIED';
    const userClearanceLevel = ClearanceDocumentParser.CLEARANCE_LEVELS[userClearance] ?? 0;
    const employeeIssuerDID = session.issuerDID;

    // =========================================================================
    // STEP 1: Get document from registry and verify authorization
    // =========================================================================
    let documentRecord;
    try {
      documentRecord = await DocumentRegistry.getClassifiedDocument(
        documentDID,
        employeeIssuerDID,
        userClearance
      );
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: 'DocumentNotFound',
          message: 'Document not found in registry'
        });
      }
      if (error.message.includes('Unauthorized')) {
        return res.status(403).json({
          success: false,
          error: 'AccessDenied',
          message: 'Your company is not authorized to access this document'
        });
      }
      throw error;
    }

    console.log(`   [DownloadToWallet] Document found: ${documentRecord.title}`);
    console.log(`   Classification: ${documentRecord.overallClassification}`);

    // =========================================================================
    // STEP 2: Download and prepare redacted document
    // =========================================================================
    const iagonClient = getIagonClient();
    const isDocx = documentRecord.metadata?.sourceFormat === 'docx' &&
                   documentRecord.iagonStorage?.originalDocxFileId;

    let redactedDocument;
    let documentFormat = 'html';
    let decryptionResult;

    if (isDocx) {
      // DOCX Flow
      const originalDocx = await iagonClient.downloadFile(documentRecord.iagonStorage.originalDocxFileId);
      redactedDocument = await DocxRedactionService.applyRedactions(
        originalDocx,
        userClearance,
        documentRecord.metadata?.sectionMetadata || []
      );
      documentFormat = 'docx';
      decryptionResult = {
        decryptedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
          s => s.clearanceLevel <= userClearanceLevel
        ),
        redactedSections: (documentRecord.metadata?.sectionMetadata || []).filter(
          s => s.clearanceLevel > userClearanceLevel
        )
      };
    } else {
      // HTML Flow
      const packageBuffer = await iagonClient.downloadFile(documentRecord.iagonStorage.fileId);
      const encryptedPackage = JSON.parse(packageBuffer.toString('utf8'));
      decryptionResult = SectionEncryptionService.decryptSectionsForUser(
        encryptedPackage,
        userClearance,
        COMPANY_SECRET
      );
      redactedDocument = RedactionEngine.generateRedactedDocument({
        metadata: encryptedPackage?.metadata || documentRecord.metadata,
        decryptedSections: decryptionResult.decryptedSections,
        redactedSections: decryptionResult.redactedSections,
        userClearance
      });
    }

    console.log(`   [DownloadToWallet] Prepared ${documentFormat.toUpperCase()} document`);
    console.log(`   Visible sections: ${decryptionResult.decryptedSections.length}`);
    console.log(`   Redacted sections: ${decryptionResult.redactedSections.length}`);

    // =========================================================================
    // STEP 3: Create ephemeral DID with 1-hour TTL
    // =========================================================================
    const redactedSectionIds = decryptionResult.redactedSections.map(s => ({
      sectionId: s.sectionId,
      clearance: s.clearance
    }));

    const { didDocument, metadata: ephemeralMetadata } = EphemeralDIDService.createEphemeralDID({
      originalDocumentDID: documentDID,
      recipientDID: session.prismDID,
      recipientPublicKey,
      clearanceLevel: userClearance,
      redactedSections: redactedSectionIds,
      ttlMs: EphemeralDIDService.DEFAULT_TTL_MS,
      viewsAllowed: -1,
      issuerDID: session.issuerDID
    });

    // Extract ephemeral ID from did:ephemeral:{uuid}
    const ephemeralId = ephemeralMetadata.ephemeralDID.split(':').pop();

    console.log(`   [DownloadToWallet] Created ephemeral DID: ${ephemeralMetadata.ephemeralDID.substring(0, 50)}...`);
    console.log(`   Ephemeral ID: ${ephemeralId}`);
    console.log(`   Expires at: ${ephemeralMetadata.expiresAt}`);

    // =========================================================================
    // STEP 4: Encrypt document for recipient's wallet using X25519
    // =========================================================================
    const serverKeyPair = nacl.box.keyPair();
    let recipientPubKeyBytes;
    try {
      recipientPubKeyBytes = Buffer.from(recipientPublicKey, 'base64');
      if (recipientPubKeyBytes.length !== 32) {
        throw new Error('Invalid key length');
      }
    } catch (keyErr) {
      return res.status(400).json({
        success: false,
        error: 'InvalidPublicKey',
        message: 'recipientPublicKey must be a valid Base64-encoded 32-byte X25519 public key'
      });
    }

    const documentBytes = Buffer.isBuffer(redactedDocument)
      ? redactedDocument
      : Buffer.from(redactedDocument, 'utf8');
    const nonce = nacl.randomBytes(24);

    const encryptedDocument = nacl.box(
      documentBytes,
      nonce,
      recipientPubKeyBytes,
      serverKeyPair.secretKey
    );

    console.log(`   [DownloadToWallet] Encrypted document (${encryptedDocument.length} bytes)`);

    // =========================================================================
    // STEP 5: Store encrypted document in EphemeralDocumentStore
    // =========================================================================
    await EphemeralDocumentStore.save(ephemeralId, {
      encryptedContent: Buffer.from(encryptedDocument).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      serverPublicKey: Buffer.from(serverKeyPair.publicKey).toString('base64'),
      expiresAt: ephemeralMetadata.expiresAt,
      walletDID: session.prismDID,
      documentDID: documentDID,
      contentType: documentFormat === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/html'
    });

    console.log(`   [DownloadToWallet] Stored encrypted document in EphemeralDocumentStore`);

    // =========================================================================
    // STEP 6: Build service endpoint URL
    // =========================================================================
    const baseUrl = process.env.PUBLIC_URL || 'https://identuslabel.cz/company-admin';
    const serviceEndpointUrl = `${baseUrl}/api/ephemeral-documents/content/${ephemeralId}`;

    console.log(`   [DownloadToWallet] Service endpoint: ${serviceEndpointUrl}`);

    // =========================================================================
    // STEP 7: Issue DocumentCopy VC via Cloud Agent credential offer
    // =========================================================================
    const contentHash = DocumentCopyVCIssuer.generateContentHash(documentBytes);

    // Get connection ID for credential offer
    // Priority: request body > session > employee-company connection lookup
    let targetConnectionId = connectionId || session.connectionId;

    // If no connection ID, try to find employee's connection to company
    if (!targetConnectionId && session.companyConnectionId) {
      targetConnectionId = session.companyConnectionId;
    }

    let credentialOfferResult = null;
    if (targetConnectionId) {
      try {
        // Get department API key for Cloud Agent
        const departmentApiKey = DEPARTMENT_API_KEYS[session.department] || DEPARTMENT_API_KEYS['IT'];

        credentialOfferResult = await DocumentCopyVCIssuer.createDocumentCopyCredentialOffer({
          holderDID: session.prismDID,
          connectionId: targetConnectionId,
          documentCopyData: {
            originalDocumentDID: documentDID,
            ephemeralDID: ephemeralMetadata.ephemeralDID,
            ephemeralServiceEndpoint: serviceEndpointUrl,
            title: documentRecord.title,
            classification: documentRecord.overallClassification,
            clearanceLevelGranted: userClearance,
            redactedSections: redactedSectionIds,
            sectionSummary: {
              visibleCount: decryptionResult.decryptedSections.length,
              redactedCount: decryptionResult.redactedSections.length
            },
            accessRights: {
              expiresAt: ephemeralMetadata.expiresAt,
              viewsAllowed: -1
            },
            contentHash
          },
          apiKey: departmentApiKey
        });

        console.log(`   [DownloadToWallet] ✅ Credential offer created: ${credentialOfferResult.recordId}`);
      } catch (vcError) {
        console.warn(`   [DownloadToWallet] ⚠️ Credential offer failed: ${vcError.message}`);
        // Continue without VC - document is still accessible via service endpoint
      }
    } else {
      console.log(`   [DownloadToWallet] ⚠️ No connection ID - skipping credential offer`);
    }

    // Record access in registry
    try {
      await DocumentRegistry.recordSectionAccess(documentDID, session.prismDID || session.email,
        decryptionResult.decryptedSections.map(s => s.sectionId));
    } catch (logErr) {
      console.warn('[DownloadToWallet] Failed to record access:', logErr.message);
    }

    console.log('='.repeat(80));
    console.log('✅ [DownloadToWallet] Document delivery initiated via SSI');
    console.log(`   Ephemeral DID: ${ephemeralMetadata.ephemeralDID.substring(0, 50)}...`);
    console.log(`   Service endpoint: ${serviceEndpointUrl}`);
    console.log(`   Credential offer: ${credentialOfferResult ? credentialOfferResult.recordId : 'skipped'}`);
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: 'DocumentCopy credential offer sent to wallet via DIDComm',
      delivery: {
        method: 'SSI_CREDENTIAL_OFFER',
        ephemeralDID: ephemeralMetadata.ephemeralDID,
        serviceEndpoint: serviceEndpointUrl,
        expiresAt: ephemeralMetadata.expiresAt
      },
      credentialOffer: credentialOfferResult ? {
        recordId: credentialOfferResult.recordId,
        state: credentialOfferResult.state
      } : null,
      sectionSummary: {
        total: decryptionResult.decryptedSections.length + decryptionResult.redactedSections.length,
        visible: decryptionResult.decryptedSections.length,
        redacted: decryptionResult.redactedSections.length
      },
      instructions: 'Check your wallet for the DocumentCopy credential. Use the ephemeralServiceEndpoint claim to fetch the encrypted document.'
    });

  } catch (error) {
    console.error('[DownloadToWallet] Error:', error);
    console.error('[DownloadToWallet] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'InternalServerError',
      message: error.message || 'Failed to process download request'
    });
  }
});

/**
 * GET /api/classified-documents/templates
 * Get available document templates
 */
app.get('/api/classified-documents/templates', (req, res) => {
  res.json({
    success: true,
    templates: [
      {
        name: 'HTML Template',
        description: 'HTML document with data-clearance attributes',
        format: 'html',
        downloadUrl: '/templates/classified-document-template.html',
        instructions: 'Add data-clearance="LEVEL" attribute to any HTML element'
      },
      {
        name: 'Word Template',
        description: 'Microsoft Word document with Content Controls',
        format: 'docx',
        downloadUrl: '/templates/classified-document-template.docx',
        instructions: 'Use Content Controls with tag clearance:LEVEL'
      }
    ],
    clearanceLevels: [
      { level: 1, name: 'INTERNAL', description: 'Basic organizational access' },
      { level: 2, name: 'CONFIDENTIAL', description: 'Sensitive business information' },
      { level: 3, name: 'RESTRICTED', description: 'Highly sensitive strategic information' },
      { level: 4, name: 'SECRET', description: 'Classified information (highest)' }
    ]
  });
});

/**
 * GET /api/classified-documents/:ephemeralDID/status
 * Check status of an ephemeral document access
 */
app.get('/api/classified-documents/:ephemeralDID/status', (req, res) => {
  const { ephemeralDID } = req.params;

  const metadata = ephemeralDIDStore.get(ephemeralDID);

  if (!metadata) {
    return res.status(404).json({
      success: false,
      error: 'NotFound',
      message: 'Ephemeral DID not found'
    });
  }

  const validity = EphemeralDIDService.checkEphemeralDIDValidity(metadata);

  res.json({
    success: true,
    ephemeralDID,
    documentDID: metadata.originalDocumentDID,
    status: validity.valid ? 'active' : 'expired',
    ...validity
  });
});

// ============================================================================
// Error Handling
// ============================================================================

// ============================================================================
// Test Helpers (only active when TEST_BYPASS_KEY env var is set)
// ============================================================================

if (process.env.TEST_BYPASS_KEY) {
  /**
   * POST /api/test/create-session
   * Inject a synthetic employee session for automated testing.
   * Requires X-Test-Key header matching TEST_BYPASS_KEY env var.
   * NEVER expose this in production (guard: TEST_BYPASS_KEY unset).
   */
  app.post('/api/test/create-session', (req, res) => {
    const key = req.headers['x-test-key'];
    if (key !== process.env.TEST_BYPASS_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const session = {
      sessionToken,
      connectionId:   req.body.connectionId   || 'test-connection',
      prismDid:       req.body.prismDid        || 'did:prism:test',
      employeeId:     req.body.employeeId      || 'test-employee',
      role:           req.body.role            || 'Employee',
      department:     req.body.department      || 'IT',
      fullName:       req.body.fullName        || 'Test Employee',
      email:          req.body.email           || 'test@example.com',
      issuerDID:      req.body.issuerDID       || 'did:prism:issuer',
      hasTraining:    req.body.hasTraining     !== undefined ? req.body.hasTraining : true,
      clearanceLevel: req.body.clearanceLevel  || 'TOP-SECRET',
      hasClearanceVC: req.body.hasClearanceVC  !== undefined ? req.body.hasClearanceVC : true,
      authenticatedAt: Date.now(),
      lastActivity:    Date.now()
    };
    employeeSessions.set(sessionToken, session);
    return res.json({ success: true, sessionToken });
  });
  console.log('[TEST] Test session injection endpoint active at POST /api/test/create-session');
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// ============================================================================
// Server Startup
// ============================================================================

app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(70));
  console.log('🏢 Company Admin Portal - Server Started');
  console.log('='.repeat(70));
  console.log(`📍 Local:            http://localhost:${PORT}`);
  console.log(`🌐 Reverse Proxy:    https://identuslabel.cz/company-admin`);
  console.log(`☁️  Cloud Agent:      ${MULTITENANCY_CLOUD_AGENT_URL}`);
  console.log(`🏭 Enterprise Agent: ${ENTERPRISE_CLOUD_AGENT_URL}`);
  console.log(`🏢 Companies:        ${Object.keys(COMPANIES).length} registered`);
  console.log(`   - ${Object.values(COMPANIES).map(c => c.displayName).join(', ')}`);
  console.log(`👥 Departments:      HR, IT, Security`);
  console.log('='.repeat(70));

  // Initialize ServiceConfiguration schema for each company
  console.log('🔧 Initializing ServiceConfiguration schemas...');
  for (const [companyId, company] of Object.entries(COMPANIES)) {
    try {
      const schemaId = await SchemaManager.ensureServiceConfigSchema(
        MULTITENANCY_CLOUD_AGENT_URL,
        company.apiKey,
        company.did
      );
      console.log(`   ✅ ${company.displayName}: Schema ready (${schemaId.split('/').pop()})`);
    } catch (error) {
      console.error(`   ❌ ${company.displayName}: Schema initialization failed:`, error.message);
    }
  }

  // Initialize CISTraining schema for each company
  console.log('🔧 Initializing CISTraining schemas...');
  for (const [companyId, company] of Object.entries(COMPANIES)) {
    try {
      const schemaManager = new SchemaManager(MULTITENANCY_CLOUD_AGENT_URL, company.apiKey);
      const cisSchemaId = await schemaManager.registerCISTrainingSchema(company.did);
      console.log(`   ✅ ${company.displayName}: CIS Training schema ready (${cisSchemaId.split('/').pop()})`);
    } catch (error) {
      console.error(`   ❌ ${company.displayName}: Failed to initialize CIS Training schema:`, error.message);
    }
  }

  // Initialize DocumentRegistry (crash recovery)
  console.log('🔧 Initializing DocumentRegistry...');
  try {
    await DocumentRegistry.initialize();
    const stats = DocumentRegistry.getStatistics();
    console.log(`   ✅ DocumentRegistry loaded (${stats.totalDocuments} documents)`);
    console.log(`   📊 Classification breakdown: INTERNAL=${stats.byClassification['INTERNAL'] || 0}, CONFIDENTIAL=${stats.byClassification['CONFIDENTIAL'] || 0}, RESTRICTED=${stats.byClassification['RESTRICTED'] || 0}, SECRET=${stats.byClassification['SECRET'] || 0}, TOP-SECRET=${stats.byClassification['TOP-SECRET'] || 0}`);
  } catch (error) {
    console.error(`   ❌ DocumentRegistry initialization failed:`, error.message);
  }

  // Initialize FolderRegistry
  console.log('🔧 Initializing FolderRegistry...');
  try {
    await FolderRegistry.initialize();
    console.log(`   ✅ FolderRegistry loaded (${FolderRegistry.folders.size} folders)`);
  } catch (error) {
    console.error(`   ❌ FolderRegistry initialization failed:`, error.message);
  }

  // Initialize ReleasablePartnersRegistry
  console.log('🔧 Initializing ReleasablePartnersRegistry...');
  try {
    await ReleasablePartnersRegistry.initialize();
    console.log(`   ✅ ReleasablePartnersRegistry loaded (${ReleasablePartnersRegistry.partners.size} companies with partner lists)`);
  } catch (error) {
    console.error(`   ❌ ReleasablePartnersRegistry initialization failed:`, error.message);
  }

  // Register enterprise agent webhook for ALL entity wallets (BasicMessageReceived requires per-wallet registration)
  // The /events/webhooks endpoint does not accept x-admin-api-key; per-wallet registration is required.
  // We use a deterministic key per entity (so restarts stay idempotent) and register in the background.
  console.log('🔧 Registering enterprise agent webhooks for all employee wallets (background)...');
  const enterpriseWebhookUrl = `${COMPANY_PUBLIC_BASE_URL}/api/enterprise-messages-webhook`;
  const ENTERPRISE_ADMIN_TOKEN = process.env.ENTERPRISE_ADMIN_TOKEN || '3HPcLUoT9h9QMYiUk2Hs4vMAgLrq8ufu';
  (async () => {
    try {
      let offset = 0; const limit = 100; let registered = 0; let skipped = 0;
      while (true) {
        const r = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/iam/entities?offset=${offset}&limit=${limit}`, {
          headers: { 'x-admin-api-key': ENTERPRISE_ADMIN_TOKEN }
        });
        if (!r.ok) { console.warn(`   ⚠️ Could not list enterprise entities (${r.status})`); break; }
        const data = await r.json();
        const entities = data.contents || [];
        if (entities.length === 0) break;

        for (const entity of entities) {
          // Deterministic per-entity key derived from admin token — stable across restarts
          const webhookKey = crypto.createHash('sha256')
            .update(`ew-${entity.id}-${ENTERPRISE_ADMIN_TOKEN}`)
            .digest('hex');

          // Populate walletId → webhookKey map so enterprise webhook handler can resolve connectionIds
          if (entity.walletId) enterpriseWalletKeyMap.set(entity.walletId, webhookKey);

          // Create the key (idempotent — ignore 409 conflicts if key already exists)
          await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/iam/apikey-authentication`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-api-key': ENTERPRISE_ADMIN_TOKEN },
            body: JSON.stringify({ entityId: entity.id, apiKey: webhookKey })
          }).catch(() => {});

          // Check if webhook already registered for this wallet
          const wResp = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/events/webhooks`, {
            headers: { 'apikey': webhookKey }
          }).catch(() => null);
          if (wResp && wResp.ok) {
            const wData = await wResp.json().catch(() => ({}));
            const items = wData.contents || wData.items || [];
            if (items.some(w => w.url === enterpriseWebhookUrl)) { skipped++; continue; }
          }

          // Register webhook for this entity's wallet
          const regResp = await fetch(`${ENTERPRISE_CLOUD_AGENT_URL}/events/webhooks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': webhookKey },
            body: JSON.stringify({ url: enterpriseWebhookUrl })
          }).catch(() => null);
          if (regResp && regResp.ok) registered++;
        }

        if (entities.length < limit) break;
        offset += limit;
      }
      console.log(`   ✅ Enterprise webhooks: ${registered} newly registered, ${skipped} already registered`);
    } catch (e) {
      console.error('   ❌ Enterprise webhook bulk registration error:', e.message);
    }
  })();

  // Register DIDComm command service webhooks with each company's Cloud Agent (idempotent).
  // Runs for every company in the registry (not just techcorp/acme) — each registration is
  // independently caught so one company's failure doesn't abort the others.
  console.log('🔧 Registering DIDComm access-request webhooks...');
  companyPortalRegistry.registerAllWebhooks((id) => `${COMPANY_PUBLIC_BASE_URL}/api/didcomm-webhook/${id}`);

  console.log('='.repeat(70));
  console.log('✅ Server ready for connections\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM signal');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT signal');
  process.exit(0);
});
