/**
 * Ensures a dual-key (Ed25519 + X25519) security clearance key exists.
 * Auto-generates one if none is present.
 * Returns the public keys, or null on failure.
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';
import * as jose from 'jose';
import {
  getSecurityClearanceKeys,
  addSecurityKeyDual,
  generateFingerprint,
} from './securityKeyStorage';
import { deriveSecurityClearanceKeyPair } from './KeyProvider';

const apollo = new SDK.Apollo();

export async function ensureSecurityClearanceKeys(defaultSeed: SDK.Domain.Seed | null): Promise<{
  ed25519PublicKey: string;
  x25519PublicKey: string;
} | null> {
  try {
    // Return existing keys if present
    const existing = getSecurityClearanceKeys();
    if (existing?.ed25519PublicKey && existing?.x25519PublicKey) {
      return { ed25519PublicKey: existing.ed25519PublicKey, x25519PublicKey: existing.x25519PublicKey };
    }

    if (!defaultSeed) {
      console.warn('⚠️ [ensureSecurityClearanceKeys] Wallet seed not ready yet');
      return null;
    }

    // Derive Ed25519 + X25519 from the wallet's own seed at the same dedicated
    // derivation path (see SecurityClearanceKeyManager.tsx for the full rationale),
    // instead of a fresh throwaway random mnemonic each time. This auto-provision path
    // only ever creates the first key (index 0) - the user-driven "generate new key"
    // flow in SecurityClearanceKeyManager.tsx is what advances the index for
    // additional distinct keys.
    const keyIndex = 0;
    const { ed25519: ed25519PrivateKey, x25519: x25519PrivateKey } = deriveSecurityClearanceKeyPair(apollo, defaultSeed, keyIndex);

    const ed25519PubB64 = jose.base64url.encode(ed25519PrivateKey.publicKey().value);
    const x25519PubB64 = jose.base64url.encode(x25519PrivateKey.publicKey().value);

    await addSecurityKeyDual(
      ed25519PubB64,
      generateFingerprint(ed25519PubB64),
      x25519PubB64,
      generateFingerprint(x25519PubB64),
      'Auto-generated',
      keyIndex
    );

    console.log('✅ Auto-generated security clearance key pair');
    return { ed25519PublicKey: ed25519PubB64, x25519PublicKey: x25519PubB64 };
  } catch (err) {
    console.error('❌ Failed to ensure security clearance keys:', err);
    return null;
  }
}
