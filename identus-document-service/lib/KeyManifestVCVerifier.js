'use strict';

/**
 * KeyManifestVCVerifier.js
 *
 * Verifies DocumentKeyManifest VCs stored in VCKeyStore.
 *
 * Signing algorithm: EdDSA (Ed25519) — Phase 2.
 *
 * Verification steps:
 *   1. Decode JWT header — check alg = EdDSA, extract kid
 *   2. Resolve the issuer's public key:
 *      a. Try MANIFEST_ISSUER_JWKS_URL (fetched with 60s cache)
 *      b. Fall back to inline MANIFEST_SIGNING_KEY_PUBLIC env var
 *   3. Verify the Ed25519 signature with Node.js crypto (constant-time)
 *   4. Decode payload and validate required claims in vc.credentialSubject
 *
 * Backward compatibility:
 *   VCs stored before Phase 2 (signed with HMAC-SHA256, alg: HS256) are
 *   verified via the legacy HMAC path using DOCUMENT_SERVICE_ADMIN_KEY.
 *   Once all manifests are migrated, the legacy path can be removed.
 *
 * Revocation:
 *   A revoked VC is deleted from VCKeyStore. A missing VC causes the
 *   access pipeline to return MANIFEST_VC_MISSING, not a signature error.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

// JWKS in-memory cache (one entry per kid)
const _jwksCache = { keys: {}, fetchedAt: 0 };
const CACHE_TTL_MS = 60_000; // 1 minute

class KeyManifestVCVerifier {
  /**
   * @param {object} [opts]
   * @param {string} [opts.jwksUrl]      - MANIFEST_ISSUER_JWKS_URL override
   * @param {string} [opts.inlineJwk]    - MANIFEST_SIGNING_KEY_PUBLIC override (JSON string)
   * @param {string} [opts.legacyHmacKey] - DOCUMENT_SERVICE_ADMIN_KEY (for HS256 backward compat)
   */
  constructor(opts = {}) {
    this._jwksUrl     = opts.jwksUrl      || process.env.MANIFEST_ISSUER_JWKS_URL || null;
    this._inlineJwk   = opts.inlineJwk   || process.env.MANIFEST_SIGNING_KEY_PUBLIC || null;
    this._legacyKey   = opts.legacyHmacKey|| process.env.DOCUMENT_SERVICE_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
  }

  /**
   * Verify a vcRecord from VCKeyStore.
   *
   * @param {object} vcRecord
   * @returns {Promise<{ valid: boolean, reason?: string, claims?: object }>}
   */
  async verify(vcRecord) {
    if (!vcRecord || !vcRecord.vcJwt) {
      return { valid: false, reason: 'No VC JWT in record' };
    }

    const parts = vcRecord.vcJwt.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'Malformed JWT — expected 3 parts' };
    }

    const [headerB64, payloadB64, sigB64] = parts;

    // Decode header
    let header;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch (_) {
      return { valid: false, reason: 'JWT header is not valid JSON' };
    }

    const alg = header.alg;

    // ── Routing by algorithm ─────────────────────────────────────────────────

    if (alg === 'EdDSA') {
      return this._verifyEdDSA(headerB64, payloadB64, sigB64, header.kid);
    }

    if (alg === 'HS256') {
      // Legacy HMAC path — backward compatibility only
      return this._verifyHmac(headerB64, payloadB64, sigB64);
    }

    return { valid: false, reason: `Unsupported JWT algorithm: ${alg}` };
  }

  // ---------------------------------------------------------------------------
  // Ed25519 verification
  // ---------------------------------------------------------------------------

  async _verifyEdDSA(headerB64, payloadB64, sigB64, kid) {
    let pubKey;
    try {
      pubKey = await this._resolvePublicKey(kid);
    } catch (e) {
      return { valid: false, reason: `Public key resolution failed: ${e.message}` };
    }

    if (!pubKey) {
      return { valid: false, reason: `No public key found for kid=${kid}` };
    }

    // Verify Ed25519 signature
    const input = `${headerB64}.${payloadB64}`;
    let sigBuf;
    try {
      sigBuf = Buffer.from(sigB64, 'base64url');
    } catch (_) {
      return { valid: false, reason: 'JWT signature is not valid base64url' };
    }

    let valid;
    try {
      valid = crypto.verify(null, Buffer.from(input), pubKey, sigBuf);
    } catch (e) {
      return { valid: false, reason: `Signature verification error: ${e.message}` };
    }

    if (!valid) {
      return { valid: false, reason: 'Ed25519 signature invalid' };
    }

    return this._extractClaims(payloadB64);
  }

  /**
   * Resolve Ed25519 public key for the given kid.
   * Priority: JWKS URL cache → inline env JWK → error.
   */
  async _resolvePublicKey(kid) {
    // 1. Try JWKS URL (with cache)
    if (this._jwksUrl) {
      const cached = await this._fetchJWKS();
      if (cached && cached[kid]) return cached[kid];
      // If kid not in fetched JWKS, fall through to inline
    }

    // 2. Inline env JWK
    if (this._inlineJwk) {
      const jwk = JSON.parse(this._inlineJwk);
      // Match kid if present, otherwise use unconditionally
      if (!kid || !jwk.kid || jwk.kid === kid) {
        return crypto.createPublicKey({ key: jwk, format: 'jwk' });
      }
    }

    return null;
  }

  /** Fetch JWKS from MANIFEST_ISSUER_JWKS_URL with 60s in-memory cache. */
  async _fetchJWKS() {
    const now = Date.now();
    if (now - _jwksCache.fetchedAt < CACHE_TTL_MS && Object.keys(_jwksCache.keys).length > 0) {
      return _jwksCache.keys;
    }

    try {
      const res = await fetch(this._jwksUrl, { timeout: 3000 });
      if (!res.ok) throw new Error(`JWKS fetch returned HTTP ${res.status}`);
      const data = await res.json();
      const keys = {};
      for (const jwk of (data.keys || [])) {
        if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
          keys[jwk.kid || 'default'] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        }
      }
      _jwksCache.keys = keys;
      _jwksCache.fetchedAt = now;
      return keys;
    } catch (e) {
      console.warn(`[KeyManifestVCVerifier] JWKS fetch failed (${this._jwksUrl}): ${e.message} — using inline key`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy HMAC verification (HS256 — backward compat for pre-Phase-2 VCs)
  // ---------------------------------------------------------------------------

  _verifyHmac(headerB64, payloadB64, sigB64) {
    if (!this._legacyKey) {
      return { valid: false, reason: 'Legacy HS256 VC but no HMAC key configured' };
    }

    const signing  = `${headerB64}.${payloadB64}`;
    const expected = crypto
      .createHmac('sha256', this._legacyKey)
      .update(signing)
      .digest('base64url');

    const expectedBuf = Buffer.from(expected);
    const actualBuf   = Buffer.from(sigB64);

    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, reason: 'HS256 signature invalid (length mismatch)' };
    }
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: 'HS256 signature invalid (HMAC mismatch)' };
    }

    return this._extractClaims(payloadB64);
  }

  // ---------------------------------------------------------------------------
  // Shared claim extraction
  // ---------------------------------------------------------------------------

  _extractClaims(payloadB64) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (_) {
      return { valid: false, reason: 'JWT payload is not valid JSON' };
    }

    const claims = payload?.vc?.credentialSubject;
    if (!claims) {
      return { valid: false, reason: 'JWT payload missing vc.credentialSubject' };
    }

    const required = ['documentDID', 'iagonFileId', 'wrappedKey', 'iv', 'authTag',
                      'wrappingAlgorithm', 'classificationLevel',
                      'fileIv', 'fileAuthTag', 'fileAlgorithm', 'releasableTo'];
    const missing = required.filter(f => claims[f] === undefined || claims[f] === null);
    if (missing.length > 0) {
      return { valid: false, reason: `Missing required claims: ${missing.join(', ')}` };
    }

    return { valid: true, claims };
  }
}

module.exports = KeyManifestVCVerifier;
