// Mirrors the SDK's internal PrismDerivationPath schema
// (domain/models/derivation/schemas/PrismDerivation.ts), which is not re-exported
// from the SDK's public `SDK.Domain` barrel. Building the path string by hand here
// avoids requiring an SDK rebuild while still producing paths the SDK's own HDKey/
// EdHDKey derivation (Apollo.createPrivateKey's `derivationPath` param) understands.
const PRISM_WALLET_PURPOSE = 29; // 0x1D
const PRISM_DID_METHOD = 29; // 0x1D

// ⚠️ THESE ORDINALS FEED HD DERIVATION PATHS — CHANGING ONE SILENTLY RE-DERIVES EVERY
// EXISTING USER'S KEYS, WHICH CANNOT BE RECOVERED FROM THE CREDENTIAL. Do not "tidy" them.
//
// These are the PRISM protocol's own KeyUsage wire constants
// (protos: io.iohk.atala.prism.protos.KeyUsage). They are fixed by the protocol — changing one
// would invalidate every PRISM DID on the network — so defining them here is safe and stable.
//
// v6 exposed them as `SDK.Domain.KeyUsage`. v7 removed that export: the enum now lives at
// `build/domain/models/derivation/schemas/PrismDerivation` as `PrismDIDKeyUsage`, which is NOT
// re-exported from the package root. Rather than deep-import an internal path that will move
// again at v8, the three values are inlined. Verified byte-identical between the v6 fork and
// v7.0.0 (build/castor/protos/node_models.d.ts):
//     UNKNOWN_KEY=0  MASTER_KEY=1  ISSUING_KEY=2  KEY_AGREEMENT_KEY=3
//     AUTHENTICATION_KEY=4  REVOCATION_KEY=5  CAPABILITY_INVOCATION_KEY=6
//     CAPABILITY_DELEGATION_KEY=7
// If a future SDK re-exports them publicly, prefer that over these literals — but assert
// equality with the values below first.
export const KeyPurpose = {
    MASTER_KEY: 1,
    KEY_AGREEMENT_KEY: 3,
    AUTHENTICATION_KEY: 4,
    // Arbitrary, deliberately outside the SDK's real KeyUsage range (0-7) so it can
    // never collide with a DID-document verification-method purpose.
    SECURITY_CLEARANCE_KEY: 100,
} as const;

function hardened(n: number): string {
    return `${n}'`;
}

/**
 * Builds a hardened HD derivation path string in the same 5-segment shape as the
 * SDK's internal PrismDerivationPath: m/walletPurpose'/didMethod'/didIndex'/keyPurpose'/keyIndex'
 */
export function derivationPath(keyPurpose: number, keyIndex = 0, didIndex = 0): string {
    return `m/${hardened(PRISM_WALLET_PURPOSE)}/${hardened(PRISM_DID_METHOD)}/${hardened(didIndex)}/${hardened(keyPurpose)}/${hardened(keyIndex)}`;
}
