'use strict';

/**
 * KeyManifestVCIssuer.js
 *
 * Issues and revokes DocumentKeyManifest VCs for document access control.
 *
 * A DocumentKeyManifest VC carries:
 *   - documentDID          (document identifier — lookup key at document-service)
 *   - iagonFileId          (Iagon file to decrypt)
 *   - CMK-wrapped DEK      (wrappedKey, iv, authTag, wrappingAlgorithm, classificationLevel)
 *   - File encryption info (fileIv, fileAuthTag, fileAlgorithm)
 *   - releasableTo[]       (issuer DIDs authorised to access this document)
 *   - contentHash          (sha256: prefix + hex digest for integrity)
 *
 * Signing strategy (Phase 2 — Ed25519 asymmetric):
 *   The VC is a compact JWT signed with Ed25519 using the company-admin-portal's
 *   private signing key (MANIFEST_SIGNING_KEY env var, JWK format).
 *   The corresponding public key is served at /.well-known/jwks.json so
 *   document-service (and any external verifier) can verify without a shared secret.
 *
 *   The signature guarantees:
 *     - Authenticity  : only company-admin (private key holder) can issue
 *     - Integrity     : Ed25519 signature covers header + payload
 *     - Non-repudiation: unlike HMAC, only one party can produce the signature
 *
 *   Revocation is handled by replacing the VC in the document-service's
 *   local VCKeyStore — old VCs are superseded, not StatusList2021-revoked.
 *
 * Usage:
 *   const issuer = new KeyManifestVCIssuer(documentServiceUrl, adminKey);
 *   const { vcJwt, vcId } = await issuer.issue({ documentDID, issuerDID, ... });
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

class KeyManifestVCIssuer {
  /**
   * @param {string} documentServiceUrl - Base URL of identus-document-service
   * @param {string} adminKey           - Shared key for authenticating push to document-service
   */
  constructor(documentServiceUrl, adminKey) {
    this._baseUrl  = (documentServiceUrl || '').replace(/\/$/, '');
    this._adminKey = adminKey || '';
    this._signingKey = this._loadSigningKey();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Build, sign (Ed25519), and push a DocumentKeyManifest VC to document-service.
   *
   * @param {object} params
   * @param {string}   params.issuerDID            - Company DID (stored in VC iss)
   * @param {string}   params.documentDID          - PRISM DID of the document
   * @param {string}   params.iagonFileId          - Iagon file ID of the encrypted document
   * @param {string}   params.wrappedKey           - CMK-wrapped DEK (base64)
   * @param {string}   params.iv                   - CMK wrap IV (base64)
   * @param {string}   params.authTag              - CMK wrap auth tag (base64)
   * @param {string}   params.wrappingAlgorithm    - e.g. 'AES-256-GCM'
   * @param {string}   params.classificationLevel  - e.g. 'CONFIDENTIAL'
   * @param {string}   params.fileIv               - File encryption IV (base64)
   * @param {string}   params.fileAuthTag          - File encryption auth tag (base64)
   * @param {string}   params.fileAlgorithm        - e.g. 'AES-256-GCM'
   * @param {string[]} params.releasableTo         - Issuer DIDs allowed to access
   * @param {string}   [params.contentHash]        - sha256:hex digest
   * @returns {Promise<{ vcId: string, vcJwt: string }>}
   */
  async issue(params) {
    const {
      issuerDID, documentDID, iagonFileId,
      wrappedKey, iv, authTag, wrappingAlgorithm, classificationLevel,
      fileIv, fileAuthTag, fileAlgorithm,
      releasableTo, contentHash
    } = params;

    if (!documentDID) throw new Error('[KeyManifestVCIssuer] documentDID is required');
    if (!iagonFileId)  throw new Error('[KeyManifestVCIssuer] iagonFileId is required');
    if (!wrappedKey)   throw new Error('[KeyManifestVCIssuer] wrappedKey is required');

    const vcId = crypto.randomUUID();
    const now  = Math.floor(Date.now() / 1000);

    const claims = {
      documentDID,
      iagonFileId,
      wrappedKey,
      iv,
      authTag,
      wrappingAlgorithm:   wrappingAlgorithm   || 'AES-256-GCM',
      classificationLevel: classificationLevel || 'INTERNAL',
      fileIv,
      fileAuthTag,
      fileAlgorithm:       fileAlgorithm       || 'AES-256-GCM',
      releasableTo:        Array.isArray(releasableTo) ? releasableTo : [],
      contentHash:         contentHash || null
    };

    const payload = {
      jti: vcId,
      iss: issuerDID || process.env.SERVICE_DID || 'unknown',
      sub: documentDID,
      iat: now,
      vc: {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type:       ['VerifiableCredential', 'DocumentKeyManifest'],
        credentialSubject: claims
      }
    };

    const vcJwt = this._sign(payload);
    await this._push(documentDID, vcId, vcJwt, claims);

    return { vcId, vcJwt };
  }

  /**
   * Notify document-service to delete the VC for a document (revocation).
   * @param {string} documentDID
   */
  async revoke(documentDID) {
    if (!this._baseUrl) {
      console.warn('[KeyManifestVCIssuer] No documentServiceUrl — skipping revocation push');
      return;
    }

    const url = `${this._baseUrl}/vc/key-manifest/${encodeURIComponent(documentDID)}`;
    try {
      const res = await fetch(url, {
        method:  'DELETE',
        headers: this._headers()
      });
      if (!res.ok && res.status !== 404) {
        const body = await res.text();
        console.warn(`[KeyManifestVCIssuer] Revocation DELETE returned ${res.status}: ${body}`);
      } else {
        console.log(`[KeyManifestVCIssuer] Revoked VC for: ${documentDID.substring(0, 50)}...`);
      }
    } catch (err) {
      console.warn(`[KeyManifestVCIssuer] Revocation push failed (non-fatal): ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load Ed25519 private key from MANIFEST_SIGNING_KEY env var (JWK).
   * Falls back to a deterministic key derived from the admin key so the
   * service stays functional even without the env var (for backward compat).
   */
  _loadSigningKey() {
    const raw = process.env.MANIFEST_SIGNING_KEY;
    if (raw) {
      try {
        const jwk = JSON.parse(raw);
        return {
          key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
          kid: jwk.kid || 'manifest-key'
        };
      } catch (e) {
        console.error(`[KeyManifestVCIssuer] Failed to parse MANIFEST_SIGNING_KEY: ${e.message}`);
      }
    }
    // Fallback: generate a random key (not deterministic — only used if env is misconfigured)
    console.warn('[KeyManifestVCIssuer] MANIFEST_SIGNING_KEY not set — issuing with ephemeral key (not verifiable)');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    return { key: privateKey, kid: 'ephemeral' };
  }

  /**
   * Sign a JWT payload with Ed25519.
   * Returns a compact JWT: base64url(header).base64url(payload).base64url(sig)
   */
  _sign(payload) {
    const { key, kid } = this._signingKey;
    const header  = _b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const body    = _b64url(JSON.stringify(payload));
    const input   = `${header}.${body}`;
    const sig     = crypto.sign(null, Buffer.from(input), key);
    return `${input}.${_b64url(sig)}`;
  }

  async _push(documentDID, vcId, vcJwt, claims) {
    if (!this._baseUrl) {
      console.warn('[KeyManifestVCIssuer] No documentServiceUrl — VC not pushed');
      return;
    }

    const url  = `${this._baseUrl}/vc/key-manifest`;
    const body = JSON.stringify({ documentDID, vcId, vcJwt, claims });

    const res = await fetch(url, {
      method:  'POST',
      headers: this._headers(),
      body
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`[KeyManifestVCIssuer] Push failed (${res.status}): ${errBody}`);
    }

    console.log(`[KeyManifestVCIssuer] VC pushed for: ${documentDID.substring(0, 50)}...`);
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-admin-key':  this._adminKey
    };
  }
}

function _b64url(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

module.exports = KeyManifestVCIssuer;
