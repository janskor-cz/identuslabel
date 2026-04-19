/**
 * identus-document-service — Document Lifecycle Microservice
 *
 * CRUD Endpoints (admin key required for writes):
 *   POST   /documents              — Create: upload → Iagon → PRISM DID
 *   GET    /documents              — List documents (Iagon-backed index)
 *   GET    /documents/:did         — Public metadata lookup
 *   POST   /documents/:did/access  — VP-gated document access
 *   PUT    /documents/:did         — Update: new version (new DID)
 *   DELETE /documents/:did         — Delete Iagon files + deactivate DID
 *
 * Legacy endpoints (backward compat):
 *   POST /access              — VP-gated access (original path)
 *   GET  /health              — Liveness probe
 *   GET  /resolve/:documentDID — Public DID metadata lookup
 */

'use strict';

require('dotenv').config();

// Task 1: Initialise Classification Master Key store (throws if CMK env vars missing)
const cmkStore = require('./lib/ClassificationKeyManager');
cmkStore.load();

// VC key-manifest store (loaded async in startup block below)
const vcStore = require('./lib/VCKeyStore');

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');

const config                       = require('./config');
const { resolveDocumentDID }       = require('./lib/DIDDocumentResolver');
const { emitAuditEvent }           = require('./lib/AuditEmitter');
const { verifyVPAndExtractClaims } = require('./lib/VPVerificationService');
const { processAccessRequest, getLevelNumber, getLevelLabel } = require('./lib/ReEncryptionService');
const { IagonStorageClient }       = require('./lib/IagonStorageClient');
const { DocumentService }          = require('./lib/DocumentService');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const docSvc = new DocumentService(config);

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------
function requireAdminKey(req, res, next) {
  if (!config.ADMIN_API_KEY) {
    return res.status(503).json({
      error:   'ADMIN_NOT_CONFIGURED',
      message: 'ADMIN_API_KEY environment variable is not set'
    });
  }
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const xKey   = req.headers['x-admin-key'] || '';
  const token  = bearer || xKey;
  if (!token || token !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Valid admin API key required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /documents — Create document
// ---------------------------------------------------------------------------
app.post('/documents', requireAdminKey, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'MISSING_FILE', message: 'A file upload is required' });
    }

    let releasableTo;
    try {
      releasableTo = JSON.parse(req.body.releasableTo || '[]');
    } catch (_) {
      return res.status(400).json({ error: 'INVALID_FIELD', message: 'releasableTo must be a JSON array string' });
    }

    const result = await docSvc.createDocument({
      fileBuffer:       req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType:         req.file.mimetype,
      title:            req.body.title,
      description:      req.body.description,
      documentType:     req.body.documentType,
      clearanceLevel:   req.body.clearanceLevel,
      releasableTo,
      department:       req.body.department,
      auditWebhookUrl:  req.body.auditWebhookUrl
    });

    return res.status(201).json({ success: true, ...result });

  } catch (err) {
    console.error('[POST /documents]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /documents — List documents
// ---------------------------------------------------------------------------
app.get('/documents', requireAdminKey, async (req, res) => {
  if (!config.DOCUMENT_INDEX_FILE_ID && !docSvc._currentIndexFileId) {
    return res.status(501).json({
      error:   'INDEX_NOT_CONFIGURED',
      message: 'Set DOCUMENT_INDEX_FILE_ID in .env to enable document listing'
    });
  }
  try {
    const result = await docSvc.listDocuments(req.query.status || null);
    return res.json(result);
  } catch (err) {
    console.error('[GET /documents]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /documents/:did — Public metadata lookup
// ---------------------------------------------------------------------------
app.get('/documents/:did', async (req, res) => {
  const documentDID = req.params.did;
  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'Invalid DID format' });
  }
  try {
    const result = await docSvc.getDocumentMetadata(documentDID);
    return res.json(result);
  } catch (err) {
    console.error('[GET /documents/:did]', err.message);
    if (err.message.includes('not found') || err.message.includes('resolution failed')) {
      return res.status(404).json({ error: 'DID not found', documentDID });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /documents/:did/access — VP-gated access (canonical path)
// ---------------------------------------------------------------------------
app.post('/documents/:did/access', async (req, res) => {
  // Inject the DID from the URL path into the body, then reuse /access logic
  req.body.documentDID = req.params.did;
  return _handleAccess(req, res);
});

// ---------------------------------------------------------------------------
// PUT /documents/:did — Update (new version)
// ---------------------------------------------------------------------------
app.put('/documents/:did', requireAdminKey, upload.single('file'), async (req, res) => {
  const oldDocumentDID = req.params.did;
  if (!oldDocumentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'Invalid DID format' });
  }
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'MISSING_FILE', message: 'A new file is required for an update' });
    }

    let releasableTo;
    try {
      releasableTo = req.body.releasableTo ? JSON.parse(req.body.releasableTo) : undefined;
    } catch (_) {
      return res.status(400).json({ error: 'INVALID_FIELD', message: 'releasableTo must be a JSON array string' });
    }

    const result = await docSvc.updateDocument(oldDocumentDID, {
      fileBuffer:       req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType:         req.file.mimetype,
      title:            req.body.title,
      description:      req.body.description,
      documentType:     req.body.documentType,
      clearanceLevel:   req.body.clearanceLevel,
      releasableTo,
      department:       req.body.department,
      auditWebhookUrl:  req.body.auditWebhookUrl
    });

    return res.status(201).json(result);

  } catch (err) {
    console.error('[PUT /documents/:did]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /documents/:did — Delete document
// ---------------------------------------------------------------------------
app.delete('/documents/:did', requireAdminKey, async (req, res) => {
  const documentDID = req.params.did;
  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'Invalid DID format' });
  }
  try {
    const purge  = req.query.purge !== 'false'; // default true
    const result = await docSvc.deleteDocument(documentDID, { purge });
    return res.json(result);
  } catch (err) {
    console.error('[DELETE /documents/:did]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /vc/key-manifest — receive a DocumentKeyManifest VC from company-admin
// DELETE /vc/key-manifest/:documentDID — revoke (called by company-admin on update)
// ---------------------------------------------------------------------------

const MANIFEST_REQUIRED_CLAIMS = [
  'iagonFileId', 'wrappedKey', 'iv', 'authTag',
  'wrappingAlgorithm', 'classificationLevel',
  'fileIv', 'fileAuthTag', 'fileAlgorithm', 'releasableTo'
];

app.post('/vc/key-manifest', requireAdminKey, async (req, res) => {
  const { documentDID, vcId, vcJwt, claims } = req.body;

  if (!documentDID || !vcJwt || !claims) {
    return res.status(400).json({
      error:   'MISSING_FIELDS',
      message: 'documentDID, vcJwt, and claims are required'
    });
  }

  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'INVALID_DID', message: 'documentDID must start with did:' });
  }

  const missing = MANIFEST_REQUIRED_CLAIMS.filter(f => claims[f] === undefined || claims[f] === null);
  if (missing.length > 0) {
    return res.status(400).json({
      error:   'MISSING_CLAIMS',
      message: `Required claims missing: ${missing.join(', ')}`
    });
  }

  const vcRecord = {
    documentDID,
    vcId:     vcId || null,
    vcJwt,
    claims,
    issuedAt: new Date().toISOString()
  };

  await vcStore.put(documentDID, vcRecord);
  console.log(`[VCKeyStore] Stored DocumentKeyManifest VC for ${documentDID.substring(0, 50)}...`);

  return res.status(201).json({ success: true, documentDID });
});

app.delete('/vc/key-manifest/:documentDID', requireAdminKey, async (req, res) => {
  const documentDID = decodeURIComponent(req.params.documentDID);

  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'INVALID_DID', message: 'documentDID must start with did:' });
  }

  const existing = vcStore.get(documentDID);
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No VC found for this documentDID' });
  }

  await vcStore.delete(documentDID);
  console.log(`[VCKeyStore] Deleted DocumentKeyManifest VC for ${documentDID.substring(0, 50)}...`);

  return res.json({ success: true, documentDID });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  const iagon = new IagonStorageClient({
    accessToken:     config.IAGON_ACCESS_TOKEN,
    nodeId:          config.IAGON_NODE_ID,
    downloadBaseUrl: config.IAGON_DOWNLOAD_BASE_URL
  });

  const iagonStatus = await iagon.testConnection().catch(() => ({ connected: false }));

  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    config: {
      cloudAgentUrl: config.ENTERPRISE_CLOUD_AGENT_URL,
      iagonConfigured: iagon.isConfigured(),
      iagonConnected:  iagonStatus.connected ?? false
    }
  });
});

// ---------------------------------------------------------------------------
// GET /resolve/:documentDID
// Public metadata lookup — strips encryptionInfo before responding
// ---------------------------------------------------------------------------
app.get('/resolve/:documentDID', async (req, res) => {
  const { documentDID } = req.params;

  if (!documentDID || !documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'Invalid DID format' });
  }

  try {
    const meta = await resolveDocumentDID(documentDID);

    // Never expose the encryption key manifest ID in a public endpoint
    const { iagonEncManifestId: _stripped, ...publicMeta } = meta;

    return res.json({
      documentDID,
      ...publicMeta,
      resolvedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[/resolve] Error:', err.message);

    if (err.message.includes('resolution failed')) {
      return res.status(404).json({ error: 'DID not found', documentDID });
    }

    return res.status(500).json({ error: 'DID resolution error', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /access — legacy path (backward compat)
// ---------------------------------------------------------------------------
app.post('/access', _handleAccess);

// ---------------------------------------------------------------------------
// Shared access handler (used by both /access and /documents/:did/access)
// ---------------------------------------------------------------------------
async function _handleAccess(req, res) {
  const startTime = Date.now();
  const clientIp  = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const {
    documentDID,
    ephemeralPublicKey,
    vp,
    signature,
    ephemeralDID,
    timestamp,
    nonce: reqNonce
  } = req.body;

  if (!documentDID || !ephemeralPublicKey || !vp) {
    return res.status(400).json({
      error:   'MISSING_FIELDS',
      message: 'documentDID, ephemeralPublicKey, and vp are required'
    });
  }

  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'INVALID_DID', message: 'documentDID must be a valid DID' });
  }

  try {
    let docMeta;
    try {
      docMeta = await resolveDocumentDID(documentDID);
    } catch (resolveErr) {
      console.error('[/access] DID resolution error:', resolveErr.message);
      return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND', message: 'Could not resolve document DID' });
    }

    const vpResult = await verifyVPAndExtractClaims(vp, docMeta.releasableTo);

    if (!vpResult.success) {
      console.warn('[/access] VP verification failed:', vpResult.error);
      _fireAudit(docMeta.auditEndpoint, {
        event: 'ACCESS_DENIED', documentDID, denialReason: vpResult.error, clientIp,
        processingMs: Date.now() - startTime
      });
      return res.status(403).json({ error: vpResult.error, message: vpResult.message });
    }

    const { issuerDID, clearanceLevel: clearanceLevelStr, viewerName } = vpResult;
    const clearanceLevelNum = getLevelNumber(clearanceLevelStr || 'UNCLASSIFIED');

    const result = await processAccessRequest({
      documentDID,
      requestorDID:      vpResult.companyDID || issuerDID,
      issuerDID,
      companyDID:        vpResult.companyDID,
      clearanceLevelNum,
      clearanceLevelStr: clearanceLevelStr || getLevelLabel(clearanceLevelNum),
      ephemeralPublicKey,
      signature:         signature    || _generateNullSig(),
      ephemeralDID:      ephemeralDID || `did:key:${crypto.randomUUID()}`,
      timestamp:         timestamp    || new Date().toISOString(),
      nonce:             reqNonce     || crypto.randomUUID(),
      docMeta,
      clientIp
    });

    _fireAudit(docMeta.auditEndpoint, {
      event:          result.success ? 'ACCESS_GRANTED' : 'ACCESS_DENIED',
      documentDID,    issuerDID,      clearanceLevel: clearanceLevelStr,
      copyId:         result.copyId   || null,
      denialReason:   result.error    || null,
      viewerName:     viewerName      || null,
      clientIp,       processingMs:   Date.now() - startTime
    });

    if (!result.success) {
      return res.status(403).json({ error: result.error, message: result.message });
    }

    return res.json({
      success:         true,
      copyId:          result.copyId,
      copyHash:        result.copyHash,
      filename:        result.filename,
      mimeType:        result.mimeType,
      clearanceLevel:  result.clearanceLevel,
      encryptedDocument: {
        ciphertext:      result.ciphertext,
        nonce:           result.nonce,
        senderPublicKey: result.serverPublicKey
      },
      accessedAt: result.accessedAt
    });

  } catch (err) {
    console.error('[/access] Unhandled error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An internal error occurred' });
  }
}

// ---------------------------------------------------------------------------
// DIDComm two-step document access (server-initiated VP collection)
// ---------------------------------------------------------------------------

/** In-memory session store: sessionId → documentDID */
const _pendingDocSessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 1000; // 6 min (slightly longer than company-admin's 5 min)
  for (const [id, s] of _pendingDocSessions) {
    if (s.createdAt < cutoff) _pendingDocSessions.delete(id);
  }
}, 60 * 1000);

function _caHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-ds-key':     config.COMPANY_ADMIN_KEY
  };
}

/**
 * POST /documents/:did/access-initiate
 * Kick off the DIDComm two-step flow via company-admin.
 * Body: { employeeId }  — employee email or PRISM DID
 */
app.post('/documents/:did/access-initiate', async (req, res) => {
  const documentDID = req.params.did;
  const { employeeId } = req.body;

  if (!documentDID || !employeeId) {
    return res.status(400).json({ error: 'MISSING_FIELDS',
      message: 'documentDID and employeeId are required' });
  }

  try {
    // Validate DID exists
    await resolveDocumentDID(documentDID);
  } catch (_) {
    return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND',
      message: 'Could not resolve document DID' });
  }

  try {
    const caResp = await fetch(
      `${config.COMPANY_ADMIN_URL}/api/document/authorize/initiate`,
      {
        method:  'POST',
        headers: _caHeaders(),
        body:    JSON.stringify({ documentDID, employeeId })
      }
    );
    const caJson = await caResp.json();
    if (!caResp.ok || !caJson.success) {
      return res.status(caResp.status || 502).json({
        error: caJson.error || 'CA_ERROR', message: caJson.message || 'Company admin error'
      });
    }

    const { sessionId } = caJson;
    _pendingDocSessions.set(sessionId, { documentDID, createdAt: Date.now() });

    return res.json({ success: true, sessionId, status: caJson.status,
      hasBothConnections: caJson.hasBothConnections,
      message: caJson.message });

  } catch (err) {
    console.error('[access-initiate] Error:', err.message);
    return res.status(502).json({ error: 'CA_UNREACHABLE',
      message: 'Could not reach company admin portal' });
  }
});

/**
 * GET /documents/:did/access-status/:sessionId
 * Proxy status poll to company-admin.
 */
app.get('/documents/:did/access-status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const caResp = await fetch(
      `${config.COMPANY_ADMIN_URL}/api/document/authorize/status/${sessionId}`,
      { headers: _caHeaders() }
    );
    const caJson = await caResp.json();
    return res.status(caResp.status).json(caJson);
  } catch (err) {
    console.error('[access-status] Error:', err.message);
    return res.status(502).json({ error: 'CA_UNREACHABLE', message: 'Could not reach company admin portal' });
  }
});

/**
 * POST /documents/:did/access-complete
 * Complete document download after DIDComm VPs verified.
 * Body: { sessionId, ephemeralPublicKey }
 */
app.post('/documents/:did/access-complete', async (req, res) => {
  const startTime   = Date.now();
  const documentDID = req.params.did;
  const clientIp    = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { sessionId, ephemeralPublicKey } = req.body;

  if (!sessionId || !ephemeralPublicKey) {
    return res.status(400).json({ error: 'MISSING_FIELDS',
      message: 'sessionId and ephemeralPublicKey are required' });
  }

  // Verify sessionId belongs to this documentDID
  const localSession = _pendingDocSessions.get(sessionId);
  if (!localSession || localSession.documentDID !== documentDID) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND',
      message: 'Session not found or does not match document DID' });
  }

  // Consume session from company-admin
  let caJson;
  try {
    const caResp = await fetch(
      `${config.COMPANY_ADMIN_URL}/api/document/authorize/complete/${sessionId}`,
      { method: 'POST', headers: _caHeaders() }
    );
    caJson = await caResp.json();
    if (!caResp.ok || !caJson.success) {
      return res.status(403).json({ error: caJson.error || 'NOT_AUTHORIZED',
        message: caJson.message || 'Authorization not yet complete' });
    }
  } catch (err) {
    console.error('[access-complete] CA call failed:', err.message);
    return res.status(502).json({ error: 'CA_UNREACHABLE', message: 'Could not reach company admin portal' });
  }

  _pendingDocSessions.delete(sessionId);

  const { issuerDID, clearanceLevel: clearanceLevelStr, companyDID } = caJson;
  const clearanceLevelNum = getLevelNumber(clearanceLevelStr || 'UNCLASSIFIED');

  let docMeta;
  try {
    docMeta = await resolveDocumentDID(documentDID);
  } catch (_) {
    return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
  }

  const result = await processAccessRequest({
    documentDID,
    requestorDID:      companyDID || issuerDID,
    issuerDID,
    companyDID,
    clearanceLevelNum,
    clearanceLevelStr: clearanceLevelStr || getLevelLabel(clearanceLevelNum),
    ephemeralPublicKey,
    signature:         _generateNullSig(),
    ephemeralDID:      `did:key:${crypto.randomUUID()}`,
    timestamp:         new Date().toISOString(),
    nonce:             crypto.randomUUID(),
    docMeta,
    clientIp
  });

  _fireAudit(docMeta.auditEndpoint, {
    event:         result.success ? 'ACCESS_GRANTED' : 'ACCESS_DENIED',
    documentDID,   issuerDID,   clearanceLevel: clearanceLevelStr,
    copyId:        result.copyId || null,
    denialReason:  result.error  || null,
    clientIp,      processingMs: Date.now() - startTime
  });

  if (!result.success) {
    return res.status(403).json({ error: result.error, message: result.message });
  }

  return res.json({
    success:  true,
    copyId:   result.copyId,
    copyHash: result.copyHash,
    filename: result.filename,
    mimeType: result.mimeType,
    encryptedDocument: {
      ciphertext:      result.ciphertext,
      nonce:           result.nonce,
      senderPublicKey: result.serverPublicKey
    },
    accessedAt: result.accessedAt
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _fireAudit(url, event) {
  emitAuditEvent(url, event);
}

/** Produces a 64-byte zero signature used when the client doesn't provide one.
 *  verifySignature will fall back to format-only validation in this case. */
function _generateNullSig() {
  return Buffer.alloc(64).toString('base64');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  // Load VC key-manifest store before accepting requests
  await vcStore.load();

  app.listen(config.PORT, () => {
    console.log(`[identus-document-service] Listening on port ${config.PORT}`);
    console.log(`[identus-document-service] Cloud Agent: ${config.ENTERPRISE_CLOUD_AGENT_URL}`);
    console.log(`[identus-document-service] Iagon configured: ${!!(config.IAGON_ACCESS_TOKEN && config.IAGON_NODE_ID)}`);
    console.log(`[identus-document-service] VC key-manifest store: ${vcStore.size()} entries loaded`);
  });
})();

module.exports = app; // for testing
