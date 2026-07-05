'use strict';

/**
 * DocumentServiceStartup.js — DIDComm identity bootstrap for the document service.
 *
 * On startup:
 *   1. If DOC_SERVICE_WALLET_ID/DOC_SERVICE_WALLET_API_KEY unset:
 *      POST /wallets on the multitenancy agent → save to data/service-wallet.json
 *   2. Register webhook: POST /events/webhooks (idempotent)
 *   3. Cache the service wallet connection info in module state
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const WALLET_FILE = path.join(__dirname, '..', 'data', 'service-wallet.json');

let _walletId  = process.env.DOC_SERVICE_WALLET_ID  || null;
let _apiKey    = process.env.DOC_SERVICE_WALLET_API_KEY || null;
let _agentUrl  = process.env.DOC_SERVICE_AGENT_URL || 'http://91.99.4.54:8200';
let _initialized = false;

function getWalletId()  { return _walletId; }
function getApiKey()    { return _apiKey; }
function getAgentUrl()  { return _agentUrl; }
function isInitialized(){ return _initialized; }

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

  _initialized = true;
  console.log(`[DocumentServiceStartup] Startup complete. Wallet=${_walletId || 'none'} Agent=${_agentUrl}`);
}

module.exports = { initialize, getWalletId, getApiKey, getAgentUrl, isInitialized };
