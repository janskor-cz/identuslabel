# 06 — Trust Model

Covers Phase 4. Read with `05-protocols.md`. **This is the security core of the wallet.** Every
mechanism here exists because a simpler one was tried and found broken; the rejected designs are
documented so they are not retried.

Five independent trust decisions, each with its own anchor:

| # | Decision | Anchor | Source |
|---|---|---|---|
| 1 | May this sender grant this capability? | sender's **actual DID** + capability allowlist | `utils/serviceAccessGrant.ts` |
| 2 | May this redirect URL be opened? | per-DID **origin allowlist**, fail-closed | same |
| 3 | Is this credential's issuer trusted for its type? | issuer DID registry (+ schema pin for one type) | `utils/trustRegistry.ts`, `utils/vcValidation.ts` |
| 4 | Is the peer who they claimed to be, *live*? | authentication-scoped signature + bait-and-switch anchors | `utils/liveIdentityVerification.ts` |
| 5 | Is this the same CA/company as last time? | TOFU pin | `utils/prefixedStorage.ts` |

## 6.1 Two rejected designs — do not retry

`utils/liveIdentityVerification.ts`'s 60-line header comment records the history. Read it in the
original before touching this area.

**Rejected #1 — DID string equality.** Comparing the DID in an invitation's `vc-proof-0` attachment
against the connecting party's DID. Confirmed broken: it proves nothing about *possession*, only that
the same string appears twice. Anyone can copy a VC-JWT and present it.

**Rejected #2 — self-signed proof-of-possession JWT at invitation time.** Found insufficient: an OOB
invitation is a **one-shot, pre-connection artifact with no live verifier-issued challenge**. A
self-signed proof has no freshness anchor, so it is replayable. The file it lived in
(`holderProofOfPossession.ts`) was removed; only its verification *loop* was salvaged.

**Accepted design.** Let the connection establish on the **unverified preview alone**, then — once a
live DIDComm channel exists — send a *fresh* present-proof request with a challenge the inviter
cannot have precomputed, and upgrade the connection's trust state only after verifying the response.

The consequence for the port: **a connection is expected to exist in an unverified state.** That is
not a bug to fix. `ConnectionMetadata.identityVerificationStatus` tracks it, and a failed
verification is a **soft** "leave as unverified" — never a reason to tear down an established
connection.

## 6.2 Decision 1 — may this sender grant this capability?

Port `isTrustedGrantSender` (`utils/serviceAccessGrant.ts:116`) as-is. Its structure matters more
than its current data.

```kotlin
fun isTrustedGrantSender(
    message: WalletMessage, connections: List<DidPair>, capability: String
): GrantTrust
data class GrantTrust(val trusted: Boolean, val originAllowlist: List<String>? = null)
```

The anchor is `message.from` — **the DID that actually sent the message**. Two tiers, in order:

**Tier 1 — deployment-pinned exact-DID allowlist.** `TRUSTED_SERVICES` in `config/serviceTrust.ts`.
Currently **empty by design**, with the reason stated: no wallet source file has a truthful hardcoded
CA/company-admin/document-service DID to seed it with. An operator deploying the wallet populates it.

```kotlin
data class TrustedServiceEntry(
    val did: String,                  // the actual cryptographic trust anchor
    val serviceName: String,
    val capabilities: List<String>,   // service-access/1.0 body.capability keys this DID may grant
    val originAllowlist: List<String> // allowed origins for this DID's redirect accessUrls
)
```

Keep it empty in Kotlin too, as **operator configuration**, not a compiled constant. Tier 1 is right
for a service with one fixed well-known DID; it does not scale to the multi-tenant services.

**Tier 2 — per-connection capabilities.** `ConnectionMetadata.capabilities`, written at
connection-establishment time from real evidence (e.g. an invitation fetched from a pinned HTTPS
well-known endpoint), keyed by **our** side of the pairing (`DIDPair.host`). This is the tier that
actually scales here, because company-admin and document-service have no single fixed DID.

The lookup maps sender → our metadata key:

```kotlin
val pair = connections.firstOrNull { it.receiver.toString() == senderDid } ?: return GrantTrust(false)
val meta = connectionMetadata.get(pair.host.toString())
```

`connection.receiver` is always the remote party; `connection.host` is our own side and the metadata
key. Getting this backwards makes every check pass or every check fail — write the test.

### What was replaced, and must not come back

The predecessor was `getConnectionMetadata(senderHostDID)?.isCAConnection`. Keying by our own
per-connection DID was structurally fine; **the value was not** — `isCAConnection` was itself derived
from matching a **mutable, locally-editable display name**. Rename a connection to "Certification
Authority" and it became trusted.

Worse, `components/Chat.tsx` had its own independent `getGrantFromMessage` with **no trust check at
all** — only an `isOwnMessage` filter, which excludes self-echo, not unauthorised senders. Both call
sites now share one parser and one check.

**Port instruction:** exactly **one** trust-check function, called by every consumer
(`_app.tsx`'s watcher, Chat, `DocumentAccessRequestor`). Enforce single-entry with an architecture
test if possible. `isCAConnection` may be read for migration; never written.

## 6.3 Decision 2 — origin allowlist for redirect grants, fail-closed

For `mode: redirect`, the `accessUrl`'s origin must be on the allowlist for that sender. The fallback
chain (`serviceAccessGrant.ts:150-185`), with each step's justification:

| Order | Source of origin | Why it's a legitimate anchor |
|---|---|---|
| 1 | `meta.enterpriseAgentUrl`'s origin | Recorded at connection time and already used for API calls — a real, non-guessed value |
| 2 | Pinned CA base URL (`config/certificationAuthority.ts`) | CA connections don't set `enterpriseAgentUrl`; the pinned URL is *what the connection was originally established from* |
| 3 | `https://identuslabel.cz` for `*-employee-portal` capabilities | company-admin's own deployment-pinned `COMPANY_PUBLIC_BASE_URL`; identical regardless of company, so not a per-company guess |
| 4 | **`null`** | Trusted for the capability, but **no known safe origin** |

**Case 4 is the critical one.** `originAllowlist: undefined` means the caller **must reject a
`mode: redirect` grant** — there is nothing to check the URL against. `mode: payload` grants have no
`accessUrl` to spoof, so their trust is fully determined by the capability check.

```kotlin
// FAIL CLOSED: no known origin ⇒ a redirect grant is rejected, not opened.
if (grant.mode is GrantMode.Redirect) {
    val allowed = trust.originAllowlist ?: return reject("no safe origin for this sender")
    if (Url(grant.accessUrl).origin !in allowed) return reject("origin not allowlisted")
}
```

Note step 3's history: a personal (`local`) wallet's company connection has no `enterpriseAgentUrl`
(that field is only set on the `walletType == 'cloud'` branch in `OOB.tsx`), so without that branch a
legitimate redirect grant was **always rejected**. Fail-closed defaults produce exactly this class of
"correct but unusable" bug — expect one or two during Phase 4, and fix them by adding a *justified*
anchor, never by loosening the default.

Errors are deliberately **not** trust-checked. The reasoning: worst case an untrusted sender causes a
bogus "access denied" for a request it can already observe, which grants no capability — a strict
improvement over the previous behaviour of silently dropping every error and leaving the status modal
spinning forever. Port that asymmetry, and port the comment explaining it.

## 6.4 Decision 3 — issuer trust

Two mechanisms, by credential type.

**Single-issuer pin — `RealPersonIdentity`.** Both the issuer DID and the schema id are hardcoded
(`utils/vcValidation.ts:8,20`):

```
TRUSTED_REALPERSON_ISSUER    = did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c
TRUSTED_REALPERSON_SCHEMA_ID = https://identuslabel.cz/cloud-agent/schema-registry/schemas/4755a426-b80b-3f6a-b9ea-ca202bd7ce16
```

**Multi-issuer registry — everything else.** `utils/trustRegistry.ts`'s `TRUSTED_ISSUERS` map plus
`isTrustedIssuer(issuerDID, credentialType?)`. Used for `SecurityClearance`,
`CertificationAuthorityIdentity`, and `CompanyIdentity`, which "are already issued from more than one
rotated CA DID and have no schema id pinned anywhere in this codebase."

**Both are operator configuration in Kotlin, not compiled constants** — CA DIDs rotate. But they must
be *configuration the user cannot edit at runtime from a message*; loading a trusted issuer from
anything a peer sent defeats the whole model.

`keyVCBinding.ts`'s `validateSecurityClearanceVC` shows the required conjunction — **all three**:

1. VC schema matches the Security Clearance schema
2. VC issuer is the trusted CA
3. VC contains a `clearanceLevel` claim

This is also what makes the empty-claims workaround safe (`04` §4.8): the proof request cannot
filter, so validation happens here instead. **If you keep empty claims, you must keep this
validation.** Dropping it while keeping empty claims accepts any credential from anyone.

Also present: `isCredentialRevoked` (`vcValidation.ts:688`) and `utils/credentialStatus.ts`.
Per `CLAUDE.md`, StatusList2021 revocation is eventually consistent (30 min – hours by design), so a
non-revoked result is not a strong guarantee. Surface revocation state in the UI; do not gate access
on it alone.

## 6.5 Decision 4 — live identity verification

The algorithm, from `verifyLiveIdentity` (`utils/liveIdentityVerification.ts:306`). All five checks
are required; the file is explicit that the SDK's own helper covers only the first group.

**What `agent.handlePresentation()` / Pollux already does:**
- nonce/challenge matches the exact request sent (correlated by thread id)
- a valid ES256K signature from *some* verification method of the signer DID
- the inner VC's signature is valid
- the inner VC's subject equals the outer presentation's signer

**What this file adds, because that is "necessary but not sufficient":**

1. **Authentication-scoped signature check.** `Pollux.JWT.verify()` accepts a signature from **any**
   entry in the signer's `verificationMethod` array — `assertionMethod`, `keyAgreement`, anything. A
   holder proving *live control of their identity DID* must sign with an **`authentication`** key
   specifically (DID-Auth convention; the same `keyPurpose='authentication'` distinction already used
   for VP-JWT holder signatures in `packages/service-access-didcomm/lib/jwtCrypto.js`). Implemented by
   trying each `authentication` verification method's `publicKeyMultibase` (`verifyAuthenticationSignature`,
   line 211).

2. **Issuer pinning per claimed type** — §6.4's per-type branch.

3. **Bait-and-switch anchors.** The live VC's **subject DID** and **`uniqueId`** must match the
   identity shown in the original `vc-proof-0` preview. Without this, a malicious inviter shows one
   (genuine, copied) person's VC as a preview, then live-proves possession of a *different* DID, and
   still gets upgraded to verified. `uniqueId` is compared exactly **when present**.

4. **Type-confusion check.** The live VC's own claimed type must match what the preview claimed.
   Otherwise a validly-signed credential of a *different type* satisfies the preview.

5. **Fail closed throughout.** Any missing / malformed / mismatched / timed-out piece returns
   `{ verified: false, error }`. Nothing throws past its own boundary — callers may `await` without
   try/catch and treat non-throwing `verified: false` as the only failure signal.

Only `RealPersonIdentity`, `SecurityClearance`, `CertificationAuthorityIdentity`, and `CompanyIdentity`
are verifiable (`LiveVerifiableCredentialType`). **Anything else is rejected fail-closed** — an
unknown type is not a pass.

### Kotlin notes

- `didsMatchTolerant` (line 195) — PRISM DIDs come in short (`did:prism:<hash>`) and long
  (`did:prism:<hash>:<keys>`) forms; compare **only the hash segment**. The same rule exists
  server-side as `prismDidsMatch` in `company-admin-portal/server.js`. Implement once, in `domain/`.
- `decodeJwtPayload` (183) and `decodeAttachmentJson` (278) — **decode without verifying**, used only
  to read claims *before* verification. Name them `decodeUnverified*` in Kotlin so no call site
  mistakes them for validation.
- Signature verification needs `publicKeyMultibase` → raw key: base58btc (multibase) and base64url
  decoding, currently via the `multiformats` package. On JVM use BouncyCastle or a small multibase
  implementation; **test against the live CA's DID document**, since multicodec prefix handling is
  where this usually breaks.
- Timeout is 5 minutes with a 500 ms poll, deliberately generous because a **human** approves on the
  responding side. Convert to a Flow + `withTimeout` (`04` §4.9); do not shorten.
- `verifyAndRecordLiveIdentity` (612) is the shared entry point three call sites funnel through
  (`OOB.tsx` ×2, `ConnectionRequest.tsx`). Keep it single-entry.
- The responding side needs **nothing new**: an inbound `request-presentation` is already handled
  generically by `UnifiedProofRequestModal` + `sendVerifiablePresentation`. Note the source comment
  that `components/Message.tsx`'s `acceptPresentationRequest` is **orphaned dead code** — not
  imported since `messages.tsx` was rewritten onto `Chat.tsx`. **Do not port `Message.tsx`.**

## 6.6 Decision 5 — TOFU pinning

`prefixedStorage.ts:139-338` implements trust-on-first-use for the CA and, symmetrically, companies:

```
CAPinData:      pinCA / getPinnedCA / isCAVerified / verifyPinnedCA / clearPinnedCA
CompanyPinData: pinCompany / getPinnedCompany / isCompanyVerified / verifyPinnedCompany / clearPinnedCompany
hashCredential(credentialJWT) → SHA-256 hex
```

Port as a `TofuPinStore` in the user scope. Two requirements:

- `verifyPinnedCA(caDID)` compares against the **pinned DID**. A mismatch means the CA's identity
  changed — that must surface to the user as a **security warning**, not a silent re-pin. Check the
  current behaviour and preserve whichever it is, but if it silently re-pins, that is worth flagging
  as a finding rather than porting.
- Pins are per-user (§3.1). Two profiles on one machine must be able to pin different CAs.

## 6.7 Security levels

`utils/securityLevels.ts` — the 5-level hierarchy, matching `CLAUDE.md`:

| Level | Name |
|---|---|
| 0 | UNCLASSIFIED |
| 1 | INTERNAL |
| 2 | CONFIDENTIAL |
| 3 | RESTRICTED |
| 4 | SECRET |

Port `SecurityLevel` as an enum with an ordinal, plus `parseSecurityLevel`, `canDecrypt`,
`getAccessibleLevels`, `isValidSecurityLevel`. Legacy mappings must be kept:
`TOP-SECRET` / `TOP_SECRET` / `TOPSECRET` → `SECRET` (renamed 2026-03-21).

Two hazards:

1. **`parseSecurityLevel` must not default silently.** An unrecognised string defaulting to
   `UNCLASSIFIED` would *grant* access; defaulting to `SECRET` would deny it. Return a nullable and
   force the caller to decide — inspect the current implementation and treat a silent default as a
   finding.
2. `StandardMessageBody.securityLevel` carries only 3 of the 5 values (`05` §5.0). Map at the
   boundary; do not narrow the domain enum.

`canDecrypt(userLevel, messageLevel)` is a **local UI gate**, not enforcement — the real gate is
cryptographic (`07-crypto.md`). Never present it as security.

## 6.8 Phase 4 exit criteria

1. `security-clearance` requested from the live CA completes end-to-end and opens the granted page.
2. A grant whose `capability` is not in the sender's `capabilities` is rejected.
3. A grant from a DID that is **not** the connection's `receiver` is rejected (spoofed sender).
4. A `mode: redirect` grant whose `accessUrl` origin is off-allowlist is rejected.
5. A `mode: redirect` grant from a sender with **no** known origin is rejected (fail-closed, §6.3).
6. An expired `expiresAt` is rejected regardless of trust.
7. A `service-access/1.0/error` surfaces in the status modal instead of spinning forever.
8. Live identity verification: a valid round trip upgrades the connection to `verified`; a live VC
   with a **different subject DID** than the preview is rejected (bait-and-switch); a live VC of a
   **different type** than the preview is rejected (type confusion); a signature from a
   non-`authentication` verification method is rejected.
9. A verification failure leaves the connection established-but-unverified, not torn down.
10. An unknown `LiveVerifiableCredentialType` is rejected, not passed through.
