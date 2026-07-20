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
const { resolveDocumentDEK, encryptForEphemeralKey, getLevelNumber } = require('./ReEncryptionService');
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

    // deliveryId → { documentDID, token, expiresAt }. Gates GET /document-blob: the blob URL in a
    // grant carries a fresh high-entropy token, and the grant itself is only released over the
    // accessToken-protected /access-grant-status poll — so the blob token never appears in an
    // enumerable/guessable position. Serves the (still-encrypted) blob only to a caller holding it.
    const blobGrants = new Map();
    const registerBlobGrant = (deliveryId, documentDID) => {
      const token = crypto.randomBytes(24).toString('base64url');
      blobGrants.set(deliveryId, { documentDID, token, expiresAt: Date.now() + 10 * 60 * 1000 });
      return token;
    };
    // Exposed for GET /document-blob (server.js): returns { documentDID } iff the token matches.
    this.checkBlobToken = (deliveryId, token) => {
      const g = blobGrants.get(deliveryId);
      if (!g) return null;
      if (Date.now() > g.expiresAt) { blobGrants.delete(deliveryId); return null; }
      if (typeof token !== 'string' || token.length !== g.token.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(g.token))) return null;
      return { documentDID: g.documentDID };
    };

    this.serviceAccessSvc = new ServiceAccessService({
      cloudAgentUrl: agentUrl,
      apiKey,
      publicBaseUrl: config.DOCUMENT_SERVICE_URL,
      // 'polling', NOT 'webhook' — same as company-admin. The custom Cloud Agent's presentation
      // webhook envelope is { type: 'PresentationUpdated', data: { status, presentationId, ... } }
      // (see PresentationServiceNotifier.scala), which never matches the library's top-level
      // 'PresentationVerified' check — the grant was never built. Polling the presentation
      // record by id is the code path proven live by the employee-portal login flow.
      verifiedEventAdapter: 'polling',
      // _handleBasicMessage resolves the connectionId from the webhook payload's sender DID
      // (`data.from`) BEFORE delegating to handleIncomingMessage, so by the time this resolver
      // runs it already receives a real connectionId — identity passthrough is correct here.
      async resolveConnection(connectionId) { return connectionId; },
      resolveIssuerDID: createIssuerResolver({ cloudAgentUrl: agentUrl, apiKey }),
      trustRegistry: employeeRoleTrustRegistry,
      capabilities: {
        'document-access': {
          label: 'Document Access', icon: '📄', mode: 'payload',
          trustedIssuerVcType: 'EmployeeRole',
          proofSpec: {
            // proofs MUST be [] — same as company-admin's employee-portal capability. The VP
            // carries multiple VCs (EmployeeRole + CISTraining + SecurityClearanceGrant) whose
            // schemas/issuers differ; a proofs entry makes the Cloud Agent enforce its post-hoc
            // per-credential schemaId check against EVERY credential in the VP (verified live:
            // schemaId '' → expectedSchemaIds List("") → PresentationVerificationFailed for all).
            // Issuer trust is enforced post-verification instead: the shared library's DID-keyed
            // trust registry (EmployeeRole) + buildResult's clearance-issuer and releasableTo checks.
            proofs: [],
            goalCode: 'document.access',
            goal: 'Present your Employee Role and Security Clearance credentials to access this document',
            claims: {},
            domain: 'identuslabel.cz'
          },
          buildResult: async ({ credentials, connectionId, requestBody }) => {
            const documentDID = requestBody?.documentDID;
            if (!documentDID || !documentDID.startsWith('did:')) {
              throw new CapabilityError('MISSING_DID', 'Access request must include documentDID');
            }
            // The DEK must never leave the service in cleartext. The grant is delivered over an
            // HTTP-pollable transport keyed only by a request id (see /access-grant-status), so a
            // cleartext DEK would be exposed to anyone who learns that id. Require the requester's
            // ephemeral X25519 public key and nacl.box the DEK to it — only the holder of the
            // matching ephemeral secret (the wallet that made the request) can open it.
            const ephemeralPublicKey = requestBody?.ephemeralPublicKey;
            if (!ephemeralPublicKey || typeof ephemeralPublicKey !== 'string') {
              throw new CapabilityError('MISSING_EPHEMERAL_KEY', 'Access request must include ephemeralPublicKey (base64 X25519)');
            }

            let docMeta;
            try {
              docMeta = await resolveDocumentDID(documentDID);
            } catch (_) {
              throw new CapabilityError('DOCUMENT_NOT_FOUND', `Document DID not found: ${documentDID}`);
            }

            // Releasability policy (July 2026): the EmployeeRole VC is MANDATORY on this path —
            // its issuer (the employing company) is what `releasableTo` is checked against inside
            // resolveDocumentDEK. The SecurityClearance VC contributes the clearance LEVEL only;
            // its issuer is deliberately NOT checked against releasableTo (clearances are issued
            // by the CA, not by the employing company), but it must still come from a trusted
            // clearance authority — otherwise a self-issued clearanceLevel claim would pass
            // cryptographic verification and grant arbitrary levels.
            // (`credentials` have already been cryptographically verified by the shared library.)
            const employeeRoleCred = credentials.find(c => c.claims?.role !== undefined && c.claims?.department !== undefined);
            if (!employeeRoleCred) {
              throw new CapabilityError('MISSING_EMPLOYEE_ROLE',
                'Document access requires an EmployeeRole credential — its issuer is checked against the document releasability list');
            }
            const clearanceCred = credentials.find(c => c.claims?.clearanceLevel !== undefined);

            // SECURITY: the "company" for both the releasableTo check and the clearance
            // same-company check is the CRYPTOGRAPHICALLY-VERIFIED issuer of the EmployeeRole
            // (`payload.iss`, whose ES256K signature the shared library already validated) — NOT
            // the credential's self-asserted, unsigned `claims.issuerDID`. Trusting the embedded
            // value would let a holder assert any company DID and match any releasableTo list, and
            // it breaks the same-company clearance check whenever the two disagree (observed live:
            // an EmployeeRole signed by TechCorp 6ee757c2 but claiming issuerDID = ACME 474c9151,
            // presented alongside a TechCorp-signed SecurityClearanceGrant → false mismatch).
            // Document releasableTo lists are populated with the verified issuer DID, so this is
            // also what makes access resolve correctly.
            const companyDID = employeeRoleCred.issuerDID;

            // PRISM DIDs compare by hash segment (short vs long form carry the same hash).
            const prismHash = d => (typeof d === 'string' && d.startsWith('did:prism:')) ? d.split(':')[2] : d;
            let clearanceLevelStr = null;
            if (clearanceCred) {
              const clearanceIssuer = clearanceCred.issuerDID;
              const clearanceTrusted =
                employeeRoleTrustRegistry.isTrustedIssuer(clearanceIssuer, 'SecurityClearanceGrant') ||
                prismHash(clearanceIssuer) === prismHash(companyDID); // company-issued SecurityClearanceGrant
              if (!clearanceTrusted) {
                throw new CapabilityError('UNTRUSTED_CLEARANCE_ISSUER',
                  'Security clearance credential was not issued by a trusted clearance authority');
              }
              clearanceLevelStr = clearanceCred.claims.clearanceLevel || null;
            }
            const clearanceLevelNum = getLevelNumber(clearanceLevelStr || 'UNCLASSIFIED');
            const credentialSubjectDID = credentials.find(c => c.subjectDID)?.subjectDID || null;
            const credentialStatuses = credentials.map(c => c.credentialStatus).filter(Boolean);

            // Releasability is checked against every verified credential issuer in the VP, not
            // just the EmployeeRole's — same rule as VPVerificationService's HTTP /access path.
            const verifiedIssuerDIDs = [...new Set(credentials.map(c => c.issuerDID).filter(Boolean))];

            console.log(`[DocumentDIDCommService] DEK decision: doc=${documentDID.slice(0,40)} companyDID=${prismHash(companyDID)?.slice(0,12)} clearance=${clearanceLevelStr}(${clearanceLevelNum}) docLevel=${docMeta.clearanceLevel} releasableTo=[${(docMeta.releasableTo||[]).map(d=>prismHash(d)?.slice(0,10)).join(',')}]`);
            const result = await resolveDocumentDEK({
              documentDID, companyDID, verifiedIssuerDIDs, clearanceLevelNum, credentialStatuses, docMeta
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

            // nacl.box the raw DEK to the requester's ephemeral key. The wallet recovers it with
            // nacl.box.open(secretKey), then AES-GCM-decrypts the Iagon blob.
            const encryptedDEK = encryptForEphemeralKey(
              new Uint8Array(Buffer.from(result.dek, 'base64')),
              ephemeralPublicKey
            );

            return {
              documentDID, deliveryId,
              // Download URL for the encrypted blob. MUST be the document-service same-origin proxy
              // (GET /document-blob), NOT the raw gw.iagon.com URL: Iagon's download is a POST that
              // requires an x-api-key header and is cross-origin, so a browser fetch of the raw URL
              // fails with a CORS "Failed to fetch". The proxy runs the authenticated download
              // server-side and streams back the still-encrypted bytes. The wallet's document
              // consumer reads this from `grant.body.result` and AES-GCM-decrypts with the DEK.
              // The URL carries a fresh per-delivery token so the endpoint isn't a DID-enumerable
              // open proxy; the token is confidential because the grant is only released over the
              // accessToken-protected /access-grant-status poll.
              iagonDownloadUrl: `${config.DOCUMENT_SERVICE_URL}/document-blob?deliveryId=${deliveryId}&token=${registerBlobGrant(deliveryId, documentDID)}`,
              sections: [{
                id: 's0', clearanceLevel: docMeta.clearanceLevel,
                // DEK is nacl.box-encrypted to the requester's ephemeral key (never cleartext).
                encryptedDEK,
                fileIv: result.fileIv, fileAuthTag: result.fileAuthTag,
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
    // The custom Cloud Agent wraps presentation state changes as
    //   { type: 'PresentationUpdated', data: { status: 'PresentationVerified', presentationId, ... } }
    // — normalize to the flat shape the handlers below expect. (The service-access flow itself
    // uses the polling adapter and doesn't depend on this event; this feeds the upload/branch path.)
    if (type === 'PresentationUpdated' && event.data?.status === 'PresentationVerified') {
      const normalized = { ...event.data, type: event.data.status };
      if (await this.serviceAccessSvc.handleWebhookEvent(normalized)) return true;
      return this._handlePresentationVerified(normalized);
    }
    if (type === 'PresentationVerified') {
      // Flat-shape fallback (kept for compatibility with any direct/manual event injection).
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
    // The custom Cloud Agent build's webhook envelope is
    //   { type: 'BasicMessageReceived', id, ts, data: { id, content, from, to, sentTime }, walletId }
    // — there is NO top-level content and NO connectionId anywhere in the payload (see
    // custom-cloud-agent DIDCommControllerImpl.scala `BasicMessageReceived`). This handler
    // previously destructured { connectionId, content } off the top-level event and silently
    // dropped every message. Mirror the CA's working handler: read event.data, unwrap the
    // wallet's StandardMessageBody nesting, and resolve connectionId from the sender's DID.
    const data = event.data || event;
    let content = data.content;
    if (!content) return false;

    // Wallets may wrap messages in StandardMessageBody: {"content":"...","timestamp":...}
    try {
      const stdBody = JSON.parse(content);
      if (stdBody && typeof stdBody.content === 'string') content = stdBody.content;
    } catch (_) { /* not JSON at this layer — use as-is */ }

    let envelope;
    try {
      envelope = JSON.parse(content);
    } catch (_) { return false; }

    const connectionId = event.connectionId || await this._resolveConnectionIdByTheirDid(data.from);
    if (!connectionId) {
      console.warn(`[DocumentDIDCommService] BasicMessage from unknown sender — no connection matches theirDid=${(data.from || '').slice(0, 60)}...`);
      return false;
    }

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
      // connectionId was resolved from the sender DID above — the shared library's
      // resolveConnection is an identity passthrough (see constructor note).
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

  // Resolve a connectionId from the sender's peer DID (webhook BasicMessageReceived events
  // carry `from`, never a connectionId). Newest match wins — each fresh invitation produces a
  // distinct peer DID pair, but be defensive about duplicates.
  async _resolveConnectionIdByTheirDid(theirDid) {
    if (!theirDid) return null;
    try {
      const data = await this._agentFetch('/connections?limit=1000');
      const matches = (data.contents || [])
        .filter(c => c.theirDid === theirDid)
        .sort((a, b) => String(a.updatedAt || a.createdAt || '').localeCompare(String(b.updatedAt || b.createdAt || '')));
      return matches.length > 0 ? matches[matches.length - 1].connectionId : null;
    } catch (e) {
      console.error('[DocumentDIDCommService] Connection lookup by theirDid failed:', e.message);
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
