/**
 * AuditEmitter.js
 *
 * Fire-and-forget POST of a structured audit event to the webhook URL
 * stored in the document DID's AuditLog service endpoint.
 *
 * Errors are logged but never thrown — audit failures must never block access.
 */

'use strict';

const fetch         = require('node-fetch');
const LocalAuditLog = require('./LocalAuditLog');
const SlackNotifier = require('./SlackNotifier');

/**
 * Emit an audit event to the given URL.
 * Returns immediately; the HTTP call runs in the background.
 *
 * @param {string|null} auditEndpointUrl
 * @param {object} event
 */
function emitAuditEvent(auditEndpointUrl, event) {
  if (!auditEndpointUrl) return;

  const payload = {
    ...event,
    emittedAt: new Date().toISOString()
  };

  fetch(auditEndpointUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    timeout: 10000
  }).then(res => {
    if (!res.ok) {
      console.warn(`[AuditEmitter] Audit POST returned ${res.status} for ${auditEndpointUrl}`);
    }
  }).catch(err => {
    console.warn('[AuditEmitter] Audit POST failed:', err.message);
  });
}

/**
 * Fan out one audit event to all three sinks: the configurable webhook
 * (emitAuditEvent), Slack, and the local JSONL (data/access.log).
 * This is the same composite operation server.js's routes have always used
 * for access-path events (previously a private `_fireAudit` closure there) —
 * extracted here so DocumentService.js's CRUD paths can reuse it too, rather
 * than duplicating the fan-out logic.
 *
 * @param {string|null} url    Audit webhook URL (per-document, or AUDIT_FALLBACK_URL)
 * @param {object} event       Event payload — must include `event` (event type) and `documentDID`
 */
function fireAudit(url, event) {
  emitAuditEvent(url, event);
  SlackNotifier.notifyAccess(event);
  LocalAuditLog.append({
    timestamp:      new Date().toISOString(),
    event:          event.event,
    documentDID:    event.documentDID    || null,
    issuerDID:      event.issuerDID      || null,
    clearanceLevel: event.clearanceLevel || null,
    accessGranted:  event.event === 'ACCESS_GRANTED',
    denialReason:   event.denialReason   || null,
    copyId:         event.copyId         || null,
    viewerName:     event.viewerName     || null,
    clientIp:       event.clientIp       || null,
    processingMs:   event.processingMs   || null
  });
}

module.exports = { emitAuditEvent, fireAudit };
