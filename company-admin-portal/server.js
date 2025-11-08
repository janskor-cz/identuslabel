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
const {
  COMPANIES,
  MULTITENANCY_CLOUD_AGENT_URL,
  getCompany,
  getAllCompanies,
  isValidCompany
} = require('./lib/companies');

const app = express();
const PORT = process.env.PORT || 3010;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: 'company-admin-portal-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
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
 * Helper function to make Cloud Agent API calls
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

    // Filter and format connections
    const employees = connections.map(conn => ({
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

    res.json({
      success: true,
      message: `Invitation created for ${employeeName}`,
      invitation: {
        connectionId: invitation.connectionId,
        invitationUrl: invitation.invitation.invitationUrl,
        label: label,
        state: invitation.state,
        createdAt: invitation.createdAt
      }
    });
  } catch (error) {
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

    await cloudAgentRequest(
      req.company.apiKey,
      `/connections/${id}`,
      {
        method: 'DELETE'
      }
    );

    console.log(`[EMPLOYEE] Deleted connection ${id} (${req.company.name})`);

    res.json({
      success: true,
      message: 'Employee connection removed'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/company/credentials - List issued credentials
 */
app.get('/api/company/credentials', requireCompany, async (req, res) => {
  try {
    const result = await cloudAgentRequest(
      req.company.apiKey,
      '/issue-credentials/records'
    );

    const credentials = result.data.contents || [];

    res.json({
      success: true,
      credentials,
      totalCount: credentials.length
    });
  } catch (error) {
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

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🏢 Company Admin Portal - Server Started');
  console.log('='.repeat(70));
  console.log(`📍 Local:            http://localhost:${PORT}`);
  console.log(`🌐 Reverse Proxy:    https://identuslabel.cz/company-admin`);
  console.log(`☁️  Cloud Agent:      ${MULTITENANCY_CLOUD_AGENT_URL}`);
  console.log(`🏢 Companies:        ${Object.keys(COMPANIES).length} registered`);
  console.log(`   - ${Object.values(COMPANIES).map(c => c.displayName).join(', ')}`);
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
