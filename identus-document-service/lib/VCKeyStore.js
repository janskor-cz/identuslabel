'use strict';

/**
 * VCKeyStore.js
 *
 * Local persistent store for DocumentKeyManifest VCs.
 * Keyed by documentDID. Backed by a JSON file on disk with an in-memory Map cache.
 *
 * Schema (per document):
 *   { current: vcRecord, history: vcRecord[] }
 *
 * - `current` holds the latest VC for the document.
 * - `history` is an array of superseded VCs ordered newest-first (history[0] is the
 *   VC that was replaced by `current`).
 *
 * Public interface:
 *   get(did)         → current vcRecord | null
 *   put(did, record) → pushes old current to history, sets new current
 *   delete(did)      → removes both current and history
 *   list()           → array of current vcRecord objects (unchanged external contract)
 *   getHistory(did)  → { current, history } | null
 *
 * Backward compatibility:
 *   Old stores using flat `{ vcJwt, claims, ... }` values are migrated to
 *   `{ current: <old value>, history: [] }` on first load.
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
    this._cache = null; // Map<documentDID, { current: vcRecord, history: vcRecord[] }>
  }

  /**
   * Load store from disk. Must be called once at startup.
   * Automatically migrates old flat-format entries to the {current, history} schema.
   */
  async load() {
    await fsp.mkdir(path.dirname(this._path), { recursive: true });

    try {
      const raw = await fsp.readFile(this._path, 'utf8');
      const obj = JSON.parse(raw);
      this._cache = new Map();

      let migratedCount = 0;
      for (const [did, value] of Object.entries(obj)) {
        if (value && typeof value === 'object' && ('current' in value || 'history' in value)) {
          // Already in new schema
          this._cache.set(did, {
            current: value.current || null,
            history: Array.isArray(value.history) ? value.history : []
          });
        } else if (value && typeof value === 'object') {
          // Old flat format — migrate
          this._cache.set(did, { current: value, history: [] });
          migratedCount++;
        }
      }

      if (migratedCount > 0) {
        console.log(`[VCKeyStore] Migrated ${migratedCount} flat-format entries to {current, history} schema`);
        await this._flush(); // Persist migration
      }

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
   * Retrieve the current VC record for a document.
   * @param {string} documentDID
   * @returns {object|null} current vcRecord or null
   */
  get(documentDID) {
    this._assertLoaded();
    const entry = this._cache.get(documentDID);
    return entry?.current || null;
  }

  /**
   * Store a new VC record. The previous current VC is pushed to history[0].
   * @param {string} documentDID
   * @param {object} vcRecord
   */
  async put(documentDID, vcRecord) {
    this._assertLoaded();
    const existing = this._cache.get(documentDID);
    const oldHistory = existing?.history || [];
    const oldCurrent = existing?.current || null;

    const newHistory = oldCurrent ? [oldCurrent, ...oldHistory] : oldHistory;

    this._cache.set(documentDID, { current: vcRecord, history: newHistory });
    await this._flush();
  }

  /**
   * Delete the VC record (current + history) for a document.
   * @param {string} documentDID
   */
  async delete(documentDID) {
    this._assertLoaded();
    this._cache.delete(documentDID);
    await this._flush();
  }

  /**
   * Return all current VC records as an array (backward-compatible external contract).
   * @returns {object[]}
   */
  list() {
    this._assertLoaded();
    return [...this._cache.values()]
      .map(entry => entry.current)
      .filter(Boolean);
  }

  /**
   * Return the full version history for a document.
   * @param {string} documentDID
   * @returns {{ current: object, history: object[] } | null}
   */
  getHistory(documentDID) {
    this._assertLoaded();
    const entry = this._cache.get(documentDID);
    if (!entry || !entry.current) return null;
    return {
      current: entry.current,
      history: entry.history || []
    };
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
