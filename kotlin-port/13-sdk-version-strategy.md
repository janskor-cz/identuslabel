# 13 — The TS SDK Problem, and the v7/v8 Migration

Added after 01–12. This document supersedes `01-sdk-gap-analysis.md` §A.0's framing of the fork as
"a v6.6.0 fork" — the situation is worse than that, and the remedy is different.

All version facts verified 2026-07-30 against npm and `github.com/hyperledger-identus/sdk-ts`.

## 13.1 The problem, stated precisely

Four compounding facts:

**1. The wallet's SDK package is dead.**

```
npm view @hyperledger/identus-edge-agent-sdk
  dist-tags: { latest: "6.6.0" }
  versions:  6.0.0 … 6.6.0        ← nothing after 6.6.0
```

`@hyperledger/identus-edge-agent-sdk` received no release after **6.6.0**. It is not "behind"; it is
**discontinued**.

**2. The SDK was renamed and is now two majors ahead.**

```
npm view @hyperledger/identus-sdk
  dist-tags: { latest: "8.1.0", rc: "8.0.0-rc.10", beta: "7.0.0-rc.14" }
```

`@hyperledger/identus-sdk@8.1.0` was published **2026-07-03** — three weeks before this document.
The wallet is pinned to a discontinued package two major versions behind its live successor.

**3. The repo became a monorepo with split packages.** Release tags now cover
`@hyperledger/identus-sdk`, `identus-domain`, `identus-didcomm`, `identus-jwe`, `identus-anoncreds`,
`identus-protos`, `identus-wasm-config`. Source moved to `packages/lib/sdk/` and
`packages/shared/domain/`.

> ⚠️ **Unverified:** `npm view @hyperledger/identus-domain` and `@hyperledger/identus-didcomm` both
> report **not published**, yet the official 8.x migration guide shows
> `import { DID } from "@hyperledger/identus-domain"`. Either they are published under a different
> name, resolved as subpath exports of `@hyperledger/identus-sdk`, or the guide is ahead of the
> registry. **Resolve this before writing any import statements.**

**4. The fork's source is gone and cannot be rebased.** `package.json` points at
`/root/clean-identus-wallet/sdk-v6-test/sdk-ts`, which no longer exists. The 13 patches survive only
in `idl-wallet/node_modules/.git` — preserved here as `artifacts/sdk-fork.patch`.

### The immediate operational risk

**A `yarn install` in `idl-wallet` today breaks the running wallet.** The `file:` target is missing,
so install either fails or resolves to something without the patches. This is not a porting concern —
it is a live production fragility, and it is the single most urgent item in this spec set.

## 13.2 Which patches does upstream now fix?

The hopeful assumption is that upgrading dissolves the fork. **Verified against v8 source — mostly it
does not.**

| Patch | v8 status | Evidence |
|---|---|---|
| **P1** credential_preview optional | 🔴 **still broken** | `packages/lib/sdk/src/plugins/internal/didcomm/protocols/issueCredential/OfferCredential.ts` still declares `credential_preview: CredentialPreview` (required), still calls `validate()` which throws `InvalidOfferCredentialMessageError`, and `fromMessage` still requires `isObject(msg.body.credential_preview)` |
| **P13** `deleteCredential` | 🔴 **still missing** | v8 `packages/shared/domain/src/buildingBlocks/Pluto.ts` has `deleteMessage(uuid)` and `revokeCredential(credential)` — **no** `deleteCredential`, no `deletePeerDID` |
| **P3** reuse subject DID | 🟢 upstream | `prepareRequestCredentialWithIssuer(did, offer)` takes the DID |
| **P4** Ed25519 presentation signing | 🟡 **likely fixed** | v8 fix #593 "explicitly request authentication or assertion key or will not g…" — verify empirically, do not assume |
| **P5** X25519 key-agreement keys | 🟢 upstream | v8 `createDID('prism', { keys: { MASTER_KEY, KEY_AGREEMENT_KEY … } })` expresses this natively |
| **P6/P7** upsert + conflict tolerance | 🟡 **re-evaluate** | v7 deleted `ConnectionsManager` (304 lines) and `BasicMediatorHandler` (263); the patch sites no longer exist. Whether the new internals are idempotent is **unverified** |
| **P8** attachment filtering | 🟡 unverified | `AttachmentBase64` still exists in v8; the tolerant-parse behaviour needs re-testing |
| **P9** deferred decryption | 🟡 unverified | `PickupRunner` was removed and replaced in v7 |
| **P10** pickup recipient filter | ⚪ moot | Never port anyway (`01` §P10) — `BasicMediatorHandler` is deleted |
| **P11** connection-request label | 🟡 **re-derive** | `HandshakeRequest` moved to `@hyperledger/identus-sdk/plugins/oea`; `safeParseBody` removed |
| **P12** mediator reload + verify | 🟡 unverified | New `StartMediator` standalone function replaces the patched path |
| **P2** piuri aliases | 🟡 partial | v8 fix #536 "support both 'jwt' and 'prism/jwt' credential formats" helps formats, not piuri namespaces |

**Conclusion: upgrading to v8 does not eliminate the fork.** P1 and P13 — the two most load-bearing
patches — are unfixed at v8. But it does shrink it from 13 patches to roughly **2 hard ones plus 5 to
re-verify**, and it moves them from "patch SDK internals" to "wrap at the boundary", because v8's
plugin architecture provides real extension points where v6 did not.

## 13.3 What v7 breaks

From the official guide (`docs/develop/sdk/migration/migrating_6x_to_7x.md`):

| Change | Wallet impact |
|---|---|
| DIDComm → **plugin**; revocation **no longer automatic**, must call `agent.handle(message)` | Message pipeline must route revocation explicitly (`04`) |
| AnonCreds → separate plugin | ⚪ none — unused |
| `ConnectionsManager`, `BasicMediatorHandler`, `PlutoMediatorStore` **deleted**; removed from `Agent.initialize` | 🔴 **12 call sites**: `agent.connectionManager.addConnection` (8×), `…mediationHandler.updateKeyListWithDIDs` (4×) |
| `Pluto.stop()` now **mandatory** | 🟢 wallet already calls `db.stop()` in the DB8 cleanup (`03` §3.3) |
| `HandshakeRequest.safeParseBody` removed | Affects P11 |
| Presentation factory methods removed (`makePresentationFromRequest`, `makeProposalFromRequest`, `makeRequestFromProposal`); `ProofTypes` gone | Verify — wallet uses `fromMessage`, which appears to survive |
| `KeyProperties.type` removed | ⚪ **reverted** — the enum in v8 `packages/shared/domain/src/models/KeyProperties.ts` still has `type`. Wallet's 1 usage is safe |
| `AttachmentDescriptor` **body** must carry `json` | Applies to `body`, **not** `data` — `AttachmentBase64` survives, so the wallet's base64 attachments are fine |
| New `StartFetchingMessages` / `StartMediator` standalone functions | Replaces the P12 patch site |

## 13.4 What v8 breaks

From `docs/develop/sdk/migration/migrating_7x_to_8x.md`:

| Change | Wallet impact |
|---|---|
| **No default export** — `import SDK from` → `import * as SDK from` | 🔴 **48 files** (`grep -c "import SDK from"`) |
| `castor.parseDID` removed → `DID.fromString()` | 2 call sites |
| `createPrismDID`/`createPeerDID` → `createDID('prism'\|'peer', { keys })`, and keys are **private keys, not public** | 🔴 semantic change, not a rename |
| `agent.createNewPeerDID()` / `createNewPrismDID()` → `agent.createDID(...)` | 🔴 **9 + n call sites** |
| `agent.sendMessage` → **`agent.send`** | 🔴 **15 call sites** |
| Seed: hex string → **`Uint8Array`**; `Agent.initialize` takes an **async seed function** | Touches login/seed handling (`03` §3.5, `07` §7.6) |
| `ExtraResolver` removed → `DIDMethodInput[]`; custom PRISM resolver via `new PrismDIDMethod(url)` | 🟢 **improvement** — replaces `ShortFormDIDResolverSample` (`01` §A.3) with a supported extension point |
| Exports moved to subpaths: `/plugins/didcomm` (`CreateOOBOffer`, `DIDCommConnection`, `CredentialFormat`, `RequestCredential`), `/plugins/oea` (`HandshakeRequest`) | Import rewrites throughout |
| `RunProtocol` internal; use `agent.handle(message)` | Aligns with the v7 revocation change |
| Apollo `seed` property: hexString → `Uint8Array` | Key creation sites |

### v8 fixes that retire wallet workarounds

This is the part that makes the upgrade worth doing on its own merits:

| v8 change | Retires |
|---|---|
| `KeyProperties.derivationPath` + #570 "store and retrieve the derivationPath on keys derived from a seed" | `utils/keyDerivation.ts`'s hand-rolled mirror of the SDK's **internal** `PrismDerivationPath` (`07` §7.7) |
| #582 "castor: verify long-form PRISM DID state hash" | Possibly the long-form-PRISM-DID workaround (`01` §A.3) — **verify** |
| #593 "explicitly request authentication or assertion key" | Patch P4's key-purpose problem |
| `new PrismDIDMethod(url)` | `ShortFormDIDResolverSample` (`01` §A.3) |
| `agent.signWith` | `holderProof.ts`'s raw Pluto key extraction (`07` §7.4) |
| `agent.isCredentialRevoked`, `agent.verifiableCredentials` | Parts of `credentialStatus.ts` / `vcValidation.ts` |
| #617 "fix JWT/SDJWT iat/exp claim units to seconds (RFC 7519)", #550/#552 exp/nbf validation | Some of the timestamp normalisation in `04` §4.7 |
| #624 "wire up SD-JWT Key Binding JWT for presentation proofs" | Strengthens SD-JWT holder binding (`06`) |
| #536 "support both 'jwt' and 'prism/jwt' credential formats" | Part of the format aliasing in `04` §4.5 |

## 2026-08 correction — Option B's outcome already exists, via a different route

Everything below §13.5 was written as a forward-looking recommendation. As of 2026-08, it's worth
reading as **history with one correction**, not a plan still to be executed:

**`idl-wallet-v2` already is the "Option B" outcome** — TS migrated 6.6.0 → 8.1.0 — but it was
reached via a **parallel rewrite** (a new wallet stood up alongside the frozen v1), not the in-place
`idl-wallet` migration §13.6/§13.7 describe. Concretely:

- `idl-wallet-v2/package.json` depends on stock `npm:@hyperledger/identus-sdk@8.1.0` — no `file:`
  fork dependency at all.
- The fork shrank from 13 patches to exactly the **2 hard ones this document predicted** (§13.2:
  P1, P13) — and even those are no longer SDK patches in the v1 sense: P1 is a post-install exact-
  string patch over the shipped bundle (`idl-wallet-v2/scripts/patch-sdk.js`), and P13 is an
  app-layer compat shim (`idl-wallet-v2/src/utils/sdkCompat.ts`'s `deleteCredential`), not a modified
  SDK internal.
- §13.6's "rescue the fork" and §13.7's step-by-step 6.6.0→7→8 migration plan **did not need to run**
  — v1 stayed frozen and untouched throughout; v2 was built fresh instead. Both sections are kept
  below as a record of the path *not* taken, in case a future in-place migration of some other wallet
  ever needs the same playbook.
- §13.1's "the fork's source is gone" (item 4) was itself already wrong by the time this was written
  — the tree had moved, not vanished (see `01-sdk-gap-analysis.md`'s A.0 correction) — but it's moot
  either way now that v2 doesn't depend on the fork at all.

**What still stands, unchanged:** §13.2's per-patch v8 status table, §13.3/§13.4's breaking-changes
tables, and §13.8's list of documents 01–12 needing a re-baseline before the Kotlin port begins —
that re-baseline is real, outstanding work (tracked as an issue on `idl-wallet-kotlin`), just against
`idl-wallet-v2` as the live example rather than as a migration still to be planned.

## 13.5 Strategy — three options

The wallet needs (a) off a dead package and (b) optionally ported to Kotlin. These interact.

### Option A — Kotlin port from the v6 baseline, TS wallet frozen

Port to Kotlin per documents 01–12; leave the TS wallet on its patched v6.6.0.

- ✅ No TS migration work; specs 01–12 apply as written
- 🔴 The TS wallet stays on a dead package with a broken `file:` dependency for the whole port
- 🔴 Kotlin `sdk-kmp` v5 is a **generation behind** — its API resembles TS v6, so the Kotlin wallet is
  born legacy
- 🔴 Behaviours are ported from v6 semantics; anything v8 fixed gets faithfully reproduced as a
  workaround

### Option B — Migrate TS to v8 first, then port to Kotlin ✅ **recommended**

1. Repoint the `file:` dependency at a real repo (below), **today**.
2. Migrate the TS wallet 6.6.0 → 7 → 8, following the two official guides.
3. Re-derive the fork: expect ~2 hard patches (P1, P13) plus 5 to re-verify.
4. Then port to Kotlin, from a v8-shaped baseline.

- ✅ Fixes the live fragility first
- ✅ Shrinks the fork from 13 patches to ~2, and moves them to plugin boundaries
- ✅ Retires 8+ wallet workarounds (§13.4) — **less code to port**
- ✅ The Kotlin port then targets v8 semantics, so `sdkbridge` is written against the *current*
  protocol behaviour rather than v6's
- 🔴 Sequential: delays the Kotlin port
- 🔴 Two majors of breaking changes on a 52k-line wallet, with ~48 files needing import rewrites

### Option C — Both in parallel

- ✅ Fastest wall-clock
- 🔴 The Kotlin spec set's baseline moves underneath the port
- 🔴 Two large migrations at once on a live deployment

**Recommendation: B**, with one caveat. The reason is not tidiness — it is that Option A ports v6
workarounds into Kotlin as if they were requirements. `keyDerivation.ts` exists only because the SDK
didn't expose derivation paths; v8 does. `ShortFormDIDResolverSample` exists only because there was no
resolver extension point; v8 has one. Porting those to Kotlin means implementing, testing, and
maintaining code that upstream has already obsoleted.

**Caveat:** `sdk-kmp`'s latest is **v5**, whose API matches TS **v6** (`EdgeAgent`, `createNewPeerDID`,
`BasicMediatorHandler`, `castor.parseDID` — all the things v7/v8 removed). So the Kotlin wallet will
**start on v6-generation semantics regardless**. That does not invalidate B — the TS migration still
retires the fork and de-risks production, and `sdkbridge` is where the generational gap is absorbed —
but it does mean **`02` §2.2's `sdkbridge` boundary now carries a second job**: insulating the wallet
from a Kotlin SDK that is a generation behind the protocol behaviour the services implement.

## 13.6 Immediate action: rescue the fork

Do this **before** any migration or porting work, independent of which option is chosen.

```bash
# 1. Snapshot the patched SDK out of node_modules (do NOT rely on it staying there)
cp -a idl-wallet/node_modules/@hyperledger/identus-edge-agent-sdk /opt/project_identuslabel/vendor/sdk-ts-fork

# 2. Scrub the leaked PAT from the copied git config
cd /opt/project_identuslabel/vendor/sdk-ts-fork
git remote remove fork          # URL contains a live ghp_… token

# 3. Repoint the wallet's dependency at the real path
#    package.json: "@hyperledger/identus-edge-agent-sdk": "file:../vendor/sdk-ts-fork"
```

Then, separately: **revoke the PAT** (`12` §12.5 finding 1). Removing the remote does not invalidate
the token.

Verify the rescue with a clean install in a scratch copy — never in the live tree:

```bash
cp -a idl-wallet /tmp/idl-wallet-installtest && cd /tmp/idl-wallet-installtest
rm -rf node_modules && yarn install && yarn build
```

That build is the real test of whether the fork is recoverable. **Do it before anything else.**

## 13.7 Migration plan for Option B

Preconditions: §13.6 done; the branch is not `master`; a rollback path exists (the wallet runs as a
production build, so keep the current `.next` output).

| Step | Work | Verification |
|---|---|---|
| 0 | §13.6 rescue + clean-install proof | `yarn install && yarn build` in a scratch copy |
| 1 | Resolve the §13.1 package-name question (`identus-domain` published or subpath?) | `npm view`, or read v8's `package.json` `exports` |
| 2 | 6.6.0 → 7.x on a branch. Rebase the fork: drop P10; re-derive P7/P11/P12 against the new internals; keep P1, P13 | `yarn build`, then `tests/` + the CA connect test |
| 3 | Fix the 12 `connectionManager`/`mediationHandler` call sites against `StartMediator`/`StartFetchingMessages` | Connect to the live CA; confirm mediator keylist registration |
| 4 | Wire `agent.handle(message)` for revocation | Revocation notification processes |
| 5 | 7.x → 8.x: mechanical renames — `import * as SDK` (48 files), `send`, `createDID`, `DID.fromString`, subpath imports | `yarn build` clean |
| 6 | Semantic changes: private-keys-not-public in `createDID`; `Uint8Array` seed + async seed function; `PrismDIDMethod` replacing `ShortFormDIDResolverSample` | Issue a credential; verify a presentation |
| 7 | Re-test each retired workaround (§13.4) and **delete** the ones v8 obsoletes | Each removal proven by a passing flow |
| 8 | Re-verify P4, P6/P7, P8, P9, P12 empirically; keep only what still fails | The `11-acceptance-tests.md` suite |
| 9 | Update `01-sdk-gap-analysis.md` to the v8 baseline before the Kotlin port begins | Spec matches reality |

Steps 2–4 are the risky ones (deleted classes, 12 call sites, changed revocation semantics). Steps 5–6
are large but mechanical. **Do not combine them** — a broken build in step 5 is trivially bisected; a
broken build spanning 2–6 is not.

## 13.8 Effect on documents 01–12

If Option B is chosen, revisit before the Kotlin port:

| Doc | Change |
|---|---|
| `01` §A | Patch inventory shrinks to the post-rebase set. **Keep the v6 inventory as history** — it records *why* each behaviour is needed, which survives the version change |
| `01` §B | Re-baseline the mapping table: TS **v8** → Kotlin sdk-kmp v5, and note that Kotlin is a generation behind |
| `02` §2.2 | `sdkbridge` gains the second job named in §13.5's caveat |
| `04` §4.5 | Revocation routing via `agent.handle`; re-check format aliasing against #536 |
| `07` §7.7 | `keyDerivation.ts` likely deleted rather than ported |
| `07` §7.4 | `holderProof.ts` simplifies to `agent.signWith` on both sides |
| `12` §12.5 | Findings 1 and 2 resolved by §13.6 |

If Option A is chosen, 01–12 stand as written — but record explicitly that the Kotlin wallet is being
built against a **discontinued** TS baseline, so nobody later mistakes that for a current design.
