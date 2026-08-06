# 11 — Acceptance Tests

Definition of done. Every scenario runs against the **live deployment**, with concrete steps and pass
criteria.

Two categories, and the distinction is the point:

- **Functional (F)** — the feature works.
- **Security (S)** — the feature **refuses** to work when it should. Each S-test corresponds to a
  vulnerability that was actually fixed in this deployment, or a fail-closed default that exists on
  purpose. **An S-test that "passes" because the feature is broken in some other way is a failure.**
  Always confirm the corresponding F-test passes first.

Reference: `README.md` → Live deployment reference. Prerequisites: two test user profiles; a
`RealPersonIdentity` VC issuable by the CA; a `SecurityClearanceGrant` at level ≥ 2; access to a
company (TechCorp or ACME) for enterprise scenarios.

---

## A. Storage and lifecycle

**F-A1 — Per-user encrypted storage.** Log in as user A, receive a credential, log out, log in as B.
✅ B sees no credential; `pluto.db` files are separate; grepping either raw file for the credential's
subject name finds nothing.

**F-A2 — Restart idempotency.** With ≥ 5 credentials, ≥ 3 connections, ≥ 20 messages, restart 3×.
✅ Counts unchanged each time; no duplicate rows; no modal reopens.

**S-A3 — Recovery from a failed DB open.** Induce a failure after the driver opens (e.g. corrupt the
schema-version row), then reopen. ✅ Second attempt succeeds — no permanent stuck state (`03` §3.3).

**S-A4 — Secrets are not in plaintext storage.** Grep the app-data directory for the seed mnemonic,
any clearance private key, and any enterprise API key. ✅ No hits outside the keystore (`07` §7.6).

---

## B. Agent and messaging

**F-B1 — Mediator registration.** Fresh profile, start the agent. ✅ Registers with
`https://identuslabel.cz/mediator`; a mediator is loaded (not just "started"); a peer DID appears in
the mediator keylist (P12).

**F-B2 — Message replay tolerance.** Feed the same batch 5×, then again with fresh message ids
carrying an already-applied effect. ✅ Exactly one credential stored, one modal shown, one reply sent
(`04` §4.4).

**S-B3 — Corrupt attachment isolation.** Inject a message with an unsupported attachment shape into
Pluto, restart. ✅ Wallet starts; other messages process; the bad one is logged and skipped (P8).

**S-B4 — Undecryptable message isolation.** Deliver a message encrypted to an unknown key. ✅ The
batch's other messages process; keylist registration still runs; wallet does not report a fatal error
(P9).

**F-B5 — Piuri aliases.** Receive `issue-credential` and `request-presentation` in **both**
`didcomm.org` and `didcomm.atalaprism.io` forms. ✅ All four handled identically (P2, `04` §4.5).

---

## C. Connections

**F-C1 — CA connection.** Fetch `GET /ca/api/well-known/invitation`, accept. ✅ Pair in
`getAllDidPairs()`; `capabilities` contains `portal` and `security-clearance`; survives restart.

**F-C2 — Counterparty naming.** ✅ The CA connection displays the CA's name, not our own alias
(`03` §3.6 item 4).

**S-C3 — Rename confers no trust.** Rename an arbitrary connection to "Certification Authority", then
have it send a grant. ✅ Grant **rejected**. *This is the exact vulnerability `service-access/1.0`
removed — the single most important test in this document.*

**S-C4 — Duplicate invitation.** Accept the same invitation twice. ✅ One pair, no error, connection
event still emitted (P6/P7).

**F-C5 — Deletion.** Delete a connection. ✅ Pair, DIDLinks, and messages gone; no orphaned rows
(assert with direct SQL).

**S-C6 — TOFU change detection.** Present a connection claiming to be the CA with a **different** DID
than the pinned one. ✅ Security warning; no silent re-pin (`06` §6.6).

**F-C7 — Preview is labelled unverified.** Accept an invitation carrying a `vc-proof-0` attachment.
✅ Preview shows the identity **explicitly marked unverified**; connection establishes anyway
(`06` §6.1).

---

## D. Credentials and presentations

**F-D1 — JWT issuance.** Request a `RealPersonIdentity` VC from the CA. ✅ Stored once; renders with
its type-specific layout.

**F-D2 — Holder DID reuse.** Obtain two credentials. ✅ Both bind to the **same** holder DID (P3).

**F-D3 — Presentation accepted by the Cloud Agent.** Satisfy a live proof request. ✅ Cloud Agent
reports **verified** — the real test of the P4 curve policy.

**F-D4 — Offer without preview.** Trigger an offer whose body omits `credential_preview`. ✅ Handled;
user sees the offer (P1 — **present in Kotlin**, so this will fail before it's fixed).

**F-D5 — SD-JWT selective disclosure.** Present an SD-JWT disclosing 2 of 5 claims. ✅ Verifier sees
exactly those 2.

**S-D6 — Untrusted issuer.** Present a validly-signed VC from a DID not on the registry. ✅ Rejected
(`06` §6.4).

**S-D7 — Clearance VC conjunction.** For each of the three conditions in `validateSecurityClearanceVC`
(schema, issuer, `clearanceLevel` present), present a VC failing **only** that one. ✅ All three
rejected.

**F-D8 — Deletion.** Delete a credential. ✅ Gone from Pluto and UI; its private keys **retained**
(`03` §3.4 hazard 2).

---

## E. service-access/1.0 and trust

**F-E1 — Happy path.** Request `security-clearance` from the CA; approve the proof. ✅ Grant received;
portal opens; content renders.

**F-E2 — Error surfacing.** Request a capability that will fail (e.g. present an untrusted issuer's
VC). ✅ `UNTRUSTED_ISSUER` shown in the status modal — **not** an indefinite spinner. *This is why
error handling was added.*

**S-E3 — Capability scope.** Have a trusted CA connection send a grant for a capability **not** in its
`capabilities`. ✅ Rejected.

**S-E4 — Spoofed sender.** Send a well-formed grant from a DID that is not the connection's
`receiver`. ✅ Rejected (`06` §6.2).

**S-E5 — Origin allowlist.** Grant with `mode: redirect` and an `accessUrl` on an unlisted origin.
✅ Rejected, portal does not open.

**S-E6 — No safe origin (fail closed).** Grant with `mode: redirect` from a sender whose metadata has
no `enterpriseAgentUrl` and no CA/employee-portal capability. ✅ Rejected (`06` §6.3 case 4).

**S-E7 — Expiry.** Grant with `expiresAt` in the past. ✅ Rejected regardless of trust.

**S-E8 — Unknown mode.** Grant with `mode: "future-mode"`. ✅ Ignored — not rendered, **not** an error
(`05` §5.1).

**F-E9 — Payload mode.** `document-access` grant with `mode: payload`. ✅ `body.result` consumed; no
redirect attempted.

**S-E10 — Single grant per request.** Confirm the wallet does not re-request on timeout with the same
id. ✅ A retry uses a **new** request id (`05` §5.1).

---

## F. Live identity verification

**F-F1 — Happy path.** Connect to a peer with a `RealPersonIdentity` preview; peer approves the live
proof request. ✅ `identityVerificationStatus == verified`; `verifiedCredentialSubject` populated from
the **live** credential.

**S-F2 — Bait and switch.** Peer previews person X's VC, then live-proves a **different** subject DID.
✅ Rejected (`06` §6.5 check 3).

**S-F3 — Type confusion.** Preview claims `RealPersonIdentity`; live VC is a validly-signed
`SecurityClearance`. ✅ Rejected (check 4).

**S-F4 — Authentication scoping.** Live presentation signed with a key that is in the DID document but
**not** under `authentication`. ✅ Rejected (check 1). *This is the gap over what the SDK's own
`handlePresentation` covers.*

**S-F5 — Unknown type fails closed.** Preview claims a type outside
`LiveVerifiableCredentialType`. ✅ Rejected, not passed through.

**F-F6 — Soft failure.** Peer never responds (timeout). ✅ Connection stays established and
**unverified**; not torn down; UI shows unverified (`06` §6.1).

**F-F7 — Staleness.** With a `verifiedCredentialSubject` older than the TTL. ✅ UI treats it as stale
rather than currently-verified (`03` §3.6 item 3).

---

## G. Enterprise and employee portal

**F-G1 — Service configuration.** Hold a ServiceConfiguration VC. ✅ `baseUrl`/`apiKey` read from it;
health check against the enterprise agent succeeds; the key is in the keystore, not a plain record.

**F-G2 — Enterprise credential offer.** Receive an offer on an enterprise-agent-managed connection.
✅ Appears once; accepting stores it.

**F-G3 — Employee portal login.** Complete the flow end-to-end. ✅ Grant arrives via the HTTP
transport; the correct page is reached per the presented VCs — no CISTraining → training page; with
CISTraining → dashboard; with SecurityClearanceGrant → clearance access.

**S-G4 — VC selection is authoritative.** Present only an `EmployeeRole` (withhold CISTraining), for an
employee who *does* have CISTraining on the server. ✅ Routed to the **training** page — no server-side
fallback lookup (per `CLAUDE.md`: "the employee's VC selection is the authority").

**F-G5 — PRISM DID form tolerance.** With short-form in the DB and long-form in the JWT `sub`.
✅ Matching succeeds on the hash segment (`06` §6.5).

**S-G6 — One-time HTTP grant.** Poll `grant-status` twice for the same request id. ✅ Second returns
nothing; the wallet does not retry into a lost grant (`08` §8.8 rule 4).

---

## H. Documents

**F-H1 — Browse.** ✅ Documents at or below the user's clearance are listed; above are not.

**F-H2 — Access with PFS.** Access a document. ✅ Renders; the ephemeral private key is zeroed after
decryption (assert via a test hook, not by inspection).

**F-H3 — Redaction.** Access a document containing sections above the user's level. ✅ Those sections
are absent from the delivered content — **not** present-but-hidden. Verify against the raw payload.

**F-H4 — Enterprise credential (no holder PoP).** Access using an `EmployeeRole` VC whose subject key
the wallet does not hold. ✅ Holder PoP returns null; a bearer VP is presented; access **succeeds**
(`07` §7.4). *A port that throws here breaks all enterprise document access.*

**F-H5 — Upload.** Upload a document with clearance and releasability. ✅ Appears in My Documents;
retrievable.

**F-H6 — Branch.** Branch an existing document. ✅ `parentDocumentDID` recorded; omitted clearance
inherits from the parent.

**S-H7 — Size limit.** Upload a file large enough to exceed the mediator's message limit. ✅ A clear
user-facing error, not a silent failure or a hang (`05` §5.3 — the current wallet has **no** cap, so
this is a new requirement).

---

## I. Encrypted messaging

**F-I1 — Handshake and encrypt.** Send an encrypted message to a peer holding a clearance VC.
✅ Handshake obtains the peer's VC; message encrypts and decrypts; badge shows the classification.

**S-I2 — Sender key binding.** Deliver a message whose `senderPublicKey` is a self-generated key not
bound to the sender's clearance VC. ✅ Rejected or clearly flagged as unauthenticated — **not**
displayed as a normal decrypted message (`07` §7.1).

**S-I3 — Clearance gating.** Receive a message classified above the user's level. ✅ Not decryptable —
verify cryptographically, not via the `canDecrypt` UI gate (`06` §6.7).

**S-I4 — Nonce uniqueness.** Send 1000 encrypted messages. ✅ 1000 distinct nonces.

**F-I5 — Interop.** Kotlin → TS wallet and TS → Kotlin both decrypt (`07` §7.10 test 1).

---

## J. Backup and multi-user

Gated on the `08` §8.3 decision.

**F-J1 — Backup round trip.** Back up, wipe local storage, restore. ✅ Credentials, connections, and
DIDs return; the agent starts.

**S-J2 — Plaintext never leaves the device.** Capture traffic during backup. ✅ Only the opaque
encrypted envelope is transmitted; no credential content, and **no username** (`07` §7.5).

**S-J3 — Wrong password.** Restore with an incorrect password. ✅ Fails cleanly; no partial state
written.

**F-J4 — Multi-user login.** Two profiles on one install, used alternately. ✅ Full isolation
(re-verifies F-A1 through the real login flow).

**S-J5 — No shared Iagon secret in the client.** Inspect the shipped artifact. ✅ No deployment-wide
Iagon access token present (`08` §8.3).

---

## K. Cross-cutting

**S-K1 — No SDK leakage.** Architecture test. ✅ Nothing outside `sdkbridge` imports
`org.hyperledger.identus.walletsdk`.

**S-K2 — No secrets in logs.** Exercise every flow with logging at max verbosity, then grep the log for
the seed, private keys, API keys, `token=` values, and full `accessUrl`s. ✅ No hits; DIDs truncated.

**S-K3 — TLS validation on.** Attempt a connection through an intercepting proxy with an untrusted
certificate. ✅ Refused (`08` §8.8 rule 2).

**F-K4 — Protocol test vectors.** Run the ported vectors from
`packages/service-access-didcomm/test/`. ✅ All pass (`05` §5.5 rule 6).

**F-K5 — Crypto interop.** All 7 tests in `07` §7.10. ✅ All pass.

---

## Coverage map

| Area | F | S |
|---|---|---|
| Storage / lifecycle | A1, A2 | A3, A4 |
| Agent / messaging | B1, B2, B5 | B3, B4 |
| Connections | C1, C2, C5, C7 | **C3**, C4, C6 |
| Credentials | D1–D5, D8 | D6, D7 |
| service-access + trust | E1, E2, E9 | E3–E8, E10 |
| Live verification | F1, F6, F7 | **F2**, **F3**, **F4**, F5 |
| Enterprise | G1, G2, G3, G5 | G4, G6 |
| Documents | H1–H6 | H7 |
| Encrypted messaging | I1, I5 | I2, I3, I4 |
| Backup / multi-user | J1, J4 | J2, J3, J5 |
| Cross-cutting | K4, K5 | K1, K2, K3 |

**Bolded tests are the ones that map to real, previously-exploitable weaknesses**: C3 (display-name
trust), F2 (bait-and-switch), F3 (type confusion), F4 (authentication scoping). If time forces
triage, these are the last to cut.

Automate every test that can be automated, and keep the whole suite in CI as a regression gate — the
bug classes in `04` §4.4 and `06` §6.1 are all regressions that recurred once already.
