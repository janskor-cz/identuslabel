'use strict';

/**
 * CredentialIssuanceService.js — shared implementation of the credential-issuance/1.0 protocol
 * (see ../PROTOCOL.md). A holder-driven alternative to a staff member manually retyping
 * applicant-supplied data into an issuance form: a service declares, per capability, which VC
 * schema it issues and which fields it needs; the holder submits those field values over DIDComm;
 * the service issues via the normal Issue-Credential-protocol credential offer.
 *
 * Deliberately NOT part of `service-access-didcomm` — that library's own PROTOCOL.md lists
 * "mutation flows" (of which issuing a brand-new credential is one) as a stated non-goal, and its
 * whole shape (VP verification, DID-keyed trust registry, capability grants) is built around
 * "prove a VP → get a bounded access grant," not "collect form data → issue a VC." This service
 * has no VP/proof machinery at all — the holder isn't proving anything yet, they're the one
 * supplying the data a not-yet-issued credential will contain.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const PROTOCOL_PREFIX = 'https://identuslabel.cz/protocols/credential-issuance/1.0';

// How long a `request`/`fields-required` exchange stays eligible to receive a `data-submit`
// before it's pruned as abandoned. Generous — this is a human filling out a form, not a
// machine-timed proof exchange.
const PENDING_TTL_MS = 30 * 60 * 1000;
// How long a message id is remembered for webhook-redelivery dedup.
const SEEN_ID_TTL_MS = 30 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class CredentialIssuanceService {
  /**
   * @param {object} config
   * @param {string}   config.cloudAgentUrl
   * @param {string}   config.apiKey
   * @param {Function} config.resolveConnection   async (fromDid) => connectionId | null
   * @param {object}   config.capabilities   { [key]: CapabilityDescriptor }
   *
   * CapabilityDescriptor: {
   *   schemaName, schemaVersion,        // sent verbatim in fields-required, for wallet-side UI —
   *                                     // this library does not read or enforce them itself
   *   fields: [{ key, label, type, required }],
   *   validate?: (values) => string|null|Promise<string|null>,   // extra, capability-specific
   *                                     // checks beyond the generic required/date checks below;
   *                                     // return an error message to reject, null/undefined to pass
   *   issue: async ({ connectionId, values }) => any,   // performs the actual issuance (e.g. calls
   *                                     // into the service's own credential-offer logic); its
   *                                     // return value is not sent anywhere by this library — the
   *                                     // resulting credential offer is the native Issue-Credential-
   *                                     // protocol message the issue() implementation itself
   *                                     // triggers. Throw to signal issuance failure.
   * }
   */
  constructor(config) {
    this.cfg = config;

    // requestId → { connectionId, capabilityKey, status: 'awaiting_data'|'issuing'|'done'|'error', startedAt }
    this._pending = new Map();
    // messageId → seenAt — redelivery guard, shared across request/data-submit
    this._seenIds = new Map();

    setInterval(() => this._cleanup(), 5 * 60 * 1000).unref();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Call for every incoming BasicMessageReceived webhook event. */
  async handleIncomingMessage(fromDid, content) {
    if (!content) return;
    const text = content.trim();
    if (!text) return;

    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return; }
    if (!parsed || typeof parsed.type !== 'string' || !parsed.type.startsWith(PROTOCOL_PREFIX)) return;

    if (typeof parsed.id === 'string') {
      if (this._seenIds.has(parsed.id)) {
        console.warn(`[CredentialIssuanceService] Ignoring redelivered message id=${parsed.id}`);
        return;
      }
      this._seenIds.set(parsed.id, Date.now());
    }

    let connectionId;
    try {
      connectionId = await this.cfg.resolveConnection(fromDid);
    } catch (e) {
      console.error('[CredentialIssuanceService] resolveConnection error:', e.message);
    }
    if (!connectionId) {
      console.warn(`[CredentialIssuanceService] Cannot resolve connectionId for DID: ${fromDid?.slice(0, 40)}...`);
      return;
    }

    if (parsed.type === `${PROTOCOL_PREFIX}/request`) {
      await this._handleRequest(connectionId, parsed.id, parsed.body?.capability);
    } else if (parsed.type === `${PROTOCOL_PREFIX}/data-submit`) {
      await this._handleDataSubmit(connectionId, parsed.thid, parsed.body);
    } else {
      console.warn(`[CredentialIssuanceService] Unhandled protocol type: ${parsed.type}`);
    }
  }

  // ── Private: request handling ─────────────────────────────────────────────

  async _handleRequest(connectionId, requestId, capabilityKey) {
    const capability = this.cfg.capabilities[capabilityKey];
    if (!capability) {
      await this._sendError(connectionId, requestId, 'UNKNOWN_CAPABILITY',
        `Unknown capability: "${capabilityKey ?? '(none)'}". Valid: ${Object.keys(this.cfg.capabilities).join(', ')}`);
      return;
    }

    this._pending.set(requestId, {
      connectionId, capabilityKey, status: 'awaiting_data', startedAt: Date.now()
    });

    console.log(`[CredentialIssuanceService] fields-required for capability="${capabilityKey}" requestId=${requestId} conn=${String(connectionId).slice(0, 12)}...`);

    await this._send(connectionId, {
      type: `${PROTOCOL_PREFIX}/fields-required`,
      id:   crypto.randomUUID(),
      thid: requestId,
      body: {
        capability:    capabilityKey,
        schemaName:    capability.schemaName,
        schemaVersion: capability.schemaVersion,
        fields:        capability.fields
      }
    });
  }

  async _handleDataSubmit(connectionId, requestId, body) {
    const pending = requestId ? this._pending.get(requestId) : null;
    if (!pending) {
      await this._sendError(connectionId, requestId, 'UNKNOWN_REQUEST',
        'No matching pending issuance request for this submission (it may have expired).');
      return;
    }
    if (pending.status !== 'awaiting_data') {
      await this._sendError(connectionId, requestId, 'DUPLICATE_REQUEST',
        'This issuance request has already been submitted.');
      return;
    }

    const capability = this.cfg.capabilities[pending.capabilityKey];
    const values = (body && typeof body.values === 'object' && body.values) || {};

    const validationError = this._validateGeneric(capability, values)
      ?? await Promise.resolve(capability.validate ? capability.validate(values) : null).catch(e => e.message || 'Validation failed.');

    if (validationError) {
      pending.status = 'error';
      await this._sendError(connectionId, requestId, 'VALIDATION_FAILED', validationError);
      return;
    }

    pending.status = 'issuing';
    try {
      await capability.issue({ connectionId, values });
      pending.status = 'done';
      console.log(`[CredentialIssuanceService] Issued for capability="${pending.capabilityKey}" requestId=${requestId} conn=${String(connectionId).slice(0, 12)}...`);
      // No message to send here — issue() triggers the native Issue-Credential-protocol
      // credential offer as a side effect; that IS the success signal to the holder.
    } catch (err) {
      pending.status = 'error';
      console.error(`[CredentialIssuanceService] issue() threw for capability="${pending.capabilityKey}":`, err.message);
      await this._sendError(connectionId, requestId, 'ISSUANCE_FAILED', err.message || 'Issuance failed.');
    }
  }

  /** Generic required/date checks driven purely off `capability.fields` — returns an error
   *  message string, or null if the generic checks pass. */
  _validateGeneric(capability, values) {
    const missing = capability.fields
      .filter(f => f.required && !String(values[f.key] ?? '').trim())
      .map(f => f.key);
    if (missing.length > 0) return `Missing required field(s): ${missing.join(', ')}`;

    for (const f of capability.fields) {
      if (f.type === 'date' && values[f.key] && !DATE_RE.test(String(values[f.key]))) {
        return `Field "${f.key}" must be a date in YYYY-MM-DD format.`;
      }
    }
    return null;
  }

  // ── Private: utilities ─────────────────────────────────────────────────────

  async _sendError(connectionId, requestId, error, message) {
    await this._send(connectionId, {
      type: `${PROTOCOL_PREFIX}/error`,
      id:   crypto.randomUUID(),
      thid: requestId,
      body: { error, message }
    });
  }

  async _send(connectionId, envelope) {
    try {
      const resp = await fetch(`${this.cfg.cloudAgentUrl}/connections/${connectionId}/basic-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey },
        body: JSON.stringify({ content: JSON.stringify(envelope) })
      });
      if (!resp.ok) console.error(`[CredentialIssuanceService] _send failed (${resp.status}) to conn ${String(connectionId).slice(0, 12)}...`);
    } catch (e) {
      console.error('[CredentialIssuanceService] _send error:', e.message);
    }
  }

  _cleanup() {
    const now = Date.now();
    let p = 0;
    for (const [id, entry] of this._pending.entries()) {
      if (now - entry.startedAt > PENDING_TTL_MS) { this._pending.delete(id); p++; }
    }
    if (p > 0) console.log(`[CredentialIssuanceService] Cleaned up ${p} abandoned pending request(s)`);

    let s = 0;
    for (const [id, seenAt] of this._seenIds.entries()) {
      if (now - seenAt > SEEN_ID_TTL_MS) { this._seenIds.delete(id); s++; }
    }
    if (s > 0) console.log(`[CredentialIssuanceService] Cleaned up ${s} stale seen-id entries`);
  }
}

module.exports = { CredentialIssuanceService, PROTOCOL_PREFIX };
