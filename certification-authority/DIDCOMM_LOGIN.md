# DIDComm Login — Implementation Description

**Version:** 1.0 — May 2026  
**Status:** Production

---

## 1. Overview

DIDComm Login is a passwordless, credential-gated authentication mechanism. A wallet user gains access to a protected web service by proving ownership of a Verifiable Credential over an encrypted DIDComm channel — without entering a username, password, or following a URL link. The protected page opens automatically inside the wallet's iFrame once the proof is verified.

### Core properties

| Property | Value |
|----------|-------|
| Transport | DIDComm BasicMessage (encrypted, end-to-end) |
| Proof mechanism | Verifiable Presentation — user holds a relevant VC issued by a trusted authority |
| Token lifetime | 5 minutes, single-use |
| Token entropy | 122 bits (cryptographic UUID) |
| Page delivery | Target page opens automatically inside wallet iFrame — no browser navigation required |

### Why DIDComm instead of a login form

Traditional web login sends a secret (password) to a server that verifies it against a stored hash. DIDComm Login sends a **cryptographic proof of identity** instead — the server never receives a secret, only a verifiable claim signed by a trusted issuer. The session token is issued only after the Cloud Agent independently verifies the cryptographic signature on the presentation, and the token is delivered back over the same encrypted channel that initiated the request.

---

## 2. Architecture

### System components

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User's Browser                             │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                        IDL Wallet                            │  │
│  │                                                              │  │
│  │  ┌──────────────────────┐    ┌──────────────────────────┐   │  │
│  │  │  Connections / Chat  │    │   Grant Watcher          │   │  │
│  │  │                      │    │                          │   │  │
│  │  │  🔓 Request Access   │    │   monitors all incoming  │   │  │
│  │  │      button          │    │   messages for grants    │   │  │
│  │  └──────────┬───────────┘    │   → opens iFrame auto   │   │  │
│  │             │                └──────────────────────────┘   │  │
│  │             │ DIDComm BasicMessage (access request)         │  │
│  │             ▼                                               │  │
│  │  ┌──────────────────────┐    ┌──────────────────────────┐  │  │
│  │  │     SDK Agent        │    │   iFrame Modal           │  │  │
│  │  │  (message transport) │    │   (protected page)       │  │  │
│  │  └──────────┬───────────┘    └──────────────────────────┘  │  │
│  └─────────────┼──────────────────────────────────────────────┘  │
└────────────────┼────────────────────────────────────────────────────┘
                 │ encrypted DIDComm
                 ▼
┌─────────────────────────┐    webhook     ┌────────────────────────┐
│      Cloud Agent        │ ─────────────► │    Protected Server    │
│                         │                │                        │
│  verifies VP signatures │ ◄───────────── │  DIDComm Command       │
│  issues proof requests  │  proof request │  Service               │
└─────────────────────────┘                └────────────────────────┘
```

### Prerequisites

Before the login flow can run, two things must exist:

1. **An established DIDComm connection** between the wallet and the server. This is created once via an OOB (Out-of-Band) invitation and persists across sessions.
2. **A valid Verifiable Credential** in the wallet issued by an authority the server trusts. The server specifies which credential type and fields are required per protected target.

---

## 3. Protocol Messages

All messages use **DIDComm BasicMessage** as transport. Custom protocol semantics are carried inside the message body as a JSON envelope. This is necessary because the Cloud Agent only fires server-side webhook events for the BasicMessage protocol type; other protocol URIs are handled internally by the agent and never reach the application layer.

> **Note:** this protocol was migrated to `service-access/1.0` (shared across CA,
> company-admin-portal, and identus-document-service) — see
> `packages/service-access-didcomm/PROTOCOL.md` for the current, authoritative spec. The shapes
> below are kept for historical reference; `target` is now called `capability`, and grants add a
> `mode` field (`"redirect"` for the shape below, or `"payload"` for capabilities whose grant is
> opaque capability-specific data rather than a URL).

### 3.1 Access Request  (Wallet → Server)

The wallet sends a structured JSON envelope identifying the resource the user wants to access.

```
type:  …/protocols/service-access/1.0/request
body:
  capability — named key identifying the protected resource
               (determines which credential proof is required)
```

### 3.2 Access Grant  (Server → Wallet)

After the credential proof is verified, the server sends a grant envelope containing a single-use access URL.

```
type:  …/protocols/service-access/1.0/grant
body:
  capability — the requested capability key
  mode       — "redirect" (this shape) or "payload"
  accessUrl  — one-time HTTPS URL to the protected page
  label      — human-readable name of the resource
  icon       — display icon for the wallet UI
  expiresAt  — ISO timestamp when the token expires
```

### 3.3 Message wrapping

The wallet wraps all outgoing BasicMessage content in a standard envelope that records security level and timestamp. The server unwraps this outer envelope before parsing the protocol message. Incoming grant messages from the server arrive unwrapped (standard BasicMessage body).

---

## 4. Full Data Flow

### 4.1 Sequence diagram

```
 User          Wallet                Cloud Agent       Server
  │               │                       │               │
  │  click        │                       │               │
  │  Request ────►│                       │               │
  │  Access       │                       │               │
  │               │  show status modal    │               │
  │               │  "Requesting          │               │
  │               │   access…"            │               │
  │               │                       │               │
  │               │── BasicMessage ───────►               │
  │               │   {type: request,     │── webhook ───►│
  │               │    target: "…"}       │               │ parse envelope
  │               │                       │               │ resolve sender DID
  │               │                       │               │ → connectionId
  │               │                       │               │
  │               │                       │◄── POST ──────│
  │               │                       │  create proof │ create VP
  │               │                       │  request      │ proof request
  │               │                       │               │
  │               │◄──────────────── RequestPresentation ─│
  │               │                       │               │
  │  proof modal  │                       │               │
  │  appears ────►│                       │               │
  │               │                       │               │
  │  approve ────►│                       │               │
  │               │── Presentation ───────►               │
  │               │   (VP with VC)        │               │
  │               │                       │               │
  │               │              PresentationVerified      │
  │               │                       │ poll ────────►│
  │               │                       │               │ decode VP JWT
  │               │                       │               │ extract claims
  │               │                       │               │ generate UUID token
  │               │                       │               │ store (5 min TTL)
  │               │                       │               │
  │               │                       │◄── POST ──────│
  │               │◄────────────────────── send grant ────│
  │               │  BasicMessage         │               │
  │               │  {type: grant,        │               │
  │               │   accessUrl: "…"}     │               │
  │               │                       │               │
  │               │ Grant Watcher         │               │
  │               │ detects grant         │               │
  │               │ opens iFrame          │               │
  │               │ status modal closes   │               │
  │               │                       │               │
  │  iFrame ─────►│── GET /api/access?token=UUID ─────────────────────────►
  │  opens        │                       │               │ validate token
  │               │                       │               │ mark as used
  │               │                       │               │ register session
  │               │◄──────────────────────────── 302 ─────│
  │               │  /protected-page      │               │
  │               │  ?session=<id>        │               │
  │               │                       │               │
  │  content ────►│── GET /api/content?session=<id> ───────────────────────►
  │  loads        │                       │               │ verify session
  │               │◄── content filtered by clearance level ────────────────│
```

### 4.2 Token redemption

```
  iFrame                          Server  (/api/access)
    │                                  │
    │── GET /api/access?token=UUID ───►│
    │                                  │  1. look up token in store
    │                                  │  2. check not already used
    │                                  │  3. check not expired
    │                                  │  4. mark as used  ← single-use lock
    │                                  │  5. generate session ID
    │                                  │  6. store server-side session
    │                                  │     { authenticated, userData,
    │                                  │       authMethod: 'DIDComm-AccessToken' }
    │◄── 302  /protected?session=id ──│
    │                                  │
    │── GET /api/content?session=id ──►│  verify session → determine clearance
    │◄── content filtered by level ───│
```

---

## 5. UI States

The wallet UI progresses through three states during the login flow.

### State 1 — Idle
Connection row in the Connections tab shows **🔓 Request Access** button with a dropdown listing available protected resources. Chat header shows the same button.

### State 2 — Pending (status modal)

```
┌────────────────────────────────────┐
│  🔓 Requesting Access          ✕  │
│ ─────────────────────────────────  │
│              🔐                    │
│         Protected Resource         │
│                                    │
│  ✅  Request sent                  │
│  ⏳  Waiting for VC proof…         │
│  ○   Identity verified — opening   │
│                                    │
│  A proof request will appear —     │
│  approve it to continue.           │
└────────────────────────────────────┘
```

The modal can be dismissed with ✕ — the request continues in the background and the page will still open when the proof is approved. The proof approval modal (`UnifiedProofRequestModal`) appears on top of this status modal when the server sends its proof request.

### State 3 — Granted (iFrame)

The status modal disappears automatically. The protected page opens full-screen inside the wallet's iFrame modal. No browser tab is opened; the page is contained within the wallet session.

If the user later clicks "Launch in Wallet" from the Browser tab (where timed grants are listed), the same iFrame opens again with the stored access URL.

---

## 6. Security Properties

| Threat | Mitigation |
|--------|-----------|
| Token replay | Token is marked used on first redemption; subsequent attempts receive a 410 error |
| Token theft | 5-minute TTL; token delivered only over encrypted DIDComm, never in browser history or logs |
| Impersonation | Cloud Agent independently verifies cryptographic signature on the VP before `PresentationVerified` is fired |
| MITM on token URL | HTTPS only; the token itself carries no identity — all state is server-side |
| Brute-force | 122-bit UUID token space; no enumeration endpoint exists |
| Proof replay | Each access request issues a fresh proof request ID; the Cloud Agent rejects previously seen presentations |
| Session fixation | Session ID is generated server-side after proof verification; the client cannot influence its value |

---

*May 2026*
