import SDK from "@hyperledger/identus-edge-agent-sdk";
import { KeyPurpose, derivationPath } from "./keyDerivation";

export type KeyPurposeName = "master" | "auth" | "keyAgreement" | "securityClearance" | "securityClearanceX25519";

// securityClearanceX25519 intentionally shares its keyPurpose (path) with securityClearance:
// Apollo's X25519 branch derives the Ed25519 root at that path internally and birationally
// maps it, so requesting both curves at the same path yields a genuinely paired keyset.
const PURPOSE_SPEC: Record<KeyPurposeName, { type: SDK.Domain.KeyTypes; curve: SDK.Domain.Curve; keyPurpose: number }> = {
    master: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, keyPurpose: KeyPurpose.MASTER_KEY },
    auth: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, keyPurpose: KeyPurpose.AUTHENTICATION_KEY },
    keyAgreement: { type: SDK.Domain.KeyTypes.Curve25519, curve: SDK.Domain.Curve.X25519, keyPurpose: KeyPurpose.KEY_AGREEMENT_KEY },
    securityClearance: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.ED25519, keyPurpose: KeyPurpose.SECURITY_CLEARANCE_KEY },
    securityClearanceX25519: { type: SDK.Domain.KeyTypes.Curve25519, curve: SDK.Domain.Curve.X25519, keyPurpose: KeyPurpose.SECURITY_CLEARANCE_KEY },
};

export interface KeyProvider {
    derivePrivateKey(purpose: KeyPurposeName, keyIndex?: number): SDK.Domain.PrivateKey;
    derivePublicKey(purpose: KeyPurposeName, keyIndex?: number): SDK.Domain.PublicKey;
}

/**
 * Centralizes the purpose -> derivation-path lookup so every key-creation call site
 * uses a distinct HD path per purpose instead of deriving with identical parameters.
 * Does not reimplement any cryptography - Apollo's own createPrivateKey does the
 * actual HD derivation once given an explicit `derivationPath` string.
 *
 * `keyIndex` defaults to 0 (one key per purpose) but purposes that support multiple
 * distinct keys - e.g. Security Clearance's "generate another key" flow - can pass an
 * incrementing index to get a genuinely different, still seed-recoverable key.
 */
export class LocalKeyProvider implements KeyProvider {
    constructor(private apollo: SDK.Apollo, private seed: SDK.Domain.Seed) { }

    private derivationPathFor(purpose: KeyPurposeName, keyIndex: number): string {
        return derivationPath(PURPOSE_SPEC[purpose].keyPurpose, keyIndex);
    }

    derivePrivateKey(purpose: KeyPurposeName, keyIndex = 0): SDK.Domain.PrivateKey {
        const spec = PURPOSE_SPEC[purpose];
        const seedHex = Buffer.from(this.seed.value).toString("hex");
        return this.apollo.createPrivateKey({
            type: spec.type,
            curve: spec.curve,
            seed: seedHex,
            derivationPath: this.derivationPathFor(purpose, keyIndex),
        });
    }

    derivePublicKey(purpose: KeyPurposeName, keyIndex = 0): SDK.Domain.PublicKey {
        return this.derivePrivateKey(purpose, keyIndex).publicKey();
    }
}

/**
 * Convenience wrapper for the common case of needing both halves of a Security
 * Clearance dual-key at once (used both when generating a new key and when
 * re-deriving an existing one on demand instead of reading persisted private bytes).
 */
export function deriveSecurityClearanceKeyPair(
    apollo: SDK.Apollo,
    seed: SDK.Domain.Seed,
    keyIndex: number
): { ed25519: SDK.Domain.PrivateKey; x25519: SDK.Domain.PrivateKey } {
    const provider = new LocalKeyProvider(apollo, seed);
    return {
        ed25519: provider.derivePrivateKey("securityClearance", keyIndex),
        x25519: provider.derivePrivateKey("securityClearanceX25519", keyIndex),
    };
}
