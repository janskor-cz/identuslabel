'use strict';

const fs   = require('fs').promises;
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'admin-config.json');

const LEVELS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];

const DEFAULT_CONFIG = {
  schemaPolicy: {
    INTERNAL:     { rules: [] },
    CONFIDENTIAL: { rules: [] },
    RESTRICTED:   { rules: [] },
    SECRET:       { rules: [] }
  },
  storage: {
    backend:             'iagon',
    iagonAccessToken:    '',
    iagonNodeId:         '',
    iagonDownloadBaseUrl: 'https://gw.iagon.com/api/v2'
  }
};

let _cache = null;

async function load() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (parsed.schemaPolicy) {
      for (const level of LEVELS) {
        if (parsed.schemaPolicy[level]) _cache.schemaPolicy[level] = parsed.schemaPolicy[level];
      }
    }
    if (parsed.storage) {
      Object.assign(_cache.storage, parsed.storage);
    }
    return _cache;
  } catch (err) {
    if (err.code === 'ENOENT') {
      _cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      return _cache;
    }
    throw err;
  }
}

async function save(config) {
  const tmp = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2));
  await fs.rename(tmp, CONFIG_FILE);
  _cache = config;
}

function getSchemaPolicy() {
  return _cache?.schemaPolicy ?? DEFAULT_CONFIG.schemaPolicy;
}

function getStorageConfig() {
  return _cache?.storage ?? DEFAULT_CONFIG.storage;
}

function getCachedConfig() {
  return _cache ?? JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * For each verified credential, check admin schema policy.
 * Returns { clearanceLevel, trusted } or null if no policy applies.
 *
 * @param {object} claims       - credential subject claims
 * @param {string} issuerDID
 * @param {object} vcPayload    - full VC JWT payload (for schema ID lookup)
 */
function applySchemaPolicy(claims, issuerDID, vcPayload) {
  const policy = getSchemaPolicy();
  const credSchemaId = vcPayload?.vc?.credentialSchema?.id || '';

  for (const level of LEVELS) {
    const { rules = [] } = policy[level] || {};
    for (const rule of rules) {
      const schemaMatches = !rule.schemaId || credSchemaId.includes(rule.schemaId);
      if (!schemaMatches) continue;

      const trusted = !rule.trustedIssuers?.length || rule.trustedIssuers.includes(issuerDID);
      const field = rule.clearanceField || 'clearanceLevel';
      const clearanceLevel = claims[field] || null;

      return { clearanceLevel, trusted, level };
    }
  }
  return null;
}

module.exports = { load, save, getSchemaPolicy, getStorageConfig, getCachedConfig, applySchemaPolicy };
