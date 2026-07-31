# 05 — Custom DIDComm Protocols

Covers Phases 2 and 4. Read with `06-trust-model.md` — this document defines the *messages*; that
one defines when a message may be **believed**. Neither is safe to implement alone.

Authoritative source for `service-access/1.0` is
`packages/service-access-didcomm/PROTOCOL.md`. Where this document and that file disagree, **that
file wins** — it is the spec the three live services implement.

## 5.0 The BasicMessage envelope convention — and a wrapping inconsistency

All four custom protocols ride inside a standard
`https://didcomm.org/basicmessage/2.0/message`. Nothing invents a new transport; the convention is a
versioned JSON envelope under an owned domain, which is the normal DIDComm practice for a protocol
with no global spec (the SDK itself does this for `revocation-notification` under `atalaprism.io`).

### ⚠️ Two different wrapping depths are in use

`service-access/1.0/request` **double-wraps** (`actions/index.ts:2035`):

```ts
const protocolEnvelope = JSON.stringify({ type: '…/service-access/1.0/request', id, body: { capability } });
const standardBody = createPlaintextMessageBody(protocolEnvelope);   // → StandardMessageBody
const basicMsgBody = { content: JSON.stringify(standardBody) };      // → content is a JSON string
```

So the wire shape is `body.content` = JSON string of a `StandardMessageBody` whose own `.content` is
the JSON string of the protocol envelope. **Two levels.**

`credential-issuance/1.0` and `document-upload/1.0` **single-wrap**:

```ts
const basicMsgBody = { content: protocolEnvelope };                  // → content is the envelope
```

`parseServiceAccessGrant` reads `body.content` and `JSON.parse`s it **once**, which works for the
grant direction because the *service* single-wraps its replies. So the double wrap is present only
on the wallet's outbound `service-access` request, and only that one path.

**Port instruction:** implement a single `EnvelopeCodec` that, on read, unwraps **up to two** levels
— parse `content`; if the result is a `StandardMessageBody` (use `isStandardMessageBody`'s predicate:
has string `content`, number `timestamp`, boolean `encrypted`), parse its `.content` too. On write,
**single-wrap everything** and treat the double wrap as legacy inbound tolerance only. Do not
replicate the asymmetry; it is an accident, not a design. Verify against the live services before
changing outbound behaviour — `certification-authority/server.js` may be parsing the double wrap
specifically.

### `StandardMessageBody`

Defined in `src/types/StandardMessageBody.ts`; it is also the chat message format, and carries the
NaCl encryption metadata (`07-crypto.md` §7.1):

```kotlin
@Serializable
data class StandardMessageBody(
    val content: String,                      // plaintext, or the literal "[ENCRYPTED]"
    val timestamp: Long,                      // ms — note: NOT the seconds used by Message.createdTime (04 §4.7)
    val encrypted: Boolean,
    val securityLevel: String? = null,        // UNCLASSIFIED | CONFIDENTIAL | SECRET
    val classificationNumeric: Int? = null,
    val encryptionMeta: EncryptionMeta? = null,
)

@Serializable
data class EncryptionMeta(
    val algorithm: String,
    val ciphertext: String,                   // base64url
    val nonce: String,                        // base64url, 24 bytes
    val recipientPublicKey: String,           // base64url X25519
    val senderPublicKey: String,              // base64url X25519
)
```

`securityLevel` here is a **3-value** subset, while the system-wide hierarchy has 5 levels
(`CLAUDE.md`: UNCLASSIFIED/INTERNAL/CONFIDENTIAL/RESTRICTED/SECRET). Do not narrow the
`SecurityLevel` domain enum to match this wire type; map at the boundary and reject unmappable
values rather than defaulting them.

### Request-id conventions

Ids are `<prefix>-<base36 ms>-<5 random base36>`, with a per-protocol prefix:

| Prefix | Protocol |
|---|---|
| `ar-` | service-access request |
| `ciq-` | credential-issuance request |
| `dup-` | document-upload request |
| `dbr-` | document-branch request |

`PROTOCOL.md` describes the request id as a "wallet-generated, connection-scoped nonce, not a
secret". `Math.random()` is acceptable under that reading, but **use a CSPRNG in Kotlin**
(`SecureRandom` / `Random.nextBytes`) — it costs nothing and the id is used for `thid` correlation
which the idempotency layer depends on (`04` §4.4).

### Store-after-send

Every sender does this, and it must be ported:

```ts
await agent.sendMessage(finalMessage);
const existing = await agent.pluto.getMessage(finalMessage.id);
if (!existing) await agent.pluto.storeMessage(finalMessage);   // non-fatal on error
```

Outbound messages are not reliably persisted by the SDK, and the wallet needs its own sent messages
for `thid` correlation and chat history. The check-then-store is also the P6/P7 idempotency concern
(`01`) — in Kotlin, route it through the `storeIdempotent` helper.

---

## 5.1 `service-access/1.0`

The core protocol: **prove a Verifiable Presentation → receive a bounded, capability-scoped access
grant**. One implementation serves all three services (CA, company-admin, document-service), with no
wallet-side per-service code.

It replaced three divergent ad-hoc protocols. The security history matters: CA and company-admin
each had a hand-copied `DIDCommCommandService.js` that trusted **Cloud Agent's internal
`PresentationVerified` state alone**, with no independent signature or issuer check; and the wallet's
trust decision was a cached flag derived from a **mutable, locally-editable connection display
name**. Both are fixed. **Do not reintroduce either shortcut.**

### Messages

**`.../request`** (holder → service)

```json
{ "type": "https://identuslabel.cz/protocols/service-access/1.0/request",
  "id": "ar-…",
  "body": { "capability": "security-clearance" } }
```

`body` MAY carry extra capability-specific fields (e.g. `documentDID` for document-access). These are
opaque to the generic layer and passed verbatim to the capability's result builder.

**`.../grant`** (service → holder), `mode: "redirect"`

```json
{ "type": "…/service-access/1.0/grant", "id": "…", "thid": "ar-…",
  "body": { "capability": "…", "label": "Human-readable name", "icon": "🔐",
            "mode": "redirect", "expiresAt": "<ISO 8601>",
            "accessUrl": "https://service.example/api/access?token=…" } }
```

`mode: "payload"` — the grant *is* the data (e.g. document decryption key material):

```json
{ "type": "…/service-access/1.0/grant", "id": "…", "thid": "ar-…",
  "body": { "capability": "document-access", "label": "Document Access", "icon": "📄",
            "mode": "payload", "expiresAt": "<ISO 8601>",
            "result": { "…": "capability-defined; opaque to generic consumers" } } }
```

**`mode` is a closed enum today but designed to grow. An unrecognised `mode` MUST be ignored — not
auto-rendered, not treated as an error.** This is a spec requirement, and it is how a `1.0` consumer
survives a future `mode`. Model it as a sealed hierarchy with an `Unknown` arm that the UI skips.

**`.../error`** (service → holder)

```json
{ "type": "…/service-access/1.0/error", "id": "…", "thid": "ar-…",
  "body": { "error": "UNTRUSTED_ISSUER", "message": "human-readable detail" } }
```

| Code | Meaning |
|---|---|
| `UNKNOWN_CAPABILITY` | No such capability on this service |
| `PROOF_REJECTED` | Presentation reached a terminal non-verified state |
| `PROOF_TIMEOUT` | No verified presentation within the polling timeout |
| `UNTRUSTED_ISSUER` | Issuer signature verified, but issuer not on this capability's trust registry |
| `HOLDER_BINDING_FAILED` | The VP-JWT's own signature failed against its `iss` DID's `authentication` key, **or** a contained credential's subject DID ≠ that `iss` DID. Means a copied/stolen VC-JWT replayed by a different DID |
| `CHALLENGE_MISMATCH` / `STALE_REQUEST` | Anti-replay: bound nonce mismatch, or request too old |

### Kotlin model

```kotlin
@Serializable data class ServiceAccessRequest(
    val type: String = REQUEST_TYPE, val id: String,
    val body: JsonObject,                     // { capability, …capability-specific }
)

data class ServiceAccessGrant(
    val id: String, val thid: String?, val capability: String,
    val label: String, val icon: String,
    val mode: GrantMode, val expiresAt: Instant,
    val accessUrl: String?,                   // mode == Redirect
    val result: JsonElement?,                 // mode == Payload
)

sealed interface GrantMode { object Redirect : GrantMode; object Payload : GrantMode
                             data class Unknown(val raw: String) : GrantMode }

data class ServiceAccessError(val thid: String?, val code: String, val message: String)
```

Port `parseServiceAccessGrant`'s validation exactly (`utils/serviceAccessGrant.ts:38`):

- reject if `type` ≠ the grant type
- reject if `body.capability` is absent
- reject if `mode` is neither `redirect` nor `payload` **at parse time**
- reject if `mode == redirect` and `accessUrl` is absent
- default `expiresAt` to **now + 5 minutes** when absent
- default `label` to `"Secure Service"`, `icon` to `"🔐"`

Note the tension: parse-time rejection of unknown `mode` (current TS behaviour) versus the spec's
"ignore unrecognised mode". Both end in "no UI action", so they agree in effect — but model
`GrantMode.Unknown` so a future mode can be *logged* rather than silently indistinguishable from a
malformed grant.

### Flow

1. User picks a capability (Connections tab or Chat header → **🔓 Request Access**).
2. Wallet sends `.../request`; stores the `requestId` as the pending request
   (`utils/CAPortalContext.tsx`'s `pendingAccessRequest`, surfaced by
   `AccessRequestStatusModal.tsx`).
3. Service sends a standard `present-proof/3.0/request-presentation`; the user approves in
   `UnifiedProofRequestModal`.
4. Service verifies (signature + holder binding + fail-closed trust registry) and replies with
   `.../grant` or `.../error`.
5. The wallet's grant watcher checks **the sender's actual DID** against the trust registry
   (`06-trust-model.md`), then acts on `mode`.

Service-side state machine (per `thid`, from `PROTOCOL.md`):

```
IDLE ──(request, known capability)──────► PENDING_PROOF
IDLE ──(request, unknown capability)────► ERROR(UNKNOWN_CAPABILITY)    [terminal]
PENDING_PROOF ──(verified, issuer trusted)──► GRANTED                  [terminal]
PENDING_PROOF ──(verified, not trusted)─────► ERROR(UNTRUSTED_ISSUER)  [terminal]
PENDING_PROOF ──(rejected/abandoned)────────► ERROR(PROOF_REJECTED)    [terminal]
PENDING_PROOF ──(timeout)───────────────────► ERROR(PROOF_TIMEOUT)     [terminal]
```

**Exactly one grant or error per request; the service never retries or re-sends.** So the wallet must
not either — a lost reply means the user retries with a *new* request id. Do not build client-side
re-request-on-timeout with the same id.

### HTTP polling — a transport, not a fallback

Some connections are managed by an **enterprise agent**, whose messages the wallet's own SDK inbox
cannot observe. For these, the service exposes the same outcome via HTTP GET keyed by request id,
**one-time (deleted on read)** — `ServiceAccessService.consumeGrant(requestId)`.

> This is not a separate protocol or a fallback business path — the same verification, trust-check,
> and grant-construction logic produces both the DIDComm message and the HTTP-pollable result; only
> the delivery transport differs.

Known endpoints:

| Endpoint | Service |
|---|---|
| `GET /api/enterprise-portal/grant-status?requestId=…` | company-admin |
| `GET /access-grant-status?requestId=…&token=…` | document-service |

**The holder's trust check applies identically to an HTTP-delivered grant.** The transport does not
authenticate the grant — but note the HTTP response has **no sender DID** to check. This is a real
asymmetry: for HTTP-polled grants, trust derives from (a) TLS to a pinned origin and (b) the request
id being a secret the wallet generated. Document that reasoning explicitly in the Kotlin code, and
only ever poll an origin the connection metadata already records (`06` §6.3).

### Capabilities

A capability is declared in the service's own `server.js`, in the object passed to
`new ServiceAccessService({...})`:

```javascript
'my-capability': {
  label: 'My Page', icon: '📄', mode: 'redirect', redirectPath: '/ca/my-page',
  trustedIssuerVcType: 'RealPerson',
  proofSpec: { proofs: [{ schemaId: '…', trustIssuers: [] }], goalCode: '…', goal: '…', claims: {} }
}
```

**Verified against the live services** (2026-07-30, all four health endpoints returning 200):

| Capability | Service | `mode` | Label / icon | Redirect path |
|---|---|---|---|---|
| `portal` | CA (`server.js:8282`) | redirect | CA Dashboard 🏛️ | `/ca/dashboard` |
| `login` | CA (`:8311`) | redirect | CA Dashboard 🔑 | `/ca/dashboard` |
| `security-clearance` | CA (`:8330`) | redirect | Security Clearance 🔐 | `/ca/dashboard` |
| `<companyId>-employee-portal` | company-admin, one per company | redirect | Employee Portal Login 🏢 | `/company-admin/employee-portal-dashboard.html` |
| `document-access` | document-service | **payload** | Document Access 📄 | — |

`login` is **deprecated**: same redirect and proof spec as `portal`. Still registered server-side so
already-connected wallets don't break, but dropped from new-connection defaults —
`CA_CAPABILITIES` in `config/serviceTrust.ts` is `['portal', 'security-clearance']`. **Do not add
`login` to new connections.**

### ⚠️ Verified fragility: the employee-portal capability key is derived twice, differently

- **Server** (`lib/companyPortalRegistry.js:70`): `` const capabilityKey = `${company.id}-employee-portal` `` —
  an explicit identifier from `lib/companies.js`.
- **Wallet** (`utils/connectionAccessTargets.ts:39`): derives a slug from the company's **display
  name** by stripping a legal suffix (`corporation|corp|incorporated|inc|industries|company|co|llc|ltd|gmbh|s.a.`)
  then slugifying.

The two agree for all three current tenants — verified by running the wallet's derivation over the
registry's display names:

| `company.id` | `displayName` | wallet-derived key | match |
|---|---|---|---|
| `techcorp` | TechCorp Corporation | `techcorp-employee-portal` | ✅ |
| `acme` | ACME Corporation | `acme-employee-portal` | ✅ |
| `evilcorp` | EvilCorp Industries | `evilcorp-employee-portal` | ✅ |

But this holds only by coincidence of naming. A tenant whose `id` differs from
`slug(displayName − legalSuffix)` — say `id: "nordic"` with `displayName: "Nordic Systems AS"`
(`AS` is not in the suffix list, and `id` isn't `nordic-systems-as`) — produces a key the server
never registered, and its employee-portal login **silently does nothing**. That exact failure has
already happened once: `evilcorp` was defined in `companies.js` but not wired into the registry, and
its login silently did nothing until the config-driven registry fixed it.

**Port instruction:** do **not** re-derive the key in the Kotlin wallet. Read it from the connection's
recorded `ConnectionMetadata.capabilities` (`03` §3.6), which is written from real evidence at
establishment time. Keep name-based derivation only as a **backfill** for connections that predate
the field, exactly as `connectionAccessTargets.ts` intends it — and log loudly when the backfill path
is used.

Adding a capability requires **two** places: the service's `server.js`, and a wallet-side trust entry
(`06-trust-model.md`). A capability the wallet doesn't trust is unusable even if the service grants
it — that is the fail-closed design working, and it is the most likely cause of a "nothing happens"
bug during Phase 4.

### Non-goals (from `PROTOCOL.md`)

- Does **not** cover mutation flows (document upload, custody transfer) — only bounded, read-style
  access grants following a proof. That is why §5.3 exists separately.
- Does **not** replace DIDComm Discover Features or present-proof `ack` — neither is implemented by
  the vendored SDK. **Check whether `sdk-kmp` implements them**; if so, that is a consolidation
  opportunity, explicitly out of scope for `1.0`.

---

## 5.2 `credential-issuance/1.0`

Interactive credential issuance where the **service decides which fields it needs** and the holder
fills them in. Reconstructed from `actions/index.ts:2195-2350` and
`components/CredentialIssuanceRequestor.tsx`; the shared library is
`packages/credential-issuance-didcomm`.

| Message | Direction | Shape |
|---|---|---|
| `.../request` | holder → service | `{ type, id: "ciq-…", body: { capability } }` |
| `.../fields-required` | service → holder | `{ type, thid, body: { … field descriptors … } }` |
| `.../data-submit` | holder → service | `{ type, thid: requestId, body: { capability, values: { field: value } } }` |
| `.../error` | service → holder | `{ type, thid, body: { error, message } }` |

Note `data-submit` uses `thid` where the request used `id` — standard DIDComm threading, same as
`service-access`.

After `data-submit`, issuance proceeds over the **standard** `issue-credential/3.0` protocol; this
protocol only negotiates the input. Read `packages/credential-issuance-didcomm/lib/CredentialIssuanceService.js`
for the exact `fields-required` descriptor shape (field name, label, type, required, validation)
before modelling it — it is not fully recoverable from the wallet side.

**Constraint from memory of past breakage:** VC schemas in this deployment are frequently
`additionalProperties: false`. Adding a claims field that the schema does not declare makes issuance
fail with a silent **422**. Verify against the schema registry before extending any credential
subject. This applies to the Kotlin port the moment it starts requesting credentials.

---

## 5.3 `document-upload/1.0`

Document **mutation** — deliberately outside `service-access/1.0`'s scope.

| Message | Direction | Shape |
|---|---|---|
| `.../request` | holder → service | `{ type, id: "dup-…", body: { title, clearanceLevel, releasableTo, filename, department }, attachments: [{ id: "file", mediaType, data: { base64 } }] }` |
| `.../branch` | holder → service | as above plus `parentDocumentDID`, id prefix `dbr-`; `clearanceLevel`/`releasableTo` optional (inherited from parent when omitted) |

Two things to note:

1. **The file is base64 in the envelope**, not a DIDComm attachment on the outer message. The whole
   document transits inside `body.content`. For large files this is a real constraint — check the
   mediator's message size limit before Phase 5 and specify a cap with a clear user-facing error.
   The TS code has no such cap.
2. After the upload request, the service initiates a VP proof request; the flow then converges on the
   `service-access/1.0` verification path. So `document-upload` is a **mutation preamble** to a
   standard proof, not an independent trust decision.

---

## 5.4 `vc-proof-sharing/1.0`

One message type: `.../proof`. Used to share a verified credential's identity claims over an
established connection, and it is the **highest-priority source** for a connection's display name
(`03` §3.6 item 4). Consumed by `connectionNameResolver.ts` and the live identity verification flow.

Model it, but treat its contents as **display-only unless it passes the same verification as any
other presentation** (`06-trust-model.md`). A name from an unverified `vc-proof-sharing` message is a
label, not an identity.

---

## 5.5 Shared implementation requirements

1. **One `EnvelopeCodec`** handling both wrapping depths on read, single-wrapping on write (§5.0).
2. **Tolerant parsing, loud call sites** — parsers return null on any mismatch; the caller logs what
   it saw (`04` §4.6).
3. **`thid` correlation through the idempotency layer** — a reply is matched to its request via
   `thid`, and `protocol_effect` prevents double-application (`04` §4.4). Kotlin's
   `pluto.getMessageByThidAndPiuri` has no TS equivalent and is the right tool here (`01` §B.4).
4. **Expiry is enforced client-side.** `expiresAt` past ⇒ reject, regardless of trust. Use a
   monotonic-safe comparison and allow a small clock-skew tolerance; do **not** trust the service's
   clock blindly, and do not let a missing `expiresAt` mean "never expires" — TS defaults it to
   5 minutes.
5. **Never send a protocol reply to a DID other than the one that sent the request.** Reply to
   `message.from`, not to a stored or resolved address.
6. **Tests:** port the vectors in `packages/service-access-didcomm/test/` (`serviceAccessService`,
   `verifyPresentation`, `claimExtractor`, `trustRegistry`, `jwtCrypto`). They encode the security
   properties and are the cheapest way to prove the Kotlin implementation matches the services.
