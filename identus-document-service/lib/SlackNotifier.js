'use strict';

/**
 * SlackNotifier.js — Fire-and-forget Slack Block Kit notifications.
 *
 * Configure via SLACK_WEBHOOK_URL env var (Slack incoming webhook).
 * All methods are no-ops when the env var is not set.
 * Errors never propagate — audit/notification failures must not block access.
 */

const fetch = require('node-fetch');

const _webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
const _enabled    = !!_webhookUrl;

const COLORS = {
  ACCESS_GRANTED: '#36a64f',
  ACCESS_DENIED:  '#d73a49',
  DEFAULT:        '#f0a500'
};

/**
 * Post a document access event to Slack.
 *
 * @param {object} event — same shape as LocalAuditLog / AuditEmitter events:
 *   { event, documentDID, issuerDID, clearanceLevel, denialReason,
 *     viewerName, clientIp, processingMs }
 */
function notifyAccess(event) {
  if (!_enabled) return;

  const isGrant  = event.event === 'ACCESS_GRANTED';
  const isDenied = event.event === 'ACCESS_DENIED';
  const color    = isGrant ? COLORS.ACCESS_GRANTED : isDenied ? COLORS.ACCESS_DENIED : COLORS.DEFAULT;
  const icon     = isGrant ? '✅' : isDenied ? '🚫' : 'ℹ️';
  const did      = event.documentDID ? event.documentDID.substring(0, 52) + '…' : 'unknown';

  const fields = [
    { title: 'Event',       value: event.event || 'UNKNOWN',          short: true },
    { title: 'Clearance',   value: event.clearanceLevel || '—',        short: true },
    { title: 'Document DID',value: `\`${did}\``,                       short: false },
    { title: 'Issuer DID',  value: event.issuerDID   ? `\`${event.issuerDID.substring(0, 52)}…\`` : '—', short: false }
  ];
  if (event.viewerName)   fields.push({ title: 'Viewer',       value: event.viewerName,    short: true });
  if (event.denialReason) fields.push({ title: 'Denied reason',value: event.denialReason,  short: true });
  if (event.clientIp)     fields.push({ title: 'Client IP',    value: event.clientIp,      short: true });
  if (event.processingMs !== undefined) fields.push({ title: 'Processing', value: `${event.processingMs} ms`, short: true });

  const payload = {
    attachments: [{
      color,
      fallback: `${icon} ${event.event} — ${did}`,
      title:    `${icon} Document Access — ${event.event}`,
      fields,
      footer:   'identus-document-service',
      ts:       Math.floor(Date.now() / 1000)
    }]
  };

  _post(payload);
}

// ---------------------------------------------------------------------------

function _post(payload) {
  fetch(_webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    timeout: 5000
  }).then(res => {
    if (!res.ok) console.warn(`[SlackNotifier] Webhook returned HTTP ${res.status}`);
  }).catch(err => {
    console.warn('[SlackNotifier] Webhook POST failed:', err.message);
  });
}

module.exports = { notifyAccess };
