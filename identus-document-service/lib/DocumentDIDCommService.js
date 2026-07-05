'use strict';

/**
 * DocumentDIDCommService.js — DIDComm message handler for document lifecycle flows.
 *
 * Handles document lifecycle protocol flows:
 *   A. Upload:          wallet → service (upload request + VP) → service creates DID + manifest
 *   B. Branch/Update:   wallet → service (branch request + VP) → service creates new version DID
 *   C. Custody Transfer:wallet → service (transfer request)    → service updates manifest publisherDID
 *
 * Access (D) has been migrated onto the shared service-access/1.0 protocol (see
 * packages/service-access-didcomm/PROTOCOL.md and this file's `serviceAccessSvc`) — it is no
 * longer a bespoke document-access/1.0 flow. Upload/Branch/Custody-Transfer remain on their own
 * protocols below since they are mutation flows, not "prove VP → get a bounded grant" flows.
 *
 * All flows use RequestPresentation for VP proof collection (existing SDK flow).
 *
 * Protocol URIs:
 *   upload:   https://identuslabel.cz/protocols/document-upload/1.0/request
 *   branch:   https://identuslabel.cz/protocols/document-upload/1.0/branch
 *   transfer: https://identuslabel.cz/protocols/document-custody/1.0/transfer
 *   access:   https://identuslabel.cz/protocols/service-access/1.0/request  (capability: "document-access")
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const { ServiceAccessService, CapabilityError, createTrustRegistry, createIssuerResolver, PROTOCOL_PREFIX: SERVICE_ACCESS_PREFIX } = require('service-access-didcomm');
const { DocumentService }    = require('./DocumentService');
const { verifyVPAndExtractClaims } = require('./VPVerificationService');
const { resolveDocumentDEK, getLevelNumber } = require('./ReEncryptionService');
const DeliveryAuditLog       = require('./DeliveryAuditLog');
const { resolveDocumentDID } = require('./DIDDocumentResolver');
const vcStore                = require('./VCKeyStore');
const config                 = require('../config');

// Shared, fail-closed trust registry — used for BOTH the new document-access capability below
// and the pre-existing upload/branch trust check (which used to import a local, fail-OPEN
// TrustRegistry.js; see packages/service-access-didcomm/lib/TrustRegistry.js's fail-closed fix).
// Same env vars as before: TRUSTED_CA_DID (SecurityClearanceGrant), TRUSTED_COMPANY_ADMIN_DIDS
// (EmployeeRole, comma-separated).
const employeeRoleTrustRegistry = createTrustRegistry([
  ...(process.env.TRUSTED_CA_DID ? [{ did: process.env.TRUSTED_CA_DID, vcTypes: ['SecurityClearanceGrant'] }] : []),
  ...(process.env.TRUSTED_COMPANY_ADMIN_DIDS || '').split(',').map(d => d.trim()).filter(Boolean)
    .map(did => ({ did, vcTypes: ['EmployeeRole'] })),
]);

// In-memory pending operation store: requestId → { type, connectionId, data, expiresAt }
const _pending = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pending.entries()) {
    if (entry.expiresAt < now) _pending.delete(id);
  }
}, 60_000);

class DocumentDIDCommService {
  /**
   * @param {object} opts
   * @param {string} opts.agentUrl         multitenancy agent base URL
   * @param {string} opts.apiKey           service wallet API key
   * @param {DocumentService} opts.docSvc  document service instance
   */
  constructor({ agentUrl, apiKey, docSvc }) {
    this.agentUrl = agentUrl;
    this.apiKey   = apiKey;
    this.docSvc   = docSvc;

    this.serviceAccessSvc = new ServiceAccessService({
      cloudAgentUrl: agentUrl,
      apiKey,
      publicBaseUrl: config.DOCUMENT_SERVICE_URL,
      verifiedEventAdapter: 'webhook', // this service already reacts to a real PresentationVerified push event
      // The multitenancy agent's webhook payloads already carry connectionId directly (see
      // _handleBasicMessage below) — there is no separate fromDid→connectionId lookup needed
      // the way CA/company-admin need one, so this is an identity passthrough rather than a
      // real resolver.
      async resolveConnection(connectionId) { return connectionId; },
      resolveIssuerDID: createIssuerResolver({ cloudAgentUrl: agentUrl, apiKey }),
      trustRegistry: employeeRoleTrustRegistry,
      capabilities: {
        'document-access': {
          label: 'Document Access', icon: '📄', mode: 'payload',
          trustedIssuerVcType: 'EmployeeRole',
          proofSpec: {
            proofs: [{ schemaId: '', trustIssuers: [] }],
            goalCode: 'document.access',
            goal: 'Please verify your credentials to access this document',
            claims: {},
            domain: 'identuslabel.cz'
          },
          buildResult: async ({ credentials, connectionId, requestBody }) => {
            const documentDID = requestBody?.documentDID;
            if (!documentDID || !documentDID.startsWith('did:')) {
              throw new CapabilityError('MISSING_DID', 'Access request must include documentDID');
            }

            let docMeta;
            try {
              docMeta = await resolveDocumentDID(documentDID);
            } catch (_) {
              throw new CapabilityError('DOCUMENT_NOT_FOUND', `Document DID not found: ${documentDID}`);
            }

            // Reproduces the enterprise-vs-personal classification that
            // VPVerificationService.verifyVPAndExtractClaims used to do — now operating on
            // `credentials`, which the shared library has already cryptographically verified.
            const employeeRoleCred = credentials.find(c => c.claims?.role !== undefined && c.claims?.department !== undefined);
            const clearanceCred    = credentials.find(c => c.claims?.clearanceLevel !== undefined);
            if (!employeeRoleCred && !clearanceCred) {
              throw new CapabilityError('NoUsableCredential', 'VP must contain an EmployeeRole or SecurityClearance credential');
            }

            const issuerDID = employeeRoleCred
              ? (employeeRoleCred.claims?.issuerDID || employeeRoleCred.issuerDID)
              : clearanceCred.issuerDID;
            const companyDID = employeeRoleCred ? issuerDID : null;
            const clearanceLevelStr = clearanceCred?.claims.clearanceLevel || null;
            const clearanceLevelNum = getLevelNumber(clearanceLevelStr || 'UNCLASSIFIED');
            const credentialSubjectDID = credentials.find(c => c.subjectDID)?.subjectDID || null;
            const credentialStatuses = credentials.map(c => c.credentialStatus).filter(Boolean);

            const result = await resolveDocumentDEK({
              documentDID, companyDID, clearanceLevelNum, credentialStatuses, docMeta
            });
            if (!result.success) throw new CapabilityError(result.error, result.message);

            const deliveryId = crypto.randomUUID();
            DeliveryAuditLog.append({
              deliveryId, documentDID,
              holderDID: credentialSubjectDID || issuerDID,
              connectionId,
              sections: [{ id: 's0', clearanceLevel: docMeta.clearanceLevel }]
            });

            console.log(`[DocumentDIDCommService] Access grant built. deliveryId=${deliveryId} doc=${documentDID.slice(0, 40)}...`);

            return {
              documentDID, deliveryId,
              // Iagon download URL — wallet fetches encrypted blob directly. Embedded in-band
              // here rather than as a DIDComm-level attachment (the old document-access/1.0/grant
              // used one) since the generic service-access/1.0 grant envelope doesn't define an
              // attachments field; the wallet's document consumer needs updating to read this
              // from `grant.body.result` instead — tracked as follow-up wallet work.
              iagonDownloadUrl: `${config.IAGON_DOWNLOAD_BASE_URL}/storage/download?fileId=${result.iagonFileId}`,
              sections: [{
                id: 's0', clearanceLevel: docMeta.clearanceLevel,
                dek: result.dek, fileIv: result.fileIv, fileAuthTag: result.fileAuthTag,
                fileAlgorithm: result.fileAlgorithm, contentHash: result.contentHash
              }]
            };
          }
        }
      }
    });
  }

  // ── Public entry point ─────────────────────────────────────────────────────

  /**
   * Process a raw webhook event from the multitenancy agent.
   * Returns true if the event was handled, false if ignored.
   */
  async handleWebhookEvent(event) {
    const { type } = event;

    if (type === 'BasicMessageReceived') {
      return this._handleBasicMessage(event);
    }
    if (type === 'PresentationVerified') {
      // Try the shared service-access/1.0 handler first — it only claims events for which it
      // actually has a pending "document-access" request (matched by presentationId), so this
      // is safe to attempt unconditionally before falling through to the upload/branch path.
      if (await this.serviceAccessSvc.handleWebhookEvent(event)) return true;
      return this._handlePresentationVerified(event);
    }
    // Connection events, other types — ignore
    return false;
  }

  // ── OOB Connection invitation ──────────────────────────────────────────────

  async createConnectionInvitation() {
    const data = await this._agentFetch('/connections', {
      method: 'POST',
      body:   JSON.stringify({ label: 'Document Service', goalCode: 'document-access' })
    });
    return data;
  }

  // ── Private: BasicMessage handler ─────────────────────────────────────────

  async _handleBasicMessage(event) {
    const { connectionId, content } = event;
    if (!content) return false;

    let envelope;
    try {
      envelope = JSON.parse(content);
    } catch (_) { return false; }

    if (!envelope?.type?.startsWith('https://identuslabel.cz/protocols/')) return false;
    const { type, id: requestId, body = {} } = envelope;

    if (type === 'https://identuslabel.cz/protocols/document-upload/1.0/request') {
      await this._handleUploadRequest(connectionId, requestId, body, envelope.attachments);
      return true;
    }
    if (type === 'https://identuslabel.cz/protocols/document-upload/1.0/branch') {
      await this._handleBranchRequest(connectionId, requestId, body, envelope.attachments);
      return true;
    }
    if (type === `${SERVICE_ACCESS_PREFIX}/request`) {
      // connectionId is already known here (from the webhook payload) — see the constructor's
      // resolveConnection note for why this is an identity passthrough, not a real DID lookup.
      await this.serviceAccessSvc.handleIncomingMessage(connectionId, content);
      return true;
    }
    if (type === 'https://identuslabel.cz/protocols/document-custody/1.0/transfer') {
      await this._handleCustodyTransfer(connectionId, requestId, body);
      return true;
    }

    console.warn(`[DocumentDIDCommService] Unhandled protocol: ${type}`);
    return false;
  }

  // ── Flow A: Upload ─────────────────────────────────────────────────────────

  async _handleUploadRequest(connectionId, requestId, body, attachments) {
    const fileAttachment = (attachments || []).find(a => a.id === 'file' || a.mediaType);
    if (!fileAttachment?.data?.base64) {
      return this._sendError(connectionId, requestId, 'document-upload/1.0', 'MISSING_ATTACHMENT',
        'Upload request must include a file attachment with base64 data');
    }

    const uploadData = {
      fileBuffer:       Buffer.from(fileAttachment.data.base64, 'base64'),
      originalFilename: body.filename || 'document',
      mimeType:         fileAttachment.mediaType || 'application/octet-stream',
      title:            body.title || 'Untitled',
      clearanceLevel:   body.clearanceLevel || 'INTERNAL',
      releasableTo:     body.releasableTo || [],
      department:       body.department || null
    };

    // Request VP proof to verify sender identity (SSI-compliant path)
    _pending.set(requestId, {
      type:         'upload',
      connectionId,
      data:         uploadData,
      expiresAt:    Date.now() + PENDING_TTL_MS
    });

    await this._requestPresentation(connectionId, requestId, {
      goalCode: 'document.upload',
      comment:  `Upload verification for: ${body.title || 'document'}`
    });
  }

  // ── Flow B: Branch/Update ──────────────────────────────────────────────────

  async _handleBranchRequest(connectionId, requestId, body, attachments) {
    const parentDID = body.parentDocumentDID;
    if (!parentDID || !parentDID.startsWith('did:')) {
      return this._sendError(connectionId, requestId, 'document-upload/1.0', 'MISSING_PARENT_DID',
        'Branch request must include parentDocumentDID');
    }

    const fileAttachment = (attachments || []).find(a => a.id === 'file' || a.mediaType);
    if (!fileAttachment?.data?.base64) {
      return this._sendError(connectionId, requestId, 'document-upload/1.0', 'MISSING_ATTACHMENT',
        'Branch request must include a file attachment with base64 data');
    }

    // Resolve parent to inherit metadata defaults
    let parentMeta;
    try {
      parentMeta = await resolveDocumentDID(parentDID);
    } catch (_) {
      return this._sendError(connectionId, requestId, 'document-upload/1.0', 'PARENT_NOT_FOUND',
        `Parent document DID not found: ${parentDID}`);
    }

    _pending.set(requestId, {
      type:         'branch',
      connectionId,
      data: {
        fileBuffer:       Buffer.from(fileAttachment.data.base64, 'base64'),
        originalFilename: body.filename || 'document',
        mimeType:         fileAttachment.mediaType || 'application/octet-stream',
        title:            body.title || parentMeta.title || 'Untitled',
        clearanceLevel:   body.clearanceLevel || parentMeta.clearanceLevel || 'INTERNAL',
        releasableTo:     body.releasableTo   || parentMeta.releasableTo   || [],
        department:       body.department     || parentMeta.department     || null,
        previousVersion:  parentDID,
        publisherDID:     null
      },
      expiresAt: Date.now() + PENDING_TTL_MS
    });

    await this._requestPresentation(connectionId, requestId, {
      goalCode: 'document.branch',
      comment:  `Branch verification for parent: ${parentDID.slice(0, 40)}...`
    });
  }

  // Flow D (Access) moved to the shared ServiceAccessService — see constructor's
  // `capabilities['document-access']` and handleWebhookEvent's delegation above.

  // ── Flow C: Custody Transfer ───────────────────────────────────────────────

  async _handleCustodyTransfer(connectionId, requestId, body) {
    const { documentDID, newOwnerDID } = body;
    if (!documentDID?.startsWith('did:') || !newOwnerDID?.startsWith('did:')) {
      return this._sendError(connectionId, requestId, 'document-custody/1.0', 'MISSING_FIELDS',
        'Transfer request must include documentDID and newOwnerDID');
    }

    // Find current publisherDID from VC store
    const vcRecord = vcStore.get(documentDID);
    if (!vcRecord) {
      return this._sendError(connectionId, requestId, 'document-custody/1.0', 'MANIFEST_NOT_FOUND',
        `No key manifest found for document: ${documentDID}`);
    }

    const currentPublisher = vcRecord.claims?.publisherDID || null;
    // Resolve connection to get holderDID
    const holderDID = await this._resolveHolderDID(connectionId);

    if (currentPublisher && holderDID && !_prismDidsMatch(currentPublisher, holderDID)) {
      return this._sendError(connectionId, requestId, 'document-custody/1.0', 'NOT_AUTHORIZED',
        'Only the current document owner can transfer custody');
    }

    // Update manifest publisherDID (update the stored VC record)
    const updatedRecord = { ...vcRecord, claims: { ...vcRecord.claims, publisherDID: newOwnerDID } };
    await vcStore.set(documentDID, updatedRecord);

    console.log(`[DocumentDIDCommService] Custody transferred: ${documentDID.slice(0, 40)}... → ${newOwnerDID.slice(0, 40)}...`);

    await this._send(connectionId, JSON.stringify({
      type:  'https://identuslabel.cz/protocols/document-custody/1.0/transferred',
      thid:  requestId,
      id:    crypto.randomUUID(),
      body:  { documentDID, newOwnerDID, timestamp: new Date().toISOString() }
    }));
  }

  // ── PresentationVerified handler ───────────────────────────────────────────

  async _handlePresentationVerified(event) {
    const { presentationId, connectionId, presentation } = event;
    // Match against pending operations by thid (requestId stored in pending)
    const pending = this._findPendingByPresentationId(presentationId, connectionId);
    if (!pending) {
      console.warn(`[DocumentDIDCommService] No pending op for presentationId=${presentationId}`);
      return false;
    }

    const { requestId, entry } = pending;
    _pending.delete(requestId);

    // Extract VCs from presentation and verify
    const vp = presentation?.verifiablePresentation || presentation || {};
    const vpResult = await verifyVPAndExtractClaims(vp, []);
    if (!vpResult.success) {
      console.warn(`[DocumentDIDCommService] VP verification failed: ${vpResult.error}`);
      await this._sendError(entry.connectionId, requestId, entry.type.split('/')[0] + '/1.0',
        vpResult.error, vpResult.message);
      return true;
    }

    // Trust registry check (shared, fail-closed registry — see top of file)
    if (!employeeRoleTrustRegistry.isTrustedIssuer(vpResult.issuerDID, 'EmployeeRole')) {
      await this._sendError(entry.connectionId, requestId, 'document/1.0', 'UNTRUSTED_ISSUER',
        'EmployeeRole credential issuer is not in the trusted registry');
      return true;
    }

    // Only 'upload'/'branch' pending entries reach this local _pending map now — 'access'
    // requests are handled entirely by this.serviceAccessSvc (see handleWebhookEvent above).
    await this._completeUpload(requestId, entry, vpResult);

    return true;
  }

  // ── Complete upload after VP verified ─────────────────────────────────────

  async _completeUpload(requestId, entry, vpResult) {
    const { data, connectionId } = entry;
    data.publisherDID = vpResult.credentialSubjectDID || vpResult.issuerDID;

    let result;
    try {
      if (entry.type === 'branch') {
        result = await this.docSvc.updateDocument(data.previousVersion, data);
        console.log(`[DocumentDIDCommService] Branch created: ${result.newDocumentDID?.slice(0, 40)}...`);
      } else {
        result = await this.docSvc.createDocument(data);
        console.log(`[DocumentDIDCommService] Document created: ${result.documentDID?.slice(0, 40)}...`);
      }
    } catch (err) {
      console.error('[DocumentDIDCommService] Upload/branch failed:', err.message);
      return this._sendError(connectionId, requestId, 'document-upload/1.0', 'CREATE_FAILED', err.message);
    }

    const documentDID = result.newDocumentDID || result.documentDID;
    await this._send(connectionId, JSON.stringify({
      type: 'https://identuslabel.cz/protocols/document-upload/1.0/complete',
      thid: requestId,
      id:   crypto.randomUUID(),
      body: {
        documentDID,
        parentDocumentDID: result.parentDocumentDID || null,
        status:    'published',
        createdAt: result.createdAt
      }
    }));
  }

  // Access grant-building moved to the shared ServiceAccessService's `document-access`
  // capability `buildResult` — see constructor.

  // ── Private helpers ────────────────────────────────────────────────────────

  _findPendingByPresentationId(presentationId, connectionId) {
    for (const [requestId, entry] of _pending.entries()) {
      if (entry.connectionId === connectionId) {
        return { requestId, entry };
      }
    }
    return null;
  }

  async _requestPresentation(connectionId, thid, opts = {}) {
    try {
      await this._agentFetch('/present-proof/presentations', {
        method: 'POST',
        body:   JSON.stringify({
          connectionId,
          proofType:   ['JWT'],
          anoncredPresentationRequest: null,
          options: {
            challenge: crypto.randomUUID(),
            domain:    'identuslabel.cz'
          }
        })
      });
    } catch (err) {
      console.warn('[DocumentDIDCommService] RequestPresentation failed:', err.message);
    }
  }

  async _send(connectionId, content) {
    try {
      await this._agentFetch(`/connections/${connectionId}/basic-messages`, {
        method: 'POST',
        body:   JSON.stringify({ content })
      });
    } catch (err) {
      console.warn('[DocumentDIDCommService] Send failed:', err.message);
    }
  }

  async _sendError(connectionId, thid, protocolBase, errorCode, message) {
    await this._send(connectionId, JSON.stringify({
      type: `https://identuslabel.cz/protocols/${protocolBase}/error`,
      thid,
      id:   crypto.randomUUID(),
      body: { error: errorCode, message }
    }));
  }

  async _resolveHolderDID(connectionId) {
    try {
      const data = await this._agentFetch(`/connections/${connectionId}`);
      return data.theirDid || null;
    } catch (_) {
      return null;
    }
  }

  async _agentFetch(urlPath, options = {}) {
    const url     = `${this.agentUrl}${urlPath}`;
    const headers = { 'Content-Type': 'application/json', apikey: this.apiKey };
    const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) }, timeout: 15000 });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${options.method || 'GET'} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : {};
  }
}

function _prismDidsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const hashOf = d => d.startsWith('did:prism:') ? d.split(':')[2] : null;
  const ha = hashOf(a), hb = hashOf(b);
  return ha && hb && ha === hb;
}

module.exports = { DocumentDIDCommService };
