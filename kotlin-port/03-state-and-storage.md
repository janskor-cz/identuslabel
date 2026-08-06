# 03 — State and Storage

Covers Phase 0. Prerequisites: `01-sdk-gap-analysis.md` §B.4 and §B.7, `02-architecture.md` §2.3.

The current wallet has **six** independent storage systems. Only the first is the SDK's; the other
five are hand-rolled. Enumerating them is the point of this document — a port that only replicates
Pluto loses most of the wallet's state.

| # | System | Backing | Scoping | Where |
|---|---|---|---|---|
| 1 | Pluto (SDK) | RxDB / IndexedDB, encrypted | `identus-wallet-idl-<user>` | `actions/index.ts` `connectDatabase` |
| 2 | Prefixed key-value | `localStorage` | `wallet-idl-<user>-<key>` | `utils/prefixedStorage.ts` |
| 3 | Classified documents | IndexedDB | `classified-documents-store-<user>` | `utils/documentStorage.ts` |
| 4 | Connection-request queue | IndexedDB | `connection_requests_<user>` | `utils/connectionRequestQueue.ts` |
| 5 | Message rejections | IndexedDB | `message_rejections_<user>` | `utils/rejectionManager.ts` |
| 6 | Invitation states | IndexedDB | `invitation_states_<user>` | `utils/InvitationStateManager.ts` |
| — | Raw `localStorage` (unprefixed) | `localStorage` | **none — a bug** | 3 keys, §3.2 |

## 3.1 Per-user isolation is a security property

All six are scoped by the lowercased username, set at login in `connectDatabase`
(`actions/index.ts:2548`):

```ts
const dbName = `identus-wallet-idl-${username.toLowerCase()}`;
const walletId = username.toLowerCase();
api.dispatch(reduxActions.setWalletId(walletId));
setDocumentStorageWalletId(walletId);
setPrefixedStorageWalletId(walletId);
```

`prefixedStorage.ts`'s own doc comment records why: before those setters existed, every wallet
profile on one browser **shared a single bucket** for security clearance keys, CA/company TOFU pins,
and connection metadata — "contrary to this file's own isolation claim above."

**Requirement:** in Kotlin, isolation must be **structural**, not three setters someone has to
remember to call. Model login as opening a user-scoped Koin scope that owns the database, the KV
store, and the agent (`02` §2.6); logout closes it. Adding a seventh store must not require touching
a login function.

**Backward compatibility:** `getStoragePrefix()` returns the *unsuffixed* `wallet-idl-` when no user
id is set, deliberately, so pre-multi-user data isn't orphaned. The Kotlin wallet starts fresh —
**do not port the null-user fallback.** A missing user id should be a programming error, not a
silent fallback into a shared bucket.

## 3.2 Three keys that escape prefixing — fix, don't port

These call `localStorage` directly, bypassing `prefixedStorage.ts` and therefore leaking across
profiles:

| Key | Note |
|---|---|
| `security-clearance-keys` | **Private key material.** The most serious of the three — cross-profile leak of encryption keys. |
| `last-qr-scan-time` | Benign |
| `wallet-log-file-path` | Benign |

`security-clearance-keys` is also written *through* `prefixedStorage` elsewhere, so the two paths
disagree about where the keys live. In Kotlin: **one accessor, always user-scoped, no exceptions.**
Security keys additionally belong in the platform keystore rather than a plain KV store — see
`07-crypto.md` §7.6.

## 3.3 The per-user encrypted database

The SDK's JVM driver is a hardcoded, unencrypted file (`01` §B.7):

```kotlin
JdbcSqliteDriver("jdbc:sqlite:prism.db")
```

Supply a custom `DbConnection` instead:

```kotlin
class WalletDbConnection(
    private val userId: String,
    private val passphrase: CharArray,
    private val paths: AppPaths,
) : DbConnection {
    override var driver: SqlDriver? = null

    override suspend fun connectDb(context: Any?): SqlDriver {
        val file = paths.userDataDir(userId).resolve("pluto.db")   // 0700 dir, 0600 file
        val d = encryptedDriver(file, passphrase)                  // expect/actual per platform
        if (!file.existed) SdkPlutoDb.Schema.create(d) else SdkPlutoDb.Schema.migrate(d, ...)
        driver = d
        return d
    }
}
```

Requirements:

- **Per-user path** under the OS app-data dir (`%LOCALAPPDATA%`, `~/Library/Application Support`,
  `$XDG_DATA_HOME`), directory `0700`, file `0600`. Never the process working directory —
  `"jdbc:sqlite:prism.db"` is relative, so today the DB lands wherever the app was launched from.
- **Encryption at rest.** Android: SQLCipher (`net.zetetic:android-database-sqlcipher`) with a
  SQLDelight driver. JVM: SQLCipher via JDBC, or `sqlite-jdbc` with an encryption extension. Verify
  the chosen JVM option actually encrypts — several SQLite JDBC wrappers accept a `key` pragma and
  silently ignore it. **Write a test that greps the raw file for a known plaintext string.**
- **Key derivation** must match the TS scheme only if cross-restore matters (it likely does not, see
  `01` §B.9 item 5). TS uses `hex(sha512(encryptionKey))` as the store password. For a fresh Kotlin
  wallet, prefer Argon2id or PBKDF2-HMAC-SHA256 with a high iteration count over raw SHA-512 —
  a single SHA-512 is not a password KDF. Document the choice; it is a deliberate improvement.
- `PlutoImpl.start(context)` takes `context` — an Android `Context`, `null` on JVM.

### The DB8 lesson: clean up a partially-initialised database

`connectDatabase` contains a hard-won `catch` block worth reading in full
(`actions/index.ts` ~2610). Summary: RxDB registers the database under its name as soon as
`db.start()` succeeds. If anything *after* that throws, the DB stays alive and registered while the
attempt is reported as failed — so a retry hits "database already exists" (RxDB error DB8)
**permanently**, since nothing ever destroyed the orphan. The fix explicitly calls `db.stop()` on the
inner failure path.

SQLite's failure mode differs (stale locks / WAL files rather than a name registry), but the
principle transfers: **any failure after the driver opens must close the driver before propagating.**
Use `runCatching { … }.onFailure { driver?.close() }` or a `use`-style scope. This is the Phase 0
exit test — open and close a per-user encrypted DB twice, with an induced failure after open, and
confirm the second attempt succeeds.

## 3.4 The missing Pluto deletes

Kotlin Pluto has no `delete*` function (`01` §B.4). Implement these as custom SQLDelight queries in
`shared/src/commonMain/sqldelight/`, against the SDK's own `SdkPlutoDb` schema, exposed only through
`sdkbridge`:

| Needed | Used by |
|---|---|
| `deleteMessage(id)` | dual-layer state updates, dedup pruning, `clearWalletData` |
| `deleteMessagesForPair(host, receiver)` | `connectionDeletion.ts` |
| `deleteCredential(id)` | `deleteCredentialByVcId`, `cleanupDuplicateCredentials` |
| `deleteDIDPair(host, receiver)` | `deleteConnection` |
| `deletePeerDID(did)` | `cleanupOrphanedPeerDIDs.ts` |
| `deleteAllForUser()` | `clearWalletData.ts` |

**Before writing them, read the SDK's `.sq` files** to establish the real schema and foreign-key
relationships (DID / DIDLink / Message / Credential / PrivateKey tables). Deleting a DID pair
without its DIDLink rows, or a peer DID whose private keys remain, leaves referential garbage that
the SDK's own queries will later trip over. Two specific hazards:

1. **Do not delete a `request-presentation` message that a pending presentation still needs.**
   Kotlin's `handlePresentation` resolves it via
   `getMessageByThidAndPiuri(thid, DidcommRequestPresentation)` (`01` §B.6). Any pruning policy must
   exclude messages whose `thid` has an open protocol thread.
2. **Do not delete private keys still bound to a held credential** — the holder could no longer
   present it. `deleteCredential` must not cascade to keys.

### Dual-layer updates

`CLAUDE.md` states the invariant, and it survives the port with a change of mechanism:

```typescript
await agent.pluto.deleteMessage(message.id);          // LAYER 1: persist
dispatch(messagesRemoved({ ids: [message.id] }));     // LAYER 2: Redux
```

In Kotlin the second layer is usually **free**: if UI state derives from a `Flow` over Pluto, the
delete propagates automatically. Prefer that — it removes the desync class entirely. Where a
`StateFlow` snapshot is held for performance, the invariant still applies and must be commented as
such.

## 3.5 `RootState` → MVI

Full current shape (`reducers/app.ts:29`), with disposition:

| Field | Disposition |
|---|---|
| `errors: TraceableError[]` | Keep — per-screen error state, plus a global toast channel |
| `wallet: WalletConfig` | → `DeploymentConfig` + user scope (`02` §2.7); not UI state |
| `username: string \| null` | → the user scope's identity |
| `iagonBackup: {status, error?}` | Keep as a UI state machine (`07` §7.5) |
| `db: {instance, connected, isConnecting, hasConnected}` | **Drop `instance`** (DI singleton). Collapse 3 booleans into one `DbState` enum |
| `messages: ExtendedMessage[]` | Derive from Pluto Flow. `ExtendedMessage` adds `isAnswering`/`hasAnswered`/`error` — keep those as a **separate** per-message UI map, not smeared onto the domain model |
| `chatMessages: ChatMessage[]` | Derive — BasicMessage piuri, filtered per conversation |
| `protocolMessages: Message[]` | Derive — non-BasicMessage piuri |
| `currentConversation: string \| null` | Keep — pure UI selection |
| `messageSendingStatus: {[id]: MessageStatus}` | Keep — optimistic-send tracking, genuinely UI-only |
| `connections: DIDPair[]` | Derive from `pluto.getAllDidPairs()`; **join with `ConnectionMetadata`** (§3.6) into one view model |
| `credentials: Credential[]` | Derive from `EdgeAgent.getAllCredentials()` |
| `presentationRequests: PresentationRequest[]` | Keep — holds the full request message pending user VC selection |
| `prismDIDs: any[]` | Derive from `pluto.getAllPrismDIDs()`. **Type it** — `any[]` here hides that these are long-form DIDs subject to the workaround in `01` §A.3 |
| `isCreatingPrismDID: boolean` | Keep — UI progress |
| `mediatorDID: DID` | → `DeploymentConfig`. Currently hardcoded at `reducers/app.ts:19` with a fallback that fabricates a fake DID object when the SDK isn't loaded — **do not port that fallback** |
| `defaultSeed: Seed \| null` | **Never in UI state.** Per-user secret; keystore + DI (`07` §7.6) |
| `agent: {instance, selfDID, isStarting, hasStarted, isSendingMessage, hasSentMessage}` | **Drop `instance`.** Replace the 4 booleans with `EdgeAgent.flowState` (`01` §B.2). Keep `selfDID` — it is load-bearing for the self-message filter (`04` §4.2) |

Three slices exist today (`reducers/index.ts`): `app`, `enterpriseAgent`, `classifiedDocuments`.
Keep the split as three stores. `enterpriseAgent` additionally holds a live `client` handle and
`activeConfiguration` — both go to DI.

**The `ignoredPaths` list in `store.ts` is a specification, not configuration.** Every entry is a
value that was never meant to be in a serializable store. Use it as the checklist for what to move
into DI: `app.db.instance`, `app.agent.instance`, `app.agent.selfDID`, `app.messages`,
`app.connections`, `app.credentials`, `app.mediatorDID`, `app.defaultSeed`, `app.prismDIDs`,
`enterpriseAgent.client`, `enterpriseAgent.activeConfiguration`.

## 3.6 `ConnectionMetadata` — the wallet's most information-dense structure

`utils/connectionMetadata.ts`, stored in the prefixed KV store under `connection-meta-<hostDID>`,
keyed by **our own** side of the pairing (`DIDPair.host`). It holds everything about a connection
that `DIDPair` does not. **Read the source file's comments in full before porting** — they are
longer than the type and record several security decisions.

```kotlin
@Serializable
data class ConnectionMetadata(
    val walletType: WalletType,                       // LOCAL | CLOUD
    val prismDid: String? = null,
    val enterpriseAgentUrl: String? = null,
    val enterpriseAgentApiKey: String? = null,        // → keystore, not this record (07 §7.6)
    val createdAt: Long,
    val updatedAt: Long,

    val establishedWithVcProof: Boolean? = null,      // a PREVIEW was attached — NOT proof
    val vcProofType: String? = null,

    @Deprecated("superseded by capabilities")
    val isCaConnection: Boolean? = null,
    val isCompanyConnection: Boolean? = null,
    val capabilities: List<String>? = null,           // service-access/1.0 keys — the trust anchor

    val supportedTargets: List<AccessTarget>? = null, // discovered from received VCs
    val remotePartyDid: String? = null,

    val identityVerificationStatus: VerificationStatus? = null,  // PENDING | VERIFIED | FAILED
    val identityVerificationError: String? = null,
    val identityVerifiedAt: Long? = null,
    val verifiedCredentialSubject: Map<String, JsonElement>? = null,

    val counterpartyDisplayName: String? = null,      // UNVERIFIED preview label
)
```

Four subtleties that are easy to lose and expensive to rediscover:

1. **`establishedWithVCProof` ≠ verified.** It records only that a pre-connection `vc-proof-0`
   *preview* was attached. `identityVerificationStatus` records whether identity was ever
   cryptographically proven live. Conflating them defeats `liveIdentityVerification.ts` entirely
   (`06-trust-model.md`).

2. **`capabilities` is the trust anchor; `isCAConnection` is the deprecated predecessor.** The old
   flag was derived from matching a **locally-editable display name** — the exact vulnerability the
   `service-access/1.0` work removed. Port `capabilities`; port `isCAConnection` **read-only** for
   migration, and never write it fresh.

3. **`verifiedCredentialSubject` is a point-in-time snapshot with no revocation check.** Noted as
   security-reviewed for display-only use, with the explicit instruction that readers apply a
   staleness cutoff against `identityVerifiedAt` (`connections.tsx`'s `PREVIEW_PHOTO_TTL_MS`).
   **Port the TTL, not just the field.**

4. **`counterpartyDisplayName` exists because `DIDPair.name` means the wrong thing.** `.name` is the
   alias we passed to `acceptInvitation`, which the SDK sends over the wire as **our own**
   self-declared name — so showing it in our own connections list reflects our name back at us. The
   documented display priority, highest first:
   1. a live `vc-proof-sharing` name
   2. `verifiedCredentialSubject` (live-verified)
   3. `counterpartyDisplayName` (unverified preview)
   4. `DIDPair.name`

   `utils/connectionNameResolver.ts` implements this; port it as a pure function with tests.

## 3.7 The prefixed KV store

Port `prefixedStorage.ts` as a small interface over platform preferences (JVM: a file-backed
`Properties`/JSON in the user dir; Android: `DataStore`). Keys observed in use, all under
`wallet-idl-<user>-`:

| Key pattern | Contents |
|---|---|
| `connection-meta-<hostDID>` | §3.6 |
| `invitation-<id>` | invitation state cache (also its own IndexedDB store, §3.8) |
| `presentation-request-<invitationId>` | pending proof request |
| `ephemeral-key-<did>` | ephemeral X25519 material (`07` §7.2) — **keystore, not KV** |
| `security-clearance-keys` | private keys (`07` §7.6) — **keystore, not KV** |
| `ca-connection-prism-did` | PRISM DID used for the CA connection |
| `company-pin` | company TOFU pin (`06`) |
| `config-<credentialId>` | enterprise service configuration per VC |
| `wallet-reload-timestamp`, `wallet-reload-url` | browser-reload plumbing — **do not port** |
| `last-qr-scan-time`, `wallet-log-file-path` | §3.2 |

The CA pin is stored via dedicated helpers rather than a raw key: `pinCA`, `getPinnedCA`,
`isCAVerified`, `verifyPinnedCA`, `clearPinnedCA`, and `hashCredential` — mirrored for companies
(`pinCompany`, …). Port these as a `TofuPinStore` with the same operations (`06-trust-model.md`).

Two items above are marked **keystore, not KV** — moving private key material out of a
plaintext-equivalent store is a deliberate improvement over the current wallet, which keeps
`security-clearance-keys` in `localStorage` where any script on the origin can read it. Flag it as a
behaviour change rather than a silent one.

## 3.8 The four hand-rolled IndexedDB stores

Each is a small object store with a per-user database name. On Kotlin they become **tables in the
same per-user SQLite database** (a separate one from Pluto's, so SDK schema migrations can't collide
with ours): `wallet.db` alongside `pluto.db`.

| TS module | DB name | Purpose | Port note |
|---|---|---|---|
| `connectionRequestQueue.ts` (531) | `connection_requests_<user>` | Queue of inbound connection requests awaiting user action | Keep. Singleton-per-walletId pattern → user scope |
| `rejectionManager.ts` (412) | `message_rejections_<user>` | Records rejected messages so they aren't re-offered | **Also part of the idempotency story** (`04` §4.4) |
| `InvitationStateManager.ts` (750) | `invitation_states_<user>` | Lifecycle state per invitation (seen / previewed / accepted / failed) | Keep. Largest of the four; read before porting |
| `documentStorage.ts` (688) | `classified-documents-store-<user>` | Classified documents, keyed by `ephemeralDID` | Keep (`07` §7.2) |

`clearWalletData.ts` deletes across all of them plus Pluto — port it as one transactional operation
over the user scope, which is far easier than the current version's per-store enumeration.

## 3.9 Phase 0 exit criteria

1. A per-user encrypted `pluto.db` + `wallet.db` open under the OS app-data dir with `0700`/`0600`.
2. A raw-file grep for a known plaintext credential string finds nothing (encryption actually on).
3. Open → induced post-open failure → close → **reopen succeeds** (the DB8 lesson, §3.3).
4. Two users' stores are mutually invisible: write under user A, log out, log in as B, read nothing.
5. All six delete operations from §3.4 execute and leave no orphaned DIDLink/key rows (assert with
   direct SQL).
6. An architecture test proves no module outside `sdkbridge` imports
   `org.hyperledger.identus.walletsdk`.
