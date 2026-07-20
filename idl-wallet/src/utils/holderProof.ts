/**
 * holderProof.ts
 *
 * Produces a holder proof-of-possession signature for document-service access.
 *
 * The document-service issues a one-time challenge bound to the document and the
 * wallet's ephemeral X25519 key. To prove the presenter actually controls the
 * credential subject's DID (and to bind the presentation to this exact request),
 * the wallet signs `${challenge}.${documentDID}.${ephemeralPublicKey}` with the
 * subject's secp256k1 key — the same key type (ES256K) the JWT credentials use,
 * which the server verifies against the holder DID's verification methods.
 *
 * Apollo's secp256k1 sign() returns a DER-encoded signature; we base64 it for
 * transport, and the server verifies DER directly with Node crypto.
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';

/**
 * Sign an access-challenge message with the holder's credential-subject key —
 * *best effort*. Enterprise-issued credentials (EmployeeRole, SecurityClearanceGrant)
 * are custodied by the enterprise cloud agent, so their subject key is NOT in this
 * browser's Pluto; there is no way to produce a holder proof for them here. In that
 * case we return null and the caller presents a bearer VP, which the document service
 * still fully verifies (issuer signature, releasability, clearance level). When the
 * wallet *does* control the subject key (personal/CA-issued credentials), we return a
 * real signature as defense-in-depth.
 *
 * @param agent     the running SDK agent (has pluto with the subject's private keys)
 * @param holderDID the credential subject DID (shared by the presented VCs)
 * @param message   canonical challenge message to sign
 * @returns base64 DER secp256k1 signature, or null if this wallet can't sign for holderDID
 */
export async function signHolderChallenge(
  agent: any,
  holderDID: string,
  message: string
): Promise<string | null> {
  try {
    if (!agent?.pluto) return null;

    const did = SDK.Domain.DID.fromString(holderDID);
    const privateKeys = await agent.pluto.getDIDPrivateKeysByDID(did);
    if (!privateKeys || privateKeys.length === 0) {
      console.log(`[holderProof] No local key for holder ${holderDID.slice(0, 32)}… — presenting bearer VP (enterprise-custodied credential).`);
      return null;
    }

    // JWT credentials (and thus the holder DID's assertion/auth keys) are secp256k1.
    const key =
      privateKeys.find((k: any) => k.curve === SDK.Domain.Curve.SECP256K1 && typeof k.sign === 'function') ||
      privateKeys.find((k: any) => typeof k.sign === 'function');
    if (!key || typeof key.sign !== 'function') return null;

    const sig = await key.sign(new TextEncoder().encode(message));
    const sigBytes = sig instanceof Uint8Array ? sig : new Uint8Array(sig);
    return Buffer.from(sigBytes).toString('base64');
  } catch (err) {
    console.warn('[holderProof] Holder signing failed, presenting bearer VP:', (err as Error).message);
    return null;
  }
}
