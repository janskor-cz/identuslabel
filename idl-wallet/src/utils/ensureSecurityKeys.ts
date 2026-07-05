/**
 * Ensures a dual-key (Ed25519 + X25519) security clearance key exists.
 * Auto-generates one if none is present.
 * Returns the public keys, or null on failure.
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';
import * as jose from 'jose';
import * as sodium from 'libsodium-wrappers';
import {
  getSecurityClearanceKeys,
  addSecurityKeyDual,
  generateFingerprint,
} from './securityKeyStorage';

const apollo = new SDK.Apollo();

export async function ensureSecurityClearanceKeys(): Promise<{
  ed25519PublicKey: string;
  x25519PublicKey: string;
} | null> {
  try {
    // Return existing keys if present
    const existing = getSecurityClearanceKeys();
    if (existing?.ed25519PublicKey && existing?.x25519PublicKey) {
      return { ed25519PublicKey: existing.ed25519PublicKey, x25519PublicKey: existing.x25519PublicKey };
    }

    // Auto-generate a new dual-key pair
    await sodium.ready;

    const mnemonics = apollo.createRandomMnemonics();
    const seed = apollo.createSeed(mnemonics, 'security-clearance-seed');

    const ed25519PrivateKey = apollo.createPrivateKey({
      type: SDK.Domain.KeyTypes.EC,
      curve: SDK.Domain.Curve.ED25519,
      seed: Array.from(seed.value).map(b => b.toString(16).padStart(2, '0')).join(''),
    });
    const ed25519PublicKey = ed25519PrivateKey.publicKey();

    const seedBytes = new Uint8Array(seed.value).slice(0, 32);
    const libsodiumKP = sodium.crypto_sign_seed_keypair(seedBytes);
    const x25519Private = sodium.crypto_sign_ed25519_sk_to_curve25519(libsodiumKP.privateKey);
    const x25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(libsodiumKP.publicKey);

    const ed25519PrivB64 = jose.base64url.encode(ed25519PrivateKey.value);
    const ed25519PubB64 = jose.base64url.encode(ed25519PublicKey.value);
    const x25519PrivB64 = jose.base64url.encode(x25519Private);
    const x25519PubB64 = jose.base64url.encode(x25519Public);

    await addSecurityKeyDual(
      ed25519PrivB64,
      ed25519PubB64,
      generateFingerprint(ed25519PubB64),
      x25519PrivB64,
      x25519PubB64,
      generateFingerprint(x25519PubB64),
      'Auto-generated'
    );

    console.log('✅ Auto-generated security clearance key pair');
    return { ed25519PublicKey: ed25519PubB64, x25519PublicKey: x25519PubB64 };
  } catch (err) {
    console.error('❌ Failed to ensure security clearance keys:', err);
    return null;
  }
}
