# `service-access/1.0` — DIDComm protocol specification

## Status

Version `1.0`. Replaces the following ad-hoc, mutually-incompatible protocols that existed prior
to this package: `https://identuslabel.cz/protocols/access-request/1.0/*` (duplicated,
independently, in `certification-authority` and `company-admin-portal`) and
`https://identuslabel.cz/protocols/document-access/1.0/*` (`identus-document-service`).

## Purpose

A generic "prove a Verifiable Presentation → receive a bounded, capability-scoped access grant"
flow, usable by any number of independent services without wallet-side, per-service code. A
service declares one or more **capabilities** (e.g. `portal`, `security-clearance`,
`techcorp-employee-portal`, `document-access`); a holder requests one, proves a VP, and — if the
issuer of the presented credential(s) is trusted for that capability — receives a grant.

## Transport

Carried entirely over the existing, standard DIDComm 2.0 transport:
`https://didcomm.org/basicmessage/2.0/message`. This package does not invent a new transport —
only a documented, versioned JSON envelope convention riding on that standard message type, the
same convention the underlying SDK itself uses for its own non-standardized protocols (e.g.
`revocation-notification` under the `atalaprism.io` namespace).

Piuris are namespaced under `https://identuslabel.cz/protocols/service-access/1.0/` — an
application-specific piuri under an owned domain is the normal DIDComm convention for a protocol
with no corresponding global spec.

## Message shapes

### `.../request` (holder → service)

```json
{
  "type": "https://identuslabel.cz/protocols/service-access/1.0/request",
  "id": "<uuid>",
  "body": { "capability": "<capability-key>", "...": "capability-specific fields, optional" }
}
```

`body` MAY carry additional, capability-specific fields beyond `capability` — e.g. a
`documentDID` a document-access-style capability needs to know which resource is being
requested. These are opaque to the generic protocol layer and passed through verbatim to the
capability's own result-building logic (`requestBody` in `ServiceAccessService`'s capability
descriptor — see its JSDoc).

### `.../grant` (service → holder)

```json
{
  "type": "https://identuslabel.cz/protocols/service-access/1.0/grant",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": {
    "capability": "<capability-key>",
    "label": "Human-readable name",
    "icon": "🔐",
    "mode": "redirect",
    "expiresAt": "<ISO 8601>",
    "accessUrl": "https://service.example/api/access?token=..."
  }
}
```

`mode: "payload"` variant — used when the grant itself is opaque, capability-specific data
(e.g. document decryption key material) rather than a URL to redirect to:

```json
{
  "type": "https://identuslabel.cz/protocols/service-access/1.0/grant",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": {
    "capability": "document-access",
    "label": "Document Access",
    "icon": "📄",
    "mode": "payload",
    "expiresAt": "<ISO 8601>",
    "result": { "...": "capability-defined; opaque to generic consumers" }
  }
}
```

`mode` is a closed enum today but is designed to grow without breaking `1.0` consumers — an
unrecognized `mode` value MUST be ignored (not auto-rendered, not treated as an error) by a
generic consumer.

## Optional alternate transport: HTTP polling

The DIDComm `.../grant` and `.../error` messages above are the primary delivery mechanism. Some
holder-side connections, however, are managed over a channel the holder's own agent process can't
directly observe messages on — for example, an enterprise-agent-managed connection reached only
through that agent's own REST API, rather than through the holder's personal wallet's own
SDK-managed DIDComm inbox. For these cases, a service MAY additionally expose the same grant/error
outcome via HTTP GET, keyed by the original request's `id`, one-time (deleted on read). This is
not a separate protocol or a fallback business path — the same verification, trust-check, and
grant-construction logic produces both the DIDComm message and the HTTP-pollable result; only the
delivery transport differs. `packages/service-access-didcomm`'s `ServiceAccessService.consumeGrant(requestId)`
implements the service side of this.

### `.../error` (service → holder)

```json
{
  "type": "https://identuslabel.cz/protocols/service-access/1.0/error",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": {
    "error": "UNKNOWN_CAPABILITY" | "PROOF_REJECTED" | "PROOF_TIMEOUT" | "UNTRUSTED_ISSUER" | "HOLDER_BINDING_FAILED" | "<other capability-specific code>",
    "message": "human-readable detail"
  }
}
```

| Code | Meaning |
|---|---|
| `UNKNOWN_CAPABILITY` | The request's `capability` doesn't match any of this service's configured capabilities. |
| `PROOF_REJECTED` | The Cloud Agent presentation reached a terminal non-verified state (rejected, abandoned, or its own post-hoc schema/structure check failed). |
| `PROOF_TIMEOUT` | No verified presentation arrived within the polling timeout. |
| `UNTRUSTED_ISSUER` | The presented credential's issuer signature verified, but that issuer is not on this capability's trust registry. |
| `HOLDER_BINDING_FAILED` | Protocol-level (not capability-specific): either the outer VP-JWT's own signature did not verify against its `iss` DID's `authentication` key, or a contained credential's subject DID does not match that `iss` DID. Means the presenter could not be proven to be the credential's rightful holder — e.g. a copied/stolen VC-JWT replayed by a different DID. See "Trust model" below. |
| `CHALLENGE_MISMATCH` / `STALE_REQUEST` | Anti-replay: the presentation's bound nonce didn't match the request's challenge, or the request itself was too old. |

## State machine

Tracked per `thid` (the original request's `id`) on the service side:

```
IDLE ──(request, known capability)──────────────────► PENDING_PROOF
IDLE ──(request, unknown capability)─────────────────► ERROR(UNKNOWN_CAPABILITY)   [terminal]

PENDING_PROOF ──(presentation verified, issuer trusted for capability)──► GRANTED  [terminal]
PENDING_PROOF ──(presentation verified, issuer NOT trusted)─────────────► ERROR(UNTRUSTED_ISSUER) [terminal]
PENDING_PROOF ──(presentation rejected/abandoned)───────────────────────► ERROR(PROOF_REJECTED)   [terminal]
PENDING_PROOF ──(timeout elapsed)───────────────────────────────────────► ERROR(PROOF_TIMEOUT)    [terminal]
```

Exactly one grant or error is sent per request; the service does not retry or re-send.

## Trust model

A grant is only to be trusted by a receiving holder if:

1. The grant's `thid` correlates to a request the holder actually sent, and
2. The **sender's own DID** for the connection (not any locally-chosen display name) is on the
   holder's trust list for the claimed `capability`, and
3. For `mode: "redirect"`, the `accessUrl`'s origin is on that same trust-list entry's allowed
   origin list, and
4. The grant's `expiresAt` has not passed.

Symmetrically, a service must only grant a capability after independently verifying the
presented VC's cryptographic signature against the issuer's resolved DID document and checking
that issuer DID against its own capability-scoped trust registry — Cloud Agent's internal
presentation-verified state is necessary but not sufficient on its own.

**This is now enforced by the shared library itself, not just documented as an expectation.**
`verifyPresentationCredentials` (`lib/verifyPresentation.js`), given the outer VP-JWT the
presenter actually signed, additionally verifies that JWT's own signature against its `iss` DID's
`authentication` key and rejects the presentation (`HOLDER_BINDING_FAILED`) if any contained
credential's subject DID doesn't match that `iss` DID — i.e. it independently proves "the sender's
own DID... is [the credential's rightful holder]", not just that some issuer once signed the
credential for someone. `ServiceAccessService` (this package's `_onProofVerified`) always supplies
the outer VP-JWT and fails closed if it cannot recover one from the underlying transport — there
is no configuration flag anywhere in this package to skip this check once a service is using
`ServiceAccessService`. A holder's own trust decision (points 1–4 above) still cannot be replaced
by anything the service does; it remains the holder's responsibility per its own agent/wallet.

## Non-goals

- This protocol does not cover document/service **mutation** flows (e.g. document upload,
  custody transfer) — only bounded, read-style access grants following a proof.
- This protocol does not attempt to replace DIDComm Discover Features or present-proof `ack` —
  neither is implemented by the vendored SDK in this repo. If/when the SDK gains those, this
  protocol's `request`/`grant`/`error` envelope can be re-examined for consolidation, but that is
  out of scope for `1.0`.
