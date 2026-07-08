'use strict';

/**
 * DocumentServiceStartup.js — DIDComm identity bootstrap for the document service.
 *
 * On startup:
 *   1. If DOC_SERVICE_WALLET_ID/DOC_SERVICE_WALLET_API_KEY unset:
 *      POST /wallets on the multitenancy agent → save to data/service-wallet.json
 *   2. Register webhook: POST /events/webhooks (idempotent)
 *   3. Publish this service's own long-term identity DID (once — see _ensureServiceDid) and
 *      cache it, so /connect can hand it to callers alongside the per-invitation peer DID
 *      connection. The two are different layers: the published shortform DID identifies the
 *      service itself (stable, resolvable, checked once over this endpoint's TLS channel); the
 *      peer DID from each accepted invitation isolates the actual DIDComm message stream for
 *      that relationship (see requestDocumentAccessViaEnterprise's connection-reuse fix in
 *      idl-wallet — the peer-DID connection is meant to be created once and reused, not the
 *      service's identity).
 *   4. Cache the service wallet connection info in module state
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const WALLET_FILE      = path.join(__dirname, '..', 'data', 'service-wallet.json');
const SERVICE_DID_FILE = path.join(__dirname, '..', 'data', 'document-service-did.json');

let _walletId  = process.env.DOC_SERVICE_WALLET_ID  || null;
let _apiKey    = process.env.DOC_SERVICE_WALLET_API_KEY || null;
let _agentUrl  = process.env.DOC_SERVICE_AGENT_URL || 'http://91.99.4.54:8200';
let _initialized = false;
let _serviceDid  = null; // shortform did:prism:<hash> — this service's own published identity

function getWalletId()  { return _walletId; }
function getApiKey()    { return _apiKey; }
function getAgentUrl()  { return _agentUrl; }
function isInitialized(){ return _initialized; }
function getServiceDid(){ return _serviceDid; }

// Long-form → shortform: did:prism:<hash>:<encoded-state> → did:prism:<hash>. The registrar
// resolves either form, but the shortform is the stable value worth persisting/handing out —
// it doesn't change across key rotations the way the long-form's encoded state does.
const PRISM_DID_RE = /^did:prism:[0-9a-f]{64}(:.+)?$/i;
function _toShortForm(did) {
  if (!PRISM_DID_RE.test(did)) throw new Error(`Cloud Agent returned a malformed PRISM DID: ${did}`);
  return did.split(':').slice(0, 3).join(':');
}

// Same-filesystem temp-then-rename so a crash mid-write can never leave SERVICE_DID_FILE holding
// truncated/corrupt JSON (a partial write here would orphan the already-published DID on disk
// and cause a duplicate to be minted on next startup).
function _writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// Create + publish this service's own identity DID exactly once, ever, and cache the result to
// disk — mirroring the per-document DID creation in DocumentService.js (_createPRISMDID +
// _publishDID), just for the service's own identity instead of a document's. Unlike a per-document
// DID, this identity is meant to be resolved independent of any single connection/session, so
// (unlike DocumentService's fire-and-forget) publication is awaited and its outcome persisted —
// a service identity nobody can resolve on-chain because publication silently failed would be a
// worse failure mode than a slow startup.
async function _ensureServiceDid(agentUrl, apiKey) {
  let did = null, longFormDid = null, published = false;

  if (fs.existsSync(SERVICE_DID_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SERVICE_DID_FILE, 'utf8'));
      if (saved.did && saved.longFormDid) {
        ({ did, longFormDid, published } = saved);
        _serviceDid = did;
        console.log(`[DocumentServiceStartup] Loaded service DID from ${SERVICE_DID_FILE}: ${did} (published=${!!published})`);
      }
    } catch (e) {
      console.warn('[DocumentServiceStartup] Could not read service DID file, will recreate:', e.message);
    }
  }

  if (!did) {
    try {
      const created = await _agentFetch(agentUrl, apiKey, '/did-registrar/dids', {
        method: 'POST',
        body:   JSON.stringify({ documentTemplate: { publicKeys: [], services: [] } })
      });
      if (!created.longFormDid) throw new Error('Cloud Agent did not return a longFormDid');
      longFormDid = created.longFormDid;
      did = _toShortForm(longFormDid);
      _writeJsonAtomic(SERVICE_DID_FILE, { did, longFormDid, published: false, createdAt: new Date().toISOString() });
      _serviceDid = did;
      console.log(`[DocumentServiceStartup] Service DID created: ${did}`);
    } catch (err) {
      console.warn(`[DocumentServiceStartup] Service DID creation failed (non-fatal, /connect will omit serviceDid): ${err.message}`);
      return;
    }
  }

  if (!published) {
    try {
      await _agentFetch(agentUrl, apiKey, `/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`, { method: 'POST' });
      _writeJsonAtomic(SERVICE_DID_FILE, { did, longFormDid, published: true, createdAt: new Date().toISOString() });
      console.log(`[DocumentServiceStartup] Service DID publication scheduled: ${did}`);
    } catch (err) {
      // Not marked published — retried on next startup. The shortform DID is still handed out via
      // /connect in the meantime (self-certifying long-form resolution still works), but an
      // operator should notice this warning before pinning it into a wallet's TRUSTED_SERVICES.
      console.warn(`[DocumentServiceStartup] Service DID publication failed, will retry on next startup: ${err.message}`);
    }
  }
}

async function _agentFetch(agentUrl, apiKey, urlPath, options = {}) {
  const url = `${agentUrl}${urlPath}`;
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { apikey: apiKey } : {}) };
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : {};
}

async function _createWallet(agentUrl) {
  const data = await _agentFetch(agentUrl, null, '/wallets', {
    method: 'POST',
    body:   JSON.stringify({ name: 'document-service', seed: undefined })
  });
  return { walletId: data.id, apiKey: data.secret };
}

async function _registerWebhook(agentUrl, apiKey, webhookUrl) {
  try {
    const list = await _agentFetch(agentUrl, apiKey, '/events/webhooks');
    const items = list.items || list.contents || [];
    if (items.some(w => w.url === webhookUrl)) {
      console.log(`[DocumentServiceStartup] Webhook already registered: ${webhookUrl}`);
      return;
    }
    await _agentFetch(agentUrl, apiKey, '/events/webhooks', {
      method: 'POST',
      body:   JSON.stringify({ url: webhookUrl })
    });
    console.log(`[DocumentServiceStartup] Webhook registered: ${webhookUrl}`);
  } catch (err) {
    console.warn(`[DocumentServiceStartup] Webhook registration failed (non-fatal): ${err.message}`);
  }
}

async function initialize(config) {
  _agentUrl = config.DOC_SERVICE_AGENT_URL || _agentUrl;
  const publicBaseUrl = (config.DOCUMENT_SERVICE_URL || '').replace(/\/$/, '');
  const webhookUrl    = `${publicBaseUrl}/didcomm-webhook`;

  // Load cached wallet credentials
  if (!_walletId || !_apiKey) {
    if (fs.existsSync(WALLET_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        _walletId = saved.walletId;
        _apiKey   = saved.apiKey;
        console.log(`[DocumentServiceStartup] Loaded service wallet from ${WALLET_FILE}`);
      } catch (e) {
        console.warn('[DocumentServiceStartup] Could not read wallet file:', e.message);
      }
    }
  }

  // Create wallet if still missing
  if (!_walletId || !_apiKey) {
    if (!publicBaseUrl) {
      console.warn('[DocumentServiceStartup] DOCUMENT_SERVICE_URL not set — skipping wallet creation');
    } else {
      try {
        const { walletId, apiKey } = await _createWallet(_agentUrl);
        _walletId = walletId;
        _apiKey   = apiKey;
        fs.writeFileSync(WALLET_FILE, JSON.stringify({ walletId, apiKey }, null, 2));
        console.log(`[DocumentServiceStartup] Service wallet created: ${walletId}`);
      } catch (err) {
        console.warn(`[DocumentServiceStartup] Wallet creation failed (non-fatal): ${err.message}`);
      }
    }
  }

  // Register webhook (idempotent)
  if (_walletId && _apiKey && publicBaseUrl) {
    await _registerWebhook(_agentUrl, _apiKey, webhookUrl);
  }

  // Publish this service's own identity DID (idempotent — no-op after the first successful run)
  if (_walletId && _apiKey) {
    await _ensureServiceDid(_agentUrl, _apiKey);
  }

  _initialized = true;
  console.log(`[DocumentServiceStartup] Startup complete. Wallet=${_walletId || 'none'} Agent=${_agentUrl} ServiceDID=${_serviceDid || 'none'}`);
}

module.exports = { initialize, getWalletId, getApiKey, getAgentUrl, isInitialized, getServiceDid };
