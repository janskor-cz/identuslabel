# SDK v6.6.0 → v8.1.0 migration notes (idl-wallet-v2)

Working notes for Stage 2. Companion to `kotlin-port/13-sdk-version-strategy.md`.
Status as of 2026-07-30: **v8.1.0 — 0 new type errors, build green, running on :3004.**

The big architectural item — `agent.connectionManager` — is **done**, via `src/utils/sdkCompat.ts`.

## How this migration is being done

**Stock v7, no fork.** v1's 13 SDK patches are *not* being rebased. A third of their patch sites
were deleted outright in v7 (`ConnectionsManager`, `BasicMediatorHandler`, `PlutoMediatorStore`),
and of the rest, P3/P5 are upstream now. Only **P1** (`credential_preview` required) and **P13**
(`Pluto.deleteCredential` missing) genuinely survive — both are wrappable at the boundary. Goal:
ship v2 on a stock npm SDK with zero fork.

**Package alias, so the 48 imports stay untouched at this hop:**

```json
"@hyperledger/identus-edge-agent-sdk": "npm:@hyperledger/identus-sdk@7.0.0"
```

The package was renamed at v7 (`identus-edge-agent-sdk` stops at 6.6.0). Aliasing defers the rename
+ `import * as SDK` sweep to Stage 3 (v8), so this hop's diff contains **only real API breaks**.

## ⚠️ `yarn build` does not catch these

`next.config.js` sets `typescript: { ignoreBuildErrors: true }`. A broken migration still builds.
Use `npx tsc --noEmit`.

**The codebase has ~169 pre-existing type errors on v6**, so "tsc is clean" is not the goal — the
goal is "no *new* errors vs. the v6 baseline". Diff method:

```bash
norm(){ grep -E "error TS" "$1" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sort -u; }
norm baseline.txt > base.txt; norm current.txt > now.txt; comm -13 base.txt now.txt
```

## Symbol relocation map (v6 → v7)

| v6 | v7 | Status |
|---|---|---|
| `SDK.Domain.{AssertionMethod,Authentication,Service,Services,ServiceEndpoint,VerificationMethods}` | `SDK.Domain.DIDDocument.*` | ✅ done (9 sites) |
| `SDK.ProtocolType.Didcommconnection{Request,Response}` | `…DidcommConnection{Request,Response}` (capital C) | ✅ done |
| `SDK.Domain.DIDDocumentCoreProperty` | `SDK.Domain.DIDDocument.CoreProperty` | ✅ done |
| `SDK.Domain.InputField` | `OEA.InputField` via `…/plugins/oea` (public subpath; persists into v8) | ✅ done |
| `SDK.Domain.PresentationExchangeDefinitionRequest` | `OEA.PresentationRequest` — same `presentation_definition` shape | ✅ done |
| `SDK.Domain.AttachmentFormats.{JWT,SDJWT}` | `SDK.Domain.CredentialType.{JWT,SDJWT}` — **byte-identical values** (`"prism/jwt"`, `"vc+sd-jwt"`) | ✅ done |
| `SDK.Domain.KeyUsage` | renamed `PrismDIDKeyUsage`, **not** publicly re-exported → values inlined in `keyDerivation.ts` | ✅ done — ordinals verified identical v6↔v7 |
| `SDK.Domain.KeyProperties.type` | **removed** (curve inferred). Dropped, not relaxed — see the note in `liveIdentityVerification.ts` | ✅ done |
| `SDK.Store` | 🔴 **REMOVED ENTIRELY at v7** — see "The v7 storage gap" below | ⬜ **blocks v7 runtime** |
| `agent.connectionManager.addConnection` | `sdkCompat.storeConnection()` → `pluto.storeDIDPair()` + P7 conflict tolerance | ✅ done (7 sites) |
| `agent.connectionManager.mediationHandler.updateKeyListWithDIDs` | `sdkCompat.updateMediatorKeyList()` → `MediationKeysUpdateList` (`coordinate-mediation/2.0/keylist-update`) from `plugins/didcomm` | ⚠️ done, **needs live verification** |
| `agent.pollux.JWT.{verify,decode}` | `sdkCompat.{jwtVerify,jwtDecode}` → the exported `SDK.JWT` class, identical signatures | ✅ done |
| `agent.pollux.parseCredential` | `SDK.JWTCredential.fromJWS(jws)` — takes the **string**, not bytes | ✅ done (2 sites) |
| `pluto.deleteCredential` | `sdkCompat.deleteCredential()` (patch P13, still absent upstream at v8) | ✅ done (4 sites) |
| `agent.currentDID` | gone | ⬜ 1 file |

## 🔴 The v7 storage gap — why v7 must not be deployed

**`SDK.Store` is gone at v7, at runtime as well as in the types** (`typeof SDK.Store === "undefined"`),
and the SDK's bundled RxDB store implementation was deleted with it — there is no `build/pluto/rxdb/`
directory any more. `Pluto` still takes `(store, keyRestoration)`, but v7 **ships no store to pass**
and has no `Pluto.create()` helper.

So on v7, storage is entirely bring-your-own: the wallet would have to implement `Pluto.Store`
(`start/stop/query/insert/update/delete` over the tables `credentials`, `credential-metadata`,
`didkey-link`, `did-link`, `dids`, `keys`, `messages`) against `@pluto-encrypted/indexdb` itself.

**Do not do that.** v8 closes the gap properly — the v8.0.0 release note "implementing identus
default store" ships a default RIDB-backed store with encryption built in:

```ts
const pluto = await Pluto.create({
  dbName: "identus-wallet-idl2-<user>",
  keyRestoration: apollo,
  startOptions: { password: "…", storageType: /* IndexedDB */ },
});
```

That is a **direct replacement** for v6's `new SDK.Store({name, storage, password})` and preserves
the per-user encrypted storage that `kotlin-port/03-state-and-storage.md` §3.1 treats as a security
property, not a convenience.

**Consequence for the plan:** v7 is a *type-level waypoint only*. Everything else in this document
is real, portable migration work that carries straight into v8 — but v7 itself cannot run the wallet,
so there is no meaningful v7 runtime exit test. Go v6 → v7 (types) → v8 (types + storage), and run
the live exit test **once, on v8**.

## Remaining work (21 errors)

| # | Issue | Files | Approach |
|---|---|---|---|
| 1 | `agent.connectionManager` deleted | `actions/index.ts`, `ConnectionRequest.tsx`, `OOB.tsx` | Biggest item. `addConnection` → `registerDIDPair`-equivalent; `mediationHandler.updateKeyListWithDIDs` → new mediator API. Read v7's `StartMediator` first |
| 2 | `pluto.deleteCredential` (P13) | `actions/index.ts`, `credentials.tsx` | **Wrapper**, not fork: decorate Pluto in a `sdkCompat` module |
| 3 | `agent.pollux` private | `CAConnectionEnforcementModal.tsx`, `OOB.tsx` | Find public equivalent; likely `agent.runTask` or a Pollux-backed Agent method |
| 4 | `AttachmentFormats` removed | `actions/index.ts` (3+) | Replace with the literal format strings; they're wire constants |
| 5 | `InputField` → plugin | `proofRequestFieldMatching.ts`, `UnifiedProofRequestModal.tsx` | Import from `…/plugins/internal/oea/types`, or define locally (it's a structural type) |
| 6 | `PresentationExchangeDefinitionRequest` removed | `proofRequestFieldMatching.ts` | Define the shape locally — see `12-coverage.md` §12.2, this file already documents its own DIF PE limits |
| 7 | `DIDDocumentCoreProperty` → Castor | `actions/index.ts` | Re-point import |
| 8 | `KeyUsage` → `PrismDIDKeyUsage` | `keyDerivation.ts` | ⚠️ **Verify the numeric values are unchanged before touching.** These feed HD derivation paths; a changed ordinal silently re-derives every user's keys. See `kotlin-port/07-crypto.md` §7.7 |
| 9 | `KeyProperties.type` removed | `liveIdentityVerification.ts` | Drop the property (v7 infers curve) |
| 10 | `agent.currentDID` gone | `verify.tsx` | Use the stored self-DID from Redux |
| 11 | `SDK.Store` moved | `actions/index.ts` | Locate new export path |
| 12 | Arg-count changes ×2 | `actions/index.ts` | Read the new signatures |
| 13 | Thunk typing: `.then` / `.unwrap` | `AutoStartAgent.tsx`, `CredentialOfferModal.tsx` | Likely fallout from changed thunk return types; re-check after item 1 |
| 14 | DID type narrowing | `usePhotoDID.ts` | Null-guard before the call |

## Not carried into v2

- **`src/components/Message.tsx` (1348 lines) — deleted.** Orphaned since `messages.tsx` moved to
  `Chat.tsx`; verified no imports. Accounted for 5 of the 37 v7 errors on its own.
- **Fossil import `from "../../../../src/domain"`** in `actions/index.ts` — resolved to
  `/opt/src/domain` (nonexistent). A leftover from when this wallet lived inside `sdk-ts/demos/`;
  survived only because it was a type-only import that TypeScript erases. Now
  `SDK.Domain.PresentationClaims`, matching how the SDK's own `Agent.d.ts` refers to it.

## Rollback

`../idl-wallet-v2-snapshots/v6-working-*.tgz` — `src`, `package.json`, `yarn.lock`,
`next.config.js`, `tsconfig.json` at the last known-good v6 build. (Deliberately excludes
`.env.local`, which holds the Iagon token.)


---

# Stage 3 — v8.1.0 (current)

**v7 was skipped as a runtime target** (see "The v7 storage gap" above). All v7 type work carried
over unchanged; v8 is where the wallet can actually run.

## Verified at v8 runtime

| Symbol | v8 status |
|---|---|
| `SDK.Pluto.create({dbName, keyRestoration, startOptions})` | ✅ present — replaces `new Store()` + `new Pluto()` |
| `SDK.createStore(dbName, options)`, `SDK.StorageType.{InMemory,IndexDB}` | ✅ present |
| `agent.sendMessage` | ✅ **still present** alongside `send` — the 14 call sites did NOT need changing |
| `agent.createNewPeerDID` / `createNewPrismDID` | 🔴 **removed** → `agent.createDID('peer'\|'prism', {keys, services, alias})` |
| default export (`import SDK from`) | 🔴 removed → `import * as SDK from` (**47 files swept**) |
| `OfferCredential`, `BasicMessage`, `IssueCredential`, `MediationKeysUpdateList` | moved to `…/plugins/didcomm` |
| `RequestPresentation`, `Presentation`, `HandshakeRequest`, `OEA.*` | moved to `…/plugins/oea` |
| `@hyperledger/identus-domain`, `-didcomm` | ⚠️ **NOT PUBLISHED to npm** despite the official 8.x guide importing from them. Use the root package + plugin subpaths. |

## Storage migration (done)

```ts
// v6
const store = new SDK.Store({ name: dbName, storage: IndexDB, password });
const db = new SDK.Pluto(store, apollo);
// v8
const db = await SDK.Pluto.create({
  dbName, keyRestoration: apollo,
  startOptions: { password, storageType: SDK.StorageType.IndexDB },
});
```

⚠️ **`storageType` is mandatory in practice.** The default is `InMemory` — omitting it gives every
user an empty, non-persistent wallet that appears to work until reload.

`@pluto-encrypted/indexdb` and `rxdb` are no longer used; both imports removed. `rxdbDexiePrefix()`
was deleted from `walletNamespace.ts` and `restoreFromIagon`'s store-clearing rewritten against the
SDK's own `store.query/delete` API — the old `indexedDB.databases()` prefix scan would have matched
nothing under RIDB and silently failed to clear.

## Fork patches at v8 — final position

| Patch | v8 |
|---|---|
| **P3** holder-DID binding | 🔴 **NOT upstream** (I previously said it was — that was the *Kotlin* SDK). v8's `prepareRequestCredentialWithIssuer(offer)` still takes only the offer. Worked around via the public `RunProtocol` task's `holderDID` arg — `sdkCompat.prepareCredentialRequestForHolder` |
| **P5** X25519 key agreement | ✅ **restored properly** — `createDID('prism', { keys: { MASTER_KEY, KEY_AGREEMENT_KEY: [...] } })` |
| **P13** `deleteCredential` | 🔴 still absent — `sdkCompat.deleteCredential` |
| P1, P2, P4, P6–P12 | see the v7 table above; handled or moot |

## Done at v8

| Change | Detail |
|---|---|
| Import sweep | 47 files, `import SDK from` → `import * as SDK from` |
| Storage | `Pluto.create({dbName, keyRestoration, startOptions:{password, storageType: IndexDB}})` |
| Restore path | rewritten onto `store.query/delete`; `rxdbDexiePrefix` deleted |
| Peer DIDs | 6 sites → `sdkCompat.createPeerDid()` (v8 needs explicit Ed25519 + X25519 keys) |
| **P5 restored** | `agent.createDID('prism', { keys: { MASTER_KEY, AUTHENTICATION_KEY, KEY_AGREEMENT_KEY } })` — the X25519 key is back in the DID document, natively, no fork |
| Seed | `seed: async () => defaultSeed.value` (`SeedFunction = () => Promise<Uint8Array>`) — a wrapper, **not** a re-derivation |
| Resolver | `ShortFormDIDResolverSample` (66 lines) **deleted** → `new PrismDIDMethod(PRISM_RESOLVER_URL)` |
| `castor.parseDID` | 2 sites → `SDK.Domain.DID.fromString` |
| Protocol classes | → `…/plugins/didcomm` (BasicMessage, OfferCredential, IssueCredential, OutOfBandInvitation) and `…/plugins/oea` (RequestPresentation, Presentation) |
| `PresentationClaims` | `SDK.Domain.PresentationClaims` → `SDK.PresentationClaims` (root export at v8) |

Type errors vs the v6 baseline: **37 (v7) → 23 → 9**.

## Remaining (9)

Mostly not SDK-API issues any more:

1. `actions/index.ts` — one namespace/type reference.
2. `AutoStartAgent.tsx` `.then` / `CredentialOfferModal.tsx` `.unwrap` ×2 — Redux thunk typing;
   these need `dispatch(...)` rather than calling the action creator directly. Pre-existing
   pattern, surfaced by stricter v8 generics (`Agent<readonly []>`).
3. `Credential.tsx` — arg count.
4. `usePhotoDID.ts` — null-guard before a `DID` argument.
5. `verify.tsx` — `agent.currentDID` removed; use the stored self-DID from Redux.
6. `KeyProvider.ts` — seed typed `string`, must be `Uint8Array`.

Then: `yarn build` → live exit test (CA connect, credential issue, proof, and the
**keylist-registration verification** `sdkCompat.updateMediatorKeyList` still needs).


---

# Stage 3 result

`yarn build` ✅ · `next start` ✅ on :3004 · **0 new type errors vs the v6 baseline** (total 169 → 166).
v1 untouched on :3002 throughout.

## Two build blockers, and what they actually were

**1. `RunProtocol` is internal at v8** — so the v7 workaround for fork patch **P3** (holder-DID
binding) does not exist here. Not exported from the root, `plugins/didcomm`, or `plugins/oea`;
`RequestCredential` offers only `fromMessage`. `sdkCompat.prepareCredentialRequestForHolder` now
**degrades with a loud warning** rather than throwing, falling back to the SDK's fresh-DID
behaviour. See the ⚠️ below.

**2. The SDK's ESM build crashes Node.** `@hyperledger/identus-sdk@8.1.0` is `"type": "module"`
and its ESM build performs a dynamic `require("crypto")`, which is illegal in ESM. Verified
directly:

```
require('@hyperledger/identus-edge-agent-sdk')  → OK
import('@hyperledger/identus-edge-agent-sdk')   → Dynamic require of "crypto" is not supported
```

Next's server pass hit the ESM path and died at "Collecting page data". Fixed with **two** changes
in `next.config.js` — both are needed:

```js
experimental: { esmExternals: false },   // Next 14 defaults true, which overrides the directive below
webpack: (config, { isServer }) => {     // leave the SDK as require() in the server output
  if (isServer) config.externals.push(({request}, cb) =>
    request?.startsWith('@hyperledger/identus-edge-agent-sdk') ? cb(null, 'commonjs ' + request) : cb());
}
```

This is an **upstream packaging bug** worth reporting: a `"type": "module"` package whose ESM entry
cannot be imported by Node.

## Dead code removed (found while debugging the above)

`src/app/` was a vestigial App Router stub next to the real Pages Router app. `src/app/state.ts`
imported the SDK, `layout.tsx` made Next build the App Router at all — both with **zero** importers.
Removed `state.ts`, `Spacer.tsx`, `layout.tsx`; kept `Box.tsx` (13 importers), `utils.ts`, and the
CSS/assets, which are live.

## ⚠️ Must be verified in the live exit test

Neither type-checking nor the build can prove these:

1. **Mediator keylist registration** (`sdkCompat.updateMediatorKeyList`) — rebuilt at the protocol
   level over `coordinate-mediation/2.0/keylist-update`. Silent failure ⇒ the mediator drops
   inbound messages and the wallet looks connected but receives nothing.
2. **Holder-DID binding (P3)** — request two credentials, then present **both in one VP**. With
   per-credential subject DIDs this can fail `HOLDER_BINDING_FAILED`. Single-credential VPs should
   be unaffected.
3. **Storage** — confirm data actually persists across a reload (`storageType: IndexDB`, not the
   `InMemory` default).
