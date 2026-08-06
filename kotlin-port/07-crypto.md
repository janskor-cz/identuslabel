# 07 — Cryptography

Covers Phase 5. Everything here is **outside** the Identus SDK — the wallet's own crypto, built on
libsodium/tweetnacl and WebCrypto in the browser. All of it needs a JVM/Android equivalent.

**Rule: no crypto in this document may be reimplemented from its description alone.** Each section
names the exact primitive and parameters; port those, and verify against the live services, which are
the other half of every one of these protocols.

## 7.0 Library choices

| Need | Browser (current) | JVM | Android |
|---|---|---|---|
| NaCl box (X25519 + XSalsa20-Poly1305) | `tweetnacl`, `libsodium-wrappers` | **lazysodium-java** (libsodium JNA) | lazysodium-android |
| Ed25519 / X25519 raw keys | tweetnacl / Apollo | BouncyCastle or lazysodium | same |
| secp256k1 (ES256K, DER sigs) | Apollo (SDK) | **Apollo (SDK)** — `agent.signWith` | same |
| AES-256-GCM | WebCrypto `crypto.subtle` | JCA `AES/GCM/NoPadding` | same |
| PBKDF2-HMAC-SHA256 | WebCrypto | JCA `PBKDF2WithHmacSHA256` | same |
| SHA-256 / SHA-512 | WebCrypto / `@noble/hashes` | JCA `MessageDigest` | same |
| multibase (base58btc) / base64url | `multiformats` | small impl or BouncyCastle | same |
| Secret storage | `localStorage` ⚠️ | **JVM keystore / OS credential store** | Android Keystore |
| JWT (JWS) | `jose` | nimbus-jose-jwt, or Apollo where ES256K | same |

**Prefer lazysodium over a pure-Kotlin NaCl reimplementation.** These are interoperability protocols
with a live counterparty; a subtly different implementation fails at decryption time, in production,
with no useful error.

`SecureRandom` (JVM) / `Random.nextBytes` — never `Math.random()`'s equivalent, and never a seeded
PRNG, for nonces, salts, ephemeral keys, or request ids (`05` §5.0).

## 7.1 Message encryption — NaCl box

`utils/messageEncryption.ts` (541 lines). Version 2.0 of the design; the comment records that v1
did a runtime Ed25519→X25519 conversion, which was **eliminated** in favour of native X25519 keys
carried in the Security Clearance VC. Do not reintroduce the conversion.

- **Primitive:** NaCl `box` — X25519 ECDH + XSalsa20-Poly1305 authenticated encryption.
- **Keys:** native X25519, always exactly **32 bytes** each. Validate the length and reject
  otherwise; the TS code does.
- **Nonce:** random **24 bytes**, fresh per message. Never reused, never derived from the message.
- **Wire format:** base64url, carried in `StandardMessageBody.encryptionMeta` (`05` §5.0) —
  `ciphertext`, `nonce`, `recipientPublicKey`, `senderPublicKey`, `algorithm`. The body's `content`
  is the literal string `"[ENCRYPTED]"`.

Public keys come from the peer's Security Clearance VC (`credentialSubject.publicKey`), obtained via
the **automatic VC handshake** (`04` §4.8) — modelled on TLS certificate exchange, and the reason
that handshake auto-responds without user approval.

**Both `senderPublicKey` and `recipientPublicKey` are on the wire.** Do not trust `senderPublicKey`
as an identity claim: verify it against the sender's Security Clearance VC via the key↔VC binding
(§7.3). Otherwise anyone can encrypt with a self-generated key and the message decrypts fine while
proving nothing about who sent it.

`utils/sectionDecryptor.ts` and `components/EncryptedMessageBadge.tsx` are the read side;
`components/SecurityLevelSelector.tsx` chooses the classification.

## 7.2 Ephemeral document access — Perfect Forward Secrecy

`utils/EphemeralDIDCrypto.ts` (460 lines). Per-document-access forward secrecy.

Model:
- A **fresh X25519 keypair per document access**, with a unique "ephemeral DID" identifier.
- The **private key is destroyed immediately after decryption**.
- The server never sees the ephemeral private key.
- Compromise of the server later does not expose past sessions.

Exports: `generateEphemeralKeyPair()` → `EphemeralKeyPair(publicKey, secretKey, ephemeralDID)`;
`AccessRequestPayload` (Ed25519-signed for non-repudiation); `EncryptedDocumentResponse`;
`DecryptionResult`.

**Kotlin hazards, both worse on JVM than in a browser:**

1. **"Destroy the key" is not free.** JVM `ByteArray` must be explicitly zeroed
   (`array.fill(0)`), and the GC may already have copied it. Never hold ephemeral secrets in a
   `String` — strings are immutable and interned, and cannot be wiped. Use `ByteArray` in a
   `try/finally` that zeroes in the `finally`.
2. Keys are currently cached under `ephemeral-key-<did>` in the prefixed KV store (`03` §3.7) — i.e.
   in `localStorage`. In Kotlin, keep them **in memory only** for the access duration; if persistence
   is genuinely required across a restart, use the platform keystore. This is a deliberate
   improvement, so state it as a behaviour change rather than a silent one.

Related: `utils/documentStorage.ts` keys documents by `ephemeralDID`;
`components/DocumentDIDAccess.tsx`, `ClassifiedDocumentViewer.tsx`, `DocumentAccess.tsx`.

## 7.3 Key ↔ VC binding

`utils/keyVCBinding.ts` (404 lines). Binds an encryption key to a Security Clearance VC by public-key
fingerprint: the VC carries a `keyFingerprint` claim that must match the fingerprint of the stored
private key.

Also contains `validateSecurityClearanceVC` — the three-way conjunction documented in
`06-trust-model.md` §6.4 (schema **and** trusted issuer **and** `clearanceLevel` present). That
function is the real validation gate behind the empty-claims workaround; the two must be ported
together.

Fingerprints: `generateFingerprint(publicKeyBytes)` in `utils/securityKeyStorage.ts:15` produces a
colon-separated hex form (`"AB:CD:EF:…"`). Port the **exact** formatting — it is compared as a string
against the VC claim, so a different separator or case silently breaks binding for every existing VC.

## 7.4 Holder proof-of-possession

`utils/holderProof.ts` (62 lines) — small but load-bearing.

Signs `${challenge}.${documentDID}.${ephemeralPublicKey}` with the credential subject's
**secp256k1** key (ES256K, the same algorithm the JWT credentials use). Apollo returns a **DER**
signature; it is base64'd for transport and the server verifies DER directly with Node `crypto`.

**Best-effort by design, and the reason matters.** Enterprise-issued credentials (`EmployeeRole`,
`SecurityClearanceGrant`) are custodied by the **enterprise cloud agent**, so their subject key is
not in this wallet's Pluto at all — there is no way to produce a holder proof for them. In that case
the function returns `null` and the caller presents a **bearer VP**, which the document service still
fully verifies (issuer signature, releasability, clearance level).

So: `null` is a **valid, expected outcome**, not an error. A Kotlin port that throws instead of
returning null breaks all enterprise-credential document access.

**Kotlin improvement:** use `EdgeAgent.signWith(did, message)` (`01` §B.3) rather than reaching into
Pluto for raw key bytes as the TS code does. It handles both Ed25519 and secp256k1 and keeps key
material inside the SDK. Verify the output is DER-encoded and base64 it identically — the server
side is unchanged and will reject any other encoding.

## 7.5 Iagon backup — AES-256-GCM

`utils/walletCrypto.ts` (135 lines). Client-side encryption for wallet backups pushed to Iagon
decentralised storage. **The plaintext backup never leaves the device.**

Exact parameters — match them if cross-restore with the TS wallet is required:

| Parameter | Value |
|---|---|
| KDF | PBKDF2-HMAC-**SHA-256**, **100 000** iterations |
| Salt | random **16 bytes**, stored base64 in the envelope |
| Cipher | **AES-256-GCM** |
| IV | random, per encryption |
| Auth tag | 16 bytes, **appended to the ciphertext** by SubtleCrypto |
| Envelope | base64-encoded JSON: `{ ciphertext, salt, iv, … }` |
| `generateCredentialHash` | `SHA-256("username_lowercase:password")` → 64-char hex — the server-side registry key (**the username itself is never sent**) |
| `generateContentHash` | `SHA-256(raw JWE string)` → 64-char hex — stored in the registry to detect wallet changes |

**JCA note:** Java's `AES/GCM/NoPadding` also appends the tag to the ciphertext, so the layout
matches WebCrypto — but the tag length must be set explicitly (`GCMParameterSpec(128, iv)`).
Verify with a round-trip against a TS-produced envelope before trusting it.

Two decisions to make deliberately:

1. **Whether TS→Kotlin restore must work.** If yes, every parameter above is frozen. If no, raise the
   KDF to Argon2id (or PBKDF2 with a far higher iteration count — 100 000 SHA-256 iterations is below
   current guidance). **Ask before assuming**; this is `01` §B.9 item 5.
2. This is distinct from the SDK's own `backupWallet()`/`recoverWallet()` JWE (`01` §B.3). The wallet
   uses **both**: the SDK JWE is the payload, and this layer encrypts it for Iagon. Keep them
   separate — `syncWalletBackup`, `backupToIagon`, `restoreFromIagon` in `actions/index.ts:3000-3200`,
   plus `components/BackupRestore.tsx` and `idl-wallet/data/wallet-registry.json`.

## 7.6 Key storage — the one place to deviate from the original

Current state, and it is the wallet's weakest point:

- `security-clearance-keys` — **private key material in `localStorage`**, and (per `03` §3.2)
  written **unprefixed**, so it leaks across user profiles on the same origin.
- `ephemeral-key-<did>` — ephemeral secrets in the prefixed KV store.
- `enterpriseAgentApiKey` — inside `ConnectionMetadata`, i.e. also `localStorage`.
- `defaultSeed` — in Redux state (`reducers/app.ts`), i.e. in memory and in any state dump.

In Kotlin, all four move:

| Secret | Destination |
|---|---|
| Security clearance private keys | Platform keystore (Android Keystore / JVM `KeyStore` with a user-derived password), or the encrypted `wallet.db` at minimum |
| Ephemeral X25519 secrets | **Memory only**, zeroed after use (§7.2) |
| Enterprise agent API keys | Keystore; store only a reference in `ConnectionMetadata` |
| Wallet seed | Keystore, never in UI state (`03` §3.5) |

`utils/securityKeyStorage.ts` (356 lines) is the full key lifecycle — `addSecurityKey`,
`addSecurityKeyDual`, `getSecurityKeyPrivateMaterial`, `getActiveSecurityKey`,
`setActiveSecurityKey`, `deleteSecurityKey`, `exportPublicKey`, `updateKeyUsage`, `isKeyExpired`,
`getValidKeys`, `clearAllKeys`, `getSecurityClearanceKeys(connectionDID?)`, plus
`getNextSecurityClearanceKeyIndex`. Port the **lifecycle unchanged** and swap only the backing store —
the key ids, fingerprints, expiry semantics, and active-key selection are all observable by the
services.

`utils/plutoKeyExtractor.ts`, `utils/KeyProvider.ts`, `utils/ensureSecurityKeys.ts`, and
`components/SecurityClearanceKeyManager.tsx` are the surrounding plumbing.

## 7.7 HD key derivation

`utils/keyDerivation.ts` (33 lines) — mirrors the SDK's **internal** `PrismDerivationPath` schema,
which is not re-exported from the public barrel. Building the path by hand avoids an SDK rebuild while
still producing paths the SDK's own HDKey/EdHDKey derivation understands.

```
m/29'/29'/didIndex'/keyPurpose'/keyIndex'      all segments hardened
PRISM_WALLET_PURPOSE = 29 (0x1D)
PRISM_DID_METHOD     = 29 (0x1D)
```

Key purposes reuse the SDK's `KeyUsage` numbering, **plus one out-of-band value**:

```kotlin
MASTER_KEY, KEY_AGREEMENT_KEY, AUTHENTICATION_KEY   // = SDK KeyUsage values
SECURITY_CLEARANCE_KEY = 100                        // deliberately outside KeyUsage's 0-7 range
```

The `100` is intentional: it can never collide with a DID-document verification-method purpose,
because these keys are **never published in a DID document**. Preserve the value and the comment —
changing it silently rederives every existing user's clearance keys, which cannot be recovered from
the VC.

**Kotlin check:** verify `sdk-kmp` exposes an equivalent derivation-path parameter on
`apollo.createPrivateKey`. If it does export `PrismDerivationPath` publicly, use that instead of
hand-building the string — but assert the produced path matches the format above.

## 7.8 Base64 and encoding

`utils/base64Utils.ts` (296 lines) plus `safeBase64Decode` / `safeBase64ParseJSON` in
`vcValidation.ts`. These are large because they handle base64 **and** base64url, padded and
unpadded, and fail soft with a `{isValid, data?, error?}` result rather than throwing — invitations
and attachments arrive in all these shapes.

Port as a small `Base64` object with explicit `standard`/`url` and `padded`/`unpadded` variants, and
keep the soft-failure result type for anything parsing untrusted input. Kotlin's
`Base64.UrlSafe` differs from JS `base64url` on padding — **test both directions against real
invitation strings** from the live CA.

## 7.9 Do not port

- `components/WasmMemoryGuard.tsx`, `utils/MemoryMonitor.ts`, `utils/RouteMemoryCleanup.ts` — these
  exist solely for browser WASM memory accumulation (`CLAUDE.md` Known Issue #5). No JVM equivalent.
- `crypto`, `fs`, `path`, `buffer` npm shims in `package.json` — Node-polyfill artefacts.

## 7.10 Crypto test requirements

Every item below is an **interop** test against the live services, not a self-consistency test.
Self-consistency proves nothing here — a wrong-but-symmetric implementation passes.

1. NaCl box: encrypt in Kotlin → decrypt in the TS wallet, and the reverse.
2. Holder PoP: Kotlin-produced DER/base64 signature accepted by `document-service`.
3. Iagon envelope: TS-produced envelope decrypts in Kotlin (only if §7.5 decision 1 is "yes").
4. Fingerprints: Kotlin `generateFingerprint` matches the `keyFingerprint` in an existing VC.
5. Derivation paths: a Kotlin-derived key matches the TS-derived key for the same seed and purpose.
6. multibase: the live CA's `publicKeyMultibase` decodes to the same raw bytes as the TS path
   (`06` §6.5).
7. Base64: round-trip real invitation strings in all four variants.
