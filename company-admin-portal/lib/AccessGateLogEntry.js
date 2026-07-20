'use strict';

/**
 * AccessGateLogEntry.js
 *
 * Pure function building one access-gate-log.jsonl entry. Shared by:
 *   - the two CREATE write sites in POST /api/classified-documents/upload (server.js)
 *   - the new POST /api/audit/document-event inbound receiver (server.js), which relays
 *     CRUD/access events emitted by identus-document-service's AuditEmitter
 *
 * Kept as a standalone pure function (no fs/network) so the payload→log-line mapping
 * has a real, fast unit test instead of only a source-level regression test.
 */

/**
 * @param {object} params
 * @param {string} params.eventType        'CREATED'|'UPDATED'|'DELETED'|'ACCESS_GRANTED'|'ACCESS_DENIED'
 * @param {string|null} [params.viewerName]
 * @param {string} params.documentDID
 * @param {string|null} [params.documentTitle]
 * @param {string|null} [params.clearanceLevel]
 * @param {string|null} [params.companyDID]
 * @param {boolean} params.accessGranted
 * @param {string|null} [params.denialReason]
 * @param {string|null} [params.copyId]
 * @param {string|null} [params.clientIp]
 * @returns {object} one access-gate-log.jsonl entry (timestamp included)
 */
function buildLogEntry({
  eventType,
  viewerName = null,
  documentDID,
  documentTitle = null,
  clearanceLevel = null,
  companyDID = null,
  accessGranted,
  denialReason = null,
  copyId = null,
  clientIp = null
}) {
  return {
    timestamp: new Date().toISOString(),
    eventType,
    viewerName,
    documentDID,
    documentTitle,
    clearanceLevel,
    companyDID,
    accessGranted,
    denialReason,
    copyId,
    clientIp
  };
}

/** Maps an inbound /api/audit/document-event webhook body to a log entry. */
function buildLogEntryFromAuditWebhook({ event, documentDID, ownerCompanyDID, title, actorEmail, clearanceLevel, clientIp }) {
  return buildLogEntry({
    eventType: event,
    viewerName: actorEmail || null,
    documentDID,
    documentTitle: title || null,
    clearanceLevel: clearanceLevel || null,
    companyDID: ownerCompanyDID || null,
    accessGranted: event !== 'DELETED' && event !== 'ACCESS_DENIED',
    denialReason: null,
    copyId: null,
    clientIp: clientIp || null
  });
}

const VALID_AUDIT_EVENT_TYPES = ['CREATED', 'UPDATED', 'DELETED', 'ACCESS_GRANTED', 'ACCESS_DENIED'];

/**
 * Read-time enrichment for GET /api/admin/access-logs.
 *
 * The 5 original ACCESS_GRANTED/ACCESS_DENIED write sites in POST /api/access-gate/present
 * and POST /api/access-gate/notify historically read `document?.metadata?.title` when building
 * their log entry, but classified documents store their display title as a *top-level*
 * `document.title` field (see DocumentRegistry.js — `title: title || null, // Plaintext title
 * for display`), not nested under `metadata`. That left `documentTitle: null` on every one of
 * those rows. Those write sites have since been corrected to read `document.title`, but that
 * only helps *future* rows — it can't retroactively fix the many already-existing historical
 * lines in access-gate-log.jsonl.
 *
 * This function backfills a falsy `documentTitle` from the live DocumentRegistry at read time
 * instead, so historical rows display correctly too (as long as the document is still in the
 * registry) — belt and suspenders alongside the write-site fix, and it also covers any future
 * entry that ends up with a bad/missing title for some other reason. An entry whose
 * `documentTitle` is already populated (e.g. a CREATED/UPDATED entry, which already reads the
 * correct top-level field) is returned unchanged — this function never overwrites a real value.
 *
 * @param {object} entry - one parsed access-gate-log.jsonl line
 * @param {(documentDID: string) => ({ title?: string|null } | undefined)} lookupDocument -
 *   e.g. `(did) => DocumentRegistry.documents.get(did)`
 * @returns {object} `entry` unchanged, or a shallow copy with `documentTitle` backfilled
 */
function enrichLogEntryTitle(entry, lookupDocument) {
  if (!entry || entry.documentTitle) return entry;
  const doc = entry.documentDID ? lookupDocument(entry.documentDID) : undefined;
  const fallbackTitle = doc?.title;
  if (!fallbackTitle) return entry;
  return { ...entry, documentTitle: fallbackTitle };
}

module.exports = { buildLogEntry, buildLogEntryFromAuditWebhook, VALID_AUDIT_EVENT_TYPES, enrichLogEntryTitle };
