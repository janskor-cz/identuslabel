/**
 * HolderBindingService.js
 *
 * Adds holder proof-of-possession + anti-replay + ephemeral-key binding to the
 * VP-gated /access flow.
 *
 * Background: the /access endpoint used to accept a bare Verifiable Presentation
 * (a bag of issuer-signed VC JWTs) with the ephemeral encryption key sent as an
 * unsigned sibling field. The VC signatures proved the *content* was authentic,
 * but nothing proved the presenter actually controls the credential subject's
 * key, and nothing bound the presentation to this specific request. That allowed
 * a captured VP to be replayed by a third party with their own ephemeral key.
 *
 * This service closes that gap with a challenge/response bound to the holder:
 *   1. issueChallenge({ documentDID, ephemeralPublicKey }) → one-time challenge,
 *      stored server-side keyed to exactly that document + ephemeral key.
 *   2. The wallet signs the canonical message
 *          `${challenge}.${documentDID}.${ephemeralPublicKey}`
 *      with the *credential subject's* secp256k1 key (proving control of the
 *      holder DID) and returns { holderDID, challenge, holderSignature }.
 *   3. verifyHolderSignature() resolves the holder's PRISM DID, checks the
 *      secp256k1 (ES256K, DER-encoded) signature against its verification
 *      methods, and consumeChallenge() enforces one-time use + binding.
 *
 * Because the challenge is server-issued, one-time, and bound to the exact
 * ephemeral key, a replayed or relayed VP is rejected: the attacker cannot
 * produce the holder's signature over a fresh challenge, and cannot swap in a
 * different ephemeral key without invalidating the binding.
 */

'use strict';

const crypto               = require('crypto');
const { resolveIssuerDID } = require('./DIDDocumentResolver');

// challenge (string) → { documentDID, ephemeralPublicKey, domain, expiresAt, consumed }
const _challenges = new Map();

const CHALLENGE_TTL_MS = 3 * 60 * 1000; // 3 minutes — enough for the user to approve + sign
const DOMAIN           = 'document-access.identuslabel.cz';

/** Purge expired challenges (cheap linear sweep; the map stays small). */
function _sweep() {
  const now = Date.now();
  for (const [challenge, entry] of _challenges) {
    if (entry.expiresAt < now) _challenges.delete(challenge);
  }
}

/**
 * Issue a one-time challenge bound to a specific document + ephemeral key.
 * @param {object} args
 * @param {string} args.documentDID
 * @param {string} args.ephemeralPublicKey  base64 X25519 public key the wallet will decrypt with
 * @returns {{ challenge: string, domain: string, expiresAt: number }}
 */
function issueChallenge({ documentDID, ephemeralPublicKey }) {
  if (!documentDID || !ephemeralPublicKey) {
    throw new Error('issueChallenge requires documentDID and ephemeralPublicKey');
  }
  _sweep();
  const challenge = crypto.randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  _challenges.set(challenge, {
    documentDID,
    ephemeralPublicKey,
    domain: DOMAIN,
    expiresAt,
    consumed: false
  });
  return { challenge, domain: DOMAIN, expiresAt };
}

/**
 * The exact byte string the holder must sign. Kept in one place so the wallet
 * and the verifier can never drift apart.
 */
function canonicalMessage({ challenge, documentDID, ephemeralPublicKey }) {
  return `${challenge}.${documentDID}.${ephemeralPublicKey}`;
}

/**
 * Look up a challenge and validate it is unconsumed, unexpired, and bound to
 * this exact document + ephemeral key. Does NOT consume it (call consumeChallenge
 * only after all other checks pass, so a failed attempt can be retried).
 *
 * @returns {{ ok: true } | { ok: false, error: string, message: string }}
 */
function checkChallengeBinding({ challenge, documentDID, ephemeralPublicKey }) {
  const entry = _challenges.get(challenge);
  if (!entry) {
    return { ok: false, error: 'CHALLENGE_NOT_FOUND', message: 'Unknown or expired access challenge' };
  }
  if (entry.consumed) {
    return { ok: false, error: 'CHALLENGE_CONSUMED', message: 'Access challenge already used' };
  }
  if (entry.expiresAt < Date.now()) {
    _challenges.delete(challenge);
    return { ok: false, error: 'CHALLENGE_EXPIRED', message: 'Access challenge expired' };
  }
  if (entry.documentDID !== documentDID) {
    return { ok: false, error: 'CHALLENGE_DOC_MISMATCH', message: 'Challenge was issued for a different document' };
  }
  if (entry.ephemeralPublicKey !== ephemeralPublicKey) {
    return { ok: false, error: 'CHALLENGE_KEY_MISMATCH', message: 'Ephemeral key does not match the challenge' };
  }
  return { ok: true };
}

/** Mark a challenge consumed (one-time use). */
function consumeChallenge(challenge) {
  const entry = _challenges.get(challenge);
  if (entry) entry.consumed = true;
}

/**
 * Verify a holder proof-of-possession signature.
 *
 * Resolves the holder's PRISM DID and checks the DER-encoded secp256k1 signature
 * over SHA-256(message) against every secp256k1 verification method in the DID
 * document (the holder's wallet may sign with any of its master/auth/assertion
 * keys, all of which are committed to by the DID's hash).
 *
 * @param {string} holderDID
 * @param {string} message           canonicalMessage(...)
 * @param {string} signatureB64      base64 DER secp256k1 signature
 * @returns {Promise<boolean>}
 */
async function verifyHolderSignature(holderDID, message, signatureB64) {
  if (!holderDID || !message || !signatureB64) return false;

  let holderDoc;
  try {
    holderDoc = await resolveIssuerDID(holderDID);
  } catch (err) {
    console.error(`[HolderBinding] Holder DID resolution failed for ${holderDID}: ${err.message}`);
    return false;
  }

  const allVMs = holderDoc.verificationMethod || [];
  const keysToTry = allVMs.filter(vm => vm.publicKeyJwk && vm.publicKeyJwk.crv === 'secp256k1');
  if (keysToTry.length === 0) {
    console.warn(`[HolderBinding] No secp256k1 verification methods for ${holderDID}`);
    return false;
  }

  let sigDER;
  try {
    sigDER = Buffer.from(signatureB64, 'base64');
  } catch (_) {
    return false;
  }

  const msgBytes = Buffer.from(message, 'utf8');
  for (const vm of keysToTry) {
    try {
      const jwk    = { ...vm.publicKeyJwk, kty: 'EC' };
      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      // Apollo's secp256k1 sign() emits DER; Node verifies DER over SHA-256(message).
      const valid  = crypto.verify('SHA256', msgBytes, { key: pubKey, dsaEncoding: 'der' }, sigDER);
      if (valid) {
        console.log(`[HolderBinding] ✅ Holder signature verified with key ${vm.id}`);
        return true;
      }
    } catch (err) {
      console.debug(`[HolderBinding] Key ${vm.id} failed: ${err.message}`);
    }
  }
  console.warn(`[HolderBinding] ❌ No key matched holder signature for ${holderDID}`);
  return false;
}

module.exports = {
  issueChallenge,
  canonicalMessage,
  checkChallengeBinding,
  consumeChallenge,
  verifyHolderSignature,
  DOMAIN
};
