'use strict';

/**
 * DocumentService.js
 *
 * Orchestrates the full document lifecycle for identus-document-service:
 *   Create  — encrypt → Iagon upload → PRISM DID creation + publication
 *   Read    — thin wrapper over DIDDocumentResolver
 *   List    — Iagon-backed JSON index (DOCUMENT_INDEX_FILE_ID)
 *   Update  — new DID version + annotate old DID with #superseded-by
 *   Delete  — Iagon file removal + DID soft-tombstone
 *
 * Stateless by design: all persistent state lives in PRISM DIDs and Iagon.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const { IagonStorageClient } = require('./IagonStorageClient');
const { resolveDocumentDID } = require('./DIDDocumentResolver');

const VALID_CLEARANCE_LEVELS = ['UNCLASSIFIED', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP-SECRET'];

class DocumentService {
  constructor(config) {
    this.config = config;
    this.iagon  = new IagonStorageClient({
      accessToken:     config.IAGON_ACCESS_TOKEN,
      nodeId:          config.IAGON_NODE_ID,
      downloadBaseUrl: config.IAGON_DOWNLOAD_BASE_URL
    });

    // In-process async mutex: serialises concurrent index writes
    this._indexMutex        = Promise.resolve();
    this._currentIndexFileId = config.DOCUMENT_INDEX_FILE_ID || null;
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────

  /**
   * Full create flow:
   *   encrypt → Iagon upload (file + key manifest) → build DID services → create + publish PRISM DID
   *
   * @param {object} params
   * @param {Buffer}   params.fileBuffer
   * @param {string}   params.originalFilename
   * @param {string}   params.mimeType
   * @param {string}   params.title
   * @param {string}   [params.description]
   * @param {string}   [params.documentType]
   * @param {string}   params.clearanceLevel    INTERNAL|CONFIDENTIAL|RESTRICTED|TOP-SECRET
   * @param {string[]} params.releasableTo       Array of issuer DIDs
   * @param {string}   [params.department]
   * @param {string}   [params.auditWebhookUrl]
   * @returns {Promise<object>}
   */
  async createDocument(params) {
    const {
      fileBuffer,
      originalFilename,
      mimeType,
      title,
      clearanceLevel,
      releasableTo,
      department,
      auditWebhookUrl
    } = params;

    // Validate inputs
    if (!fileBuffer || !fileBuffer.length) {
      throw _clientError('File content is required');
    }
    if (!title || !title.trim()) {
      throw _clientError('title is required');
    }
    const level = (clearanceLevel || 'INTERNAL').toUpperCase();
    if (!VALID_CLEARANCE_LEVELS.includes(level)) {
      throw _clientError(`clearanceLevel must be one of: ${VALID_CLEARANCE_LEVELS.join(', ')}`);
    }
    const releasable = Array.isArray(releasableTo) ? releasableTo : [];
    if (releasable.length === 0 || !releasable.every(d => typeof d === 'string' && d.startsWith('did:'))) {
      throw _clientError('releasableTo must be a non-empty array of DID strings (starting with "did:")');
    }
    if (!this.iagon.isConfigured()) {
      throw _serviceError('Iagon storage not configured — set IAGON_ACCESS_TOKEN and IAGON_NODE_ID');
    }

    // Step 2+3: Encrypt and upload to Iagon in one call.
    // uploadFile handles encryption internally — do NOT pre-encrypt separately, as that would
    // double-encrypt: uploadFile always generates its own DEK for storage encryption.
    const ext      = ((originalFilename || '').split('.').pop() || 'dat').toLowerCase();
    const tempId   = crypto.randomUUID();
    const filename = `doc-${tempId}.${ext}`;
    console.log(`[DocumentService] Uploading file to Iagon: ${filename}`);
    const iagonResult = await this.iagon.uploadFile(fileBuffer, filename);
    console.log(`[DocumentService] Iagon file uploaded: fileId=${iagonResult.fileId}`);
    // encryptionInfo holds the DEK for later decryption (stored in key manifest on Iagon)
    const encryptionInfo = iagonResult.encryptionInfo;

    // Step 4: Upload key manifest (only if AES encryption was applied)
    let iagonEncManifestId = null;
    if (encryptionInfo.algorithm !== 'none') {
      try {
        const manifestBuf    = Buffer.from(JSON.stringify(encryptionInfo), 'utf8');
        const manifestResult = await this.iagon.uploadFile(manifestBuf, `enckey-${iagonResult.fileId}.json`);
        iagonEncManifestId   = manifestResult.fileId;
        console.log(`[DocumentService] Key manifest uploaded: ${iagonEncManifestId}`);
      } catch (manifestErr) {
        console.error('[DocumentService] Key manifest upload failed (non-fatal):', manifestErr.message);
      }
    }

    // Step 5: Build DID service endpoints
    const services = this._buildServices({
      iagonFileId:       iagonResult.fileId,
      iagonFilename:     iagonResult.filename,
      originalFilename:  originalFilename || null,
      mimeType:          mimeType         || null,
      clearanceLevel:    level,
      releasableTo:      releasable,
      iagonEncManifestId,
      auditWebhookUrl:   auditWebhookUrl || this.config.AUDIT_FALLBACK_URL || null
    });

    // Step 6: Create PRISM DID
    const { longFormDid, operationId } = await this._createPRISMDID(services);
    console.log(`[DocumentService] DID created: ${longFormDid.substring(0, 60)}...`);

    // Step 7: Publish (fire-and-forget — long-form DID usable immediately)
    this._publishDID(longFormDid).catch(err =>
      console.warn(`[DocumentService] DID publication failed (non-fatal): ${err.message}`)
    );

    const createdAt = new Date().toISOString();

    // Step 8: Update Iagon-backed index
    await this._withIndex(entries => [
      ...entries,
      {
        documentDID:    longFormDid,
        title:          title.trim(),
        clearanceLevel: level,
        department:     department || null,
        createdAt,
        status:         'active'
      }
    ]).catch(err => console.warn('[DocumentService] Index update failed (non-fatal):', err.message));

    return {
      documentDID:        longFormDid,
      operationId,
      iagonFileId:        iagonResult.fileId,
      iagonEncManifestId,
      clearanceLevel:     level,
      releasableTo:       releasable,
      title:              title.trim(),
      createdAt,
      note: 'DID blockchain publication in progress. Long-form DID is immediately usable.'
    };
  }

  // ── READ ────────────────────────────────────────────────────────────────────

  async getDocumentMetadata(documentDID) {
    const meta = await resolveDocumentDID(documentDID);
    // Strip fields that must not be public
    const { iagonEncManifestId: _a, iagonFilename: _b, ...publicMeta } = meta;
    return { documentDID, ...publicMeta, resolvedAt: new Date().toISOString() };
  }

  // ── LIST ────────────────────────────────────────────────────────────────────

  async listDocuments(filterStatus) {
    const index = await this._loadIndex();
    let docs = index.documents || [];
    if (filterStatus) {
      docs = docs.filter(d => d.status === filterStatus);
    }
    return { documents: docs, total: docs.length, indexedAt: index.updatedAt || null };
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────

  async updateDocument(oldDocumentDID, params) {
    // Resolve old DID — confirm it exists and get defaults
    let oldMeta;
    try {
      oldMeta = await resolveDocumentDID(oldDocumentDID);
    } catch (_) {
      throw _notFound(`Document DID not found: ${oldDocumentDID}`);
    }

    // Merge old metadata as defaults for fields not provided
    const mergedParams = {
      clearanceLevel: oldMeta.clearanceLevel,
      releasableTo:   oldMeta.releasableTo,
      ...params
    };

    // Create the new version
    const newResult      = await this.createDocument(mergedParams);
    const newDocumentDID = newResult.documentDID;

    // Annotate old DID with #superseded-by (fire-and-forget — non-fatal)
    this._patchDIDService(oldDocumentDID, 'ADD_SERVICE', {
      id:              'superseded-by',
      type:            'LinkedDomains',
      serviceEndpoint: [newDocumentDID]
    })
    .then(() => this._publishDID(oldDocumentDID))
    .catch(err => console.warn(`[DocumentService] superseded-by patch failed (non-fatal): ${err.message}`));

    // Update index: mark old superseded, add new active entry
    await this._withIndex(entries =>
      entries
        .map(e => e.documentDID === oldDocumentDID
          ? { ...e, status: 'superseded', supersededBy: newDocumentDID }
          : e
        )
        .concat([{
          documentDID:    newDocumentDID,
          title:          newResult.title,
          clearanceLevel: newResult.clearanceLevel,
          department:     mergedParams.department || null,
          createdAt:      newResult.createdAt,
          status:         'active'
        }])
    ).catch(err => console.warn('[DocumentService] Index update failed (non-fatal):', err.message));

    return {
      success:        true,
      newDocumentDID,
      oldDocumentDID,
      operationId:    newResult.operationId,
      iagonFileId:    newResult.iagonFileId,
      supersedes:     oldDocumentDID,
      createdAt:      newResult.createdAt,
      note: 'New DID created. Old DID annotated with #superseded-by service (fire-and-forget).'
    };
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────

  async deleteDocument(documentDID, opts = {}) {
    const purge = opts.purge !== false; // default: true

    // Resolve DID to get Iagon file references
    let meta;
    try {
      meta = await resolveDocumentDID(documentDID);
    } catch (_) {
      throw _notFound(`Document DID not found: ${documentDID}`);
    }

    let iagonFilesDeleted = 0;

    if (purge) {
      // Delete main encrypted file
      if (meta.iagonFilename) {
        try {
          await this.iagon.deleteFile(this.config.IAGON_NODE_ID, meta.iagonFilename);
          iagonFilesDeleted++;
          console.log(`[DocumentService] Deleted Iagon file: ${meta.iagonFilename}`);
        } catch (err) {
          console.warn(`[DocumentService] Iagon file delete failed (best-effort): ${err.message}`);
        }
      } else {
        console.warn('[DocumentService] iagonFilename not in DID metadata — skipping Iagon file deletion');
      }

      // Delete key manifest (filename is derivable from iagonFileId)
      if (meta.iagonFileId) {
        const manifestFilename = `enckey-${meta.iagonFileId}.json`;
        try {
          await this.iagon.deleteFile(this.config.IAGON_NODE_ID, manifestFilename);
          iagonFilesDeleted++;
          console.log(`[DocumentService] Deleted key manifest: ${manifestFilename}`);
        } catch (err) {
          console.warn(`[DocumentService] Key manifest delete failed (best-effort): ${err.message}`);
        }
      }
    }

    // Deactivate DID via soft tombstone (#status service endpoint)
    let didDeactivated = false;
    try {
      await this._patchDIDService(documentDID, 'ADD_SERVICE', {
        id:              'status',
        type:            'DocumentStatus',
        serviceEndpoint: 'deactivated'
      });
      await this._publishDID(documentDID);
      didDeactivated = true;
      console.log(`[DocumentService] DID tombstoned: ${documentDID}`);
    } catch (err) {
      console.warn(`[DocumentService] DID deactivation failed (non-fatal): ${err.message}`);
    }

    // Soft-delete in index
    const deletedAt = new Date().toISOString();
    await this._withIndex(entries =>
      entries.map(e => e.documentDID === documentDID
        ? { ...e, status: 'deleted', deletedAt }
        : e
      )
    ).catch(err => console.warn('[DocumentService] Index update failed (non-fatal):', err.message));

    return {
      success:           true,
      documentDID,
      iagonFilesDeleted,
      didDeactivated,
      deletedAt
    };
  }

  // ── PRIVATE: DID BUILDER ─────────────────────────────────────────────────────

  _buildServices({ iagonFileId, iagonFilename, originalFilename, mimeType, clearanceLevel, releasableTo, iagonEncManifestId, auditWebhookUrl }) {
    const services = [
      {
        id:   'metadata',
        type: 'DocumentMetadata',
        serviceEndpoint: {
          iagonFileId,
          clearanceLevel,
          // Filename stored for MIME-type detection on access (extension preserved).
          // releasableTo and iagonEncManifestId omitted — stored in KeyManifest VC (VCKeyStore)
          // to keep service endpoint under PRISM's 300-char limit
          ...(originalFilename ? { originalFilename } : {})
        }
      }
    ];

    const serviceUrl = (this.config.DOCUMENT_SERVICE_URL || '').replace(/\/$/, '');
    if (serviceUrl) {
      services.push({
        id:              'access',
        type:            'DocumentAccessGate',
        serviceEndpoint: `${serviceUrl}/access`
      });
    }

    if (auditWebhookUrl) {
      services.push({
        id:              'audit',
        type:            'AuditLog',
        serviceEndpoint: auditWebhookUrl
      });
    }

    return services;
  }

  // ── PRIVATE: PRISM DID OPERATIONS ───────────────────────────────────────────

  async _createPRISMDID(services) {
    const data = await this._agentFetch('/did-registrar/dids', {
      method: 'POST',
      body:   JSON.stringify({ documentTemplate: { publicKeys: [], services } })
    });
    return {
      longFormDid: data.longFormDid,
      operationId: data.scheduledOperation?.id || null
    };
  }

  async _publishDID(did) {
    const data = await this._agentFetch(
      `/did-registrar/dids/${encodeURIComponent(did)}/publications`,
      { method: 'POST' }
    );
    return data.scheduledOperation?.id || null;
  }

  async _patchDIDService(did, actionType, serviceEntry) {
    // Cloud Agent PATCH body structure varies by actionType
    const action = { actionType };
    if (actionType === 'ADD_SERVICE')    action.addService    = serviceEntry;
    if (actionType === 'UPDATE_SERVICE') action.updateService = serviceEntry;
    if (actionType === 'REMOVE_SERVICE') action.removeService = serviceEntry;

    await this._agentFetch(`/did-registrar/dids/${encodeURIComponent(did)}`, {
      method: 'PATCH',
      body:   JSON.stringify({ actions: [action] })
    });
  }

  async _agentFetch(path, options = {}) {
    const url     = `${this.config.ENTERPRISE_CLOUD_AGENT_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.ENTERPRISE_CLOUD_AGENT_API_KEY) {
      headers['apikey'] = this.config.ENTERPRISE_CLOUD_AGENT_API_KEY;
    }

    const res = await fetch(url, {
      ...options,
      headers:  { ...headers, ...(options.headers || {}) },
      timeout:  this.config.REQUEST_TIMEOUT_MS
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cloud Agent ${options.method || 'GET'} ${path} failed (${res.status}): ${text}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return {};
  }

  // ── PRIVATE: IAGON-BACKED INDEX ──────────────────────────────────────────────

  async _withIndex(mutatorFn) {
    const result = this._indexMutex.then(async () => {
      const current  = await this._loadIndex();
      const updated  = mutatorFn(current.documents || []);
      await this._saveIndex({ documents: updated, updatedAt: new Date().toISOString() });
      return updated;
    });
    this._indexMutex = result.catch(() => {});
    return result;
  }

  async _loadIndex() {
    if (!this._currentIndexFileId) {
      return { documents: [] };
    }
    try {
      const buf = await this.iagon.downloadFile(this._currentIndexFileId, { algorithm: 'none' });
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      console.warn('[DocumentService] Index load failed — starting fresh:', err.message);
      return { documents: [] };
    }
  }

  async _saveIndex(indexData) {
    const buf    = Buffer.from(JSON.stringify(indexData), 'utf8');
    const result = await this.iagon.uploadFile(buf, 'document-index.json');
    this._currentIndexFileId = result.fileId;
    console.log(`[DocumentService] Index saved. fileId=${result.fileId} — update DOCUMENT_INDEX_FILE_ID in .env to persist across restarts`);
    return result.fileId;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _clientError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function _notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function _serviceError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

module.exports = { DocumentService };
