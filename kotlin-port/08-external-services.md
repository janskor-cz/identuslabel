# 08 — External Services

Covers Phase 5. Everything the wallet does over **HTTP rather than DIDComm**.

`02-architecture.md` §2.7 sets the client structure. This document enumerates the endpoints and — the
harder part — resolves what happens to the wallet's **server half**, which a desktop application does
not have.

## 8.1 The server-half problem

`idl-wallet` is a Next.js app, so it has a server. Five API routes run there, and the wallet's own
browser code calls them on its own origin. **Two of them exist specifically because they hold things
the browser must not have.** Removing the server is therefore not a refactor; it is a security
decision that must be made deliberately.

| Route | What it really does | Desktop consequence |
|---|---|---|
| `POST /wallet/api/logs` | Appends log entries to a server-side file (`fs`) | Trivial — log locally (§8.5) |
| `POST/GET /api/shorten` | In-memory URL shortener for invitation links, paired with `pages/i/[token].tsx` | Needs a decision (§8.6) |
| `POST /api/mediator/register-peer-did` | **Connects directly to the mediator's MongoDB** — `mongodb://admin:admin@127.0.0.1:27017/mediator`, writing `mediator.user.account` | 🔴 Must not port (§8.4) |
| `GET /api/wallet/check` | Reads `data/wallet-registry.json` by `credHash` | Move to Iagon or local state (§8.3) |
| `GET /api/wallet/download`, `POST /api/wallet/upload` | Iagon gateway calls using **`process.env.IAGON_ACCESS_TOKEN`** | 🔴 Secret has nowhere to live (§8.3) |

## 8.2 Cloud Agent REST — `EnterpriseAgentClient`

`utils/EnterpriseAgentClient.ts` (850 lines) wraps the Identus Cloud Agent REST API for the
**enterprise** (8300) and **multitenancy** (8200) agents. Used where the wallet acts on
agent-custodied credentials rather than its own (`07` §7.4).

**Auth header:** `apikey` — **lowercase**, with a source comment noting "Cloud Agent 2.0.0 uses
lowercase `apikey`". Ktor and OkHttp both preserve case as given, but some proxies normalise; assert
the header name in a test.

Endpoints in use:

| Group | Endpoints |
|---|---|
| Connections | `GET/POST /connections`, `GET /connections/{id}` |
| Invitations | `POST /connection-invitations` |
| Credentials | `GET /issue-credentials/records`, `GET /issue-credentials/records/{id}`, `POST /issue-credentials/credential-offers`, `POST /issue-credentials/records/{id}/issue-credential` |
| DIDs | `GET/POST /did-registrar/dids`, `GET /did-registrar/dids/{did}`, `GET /dids/{did}` |
| Proofs | `GET/POST /present-proof/presentations`, `GET/PATCH /present-proof/presentations/{id}` |
| Company admin | `GET /api/employee-portal/connection-names` |

Driven by 19 thunks in `actions/enterpriseAgentActions.ts` (977 lines). Note the polling ones —
`pollPendingProofRequests`, `pollPendingCredentialOffers` — which exist because these connections are
**not** on the wallet's own DIDComm inbox. Convert to Flows (`04` §4.9). `dismissedOfferIds` there is
part of the idempotency story (`04` §4.4).

Configuration comes from a **ServiceConfiguration VC** held in the wallet — `apiKey` and `baseUrl`
are read from `credentialSubject` (see `CLAUDE.md`'s "Enterprise Agent Communication", plus
`utils/serviceConfigManager.ts`, `utils/cloudWalletConfig.ts`, `components/ServiceConfigDisplay.tsx`,
`pages/configuration.tsx`, and the `config-<credentialId>` KV keys in `03` §3.7).

**The API key therefore arrives inside a credential and must go to the keystore, not a plain record**
(`07` §7.6). It currently sits in `ConnectionMetadata.enterpriseAgentApiKey` in `localStorage`.

Other clients: `utils/KeyAuthorityClient.ts` (793), `utils/SecureDashboardBridge.ts` (1185 — the
largest util; read before porting, it bridges the wallet to the secure dashboard).

## 8.3 Iagon backup — where does the token live?

Current flow: the browser encrypts the backup (`07` §7.5), then POSTs the opaque blob to its **own**
`/api/wallet/upload`, which adds `IAGON_ACCESS_TOKEN` from the server environment and forwards to
`https://gw.iagon.com/api/v2`. The registry (`data/wallet-registry.json`, keyed by `credHash`) is also
server-side.

The plaintext backup never leaves the device — that part ports cleanly. **The access token is the
problem.** In a desktop app there is no server, so:

| Option | Assessment |
|---|---|
| **A.** Ship the token in the client | 🔴 Every user gets the deployment's Iagon credentials. Unacceptable. |
| **B.** Per-user Iagon token, entered by the user, kept in the keystore | ✅ Correct if Iagon supports per-user tokens. **Verify.** |
| **C.** Keep a thin server-side relay (the existing routes, deployed standalone) | ✅ Preserves today's trust boundary; adds an always-on dependency for a desktop wallet |
| **D.** Drop Iagon; local encrypted export/import file | ✅ Simplest, loses cross-browser/cross-device restore |

**Recommendation: B if per-user tokens exist, otherwise C.** Both preserve the property that matters —
the deployment's shared secret never reaches a client. **This needs a decision from the operator
before Phase 5**; it is not a judgement the porting agent should make silently. Flag it as an open
question in the phase plan.

Also note `generateCredentialHash` deliberately sends only `SHA-256("user:pass")` and **never the
username** (`07` §7.5) — whatever option is chosen must preserve that.

## 8.4 The mediator MongoDB route — do not port

`pages/api/mediator/register-peer-did.ts` opens
`mongodb://admin:admin@127.0.0.1:27017/mediator?authSource=admin` and writes
`mediator.user.account` directly, to register a peer DID that mediation registration apparently
missed.

Three reasons not to port it:

1. **It bypasses the mediator's own protocol.** Peer DID registration belongs to DIDComm mediation
   (`updateKeyListWithDIDs` / `updateMediatorWithDID`), which the SDK implements.
2. **It requires database credentials and network access to the mediator's Mongo**, which a
   distributed desktop client must never have. It only works today because the Next.js server runs on
   the same host.
3. It is a **workaround for the bug that patch P12 also addresses** (`01`) — mediator registration
   succeeding without the keylist actually being updated. Fix the cause, not the symptom.

**Port instruction:** implement peer DID registration through mediation only. If a DID still fails to
register, that is a Phase 1 bug to diagnose (see the Phase 1 exit criteria in `04` §4.10), not a
reason to reach into the mediator's database.

⚠️ Those Mongo credentials are hardcoded in the source file. Unrelated to the port, but worth
flagging alongside the leaked PAT (`README.md` constraint 8).

## 8.5 Logging

`utils/ConsoleLogger.ts` (354) + `POST /wallet/api/logs` + the `wallet-log-file-path` KV key exist
because a browser cannot write files. On desktop, write directly to a rotating file under the
app-data directory (`03` §3.3) and delete the HTTP hop entirely.

Keep the *practice* of logging protocol decisions — which capability, which DID, trusted or not, why
rejected. `02` §2.8 covers the rules, including the truncation of DIDs in logs.

`components/DebugConsoleSection.tsx` surfaces logs in-app; a desktop equivalent is genuinely useful
for field debugging. Keep it.

## 8.6 URL shortener and deep links

`POST/GET /api/shorten` stores a URL and returns a token; `pages/i/[token].tsx` (20 lines) resolves
`/i/<token>` back to a full invitation URL. It exists so an invitation fits in a QR code.

Two halves, with different answers:

- **Producing** short links needs a server. A desktop wallet that only *consumes* invitations does not
  need this at all — drop it unless the wallet must also generate shareable invitations
  (`components/CAHyperlinkGenerator.tsx` suggests it does). If so, that is another server dependency;
  resolve it with the §8.3 decision.
- **Consuming** `/i/<token>` links must be kept: register an OS deep-link handler (custom URI scheme
  on desktop, App Links / Universal Links on mobile) and resolve the token against whichever service
  hosts the shortener.

The store is **in-memory** in the current route, so tokens do not survive a wallet restart. If short
links are kept, they need real persistence — this is a latent bug in the current implementation, not
just a porting concern.

## 8.7 Other HTTP calls

Collected from `grep fetch(` across `src/`:

| Target | Purpose |
|---|---|
| `${CA}/api/well-known/invitation` | CA invitation — regenerated across restarts, **never pin the invitation itself** (`config/certificationAuthority.ts`) |
| `${DOC_SERVICE}/connect` | Document service connection bootstrap |
| `${DOC_SERVICE}/access-grant-status?requestId=&token=` | HTTP grant transport (`05` §5.1) |
| `${COMPANY_ADMIN}/api/enterprise-portal/grant-status?requestId=` | HTTP grant transport |
| `${COMPANY_ADMIN}/api/documents/issue-docx`, `/api/documents/issue-section-keys` | DOCX issuance + section keys |
| `${COMPANY_ADMIN}/api/document-update/request-edit`, `${API}/document-update/submit` | Document edit flow |
| `${API}/ephemeral-documents/access`, `/access-gate/present`, `/api/access-gate/notify` | Ephemeral document access (`07` §7.2) |
| `${base}/api/document-access/{initiate,status/:id,complete}` | Document access session |
| `${DOC_SERVICE}/upload/{initiate,complete}` | Document upload |
| `${COMPANY_ADMIN}/api/companies` | Company list |

All base URLs must come from `DeploymentConfig` (`02` §2.7). Remember the security caveat there: the
CA base URL doubles as a **trust anchor** for redirect-grant origin checks (`06` §6.3), so it is
operator configuration and must never be derived from a received message.

## 8.8 Client requirements

1. **One Ktor client per concern** (`02` §2.7), each with its own auth strategy. Do not share a
   configured client between the Cloud Agent (`apikey` header) and the app APIs (token in query
   string).
2. **Certificate validation on.** No `trustAll`, not even in debug — these are HTTPS trust anchors for
   the origin allowlist.
3. **Timeouts everywhere**, with the generous ones preserved (`04` §4.9): human-in-the-loop flows are
   minutes, not seconds.
4. **Retry only idempotent GETs.** Never retry a `consumeGrant`-style one-time read (`05` §5.1) — the
   grant is deleted on read, so a retry loses it.
5. **Never log tokens**, including the `token=` query parameter on `access-grant-status`, or
   `accessUrl` in full (it embeds a live access token).
6. `pages/api/wallet/*` and `pages/api/mediator/*` have **no Kotlin equivalent** — resolve via §8.3
   and §8.4 rather than transliterating.

## 8.9 Open questions for the operator

These block Phase 5 and are not the porting agent's call:

1. **Iagon:** per-user tokens (option B) or a standalone relay (option C)? (§8.3)
2. **Short links:** must the Kotlin wallet *generate* invitations, or only consume them? (§8.6)
3. **Backup interop:** must a TS-created backup restore into the Kotlin wallet? Determines whether the
   `07` §7.5 parameters are frozen or can be strengthened.
