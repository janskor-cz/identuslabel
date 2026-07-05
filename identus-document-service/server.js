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
const path    = require('path');

const AdminConfigStore = require('./lib/AdminConfigStore');
const LocalAuditLog    = require('./lib/LocalAuditLog');
const DocumentServiceStartup  = require('./lib/DocumentServiceStartup');
const { DocumentDIDCommService } = require('./lib/DocumentDIDCommService');

const config                       = require('./config');
const { resolveDocumentDID }       = require('./lib/DIDDocumentResolver');
const { emitAuditEvent }           = require('./lib/AuditEmitter');
const SlackNotifier                = require('./lib/SlackNotifier');
const { verifyVPAndExtractClaims } = require('./lib/VPVerificationService');
const { processAccessRequest, getLevelNumber, getLevelLabel } = require('./lib/ReEncryptionService');
const { IagonStorageClient }       = require('./lib/IagonStorageClient');
const { DocumentService }          = require('./lib/DocumentService');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const docSvc = new DocumentService(config);

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Upload session store (VP-over-REST — no DIDComm, no admin key required)
// ---------------------------------------------------------------------------
const _pendingUploadSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of _pendingUploadSessions)
    if (s.createdAt < cutoff) _pendingUploadSessions.delete(id);
}, 60_000);

// POST /upload/initiate — reserve upload slot; returns sessionId
app.post('/upload/initiate', express.json(), (req, res) => {
  const { title, clearanceLevel } = req.body || {};
  let releasableTo = req.body?.releasableTo;

  if (!title || !String(title).trim())
    return res.status(400).json({ error: 'MISSING_FIELD', message: 'title is required' });

  const VALID = ['UNCLASSIFIED', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP-SECRET'];
  const level = (clearanceLevel || '').toUpperCase();
  if (!VALID.includes(level))
    return res.status(400).json({ error: 'INVALID_FIELD', message: `clearanceLevel must be one of: ${VALID.join(', ')}` });

  if (!Array.isArray(releasableTo)) {
    try { releasableTo = JSON.parse(releasableTo || '[]'); } catch (_) { releasableTo = []; }
  }
  if (!releasableTo.length || !releasableTo.every(d => typeof d === 'string' && d.startsWith('did:')))
    return res.status(400).json({ error: 'INVALID_FIELD', message: 'releasableTo must be a non-empty array of DID strings' });

  const sessionId = crypto.randomUUID();
  _pendingUploadSessions.set(sessionId, { title: String(title).trim(), clearanceLevel: level, releasableTo, createdAt: Date.now() });
  return res.json({ sessionId, expiresIn: 1800 });
});

// POST /upload/complete — multipart: sessionId + vp (JSON string) + file
app.post('/upload/complete', upload.single('file'), async (req, res) => {
  const { sessionId, vp: vpString } = req.body || {};
  if (!sessionId || !vpString)
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'sessionId and vp are required' });
  if (!req.file)
    return res.status(400).json({ error: 'MISSING_FILE', message: 'A file is required' });

  const session = _pendingUploadSessions.get(sessionId);
  if (!session)
    return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Upload session expired or not found' });
  _pendingUploadSessions.delete(sessionId); // one-time use

  let vp;
  try { vp = typeof vpString === 'string' ? JSON.parse(vpString) : vpString; }
  catch (_) { return res.status(400).json({ error: 'INVALID_VP', message: 'vp must be valid JSON' }); }

  let vpResult;
  try { vpResult = await verifyVPAndExtractClaims(vp, []); }
  catch (err) {
    console.error('[POST /upload/complete] VP verify error:', err.message);
    return res.status(500).json({ error: 'VP_VERIFY_ERROR', message: 'VP verification failed' });
  }
  if (!vpResult.success)
    return res.status(403).json({ error: vpResult.error, message: vpResult.message });

  const publisherDID   = vpResult.credentialSubjectDID || vpResult.issuerDID;
  const ownerCompanyDID = vpResult.issuerDID || null;
  try {
    const result = await docSvc.createDocument({
      fileBuffer:       req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType:         req.file.mimetype,
      title:            session.title,
      clearanceLevel:   session.clearanceLevel,
      releasableTo:     session.releasableTo
    });
    console.log(`[POST /upload/complete] Created: ${result.documentDID?.slice(0, 50)}... publisher=${publisherDID?.slice(0, 40)}`);

    // Register in company-admin DocumentRegistry so the document appears in employee discovery
    try {
      const regRes = await fetch(`${config.COMPANY_ADMIN_URL}/api/documents/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentDID:          result.documentDID,
          title:                session.title,
          classificationLevel:  session.clearanceLevel,
          releasableTo:         session.releasableTo,
          contentEncryptionKey: 'not-applicable',
          ownerCompanyDID,
          iagonStorage: {
            fileId:   result.iagonFileId,
            filename: req.file.originalname,
          },
          metadata: {
            createdBy:    vpResult.viewerName || ownerCompanyDID,
            department:   vpResult.employeeRoleClaims?.department || null,
            uploadedVia:  'vp-over-rest',
            sourceFormat: (req.file.originalname || '').toLowerCase().endsWith('.docx') ? 'docx' : 'binary',
            title:        session.title,
          }
        })
      });
      if (!regRes.ok) {
        const body = await regRes.json().catch(() => ({}));
        console.warn(`[POST /upload/complete] Registry warn (${regRes.status}):`, body.message || '');
      } else {
        console.log(`[POST /upload/complete] Registered in DocumentRegistry: ${result.documentDID?.slice(0, 50)}`);
      }
    } catch (regErr) {
      console.warn('[POST /upload/complete] DocumentRegistry call failed (non-fatal):', regErr.message);
    }

    // Populate vcStore so access requests can retrieve the DEK (avoids "bad public key size" crash)
    if (result.encryptionInfo?.key && config.ADMIN_API_KEY) {
      try {
        const rawDEK = Buffer.from(result.encryptionInfo.key, 'base64');
        const wrapped = cmkStore.wrapDEK(rawDEK, session.clearanceLevel);
        rawDEK.fill(0);

        const credSubject = {
          documentDID:         result.documentDID,
          iagonFileId:         result.iagonFileId,
          wrappedKey:          wrapped.wrappedKey,
          iv:                  wrapped.iv,
          authTag:             wrapped.authTag,
          wrappingAlgorithm:   wrapped.wrappingAlgorithm,
          classificationLevel: wrapped.classificationLevel,
          fileIv:              result.encryptionInfo.iv,
          fileAuthTag:         result.encryptionInfo.authTag,
          fileAlgorithm:       result.encryptionInfo.algorithm || 'AES-256-GCM',
          releasableTo:        session.releasableTo,
          contentHash:         null
        };

        const headerB64  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payloadB64 = Buffer.from(JSON.stringify({
          vc:  { credentialSubject: credSubject },
          iat: Math.floor(Date.now() / 1000),
          iss: 'document-service-upload'
        })).toString('base64url');
        const sig    = crypto.createHmac('sha256', config.ADMIN_API_KEY).update(`${headerB64}.${payloadB64}`).digest('base64url');
        const vcJwt  = `${headerB64}.${payloadB64}.${sig}`;

        await vcStore.put(result.documentDID, { vcJwt });
        console.log(`[POST /upload/complete] Key manifest stored in vcStore for: ${result.documentDID?.slice(0, 50)}`);
      } catch (vcErr) {
        console.error('[POST /upload/complete] vcStore population failed (non-fatal):', vcErr.message);
      }
    }

    return res.status(201).json({ success: true, documentDID: result.documentDID });
  } catch (err) {
    console.error('[POST /upload/complete] createDocument failed:', err.message);
    return res.status(err.status || 500).json({ error: 'CREATE_FAILED', message: err.message });
  }
});

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

// ---------------------------------------------------------------------------
// GET /vc/key-manifest/:documentDID — fetch current VC for a document
// ---------------------------------------------------------------------------
app.get('/vc/key-manifest/:documentDID', requireAdminKey, (req, res) => {
  const documentDID = decodeURIComponent(req.params.documentDID);

  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'INVALID_DID', message: 'documentDID must start with did:' });
  }

  const record = vcStore.get(documentDID);
  if (!record) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No VC found for this documentDID' });
  }

  return res.json(record);
});

// ---------------------------------------------------------------------------
// GET /vc/key-manifest/:documentDID/history — full version chain for a document
// ---------------------------------------------------------------------------
app.get('/vc/key-manifest/:documentDID/history', requireAdminKey, (req, res) => {
  const documentDID = decodeURIComponent(req.params.documentDID);

  if (!documentDID.startsWith('did:')) {
    return res.status(400).json({ error: 'INVALID_DID', message: 'documentDID must start with did:' });
  }

  const full = vcStore.getHistory(documentDID);
  if (!full) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No VC found for this documentDID' });
  }

  return res.json({ documentDID, current: full.current, history: full.history });
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
// GET /vc/key-manifests — list all stored VCs or find one by vcId
// ---------------------------------------------------------------------------
app.get('/vc/key-manifests', requireAdminKey, (req, res) => {
  const { vcId } = req.query;
  const all = vcStore.list();

  if (vcId) {
    const match = all.find(r => r.vcId === vcId);
    if (!match) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No VC found with that vcId' });
    }
    return res.json(match);
  }

  // Return summary list (without sensitive JWT payload)
  return res.json(all.map(r => ({
    documentDID:    r.documentDID,
    vcId:           r.vcId,
    issuedAt:       r.issuedAt,
    iagonFileId:    r.claims?.iagonFileId,
    classification: r.claims?.classificationLevel
  })));
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
      requestorDID:       vpResult.companyDID || issuerDID,
      issuerDID,
      companyDID:         vpResult.companyDID,
      clearanceLevelNum,
      clearanceLevelStr:  clearanceLevelStr || getLevelLabel(clearanceLevelNum),
      ephemeralPublicKey,
      signature:          signature    || _generateNullSig(),
      ephemeralDID:       ephemeralDID || `did:key:${crypto.randomUUID()}`,
      timestamp:          timestamp    || new Date().toISOString(),
      nonce:              reqNonce     || crypto.randomUUID(),
      credentialStatuses: vpResult.credentialStatuses || [],
      docMeta,
      clientIp,
      // VP-gated direct access: the VP (with issuer-signed VCs) is the cryptographic proof.
      // The additional Ed25519 challenge-response signature is only needed when no VP is sent.
      trustedDelegation:  !signature
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
      success:        true,
      copyId:         result.copyId,
      copyHash:       result.copyHash,
      filename:       result.filename,
      mimeType:       result.mimeType,
      clearanceLevel: result.clearanceLevel,
      accessedAt:     result.accessedAt,
      // SSI-aligned: DEK re-encrypted for client's ephemeral X25519 key (nacl.box, 32 bytes only)
      encryptedDEK: {
        ciphertext:      result.ciphertext,
        nonce:           result.nonce,
        senderPublicKey: result.serverPublicKey
      },
      // Raw encrypted file from Iagon — wallet decrypts using DEK above
      encryptedBlob: result.encryptedBlob,
      fileIv:        result.fileIv,
      fileAuthTag:   result.fileAuthTag,
      fileAlgorithm: result.fileAlgorithm,
      contentHash:   result.contentHash   // wallet verifies sha256(plaintext) after decrypt
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
    trustedDelegation: true,  // VP was verified by company-admin; auth via x-ds-key
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
    success:        true,
    copyId:         result.copyId,
    copyHash:       result.copyHash,
    filename:       result.filename,
    mimeType:       result.mimeType,
    clearanceLevel: result.clearanceLevel,
    accessedAt:     result.accessedAt,
    encryptedDEK: {
      ciphertext:      result.ciphertext,
      nonce:           result.nonce,
      senderPublicKey: result.serverPublicKey
    },
    encryptedBlob: result.encryptedBlob,
    fileIv:        result.fileIv,
    fileAuthTag:   result.fileAuthTag,
    fileAlgorithm: result.fileAlgorithm,
    contentHash:   result.contentHash
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _fireAudit(url, event) {
  emitAuditEvent(url, event);
  SlackNotifier.notifyAccess(event);
  LocalAuditLog.append({
    timestamp:     new Date().toISOString(),
    event:         event.event,
    documentDID:   event.documentDID   || null,
    issuerDID:     event.issuerDID     || null,
    clearanceLevel:event.clearanceLevel|| null,
    accessGranted: event.event === 'ACCESS_GRANTED',
    denialReason:  event.denialReason  || null,
    copyId:        event.copyId        || null,
    viewerName:    event.viewerName    || null,
    clientIp:      event.clientIp      || null,
    processingMs:  event.processingMs  || null
  });
}

/** Produces a 64-byte zero signature used when the client doesn't provide one.
 *  verifySignature will fall back to format-only validation in this case. */
function _generateNullSig() {
  return Buffer.alloc(64).toString('base64');
}

// ---------------------------------------------------------------------------
// DIDComm endpoints
// ---------------------------------------------------------------------------

// Lazy-initialised singleton — populated in the startup block below
let _didcommSvc = null;

// GET /connect — returns a fresh OOB connection invitation from the service wallet
app.get('/connect', async (req, res) => {
  if (!DocumentServiceStartup.isInitialized() || !_didcommSvc) {
    return res.status(503).json({ error: 'NOT_INITIALIZED', message: 'DIDComm identity not yet initialized' });
  }
  try {
    const invitation = await _didcommSvc.createConnectionInvitation();
    return res.json({ success: true, invitation });
  } catch (err) {
    console.error('[GET /connect]', err.message);
    return res.status(500).json({ error: 'INVITATION_FAILED', message: err.message });
  }
});

// POST /didcomm-webhook — receives all DIDComm events from the multitenancy agent
app.post('/didcomm-webhook', async (req, res) => {
  // Acknowledge immediately; process asynchronously
  res.status(200).json({ received: true });

  if (!_didcommSvc) return;
  const event = req.body;
  if (!event) return;

  _didcommSvc.handleWebhookEvent(event).catch(err => {
    console.error('[POST /didcomm-webhook] Handler error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Admin UI — static files + API
// ---------------------------------------------------------------------------
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

// GET /admin/api/status — health + doc count + storage status
app.get('/admin/api/status', requireAdminKey, async (req, res) => {
  const iagonOk = !!(config.IAGON_ACCESS_TOKEN && config.IAGON_NODE_ID);
  let docCount = null;
  try {
    if (config.DOCUMENT_INDEX_FILE_ID) {
      const docs = await docSvc.listDocuments();
      docCount = docs.filter(d => d.status !== 'deleted').length;
    }
  } catch (_) { /* non-fatal */ }

  const { entries: recentLogs } = await LocalAuditLog.getEntries({ limit: 5 });

  res.json({
    healthy:    true,
    port:       config.PORT,
    docCount,
    storageConfigured: iagonOk,
    agentUrl:   config.ENTERPRISE_CLOUD_AGENT_URL,
    serviceUrl: config.DOCUMENT_SERVICE_URL,
    recentLogs
  });
});

// GET /admin/api/config — full config (masks secrets)
app.get('/admin/api/config', requireAdminKey, async (req, res) => {
  const cfg = AdminConfigStore.getCachedConfig();
  // Mask storage secrets for display
  const masked = JSON.parse(JSON.stringify(cfg));
  if (masked.storage?.iagonAccessToken) masked.storage.iagonAccessToken = masked.storage.iagonAccessToken.slice(0, 8) + '…';
  res.json({ ...masked, _env: {
    iagonConfigured: !!(config.IAGON_ACCESS_TOKEN && config.IAGON_NODE_ID),
    adminKeySet:     !!config.ADMIN_API_KEY,
    serviceUrl:      config.DOCUMENT_SERVICE_URL
  }});
});

// PUT /admin/api/config/schemas — save schema policy
app.put('/admin/api/config/schemas', requireAdminKey, async (req, res) => {
  const { schemaPolicy } = req.body;
  if (!schemaPolicy || typeof schemaPolicy !== 'object') {
    return res.status(400).json({ error: 'INVALID_BODY', message: 'schemaPolicy object required' });
  }
  const cfg = AdminConfigStore.getCachedConfig();
  cfg.schemaPolicy = schemaPolicy;
  await AdminConfigStore.save(cfg);
  res.json({ success: true });
});

// PUT /admin/api/config/storage — save storage settings and apply to runtime
app.put('/admin/api/config/storage', requireAdminKey, async (req, res) => {
  const { storage } = req.body;
  if (!storage || typeof storage !== 'object') {
    return res.status(400).json({ error: 'INVALID_BODY', message: 'storage object required' });
  }
  const cfg = AdminConfigStore.getCachedConfig();
  cfg.storage = storage;
  await AdminConfigStore.save(cfg);
  // Apply to runtime so changes take effect without restart
  if (storage.iagonAccessToken)    config.IAGON_ACCESS_TOKEN     = storage.iagonAccessToken;
  if (storage.iagonNodeId)         config.IAGON_NODE_ID          = storage.iagonNodeId;
  if (storage.iagonDownloadBaseUrl) config.IAGON_DOWNLOAD_BASE_URL = storage.iagonDownloadBaseUrl;
  res.json({ success: true });
});

// GET /admin/api/documents — list documents
app.get('/admin/api/documents', requireAdminKey, async (req, res) => {
  try {
    const docs = await docSvc.listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: 'LIST_FAILED', message: err.message });
  }
});

// GET /admin/api/logs — paginated access log
app.get('/admin/api/logs', requireAdminKey, async (req, res) => {
  const limit      = Math.min(parseInt(req.query.limit  || '50',  10), 200);
  const offset     = parseInt(req.query.offset || '0',  10);
  const documentDID= req.query.documentDID || undefined;
  const fromDate   = req.query.fromDate    || undefined;
  const toDate     = req.query.toDate      || undefined;
  let   granted    = undefined;
  if (req.query.granted === 'true')  granted = true;
  if (req.query.granted === 'false') granted = false;

  try {
    const result = await LocalAuditLog.getEntries({ limit, offset, documentDID, granted, fromDate, toDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'LOG_READ_FAILED', message: err.message });
  }
});

// POST /admin/api/storage/test — test Iagon connectivity with given creds
app.post('/admin/api/storage/test', requireAdminKey, async (req, res) => {
  const { iagonAccessToken, iagonNodeId, iagonDownloadBaseUrl } = req.body;
  const testConfig = {
    ...config,
    IAGON_ACCESS_TOKEN:     iagonAccessToken    || config.IAGON_ACCESS_TOKEN,
    IAGON_NODE_ID:          iagonNodeId         || config.IAGON_NODE_ID,
    IAGON_DOWNLOAD_BASE_URL:iagonDownloadBaseUrl|| config.IAGON_DOWNLOAD_BASE_URL
  };
  try {
    const { IagonStorageClient } = require('./lib/IagonStorageClient');
    const client = new IagonStorageClient(testConfig);
    const result = await client.testConnection();
    res.json({ success: result.success, message: result.message || 'Connected' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Test injection endpoint removed — it accepted HMAC-signed JWTs alongside real ES256K VCs,
// creating a production authentication bypass if TEST_BYPASS_KEY was set.
// For integration testing, issue real EdDSA-signed DocumentKeyManifest VCs via company-admin.

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  // Load VC key-manifest store and admin config before accepting requests
  await vcStore.load();
  await AdminConfigStore.load();

  // Initialize DIDComm identity (wallet + webhook registration — non-fatal if agent unavailable)
  await DocumentServiceStartup.initialize({
    DOC_SERVICE_AGENT_URL: process.env.DOC_SERVICE_AGENT_URL || config.ENTERPRISE_CLOUD_AGENT_URL,
    DOCUMENT_SERVICE_URL:  config.DOCUMENT_SERVICE_URL
  }).catch(err => console.warn('[startup] DIDComm identity init failed (non-fatal):', err.message));

  const svcApiKey = DocumentServiceStartup.getApiKey();
  const svcAgentUrl = DocumentServiceStartup.getAgentUrl();
  if (svcApiKey) {
    _didcommSvc = new DocumentDIDCommService({
      agentUrl: svcAgentUrl,
      apiKey:   svcApiKey,
      docSvc
    });
    console.log('[identus-document-service] DIDComm service ready');
  }

  app.listen(config.PORT, () => {
    console.log(`[identus-document-service] Listening on port ${config.PORT}`);
    console.log(`[identus-document-service] Cloud Agent: ${config.ENTERPRISE_CLOUD_AGENT_URL}`);
    console.log(`[identus-document-service] Iagon configured: ${!!(config.IAGON_ACCESS_TOKEN && config.IAGON_NODE_ID)}`);
    console.log(`[identus-document-service] VC key-manifest store: ${vcStore.size()} entries loaded`);
  });
})();

module.exports = app; // for testing
