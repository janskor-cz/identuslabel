'use strict';

/**
 * DeliveryAuditLog.js — Append-only log for DIDComm document deliveries.
 *
 * Each DEK delivery is logged with a unique deliveryId so any leaked document
 * can be traced to the exact wallet/DID that received the decryption key.
 *
 * Format (one JSON object per line, JSONL):
 *   { deliveryId, documentDID, holderDID, connectionId, sections, issuedAt }
 */

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'delivery-audit.jsonl');

function append(entry) {
  const line = JSON.stringify({
    deliveryId:  entry.deliveryId,
    documentDID: entry.documentDID,
    holderDID:   entry.holderDID,
    connectionId:entry.connectionId,
    sections:    entry.sections || [],
    issuedAt:    new Date().toISOString()
  }) + '\n';

  fs.appendFile(LOG_PATH, line, err => {
    if (err) console.error('[DeliveryAuditLog] Write failed:', err.message);
  });
}

module.exports = { append };
