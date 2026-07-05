/**
 * serviceTrust.ts — wallet-side trust anchors for the service-access/1.0 protocol
 * (see packages/service-access-didcomm/PROTOCOL.md).
 *
 * Two tiers, checked in order by `isTrustedGrantSender` (src/utils/serviceAccessGrant.ts):
 *
 * 1. TRUSTED_SERVICES below — a deployment-pinned, exact-DID allowlist. Appropriate for a
 *    service with ONE fixed, well-known DID (this deployment's CA fetches its invitation from a
 *    pinned HTTPS endpoint, so its DID *could* be pinned here once known — left empty by default
 *    since no wallet source file in this repo has a hardcoded CA/company-admin/document-service
 *    DID to seed it with truthfully; an operator deploying this wallet should populate it).
 *
 * 2. Per-connection `capabilities` recorded in ConnectionMetadata at connection-establishment
 *    time (see connectionMetadata.ts) — the mechanism that actually scales to this deployment's
 *    multi-tenant services (company-admin-portal, identus-document-service), which don't have a
 *    single fixed DID the wallet could pin ahead of time. This tier replaces the old
 *    `isCAConnection` display-name-derived flag with a DID-keyed, capability-scoped one.
 */

export interface TrustedServiceEntry {
  /** The service's own DID for this connection — the actual cryptographic trust anchor. */
  did: string;
  serviceName: string;
  /** Capability keys (service-access/1.0 `body.capability`) this DID may grant. */
  capabilities: string[];
  /** Allowed origin(s) for this DID's `mode: redirect` grants' `accessUrl`. */
  originAllowlist: string[];
}

export const TRUSTED_SERVICES: TrustedServiceEntry[] = [];

/** The Certification Authority's three known capability keys — the CA is currently the one
 *  service in this deployment identified by connection name at establishment time rather than
 *  a fixed pinned DID (see connectionMetadata.ts's `capabilities` field and its write sites in
 *  OOB.tsx / CAConnectionEnforcementModal.tsx / _app.tsx's GlobalCAEnforcer backfill). */
export const CA_CAPABILITIES = ['portal', 'login', 'security-clearance'];
