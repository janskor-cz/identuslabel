'use strict';

/**
 * DIDCommCommandService — reusable DIDComm command processor
 *
 * Drop into any Express server that uses the PRISM Cloud Agent. Handles
 * incoming BasicMessage commands (e.g. "/access-request portal") and sends
 * back one-time, time-limited access URLs after verifying a VC proof.
 *
 * Usage:
 *   const svc = new DIDCommCommandService({ cloudAgentUrl, apiKey, publicBaseUrl,
 *                                           resolveConnection, getUserInfo, targets });
 *   // In webhook handler:
 *   await svc.handleIncomingMessage(fromDid, content);
 *   // At startup:
 *   await svc.registerWebhook('https://your-server/api/webhook-probe');
 *   // In GET /api/access endpoint:
 *   const entry = svc.getToken(req.query.token);
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

class DIDCommCommandService {
  /**
   * @param {object} config
   * @param {string}   config.cloudAgentUrl      Cloud Agent base URL
   * @param {string}   config.apiKey             Cloud Agent API key
   * @param {string}   config.publicBaseUrl      Public base URL of this server (used in token URLs)
   * @param {Function} config.resolveConnection  async (fromDid) → connectionId UUID | null
   * @param {Function} config.getUserInfo        async (connectionId) → { firstName, lastName, uniqueId } | null
   * @param {object}   config.targets            { [targetKey]: TargetConfig }
   * @param {number}   [config.tokenTTLMs]       Token time-to-live in ms (default 5 min)
   * @param {number}   [config.pollIntervalMs]   Proof poll interval in ms (default 3 s)
   * @param {number}   [config.pollTimeoutMs]    Max proof wait time in ms (default 2 min)
   *
   * TargetConfig: {
   *   label: string,
   *   redirectPath: string,   // server-relative path served after token redemption
   *   proofSpec: {
   *     proofTypes: [{ schema: string, requiredFields: string[] }],
   *     goalCode: string,
   *     goal: string,
   *     claims: object
   *   }
   * }
   */
  constructor(config) {
    this.cfg = config;
    this.tokenTTLMs    = config.tokenTTLMs    ?? 5  * 60 * 1000;
    this.pollIntervalMs = config.pollIntervalMs ?? 3  * 1000;
    this.pollTimeoutMs  = config.pollTimeoutMs  ?? 2  * 60 * 1000;

    this._tokens  = new Map(); // token → TokenEntry
    this._pending = new Map(); // proofId → PendingEntry
    this._polls   = new Map(); // proofId → intervalId

    // Purge expired/used tokens every 10 minutes
    setInterval(() => this._cleanupTokens(), 10 * 60 * 1000);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Call this for every incoming BasicMessageReceived webhook event.
   * Handles two formats:
   *   1. JSON protocol envelope: { type: "https://identuslabel.cz/protocols/...", id, body }
   *   2. Text commands (legacy): "/help", "/status", "/access-request <target>"
   * Messages that are neither are silently ignored.
   */
  async handleIncomingMessage(fromDid, content) {
    if (!content) return;
    const text = content.trim();
    if (!text) return;

    let connectionId;
    try {
      connectionId = await this.cfg.resolveConnection(fromDid);
    } catch (e) {
      console.error(`[DIDCommCmd] resolveConnection error:`, e.message);
    }
    if (!connectionId) {
      console.warn(`[DIDCommCmd] Cannot resolve connectionId for DID: ${fromDid?.slice(0, 40)}...`);
      return;
    }

    // 1. Try JSON protocol envelope
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.type === 'string' &&
          parsed.type.startsWith('https://identuslabel.cz/protocols/')) {
        console.log(`[DIDCommCmd] Protocol message received: ${parsed.type}`);
        await this._handleProtocolMessage(connectionId, parsed);
        return;
      }
    } catch (_) { /* not JSON */ }

    // 2. Text commands (legacy convenience)
    if (!text.startsWith('/')) return;
    const [rawCmd, ...args] = text.split(/\s+/);
    await this._dispatch(connectionId, rawCmd.toLowerCase(), args);
  }

  /**
   * Return token entry for validation in GET /api/access.
   * Returns null if not found.
   */
  getToken(token) {
    return this._tokens.get(token) ?? null;
  }

  /**
   * Register this server's webhook with the Cloud Agent (idempotent).
   * Safe to call on every server start.
   */
  async registerWebhook(publicWebhookUrl) {
    try {
      const listResp = await fetch(`${this.cfg.cloudAgentUrl}/events/webhooks`, {
        headers: { 'apikey': this.cfg.apiKey }
      });
      if (listResp.ok) {
        const data = await listResp.json();
        const items = data.items || data.contents || [];
        if (items.some(w => w.url === publicWebhookUrl)) {
          console.log(`[DIDCommCmd] Webhook already registered: ${publicWebhookUrl}`);
          return;
        }
      }

      const regResp = await fetch(`${this.cfg.cloudAgentUrl}/events/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': this.cfg.apiKey },
        body: JSON.stringify({ url: publicWebhookUrl })
      });

      if (regResp.ok) {
        console.log(`[DIDCommCmd] Webhook registered: ${publicWebhookUrl}`);
      } else {
        const errText = await regResp.text().catch(() => '');
        console.error(`[DIDCommCmd] Webhook registration failed (${regResp.status}): ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[DIDCommCmd] Error registering webhook:`, e.message);
    }
  }

  // ── Private: Protocol message router ───────────────────────────────────────

  async _handleProtocolMessage(connectionId, envelope) {
    const { type, id: requestId, body = {} } = envelope;

    // access-request protocol
    if (type === 'https://identuslabel.cz/protocols/access-request/1.0/request') {
      await this._handleAccessRequest(connectionId, body.target);
      return;
    }

    console.warn(`[DIDCommCmd] Unhandled protocol type: ${type}`);
    await this._send(connectionId,
      `❓ Unsupported protocol: ${type}\n\nSend /help for available options.`);
  }

  // ── Private: Command dispatcher ─────────────────────────────────────────────

  async _dispatch(connectionId, cmd, args) {
    try {
      switch (cmd) {
        case '/access-request': await this._handleAccessRequest(connectionId, args[0]); break;
        case '/status':         await this._handleStatus(connectionId);                 break;
        case '/help':           await this._handleHelp(connectionId);                   break;
        default:
          await this._send(connectionId,
            `❓ Unknown command: ${cmd}\n\nSend /help to see available commands.`);
      }
    } catch (e) {
      console.error(`[DIDCommCmd] Error in command "${cmd}":`, e.message);
      await this._send(connectionId, '⚠️ Error processing command. Please try again later.').catch(() => {});
    }
  }

  // ── Private: /help ──────────────────────────────────────────────────────────

  async _handleHelp(connectionId) {
    const targetList = Object.entries(this.cfg.targets)
      .map(([key, t]) => `  • /access-request ${key} — ${t.label}`)
      .join('\n');

    await this._send(connectionId, [
      '📋 Available commands:',
      '',
      '/access-request <target>',
      '  Request verified access to a protected resource.',
      '  Targets:',
      targetList,
      '',
      '/status — Show your connection info',
      '/help   — Show this help message'
    ].join('\n'));
  }

  // ── Private: /status ────────────────────────────────────────────────────────

  async _handleStatus(connectionId) {
    const info = await this.cfg.getUserInfo(connectionId).catch(() => null);
    if (!info) {
      await this._send(connectionId,
        '❌ No registered user found for this connection.\nPlease complete identity registration with the CA first.');
      return;
    }
    await this._send(connectionId, [
      '🔍 Connection Status:',
      `   Name:       ${info.firstName} ${info.lastName}`,
      `   Unique ID:  ${info.uniqueId}`,
      `   Connection: ${connectionId.slice(0, 12)}...`,
      '',
      '✅ Connection is active.'
    ].join('\n'));
  }

  // ── Private: /access-request ────────────────────────────────────────────────

  async _handleAccessRequest(connectionId, targetKey) {
    if (!targetKey || !this.cfg.targets[targetKey]) {
      const valid = Object.keys(this.cfg.targets).join(', ');
      await this._send(connectionId,
        `❌ Unknown target: "${targetKey ?? '(none)'}"\n\nValid targets: ${valid}\n\nUsage: /access-request <target>`);
      return;
    }

    const target = this.cfg.targets[targetKey];

    await this._send(connectionId,
      `⏳ Access request for "${target.label}" received.\nA proof request has been sent to your wallet — please approve it.`);

    // Create proof request via Cloud Agent
    const challenge = crypto.randomUUID();
    const domain    = 'ca.identus.org';

    const proofPayload = {
      connectionId,
      proofs:      [],
      proofTypes:  target.proofSpec.proofTypes,
      options:     { challenge, domain },
      credentialFormat: 'JWT',
      goalCode:    target.proofSpec.goalCode,
      goal:        target.proofSpec.goal,
      claims:      target.proofSpec.claims
    };

    let proofData;
    try {
      const resp = await fetch(`${this.cfg.cloudAgentUrl}/present-proof/presentations`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': this.cfg.apiKey },
        body:    JSON.stringify(proofPayload)
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[DIDCommCmd] Proof request failed (${resp.status}): ${errText.slice(0, 300)}`);
        await this._send(connectionId, '❌ Failed to create proof request. Please try again later.');
        return;
      }
      proofData = await resp.json();
    } catch (e) {
      console.error(`[DIDCommCmd] Network error creating proof request:`, e.message);
      await this._send(connectionId, '❌ Network error. Please try again later.');
      return;
    }

    const proofId = proofData.presentationId || proofData.id;
    console.log(`[DIDCommCmd] Proof request created: ${proofId} (target="${targetKey}", conn=${connectionId.slice(0, 12)}...)`);

    this._pending.set(proofId, { connectionId, targetKey, challenge, domain, startedAt: Date.now() });
    this._startPolling(proofId);
  }

  // ── Private: Proof polling ──────────────────────────────────────────────────

  _startPolling(proofId) {
    const startTime = Date.now();

    const timerId = setInterval(async () => {
      const pending = this._pending.get(proofId);
      if (!pending) {
        clearInterval(timerId);
        this._polls.delete(proofId);
        return;
      }

      if (Date.now() - startTime > this.pollTimeoutMs) {
        clearInterval(timerId);
        this._polls.delete(proofId);
        this._pending.delete(proofId);
        await this._send(pending.connectionId,
          '⏰ Access request timed out waiting for wallet approval.\nSend /access-request again when ready.').catch(() => {});
        return;
      }

      try {
        const resp = await fetch(
          `${this.cfg.cloudAgentUrl}/present-proof/presentations/${proofId}`,
          { headers: { 'apikey': this.cfg.apiKey } }
        );
        if (!resp.ok) return; // transient, keep polling

        const data  = await resp.json();
        const state = data.state || data.status;
        console.log(`[DIDCommCmd] Poll ${proofId.slice(0, 12)}... → ${state}`);

        if (state === 'PresentationVerified') {
          clearInterval(timerId);
          this._polls.delete(proofId);
          this._pending.delete(proofId);
          await this._onProofSuccess(proofId, pending, data);
        } else if (['PresentationRejected', 'Rejected', 'Abandoned'].includes(state)) {
          clearInterval(timerId);
          this._polls.delete(proofId);
          this._pending.delete(proofId);
          await this._send(pending.connectionId, '❌ Proof request was rejected. Access denied.').catch(() => {});
        }
      } catch (e) {
        console.warn(`[DIDCommCmd] Poll error for ${proofId.slice(0, 12)}:`, e.message);
      }
    }, this.pollIntervalMs);

    this._polls.set(proofId, timerId);
  }

  async _onProofSuccess(proofId, pending, presentationData) {
    const { connectionId, targetKey } = pending;
    const target = this.cfg.targets[targetKey];

    const userClaims = this._extractClaims(presentationData);

    const token     = crypto.randomUUID();
    const expiresAt = Date.now() + this.tokenTTLMs;

    this._tokens.set(token, {
      token,
      connectionId,
      targetKey,
      targetLabel:  target.label,
      redirectPath: target.redirectPath,
      userClaims:   userClaims ?? {},
      expiresAt,
      used:      false,
      createdAt: Date.now()
    });

    // Accept presentation on Cloud Agent (best-effort, non-fatal)
    fetch(`${this.cfg.cloudAgentUrl}/present-proof/presentations/${proofId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': this.cfg.apiKey },
      body:    JSON.stringify({ action: 'presentation-accept' })
    }).catch(() => {});

    const userName   = userClaims ? `${userClaims.firstName} ${userClaims.lastName}` : 'Unknown';
    const accessUrl  = `${this.cfg.publicBaseUrl}/api/access?token=${token}`;
    const expiresMin = Math.round(this.tokenTTLMs / 60000);

    console.log(`[DIDCommCmd] Token issued for ${userName} (target="${targetKey}"): ${token.slice(0, 12)}...`);

    // Send a structured JSON grant envelope — wallet parses this to show a service card.
    // The wallet wraps all its outgoing messages in StandardMessageBody, so we match that
    // format here so the wallet's content parser is consistent on both directions.
    const grantEnvelope = JSON.stringify({
      type: 'https://identuslabel.cz/protocols/access-request/1.0/grant',
      id:   `grant-${Date.now().toString(36)}`,
      body: {
        accessUrl,
        target:    targetKey,
        label:     target.label,
        icon:      target.icon || '🔐',
        userName,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresMin
      }
    });

    await this._send(connectionId, grantEnvelope);
  }

  // ── Private: Utilities ──────────────────────────────────────────────────────

  /**
   * Decode VP JWT → extract claims from ALL VCs inside.
   *
   * Returns a merged object whose primary fields come from the EmployeeRole VC
   * (email, role, department, prismDid, …) and whose optional sub-objects carry
   * data from any CISTraining or SecurityClearanceGrant VCs that were included:
   *
   *   { email, role, department, prismDid,            // from EmployeeRole (required)
   *     cisTraining: { hasValidTraining, expiryDate, completionDate } | null,
   *     clearance:   { hasClearanceVC, level }         | null }
   */
  _extractClaims(presentationData) {
    const decodeVcSubject = (vcJwt) => {
      try {
        if (typeof vcJwt !== 'string') return vcJwt?.credentialSubject ?? null;
        const parts = vcJwt.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(this._b64urlDecode(parts[1]));
        return payload?.vc?.credentialSubject ?? null;
      } catch (_) { return null; }
    };

    let vcs = [];
    try {
      const dataArr = presentationData.data;
      if (Array.isArray(dataArr) && typeof dataArr[0] === 'string') {
        const vpParts = dataArr[0].split('.');
        if (vpParts.length === 3) {
          const vpPayload = JSON.parse(this._b64urlDecode(vpParts[1]));
          vcs = vpPayload?.vp?.verifiableCredential ?? [];
        }
      }
    } catch (_) {}

    if (vcs.length === 0) {
      try {
        const pres = presentationData.presentation ?? presentationData.data?.presentation;
        vcs = pres?.verifiableCredential ?? [];
      } catch (_) {}
    }

    let employeeRole = null;
    let cisTraining  = null;
    let clearance    = null;

    for (const vcJwt of vcs) {
      const cs = decodeVcSubject(vcJwt);
      if (!cs) continue;

      if (cs.role !== undefined && cs.department !== undefined) {
        // EmployeeRole VC
        employeeRole = cs;
      } else if (cs.trainingYear !== undefined && cs.certificateNumber !== undefined) {
        // CISTraining VC
        const expiry = cs.expiryDate ? new Date(cs.expiryDate) : null;
        cisTraining = {
          hasValidTraining: expiry ? expiry > new Date() : true,
          expiryDate:       cs.expiryDate   || null,
          completionDate:   cs.completionDate || null,
          certificateNumber: cs.certificateNumber || null
        };
      } else if (cs.clearanceLevel !== undefined) {
        // SecurityClearanceGrant VC
        clearance = {
          hasClearanceVC: true,
          level: cs.clearanceLevel
        };
      }
    }

    if (!employeeRole) return null;

    return {
      ...employeeRole,
      cisTraining: cisTraining  ?? null,
      clearance:   clearance    ?? null
    };
  }

  _b64urlDecode(str) {
    const std = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (std.length % 4)) % 4);
    return Buffer.from(std + pad, 'base64').toString('utf-8');
  }

  async _send(connectionId, text) {
    try {
      const resp = await fetch(
        `${this.cfg.cloudAgentUrl}/connections/${connectionId}/basic-messages`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': this.cfg.apiKey },
          body:    JSON.stringify({ content: text })
        }
      );
      if (!resp.ok) {
        console.error(`[DIDCommCmd] _send failed (${resp.status}) to conn ${connectionId.slice(0, 12)}...`);
      }
    } catch (e) {
      console.error(`[DIDCommCmd] _send error:`, e.message);
    }
  }

  _cleanupTokens() {
    const now = Date.now();
    let n = 0;
    for (const [tok, entry] of this._tokens.entries()) {
      if (entry.used || now > entry.expiresAt) { this._tokens.delete(tok); n++; }
    }
    if (n > 0) console.log(`[DIDCommCmd] Cleaned up ${n} expired/used tokens`);
  }
}

module.exports = DIDCommCommandService;
