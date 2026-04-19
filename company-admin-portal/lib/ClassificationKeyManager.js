'use strict';

/**
 * ClassificationKeyManager.js
 *
 * Task 1: Classification Master Key (CMK) Store
 *
 * Provides a per-classification key hierarchy that wraps Document Encryption
 * Keys (DEKs) so no raw DEK is ever written to persistent storage.
 *
 * CMKs are loaded from environment variables at startup:
 *   CMK_INTERNAL, CMK_CONFIDENTIAL, CMK_RESTRICTED, CMK_TOP_SECRET
 *
 * Each must be a base64-encoded 256-bit (32-byte) random value.
 *
 * Usage:
 *   const cmk = require('./ClassificationKeyManager');
 *   cmk.load();  // call once at server startup — throws if any CMK is missing
 *
 *   // Wrap DEK before uploading key manifest to Iagon
 *   const wrapped = cmk.wrapDEK(rawDEKBuffer, 'CONFIDENTIAL');
 *   // → { wrappedKey, iv, authTag, wrappingAlgorithm, classificationLevel }
 *
 *   // Unwrap DEK in access pipeline
 *   const rawDEK = cmk.unwrapDEK(wrappedManifest, 'CONFIDENTIAL');
 */

const crypto = require('crypto');

// Mapping from classification level string → env var name
const ENV_VAR_MAP = {
  'INTERNAL':       'CMK_INTERNAL',
  'CONFIDENTIAL':   'CMK_CONFIDENTIAL',
  'RESTRICTED':     'CMK_RESTRICTED',
  'TOP-SECRET':     'CMK_TOP_SECRET',
  // aliases
  'UNCLASSIFIED':   'CMK_INTERNAL',  // treat UNCLASSIFIED same as INTERNAL
  'TOP_SECRET':     'CMK_TOP_SECRET' // underscore variant
};

class ClassificationKeyManager {
  constructor() {
    this._keys = {};   // level → Buffer (32 bytes)
    this._loaded = false;
  }

  /**
   * Load all CMKs from environment variables.
   * Must be called once at server startup.
   * Throws if any required CMK env var is missing or has wrong length.
   */
  load() {
    const required = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP-SECRET'];
    for (const level of required) {
      const envVar = ENV_VAR_MAP[level];
      const b64 = process.env[envVar];
      if (!b64) {
        throw new Error(
          `[ClassificationKeyManager] Missing required env var: ${envVar} (for classification ${level})`
        );
      }
      const keyBuf = Buffer.from(b64, 'base64');
      if (keyBuf.length !== 32) {
        throw new Error(
          `[ClassificationKeyManager] ${envVar} must be a base64-encoded 256-bit (32-byte) key, got ${keyBuf.length} bytes`
        );
      }
      this._keys[level] = keyBuf;
      console.log(`[ClassificationKeyManager] ✅ CMK loaded for ${level}`);
    }
    // Also alias TOP_SECRET → TOP-SECRET and UNCLASSIFIED → INTERNAL
    this._keys['TOP_SECRET']   = this._keys['TOP-SECRET'];
    this._keys['UNCLASSIFIED'] = this._keys['INTERNAL'];
    this._loaded = true;
    console.log('[ClassificationKeyManager] All CMKs loaded successfully');
  }

  /**
   * Wrap a raw DEK (Document Encryption Key) using the CMK for the given
   * classification level.
   *
   * @param {Buffer} rawDEK - 32-byte raw AES key
   * @param {string} classificationLevel - INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET
   * @returns {{ wrappedKey: string, iv: string, authTag: string,
   *             wrappingAlgorithm: string, classificationLevel: string }}
   *   All byte fields are base64-encoded strings.
   */
  wrapDEK(rawDEK, classificationLevel) {
    const cmk = this._getCMK(classificationLevel);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cmk, iv);
    const wrappedKey = Buffer.concat([cipher.update(rawDEK), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      wrappedKey:           wrappedKey.toString('base64'),
      iv:                   iv.toString('base64'),
      authTag:              authTag.toString('base64'),
      wrappingAlgorithm:    'AES-256-GCM',
      classificationLevel:  this._normalise(classificationLevel)
    };
  }

  /**
   * Unwrap a wrapped key manifest produced by wrapDEK().
   *
   * @param {object} manifest - Object with { wrappedKey, iv, authTag, classificationLevel }
   * @param {string} classificationLevel - Expected level (used to select CMK)
   * @returns {Buffer} - Raw DEK (32 bytes). Caller must zero this after use.
   * @throws {Error} if classification level in manifest doesn't match expectation,
   *   or if decryption fails (wrong key / tampered data).
   */
  unwrapDEK(manifest, classificationLevel) {
    const normalExpected = this._normalise(classificationLevel);
    if (manifest.classificationLevel && this._normalise(manifest.classificationLevel) !== normalExpected) {
      throw new Error(
        `[ClassificationKeyManager] Classification mismatch: manifest says "${manifest.classificationLevel}", expected "${normalExpected}"`
      );
    }
    const cmk = this._getCMK(classificationLevel);
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        cmk,
        Buffer.from(manifest.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(manifest.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(manifest.wrappedKey, 'base64')),
        decipher.final()
      ]);
    } catch (err) {
      throw new Error(`[ClassificationKeyManager] DEK unwrap failed for ${normalExpected}: ${err.message}`);
    }
  }

  /** True if load() has been called successfully. */
  get isLoaded() {
    return this._loaded;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _getCMK(level) {
    this._assertLoaded();
    const normalised = this._normalise(level);
    const key = this._keys[normalised];
    if (!key) {
      throw new Error(`[ClassificationKeyManager] No CMK for classification: "${level}" (normalised: "${normalised}")`);
    }
    return key;
  }

  _normalise(level) {
    if (!level) return 'INTERNAL';
    const upper = level.toUpperCase().trim();
    // Normalise underscores → hyphens for TOP-SECRET
    return upper.replace('_', '-');
  }

  _assertLoaded() {
    if (!this._loaded) {
      throw new Error('[ClassificationKeyManager] CMK store not initialised — call load() at server startup');
    }
  }
}

// Export a singleton — both server.js files share the same process
module.exports = new ClassificationKeyManager();
