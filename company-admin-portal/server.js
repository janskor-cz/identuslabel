/**
 * Company Admin Portal Server
 *
 * Standalone Express application for company DID and employee management.
 * Provides session-based multi-company administration interface with
 * integration to Hyperledger Identus multitenancy Cloud Agent (port 8200).
 */

const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');
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
const {
  COMPANIES,
  MULTITENANCY_CLOUD_AGENT_URL,
  getCompany,
  getAllCompanies,
  isValidCompany
} = require('./lib/companies');

// Employee API Key Management (for Enterprise Cloud Agent)
const EmployeeApiKeyManager = require('./lib/EmployeeApiKeyManager');
const EmployeeWalletManager = require('./lib/EmployeeWalletManager');
const ServiceConfigVCBuilder = require('./lib/ServiceConfigVCBuilder');
const ConnectionEventHandler = require('./lib/ConnectionEventHandler');
const SchemaManager = require('./lib/SchemaManager');
const EmployeePortalDatabase = require('./lib/EmployeePortalDatabase');
const DocumentRegistry = require('./lib/DocumentRegistry');
const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const ReEncryptionService = require('./lib/ReEncryptionService');

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

// Initialize soft-deleted connections storage
global.softDeletedConnections = loadSoftDeletedConnections();

// Initialize employee-connection mappings storage
global.employeeConnectionMappings = loadEmployeeMappings();

// Middleware
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

// ============================================================================
// Public Routes (no authentication required)
// ============================================================================

/**
 * GET / - Serve frontend
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    logo: company.logo
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

    // Get soft-deleted connections for this company
    const softDeleted = global.softDeletedConnections.get(req.company.id) || new Set();

    // Filter out CA connections (only show employee connections)
    // CA connections have labels containing "CA", "Certification Authority", or are InvitationGenerated state for CA invites
    // Also filter out soft-deleted connections
    const employeeConnections = connections.filter(conn => {
      const label = (conn.label || '').toLowerCase();
      const theirLabel = (conn.theirLabel || '').toLowerCase();

      // Exclude soft-deleted connections
      if (softDeleted.has(conn.connectionId)) {
        return false;
      }

      // Exclude connections with CA-related labels
      if (label.includes('ca ') || label.includes(' ca') ||
          label.includes('certification') || label.includes('authority') ||
          theirLabel.includes('certification') || theirLabel.includes('authority')) {
        return false;
      }

      // ✨ NEW: Exclude Enterprise Cloud Agent connections (auto-created during VC issuance)
      // Pattern: "TechCorp ↔ Name (email@domain.com)" or "TechCorp <-> Name"
      // These are connections between Employee Wallet (port 8300) and TechCorp (port 8200)
      if (label.includes('↔') || label.includes('<->') ||
          theirLabel.includes('↔') || theirLabel.includes('<->')) {
        console.log(`[FILTER] Excluding Enterprise wallet connection: ${label}`);
        return false;
      }

      // Exclude InvitationGenerated states (these are outgoing invites to CA)
      if (conn.state === 'InvitationGenerated') {
        return false;
      }

      return true;
    });

    // Filter and format connections
    const employees = employeeConnections.map(conn => ({
      connectionId: conn.connectionId,
      label: conn.label,
      state: conn.state,
      theirDid: conn.theirDid,
      myDid: conn.myDid,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt
    }));

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
    const { employeeName, role, department } = req.body;

    if (!employeeName) {
      return res.status(400).json({
        success: false,
        error: 'Employee name is required'
      });
    }

    // Create label with employee details
    const labelParts = [employeeName];
    if (role) labelParts.push(`(${role})`);
    if (department) labelParts.push(`- ${department}`);
    const label = labelParts.join(' ');

    // Create goal for invitation
    const goal = `Employee connection for ${employeeName} at ${req.company.displayName}`;

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

    console.log(`[EMPLOYEE] Created invitation for ${employeeName} (${req.company.name})`);

    // Fetch company's CompanyIdentity credential
    let finalInvitation = invitation.invitation;
    let hasCompanyCredential = false;

    try {
      // Get company's issued credentials
      const credentialsResult = await cloudAgentRequest(
        req.company.apiKey,
        '/issue-credentials/records'
      );

      const allRecords = credentialsResult.data.contents || [];

      // Filter for CompanyIdentity credentials that are received/sent
      const companyIdentityCredentials = allRecords.filter(r => {
        const isIssued = r.protocolState === 'CredentialReceived' || r.protocolState === 'CredentialSent';
        // Decode to check if it's a CompanyIdentity credential
        if (!isIssued) return false;

        try {
          const decoded = decodeCredential(r);
          return decoded && decoded.credentialType === 'CompanyIdentity';
        } catch {
          return false;
        }
      });

      if (companyIdentityCredentials.length > 0) {
        // Use the first (most recent) CompanyIdentity credential
        const companyCredential = decodeCredential(companyIdentityCredentials[0]);

        if (companyCredential && companyCredential.jwtCredential) {
          console.log(`[EMPLOYEE] Found CompanyIdentity credential for ${req.company.name}`);

          // Extract and decode the _oob parameter from invitation URL
          const invitationUrl = new URL(invitation.invitation.invitationUrl);
          const oobParam = invitationUrl.searchParams.get('_oob');

          if (!oobParam) {
            throw new Error('Invalid invitation URL: missing _oob parameter');
          }

          // Decode the base64 invitation
          const invitationJson = Buffer.from(oobParam, 'base64').toString('utf-8');
          const invitationObj = JSON.parse(invitationJson);

          // Embed Company Identity credential in invitation's requests_attach
          if (!invitationObj.body) {
            invitationObj.body = {};
          }
          invitationObj.body.goal_code = 'company-employee-verification';
          invitationObj.body.goal = `Connect as ${req.company.displayName} employee`;

          // Add company credential as attachment
          invitationObj.requests_attach = [{
            '@id': 'company-identity-credential',
            'mime-type': 'application/json',
            'data': {
              'json': {
                credential: companyCredential.jwtCredential,
                claims: companyCredential.claims,
                issuerDID: companyCredential.issuer,
                holderDID: companyCredential.subject,
                credentialType: companyCredential.credentialType,
                issuedDate: companyCredential.issuanceDate
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

          hasCompanyCredential = true;
          console.log(`✅ [EMPLOYEE] Company credential embedded in invitation for ${employeeName}`);
        }
      } else {
        console.warn(`⚠️ [EMPLOYEE] No CompanyIdentity credential found for ${req.company.name}`);
      }
    } catch (embedError) {
      console.error('⚠️ [EMPLOYEE] Failed to embed company credential:', embedError.message);
      // Continue with original invitation without credential
    }

    res.json({
      success: true,
      message: `Invitation created for ${employeeName}`,
      invitation: {
        connectionId: invitation.connectionId,
        invitationUrl: finalInvitation.invitationUrl,
        label: label,
        state: invitation.state,
        createdAt: invitation.createdAt,
        hasCompanyCredential
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
    const { email, name, department } = req.body; // ✨ REMOVED: apiKey (auto-generated)

    if (!email || !name || !department) { // ✨ REMOVED: apiKey from validation
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, name, department'
      });
    }

    // Validate department
    if (!['HR', 'IT', 'Security'].includes(department)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid department. Must be one of: HR, IT, Security'
      });
    }

    // Get department API key for issuing credentials
    const departmentApiKey = DEPARTMENT_API_KEYS[department];
    if (!departmentApiKey) {
      return res.status(500).json({
        success: false,
        error: `Department API key not configured for ${department}`
      });
    }

    // ✨ NEW: Build ServiceConfiguration VC claims (auto-creates employee wallet with PRISM DID)
    console.log(`\n📝 [SERVICE-CONFIG] Issuing ServiceConfiguration to ${name} (${email})`);
    const claims = await ServiceConfigVCBuilder.buildServiceConfigClaims({
      email,
      name,
      department,
      connectionId
    }); // ✨ REMOVED: apiKey parameter

    // ✨ NEW: Log employee wallet details (created during claims build)
    console.log(`\n🎉 [SERVICE-CONFIG] Employee wallet created:`);
    console.log(`   Wallet ID: ${claims.employeeWallet.walletId}`);
    console.log(`   Entity ID: ${claims.employeeWallet.entityId}`);
    console.log(`   PRISM DID: ${claims.employeeWallet.prismDid.substring(0, 60)}...`);
    console.log(`   API Key: ${claims.employeeWallet.apiKey.substring(0, 20)}... (stored in VC)\n`);

    // Build credential offer payload for Enterprise Cloud Agent
    const credentialOffer = ServiceConfigVCBuilder.buildCredentialOfferPayload(
      connectionId,
      claims
    );

    // Issue credential via Enterprise Cloud Agent
    const result = await enterpriseAgentRequest(
      departmentApiKey,
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

// Employee authentication configuration - uses Multitenancy Cloud Agent (port 8200)
// This connects to TechCorp's tenant wallet for employee authentication via DIDComm
const TECHCORP_CLOUD_AGENT_URL = process.env.TECHCORP_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const TECHCORP_API_KEY = process.env.TECHCORP_API_KEY || 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2';
const TECHCORP_DID = COMPANIES.techcorp.did; // Used for issuer validation

// TEMPORARY: Accept both Multitenancy Cloud Agent and Main Cloud Agent DIDs
// This allows existing credentials issued by Main Cloud Agent to work during transition
const ACCEPTED_ISSUER_DIDS = [
  TECHCORP_DID, // Multitenancy Cloud Agent TechCorp wallet
  'did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c' // Main Cloud Agent (backwards compatibility)
];

// Employee Role schema GUID (v1.1.0 with email field for authentication)
const EMPLOYEE_ROLE_SCHEMA_GUID = process.env.EMPLOYEE_ROLE_SCHEMA_GUID ||
  '6c39cc8e-b292-30aa-bbef-98ca2fdc6abe';

/**
 * Helper function to check CIS Training status
 * @param {string} prismDid - Employee's PRISM DID
 * @returns {Object} Training status with hasValidTraining and expiryDate
 */
async function checkCISTrainingStatus(prismDid) {
  try {
    // Query TechCorp Cloud Agent for credentials
    const response = await cloudAgentRequest(
      TECHCORP_API_KEY,
      '/issue-credentials/records'
    );

    const records = response.data.contents || [];

    // Look for CISTraining credential for this DID
    const trainingCredential = records.find(record => {
      if (record.protocolState !== 'CredentialSent') return false;

      try {
        const decoded = decodeCredential(record);
        return decoded &&
               decoded.credentialType === 'CISTraining' &&
               decoded.subject === prismDid;
      } catch (e) {
        return false;
      }
    });

    if (trainingCredential) {
      const decoded = decodeCredential(trainingCredential);
      const expiryDate = decoded.claims?.expiryDate;
      const hasValidTraining = expiryDate ? new Date(expiryDate) > new Date() : true;

      return {
        hasValidTraining,
        expiryDate: expiryDate || null,
        completionDate: decoded.claims?.completionDate || null
      };
    }

    return { hasValidTraining: false, expiryDate: null };
  } catch (error) {
    console.error('[EmployeeAuth] Error checking CIS training status:', error);
    return { hasValidTraining: false, expiryDate: null };
  }
}

/**
 * Middleware to require employee session
 * Validates session token and checks expiration
 */
function requireEmployeeSession(req, res, next) {
  const token = req.headers['x-session-token'];

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
 * POST /api/employee-portal/auth/initiate
 * Initiate employee authentication via EmployeeRole VC presentation
 */
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

    console.log(`[EmployeeAuth] Creating proof request:`);
    console.log(`   Connection ID: ${employee.techcorp_connection_id}`);
    console.log(`   Challenge: ${challenge.substring(0, 12)}...`);
    console.log(`   Domain: ${domain}`);

    // Create Present Proof request via DIDComm connection
    // ✅ SCHEMA-LESS PROOF REQUEST: Accepts ANY verifiable presentation
    // User requested: "I want to implement simpler workaround using schema-less proof requests (allowing any VP)"
    //
    // Note: Cloud Agent API requires 'proofs' field, but we use empty array to bypass schema validation
    // This allows manual credential selection in wallet without schema constraints
    const proofRequestPayload = {
      connectionId: employee.techcorp_connection_id,
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
          issuerDID = employeeRoleCred.issuer;
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
      authenticatedAt: Date.now(),
      lastActivity: Date.now()
    };

    // Store session
    employeeSessions.set(sessionToken, session);

    // Clean up pending auth
    pendingEmployeeAuths.delete(presentationId);

    console.log(`[EmployeeAuth] Session created successfully`);
    console.log(`   Token: ${sessionToken.substring(0, 20)}...`);

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
app.get('/api/employee-portal/profile', requireEmployeeSession, (req, res) => {
  const session = req.employeeSession;

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

    // Get TechCorp company info
    const techCorp = getCompany('techcorp');
    if (!techCorp) {
      throw new Error('TechCorp company not found');
    }

    // Generate certificate details
    const completionDate = new Date();
    const expiryDate = new Date(completionDate);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // Valid for 1 year

    const certificateNumber = `CIS-${Date.now()}-${session.employeeId}`;
    const trainingYear = completionDate.getFullYear().toString();

    // Get cached CIS Training schema GUID
    const schemaManager = new SchemaManager(techCorp.apiKey, MULTITENANCY_CLOUD_AGENT_URL);
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
      issuingDID: techCorp.did, // TechCorp's PRISM DID for signing the credential
      connectionId,
      schemaId: `${MULTITENANCY_CLOUD_AGENT_URL}/schema-registry/schemas/${schemaGuid}`,
      credentialFormat: 'JWT',
      claims,
      automaticIssuance: true, // Auto-approve after employee accepts
      awaitConfirmation: false
    };

    const result = await cloudAgentRequest(
      techCorp.apiKey,
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
    // Get TechCorp company info
    const techCorp = getCompany('techcorp');
    if (!techCorp) {
      throw new Error('TechCorp company not found');
    }

    // Query Cloud Agent for credential record status
    const result = await cloudAgentRequest(
      techCorp.apiKey,
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
 * - classificationLevel: UNCLASSIFIED | CONFIDENTIAL | SECRET | TOP_SECRET (required)
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
    const validClassifications = ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'];
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
      contentEncryptionKey: 'mock-abe-encrypted-key',
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
 * - classificationLevel: UNCLASSIFIED | CONFIDENTIAL | SECRET | TOP_SECRET (required)
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
    const validClassifications = ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'];
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

    let iagonStorage = null;
    if (iagonClient.isConfigured()) {
      try {
        iagonStorage = await iagonClient.uploadFile(
          req.file.buffer,
          req.file.originalname,
          { classificationLevel }
        );
        console.log(`[DocumentUpload] ✅ File uploaded to Iagon: ${iagonStorage.filename}`);
        console.log(`[DocumentUpload]    File ID: ${iagonStorage.fileId}`);
        console.log(`[DocumentUpload]    Download URL: ${iagonStorage.iagonUrl}`);
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
      const didResult = await documentManager.createDocumentDIDWithServiceEndpoint(
        session.department,
        {
          title,
          description,
          documentType,
          classificationLevel,
          createdBy: session.email,
          createdByDID: session.prismDid
        },
        {
          fileId: iagonStorage.fileId,
          downloadUrl: iagonStorage.iagonUrl
        }
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
    let vcIssuanceWarning = null;

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
          createdByDID: session.prismDid
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
      contentEncryptionKey: iagonStorage?.encryptionInfo?.key || 'no-encryption',
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
  console.log(`   Clearance: ${session.clearanceLevel || 'NONE (UNCLASSIFIED only)'}`);

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
      'UNCLASSIFIED': 1,
      'CONFIDENTIAL': 2,
      'SECRET': 3,
      'TOP_SECRET': 4
    };

    const documentLevel = clearanceLevels[document.classificationLevel] || 1;
    const employeeLevel = session.clearanceLevel ? (clearanceLevels[session.clearanceLevel] || 1) : 1;

    if (employeeLevel < documentLevel) {
      console.log(`[DocumentDownload] ❌ Insufficient clearance (has: ${session.clearanceLevel || 'NONE'}, needs: ${document.classificationLevel})`);
      return res.status(403).json({
        success: false,
        error: 'InsufficientClearance',
        message: `This document requires ${document.classificationLevel} clearance. You have ${session.clearanceLevel || 'no clearance (UNCLASSIFIED only)'}.`
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
 * GET /api/documents/discover
 * Discover documents by issuer DID (from employee's EmployeeRole VC)
 *
 * Query Parameters:
 * - issuerDID: Company DID from employee's EmployeeRole credential
 *
 * Returns: Array of discoverable documents (filtered by clearance level from session)
 */
app.get('/api/documents/discover', async (req, res) => {
  try {
    const { issuerDID } = req.query;

    if (!issuerDID) {
      return res.status(400).json({
        success: false,
        error: 'BadRequest',
        message: 'issuerDID query parameter is required'
      });
    }

    // Extract clearance level from employee session (if authenticated)
    // If no session or no clearance, defaults to null (UNCLASSIFIED access only)
    const session = employeeSessions.get(req.query.sessionId) || employeeSessions.get(req.headers['x-session-id']);
    const clearanceLevel = session?.clearanceLevel || null;

    console.log(`[DocumentRegistry] Document discovery request for issuerDID: ${issuerDID}`);
    console.log(`[DocumentRegistry] Employee clearance level: ${clearanceLevel || 'NONE (UNCLASSIFIED only)'}`);

    // Query document registry by issuer DID with clearance-based filtering
    const documents = await DocumentRegistry.queryByIssuerDID(issuerDID, clearanceLevel);

    console.log(`[DocumentRegistry] Found ${documents.length} documents for ${issuerDID}`);

    res.json({
      success: true,
      documents,
      count: documents.length,
      issuerDID,
      clearanceLevel: clearanceLevel || 'UNCLASSIFIED'
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
 * - classificationLevel: UNCLASSIFIED|CONFIDENTIAL|SECRET|TOP_SECRET
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

    // Register document in registry
    const result = await DocumentRegistry.registerDocument({
      documentDID,
      title,
      classificationLevel,
      releasableTo,
      contentEncryptionKey,
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
 * - classificationLevel: 1-4 (UNCLASSIFIED to TOP_SECRET)
 * - classificationLabel: UNCLASSIFIED|CONFIDENTIAL|SECRET|TOP_SECRET
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
    const session = employeeSessions.get(sessionToken);

    if (!session) {
      console.log('[EphemeralAccess] DENIED: No valid session');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'No valid session. Please log in first.'
      });
    }

    // Use clearance from session (set during VP verification at login)
    // Default to UNCLASSIFIED if no clearance verification done yet
    const sessionClearanceLabel = session.clearanceLevel || 'UNCLASSIFIED';
    const clearanceLevelNumeric = ReEncryptionService.getLevelNumber(sessionClearanceLabel);

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

    res.json({
      success: true,
      document
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
        console.log('[DocumentDownload] No encryption info found in registry (UNCLASSIFIED document or legacy)');
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
 * Initiate Security Clearance VC verification via DIDComm
 *
 * ARCHITECTURE: Uses DIRECT DIDComm connection from TechCorp (Cloud Agent 8200)
 * to Alice's personal wallet. No CA intermediary needed.
 *
 * Flow: Employee Portal → Company Admin Portal → Cloud Agent 8200 → Alice Personal Wallet
 */
app.post('/api/employee-portal/clearance/initiate', requireEmployeeSession, async (req, res) => {
  try {
    const session = req.employeeSession;
    const token = req.headers['x-session-token'];

    console.log('\n' + '='.repeat(70));
    console.log('[ClearanceVerification] Initiating DIRECT DIDComm Security Clearance verification');
    console.log(`   Employee: ${session.email} (${session.employeeId})`);
    console.log(`   PRISM DID: ${session.prismDid}`);
    console.log(`   Issuer DID: ${session.issuerDID}`);
    console.log('='.repeat(70));

    // Find company configuration by matching issuerDID against company DIDs
    const company = getAllCompanies().find(c => c.did === session.issuerDID);
    if (!company) {
      console.error(`[ClearanceVerification] No company found with DID: ${session.issuerDID}`);
      return res.status(400).json({
        success: false,
        error: 'CompanyNotFound',
        message: `No company found for issuer DID ${session.issuerDID}`
      });
    }
    console.log(`   Company: ${company.displayName} (${company.id})`);
    console.log('='.repeat(70));

    // Find employee's connection to TechCorp (their personal wallet connection)
    // This connection was established during employee onboarding
    const MULTITENANCY_URL = process.env.MULTITENANCY_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';

    console.log(`[ClearanceVerification] Looking for employee connection in Cloud Agent 8200`);
    console.log(`   Looking for label containing: ${session.email.split('@')[0]}`);

    // Get all connections from TechCorp's Cloud Agent
    const connectionsResponse = await fetch(`${MULTITENANCY_URL}/connections`, {
      method: 'GET',
      headers: {
        'apikey': company.apiKey
      }
    });

    if (!connectionsResponse.ok) {
      console.error('[ClearanceVerification] Failed to fetch connections');
      return res.status(500).json({
        success: false,
        error: 'ConnectionFetchError',
        message: 'Failed to fetch company connections'
      });
    }

    const connectionsData = await connectionsResponse.json();
    const connections = connectionsData.contents || [];

    // Find established connection to this employee's personal wallet
    // Connection label format: "Alice Cooper (Engineer) - Engineering" or similar
    const employeeNamePart = session.email.split('@')[0].replace(/\./g, ' ').toLowerCase();

    let employeeConnection = connections.find(conn => {
      if (conn.state !== 'ConnectionResponseSent' && conn.state !== 'ConnectionResponseReceived') {
        return false;
      }
      if (!conn.label) return false;
      return conn.label.toLowerCase().includes(employeeNamePart) ||
             conn.label.toLowerCase().includes(session.email.toLowerCase());
    });

    // Also check the stored employee-connection mappings
    if (!employeeConnection) {
      const mappingKey = session.email.split('@')[0];
      const mapping = employeeConnectionMappings[mappingKey];
      if (mapping && mapping.connectionId) {
        employeeConnection = connections.find(conn => conn.connectionId === mapping.connectionId);
        console.log(`[ClearanceVerification] Found connection from mapping: ${mapping.connectionId}`);
      }
    }

    if (!employeeConnection) {
      console.log(`[ClearanceVerification] No direct connection found for employee`);
      return res.status(400).json({
        success: false,
        error: 'NoDirectConnection',
        message: 'No DIDComm connection found to your personal wallet. Please ensure your personal wallet is connected to TechCorp.',
        instructions: [
          '1. Open Alice Wallet (https://identuslabel.cz/alice)',
          '2. Go to Connections',
          '3. Accept the company invitation or create a new connection',
          '4. Then return here and try again'
        ]
      });
    }

    console.log(`[ClearanceVerification] Found employee connection:`);
    console.log(`   Connection ID: ${employeeConnection.connectionId}`);
    console.log(`   Label: ${employeeConnection.label}`);
    console.log(`   State: ${employeeConnection.state}`);

    // Create proof request for Security Clearance VC via TechCorp's Cloud Agent
    // This sends a DIDComm proof request directly to Alice's personal wallet
    const proofRequestPayload = {
      connectionId: employeeConnection.connectionId,
      proofs: [],  // JWT format - request any credential
      options: {
        challenge: require('crypto').randomBytes(16).toString('hex'),
        domain: 'identuslabel.cz'
      }
    };

    console.log(`[ClearanceVerification] Creating proof request via Cloud Agent 8200`);
    console.log(`   Payload:`, JSON.stringify(proofRequestPayload, null, 2));

    const proofResponse = await fetch(`${MULTITENANCY_URL}/present-proof/presentations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': company.apiKey
      },
      body: JSON.stringify(proofRequestPayload)
    });

    if (!proofResponse.ok) {
      const errorText = await proofResponse.text();
      console.error(`[ClearanceVerification] Proof request failed: ${proofResponse.status} - ${errorText}`);
      return res.status(500).json({
        success: false,
        error: 'ProofRequestFailed',
        message: `Failed to create proof request: ${proofResponse.status}`
      });
    }

    const proofResult = await proofResponse.json();
    console.log(`[ClearanceVerification] Proof request created:`, JSON.stringify(proofResult, null, 2));

    // Store verification for polling
    const verificationId = proofResult.presentationId || proofResult.id;

    pendingClearanceVerifications.set(verificationId, {
      verificationId,
      presentationId: verificationId,
      connectionId: employeeConnection.connectionId,
      employeeId: session.employeeId,
      email: session.email,
      prismDid: session.prismDid,
      company: session.company,
      companyApiKey: company.apiKey,
      sessionToken: token,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes expiry
    });

    console.log(`[ClearanceVerification] DIDComm proof request sent DIRECTLY to personal wallet!`);
    console.log(`   Presentation ID: ${verificationId}`);
    console.log(`   Connection: ${employeeConnection.connectionId}`);
    console.log('='.repeat(70));

    // Return verification details for the UI to poll status
    res.json({
      success: true,
      verificationId,
      presentationId: verificationId,
      message: 'Security Clearance proof request sent to your Alice Wallet via DIDComm. Please check your wallet to approve the request.',
      instructions: [
        '1. Open Alice Wallet',
        '2. You should see a proof request from TechCorp',
        '3. Approve the request to share your Security Clearance credential',
        '4. Your clearance will be verified automatically'
      ],
      aliceWalletUrl: 'https://identuslabel.cz/alice/',
      expiresIn: 300 // 5 minutes in seconds
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

  // Poll Cloud Agent 8200 directly for presentation status
  try {
    const MULTITENANCY_URL = process.env.MULTITENANCY_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
    const presentationResponse = await fetch(
      `${MULTITENANCY_URL}/present-proof/presentations/${verification.presentationId}`,
      {
        method: 'GET',
        headers: {
          'apikey': verification.companyApiKey
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

                      // Check if this is a SecurityClearance VC
                      if (vcPayload.vc && vcPayload.vc.credentialSubject) {
                        const subject = vcPayload.vc.credentialSubject;
                        if (subject.clearanceLevel) {
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
    const validLevels = ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'];
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
    requiredClearance: 'SECRET',
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
    requiredClearance: 'TOP_SECRET',
    requiredRole: 'IT'
  }
};

// Clearance level hierarchy for comparison
const CLEARANCE_HIERARCHY = {
  'UNCLASSIFIED': 0,
  'CONFIDENTIAL': 1,
  'SECRET': 2,
  'TOP_SECRET': 3
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
// Error Handling
// ============================================================================

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
    console.log(`   📊 Classification breakdown: UNCLASSIFIED=${stats.byClassification.UNCLASSIFIED}, CONFIDENTIAL=${stats.byClassification.CONFIDENTIAL}, SECRET=${stats.byClassification.SECRET}, TOP_SECRET=${stats.byClassification.TOP_SECRET}`);
  } catch (error) {
    console.error(`   ❌ DocumentRegistry initialization failed:`, error.message);
  }

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
