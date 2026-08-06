# 02 — Architecture

Prerequisite: `01-sdk-gap-analysis.md`. Several decisions here exist only to accommodate its
findings; they will look like over-engineering without it.

## 2.1 Module layout

```
kotlin-wallet/
  settings.gradle.kts
  gradle/libs.versions.toml          version catalogue — pin sdk-kmp explicitly (01 §B.1)
  shared/                            KMP library: jvm + android targets
    src/commonMain/kotlin/cz/identuslabel/wallet/
      domain/                        wallet models, SDK-free
      sdkbridge/                     THE ONLY code that imports org.hyperledger.identus.walletsdk
      store/                         per-user encrypted DB, prefixed KV store, Pluto deletes
      pipeline/                      message pipeline + idempotency layer
      protocols/                     service-access/1.0, credential-issuance/1.0, document-upload/1.0
      trust/                         DID-keyed trust registry, TOFU pinning, live verification
      crypto/                        NaCl box, ephemeral X25519, AES-GCM backup, holder PoP
      net/                           Ktor clients for the REST services
      state/                         MVI stores (one per current Redux slice)
    src/commonMain/sqldelight/       custom delete/upsert queries over SdkPlutoDb
    src/jvmMain/                     JVM actuals: DB path, encrypted driver, keystore, file IO
    src/androidMain/                 Android actuals
  desktopApp/                        Compose Desktop — the primary target
  androidApp/                        Compose — phase 6
  # iosApp/                          NOT created yet; see 2.4
```

**Do not create `iosApp/` or an `iosMain` source set yet.** An empty iOS target that cannot compile
against the SDK is worse than none — it implies a capability that does not exist (`01` §B.1).

## 2.2 The `sdkbridge` boundary — the single most important decision

**Rule: no code outside `sdkbridge` imports `org.hyperledger.identus.walletsdk`.** Enforce it
mechanically (a Konsist/ArchUnit test, or a lint rule on the import) rather than by convention.

Four independent reasons, each of which alone would justify it:

1. **iOS.** `sdk-kmp` has no iOS artifact. The only route to iOS is a second implementation backed
   by `sdk-swift`. If SDK types leak into the UI, that becomes a rewrite instead of a new module.

2. **The fork patches.** 13 patches (`01` Part A) modified SDK *internals*. In Kotlin, those
   behaviours must be reimplemented *around* an unmodified SDK. `sdkbridge` is where they live:
   lenient offer parsing (P1), piuri normalisation (P2), curve-selection policy (P4), idempotent
   writes (P6/P7), tolerant attachment decoding (P8), deferred-decryption handling (P9). **Do not
   fork `sdk-kmp`** — the TS fork's history is a cautionary tale: its source path was lost and the
   patches survived only by accident.

3. **The missing deletes.** Custom SQLDelight queries against the SDK's own `SdkPlutoDb` schema
   (`01` §B.4) are inherently coupled to SDK internals and must be quarantined.

4. **The listener-semantics change.** `01` §B.5 — the boundary is where "entire table re-emitted"
   is converted into "new messages, once".

### Interface shape

Declare the bridge as a plain `interface` in `commonMain`, not an `expect class`. `expect`/`actual`
forces one implementation per platform; an interface allows a JVM/Android implementation plus test
fakes plus a future Swift-backed one, and keeps the pipeline unit-testable without a mediator.

```kotlin
interface WalletAgent {
    val state: Flow<AgentState>

    suspend fun start(); suspend fun stop()
    fun newMessages(): Flow<List<WalletMessage>>          // deltas, NOT the whole table (04)

    suspend fun createPeerDid(services: List<ServiceEndpoint> = emptyList(), updateMediator: Boolean): Did
    suspend fun createPrismDid(alias: String?, keyAgreement: Boolean = false): Did

    suspend fun parseInvitation(raw: String): ParsedInvitation
    suspend fun acceptInvitation(invitation: ParsedInvitation)

    suspend fun send(message: WalletMessage)

    suspend fun requestCredential(offer: CredentialOfferRef, subjectDid: Did)
    suspend fun storeIssuedCredential(message: WalletMessage): WalletCredential

    suspend fun presentProof(request: PresentationRequestRef, credential: WalletCredential,
                             disclosing: List<String>? = null)
    suspend fun requestProof(from: Did, claims: ProofClaims, domain: String, challenge: String): String  // returns thid
    suspend fun verifyPresentation(message: WalletMessage): Boolean

    suspend fun signAsHolder(did: Did, payload: ByteArray): ByteArray

    suspend fun backup(): String
    suspend fun restore(jwe: String)
}
```

Notes on the shape:

- `newMessages()` returns **deltas**, converting Kotlin's whole-table Flow at the boundary. Handlers
  never see the raw Flow.
- `requestProof` returns the `thid`, because the caller must persist the challenge against it
  (`01` §B.6) — the TS API returned nothing and relied on the SDK's internal nonce.
- `signAsHolder` maps to `EdgeAgent.signWith`, which is strictly better than the TS approach in
  `holderProof.ts` (that file reached into Pluto for raw key bytes; Kotlin handles both curves).
- No `deleteX` here — deletes belong to the store layer (`03`), which owns the DB.
- Domain types (`Did`, `WalletMessage`, `WalletCredential`) are **ours**, defined in `domain/`.
  Mapping to/from SDK types happens only inside the implementation.

## 2.3 Threading and state: Redux thunks → coroutines + MVI

The TS wallet uses Redux Toolkit with 28 `createAsyncThunk`s in `actions/index.ts` plus 19 in
`enterpriseAgentActions.ts`, and holds non-serializable SDK handles in the store — `store.ts`'s
`ignoredPaths`/`ignoredActions` lists are effectively a catalogue of what does not belong in state:
`app.db.instance`, `app.agent.instance`, `app.agent.selfDID`, `app.messages`, `app.connections`,
`app.credentials`, `app.prismDIDs`, `enterpriseAgent.client`.

**Do not port that shape.** In Kotlin:

- SDK/DB handles live in **singletons owned by the DI graph**, never in UI state.
- UI state is immutable data classes exposed as `StateFlow`, holding only rendering-ready values.
- Thunks become `suspend` functions on repositories/use-cases. Long-running polls become
  `Flow`s scoped to a `CoroutineScope`, not `setInterval` + `clearInterval`.
- Dispatchers: `Dispatchers.Default` for crypto/parsing, `Dispatchers.IO` for DB/HTTP, main
  dispatcher only for state emission. Pluto is SQLite — serialise writes through a single-threaded
  context or the SDK's own dispatcher to avoid lock contention.

The TS code polls with `setInterval` in several places (`initiateVCHandshake`,
`liveIdentityVerification`, `sendDocumentAccessRequest`, enterprise grant polling). All become
`flow { }` + `withTimeout`, which removes an entire class of leaked-interval bugs — `clearInterval`
is easy to miss on every early-return path, and the TS code has several.

### Replacing `useMountedApp()`

`reducers/store.ts` exposes `useMountedApp()`, which spreads **every** action creator and the whole
`app` slice into one object used by nearly every component. It is the wallet's de facto god object.
Do not reproduce it: give each screen a ViewModel with only the use-cases it needs. This is the main
reason the TS components are so large (`OOB.tsx` 2628 lines, `ConnectionRequest.tsx` 1788).

## 2.4 iOS decision record

**Status: blocked at the SDK layer, by design accommodated.**

`sdk-kmp` publishes `androidMain` and `jvmMain` only. Kotlin/Native can *target* iOS, but the SDK
provides no iOS artifact — notably `DbConnectionImpl` (SQLDelight driver) and the DIDComm
implementation have no iOS actuals. Identus ships a separate Swift SDK
(`github.com/hyperledger-identus/sdk-swift`) for Apple platforms.

Three options, with a recommendation:

| Option | Cost | Risk |
|---|---|---|
| **A. `sdk-swift` behind `WalletAgent`** (recommended) | Implement `WalletAgent` in Swift; share `domain`, `protocols`, `trust`, `state` via KMP | Two SDK implementations to keep behaviourally aligned; needs a shared conformance test suite |
| B. Contribute iOS targets to `sdk-kmp` | Large; requires iOS actuals for SQLDelight, DIDComm, crypto | Upstream timeline outside our control |
| C. Native iOS app, no sharing | No KMP constraint | Third full implementation of the protocols and trust model — worst long-run cost |

**Choose A.** It is the only option where the work done for desktop and Android is reused, and it is
the reason `WalletAgent` is an interface rather than an `expect class` (§2.2). Consequence: keep
`protocols/`, `trust/`, `domain/`, and `state/` free of *any* platform or SDK dependency, so they
compile for iOS unchanged. `crypto/` and `store/` will need iOS actuals.

**Sequencing:** ship desktop (Phase 0–5), then Android (Phase 6) — Android proves the KMP split
without the SDK-swap variable. Only then attempt iOS (Phase 7), when `WalletAgent`'s surface has
stabilised against two real UIs.

## 2.5 UI framework

**Compose Multiplatform**, desktop target first.

- Desktop and Android share Compose code; iOS Compose support does not change the §2.4 conclusion
  (the blocker is the SDK, not the UI).
- The current UI is Tailwind on a dark slate/cyan theme (`src/app/index.css`, `MainLayout.tsx`).
  Define a Compose theme rather than transliterating utility classes; capture the visual intent in
  `09-ui-screens.md`.
- Two screens need non-trivial native work — DOCX rendering and camera QR scanning (`09` §9.10).
  Neither has a Compose Multiplatform answer out of the box; both need a platform decision before
  Phase 5.

## 2.6 Dependency injection

Use **Koin** (works across KMP targets; Hilt is Android-only and would break the desktop target).

Graph roots, all singletons, created in dependency order — this order is load-bearing because
`PlutoImpl.start()` must complete before `EdgeAgent` is constructed (`01` §B.2):

```
WalletDatabase (per-user, encrypted)   →  03 §3.3
  PlutoStore (SDK Pluto + custom deletes) →  03 §3.4
    WalletAgent (sdkbridge impl)        →  02 §2.2
      MessagePipeline (+ IdempotencyStore) →  04
        ProtocolClients, TrustRegistry     →  05, 06
          Repositories → ViewModels
```

**Per-user scoping:** the database, prefixed KV store, and agent are all per-logged-in-user. Model
login as **creating a user-scoped Koin scope** and logout as closing it. In TS this is done by
mutating module-level globals at login (`setPrefixedStorageWalletId`, `setDocumentStorageWalletId`,
`setSecureDashboardAgent` — all called from `connectDatabase`), which is exactly how profiles leaked
into each other before those setters were added; `prefixedStorage.ts`'s own doc comment records that
leak. A scope makes the isolation structural instead of remembered.

## 2.7 Networking

**Ktor client** with `ContentNegotiation` + kotlinx.serialization. Engine: CIO or OkHttp (JVM),
OkHttp (Android).

Four distinct HTTP concerns, kept as separate clients (`08-external-services.md`):

1. Cloud Agent REST (enterprise + multitenancy) — `EnterpriseAgentClient.ts`
2. CA / company-admin / document-service app APIs
3. Iagon backup storage
4. The mediator — owned by the SDK; do not touch it directly

All service base URLs must be **configurable**, not compiled in. The TS wallet hardcodes
`https://identuslabel.cz/...` in ~8 places including `config/certificationAuthority.ts` and
`serviceAccessGrant.ts`'s origin allowlist fallback. Centralise into one `DeploymentConfig`, but
note the security constraint: the CA base URL doubles as a **trust anchor** for redirect-grant
origin checks (`06-trust-model.md`), so it must be operator-set configuration, never
runtime-discovered from a message.

## 2.8 Logging

The TS wallet ships `utils/ConsoleLogger.ts` and a `/wallet/api/logs` route that writes to a
server-side file — an artefact of running in a browser. On desktop, log to a rotating file in the
app-data directory directly and drop the HTTP hop (`08` §8.5).

Carry over the practice of logging protocol decisions (which capability, which DID, trusted or not,
why a grant was rejected). `serviceAccessGrant.ts` and `liveIdentityVerification.ts` are debuggable
in production precisely because of this. **Never log private key material, seeds, or decrypted
document content** — the TS code is careful to truncate DIDs to ~50 chars in logs; keep that.

## 2.9 Testing strategy

| Layer | Approach |
|---|---|
| `domain`, `protocols`, `trust` | Pure unit tests, no SDK. Port the existing vectors in `packages/service-access-didcomm/test/` and `idl-wallet/tests/` |
| `store` | `DbConnectionInMemory` (ships with the SDK) + a real encrypted file DB for the per-user isolation test |
| `pipeline` | Fake `WalletAgent` emitting scripted message batches — **including replays**, to prove the idempotency layer (`04` §4.4) |
| `sdkbridge` | Integration tests against the live deployment; this is the only layer that needs it |
| UI | Compose UI tests for the grant/offer/proof modals, which carry the security-relevant decisions |

The conformance suite over `WalletAgent` is what makes §2.4 option A viable — write it as the bridge
is built, not retrofitted.
