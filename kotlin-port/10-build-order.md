# 10 — Build Order

Eight phases. Each has an **exit test that must actually run** — not a checklist. Several phases are
sequenced by a dependency that is not obvious from the feature list, noted per phase.

Every phase runs against the **live deployment** (`README.md` → Live deployment reference). There is
no local mock of the Cloud Agent, mediator, CA, or document service, and building one is not worth it:
the interop bugs this port will hit are precisely the ones a mock would hide (`07` §7.10).

## Blocking decisions

Resolve these before the phase that needs them. They are **operator decisions**, not the porting
agent's:

| Decision | Needed by | Where |
|---|---|---|
| Iagon: per-user tokens vs. standalone relay | Phase 5 | `08` §8.3, §8.9 |
| Must the wallet *generate* invitations (short links)? | Phase 5 | `08` §8.6 |
| Must a TS-created backup restore into Kotlin? | Phase 5 | `07` §7.5 |
| Redirect grants: embedded webview vs. system browser | Phase 4 | `09` §9.10 |
| DOCX rendering approach | Phase 5 | `09` §9.10 |

Also resolve the 9 **unverified** SDK items in `01` §B.9 as each phase reaches them. Do not carry an
unverified assumption past the phase that depends on it.

---

## Phase 0 — Foundation

**Deliverables:** Gradle KMP skeleton (`shared` with jvm+android, `desktopApp`); version catalogue
with `sdk-kmp` pinned; Koin graph; `WalletAgent` interface (`02` §2.2); per-user encrypted
`DbConnection`; the six Pluto delete queries; prefixed KV store; `MainLayout` shell.

**Do not create `iosApp/` or `iosMain`** (`02` §2.4).

**Exit test** (`03` §3.9):
1. Per-user encrypted `pluto.db` + `wallet.db` under the OS app-data dir, `0700`/`0600`.
2. Raw-file grep for a known plaintext string finds nothing.
3. Open → induced post-open failure → close → **reopen succeeds** (the DB8 lesson).
4. User A's data invisible to user B.
5. All six deletes run, leaving no orphaned DIDLink/key rows (assert with direct SQL).
6. Architecture test: nothing outside `sdkbridge` imports `org.hyperledger.identus.walletsdk`.

---

## Phase 1 — Agent lifecycle and the message pipeline

**Why before connections:** the idempotency layer must exist *before* real messages arrive. Retrofitting
it means debugging duplicate-processing symptoms instead of building the fix — which is exactly how the
TypeScript wallet acquired five separate ad-hoc guards and a startup repair job (`04` §4.4).

**Deliverables:** seed/mnemonic generation + keystore storage; `EdgeAgent` construction (`01` §B.2);
`start`/`stop`/`startFetchingMessages`; mediator registration **with the P12 verification**; the
new-message delta at the bridge (`04` §4.3); the persistent two-level idempotency layer (`04` §4.4);
piuri normalisation and the alias table (`04` §4.5); tolerant attachment/offer parsing (P1, P8);
deferred-decryption handling (P9); `EnvelopeCodec` (`05` §5.0); timestamp normalisation (`04` §4.7).

**Exit test** (`04` §4.10):
1. Registers with `https://identuslabel.cz/mediator`; `flowState` reports started **with a mediator
   loaded**.
2. Restart 3× against a populated Pluto: zero reprocessed messages, zero duplicate credentials.
3. Replay the same batch 5×, including fresh message ids carrying an already-applied effect — exactly
   one effect applied.
4. A message with an undecodable attachment doesn't block the batch or startup.
5. An undecryptable message doesn't abort pickup, and keylist registration still runs.
6. Both piuri namespaces accepted for all four aliased protocols (unit test).
7. An unknown envelope type is logged and ignored.

---

## Phase 2 — Connections

**Deliverables:** OOB parse/accept (mind the crossed-over Kotlin method names, `01` §B.3);
`detectInvitationFormat` (url/json/base64); invitation preview **clearly labelled unverified**;
CA connection via `GET /ca/api/well-known/invitation`; `ConnectionMetadata` incl. `capabilities`
recording; `connectionNameResolver` 4-level priority; TOFU pinning; connection request queue and
invitation state stores; `GlobalCAEnforcer` + capability backfill; connection deletion.

**Exit test:**
1. Connect to the live CA; the pair appears in `getAllDidPairs()` and survives restart.
2. `ConnectionMetadata.capabilities` is populated from the pinned well-known fetch — **not** from a
   display name.
3. Renaming a connection locally changes **no** trust behaviour (regression test for the vulnerability
   `06` §6.2 removed).
4. Connection displays the counterparty's name, not our own alias (`03` §3.6 item 4).
5. Re-accepting the same invitation does not create a duplicate pair (P6/P7).
6. Delete removes the pair, its DIDLinks, and its messages, with no orphans.
7. TOFU: a second connection from a *different* CA DID surfaces a warning, not a silent re-pin.

---

## Phase 3 — Credentials and presentations

**Deliverables:** offer → request → issue for JWT and SD-JWT, with the holder DID passed explicitly
(P3); curve policy (P4); credential type detection and per-type layouts; presentation
request/response via `UnifiedProofRequestModal`; selective disclosure; issuer trust checks (`06` §6.4);
revocation display; credential deletion.

**Exit test:**
1. Receive a `RealPersonIdentity` VC from the live CA and store it; it survives restart exactly once.
2. Satisfy a live proof request from that VC; the Cloud Agent reports the presentation **verified**
   (this is the real test of the P4 curve policy).
3. All credentials bind to **one** holder DID, not one per offer (P3).
4. An offer with **no** `credential_preview` is handled (P1) — the defect is present in Kotlin.
5. An `atalaprism.io`-namespaced `issue-credential` is accepted (P2).
6. A credential from an untrusted issuer is rejected.
7. SD-JWT selective disclosure discloses only the named claims.
8. `validateSecurityClearanceVC` rejects on any of the three conditions failing (`06` §6.4).

---

## Phase 4 — service-access/1.0 and trust

**Deliverables:** the full protocol (`05` §5.1); the two-tier DID-keyed trust check and fail-closed
origin allowlist (`06` §6.2–6.3); `GlobalGrantWatcher`; `AccessRequestStatusModal`; portal rendering
per the `09` §9.10 decision; error handling; live identity verification (`06` §6.5) incl.
authentication-scoped signature verification, multibase decoding, and the bait-and-switch and
type-confusion anchors.

**Exit test** — all 10 criteria in `06` §6.8. The negative cases (3, 4, 5, 8) matter more than the
happy path; each corresponds to a real vulnerability that was fixed.

---

## Phase 5 — Full parity

The largest phase. Split it into independently shippable slices, in this order:

| Slice | Contents | Gate |
|---|---|---|
| 5a | Enterprise agent REST + polling → Flows; ServiceConfiguration VCs; API keys to keystore | — |
| 5b | Employee portal login incl. HTTP grant transport (`05` §5.1) | 5a |
| 5c | NaCl chat encryption + the automatic VC handshake (`07` §7.1, `04` §4.8) | — |
| 5d | Security key lifecycle + key↔VC binding (`07` §7.3, §7.6) | 5c |
| 5e | Document access: ephemeral PFS, holder PoP, section keys, redaction rendering | `09` §9.10 DOCX decision |
| 5f | Document upload / branch / edit (`05` §5.3) | 5e |
| 5g | Iagon backup/restore + multi-user login | `08` §8.3 decision |

**Exit test:** the full suite in `11-acceptance-tests.md`, plus the 7 crypto interop tests in
`07` §7.10. Interop, not self-consistency — a symmetric-but-wrong crypto implementation passes a
self-test and fails in production.

---

## Phase 6 — Android

**Deliverables:** `androidApp`; `androidMain` actuals (SQLCipher, Android Keystore, ML Kit QR,
WebView); Compose adaptation for small screens; `PlutoImpl.start(context)` with a real `Context`.

**Why after desktop:** proves the KMP split with the SDK held constant, so any breakage is the
platform layer rather than the bridge. Doing Android and iOS together would confound two variables.

**Exit test:** the entire Phase 0–5 acceptance suite passes on a physical Android device — including
key material in the Android Keystore, not shared preferences.

---

## Phase 7 — iOS (blocked)

Blocked at the SDK layer: `sdk-kmp` publishes no iOS artifact (`01` §B.1, `02` §2.4). The approach is
a `sdk-swift`-backed `WalletAgent` implementation, sharing `domain`, `protocols`, `trust`, and `state`.

**Prerequisites:** `WalletAgent` stable against two real UIs (Phases 5–6 complete); a conformance test
suite over `WalletAgent` that both implementations pass; iOS actuals for `crypto` and `store`.

**Do not begin before Phase 6 completes.** Attempting iOS earlier means designing the bridge against
one consumer and discovering its leaks later.

---

## Effort shape

Not calendar estimates — relative weight, to inform sequencing:

| Phase | Weight | Dominated by |
|---|---|---|
| 0 | M | encrypted per-user storage; the delete queries |
| 1 | **L** | the idempotency layer and the fork-patch reimplementations |
| 2 | L | `OOB.tsx`'s 2628 lines of establishment logic |
| 3 | M | curve policy verification; type detection |
| 4 | **L** | live identity verification (`06` §6.5) is intricate and security-critical |
| 5 | **XL** | seven slices; documents alone are ~5k lines of TS |
| 6 | M | platform actuals |
| 7 | XL | a second SDK implementation |

Phases 1 and 4 are the ones most likely to be underestimated: both look small in feature terms and are
mostly invisible correctness work.

## Standing rules

1. **Never fork `sdk-kmp`.** Reimplement patch behaviours in `sdkbridge` (`02` §2.2). The TypeScript
   fork's source path was lost and its patches survived only by accident.
2. **Resolve unverified items in the phase that needs them** (`01` §B.9), and update that section.
3. **Port the comments that explain *why*.** The most valuable content in the TypeScript source is the
   rejected-design records (`06` §6.1, `01` §P10, `04` §4.8). Losing them means retrying them.
4. **Fail closed.** When a trust decision is ambiguous, deny. Expect one or two "correct but unusable"
   bugs in Phase 4 (`06` §6.3) and fix them by adding a *justified* anchor, never by loosening the
   default.
5. **Every phase's exit test runs against the live deployment**, and stays in CI as a regression suite.
