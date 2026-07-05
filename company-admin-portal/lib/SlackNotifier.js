'use strict';

/**
 * SlackNotifier.js — Fire-and-forget Slack Block Kit notifications.
 *
 * Configure via SLACK_WEBHOOK_URL env var (Slack incoming webhook).
 * All methods are no-ops when the env var is not set.
 * Errors never propagate — notification failures must not block any operation.
 */

const fetch = require('node-fetch');

const _webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
const _enabled    = !!_webhookUrl;

const COLORS = {
  SUCCESS: '#36a64f',
  FAILURE: '#d73a49',
  WARNING: '#f0a500'
};

/**
 * Notify Slack when an employee wallet is created.
 *
 * @param {object} wallet — result from EmployeeWalletManager.createEmployeeWallet()
 *   { email, name, department, walletId, prismDid, created }
 */
function notifyWalletCreated(wallet) {
  if (!_enabled) return;

  const did = wallet.prismDid ? wallet.prismDid.substring(0, 50) + '…' : '—';

  const payload = {
    attachments: [{
      color:    COLORS.SUCCESS,
      fallback: `✅ Employee wallet created — ${wallet.email}`,
      title:    '✅ Employee Wallet Created',
      fields: [
        { title: 'Name',       value: wallet.name       || '—', short: true  },
        { title: 'Email',      value: wallet.email      || '—', short: true  },
        { title: 'Department', value: wallet.department || '—', short: true  },
        { title: 'Wallet ID',  value: wallet.walletId   || '—', short: true  },
        { title: 'PRISM DID',  value: `\`${did}\``,             short: false }
      ],
      footer: 'company-admin-portal',
      ts:     Math.floor(Date.now() / 1000)
    }]
  };

  _post(payload);
}

/**
 * Notify Slack of a security clearance verification result.
 *
 * @param {string}      email
 * @param {string|null} clearanceLevel — null if not provided / rejected
 * @param {boolean}     passed
 * @param {string}      [reason]       — denial reason when !passed
 */
function notifyClearanceVerification(email, clearanceLevel, passed, reason) {
  if (!_enabled) return;

  const icon  = passed ? '🔐' : '🚫';
  const color = passed ? COLORS.SUCCESS : COLORS.FAILURE;
  const title = passed
    ? `${icon} Security Clearance Verified`
    : `${icon} Security Clearance Rejected`;

  const fields = [
    { title: 'Employee', value: email || '—', short: true }
  ];
  if (clearanceLevel) fields.push({ title: 'Clearance Level', value: clearanceLevel, short: true });
  if (!passed && reason) fields.push({ title: 'Reason', value: reason, short: false });

  const payload = {
    attachments: [{
      color,
      fallback: `${icon} Clearance ${passed ? 'verified' : 'rejected'} — ${email}`,
      title,
      fields,
      footer: 'company-admin-portal',
      ts:     Math.floor(Date.now() / 1000)
    }]
  };

  _post(payload);
}

/**
 * Notify Slack of a document access event (audit mirror from document-service events).
 *
 * @param {object} event — { event, documentDID, issuerDID, clearanceLevel, denialReason, clientIp }
 */
function notifyDocumentAccess(event) {
  if (!_enabled) return;

  const isGrant = event.event === 'ACCESS_GRANTED';
  const color   = isGrant ? COLORS.SUCCESS : COLORS.FAILURE;
  const icon    = isGrant ? '✅' : '🚫';
  const did     = event.documentDID ? event.documentDID.substring(0, 52) + '…' : 'unknown';

  const fields = [
    { title: 'Event',        value: event.event     || 'UNKNOWN', short: true  },
    { title: 'Clearance',    value: event.clearanceLevel || '—',   short: true  },
    { title: 'Document DID', value: `\`${did}\``,                  short: false }
  ];
  if (event.denialReason) fields.push({ title: 'Denied reason', value: event.denialReason, short: true });

  const payload = {
    attachments: [{
      color,
      fallback: `${icon} ${event.event} — ${did}`,
      title:    `${icon} Document Access — ${event.event}`,
      fields,
      footer:   'company-admin-portal',
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

module.exports = { notifyWalletCreated, notifyClearanceVerification, notifyDocumentAccess };
