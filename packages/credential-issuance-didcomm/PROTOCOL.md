# `credential-issuance/1.0` — DIDComm protocol specification

## Status

Version `1.0`. First consumer: `certification-authority`'s RealPerson identity credential —
replacing the need for a staff member to manually retype an applicant's name/DOB/gender into
`public/realperson.html` after learning it over an informal DIDComm chat. The staff-operated form
and its `POST /api/credentials/issue-realperson` endpoint are unaffected — this protocol is an
additional, holder-driven entry point into the same underlying issuance logic, not a replacement.

## Purpose

A generic "service declares which VC schema + fields it needs → holder submits values → service
issues" flow, usable by any issuer service without wallet-side, per-VC-type code. A service
declares one or more **capabilities** (e.g. `realperson`); a holder requests one, receives back
the schema name/version and the exact field list to fill in, submits values, and — if they pass
validation — the service issues a standard Issue-Credential-protocol credential offer.

This is a sibling to `service-access-didcomm`, not an extension of it: that package's own
PROTOCOL.md lists mutation flows (which issuing a brand-new credential is) as a stated non-goal,
and its whole design — VP verification, DID-keyed trust registry, capability *grants* — solves a
different problem ("prove a VP → get bounded access") than this one ("collect data → issue a VC").
This protocol has no VP/proof machinery at all: the holder isn't proving anything yet, they're
supplying the data a not-yet-issued credential will contain.

## Transport

Same choice `service-access/1.0` made and for the same reason: carried entirely over the existing,
standard DIDComm 2.0 transport, `https://didcomm.org/basicmessage/2.0/message`. Native DIDComm
`propose-credential` (Issue Credential v2/v3's holder-initiated entry point, which would otherwise
be the standards-first way to do this) is not implemented by the deployed Cloud Agent — only the
issuer-initiated `offer-credential` beginning is — so a custom application-level envelope is the
only usable path today. If a future Cloud Agent version implements holder-initiated
`propose-credential`, this protocol's `request`/`fields-required`/`data-submit` exchange could be
re-examined for consolidation onto it, but that's out of scope for `1.0`.

Piuris are namespaced under `https://identuslabel.cz/protocols/credential-issuance/1.0/`, mirroring
`service-access/1.0`'s convention of an application-specific piuri under an owned domain.

## Message shapes

### `.../request` (holder → service)

```json
{
  "type": "https://identuslabel.cz/protocols/credential-issuance/1.0/request",
  "id": "<uuid>",
  "body": { "capability": "<capability-key>" }
}
```

### `.../fields-required` (service → holder)

```json
{
  "type": "https://identuslabel.cz/protocols/credential-issuance/1.0/fields-required",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": {
    "capability": "<capability-key>",
    "schemaName": "RealPerson",
    "schemaVersion": "4.0.0",
    "fields": [
      { "key": "firstName", "label": "First name", "type": "string", "required": true },
      { "key": "dateOfBirth", "label": "Date of birth", "type": "date", "required": true }
    ]
  }
}
```

`schemaName`/`schemaVersion` are carried for the holder's own UI (e.g. "You're applying for a
RealPerson v4.0.0 credential") — this library neither reads nor enforces them; they're opaque
pass-through set by the capability descriptor. `fields[].type` is an open, additive set (`string`,
`date` today); a holder-side renderer should fall back to a plain text input for a type it doesn't
recognize rather than erroring, so new field types don't break existing wallet builds.

### `.../data-submit` (holder → service)

```json
{
  "type": "https://identuslabel.cz/protocols/credential-issuance/1.0/data-submit",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": {
    "capability": "<capability-key>",
    "values": { "firstName": "Ada", "lastName": "Lovelace", "gender": "female", "dateOfBirth": "1815-12-10" }
  }
}
```

### `.../error` (service → holder)

```json
{
  "type": "https://identuslabel.cz/protocols/credential-issuance/1.0/error",
  "id": "<uuid>",
  "thid": "<the request's id>",
  "body": { "error": "<code>", "message": "human-readable detail" }
}
```

| Code | Meaning |
|---|---|
| `UNKNOWN_CAPABILITY` | The request's `capability` doesn't match any of this service's configured capabilities. |
| `UNKNOWN_REQUEST` | A `data-submit` arrived whose `thid` doesn't match any pending request (expired or never sent). |
| `DUPLICATE_REQUEST` | A `data-submit` arrived for a request that's already past `awaiting_data` (already submitted). |
| `VALIDATION_FAILED` | A required field was missing, a `date`-typed field wasn't `YYYY-MM-DD`, or the capability's own `validate` rejected the values. |
| `ISSUANCE_FAILED` | The capability's `issue()` threw. |

There is no `.../grant` message and no success envelope of any kind — a successful `data-submit`
is signaled entirely by the native, already-standard Issue-Credential-protocol `offer-credential`
DIDComm message the Cloud Agent sends as a side effect of the capability's `issue()` call. A
generic wallet-side consumer of this protocol needs no new code to observe issuance succeeding;
whatever already renders an incoming credential offer keeps doing so unmodified.

## State machine

Tracked per `thid` (the original `request`'s `id`) on the service side:

```
(none) ──(request, known capability)─────────────► AWAITING_DATA   [fields-required sent]
(none) ──(request, unknown capability)───────────► ERROR(UNKNOWN_CAPABILITY)          [terminal, untracked]

AWAITING_DATA ──(data-submit, generic+capability validation passes)──► ISSUING
AWAITING_DATA ──(data-submit, validation fails)───────────────────────► ERROR(VALIDATION_FAILED)  [terminal]
AWAITING_DATA ──(second data-submit for same thid)────────────────────► ERROR(DUPLICATE_REQUEST)  [terminal, first attempt's outcome unchanged]

ISSUING ──(issue() resolves)───► DONE   [terminal — offer already sent by issue() itself]
ISSUING ──(issue() throws)─────► ERROR(ISSUANCE_FAILED)                              [terminal]
```

Abandoned `AWAITING_DATA` entries (holder never submits) are pruned after 30 minutes; no message
is sent for an abandonment, since there's no request left to reply to.

## Non-goals

- No VP presentation or proof of any kind — this protocol issues on the strength of holder-
  submitted form data alone. Whether that's an appropriate assurance level for a given VC type is
  a decision for the capability's own `issue()`/`validate()` (e.g. gating on other, already-
  verified state), not something this protocol layer enforces or should be trusted to enforce.
- No re-issuance, revocation, or update flows — a capability that needs those keeps its own
  existing out-of-band endpoints (e.g. `certification-authority`'s
  `/api/credentials/update-realperson` for in-place photo updates) untouched.
- Does not replace or extend `service-access/1.0` — see "Purpose" above.
