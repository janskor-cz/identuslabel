'use strict';

/**
 * VCKeyStore.js
 *
 * Local persistent store for DocumentKeyManifest VCs.
 * Keyed by documentDID. Backed by a JSON file on disk with an in-memory Map cache.
 *
 * Atomic writes via tmp-file + rename prevent partial-write corruption.
 * All reads are served from the in-memory cache (zero disk I/O per access request).
 */

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');
const os   = require('os');

class VCKeyStore {
  constructor(storePath) {
    this._path  = storePath;
    this._cache = null; // Map<documentDID, vcRecord> — null until load() called
  }

  /**
   * Load store from disk. Must be called once at startup.
   */
  async load() {
    await fsp.mkdir(path.dirname(this._path), { recursive: true });

    try {
      const raw = await fsp.readFile(this._path, 'utf8');
      const obj = JSON.parse(raw);
      this._cache = new Map(Object.entries(obj));
      console.log(`[VCKeyStore] Loaded ${this._cache.size} key manifest VCs from ${this._path}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._cache = new Map();
        console.log('[VCKeyStore] No existing store found — starting fresh');
      } else {
        throw new Error(`[VCKeyStore] Failed to load store: ${err.message}`);
      }
    }
  }

  _assertLoaded() {
    if (!this._cache) throw new Error('[VCKeyStore] Store not loaded — call load() at startup');
  }

  /**
   * Retrieve a VC record by document DID.
   * @param {string} documentDID
   * @returns {object|null} vcRecord or null
   */
  get(documentDID) {
    this._assertLoaded();
    return this._cache.get(documentDID) || null;
  }

  /**
   * Store or replace a VC record.
   * @param {string} documentDID
   * @param {object} vcRecord
   */
  async put(documentDID, vcRecord) {
    this._assertLoaded();
    this._cache.set(documentDID, vcRecord);
    await this._flush();
  }

  /**
   * Delete the VC record for a document (used before storing a replacement).
   * @param {string} documentDID
   */
  async delete(documentDID) {
    this._assertLoaded();
    this._cache.delete(documentDID);
    await this._flush();
  }

  /**
   * Return all stored VC records as an array (for migration / status checks).
   * @returns {object[]}
   */
  list() {
    this._assertLoaded();
    return [...this._cache.values()];
  }

  /**
   * Return count of stored records.
   * @returns {number}
   */
  size() {
    this._assertLoaded();
    return this._cache.size;
  }

  /**
   * Atomically flush the in-memory cache to disk.
   * Writes to a tmp file then renames to prevent partial-write corruption.
   */
  async _flush() {
    const obj = Object.fromEntries(this._cache.entries());
    const json = JSON.stringify(obj, null, 2);
    const tmp  = path.join(os.tmpdir(), `vc-key-store-${process.pid}-${Date.now()}.tmp`);
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, this._path);
  }
}

module.exports = new VCKeyStore(
  process.env.VC_STORE_PATH ||
  path.join(__dirname, '..', 'data', 'vc-key-store.json')
);
