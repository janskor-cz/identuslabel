# 04 — Message Pipeline

Covers Phase 1. Prerequisites: `01-sdk-gap-analysis.md` §B.5 (listener semantics) and §B.4 (missing
deletes), `03-state-and-storage.md` §3.4.

This is the highest-risk document in the set. The TypeScript pipeline is built on an assumption that
**does not hold in Kotlin**, and the wallet's known bug history is almost entirely a consequence of
that assumption being violated even in TypeScript.

## 4.1 The pipeline today

Entry point: `handleMessages` at `idl-wallet/src/actions/index.ts:369`, registered in `startAgent`:

```ts
agent.addListener(ListenerKey.MESSAGE,
    handleMessages.bind({}, { dispatch, agent, getState }));
```

Stages, in order:

```
newMessages
  └─ 1. direction filter      keep MessageDirection.RECEIVED
  └─ 2. self-DID filter       drop msg.from == agent.selfDID
  └─ 3. per-piuri dispatch    issue-credential | basicmessage | request-presentation | connection-request
        └─ 4. per-branch idempotency (ad hoc, see §4.4)
        └─ 5. side effects: Pluto write, Redux dispatch, metadata persist, auto-response
```

Stage 2 exists because **stage 1 is not reliable**. The comment is explicit:

```ts
// ✅ FIX #2: Filter out messages FROM ourselves (self-DID check)
// SDK sometimes stores outgoing messages with wrong direction, so we need this second layer
```

Port both layers. `selfDID` comes from `startAgent`'s `agent.createNewPeerDID([], false)` and is the
reason `app.agent.selfDID` must survive into the Kotlin state (`03` §3.5).

## 4.2 Stage-by-stage port

| Stage | TypeScript | Kotlin |
|---|---|---|
| Source | `addListener(MESSAGE, cb)` — new messages | `WalletAgent.newMessages()` — deltas synthesised at the bridge (§4.3) |
| 1. Direction | `filter(m => m.direction === RECEIVED)` | Prefer `pluto.getAllMessagesReceived()` at the source — the filter becomes structural |
| 2. Self-DID | `filter(m => m.from?.toString() !== selfDID)` | **Keep.** Compare on normalised DID strings |
| 3. Dispatch | `if`/`filter` chains over piuri, with `Set`s for aliases | `when (normalisePiuri(m.piuri))` over a sealed hierarchy — §4.5 |
| 4. Idempotency | ad hoc per branch | **One mandatory layer before dispatch** — §4.4 |
| 5. Effects | `pluto.*` + `dispatch(...)` | suspend calls; UI updates derive from Flows (`03` §3.4) |

Normalise piuri **before** the `when`, not inside each branch (`01` §P2).

## 4.3 Synthesising a new-message delta

Kotlin gives the whole table, re-emitted (`01` §B.5). The bridge must convert it:

```kotlin
override fun newMessages(): Flow<List<WalletMessage>> =
    pluto.getAllMessagesReceived()
        .map { batch -> batch.filter { seen.markIfNew(it.id) } }   // persistent, not in-memory
        .filter { it.isNotEmpty() }
```

Three requirements on `seen`:

- **Persistent.** An in-memory `Set` resets on restart, and the whole table is re-emitted on the next
  launch — every message would reprocess. This is not a hypothetical: the TS wallet's own
  `getProcessedIssueCredentialIds()` is backed by the KV store precisely because an in-memory set was
  insufficient.
- **Keyed on message id**, which the mediator/SDK is known to reuse for redelivered messages. Message
  id alone is therefore necessary but **not sufficient** — see §4.4.
- **Bounded.** The TS implementation keeps the last 500 ids (`Array.from(ids).slice(-500)`). In
  SQLite there is no reason to cap that low; keep all ids with a periodic prune of entries older than
  the longest protocol timeout. **A cap that is too small silently reintroduces reprocessing** — if
  501 messages arrive before a redelivery, the guard has already forgotten.

## 4.4 The idempotency layer

**Do not port the ad-hoc per-branch guards. Replace them with one layer.** The existing guards are a
catalogue of the same bug found five times:

| Mechanism | Location | Guards |
|---|---|---|
| `getProcessedIssueCredentialIds()` / `markIssueCredentialProcessed()` | `actions/index.ts:343-360`, KV-backed, last 500 | Duplicate credential rows from redelivered `issue-credential` |
| `seenGrantIds` / `seenErrorIds` (`useRef<Set>`) | `pages/_app.tsx:113-114` | Re-opening the portal / re-showing an error |
| `dismissedOfferIds` (module-level `Set`) | `actions/enterpriseAgentActions.ts:24` | Credential-offer modal loop |
| `MessageRejectionManager` (IndexedDB) | `utils/rejectionManager.ts` | Re-offering a message the user rejected |
| `cleanupDuplicateCredentials(agent)` | run fire-and-forget from `startAgent` | **Repairing damage after the fact** |

That last one is the tell: the wallet ships a startup repair job because prevention leaked. And note
the comment at `actions/index.ts:886` — wallets that ran *before* the processed-ids fix landed can
still hold duplicates, so the repair job cannot be removed. **A fresh Kotlin wallet has no legacy
data and should not need it** — but only if the layer below is correct from the start.

### Required design

Two tables in `wallet.db` (`03` §3.8):

```sql
-- every message the pipeline has admitted
CREATE TABLE processed_message (
    message_id TEXT PRIMARY KEY,
    piuri      TEXT NOT NULL,
    thid       TEXT,
    admitted_at INTEGER NOT NULL
);

-- protocol-level effect guard: "this outcome has already been applied"
CREATE TABLE protocol_effect (
    kind       TEXT NOT NULL,      -- CREDENTIAL_STORED | GRANT_CONSUMED | OFFER_ANSWERED | ...
    key        TEXT NOT NULL,      -- thid, or credential id, or capability+thid
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
);
```

Two levels, because **message-id dedup alone is insufficient**. The same credential can arrive under
a *different* message id (a genuinely new message carrying an already-issued credential), which
`processed_message` will happily admit. The second table guards the **effect**, keyed by protocol
identity — `thid` for a protocol thread, credential id for a stored credential.

Rules:

1. Admit a message only if `INSERT INTO processed_message` succeeds (atomic test-and-set).
2. Before applying an effect, `INSERT INTO protocol_effect` and skip if it conflicts.
3. Both inserts and the side effect happen **in one transaction** where the effect is local. Where
   the effect is remote (sending a reply), record intent first, then send — at-least-once delivery is
   correct here; at-most-once is not, since protocol peers tolerate duplicate requests but a dropped
   reply strands the thread.

### Consume-once via deletion

`GlobalGrantWatcher` in `_app.tsx` uses a second strategy for grants: after processing, it **deletes
the message** from Pluto and removes it from Redux. This is deliberate — a grant is single-use, and
deletion prevents both reprocessing and stale grants accumulating.

That strategy **depends on `deleteMessage`, which Kotlin does not have** (`01` §B.4). Either
implement the delete query (`03` §3.4) or fall back to `protocol_effect` marking. **Prefer the
delete** — a consumed grant contains a live `accessUrl` token and should not linger in storage.

## 4.5 Complete piuri table

The deployment emits **two namespaces for the same protocols**. Every match must accept both; the
TS code does this with `Set`s (`PRESENTATION_REQUEST_PIURIS`, `CONNECTION_REQUEST_PIURIS`, and an
inline `||` for issue-credential).

### Standard `didcomm.org`

| piuri | Handling |
|---|---|
| `basicmessage/2.0/message` | Chat **and** the carrier for all three custom protocols (§4.6) |
| `out-of-band/2.0/invitation` | OOB invitation |
| `connections/1.0/invitation` | legacy invitation |
| `didexchange/1.0/request` | inbound connection request → Connections tab |
| `didexchange/1.0/response` | connection response |
| `didexchange/1.0/complete` | connection complete |
| `issue-credential/3.0/offer-credential` | → `CredentialOfferModal` |
| `issue-credential/3.0/request-credential` | outbound |
| `issue-credential/3.0/issue-credential` | store credential + discover connection metadata |
| `present-proof/3.0/request-presentation` | → `UnifiedProofRequestModal` |

### Atala-namespaced `didcomm.atalaprism.io` — aliases, must be accepted

| piuri | Aliases |
|---|---|
| `connections/1.0/invitation` | standard equivalent |
| `issue-credential/3.0/issue-credential` | standard equivalent |
| `present-proof/3.0/request-presentation` | standard equivalent |
| `present-proof/3.0/presentation` | **no `didcomm.org` form is used** — this is the only namespace the wallet polls for presentation responses (`actions/index.ts:1145, 1447, 1786`) |

Also referenced: `SDK.ProtocolType.DidcommconnectionRequest`,
`DidcommconnectionResponse`, `ProblemReporting`.

⚠️ **The presentation-response asymmetry is a trap.** Three separate polling loops match *only*
`didcomm.atalaprism.io/present-proof/3.0/presentation`. If the Cloud Agent ever emits the
`didcomm.org` form, all three break silently — they time out rather than error. In Kotlin, match
both and log which was seen.

## 4.6 Custom protocols ride BasicMessage

All three custom protocols are JSON envelopes inside a `basicmessage/2.0/message` body's `content`
field. Full specs in `05-protocols.md`; the pipeline needs only to route them.

| Envelope `type` | Protocol |
|---|---|
| `https://identuslabel.cz/protocols/service-access/1.0/{request,grant,error}` | `05` §5.1 |
| `https://identuslabel.cz/protocols/credential-issuance/1.0/{request,fields-required,data-submit,error}` | `05` §5.2 |
| `https://identuslabel.cz/protocols/document-upload/1.0/{request,branch}` | `05` §5.3 |
| `https://identuslabel.cz/protocols/vc-proof-sharing/1.0/proof` | `05` §5.4 |

Routing, in order:

```kotlin
BasicMessage -> {
    val envelope = parseEnvelope(message)   // null-returning, never throwing
    when (envelope?.type) {
        in SERVICE_ACCESS_TYPES  -> serviceAccess.handle(envelope, message)
        in CRED_ISSUANCE_TYPES   -> credentialIssuance.handle(envelope, message)
        in DOC_UPLOAD_TYPES      -> documentUpload.handle(envelope, message)
        VC_PROOF_SHARING         -> vcProofSharing.handle(envelope, message)
        null                     -> chat.handle(message)      // ordinary chat
        else                     -> log.debug("unknown envelope type")   // forward-compatible
    }
}
```

Two constraints from the existing code:

1. **Parsers must fail silently by returning null, and the *call site* must log.**
   `parseServiceAccessGrant` returns null on any shape mismatch. `_app.tsx` has a diagnostic log
   above it with a comment explaining why: silent failure "made a real parsing bug
   indistinguishable from 'not a grant message'". Keep the tolerant parser **and** the diagnostic.
2. **An unrecognised envelope type must be ignored, not error.** `PROTOCOL.md` requires this for
   `mode` and the same reasoning applies to types — it is how `1.0` grows without breaking
   consumers.

Note `message.body` may be a JSON **string or an object**; the TS parsers handle both
(`typeof message.body === 'string' ? JSON.parse(...) : message.body`). Kotlin must too.

## 4.7 Timestamp normalisation

`Message.createdTime` is in **seconds**, while wall-clock comparisons use milliseconds. The wallet
normalises:

```ts
msgTime = msg.createdTime < 10000000000 ? msg.createdTime * 1000 : msg.createdTime;
```

Also: `createdTime` can be **absent**, and the polling loops deliberately **accept** a message with
no timestamp during an active handshake rather than discard it —

```ts
if (msgTime === 0) { /* accept anyway since we're actively waiting for a response */ return true; }
```

Port both behaviours into one `normalisedCreatedTime(): Instant?` plus an explicit
"accept-if-unknown-while-awaiting" policy. Do **not** silently coerce a missing timestamp to epoch 0
— that is what forced the special case.

## 4.8 Auto-responses and the empty-claims trap

The pipeline auto-responds to some presentation requests without user approval — the "VC handshake",
modelled on TLS certificate exchange, used to obtain a peer's Security Clearance VC before
encrypting chat (`07` §7.1).

**Carry this comment forward verbatim in the Kotlin source** (`actions/index.ts` ~1100):

> Requesting a claim with an empty filter object (e.g. `{ clearanceLevel: {} }`) triggers a bug in
> the SDK's `Pollux.validateInputDescriptor`: an empty filter `{}` is truthy but has no
> `.pattern`/`.enum`/`.const`, so that code path can never mark the field valid even when it
> genuinely exists in the credential — `agent.handlePresentation()` would then always reject the
> presentation. Keep this claims filter empty.

So `presentationClaims = { claims: {} }` — **entirely empty**, not "empty filters". Real validation
happens afterwards in `validateSecurityClearanceVC` (`06-trust-model.md`).

**Verify whether Kotlin's Pollux has the same defect** (`01` §B.9 item 3) before designing any claim
filter. If it is fixed there, using real filters is an improvement — but it must be *verified*, since
the failure mode is a blanket rejection that looks like a peer problem.

Auto-response is a **security-relevant** decision: the wallet answers a proof request with no human
in the loop. The scope must stay exactly as narrow as today (the clearance handshake on an
established connection). Everything else routes to `UnifiedProofRequestModal` for explicit approval.

## 4.9 Polling loops → Flows

Four hand-rolled `setInterval` pollers exist: `initiateVCHandshake`, `liveIdentityVerification`,
document-access status, and enterprise grant polling. All follow the same shape — poll
`getAllMessages()`, match on piuri + sender + timestamp, resolve or time out.

Replace each with:

```kotlin
withTimeout(timeout) {
    pluto.getAllMessagesReceived()
        .mapNotNull { batch -> batch.firstOrNull(matcher) }
        .first()
}
```

This removes the leaked-interval class of bugs (the TS code must call `clearInterval` on every
early-return path, and some paths are easy to miss) and replaces polling with the SDK's own change
notifications. Where Kotlin offers a targeted query — `getMessageByThidAndPiuri`,
`getAllMessagesReceivedFrom` — use it instead of scanning (`01` §B.4).

Timeouts in use: the clearance handshake is 5 minutes; live identity verification is deliberately
"generous (minutes, not seconds)" because a **human** must approve on the responding side. Do not
tighten these.

## 4.10 Phase 1 exit criteria

1. Agent registers with `https://identuslabel.cz/mediator` and `flowState` reports started **with a
   mediator loaded** (`01` §P12).
2. Restart the wallet 3× against a populated Pluto: **zero** messages reprocess, zero duplicate
   credentials, zero re-opened modals.
3. Replay test: feed the same message batch to the pipeline 5×, including with fresh message ids
   carrying an already-applied effect. Exactly one effect is applied (proves both idempotency levels,
   §4.4).
4. A message with an undecodable attachment does not prevent the remaining batch from processing
   (`01` §P8) and does not prevent startup.
5. An undecryptable message does not abort the pickup batch, and mediator keylist registration still
   runs (`01` §P9).
6. Both piuri namespaces are accepted for all four aliased protocols (§4.5), asserted by unit test.
7. An unknown envelope type inside a BasicMessage is logged and ignored, not surfaced as an error.
