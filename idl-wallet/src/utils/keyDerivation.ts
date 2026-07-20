import SDK from "@hyperledger/identus-edge-agent-sdk";

// Mirrors the SDK's internal PrismDerivationPath schema
// (domain/models/derivation/schemas/PrismDerivation.ts), which is not re-exported
// from the SDK's public `SDK.Domain` barrel. Building the path string by hand here
// avoids requiring an SDK rebuild while still producing paths the SDK's own HDKey/
// EdHDKey derivation (Apollo.createPrivateKey's `derivationPath` param) understands.
const PRISM_WALLET_PURPOSE = 29; // 0x1D
const PRISM_DID_METHOD = 29; // 0x1D

// Reuses the SDK's own KeyUsage numbering (SDK.Domain.KeyUsage) for the three
// DID-document key purposes, plus one out-of-band purpose for keys that are
// never published in a DID document.
export const KeyPurpose = {
    MASTER_KEY: SDK.Domain.KeyUsage.MASTER_KEY,
    KEY_AGREEMENT_KEY: SDK.Domain.KeyUsage.KEY_AGREEMENT_KEY,
    AUTHENTICATION_KEY: SDK.Domain.KeyUsage.AUTHENTICATION_KEY,
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
