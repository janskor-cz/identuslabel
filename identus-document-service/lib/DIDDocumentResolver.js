/**
 * DIDDocumentResolver.js
 *
 * Two responsibilities:
 *
 * 1. resolveDocumentDID(did) — resolves a DOCUMENT DID and extracts the
 *    DocumentMetadata service endpoint (iagonFileId, clearanceLevel, etc.).
 *    Used by the access pipeline to find the file and its access policy.
 *
 * 2. resolveIssuerDID(did) — resolves ANY PRISM DID and returns its
 *    verification methods (public keys). Used by VPVerificationService to
 *    verify JWT-VC signatures cryptographically.
 *    Results are cached for 60 s to avoid hammering the Cloud Agent on every
 *    access request.
 *
 * DID resolution is public — no API key required for /dids/{did}.
 */

'use strict';

const fetch  = require('node-fetch');
const config = require('../config');

// ── Issuer DID cache ─────────────────────────────────────────────────────────
// Maps DID string → { verificationMethod: [...], assertionMethod: [...], cachedAt: ms }
const _issuerCache = new Map();
const ISSUER_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Resolve a document DID and return structured metadata.
 *
 * @param {string} documentDID
 * @returns {Promise<{
 *   iagonFileId: string,
 *   clearanceLevel: string,
 *   releasableTo: string[],
 *   iagonEncManifestId: string|null,
 *   accessEndpoint: string|null,
 *   auditEndpoint: string|null,
 *   verificationMethods: object[]
 * }>}
 */
async function resolveDocumentDID(documentDID) {
  const url = `${config.ENTERPRISE_CLOUD_AGENT_URL}/dids/${encodeURIComponent(documentDID)}`;

  const headers = { 'Content-Type': 'application/json' };
  if (config.ENTERPRISE_CLOUD_AGENT_API_KEY) {
    headers['apikey'] = config.ENTERPRISE_CLOUD_AGENT_API_KEY;
  }

  const response = await fetch(url, {
    method:  'GET',
    headers,
    timeout: config.REQUEST_TIMEOUT_MS
  });

  if (!response.ok) {
    throw new Error(`DID resolution failed (${response.status}) for: ${documentDID}`);
  }

  const data = await response.json();

  // Identus Cloud Agent wraps the DID document under { didDocument: { ... } } or { did: { ... } }
  const didDoc = data.didDocument || data.did || data.document || data;

  const services = didDoc.services || didDoc.service || [];
  const verificationMethods = didDoc.verificationMethods || didDoc.authentication || [];

  // ---- DocumentMetadata -------------------------------------------------
  const metadataService = services.find(s => s.type === 'DocumentMetadata');
  if (!metadataService) {
    throw new Error(`No DocumentMetadata service endpoint in DID document: ${documentDID}`);
  }

  let metadata = metadataService.serviceEndpoint;

  // The Cloud Agent may return a single-element array
  if (Array.isArray(metadata)) {
    metadata = metadata[0];
  }

  // May be stored as a JSON string inside a plain string serviceEndpoint
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (_) {}
  }

  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`Malformed DocumentMetadata service endpoint in DID: ${documentDID}`);
  }

  if (!metadata.iagonFileId) {
    throw new Error(`DocumentMetadata missing iagonFileId in DID: ${documentDID}`);
  }

  // ---- DocumentAccessGate (document-service /access — no redaction) --------
  const accessService  = services.find(s => s.type === 'DocumentAccessGate');
  const accessEndpoint = accessService
    ? _unwrapEndpoint(accessService.serviceEndpoint)
    : null;

  // ---- DocumentAccessGate challenge (company-admin — applies redaction) ----
  // Identified by service id "document-access-gate" to distinguish from the
  // document-service /access endpoint (same type, different id).
  const challengeService  = services.find(s =>
    s.id === 'document-access-gate' ||
    (typeof s.id === 'string' && s.id.endsWith('#document-access-gate'))
  );
  const challengeEndpoint = challengeService
    ? _unwrapEndpoint(challengeService.serviceEndpoint)
    : null;

  // ---- AuditLog ---------------------------------------------------------
  const auditService  = services.find(s => s.type === 'AuditLog');
  const auditEndpoint = auditService
    ? _unwrapEndpoint(auditService.serviceEndpoint)
    : (config.AUDIT_FALLBACK_URL || null);

  // ---- IagonStorage — extract filename from Iagon download URL -----------
  // The iagon-storage service endpoint contains a URL with a `filename` query
  // parameter (e.g. ?filename=ACME_Test.docx). Use this as fallback when the
  // metadata service does not carry originalFilename or mimeType.
  let iagonFilenameFromUrl = null;
  const iagonStorageService = services.find(s => s.type === 'IagonStorage' || s.id === 'iagon-storage');
  if (iagonStorageService) {
    try {
      const rawEndpoint = _unwrapEndpoint(iagonStorageService.serviceEndpoint);
      // serviceEndpoint may be a JSON-encoded array string: ["https://..."]
      let urlStr = rawEndpoint;
      if (urlStr && urlStr.startsWith('[')) {
        try { urlStr = JSON.parse(urlStr)[0]; } catch (_) {}
      }
      if (urlStr) {
        const parsed = new URL(urlStr);
        const fn = parsed.searchParams.get('filename');
        if (fn) iagonFilenameFromUrl = fn;
      }
    } catch (_) {
      // Non-fatal: URL parse failure — filename stays null
    }
  }

  return {
    iagonFileId:         metadata.iagonFileId,
    iagonFilename:       metadata.iagonFilename       || iagonFilenameFromUrl || null,
    originalFilename:    metadata.originalFilename    || null,
    mimeType:            metadata.mimeType            || null,
    clearanceLevel:      metadata.clearanceLevel      || 'INTERNAL',
    releasableTo:        Array.isArray(metadata.releasableTo) ? metadata.releasableTo : [],
    // @deprecated — iagonEncManifestId is no longer written to new DID documents.
    // Present only on legacy documents created before the VC-manifest migration.
    // ReEncryptionService uses this as a backward-compat fallback when no VC is
    // found in VCKeyStore.
    iagonEncManifestId:  metadata.iagonEncManifestId  || null,
    accessEndpoint,
    challengeEndpoint,
    auditEndpoint,
    verificationMethods
  };
}

/** Extract a plain URL string from whatever shape the serviceEndpoint arrives in.
 * Only https:// URLs are accepted — rejects javascript:, file:, and internal http:// to prevent SSRF. */
function _unwrapEndpoint(ep) {
  if (!ep) return null;
  let url = null;
  if (typeof ep === 'string') url = ep;
  else if (Array.isArray(ep)) url = ep[0] || null;
  else if (typeof ep === 'object' && ep.uri) url = ep.uri;
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('https://')) return null;
  return url;
}

/**
 * Resolve any PRISM DID and return its verification methods.
 *
 * Uses the public /dids/{did} endpoint (no API key needed).
 * Results cached for ISSUER_CACHE_TTL_MS to reduce Cloud Agent load.
 *
 * @param {string} issuerDID
 * @returns {Promise<{
 *   verificationMethod: Array<{id:string, type:string, publicKeyJwk?:object}>,
 *   assertionMethod: string[]
 * }>}
 */
async function resolveIssuerDID(issuerDID) {
  const now = Date.now();
  const cached = _issuerCache.get(issuerDID);
  if (cached && now - cached.cachedAt < ISSUER_CACHE_TTL_MS) {
    return cached;
  }

  const url = `${config.ENTERPRISE_CLOUD_AGENT_URL}/dids/${encodeURIComponent(issuerDID)}`;
  const response = await fetch(url, {
    method:  'GET',
    headers: { 'Content-Type': 'application/json' },
    timeout: config.REQUEST_TIMEOUT_MS
  });

  if (!response.ok) {
    throw new Error(`Issuer DID resolution failed (${response.status}) for: ${issuerDID}`);
  }

  const data   = await response.json();
  // Identus wraps the DID document under didDocument in the W3C DID resolution format
  const didDoc = data.didDocument || data.did || data;

  const result = {
    verificationMethod: didDoc.verificationMethod || [],
    assertionMethod:    didDoc.assertionMethod    || [],
    cachedAt: now
  };

  _issuerCache.set(issuerDID, result);
  return result;
}

module.exports = { resolveDocumentDID, resolveIssuerDID };
