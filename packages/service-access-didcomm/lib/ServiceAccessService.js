'use strict';

/**
 * ServiceAccessService.js — shared implementation of the service-access/1.0 protocol
 * (see ../PROTOCOL.md). Replaces:
 *   - certification-authority/lib/DIDCommCommandService.js
 *   - company-admin-portal/lib/DIDCommCommandService.js (an unsynced fork of the above)
 *   - identus-document-service/lib/DocumentDIDCommService.js's document-access/1.0 flow only
 *     (document-upload/1.0 and document-custody/1.0 are out of scope — those are mutation
 *     flows, not "prove VP → get a bounded grant" flows)
 *
 * Every capability request funnels through the same `_onProofVerified` core regardless of
 * which verified-event adapter (polling vs. webhook) delivered it: cryptographic VP-signature
 * verification → DID-keyed trust registry check → declarative claim extraction → capability-
 * specific grant body → send over the standard basicmessage/2.0 transport.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

/**
 * Thrown by a `mode: payload` capability's `buildResult` to signal an expected, capability-
 * specific failure (e.g. "document not found", "clearance level too low") — caught by
 * `_onProofVerified` and turned into a `service-access/1.0/error` with the given `code`, rather
 * than being treated as an unexpected exception.
 */
class CapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const { verifyPresentationCredentials } = require('./verifyPresentation');
const { extractClaims, classifyCredential, DEFAULT_CLAIM_RULES } = require('./ClaimExtractor');

const PROTOCOL_PREFIX = 'https://identuslabel.cz/protocols/service-access/1.0';

// Terminal Cloud Agent presentation states that mean "this proof did not succeed" — as opposed
// to a still-in-progress state we should keep waiting/polling on. `PresentationVerificationFailed`
// (the Cloud Agent's own post-hoc schema/structure check failing — see e.g. a requested
// schemaId not matching what was actually presented) is included here: earlier this state was
// unhandled, so both the polling loop and the webhook adapter silently treated it as "still
// pending" until the poll timeout, giving no indication of what actually went wrong.
const TERMINAL_REJECTED_STATES = new Set(['PresentationRejected', 'PresentationVerificationFailed', 'Rejected', 'Abandoned']);

function b64urlDecode(str) {
  const std = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(std + pad, 'base64').toString('utf-8');
}

/**
 * Normalize a Cloud Agent `GET /present-proof/presentations/{id}` poll response into a plain
 * `{ verifiableCredential: string[], rawVpJwt: string|null }` VP object. Reproduces the decoding
 * this codebase already did ad hoc in DIDCommCommandService.js's `_extractClaims` (the outer VP
 * itself arrives as a compact JWT in `data.data[0]`, distinct from the VC-JWTs it contains).
 *
 * `rawVpJwt` — the outer VP JWT's own compact-serialized form — is threaded through so
 * `verifyPresentationCredentials` can verify ITS signature too (holder binding), not just the
 * inner VC-JWTs' issuer signatures. Previously this function discarded the outer JWT's `iss` and
 * signature entirely, which is what let a copied VC-JWT be presented by any DID (see
 * verifyPresentation.js's header comment).
 */
function normalizePollingVp(presentationData) {
  try {
    const dataArr = presentationData.data;
    if (Array.isArray(dataArr) && typeof dataArr[0] === 'string') {
      const vpParts = dataArr[0].split('.');
      if (vpParts.length === 3) {
        const vpPayload = JSON.parse(b64urlDecode(vpParts[1]));
        return { verifiableCredential: vpPayload?.vp?.verifiableCredential ?? [], rawVpJwt: dataArr[0] };
      }
    }
  } catch (_) { /* fall through */ }
  try {
    const pres = presentationData.presentation ?? presentationData.data?.presentation;
    if (pres?.verifiableCredential) return { verifiableCredential: pres.verifiableCredential, rawVpJwt: null };
  } catch (_) { /* fall through */ }
  return { verifiableCredential: [], rawVpJwt: null };
}

/**
 * Normalize a webhook PresentationVerified event's presentation into the same
 * `{ verifiableCredential, rawVpJwt }` shape as `normalizePollingVp`. No service in this codebase
 * currently uses the webhook adapter (all three `ServiceAccessService` instances configure
 * `verifiedEventAdapter: 'polling'` — see PROTOCOL.md's "Optional alternate transport" note and
 * each service's own comment on why), so no real Cloud Agent webhook envelope shape has been
 * observed to harden this against. Written defensively: best-effort recovery of a raw outer VP
 * JWT from a couple of plausible shapes (a bare compact-JWT string, or a `data: [jwt, ...]` array
 * mirroring the polling response) and otherwise `rawVpJwt: null` — `_onProofVerified` fails
 * closed on a null `rawVpJwt` (see below) rather than silently skipping holder-binding.
 */
function normalizeWebhookVp(event) {
  const pres = event.presentation?.verifiablePresentation || event.presentation || {};

  if (typeof pres === 'string') {
    const parts = pres.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(b64urlDecode(parts[1]));
        return { verifiableCredential: payload?.vp?.verifiableCredential ?? [], rawVpJwt: pres };
      } catch (_) { /* fall through */ }
    }
  }

  if (Array.isArray(pres.data) && typeof pres.data[0] === 'string') {
    const parts = pres.data[0].split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(b64urlDecode(parts[1]));
        return { verifiableCredential: payload?.vp?.verifiableCredential ?? [], rawVpJwt: pres.data[0] };
      } catch (_) { /* fall through */ }
    }
  }

  return { verifiableCredential: pres.verifiableCredential ?? [], rawVpJwt: null };
}

/** Length-safe constant-time string compare (timingSafeEqual throws on length mismatch). */
function _constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** base64url(sha256(parts joined by '\n')) — used to build a request-bound proof challenge. */
function _bindingChallenge(...parts) {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('base64url');
}

/**
 * Extract the holder-signed `nonce` (the challenge the Cloud Agent put in the presentation
 * request `options.challenge`) from a polling presentation record's VP JWT. Returns null if it
 * cannot be recovered — callers decide whether a missing nonce is fatal.
 */
function _extractVpNonce(presentationData) {
  try {
    const dataArr = presentationData?.data;
    if (Array.isArray(dataArr) && typeof dataArr[0] === 'string') {
      const parts = dataArr[0].split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(b64urlDecode(parts[1]));
        return payload?.nonce ?? payload?.vp?.nonce ?? null;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

class ServiceAccessService {
  /**
   * @param {object} config
   * @param {string}   config.cloudAgentUrl
   * @param {string}   config.apiKey
   * @param {string}   config.publicBaseUrl
   * @param {string}   [config.accessPath='/api/access']  path (appended to publicBaseUrl) that
   *                     redeems a `mode: redirect` token
   * @param {Function} config.resolveConnection   async (fromDid) => connectionId | null
   * @param {(did: string) => Promise<object>} config.resolveIssuerDID  — see issuerResolver.js
   * @param {{isTrustedIssuer, getTrustedIssuers}} config.trustRegistry — see TrustRegistry.js
   * @param {object}   config.capabilities   { [key]: CapabilityDescriptor } — see PROTOCOL.md / plan Part 2c
   * @param {'polling'|'webhook'} [config.verifiedEventAdapter='polling']
   * @param {number}   [config.tokenTTLMs]
   * @param {number}   [config.pollIntervalMs]
   * @param {number}   [config.pollTimeoutMs]
   *
   * CapabilityDescriptor: {
   *   label, icon, mode: 'redirect'|'payload',
   *   redirectPath,                 // mode: redirect only — appended to the token entry for the
   *                                 // consuming server's own routing (not used by this library)
   *   proofSpec: { proofs: [{ schemaId, trustIssuers }], goalCode, goal, claims, domain },
   *   claimRules,                   // optional, defaults to DEFAULT_CLAIM_RULES
   *   trustedIssuerVcType,          // which classified credential's issuer must be trust-registry-checked
   *   tokenTTLMs,                   // optional per-capability override
   *   buildResult: async ({ claims, credentials, connectionId, requestBody }) => object
   *                 // mode: payload only. `requestBody` is the full body of the incoming
   *                 // service-access/1.0/request (beyond just `capability`) — e.g. a documentDID
   *                 // a document-access-style capability needs to know which resource was asked
   *                 // for. Throw a CapabilityError(code, message) for an expected, capability-
   *                 // specific failure (e.g. "document not found") — turned into a proper
   *                 // service-access/1.0/error instead of a generic 500-style failure.
   * }
   */
  constructor(config) {
    this.cfg = config;
    this.accessPath      = config.accessPath ?? '/api/access';
    this.tokenTTLMs       = config.tokenTTLMs      ?? 5  * 60 * 1000;
    this.pollIntervalMs   = config.pollIntervalMs  ?? 3  * 1000;
    this.pollTimeoutMs    = config.pollTimeoutMs   ?? 2  * 60 * 1000;
    this.verifiedEventAdapter = config.verifiedEventAdapter ?? 'polling';

    this._tokens  = new Map(); // token → TokenEntry
    this._pending = new Map(); // proofId → PendingEntry
    // requestId → { grant } | { error, message } — an HTTP-pollable mirror of the grant/error
    // this service also sends over DIDComm. Some consumers (e.g. an enterprise-agent-managed
    // connection reached over a REST API rather than the holder's own SDK-managed DIDComm
    // inbox) have no way to observe an incoming DIDComm message at all, so they need to
    // retrieve the outcome by polling instead. Both transports are populated from the same
    // _onProofVerified/_sendError core — this is not a second code path, just a second
    // delivery mechanism for the same result. See consumeGrant().
    this._pendingResults = new Map();
    // requestId → accessToken (a high-entropy secret the requester chose and sent inside the
    // transport-encrypted request). consumeGrant() releases a grant/error only to a caller that
    // presents the matching token, so knowing (or enumerating) a requestId alone is not enough
    // to retrieve the sealed DEK. Populated in _handleAccessRequest, cleared on consume.
    this._requestTokens = new Map();

    // unref() so this timer alone doesn't keep the process (or a test run) alive.
    setInterval(() => this._cleanupTokens(), 10 * 60 * 1000).unref();
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

    let connectionId;
    try {
      connectionId = await this.cfg.resolveConnection(fromDid);
    } catch (e) {
      console.error('[ServiceAccessService] resolveConnection error:', e.message);
    }
    if (!connectionId) {
      console.warn(`[ServiceAccessService] Cannot resolve connectionId for DID: ${fromDid?.slice(0, 40)}...`);
      return;
    }

    if (parsed.type === `${PROTOCOL_PREFIX}/request`) {
      // `body` may carry capability-specific fields beyond `capability` itself (e.g. a
      // documentDID a document-access-style capability needs to know which resource is being
      // requested) — threaded through as `requestBody` into `buildResult` for mode: payload
      // capabilities. Capabilities that don't need extra params simply ignore it.
      await this._handleAccessRequest(connectionId, parsed.id, parsed.body?.capability, parsed.body, fromDid);
    } else {
      console.warn(`[ServiceAccessService] Unhandled protocol type: ${parsed.type}`);
    }
  }

  /**
   * Call for every incoming Cloud Agent webhook event when verifiedEventAdapter === 'webhook'.
   * Returns true if the event was a PresentationVerified/Rejected event this service handled.
   */
  async handleWebhookEvent(event) {
    if (this.verifiedEventAdapter !== 'webhook') return false;

    const state = event.type || event.state || event.status;
    if (state !== 'PresentationVerified' && !TERMINAL_REJECTED_STATES.has(state)) return false;

    const proofId = event.presentationId || event.id;
    let pending = proofId ? this._pending.get(proofId) : null;
    if (!pending) {
      // Fallback: match the newest pending entry for this connection (mirrors the original
      // DocumentDIDCommService behavior, which only ever matched by connectionId).
      for (const [id, entry] of this._pending.entries()) {
        if (entry.connectionId === event.connectionId) { pending = entry; pending._id = id; break; }
      }
    } else {
      pending._id = proofId;
    }
    if (!pending) {
      console.warn(`[ServiceAccessService] No pending request for webhook event (proofId=${proofId})`);
      return false;
    }

    this._pending.delete(pending._id);

    if (TERMINAL_REJECTED_STATES.has(state)) {
      console.warn(`[ServiceAccessService] Proof ${pending._id} did not succeed (state="${state}") for capability="${pending.capabilityKey}"`);
      await this._sendError(pending.connectionId, pending.requestId, 'PROOF_REJECTED', `Proof request did not succeed (${state}).`);
      return true;
    }

    await this._onProofVerified(pending, normalizeWebhookVp(event), {
      acceptPresentation: async () => {} // webhook flows don't need an explicit accept PATCH
    });
    return true;
  }

  /** Returns the token entry for `GET {accessPath}?token=`, or null if not found. */
  getToken(token) {
    return this._tokens.get(token) ?? null;
  }

  /**
   * Consume the pending grant/error for a given request id (one-time, deletes on read).
   * For consumers that can't observe an incoming DIDComm message directly (see the
   * `_pendingResults` note in the constructor) and must instead poll an HTTP endpoint keyed by
   * the original request's id. Returns null if no result is ready yet.
   */
  consumeGrant(requestId, token) {
    const result = this._pendingResults.get(requestId) ?? null;
    if (!result) return null;
    // If the request carried an accessToken, release the result ONLY to a caller presenting the
    // matching token. On mismatch, return a sentinel WITHOUT deleting, so the legitimate holder
    // (who has the token) can still retrieve it and an enumerator learns nothing.
    const expected = this._requestTokens.get(requestId);
    if (expected && !_constantTimeEquals(token, expected.token)) {
      return { tokenMismatch: true };
    }
    this._pendingResults.delete(requestId);
    this._requestTokens.delete(requestId);
    return result;
  }

  /** Register this server's webhook with the Cloud Agent (idempotent). */
  async registerWebhook(publicWebhookUrl) {
    try {
      const listResp = await fetch(`${this.cfg.cloudAgentUrl}/events/webhooks`, { headers: { apikey: this.cfg.apiKey } });
      if (listResp.ok) {
        const data = await listResp.json();
        const items = data.items || data.contents || [];
        if (items.some(w => w.url === publicWebhookUrl)) return;
      }
      const regResp = await fetch(`${this.cfg.cloudAgentUrl}/events/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey },
        body: JSON.stringify({ url: publicWebhookUrl })
      });
      if (!regResp.ok) {
        const errText = await regResp.text().catch(() => '');
        console.error(`[ServiceAccessService] Webhook registration failed (${regResp.status}): ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      console.error('[ServiceAccessService] Error registering webhook:', e.message);
    }
  }

  // ── Private: request handling ─────────────────────────────────────────────

  // `senderRef` is whatever `handleIncomingMessage` received as `fromDid` — for CA/company-admin
  // this is the connection's actual `theirDid` (a did:peer:2 DID); for identus-document-service it
  // is ALREADY a resolved connectionId (its own `resolveConnection` is an identity passthrough —
  // see its constructor comment), not a DID at all. It is therefore NOT safe to compare against
  // the verified holder DID (`vpResult.holderDID`, a did:prism DID — see didCompare.js's header
  // comment on why VP `iss` is never a did:peer DID) as a hard security gate; it's carried only
  // for logging/audit correlation. Real holder binding is enforced entirely by
  // verifyPresentationCredentials's outer-signature + subject-vs-holder check below.
  async _handleAccessRequest(connectionId, requestId, capabilityKey, requestBody, senderRef) {
    const capability = this.cfg.capabilities[capabilityKey];
    if (!capability) {
      await this._sendError(connectionId, requestId, 'UNKNOWN_CAPABILITY',
        `Unknown capability: "${capabilityKey ?? '(none)'}". Valid: ${Object.keys(this.cfg.capabilities).join(', ')}`);
      return;
    }

    // Freshness: reject stale/replayed requests when the requester timestamped them (opt-in per
    // request, so capabilities that don't send `ts` are unaffected). Small negative skew allowed.
    const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
    if (requestBody?.ts != null) {
      const age = Date.now() - Number(requestBody.ts);
      if (!Number.isFinite(age) || age < -60_000 || age > REQUEST_MAX_AGE_MS) {
        await this._sendError(connectionId, requestId, 'STALE_REQUEST', 'Access request expired — please retry.');
        return;
      }
    }

    // Channel binding: when the request carries resource parameters (document-access sends the
    // requester's ephemeral X25519 pubkey and the target documentDID), commit them into the proof
    // `challenge`. The Cloud Agent forces the holder to sign the VP over this challenge, so the
    // holder's signature cryptographically binds to exactly this ephemeral key + resource — a VP
    // captured for one request cannot be replayed against a different key/document. A fresh nonce
    // keeps the challenge unique even for identical parameters.
    const bindNonce = crypto.randomUUID();
    const isBound   = !!(requestBody?.ephemeralPublicKey || requestBody?.documentDID);
    const challenge = isBound
      ? _bindingChallenge(bindNonce, requestBody.ephemeralPublicKey || '', requestBody.documentDID || '')
      : bindNonce;

    // Bind grant retrieval to a caller-chosen secret (see consumeGrant).
    if (requestBody?.accessToken) this._requestTokens.set(requestId, { token: String(requestBody.accessToken), at: Date.now() });

    // See DIDCommCommandService.js's original note: the Cloud Agent does not forward
    // proofs[].schemaId/claims/goalCode into the actual DIDComm wire message for JWT-format
    // requests — `options.domain` is the one field confirmed to survive, so it doubles as the
    // wallet-side schema hint. Preserved here unchanged.
    const domain = capability.proofSpec.domain || 'ca.identus.org';

    const trustedIssuers = this.cfg.trustRegistry.getTrustedIssuers(capability.trustedIssuerVcType);
    const proofs = capability.proofSpec.proofs.map(p =>
      (p.trustIssuers && p.trustIssuers.length > 0) ? p : { ...p, trustIssuers: trustedIssuers }
    );

    const proofPayload = {
      connectionId, proofs,
      options: { challenge, domain },
      credentialFormat: 'JWT',
      goalCode: capability.proofSpec.goalCode,
      goal:     capability.proofSpec.goal,
      claims:   capability.proofSpec.claims
    };

    let proofData;
    try {
      const resp = await fetch(`${this.cfg.cloudAgentUrl}/present-proof/presentations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey },
        body: JSON.stringify(proofPayload)
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[ServiceAccessService] Proof request failed (${resp.status}): ${errText.slice(0, 300)}`);
        await this._sendError(connectionId, requestId, 'PROOF_REQUEST_FAILED', 'Failed to create proof request.');
        return;
      }
      proofData = await resp.json();
    } catch (e) {
      console.error('[ServiceAccessService] Network error creating proof request:', e.message);
      await this._sendError(connectionId, requestId, 'PROOF_REQUEST_FAILED', 'Network error creating proof request.');
      return;
    }

    const proofId = proofData.presentationId || proofData.id;
    console.log(`[ServiceAccessService] Proof request created: ${proofId} (capability="${capabilityKey}", conn=${connectionId.slice(0, 12)}...)`);

    const pending = { connectionId, requestId, capabilityKey, requestBody, senderRef, startedAt: Date.now(),
      expectedChallenge: isBound ? challenge : null };
    this._pending.set(proofId, pending);

    if (this.verifiedEventAdapter === 'polling') this._startPolling(proofId);
  }

  // ── Private: polling adapter ──────────────────────────────────────────────

  _startPolling(proofId) {
    const startTime = Date.now();

    const timerId = setInterval(async () => {
      const pending = this._pending.get(proofId);
      if (!pending) { clearInterval(timerId); return; }

      if (Date.now() - startTime > this.pollTimeoutMs) {
        clearInterval(timerId);
        this._pending.delete(proofId);
        console.warn(`[ServiceAccessService] Proof ${proofId} timed out for capability="${pending.capabilityKey}"`);
        await this._sendError(pending.connectionId, pending.requestId, 'PROOF_TIMEOUT',
          'Timed out waiting for wallet approval.').catch(() => {});
        return;
      }

      try {
        const resp = await fetch(`${this.cfg.cloudAgentUrl}/present-proof/presentations/${proofId}`,
          { headers: { apikey: this.cfg.apiKey } });
        if (!resp.ok) {
          // Drain the body before abandoning this response — otherwise the underlying socket
          // never returns to fetch's keep-alive pool. This timer fires every pollIntervalMs
          // (default 3s) for up to pollTimeoutMs (default 2min) per pending proof, across every
          // service that embeds this shared library — a leaked connection per non-OK response
          // compounds fast under any sustained agent slowness/errors.
          try { await resp.body?.cancel?.(); } catch (_) {}
          return; // transient, keep polling
        }

        const data  = await resp.json();
        const state = data.state || data.status;

        if (state === 'PresentationVerified') {
          clearInterval(timerId);
          this._pending.delete(proofId);
          pending.vpNonce = _extractVpNonce(data);
          await this._onProofVerified(pending, normalizePollingVp(data), {
            acceptPresentation: () => fetch(`${this.cfg.cloudAgentUrl}/present-proof/presentations/${proofId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey },
              body: JSON.stringify({ action: 'presentation-accept' })
            })
          });
        } else if (TERMINAL_REJECTED_STATES.has(state)) {
          clearInterval(timerId);
          this._pending.delete(proofId);
          console.warn(`[ServiceAccessService] Proof ${proofId} did not succeed (state="${state}") for capability="${pending.capabilityKey}"`);
          await this._sendError(pending.connectionId, pending.requestId, 'PROOF_REJECTED',
            `Proof request did not succeed (${state}).`).catch(() => {});
        }
      } catch (e) {
        console.warn(`[ServiceAccessService] Poll error for ${proofId.slice(0, 12)}:`, e.message);
      }
    }, this.pollIntervalMs);
    timerId.unref?.();
  }

  // ── Private: shared post-verification core ────────────────────────────────

  async _onProofVerified(pending, vp, { acceptPresentation }) {
    const { connectionId, requestId, capabilityKey, requestBody } = pending;
    const capability = this.cfg.capabilities[capabilityKey];
    console.log(`[ServiceAccessService] _onProofVerified capability="${capabilityKey}" requestId=${requestId} conn=${String(connectionId).slice(0,8)}`);

    // Channel-binding check: for a request that bound resource params into the proof challenge,
    // the holder-signed VP nonce must equal the challenge we issued. If it is recoverable and
    // does NOT match, the presentation was produced for different parameters → reject. (If it is
    // not recoverable from this Cloud Agent's presentation record we do not hard-fail here: the
    // agent already verified the VP against the challenge it issued as part of PresentationVerified.)
    if (pending.expectedChallenge) {
      if (pending.vpNonce && pending.vpNonce !== pending.expectedChallenge) {
        console.error(`[ServiceAccessService] Challenge binding mismatch for requestId=${requestId} — rejecting`);
        await this._sendError(connectionId, requestId, 'CHALLENGE_MISMATCH',
          'Presentation was not bound to this request. Please retry.');
        return;
      }
      console.log(`[ServiceAccessService] Channel binding ${pending.vpNonce ? 'VERIFIED (nonce matches request)' : 'not enforced (nonce not in presentation record; relying on Cloud Agent challenge check)'} for requestId=${requestId}`);
    }

    // Holder binding: verifyPresentationCredentials only enforces this when it receives a raw
    // outer VP JWT (`vp.rawVpJwt`) to verify the presenter's own signature against. This is the
    // fix for the gap where a copied/stolen VC-JWT could be presented over any DIDComm
    // connection and this library would accept it on issuer-signature + issuer-trust alone,
    // without ever checking that the presenter IS the credential's rightful subject (see
    // verifyPresentation.js's header comment). ServiceAccessService is the caller this closes the
    // gap for, so — unlike verifyPresentationCredentials itself, which tolerates a missing
    // rawVpJwt for other callers that already do this check their own way — a missing rawVpJwt
    // HERE is fail-closed, not silently skipped. There is no config flag to bypass this.
    if (!vp.rawVpJwt) {
      console.error(`[ServiceAccessService] Could not recover the outer VP JWT for requestId=${requestId} (capability="${capabilityKey}") — rejecting fail-closed, holder binding cannot be verified`);
      await this._sendError(connectionId, requestId, 'HOLDER_BINDING_FAILED',
        'Could not verify presentation holder binding.');
      return;
    }

    const vpResult = await verifyPresentationCredentials(vp, this.cfg.resolveIssuerDID);
    if (!vpResult.success) {
      console.warn(`[ServiceAccessService] VP verification failed (${vpResult.error}): ${vpResult.message}`);
      await this._sendError(connectionId, requestId, vpResult.error, vpResult.message);
      return;
    }
    console.log(`[ServiceAccessService] VP verified — holder=${String(vpResult.holderDID).slice(0,32)}${pending.senderRef ? ` (connection senderRef=${String(pending.senderRef).slice(0,32)})` : ''} — ${vpResult.credentials.length} credential(s): ` +
      vpResult.credentials.map(c => `${classifyCredential(c.claims, capability.claimRules || DEFAULT_CLAIM_RULES)?.vcType || '?'}<${String(c.issuerDID).slice(0,24)}>`).join(', '));

    // DID-keyed trust check — independent of whatever `trustIssuers` constraint the Cloud
    // Agent's presentation request enforced upstream (defense in depth, not a replacement).
    const rules = capability.claimRules || DEFAULT_CLAIM_RULES;
    if (capability.trustedIssuerVcType) {
      const matched = vpResult.credentials.find(c => classifyCredential(c.claims, rules)?.vcType === capability.trustedIssuerVcType);
      if (!matched || !this.cfg.trustRegistry.isTrustedIssuer(matched.issuerDID, capability.trustedIssuerVcType)) {
        console.error(`[ServiceAccessService] Untrusted issuer for capability "${capabilityKey}": ${matched?.issuerDID}`);
        await this._sendError(connectionId, requestId, 'UNTRUSTED_ISSUER',
          `No credential from a trusted issuer for "${capability.trustedIssuerVcType}" was presented.`);
        return;
      }
    }

    const claims = extractClaims(vpResult.credentials, rules);
    if (!claims) {
      await this._sendError(connectionId, requestId, 'NoUsableCredential',
        'Presentation did not contain a usable base credential.');
      return;
    }

    await acceptPresentation().catch(() => {}); // best-effort, non-fatal

    const tokenTTLMs = capability.tokenTTLMs ?? this.tokenTTLMs;
    const expiresAt  = Date.now() + tokenTTLMs;

    let grantBody;
    if (capability.mode === 'payload') {
      let result;
      try {
        result = await capability.buildResult({ claims, credentials: vpResult.credentials, connectionId, requestBody });
      } catch (err) {
        if (err instanceof CapabilityError) {
          console.warn(`[ServiceAccessService] buildResult denied "${capabilityKey}" (${err.code}): ${err.message} [requestId=${requestId}]`);
          await this._sendError(connectionId, requestId, err.code, err.message);
        } else {
          console.error(`[ServiceAccessService] buildResult threw for capability "${capabilityKey}":`, err);
          await this._sendError(connectionId, requestId, 'CAPABILITY_ERROR', 'Failed to build access result.');
        }
        return;
      }
      grantBody = { capability: capabilityKey, label: capability.label, icon: capability.icon || '🔐',
        mode: 'payload', expiresAt: new Date(expiresAt).toISOString(), result };
    } else {
      const token = crypto.randomUUID();
      this._tokens.set(token, {
        token, connectionId, capabilityKey,
        capabilityLabel: capability.label,
        redirectPath: capability.redirectPath,
        userClaims: claims,
        expiresAt, used: false, createdAt: Date.now()
      });
      const accessUrl = `${this.cfg.publicBaseUrl}${this.accessPath}?token=${token}`;
      console.log(`[ServiceAccessService] Token issued for capability="${capabilityKey}": ${token.slice(0, 12)}...`);
      grantBody = { capability: capabilityKey, label: capability.label, icon: capability.icon || '🔐',
        mode: 'redirect', expiresAt: new Date(expiresAt).toISOString(), accessUrl };
    }

    if (requestId) this._pendingResults.set(requestId, { grant: grantBody, storedAt: Date.now() });

    await this._send(connectionId, JSON.stringify({
      type: `${PROTOCOL_PREFIX}/grant`,
      id:   `grant-${Date.now().toString(36)}`,
      thid: requestId,
      body: grantBody
    }));
  }

  // ── Private: utilities ─────────────────────────────────────────────────────

  async _sendError(connectionId, requestId, error, message) {
    if (requestId) this._pendingResults.set(requestId, { error, message, storedAt: Date.now() });
    await this._send(connectionId, JSON.stringify({
      type: `${PROTOCOL_PREFIX}/error`,
      id:   crypto.randomUUID(),
      thid: requestId,
      body: { error, message }
    })).catch(() => {});
  }

  async _send(connectionId, text) {
    try {
      const resp = await fetch(`${this.cfg.cloudAgentUrl}/connections/${connectionId}/basic-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey },
        body: JSON.stringify({ content: text })
      });
      if (!resp.ok) console.error(`[ServiceAccessService] _send failed (${resp.status}) to conn ${connectionId.slice(0, 12)}...`);
    } catch (e) {
      console.error('[ServiceAccessService] _send error:', e.message);
    }
  }

  _cleanupTokens() {
    const now = Date.now();
    let n = 0;
    for (const [tok, entry] of this._tokens.entries()) {
      if (entry.used || now > entry.expiresAt) { this._tokens.delete(tok); n++; }
    }
    if (n > 0) console.log(`[ServiceAccessService] Cleaned up ${n} expired/used tokens`);

    let r = 0;
    for (const [id, entry] of this._pendingResults.entries()) {
      if (now - entry.storedAt > 10 * 60 * 1000) { this._pendingResults.delete(id); r++; }
    }
    if (r > 0) console.log(`[ServiceAccessService] Cleaned up ${r} unconsumed pending results`);

    for (const [id, entry] of this._requestTokens.entries()) {
      if (now - entry.at > 10 * 60 * 1000) this._requestTokens.delete(id);
    }
  }
}

module.exports = { ServiceAccessService, PROTOCOL_PREFIX, CapabilityError };
