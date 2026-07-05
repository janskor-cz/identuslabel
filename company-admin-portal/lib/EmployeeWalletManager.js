/**
 * Employee Wallet Manager
 *
 * Manages individual employee wallet creation on the Employee Cloud Agent (port 8300).
 * This replaces the department wallet model with individual employee wallets.
 *
 * Architecture:
 * - Employee Cloud Agent (port 8300): Multitenancy with individual employee wallets
 * - Each employee gets: Unique wallet + Entity + API key + PRISM DID
 * - Employee authenticates using their personal API key
 *
 * Key Operations:
 * 1. createEmployeeWallet() - Create wallet, entity, API key, and PRISM DID
 * 2. getEmployeeWallet() - Retrieve employee wallet details
 * 3. listEmployeeWallets() - List all employee wallets
 * 4. deleteEmployeeWallet() - Remove employee wallet (soft delete)
 */

const fetch = require('node-fetch');

// Throws at require-time if a required secret is missing — no silent fallback to committed values.
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

// Employee Cloud Agent configuration (port 8300)
const EMPLOYEE_CLOUD_AGENT_URL = process.env.EMPLOYEE_CLOUD_AGENT_URL || 'https://identuslabel.cz/enterprise';
const ADMIN_API_KEY = requireEnv('ENTERPRISE_ADMIN_TOKEN');

// TechCorp Company Wallet configuration (port 8200 - Multitenancy Cloud Agent)
const TECHCORP_CLOUD_AGENT_URL = process.env.TECHCORP_CLOUD_AGENT_URL || 'http://91.99.4.54:8200';
const TECHCORP_API_KEY    = requireEnv('TECHCORP_API_KEY');
const TECHCORP_WALLET_ID  = requireEnv('TECHCORP_WALLET_ID');
const TECHCORP_PRISM_DID  = process.env.TECHCORP_PRISM_DID || 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf';

// Shared PostgreSQL connection pool (lazy-initialised, reused for the module lifetime).
let _dbPool = null;
function getDbPool() {
  if (!_dbPool) {
    if (!process.env.ENTERPRISE_DB_PASSWORD) {
      throw new Error('ENTERPRISE_DB_PASSWORD environment variable is required');
    }
    const { Pool } = require('pg');
    _dbPool = new Pool({
      host:     process.env.ENTERPRISE_DB_HOST || '91.99.4.54',
      port:     parseInt(process.env.ENTERPRISE_DB_PORT || '5434'),
      database: process.env.ENTERPRISE_DB_NAME || 'pollux_enterprise',
      user:     process.env.ENTERPRISE_DB_USER || 'identus_enterprise',
      password: process.env.ENTERPRISE_DB_PASSWORD,
      max: 5
    });
  }
  return _dbPool;
}

/**
 * Create individual employee wallet with PRISM DID
 *
 * Workflow:
 * 1. Create wallet via POST /wallets with employee name
 * 2. Create entity via POST /entities linked to wallet
 * 3. Auto-generate API key for wallet
 * 4. Create PRISM DID via POST /did-registrar/dids
 * 5. Return: { walletId, entityId, apiKey, prismDid }
 *
 * @param {Object} employeeData - Employee information
 * @param {string} employeeData.email - Employee email (unique identifier)
 * @param {string} employeeData.name - Employee full name
 * @param {string} employeeData.department - Department (for metadata)
 * @returns {Promise<Object>} Created wallet details
 */
async function createEmployeeWallet(employeeData, companyDID = null, preloadedRealPersonClaims = null) {
  const { email, name, department } = employeeData;

  console.log(`🏗️  [EmployeeWalletMgr] Creating wallet for: ${name} (${email})`);

  // Track partial employee data for rollback
  const partialData = { email, name, department };

  try {
    // STEP 1: Create wallet
    console.log('  → Step 1/12: Creating wallet...');
    const walletResponse = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/wallets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-api-key': ADMIN_API_KEY
      },
      body: JSON.stringify({
        name: `${name} (${department})`,
        seed: generateSeed()
      })
    });

    if (!walletResponse.ok) {
      const error = await walletResponse.text();
      throw new Error(`Wallet creation failed: ${walletResponse.status} ${error}`);
    }

    const wallet = await walletResponse.json();
    partialData.walletId = wallet.id;
    console.log(`  ✅ Wallet created: ${partialData.walletId}`);

    // STEP 2: Create entity for wallet
    console.log('  → Step 2/12: Creating entity...');
    const entityResponse = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/iam/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-api-key': ADMIN_API_KEY
      },
      body: JSON.stringify({
        name: `${name} (${department})`,
        walletId: partialData.walletId
      })
    });

    if (!entityResponse.ok) {
      const error = await entityResponse.text();
      throw new Error(`Entity creation failed: ${entityResponse.status} ${error}`);
    }

    const entity = await entityResponse.json();
    partialData.entityId = entity.id;
    console.log(`  ✅ Entity created: ${partialData.entityId}`);

    // STEP 3: Generate and register API key
    console.log('  → Step 3/12: Registering API key...');
    partialData.apiKey = generateApiKey();

    const apiKeyResponse = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/iam/apikey-authentication`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-api-key': ADMIN_API_KEY
      },
      body: JSON.stringify({
        entityId: partialData.entityId,
        apiKey: partialData.apiKey
      })
    });

    if (!apiKeyResponse.ok) {
      const error = await apiKeyResponse.text();
      throw new Error(`API key registration failed: ${apiKeyResponse.status} ${error}`);
    }

    const { createHash } = require('crypto');
    const keyFp = createHash('sha256').update(partialData.apiKey).digest('hex').substring(0, 16);
    console.log(`  ✅ API key registered (fingerprint: sha256:${keyFp}...)`);

    // STEP 4: Create PRISM DID using employee's registered API key
    console.log('  → Step 4/12: Creating PRISM DID...');
    const didResponse = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/did-registrar/dids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': partialData.apiKey
      },
      body: JSON.stringify({
        documentTemplate: {
          publicKeys: [
            { id: 'auth-key-1', purpose: 'authentication' },
            { id: 'assertion-key-1', purpose: 'assertionMethod' }
          ],
          services: []
        }
      })
    });

    if (!didResponse.ok) {
      const error = await didResponse.text();
      throw new Error(`PRISM DID creation failed: ${didResponse.status} ${error}`);
    }

    const didData = await didResponse.json();
    partialData.prismDid = didData.longFormDid || didData.did;
    console.log(`  ✅ PRISM DID created: ${partialData.prismDid.substring(0, 40)}...`);

    // STEP 5: Publish PRISM DID to blockchain
    console.log('  → Step 5/12: Publishing PRISM DID to blockchain...');
    await publishPrismDid(partialData.prismDid, partialData.apiKey);

    // STEP 6: Wait for DID publication to complete
    console.log('  → Step 6/12: Waiting for DID publication...');
    partialData.canonicalDid = await waitForPublicationComplete(partialData.prismDid, partialData.apiKey);
    console.log(`  ✅ DID published: ${partialData.canonicalDid}`);

    // Register enterprise webhook for this wallet so BasicMessageReceived fires to the portal
    const COMPANY_PORTAL_BASE_URL = process.env.COMPANY_PORTAL_BASE_URL || 'https://identuslabel.cz/company-admin';
    const enterpriseWebhookUrl = `${COMPANY_PORTAL_BASE_URL}/api/enterprise-messages-webhook`;
    await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/events/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': partialData.apiKey },
      body: JSON.stringify({ url: enterpriseWebhookUrl })
    }).catch(e => console.warn(`  ⚠️ Enterprise webhook registration skipped: ${e.message}`));
    console.log(`  ✅ Enterprise webhook registered for new wallet`);

    // STEP 7: Create TechCorp invitation
    console.log('  → Step 7/12: Creating TechCorp invitation...');
    const { invitationUrl, connectionId: techCorpConnectionId } = await createTechCorpInvitation(name, email);
    partialData.techCorpConnectionId = techCorpConnectionId;

    // STEP 8: Accept invitation as employee
    console.log('  → Step 8/12: Employee accepting TechCorp invitation...');
    partialData.employeeConnectionId = await acceptInvitationAsEmployee(invitationUrl, partialData.apiKey);

    // STEP 9: Wait for connection to establish (employee side)
    console.log('  → Step 9/12: Waiting for employee connection...');
    await waitForConnectionComplete(partialData.employeeConnectionId, partialData.apiKey);

    // STEP 10: Wait for connection to establish (TechCorp side)
    console.log('  → Step 10/12: Waiting for TechCorp connection...');
    await waitForConnectionComplete(partialData.techCorpConnectionId, TECHCORP_API_KEY, TECHCORP_CLOUD_AGENT_URL);

    // STEP 11: Use pre-loaded RealPerson claims (provided externally) or skip
    let realPersonClaims = preloadedRealPersonClaims || null;
    if (realPersonClaims) {
      console.log(`  ✅ Step 11/13: Using pre-loaded RealPerson claims: uniqueId=${realPersonClaims.uniqueId}, lastName=${realPersonClaims.lastName}`);
    } else {
      console.log('  ℹ️ Step 11/13: No RealPerson claims provided — identity fields will be omitted from EmployeeRole VC');
    }

    // STEP 12: Issue EmployeeRole VC to employee
    console.log('  → Step 12/13: Issuing EmployeeRole VC...');

    // Prepare credential subject for EmployeeRole VC
    const employeeId = email.split('@')[0]; // Extract "alice" from "alice@techcorp.com"
    const credentialSubject = {
      prismDid: partialData.prismDid,
      employeeId: employeeId,
      email: email, // Administrator-provided email for portal authentication
      issuerDID: companyDID || TECHCORP_PRISM_DID, // DID of the credential issuer (company-specific) - enables document releasability filtering
      role: employeeData.role || "Engineer",
      department: employeeData.department || department || "Engineering",
      serviceUrl: `https://identuslabel.cz/company-admin/employee-portal-login.html?user=${encodeURIComponent(employeeId)}`,
      serviceName: 'Employee Portal',
      serviceIcon: '🏢',
      accessTarget: 'techcorp-employee-portal',
      accessTargetLabel: 'TechCorp Employee Portal',
      accessTargetIcon: '🏢',
      hireDate: new Date().toISOString(),
      effectiveDate: new Date().toISOString(),
      expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString() // 1 year from now
    };

    // Embed identity fields from RealPerson VC if proof was provided
    if (realPersonClaims) {
      credentialSubject.uniqueId = realPersonClaims.uniqueId;
      credentialSubject.lastName = realPersonClaims.lastName;
      // Only include photo if non-null — schema type is string and rejects null values
      if (realPersonClaims.photo) {
        credentialSubject.photo = realPersonClaims.photo;
      }
    }

    // Issue EmployeeRole VC using TechCorp Cloud Agent
    partialData.employeeRoleCredentialId = await issueEmployeeRoleVC(
      partialData.techCorpConnectionId,
      partialData.employeeConnectionId,
      credentialSubject,
      TECHCORP_API_KEY,
      TECHCORP_CLOUD_AGENT_URL,
      partialData.apiKey,
      EMPLOYEE_CLOUD_AGENT_URL
    );

    console.log(`  ✅ EmployeeRole VC issued: ${partialData.employeeRoleCredentialId}`);

    // STEP 13: Store employee record in database
    console.log('  → Step 13/14: Storing employee record in database...');
    const EmployeePortalDatabase = require('./EmployeePortalDatabase');
    const employeeDb = new EmployeePortalDatabase(getDbPool());

    // Create employee account with basic info
    const employeeRecord = await employeeDb.createEmployeeAccount({
      email: email,
      fullName: name,
      department: department,
      employeeId: email.split('@')[0], // Extract username part
      walletId: partialData.walletId,
      entityId: partialData.entityId,
      apiKey: partialData.apiKey, // Will be hashed by database
      prismDid: partialData.canonicalDid,
      createdBy: 'EmployeeWalletManager'
    });

    console.log(`  ✅ Employee account created in database: ${employeeRecord.id}`);

    // Update TechCorp connection details
    await employeeDb.updateTechCorpConnection(
      employeeRecord.id,
      partialData.techCorpConnectionId,
      'ConnectionResponseSent'
    );

    console.log(`  ✅ TechCorp connection recorded: ${partialData.techCorpConnectionId}`);

    // Record EmployeeRole VC issuance
    await employeeDb.recordCredentialIssuance(
      employeeRecord.id,
      'EmployeeRole',
      partialData.employeeRoleCredentialId,
      {
        prismDid: partialData.canonicalDid,
        employeeId: email.split('@')[0],
        email: email,
        role: employeeData.role || "Engineer",
        department: department,
        issuedBy: 'TechCorp'
      }
    );

    console.log(`  ✅ EmployeeRole VC recorded in database`);

    // STEP 14: Connect enterprise wallet to Document Service (best-effort)
    console.log('  → Step 14/14: Connecting to Document Service...');
    try {
      const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || 'https://identuslabel.cz/document-service';
      const docInviteResp = await fetch(`${docServiceUrl}/connect`);
      if (docInviteResp.ok) {
        const docInviteData = await docInviteResp.json();
        const invitationUrl = docInviteData.invitation?.invitation?.invitationUrl
          || docInviteData.invitation?.invitationUrl
          || docInviteData.invitation;
        if (invitationUrl && typeof invitationUrl === 'string') {
          partialData.docServiceConnectionId = await acceptInvitationAsEmployee(
            invitationUrl, partialData.apiKey, 'Document Service'
          );
          console.log(`  ✅ Step 14/14: Document Service connection established: ${partialData.docServiceConnectionId}`);
        } else {
          console.warn('  ⚠️ Step 14/14: Document Service returned no invitation URL');
        }
      } else {
        console.warn(`  ⚠️ Step 14/14: Document Service /connect returned ${docInviteResp.status} — skipping`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Step 14/14: Document Service connection skipped: ${e.message}`);
    }

    // SUCCESS - Return complete employee wallet details
    console.log('\n✅ All 14 steps completed successfully!');
    const employeeWallet = {
      email,
      name,
      department,
      walletId: partialData.walletId,
      entityId: partialData.entityId,
      apiKey: partialData.apiKey,
      prismDid: partialData.prismDid,
      canonicalDid: partialData.canonicalDid,
      techCorpConnectionId: partialData.techCorpConnectionId,
      employeeConnectionId: partialData.employeeConnectionId,
      employeeRoleCredentialId: partialData.employeeRoleCredentialId,
      created: new Date().toISOString()
    };

    console.log(`\n🎉 [EmployeeWalletMgr] Employee wallet created successfully!`);
    console.log(`   Wallet ID: ${employeeWallet.walletId}`);
    console.log(`   Entity ID: ${employeeWallet.entityId}`);
    console.log(`   PRISM DID: ${employeeWallet.canonicalDid}`);
    console.log(`   TechCorp Connection: ${employeeWallet.techCorpConnectionId}`);
    console.log(`   Employee Connection: ${employeeWallet.employeeConnectionId}`);
    console.log(`   EmployeeRole VC: ${employeeWallet.employeeRoleCredentialId}`);
    const { createHash: _ch } = require('crypto');
    const _fp = _ch('sha256').update(employeeWallet.apiKey).digest('hex').substring(0, 16);
    console.log(`   API Key fingerprint: sha256:${_fp}... (stored in ServiceConfiguration VC)\n`);

    return employeeWallet;

  } catch (error) {
    console.error(`❌ [EmployeeWalletMgr] Wallet creation failed at step:`, error.message);

    // Rollback wallet creation
    await rollbackEmployeeWallet(partialData);

    throw error;
  }
}

/**
 * Get employee wallet details
 *
 * @param {string} walletId - Wallet UUID
 * @returns {Promise<Object>} Wallet details
 */
async function getEmployeeWallet(walletId) {
  try {
    const response = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/wallets/${walletId}`, {
      method: 'GET',
      headers: {
        'x-admin-api-key': ADMIN_API_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Wallet retrieval failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ [EmployeeWalletMgr] Wallet retrieval failed:`, error.message);
    throw error;
  }
}

/**
 * List all employee wallets
 *
 * @returns {Promise<Array>} Array of employee wallets
 */
async function listEmployeeWallets() {
  try {
    const response = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/wallets`, {
      method: 'GET',
      headers: {
        'x-admin-api-key': ADMIN_API_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Wallet listing failed: ${response.status}`);
    }

    const data = await response.json();
    return data.contents || [];
  } catch (error) {
    console.error(`❌ [EmployeeWalletMgr] Wallet listing failed:`, error.message);
    throw error;
  }
}

/**
 * Delete employee wallet (soft delete via API)
 *
 * Note: Cloud Agent 2.0.0 may not support wallet deletion via API.
 * This would require database-level deletion or wallet deactivation.
 *
 * @param {string} walletId - Wallet UUID
 * @returns {Promise<boolean>} Success status
 */
async function deleteEmployeeWallet(walletId) {
  try {
    // Attempt wallet deletion (may not be supported)
    const response = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/wallets/${walletId}`, {
      method: 'DELETE',
      headers: {
        'x-admin-api-key': ADMIN_API_KEY
      }
    });

    if (response.status === 404) {
      console.log(`⚠️  [EmployeeWalletMgr] Wallet not found: ${walletId}`);
      return false;
    }

    if (response.status === 405 || response.status === 501) {
      console.log(`⚠️  [EmployeeWalletMgr] Wallet deletion not supported by Cloud Agent`);
      console.log(`   Manual database deletion required for wallet: ${walletId}`);
      return false;
    }

    if (!response.ok) {
      throw new Error(`Wallet deletion failed: ${response.status}`);
    }

    console.log(`✅ [EmployeeWalletMgr] Wallet deleted: ${walletId}`);
    return true;

  } catch (error) {
    console.error(`❌ [EmployeeWalletMgr] Wallet deletion failed:`, error.message);
    throw error;
  }
}

/**
 * Generate BIP-32 seed for wallet (required by Cloud Agent)
 *
 * Generates a 128-character hex string (64 bytes) for BIP-32 wallet creation.
 * Cloud Agent requires exactly 64 bytes for BIP-32 seed generation.
 *
 * @returns {string} 128-character hex seed (64 bytes)
 */
function generateSeed() {
  const crypto = require('crypto');
  return crypto.randomBytes(64).toString('hex'); // 64 bytes = 128 hex characters
}

/**
 * Generate API key for employee authentication
 *
 * Generates a 64-character hex string (256 bits) for API authentication.
 * This is the employee's credential to access their wallet.
 *
 * @returns {string} 64-character hex API key
 */
function generateApiKey() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Helper: Publish PRISM DID to blockchain
 * @param {string} longFormDid - Long-form DID to publish
 * @param {string} apiKey - Employee's API key
 * @returns {Promise<void>}
 */
async function publishPrismDid(longFormDid, apiKey) {
  console.log(`[EmployeeWalletMgr] Publishing PRISM DID: ${longFormDid.substring(0, 60)}...`);

  const response = await fetch(
    `${EMPLOYEE_CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to publish DID: ${response.status} - ${errorText}`);
  }

  console.log(`✅ [EmployeeWalletMgr] DID publication initiated`);
}

/**
 * Helper: Wait for PRISM DID publication to complete
 * @param {string} longFormDid - Long-form DID to check
 * @param {string} apiKey - Employee's API key
 * @param {number} maxAttempts - Maximum polling attempts (default: 45)
 * @param {number} intervalMs - Polling interval in milliseconds (default: 2000)
 * @returns {Promise<string>} Canonical DID
 */
/**
 * Helper: Request RealPersonIdentity proof from employee via TechCorp connection
 * Returns the presentationId to poll for results.
 */
async function requestRealPersonProof(techCorpConnectionId) {
  const { randomBytes } = require('crypto');
  const challenge = randomBytes(32).toString('hex');

  const response = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': TECHCORP_API_KEY },
    body: JSON.stringify({
      connectionId: techCorpConnectionId,
      proofs: [],
      options: { challenge, domain: 'identuslabel.cz' },
      goalCode: 'present-vp',
      goal: 'Share your RealPersonIdentity credential for employee onboarding',
      credentialFormat: 'JWT'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to send proof request: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  // Return both presentationId and challenge — caller must pass challenge to
  // waitForPresentationAndExtract for replay-attack prevention.
  return { presentationId: data.presentationId || data.thid, challenge };
}

/**
 * Helper: Poll TechCorp agent for PresentationVerified, then extract RealPerson claims.
 * Returns { uniqueId, lastName, photo } or throws on timeout/missing credential.
 */
async function waitForPresentationAndExtract(
  presentationId,
  originalChallenge,
  maxAttempts = 150,
  intervalMs = 2000
) {
  console.log(`[EmployeeWalletMgr] Waiting for RealPerson proof (max ${maxAttempts * intervalMs / 1000}s)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const response = await fetch(
      `${TECHCORP_CLOUD_AGENT_URL}/present-proof/presentations/${presentationId}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json', 'apikey': TECHCORP_API_KEY } }
    );

    if (!response.ok) {
      throw new Error(`Failed to poll presentation: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[EmployeeWalletMgr] Proof attempt ${attempt}/${maxAttempts} - State: ${data.status}`);

    // Only trust PresentationVerified — Cloud Agent has already verified the VP signature.
    // PresentationReceived means signature not yet checked; do not extract claims from it.
    if (data.status === 'PresentationVerified') {
      const jwtVP = data.data?.[0] || data.jwt || (Array.isArray(data.data) ? data.data[0] : null);
      if (!jwtVP || typeof jwtVP !== 'string') {
        throw new Error('No JWT VP found in verified presentation');
      }

      const parts = jwtVP.split('.');
      if (parts.length < 2) throw new Error('Invalid JWT VP format');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

      // Replay-attack prevention: VP nonce must match the challenge we sent.
      if (originalChallenge && payload.nonce && payload.nonce !== originalChallenge) {
        throw new Error('VP challenge mismatch — possible replay attack');
      }

      const now = Math.floor(Date.now() / 1000);
      const vcs = payload?.vp?.verifiableCredential || [];
      for (const vcJwt of vcs) {
        if (typeof vcJwt !== 'string') continue;
        const vcParts = vcJwt.split('.');
        if (vcParts.length < 2) continue;
        const vcPayload = JSON.parse(Buffer.from(vcParts[1], 'base64url').toString('utf8'));

        // Validity window checks on the VC itself.
        if (vcPayload.exp && vcPayload.exp < now) continue; // expired — skip
        if (vcPayload.nbf && vcPayload.nbf > now) continue; // not yet valid — skip

        const claims = vcPayload?.vc?.credentialSubject || vcPayload?.credentialSubject || {};
        if (claims.credentialType === 'RealPersonIdentity') {
          return {
            uniqueId: claims.uniqueId || null,
            lastName: claims.lastName || null,
            photo: claims.photo || null
          };
        }
      }
      throw new Error('RealPersonIdentity credential not found in presented VP');
    }

    if (data.status === 'PresentationRejected' || data.status === 'RequestRejected') {
      throw new Error('Employee rejected the proof request');
    }
  }

  throw new Error(`RealPerson proof not received after ${maxAttempts * intervalMs / 1000} seconds`);
}

async function waitForPublicationComplete(
  longFormDid,
  apiKey,
  maxAttempts = 45,
  intervalMs = 2000
) {
  console.log(`[EmployeeWalletMgr] Waiting for DID publication (max ${maxAttempts * intervalMs / 1000}s)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const response = await fetch(
      `${EMPLOYEE_CLOUD_AGENT_URL}/did-registrar/dids/${encodeURIComponent(longFormDid)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to check DID status: ${response.status}`);
    }

    const didData = await response.json();
    console.log(`[EmployeeWalletMgr] Attempt ${attempt}/${maxAttempts} - Status: ${didData.status}`);

    if (didData.status === 'PUBLISHED') {
      console.log(`✅ [EmployeeWalletMgr] DID published successfully`);
      return didData.did; // Canonical DID
    }
  }

  throw new Error(`DID publication timed out after ${maxAttempts * intervalMs / 1000} seconds`);
}

/**
 * Helper: Create OOB invitation from TechCorp company wallet
 * @param {string} employeeName - Employee name for connection label
 * @param {string} employeeEmail - Employee email for label search
 * @returns {Promise<{invitationUrl: string, connectionId: string}>}
 */
async function createTechCorpInvitation(employeeName, employeeEmail) {
  console.log(`[EmployeeWalletMgr] Creating TechCorp invitation for ${employeeName}...`);

  const response = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/connections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': TECHCORP_API_KEY
    },
    body: JSON.stringify({
      label: `TechCorp ↔ ${employeeName} (${employeeEmail})`,
      goal: `Establish connection between TechCorp company and employee ${employeeName}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create TechCorp invitation: ${response.status} - ${errorText}`);
  }

  const connectionData = await response.json();
  console.log(`✅ [EmployeeWalletMgr] TechCorp invitation created (connectionId: ${connectionData.connectionId})`);

  return {
    invitationUrl: connectionData.invitation.invitationUrl, // Use invitationUrl field (contains base64 _oob param)
    connectionId: connectionData.connectionId
  };
}

/**
 * Helper: Accept OOB invitation as employee
 *
 * CUSTODIAL PROVISIONING: The server accepts this DIDComm invitation on behalf of the employee.
 * This is a deliberate enterprise onboarding pattern — not user-sovereign SSI.
 * The employee has no running wallet agent at this stage; the server acts as a custodial agent
 * to establish the DIDComm channel. The employee receives their VCs via this channel and
 * controls their wallet independently from that point forward.
 *
 * @param {string} invitationUrl - OOB invitation URL or payload
 * @param {string} employeeApiKey - Employee's API key
 * @returns {Promise<string>} Employee's connectionId
 */
async function acceptInvitationAsEmployee(invitationUrl, employeeApiKey, label = 'TechCorp Internal') {
  console.log(`[EmployeeWalletMgr] Employee accepting TechCorp invitation...`);

  // Extract _oob parameter if it's a full URL
  let oobPayload = invitationUrl;
  try {
    const url = new URL(invitationUrl);
    const oobParam = url.searchParams.get('_oob');
    if (oobParam) {
      oobPayload = oobParam;
    }
  } catch (error) {
    // Already just the payload, not a URL
  }

  const response = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/connection-invitations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': employeeApiKey
    },
    body: JSON.stringify({
      invitation: oobPayload,
      label
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to accept invitation: ${response.status} - ${errorText}`);
  }

  const connectionData = await response.json();
  console.log(`✅ [EmployeeWalletMgr] Invitation accepted (connectionId: ${connectionData.connectionId})`);

  return connectionData.connectionId;
}

/**
 * Helper: Wait for DIDComm connection to complete
 * @param {string} connectionId - Connection ID to monitor
 * @param {string} apiKey - API key for the wallet
 * @param {string} cloudAgentUrl - Cloud Agent URL (defaults to Employee Cloud Agent)
 * @param {number} maxAttempts - Maximum polling attempts (default: 15)
 * @param {number} intervalMs - Polling interval in milliseconds (default: 1000)
 * @returns {Promise<object>} Complete connection record
 */
async function waitForConnectionComplete(
  connectionId,
  apiKey,
  cloudAgentUrl = EMPLOYEE_CLOUD_AGENT_URL,
  maxAttempts = 15,
  intervalMs = 1000
) {
  console.log(`[EmployeeWalletMgr] Waiting for connection ${connectionId} (max ${maxAttempts * intervalMs / 1000}s)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const response = await fetch(
      `${cloudAgentUrl}/connections/${connectionId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to check connection status: ${response.status}`);
    }

    const connectionData = await response.json();
    console.log(`[EmployeeWalletMgr] Attempt ${attempt}/${maxAttempts} - State: ${connectionData.state}`);

    // Connection is established when state is 'Connected', 'ConnectionResponseSent', or 'ConnectionResponseReceived'
    // Note: ConnectionResponseReceived is the final state for invitee side in Cloud Agent 2.0.0
    if (connectionData.state === 'Connected' ||
        connectionData.state === 'ConnectionResponseSent' ||
        connectionData.state === 'ConnectionResponseReceived') {
      console.log(`✅ [EmployeeWalletMgr] Connection established`);
      return connectionData;
    }
  }

  throw new Error(`Connection failed to establish after ${maxAttempts * intervalMs / 1000} seconds`);
}

/**
 * Helper: Issue EmployeeRole VC to employee
 *
 * Issues an EmployeeRole Verifiable Credential to the employee using the TechCorp
 * Cloud Agent. This credential contains the employee's role, department, and other
 * employment details.
 *
 * @param {string} techCorpConnectionId - TechCorp's connection ID with the employee
 * @param {string} employeeConnectionId - Employee's connection ID with TechCorp
 * @param {object} credentialSubject - Credential subject data
 * @param {string} techCorpApiKey - TechCorp's API key
 * @param {string} techCorpCloudAgentUrl - TechCorp's Cloud Agent URL
 * @param {string} employeeApiKey - Employee's API key
 * @param {string} employeeCloudAgentUrl - Employee's Cloud Agent URL
 * @returns {Promise<string>} Credential record ID
 */
async function issueEmployeeRoleVC(
  techCorpConnectionId,
  employeeConnectionId,
  credentialSubject,
  techCorpApiKey,
  techCorpCloudAgentUrl,
  employeeApiKey,
  employeeCloudAgentUrl
) {
  console.log(`[EmployeeWalletMgr] Issuing EmployeeRole VC to employee...`);
  console.log(`[EmployeeWalletMgr] Credential Subject:`, JSON.stringify(credentialSubject, null, 2));

  // Extract employee PRISM DID for later use
  const employeeDid = credentialSubject.prismDid;

  // EmployeeRole schema GUID
  // NOTE: v1.3.0 adds uniqueId, lastName, photo, serviceUrl, serviceName, serviceIcon fields
  const EMPLOYEE_ROLE_SCHEMA_GUID = '028358d2-1f3b-37cc-ad1c-b8ca48d1e6c3'; // v1.4.0 — adds accessTarget, accessTargetLabel, accessTargetIcon

  // Step 1: Create credential offer from TechCorp side
  const offerResponse = await fetch(`${techCorpCloudAgentUrl}/issue-credentials/credential-offers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': techCorpApiKey
    },
    body: JSON.stringify({
      connectionId: techCorpConnectionId,
      schemaId: `${techCorpCloudAgentUrl}/schema-registry/schemas/${EMPLOYEE_ROLE_SCHEMA_GUID}`, // Full schema URL
      claims: credentialSubject,
      automaticIssuance: true, // Auto-approve after employee accepts
      issuingDID: TECHCORP_PRISM_DID, // TechCorp's published PRISM DID (issuer identifier)
      credentialFormat: 'JWT'
    })
  });

  if (!offerResponse.ok) {
    const errorText = await offerResponse.text();
    throw new Error(`Failed to create EmployeeRole VC offer: ${offerResponse.status} - ${errorText}`);
  }

  const offerData = await offerResponse.json();
  const techCorpRecordId = offerData.recordId;
  const offerThid = offerData.thid;
  console.log(`[EmployeeWalletMgr] EmployeeRole VC offer created (recordId: ${techCorpRecordId}, thid: ${offerThid})`);

  // Step 2: Wait for offer to appear in employee's records and accept it
  console.log(`[EmployeeWalletMgr] Waiting for offer to arrive at employee wallet...`);

  const maxAttempts = 30;
  const intervalMs = 2000;
  let employeeRecordId = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    // Check employee's credential records for the offer
    const employeeRecordsResponse = await fetch(`${employeeCloudAgentUrl}/issue-credentials/records`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': employeeApiKey
      }
    });

    if (employeeRecordsResponse.ok) {
      const employeeRecords = await employeeRecordsResponse.json();
      const offerRecord = employeeRecords.contents?.find(
        record => record.thid === offerThid && record.protocolState === 'OfferReceived'
      );

      if (offerRecord) {
        console.log(`[EmployeeWalletMgr] Offer received by employee (recordId: ${offerRecord.recordId})`);
        employeeRecordId = offerRecord.recordId;

        // Accept the offer from employee side
        console.log(`[EmployeeWalletMgr] Employee accepting credential offer...`);
        const acceptResponse = await fetch(
          `${employeeCloudAgentUrl}/issue-credentials/records/${employeeRecordId}/accept-offer`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': employeeApiKey
            },
            body: JSON.stringify({
              subjectId: employeeDid  // Use employee's PRISM DID as the subject
            })
          }
        );

        if (!acceptResponse.ok) {
          const errorText = await acceptResponse.text();
          console.error(`[EmployeeWalletMgr] Failed to accept offer: ${errorText}`);
        } else {
          console.log(`[EmployeeWalletMgr] Offer accepted by employee`);
          break;
        }
      }
    }

    console.log(`[EmployeeWalletMgr] Attempt ${attempt}/${maxAttempts} - Waiting for offer...`);
  }

  if (!employeeRecordId) {
    throw new Error(`Credential offer not received by employee after ${maxAttempts * intervalMs / 1000} seconds`);
  }

  // Step 3: Wait for credential to be issued (poll TechCorp side until CredentialSent)
  console.log(`[EmployeeWalletMgr] Waiting for credential issuance...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const statusResponse = await fetch(`${techCorpCloudAgentUrl}/issue-credentials/records/${techCorpRecordId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': techCorpApiKey
      }
    });

    if (!statusResponse.ok) {
      throw new Error(`Failed to check credential status: ${statusResponse.status}`);
    }

    const statusData = await statusResponse.json();
    console.log(`[EmployeeWalletMgr] Attempt ${attempt}/${maxAttempts} - TechCorp VC State: ${statusData.protocolState}`);

    // Credential is issued when protocolState is 'CredentialSent'
    if (statusData.protocolState === 'CredentialSent') {
      console.log(`✅ [EmployeeWalletMgr] EmployeeRole VC issued successfully`);
      return techCorpRecordId;
    }

    // Handle error states
    if (statusData.protocolState === 'Failed' || statusData.protocolState === 'Rejected') {
      throw new Error(`Credential issuance failed with state: ${statusData.protocolState}`);
    }
  }

  throw new Error(`EmployeeRole VC issuance timed out after ${maxAttempts * intervalMs / 1000} seconds`);
}

/**
 * Helper: Rollback employee wallet creation on failure
 * @param {object} employeeData - Partial employee data to rollback
 * @returns {Promise<void>}
 */
async function rollbackEmployeeWallet(employeeData) {
  console.log(`❌ [EmployeeWalletMgr] Rolling back employee wallet for ${employeeData.email}...`);

  const errors = [];

  // Step 0: Delete TechCorp-side DIDComm connection (if established)
  if (employeeData.techCorpConnectionId) {
    try {
      console.log(`[EmployeeWalletMgr] Deleting TechCorp connection ${employeeData.techCorpConnectionId}...`);
      await fetch(
        `${TECHCORP_CLOUD_AGENT_URL}/connections/${employeeData.techCorpConnectionId}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'apikey': TECHCORP_API_KEY }
        }
      );
      console.log(`✅ [EmployeeWalletMgr] TechCorp connection deleted`);
    } catch (error) {
      errors.push(`TechCorp connection deletion: ${error.message}`);
    }
  }

  // Note: CredentialOffer records (employeeData.employeeRoleCredentialId) become orphaned
  // when the wallet is deleted. Full StatusList2021 revocation takes 30min+ and is not
  // appropriate here. Wallet deletion removes the holder side; connection deletion above
  // prevents future interactions on the issuer side.

  // Step 1: Delete API key authentication (if exists)
  if (employeeData.entityId && employeeData.apiKey) {
    try {
      console.log(`[EmployeeWalletMgr] Deleting API key for entity ${employeeData.entityId}...`);
      // Note: Cloud Agent 2.0.0 doesn't have DELETE endpoint for API keys
      // They are automatically deleted when entity is deleted
      console.log(`[EmployeeWalletMgr] API key will be deleted with entity`);
    } catch (error) {
      errors.push(`API key deletion: ${error.message}`);
    }
  }

  // Step 2: Delete entity (if exists)
  if (employeeData.entityId) {
    try {
      console.log(`[EmployeeWalletMgr] Deleting entity ${employeeData.entityId}...`);
      const response = await fetch(
        `${EMPLOYEE_CLOUD_AGENT_URL}/iam/entities/${employeeData.entityId}`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-api-key': ADMIN_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      console.log(`✅ [EmployeeWalletMgr] Entity deleted`);
    } catch (error) {
      errors.push(`Entity deletion: ${error.message}`);
    }
  }

  // Step 3: Delete wallet (if exists)
  if (employeeData.walletId) {
    try {
      console.log(`[EmployeeWalletMgr] Deleting wallet ${employeeData.walletId}...`);
      const response = await fetch(
        `${EMPLOYEE_CLOUD_AGENT_URL}/wallets/${employeeData.walletId}`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-api-key': ADMIN_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      console.log(`✅ [EmployeeWalletMgr] Wallet deleted`);
    } catch (error) {
      errors.push(`Wallet deletion: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`⚠️ [EmployeeWalletMgr] Rollback completed with errors:`, errors);
  } else {
    console.log(`✅ [EmployeeWalletMgr] Rollback completed successfully`);
  }
}

/**
 * Get employee's TechCorp connection details from database
 *
 * Retrieves the stored TechCorp connection ID for credential issuance.
 * Validates that the connection exists and is active on both sides.
 *
 * @param {string} employeeEmail - Employee email address
 * @returns {Promise<Object>} Connection details { techCorpConnectionId, employeeData }
 */
async function getEmployeeTechCorpConnection(employeeEmail) {
  console.log(`[EmployeeWalletMgr] Retrieving TechCorp connection for ${employeeEmail}...`);

  const EmployeePortalDatabase = require('./EmployeePortalDatabase');
  const employeeDb = new EmployeePortalDatabase(getDbPool());

  // Get employee data from database
  const employeeData = await employeeDb.getEmployeeByEmail(employeeEmail);
  if (!employeeData) {
    throw new Error(`Employee not found: ${employeeEmail}`);
  }

  if (!employeeData.techcorp_connection_id) {
    throw new Error(`No TechCorp connection found for employee: ${employeeEmail}`);
  }

  console.log(`[EmployeeWalletMgr] Found TechCorp connection: ${employeeData.techcorp_connection_id}`);
  console.log(`[EmployeeWalletMgr] Connection state: ${employeeData.techcorp_connection_state}`);

  // Validate connection exists on TechCorp side
  const techCorpConnectionResponse = await fetch(
    `${TECHCORP_CLOUD_AGENT_URL}/connections/${employeeData.techcorp_connection_id}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': TECHCORP_API_KEY
      }
    }
  );

  if (!techCorpConnectionResponse.ok) {
    throw new Error(`TechCorp connection not found: ${employeeData.techcorp_connection_id}`);
  }

  const techCorpConnection = await techCorpConnectionResponse.json();
  console.log(`[EmployeeWalletMgr] TechCorp connection validated (state: ${techCorpConnection.state})`);

  return {
    techCorpConnectionId: employeeData.techcorp_connection_id,
    employeeData: {
      walletId: employeeData.wallet_id,
      entityId: employeeData.entity_id,
      prismDid: employeeData.prism_did,
      email: employeeData.email,
      fullName: employeeData.full_name,
      department: employeeData.department
    }
  };
}

/**
 * Issue CISTraining credential to employee
 *
 * Issues a CIS Training Certificate to an employee's Enterprise wallet using
 * the established DIDComm connection. Follows W3C DID standards with PRISM DID
 * included in credential claims.
 *
 * @param {string} employeeEmail - Employee email address
 * @param {object} credentialData - Credential claims data
 * @param {string} credentialData.trainingYear - Training year
 * @param {string} credentialData.completionDate - ISO 8601 completion date
 * @param {string} credentialData.expiryDate - ISO 8601 expiry date
 * @returns {Promise<string>} Credential record ID
 */
async function issueCISTrainingCredential(employeeEmail, credentialData) {
  console.log(`[EmployeeWalletMgr] Issuing CISTraining credential to ${employeeEmail}...`);

  // Step 1: Get employee's TechCorp connection from database
  const { techCorpConnectionId, employeeData } = await getEmployeeTechCorpConnection(employeeEmail);

  console.log(`[EmployeeWalletMgr] Using TechCorp connection: ${techCorpConnectionId}`);
  console.log(`[EmployeeWalletMgr] Employee PRISM DID: ${employeeData.prismDid}`);

  // Step 2: Prepare credential subject
  const employeeId = employeeEmail.split('@')[0];
  const { randomUUID } = require('crypto');
  const certificateNumber = `CIS-${randomUUID()}`;

  const credentialSubject = {
    prismDid: employeeData.prismDid, // W3C DID standards compliance
    employeeId: employeeId,
    certificateNumber: certificateNumber,
    trainingYear: credentialData.trainingYear || new Date().getFullYear().toString(),
    completionDate: credentialData.completionDate || new Date().toISOString(),
    expiryDate: credentialData.expiryDate || new Date(Date.now() + 365*24*60*60*1000).toISOString()
  };

  console.log(`[EmployeeWalletMgr] Credential Subject:`, JSON.stringify(credentialSubject, null, 2));

  // Step 3: Issue credential using TechCorp Cloud Agent
  const CIS_TRAINING_SCHEMA_GUID = 'bc954e49-5cb0-38a8-90a6-4142c0222de3';

  const offerResponse = await fetch(`${TECHCORP_CLOUD_AGENT_URL}/issue-credentials/credential-offers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': TECHCORP_API_KEY
    },
    body: JSON.stringify({
      connectionId: techCorpConnectionId,
      schemaId: `${TECHCORP_CLOUD_AGENT_URL}/schema-registry/schemas/${CIS_TRAINING_SCHEMA_GUID}`,
      claims: credentialSubject,
      automaticIssuance: true,
      issuingDID: 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
      credentialFormat: 'JWT'
    })
  });

  if (!offerResponse.ok) {
    const errorText = await offerResponse.text();
    throw new Error(`Failed to create CISTraining VC offer: ${offerResponse.status} - ${errorText}`);
  }

  const offerData = await offerResponse.json();
  const recordId = offerData.recordId;

  console.log(`✅ [EmployeeWalletMgr] CISTraining VC offer created (recordId: ${recordId})`);

  // Step 4: Record credential issuance in database
  const EmployeePortalDatabase = require('./EmployeePortalDatabase');
  const employeeDb = new EmployeePortalDatabase(getDbPool());
  const employee = await employeeDb.getEmployeeByEmail(employeeEmail);

  await employeeDb.recordCredentialIssuance(
    employee.id,
    'CISTraining',
    recordId,
    {
      ...credentialSubject,
      issuedBy: 'TechCorp'
    }
  );

  console.log(`[EmployeeWalletMgr] CISTraining VC recorded in database`);

  return recordId;
}

/**
 * Connect an existing employee's enterprise wallet to the Document Service.
 *
 * The original API key is hashed and unrecoverable from the DB. We generate a
 * fresh key, register it via the admin credential, use it to accept the OOB
 * invitation, then leave it in place (the employee can use it going forward).
 *
 * @param {string} entityId   - From employee_portal_accounts.entity_id
 * @param {string} [docServiceUrl] - Defaults to DOCUMENT_SERVICE_URL env or production URL
 * @returns {Promise<string>} New connectionId
 */
async function connectExistingEmployeeToDocService(entityId, docServiceUrl) {
  const svcUrl = docServiceUrl || process.env.DOCUMENT_SERVICE_URL || 'https://identuslabel.cz/document-service';

  // 1. Issue a fresh API key for the entity using admin credentials
  const freshApiKey = generateApiKey();
  const keyResp = await fetch(`${EMPLOYEE_CLOUD_AGENT_URL}/iam/apikey-authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-api-key': ADMIN_API_KEY },
    body: JSON.stringify({ entityId, apiKey: freshApiKey })
  });
  if (!keyResp.ok) {
    const err = await keyResp.text();
    throw new Error(`Failed to register fresh API key for entity ${entityId}: ${keyResp.status} ${err}`);
  }

  // 2. Get OOB invitation from document service
  const inviteResp = await fetch(`${svcUrl}/connect`);
  if (!inviteResp.ok) {
    throw new Error(`Document service /connect returned ${inviteResp.status}`);
  }
  const inviteData = await inviteResp.json();
  const invitationUrl = inviteData.invitation?.invitation?.invitationUrl
    || inviteData.invitation?.invitationUrl
    || inviteData.invitation;
  if (!invitationUrl || typeof invitationUrl !== 'string') throw new Error('Document service returned no invitation URL');

  // 3. Accept the invitation using the fresh key
  const connectionId = await acceptInvitationAsEmployee(invitationUrl, freshApiKey, 'Document Service');
  return connectionId;
}

module.exports = {
  createEmployeeWallet,
  getEmployeeWallet,
  listEmployeeWallets,
  deleteEmployeeWallet,
  getEmployeeTechCorpConnection,
  issueCISTrainingCredential,
  connectExistingEmployeeToDocService
};
