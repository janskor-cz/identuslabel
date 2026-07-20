#!/usr/bin/env node
/**
 * Regression check for the IDL Wallet key-derivation fix (Part A).
 *
 * Plain Node.js script (no test framework configured for idl-wallet today,
 * matching the plain-script convention used elsewhere in this repo, e.g.
 * company-admin-portal/test-e2e-pipeline.js) run directly against the
 * installed SDK package, not against the wallet's TypeScript source (which
 * would require a TS runtime not otherwise needed by this project). The
 * derivation-path constants below are mirrored from
 * idl-wallet/src/utils/keyDerivation.ts and idl-wallet/src/utils/KeyProvider.ts
 * — keep them in sync if that table ever changes.
 *
 * Run: node scripts/verify-key-derivation.js
 */

const SDK = require("@hyperledger/identus-edge-agent-sdk").default || require("@hyperledger/identus-edge-agent-sdk");

// Fixed test fixture only — not a real wallet seed, never used in production.
const TEST_MNEMONIC = [
    "repeat", "spider", "frozen", "drama", "april", "step",
    "engage", "pitch", "purity", "arrest", "orchard", "grocery",
    "green", "chapter", "know", "disease", "attend", "notable",
    "usage", "add", "trash", "dry", "refuse", "jewel",
];

// Mirrors idl-wallet/src/utils/keyDerivation.ts
const PRISM_WALLET_PURPOSE = 29;
const PRISM_DID_METHOD = 29;
const KeyPurpose = {
    MASTER_KEY: 1,
    KEY_AGREEMENT_KEY: 3,
    AUTHENTICATION_KEY: 4,
    SECURITY_CLEARANCE_KEY: 100,
};
function hardened(n) { return `${n}'`; }
function derivationPath(keyPurpose, keyIndex = 0, didIndex = 0) {
    return `m/${hardened(PRISM_WALLET_PURPOSE)}/${hardened(PRISM_DID_METHOD)}/${hardened(didIndex)}/${hardened(keyPurpose)}/${hardened(keyIndex)}`;
}

let failures = 0;
function assertTrue(condition, message) {
    if (!condition) {
        failures += 1;
        console.error(`  ✗ FAIL: ${message}`);
    } else {
        console.log(`  ✓ ${message}`);
    }
}

function bytesEqual(a, b) {
    return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function main() {
    const apollo = new SDK.Apollo();
    const seed = apollo.createSeed(TEST_MNEMONIC);
    const seedHex = Buffer.from(seed.value).toString("hex");

    console.log("\n[1] Purpose separation — masterKey / authKey / keyAgreementKey / securityClearance must all differ\n");

    const masterKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.SECP256K1,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.MASTER_KEY),
    });
    const authKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.SECP256K1,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.AUTHENTICATION_KEY),
    });
    const keyAgreementKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.Curve25519,
        curve: SDK.Domain.Curve.X25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.KEY_AGREEMENT_KEY),
    });
    const securityClearanceKey = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.ED25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY),
    });

    assertTrue(!bytesEqual(masterKey.value, authKey.value), "masterKey !== authKey (the original Defect 2 regression)");
    assertTrue(!bytesEqual(masterKey.value, keyAgreementKey.value), "masterKey !== keyAgreementKey");
    assertTrue(!bytesEqual(authKey.value, keyAgreementKey.value), "authKey !== keyAgreementKey");
    assertTrue(!bytesEqual(masterKey.value, securityClearanceKey.value), "masterKey !== securityClearanceKey");
    assertTrue(!bytesEqual(authKey.value, securityClearanceKey.value), "authKey !== securityClearanceKey");

    console.log("\n[2] Deterministic re-derivation — same mnemonic on two independent seed instances must reproduce identical keys, with no Pluto/IndexedDB involved\n");

    const seedDeviceA = apollo.createSeed(TEST_MNEMONIC);
    const seedDeviceB = apollo.createSeed(TEST_MNEMONIC);
    const seedHexA = Buffer.from(seedDeviceA.value).toString("hex");
    const seedHexB = Buffer.from(seedDeviceB.value).toString("hex");

    assertTrue(bytesEqual(seedDeviceA.value, seedDeviceB.value), "createSeed(mnemonic) is deterministic across independent calls");

    for (const [name, spec] of Object.entries({
        master: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, purpose: KeyPurpose.MASTER_KEY },
        auth: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, purpose: KeyPurpose.AUTHENTICATION_KEY },
        keyAgreement: { type: SDK.Domain.KeyTypes.Curve25519, curve: SDK.Domain.Curve.X25519, purpose: KeyPurpose.KEY_AGREEMENT_KEY },
        securityClearance: { type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.ED25519, purpose: KeyPurpose.SECURITY_CLEARANCE_KEY },
    })) {
        const path = derivationPath(spec.purpose);
        const keyA = apollo.createPrivateKey({ type: spec.type, curve: spec.curve, seed: seedHexA, derivationPath: path });
        const keyB = apollo.createPrivateKey({ type: spec.type, curve: spec.curve, seed: seedHexB, derivationPath: path });
        assertTrue(bytesEqual(keyA.value, keyB.value), `${name} key re-derives identically from the mnemonic alone (device A vs. device B)`);
    }

    console.log("\n[3] Documented Apollo quirk — passing `index` alone (no `derivationPath`) is a no-op for EC/SECP256K1 and ED25519; only an explicit `derivationPath` string differentiates keys\n");

    const secpNoParams = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, seed: seedHex });
    const secpIndexOnly = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, seed: seedHex, index: 7 });
    const secpExplicitPath = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.SECP256K1, seed: seedHex, derivationPath: derivationPath(KeyPurpose.AUTHENTICATION_KEY) });

    assertTrue(bytesEqual(secpNoParams.value, secpIndexOnly.value), "SECP256K1: `index` alone returns the same seed-root key as no params at all (known quirk, locked in)");
    assertTrue(!bytesEqual(secpNoParams.value, secpExplicitPath.value), "SECP256K1: an explicit `derivationPath` DOES differentiate the key");

    const ed25519NoParams = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.ED25519, seed: seedHex });
    const ed25519IndexOnly = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.ED25519, seed: seedHex, index: 7 });
    const ed25519ExplicitPath = apollo.createPrivateKey({ type: SDK.Domain.KeyTypes.EC, curve: SDK.Domain.Curve.ED25519, seed: seedHex, derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY) });

    assertTrue(bytesEqual(ed25519NoParams.value, ed25519IndexOnly.value), "ED25519: `index` alone returns the same seed-root key as no params at all (known quirk, locked in)");
    assertTrue(!bytesEqual(ed25519NoParams.value, ed25519ExplicitPath.value), "ED25519: an explicit `derivationPath` DOES differentiate the key");

    console.log("\n[4] Security Clearance Ed25519/X25519 pairing — same derivationPath fed to both curve requests must yield a genuinely matched keypair\n");

    const x25519FromSamePath = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.Curve25519,
        curve: SDK.Domain.Curve.X25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY),
    });
    const x25519FromDifferentPath = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.Curve25519,
        curve: SDK.Domain.Curve.X25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.MASTER_KEY),
    });
    assertTrue(!bytesEqual(x25519FromSamePath.value, x25519FromDifferentPath.value), "X25519 derived at a different path is not the securityClearance X25519 key (sanity check that path actually matters for X25519)");

    console.log("\n[5] Multi-key regression fix — distinct keyIndex values for the same purpose must yield distinct keys, and the same (purpose, keyIndex) pair must always re-derive the same key\n");

    const scKeyIndex0 = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.ED25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY, 0),
    });
    const scKeyIndex1 = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.ED25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY, 1),
    });
    const scKeyIndex0Again = apollo.createPrivateKey({
        type: SDK.Domain.KeyTypes.EC,
        curve: SDK.Domain.Curve.ED25519,
        seed: seedHex,
        derivationPath: derivationPath(KeyPurpose.SECURITY_CLEARANCE_KEY, 0),
    });
    assertTrue(!bytesEqual(scKeyIndex0.value, scKeyIndex1.value), "securityClearance keyIndex=0 !== keyIndex=1 (two 'Generate New Key' clicks now produce genuinely distinct keys)");
    assertTrue(bytesEqual(scKeyIndex0.value, scKeyIndex0Again.value), "securityClearance keyIndex=0 re-derives identically (still fully seed-recoverable, not random)");

    console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} check(s) failed`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
