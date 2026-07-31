# 01 — SDK Gap Analysis: TypeScript fork → Kotlin `sdk-kmp`

**Read this document before writing any Kotlin.** It is the reason this port is not a
straightforward UI rewrite.

Two independent sets of gaps are documented here:

- **Part A — the fork patches.** `idl-wallet` does not run on a released SDK. It runs on a
  privately patched fork. Every patch exists because something in the live deployment broke without
  it. The Kotlin SDK has none of them, and several of the same defects are present in Kotlin.
- **Part B — the API mapping.** Where the Kotlin SDK's surface differs from the TypeScript one,
  including four outright missing capabilities.

---

## Part A — The fork patches

### A.0 Provenance and fragility

`idl-wallet/package.json` declares:

```json
"@hyperledger/identus-edge-agent-sdk": "/root/clean-identus-wallet/sdk-v6-test/sdk-ts"
```

**That directory no longer exists.** The only surviving copy of the fork is
`idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk`, which is itself a git repository:

| | |
|---|---|
| Upstream | `github.com/hyperledger-identus/sdk-ts` |
| Base tag | `v6.6.0` |
| Local commits | 4 (`git describe` → `v6.6.0-4-g17799031`) |
| Scope | 20 files under `src/`, ~400 net added lines |

```
17799031  2026-03-21  feat: VC-based document access, QR scanner fix, security level standardization
910e670e  2026-01-02  Fix Security Clearance credential display name in wallet
cd10bb7b  2025-12-13  Add My Documents page and classified document viewer
f15d7ba6  2025-12-11  Custom Identus SDK modifications for SSI infrastructure
```

A single `yarn install` / `npm ci` in `idl-wallet` destroys all of it. The diff is therefore
preserved in this spec set:

- `artifacts/sdk-fork.patch` — full diff of `src/` (850 lines)
- `artifacts/sdk-fork.diffstat.txt` — the 20-file diffstat
- `artifacts/sdk-fork.commits.txt` — commit list

Regenerate with:

```bash
cd idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk
git diff v6.6.0..HEAD -- src/
```

> ⚠️ **Also note:** that repo's `.git/config` contains a GitHub PAT embedded in a `fork` remote URL.
> The token should be revoked; do not copy the remote into any new repository.

### A.1 Patch inventory

Each row states what the patch changed, why, and what the Kotlin port must do. **"Remedy" is the
actionable column.** Nothing here is optional cleanup — each patch corresponds to an observed
failure against the live Cloud Agent / mediator.

---

#### P1 — Credential offers arrive without a `credential_preview`

**Files:** `src/edge-agent/protocols/issueCredential/OfferCredential.ts`

Upstream requires `body.credential_preview`, validates it via `validateCredentialPreview`, and
throws `InvalidOfferCredentialMessageError` / `InvalidOfferCredentialBodyError` otherwise. The
patch makes the field optional and **deletes the validation entirely**, with the rationale that the
real credential data lives in the attachments:

```ts
// Made optional to support Cloud Agent offers that may not include preview in body
credential_preview?: CredentialPreview;
```

**Why:** the Identus Cloud Agent emits `offer-credential` messages whose body has no
`credential_preview` (or a non-standard one). Unpatched, every such offer throws before the user
ever sees it.

**Kotlin status: 🔴 SAME DEFECT, WORSE.**
`edgeagent/protocols/issueCredential/OfferCredential.kt` declares:

```kotlin
val credentialPreview: CredentialPreview   // non-nullable
```

and `fromMessage` does `Json.decodeFromString<Body>(fromMessage.body)`. kotlinx.serialization
throws `MissingFieldException` on a missing non-nullable field — a hard failure, not a soft one.

**Remedy:** do **not** call `OfferCredential.fromMessage` directly from the pipeline. Parse offers
in `sdkbridge` with a lenient local model (`credentialPreview: CredentialPreview? = null`,
`Json { ignoreUnknownKeys = true; isLenient = true }`) and construct the SDK object only when the
SDK needs it. Track an upstream issue to relax the field.

---

#### P2 — `piuri` namespace aliases (`didcomm.atalaprism.io` vs `didcomm.org`)

**Files:** implicit across the wallet; surfaces in `OfferCredential.ts` / `Message.ts` handling

The live deployment emits **both** namespaces for the same protocols (see
`04-message-pipeline.md`'s piuri table). `idl-wallet` matches on sets containing both.

**Kotlin status: 🔴 GAP.** `OfferCredential.fromMessage` hard-requires
`fromMessage.piuri == ProtocolType.DidcommOfferCredential.value` and throws
`EdgeAgentError.InvalidMessageType` otherwise. An `atalaprism.io`-namespaced message is rejected.

**Remedy:** normalise piuri to the canonical `didcomm.org` form in `sdkbridge` **before** handing a
message to any SDK `fromMessage`, keeping the original on the domain model for display/debug.

---

#### P3 — Reuse an existing PRISM DID as credential subject

**Files:** `src/edge-agent/didcomm/HandleOfferCredential.ts`, `src/edge-agent/didcomm/Agent.ts`

Upstream mints a **fresh** PRISM DID (master + auth key, new key-path index) for every credential
offer. The patch adds `subjectDID?` / `alias?` args: when a DID is supplied, its keys are loaded
from Pluto instead — selecting **SECP256K1 for JWT** ("Cloud Agent expects ES256K") and
**ED25519 for SD-JWT**, falling back to the last stored key.

**Why:** the deployment needs multiple credentials bound to one holder DID (holder binding — see
`06-trust-model.md`); a per-offer DID makes `HOLDER_BINDING_FAILED` unavoidable.

**Kotlin status: 🟢 ALREADY SUPPORTED.**
`prepareRequestCredentialWithIssuer(did: DID, offer: OfferCredential)` takes the subject DID as a
parameter, and internally does the same key selection (`keys.find { it.getCurve().lowercase() == "ed25519" }`
for SD-JWT, `getPrismAuthenticationPrivateKey(did)` for JWT).

**Remedy:** none — pass the holder DID explicitly. **This is the largest TS patch and it is not
needed in Kotlin.** Preserve the key-curve-per-credential-type rule as an assertion in tests.

---

#### P4 — Presentations must be signed with Ed25519 (EdDSA)

**Files:** `src/edge-agent/didcomm/CreatePresentation.ts`

Two call sites changed from "first available key" to:

```ts
// Cloud Agent requires EdDSA (Ed25519) signatures for presentation verification
const privateKey = privateKeys.find((key) => key.curve === Domain.Curve.ED25519) || privateKeys.at(0);
```

A third site is annotated to confirm the **JWT credential** path deliberately stays
SECP256K1/ES256K.

**Why:** the deployment's Cloud Agent rejects presentations signed with anything other than EdDSA;
key ordering in Pluto is not stable, so "first key" failed intermittently — a heisenbug.

**Kotlin status: 🟡 PARTIAL / MUST VERIFY.** Kotlin's `initiatePresentationRequest` hardcodes
`JWTPresentationOptions(jwt = arrayOf("ES256K"), …)` on the **request** side, and
`preparePresentationForRequestProof` performs its own key selection. The curve actually used per
path must be verified empirically against the live agent before Phase 3 exits.

**Remedy:** add an explicit curve-selection policy in `sdkbridge` mirroring the patch
(presentation → Ed25519; JWT credential request → SECP256K1) and assert it in the Phase 3 exit
test. Do not assume the Kotlin defaults match.

---

#### P5 — `createPrismDID` gains X25519 key-agreement keys

**Files:** `src/castor/Castor.ts`

`createPrismDID` accepts a third `keyAgreementKeys: (PublicKey | KeyPair)[]` parameter and appends
each as a `Usage.KEY_AGREEMENT_KEY` public key to the DID document proto.

**Why:** the NaCl-box message encryption and ephemeral document access (see `07-crypto.md`) need
X25519 material discoverable on the PRISM DID document.

**Kotlin status: 🟡 LIKELY SUPPORTED, VERIFY.** `createNewPrismDID(keys, services, keyPathIndex)`
takes keys tagged with a `KeyPurpose`, and `EdgeAgent` builds `DIDUrl`/verification methods per
purpose — so `KeyPurpose.KEY_AGREEMENT` should be expressible.

**Remedy:** verify a PRISM DID created with an X25519 key-agreement key resolves with that key in
its DID document, via `castor.resolveDID`. If not, this becomes an upstream contribution.

---

#### P6 — Idempotent writes: `insert` → `upsert`

**Files:** `src/pluto/rxdb/Store.ts` (the "1-line change")

```diff
-    await table.insert(data);
+    await table.upsert(data);
```

**Why:** this is the *root* fix that P7's error-swallowing works around at a higher level. Every
Pluto write became idempotent.

**Kotlin status: 🟡 DIFFERENT SUBSTRATE.** Kotlin Pluto is SQLDelight/SQLite, not RxDB. Idempotency
depends on the generated `.sq` statements (`INSERT OR REPLACE` vs `INSERT`).

**Remedy:** audit the SDK's `.sq` files for plain `INSERT` on tables the wallet re-writes (DID,
DIDPair, Message, Credential). Where they are not upserts, route those writes through
`sdkbridge` helpers that check-then-write inside a transaction. Specify alongside the delete
queries in `03-state-and-storage.md`.

---

#### P7 — Tolerate duplicate-key conflicts as success

**Files:** `src/pluto/repositories/DIDRepository.ts`, `src/edge-agent/connectionsManager/ConnectionsManager.ts`,
`src/pluto/repositories/builders/BaseRepository.ts`, `src/pluto/Pluto.ts`

- `DIDRepository.save` wraps insert in try/catch and treats RxDB `CONFLICT` / status 409 /
  `StoreInsertError` as success **after confirming the DID really exists** — re-throwing if the
  conflict was spurious.
- `ConnectionsManager` catches conflicts from `storeDIDPair` and **still emits the `CONNECTION`
  event** so the UI updates. (Original comment: without this, a conflict left the UI with no
  connection despite a successful pairing.)
- `Pluto.storeDIDPair` checks `DIDLinks` for an existing `(hostId, targetId, role=pair)` and returns
  early.
- `BaseRepository.insert` logs the original error before wrapping it in `StoreInsertError`
  (upstream discarded it, making all insert failures indistinguishable).

**Why:** re-accepting an invitation, or a redelivered connection message, re-saves the same DID.

**Kotlin status: 🔴 GAP (different failure mode).** SQLite raises
`SQLiteException: UNIQUE constraint failed`, not a 409.

**Remedy:** one `sdkbridge` `storeIdempotent { … }` wrapper that catches unique-constraint
violations, re-reads to confirm the row exists, and re-throws otherwise. Never a blanket catch.
Preserve the "**emit the connection event even on conflict**" behaviour — it is a UI-correctness
requirement, not defensive noise.

---

#### P8 — One bad attachment must not brick the message store

**Files:** `src/domain/models/Message.ts`

`Message.fromJson` changed from *throw on unsupported attachment* to **filter**: attachments with
missing `data`, or that are neither base64 nor JSON, are dropped with a warning; an empty/absent
attachments array is normalised to `[]` ("standard for connection responses").

**Why:** one undecodable attachment threw during `getAllMessages()`, i.e. at wallet startup, making
the whole wallet unloadable. `connectDatabase` in `actions/index.ts` still wraps
`getAllMessages()` in its own try/catch as a second line of defence, explicitly commented
"possible corruption".

**Kotlin status: 🔴 GAP.** kotlinx.serialization strict decoding into `AttachmentDescriptor`/
`AttachmentData` will throw on unknown attachment shapes.

**Remedy:** lenient attachment decoding in `sdkbridge` (`ignoreUnknownKeys`, nullable `data`,
drop-and-log unsupported), plus a **corruption-tolerant bulk read** for startup. Carry over the
double defence: tolerant parse *and* a caught bulk read.

---

#### P9 — Undecryptable messages must not abort a pickup batch

**Files:** `src/mercury/didcomm/Wrapper.ts`, `src/edge-agent/protocols/pickup/PickupRunner.ts`,
`src/domain/models/errors/Mercury.ts`

- New `MercuryError.DIDCommDecryptionError` — explicitly documented as **non-fatal**.
- `DIDCommWrapper.unpack` catches WASM-boundary errors matching `No recipient secrets found` /
  `SecretNotFound` / `DIDCommSecretNotFound` and rethrows them as that typed error.
- `PickupRunner` switches to `Promise.allSettled` so surviving messages in the batch still process.

The wallet mirrors this at the top level: `startAgent` in `actions/index.ts` catches the same three
error strings around `agent.start()` and **continues** — including re-running mediator keylist
registration, which an earlier version of the code skipped on the error path, silently causing the
mediator to drop all inbound messages.

**Why:** during connection establishment, encrypted messages routinely arrive before the recipient
peer DID's keys are persisted. This is normal and self-healing on the next poll.

**Kotlin status: 🔴 GAP.** No equivalent typed error or settled-batch handling.

**Remedy:** specify a `DecryptionDeferred` outcome in `sdkbridge`; process pickup batches
per-message with failures collected, not thrown; and ensure agent-start failure of this class does
**not** skip mediator keylist registration. Note that Kotlin uses `didcomm-jvm`, not WASM, so the
error *types* differ — match on the library's actual exception, not on English substrings.

---

#### P10 — Pickup filtering by recipient DID

**Files:** `src/edge-agent/mediator/BasicMediatorHandler.ts`, `src/edge-agent/types/index.ts`

`pickupUnreadMessages(limit, recipientDID?)` adds an optional `recipientKey` to the pickup request
body, so polling can be scoped to one DID instead of every registered peer DID.

**Instructive history — do not repeat it.** `ConnectionsManager` shows FIX #10 adding a filter that
selected the connection **named `"Certification Authority"`**, immediately followed by FIX #11
reverting it in place because *"Previous FIX #10 broke TechCorp proof requests by filtering to CA
only."* The dead FIX #10 helper is still in the file.

**Kotlin status:** ⚪ N/A — an optional optimisation, not required for parity.

**Remedy:** **do not port.** Poll all registered DIDs. Record the FIX #10/#11 history so a future
optimisation doesn't rediscover it. Never key behaviour off a connection's mutable display name
(the same anti-pattern `06-trust-model.md` documents for trust decisions).

---

#### P11 — Connection request carries a `label`

**Files:** `src/edge-agent/protocols/connection/HandshakeRequest.ts`, `src/edge-agent/protocols/types.ts`

`HandshakeRequestBody` gains `label?: string`; `HandshakeRequest` takes a `label` argument and
defaults it to `"Unspecified"`.

**Why:** the CA and company-admin portals display the connecting wallet's label in their approval
UIs; without it, every inbound connection is anonymous.

**Kotlin status: 🟡 VERIFY.** Check whether Kotlin's `HandshakeRequest`/`OutOfBandInvitation` body
carries a label.

**Remedy:** ensure the label reaches the wire. If the SDK type lacks it, build the request body in
`sdkbridge`. Wallet-side value comes from the logged-in profile.

---

#### P12 — Mediator reload + verification after registration

**Files:** `src/edge-agent/didcomm/Agent.ts` (`start`)

After mediation registration, the patch calls
`connectionManager.mediationHandler.bootRegisteredMediator()` and then **asserts**
`mediationHandler.mediator` is non-null, throwing `MediationRequestFailedError` if not.

**Why:** registration could succeed while the in-memory handler still held no mediator, producing a
wallet that looked started but could neither send nor receive.

**Kotlin status: 🟡 VERIFY.** Kotlin's `EdgeAgent.start()` handles mediation via
`BasicMediatorHandler`; whether it re-reads and verifies is unconfirmed.

**Remedy:** after `start()`, assert a mediator is loaded before reporting the agent as started —
this is exactly the Phase 1 exit test in `10-build-order.md`.

---

#### P13 — `deleteCredential`

**Files:** `src/domain/buildingBlocks/Pluto.ts`, `src/pluto/Pluto.ts`

Adds `deleteCredential(credential)` to the `Pluto` interface and implements it (find by id, delete
by uuid). Upstream had only `revokeCredential`.

**Kotlin status: 🔴 GAP — see Part B.4.** Kotlin has no delete methods at all.

**Remedy:** covered by the delete-query work in `03-state-and-storage.md`.

---

### A.2 Patch coverage check

All 20 files in `artifacts/sdk-fork.diffstat.txt` map to a patch above:

| File | Patch |
|---|---|
| `edge-agent/protocols/issueCredential/OfferCredential.ts` | P1 |
| `edge-agent/didcomm/HandleOfferCredential.ts` | P3 |
| `edge-agent/didcomm/Agent.ts` | P3, P12 |
| `edge-agent/didcomm/CreatePresentation.ts` | P4 |
| `castor/Castor.ts` | P5 |
| `pluto/rxdb/Store.ts` | P6 |
| `pluto/repositories/DIDRepository.ts` | P7 |
| `pluto/repositories/builders/BaseRepository.ts` | P7 |
| `edge-agent/connectionsManager/ConnectionsManager.ts` | P7, P10 |
| `pluto/Pluto.ts` | P7, P13 |
| `domain/models/Message.ts` | P8 |
| `mercury/didcomm/Wrapper.ts` | P9 |
| `edge-agent/protocols/pickup/PickupRunner.ts` | P9 |
| `domain/models/errors/Mercury.ts` | P9 |
| `edge-agent/mediator/BasicMediatorHandler.ts` | P10 |
| `edge-agent/types/index.ts` | P10 |
| `edge-agent/protocols/connection/HandshakeRequest.ts` | P11 |
| `edge-agent/protocols/types.ts` | P11 |
| `domain/buildingBlocks/Pluto.ts` | P13 |
| `edge-agent/didcomm/HandleOOBInvitation.ts` | P3 (signature pass-through) |

### A.3 Wallet-side workarounds that are *not* SDK patches

Same category of hidden knowledge; they live in `idl-wallet/src` and must survive the port.

- **`ShortFormDIDResolverSample`** (`actions/index.ts:2450`) — a custom
  `SDK.Domain.DIDResolver` passed as an `extraResolver` to `Castor`, because short-form PRISM DIDs
  are not resolvable by the default resolver. Kotlin's `CastorImpl(apollo)` must accept the
  equivalent; verify extra-resolver support exists.
- **Long-form PRISM DID disabled for credential requests** — per `CLAUDE.md`'s Known Issues, a
  Cloud Agent validation bug; workaround active in `actions/index.ts`.
- **Empty presentation-claims filter is mandatory** (`actions/index.ts` ~line 1100) — requesting a
  claim with an empty filter object (`{ clearanceLevel: {} }`) triggers a Pollux bug:
  `validateInputDescriptor` sees a truthy `{}` with no `.pattern`/`.enum`/`.const` and can never
  mark the field valid, so `handlePresentation` **always** rejects. Claims must be `{}` entirely,
  with real validation done afterwards by `validateSecurityClearanceVC`. **Check whether Kotlin's
  Pollux has the same flaw before designing any claim filter.**
- **`createdTime` is in seconds, not milliseconds** — normalised with
  `msgTime < 10000000000 ? msgTime * 1000 : msgTime`. See `04-message-pipeline.md`.
- **Duplicate-credential cleanup on startup** — `cleanupDuplicateCredentials(agent)` runs
  fire-and-forget from `startAgent`, a symptom of the redelivery cluster (`04`).
- **Orphaned-peer-DID cleanup** — `utils/cleanupOrphanedPeerDIDs.ts`.
- **WASM memory pressure** — `components/WasmMemoryGuard.tsx`, `utils/MemoryMonitor.ts`,
  `utils/RouteMemoryCleanup.ts` exist solely because the browser SDK leaks WASM memory. **These
  should not be ported**; JVM has no equivalent constraint. Confirm before dropping.

---

## Part B — API mapping

Verified against `github.com/hyperledger-identus/sdk-kmp` @ `main` (latest tag `v5.0.0`), files
`sdk/src/commonMain/kotlin/org/hyperledger/identus/walletsdk/edgeagent/EdgeAgent.kt` and
`…/domain/buildingblocks/Pluto.kt`. Anything not directly read is marked **unverified**.

### B.1 Coordinates and platform

```kotlin
implementation("org.hyperledger.identus:sdk:<version>")   // latest tag v5.0.0
```

- Requires **Kotlin ≥ 1.9.24**, **JVM 17+**, **Android API ≥ 21**.
- Source sets: `commonMain`, `androidMain`, `jvmMain`. **No `iosMain`.**
- Repo self-describes as "Edge Agent SDK - Kotlin Multiplatform (**Android/JVM**)".

> The `gradle.properties` in `main` reads `version = 4.0.0` while the newest tag is `v5.0.0`
> (semantic-release sets the published version at build time). **Pin an explicit version; do not
> infer it from `gradle.properties`.**

**Consequence for iOS:** the Kotlin SDK cannot be linked on iOS. iOS requires
`hyperledger-identus/sdk-swift` behind the `sdkbridge` boundary — see `02-architecture.md`.

### B.2 Construction

TypeScript hides most wiring behind `Agent.initialize`:

```ts
const apollo = new SDK.Apollo();
const castor  = new SDK.Castor(apollo, [ShortFormDIDResolverSample]);
const agent   = await Agent.initialize({ apollo, castor, mediatorDID, pluto, seed: defaultSeed });
```

Kotlin requires every building block explicitly:

```kotlin
val apollo = ApolloImpl()
val castor = CastorImpl(apollo)
val pluto  = PlutoImpl(DbConnectionImpl())
pluto.start(context)                    // context = null on JVM
val mercury = MercuryImpl(castor, DIDCommWrapper(castor, pluto, apollo), ApiImpl(httpClient()))
val pollux  = PolluxImpl(castor)
val handler = BasicMediatorHandler(
    mediatorDID = DID(MEDIATOR_DID),
    mercury     = mercury,
    store       = BasicMediatorHandler.PlutoMediatorRepositoryImpl(pluto)
)
val agent = EdgeAgent(apollo, castor, pluto, mercury, pollux, seed, handler)
agent.start()
agent.startFetchingMessages(requestInterval = 5)
```

Mediator DID for this deployment is hardcoded at `idl-wallet/src/reducers/app.ts:19`.

`EdgeAgent` is an `open class` with two constructors and exposes `flowState: MutableSharedFlow<State>`
— use it for the agent-status UI rather than the ad-hoc `isStarting`/`hasStarted` booleans in
`reducers/app.ts`.

### B.3 Method mapping

Counts are usages in `idl-wallet/src`.

| TypeScript | Kotlin | Status |
|---|---|---|
| `Agent.initialize({…})` | `EdgeAgent(apollo,castor,pluto,mercury,pollux,seed,mediatorHandler)` | 🟡 manual wiring (B.2) |
| `agent.start()` (7) / `stop()` (1) | `suspend fun start()` / `stop()` | 🟢 |
| `agent.startFetchingMessages(5)` (3) | `startFetchingMessages(requestInterval: Int = 5)` | 🟢 TS comment notes seconds→ms internally; confirm Kotlin unit |
| `agent.stopFetchingMessages()` (1) | `suspend fun stopFetchingMessages()` | 🟢 |
| `agent.addListener(ListenerKey.MESSAGE, cb)` (3) | `handleReceivedMessagesEvents(): Flow<List<Message>>` | 🔴 **all messages, not new** — B.5 |
| `agent.removeListener` (3) | cancel the Flow collection job | 🟡 |
| `agent.createNewPeerDID([], false)` (9) | `createNewPeerDID(services: Array<Service>, updateMediator: Boolean)` | 🟢 |
| `createLongFormPrismDID` thunk | `createNewPrismDID(alias, keyPathIndex)` / `(keys, services, keyPathIndex)` | 🟡 see P5, and the long-form workaround in A.3 |
| `agent.parseInvitation` (4) / `parseOOBInvitation` (2) | `suspend fun parseInvitation(str: String): InvitationType` | 🟢 one entry point |
| `agent.acceptInvitation` (8) | `acceptOutOfBandInvitation(OutOfBandInvitation)` | 🟡 renamed |
| `agent.acceptDIDCommInvitation` (1) | `acceptInvitation(PrismOnboardingInvitation)` | 🔴 **names are crossed over** — read `InvitationType` before wiring |
| `agent.sendMessage(msg)` (15) | `suspend fun sendMessage(Message): Message?` | 🟢 |
| `agent.prepareRequestCredentialWithIssuer(did, offer)` (2) | same | 🟢 P3 |
| `agent.processIssuedCredentialMessage(ic)` (2) | `suspend fun processIssuedCredentialMessage(IssueCredential): Credential` | 🟢 |
| `agent.createPresentationForRequestProof(req, cred)` (2) | `preparePresentationForRequestProof(req, cred[, disclosingClaims])` | 🟡 renamed; 3-arg overload adds SD-JWT selective disclosure |
| `agent.handlePresentation(msg)` (**14**) | `suspend fun handlePresentation(msg: Message): Boolean` | 🟡 requires the original request still in Pluto — B.6 |
| `agent.initiatePresentationRequest(type, toDID, claims)` (5) | `initiatePresentationRequest(type, toDID, presentationClaims, domain, challenge)` | 🔴 `domain`+`challenge` **mandatory** for JWT — B.6 |
| `agent.backup.createJWE()` (2) / `restore()` (2) | `suspend fun backupWallet(PlutoBackupTask): String` / `recoverWallet(jwe)` | 🟡 renamed; also `PlutoBackupTask`/`PlutoRestoreTask`, `BackupV0_0_1` |
| `agent.connectionManager.addConnection(pair)` (8) | `registerDIDPair(pair: DIDPair)` | 🟢 |
| `…mediationHandler.updateKeyListWithDIDs(dids)` (4) | `updateMediatorWithDID(did: DID)` | 🟡 **single DID** — loop; keep the batch semantics of P12/`startAgent` |
| `agent.castor.resolveDID` (2) / `parseDID` (2) | `castor.resolveDID(String)` / `parseDID` | 🟢 |
| `agent.apollo.createPublicKey` (1) | `apollo.createPrivateKey(…)` / `restorePrivateKey(id, data)` | 🟡 different shape |
| *(holder PoP, `holderProof.ts`)* | `suspend fun signWith(did: DID, message: ByteArray): Signature` | 🟢 **better than TS** — handles Ed25519 + Secp256k1 |
| `agent.pollux.parseCredential` (2) | `pollux.parseCredential` / `restoreCredential(id, data, revoked)` | 🟡 |
| `SDK.JWTCredential.fromJWS` (6) / `SDJWTCredential.fromJWS` (3) | via Pollux | 🟡 **unverified** direct-parse path |
| `SDK.isPresentationDefinitionRequestType` (3), `SDK.Domain.InputField` (7) | `JWTPresentationDefinitionRequest`, `PresentationClaims` | 🟡 shapes differ |
| `SDK.ProtocolType.*` | `ProtocolType.*` (e.g. `DidcommOfferCredential`, `DidcommRequestPresentation`) | 🟢 |
| `SDK.Domain.MessageDirection.RECEIVED` (13) | `Message.Direction.RECEIVED` — or `pluto.getAllMessagesReceived()` | 🟢 |
| `agent.getAllCredentials` / `getAllDIDPairs` / `getAllRegisteredPeerDIDs` | present as suspend/Flow convenience wrappers on `EdgeAgent` | 🟢 |

### B.4 Pluto: Flow-based, and **no deletes**

Every Kotlin Pluto getter returns `Flow<…>`; use `.first()` for one-shot reads and collect only
where the UI genuinely wants a live stream.

| TypeScript (count) | Kotlin | Status |
|---|---|---|
| `getAllDidPairs` (14) | `getAllDidPairs(): Flow<List<DIDPair>>` | 🟢 |
| `getAllMessages` (5) | `getAllMessages(): Flow<List<Message>>` + many filtered variants (`ByType`, `Sent`, `Received`, `SentTo`, `ReceivedFrom`, `(from,to)`) | 🟢 **richer than TS** — use these instead of filtering in memory |
| `getMessage(id)` (7) | `getMessage(id): Flow<Message?>` | 🟢 |
| — | `getMessageByThidAndPiuri(thid, piuri): Flow<Message?>` | 🟢 **no TS equivalent** — ideal for `thid` correlation in `05-protocols.md` |
| `getAllPeerDIDs` (7) | `getAllPeerDIDs(): Flow<List<PeerDID>>` | 🟢 |
| `getAllCredentials` (6) | `getAllCredentials(): Flow<List<CredentialRecovery>>` | 🟡 returns `CredentialRecovery`, not `Credential` — `EdgeAgent.getAllCredentials()` gives `Flow<List<Credential>>` |
| `getAllPrismDIDs` (5) | `getAllPrismDIDs(): Flow<List<PrismDIDInfo>>` | 🟢 |
| `getDIDPrivateKeysByDID` (4) | `getDIDPrivateKeysByDID(did): Flow<List<StorablePrivateKey?>>` | 🟡 needs `apollo.restorePrivateKey(it.restorationIdentifier, it.data)` |
| `getLinkSecret` (1) | `getLinkSecret(): Flow<String?>` | 🟢 |
| `storeMessage` (7) | `storeMessage(message)` / `storeMessages(list)` | 🟢 |
| `storeCredential` (2) | `storeCredential(StorableCredential)` | 🟡 wrap first |
| `storeDIDPair` (2) | `storeDIDPair(host, receiver, name)` | 🟢 |
| `storeDID` (1) | `storePrismDIDAndPrivateKeys(…)` / `storePeerDID(did)` | 🟡 **split by DID kind** |
| **`deleteMessage` (7)** | **absent** | 🔴 |
| **`deleteCredential` (2)** | **absent** (only `revokeCredential(credentialId)`) | 🔴 |
| **`deletePeerDID` (1)** | **absent** | 🔴 |
| `SDK.Store({name, storage: IndexDB, password})` | `DbConnectionImpl()` → `JdbcSqliteDriver("jdbc:sqlite:prism.db")` | 🔴 fixed path, **no encryption** |

`PlutoImpl.kt` contains **no** `delete*` or `remove*` function. The wallet features that break
without deletes: `deleteConnection`, `deleteCredentialByVcId`, `clearWalletData`,
`cleanupOrphanedPeerDIDs`, `cleanupDuplicateCredentials`, `connectionDeletion.ts`, and the
message-dedup strategy in `04-message-pipeline.md`. Also useful and present:
`getAllKeysForBackUp()`, `getAllPrivateKeys()`, `observeRevokedCredentials()`.

**Remedy:** custom SQLDelight queries against the SDK's `SdkPlutoDb` schema, exposed through
`sdkbridge` as `deleteMessage(id)`, `deleteCredential(id)`, `deletePeerDID(did)`,
`deleteDIDPair(host, receiver)`. Referential integrity across DID / DIDLink / Message /
Credential tables must be worked out from the SDK's `.sq` files and specified in
`03-state-and-storage.md`.

### B.5 The message-listener semantics change (highest behavioural risk)

TypeScript:

```ts
agent.addListener(ListenerKey.MESSAGE, handleMessages);   // NEW messages only
```

Kotlin:

```kotlin
fun handleMessagesEvents():          Flow<List<Message>> = pluto.getAllMessages()
fun handleReceivedMessagesEvents():  Flow<List<Message>> = pluto.getAllMessagesReceived()
```

These are **the whole table, re-emitted on change** — not a new-message delta. Every branch of
`handleMessages` in `actions/index.ts` assumes "new only".

A naive port reproduces, by construction, the entire documented redelivery bug cluster: the
credential-offer modal loop, the credential-row explosion, and the stuck-retry state. The wallet
already fights this with `getProcessedIssueCredentialIds()` / `markIssueCredentialProcessed()`,
`seenGrantIds`/`seenErrorIds` refs in `_app.tsx`, `dismissedOfferIds`, `rejectionManager.ts`, and
`cleanupDuplicateCredentials` — all because the SDK/mediator re-delivers old message ids as new.

**Remedy:** a mandatory, persistent idempotency layer between the Flow and the handlers — not
in-memory `Set`s that reset on restart. Specified as a first-class component in
`04-message-pipeline.md`.

### B.6 Presentation API differences

**`initiatePresentationRequest` requires `domain` and `challenge`.**

```kotlin
suspend fun initiatePresentationRequest(
    type: CredentialType, toDID: DID, presentationClaims: PresentationClaims,
    domain: String? = null, challenge: String? = null
)
```

For `CredentialType.JWT` it throws `EdgeAgentError.MissingOrNullFieldError` if either is null.
TypeScript generated the nonce internally, which `liveIdentityVerification.ts` explicitly relies on
("not caller-supplied, but that's fine: we never need to know the nonce ourselves").

This is an **improvement** for the live-verification design — the wallet can now supply its own
unpredictable challenge, which is exactly what that file wants. But it changes the call signature at
all 5 sites and the challenge must be generated, persisted against the `thid`, and checked.

Note the hardcoded `jwt = arrayOf("ES256K")` in the JWT branch — cross-check against P4.

**`handlePresentation(msg)`** requires `msg.thid` (throws otherwise) and looks up the original
request via `pluto.getMessageByThidAndPiuri(msg.thid, ProtocolType.DidcommRequestPresentation.value)`.
So the request-presentation message **must still be in Pluto** when the response arrives. Any
message-pruning policy has to preserve it — interacts directly with the missing `deleteMessage`
(B.4) and the dedup layer (B.5).

### B.7 JVM storage: no encryption, one fixed path

`sdk/src/jvmMain/.../DbConnectionImpl.kt` in full:

```kotlin
actual override suspend fun connectDb(context: Any?): SqlDriver {
    val driver = JdbcSqliteDriver("jdbc:sqlite:prism.db")
    SdkPlutoDb.Schema.create(driver)
    this.driver = driver
    return driver
}
```

Versus TypeScript:

```ts
const store = new SDK.Store({
    name: options.username ? `identus-wallet-idl-${username.toLowerCase()}` : state.wallet.dbName,
    storage: IndexDB,
    password: Buffer.from(sha512(options.encryptionKey)).toString("hex")
});
```

Three regressions in one function: a hardcoded relative filename, no per-user isolation, and no
encryption at rest. A `DbConnectionInMemory` also exists (tests only).

**Remedy:** a custom `DbConnection` supplying a per-user path under the OS app-data directory plus
an encrypted driver (SQLCipher on Android; JDBC SQLCipher or equivalent on JVM). Specified in
`03-state-and-storage.md`. Multi-user isolation is a **security property** of the current wallet
(`prefixedStorage.ts`'s own doc comment records a real past leak between profiles), not a
convenience.

### B.8 Capability summary

| Capability | TS (fork) | Kotlin | Note |
|---|---|---|---|
| JWT VC | ✅ | ✅ | curve policy P4 |
| SD-JWT VC | ✅ | ✅ | + `disclosingClaims` selective disclosure |
| AnonCreds | ✅ | ✅ | unused by this wallet |
| Presentation Exchange | ✅ | ✅ | `PresentationClaims`; watch the empty-filter bug (A.3) |
| Wallet as verifier | ✅ | ✅ | needs domain+challenge (B.6) |
| Backup / restore JWE | ✅ | ✅ | renamed; envelope compatibility unverified |
| BasicMessage | ✅ | ✅ | carries all three custom protocols (`05-protocols.md`) |
| Pluto deletes | ✅ (patched) | ❌ | B.4 |
| Encrypted / per-user store | ✅ | ❌ | B.7 |
| New-message delta | ✅ | ❌ | B.5 |
| iOS | n/a | ❌ | B.1 |

### B.9 Unverified — resolve before the phase that depends on it

1. Direct JWT/SD-JWT credential parsing outside Pollux's offer flow (`JWTCredential.fromJWS`).
2. Whether `CastorImpl` accepts extra DID resolvers (needed for `ShortFormDIDResolverSample`).
3. Whether Kotlin Pollux has the empty-input-descriptor-filter bug (A.3).
4. Whether `startFetchingMessages`' interval is seconds or milliseconds.
5. Backup JWE envelope compatibility between `BackupV0_0_1` and the TS backup schema — matters only
   if a TS-created backup must restore into the Kotlin wallet. **Ask before assuming it must.**
6. Whether Kotlin's connection request carries a `label` (P11).
7. Whether `EdgeAgent.start()` verifies mediator load (P12).
8. Whether the SDK's `.sq` statements are upserts (P6).
