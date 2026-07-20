/**
 * serviceAccessGrant.ts — wallet-side parsing and trust-checking for the service-access/1.0
 * protocol (see packages/service-access-didcomm/PROTOCOL.md).
 *
 * Replaces:
 *   - idl-wallet/src/pages/_app.tsx's `GlobalGrantWatcher` inline parsing + the
 *     `getConnectionMetadata(senderHostDID)?.isCAConnection` check (senderHostDID was our OWN
 *     per-connection DID — trusting "which connection" via that key was structurally fine, but
 *     the *value* it looked up, `isCAConnection`, was itself derived from matching a mutable,
 *     locally-editable display name — not from the sender's actual DID identity).
 *   - idl-wallet/src/components/Chat.tsx's independent `getGrantFromMessage`, which had NO trust
 *     check at all (only `isOwnMessage`, which filters self-echo, not authorization).
 *
 * Both call sites now share this one parser + one trust check.
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';
import { getConnectionMetadata } from './connectionMetadata';
import { TRUSTED_SERVICES } from '@/config/serviceTrust';
import { CERTIFICATION_AUTHORITY } from '@/config/certificationAuthority';

export const SERVICE_ACCESS_GRANT_TYPE = 'https://identuslabel.cz/protocols/service-access/1.0/grant';

export interface ServiceAccessGrant {
  id: string;
  thid?: string;
  capability: string;
  label: string;
  icon: string;
  mode: 'redirect' | 'payload';
  expiresAt: number; // ms epoch
  accessUrl?: string; // mode: redirect
  result?: unknown;   // mode: payload
}

/** Parse a service-access/1.0/grant envelope out of a received message's content, or null. */
export function parseServiceAccessGrant(message: SDK.Domain.Message): ServiceAccessGrant | null {
  try {
    const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
    const raw = (body as any)?.content ?? '';
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.type !== SERVICE_ACCESS_GRANT_TYPE) return null;

    const b = parsed.body ?? {};
    if (!b.capability || (b.mode !== 'redirect' && b.mode !== 'payload')) return null;
    if (b.mode === 'redirect' && !b.accessUrl) return null;

    return {
      id: parsed.id || message.id,
      thid: parsed.thid,
      capability: b.capability,
      label: b.label || 'Secure Service',
      icon: b.icon || '🔐',
      mode: b.mode,
      expiresAt: b.expiresAt ? new Date(b.expiresAt).getTime() : Date.now() + 5 * 60 * 1000,
      accessUrl: b.accessUrl,
      result: b.result,
    };
  } catch {
    return null;
  }
}

export interface GrantTrustResult {
  trusted: boolean;
  /** Origins allowed for this sender's `mode: redirect` grants — undefined means "no known safe
   *  origin," which must be treated as untrusted for redirect-mode grants (fail closed). */
  originAllowlist?: string[];
}

/**
 * Determine whether the DID that actually sent this message (not our own per-connection DID) is
 * trusted to grant the capability named in the parsed grant.
 *
 * @param message      the received DIDComm message carrying the grant
 * @param connections  current connection list (app.connections), used to map the sender's DID
 *                      back to our own per-connection metadata key (see connectionMetadata.ts —
 *                      metadata is stored keyed by *our* side of a pairing, `DIDPair.host`)
 * @param capability   the capability key claimed by the grant
 */
export function isTrustedGrantSender(
  message: SDK.Domain.Message,
  connections: SDK.Domain.DIDPair[],
  capability: string
): GrantTrustResult {
  const senderDID = message.from?.toString();
  if (!senderDID) return { trusted: false };

  // Tier 1: deployment-pinned bundled entries (exact DID match).
  const bundled = TRUSTED_SERVICES.find(e => e.did === senderDID);
  if (bundled) {
    return { trusted: bundled.capabilities.includes(capability), originAllowlist: bundled.originAllowlist };
  }

  // Tier 2: per-connection capabilities recorded at connection-establishment time.
  // `connection.receiver` is always the remote party's DID; `connection.host` is our own side,
  // which is the key connectionMetadata.ts stores under.
  const pair = connections.find(c => c.receiver.toString() === senderDID);
  if (!pair) return { trusted: false };

  const meta = getConnectionMetadata(pair.host.toString());
  const capabilities = meta?.capabilities ?? (meta?.isCAConnection ? ['portal', 'login', 'security-clearance'] : []);
  if (!capabilities.includes(capability)) return { trusted: false };

  // Origin scoping: company-admin/cloud-wallet connections record the enterprise agent's own
  // URL at connection time (already used for API calls) — its origin is a real, non-guessed
  // anchor. CA connections don't set enterpriseAgentUrl; fall back to the wallet's own pinned
  // CA config, which is legitimate since THAT pinned URL is what the connection was originally
  // established from in the first place (see CAConnectionEnforcementModal.tsx).
  if (meta?.enterpriseAgentUrl) {
    try { return { trusted: true, originAllowlist: [new URL(meta.enterpriseAgentUrl).origin] }; } catch { /* fall through */ }
  }
  if (capabilities.some(c => ['portal', 'login', 'security-clearance'].includes(c))) {
    try { return { trusted: true, originAllowlist: [new URL(CERTIFICATION_AUTHORITY.baseUrl).origin] }; } catch { /* fall through */ }
  }
  // Company employee-portal capabilities (service-access/1.0 `${slug}-employee-portal` keys —
  // see connectionAccessTargets.ts's companyEmployeePortalCapabilityKey) redirect through
  // company-admin-portal. A personal ('local') wallet connection to a company has no
  // enterpriseAgentUrl recorded (that field is only populated on the `walletType === 'cloud'`
  // branch in OOB.tsx) — without this branch, a `local` wallet's company connection would fall
  // through to the no-safe-origin case below and its (legitimate) redirect grant would always be
  // rejected. company-admin-portal's own accessPath/publicBaseUrl (server.js's
  // COMPANY_PUBLIC_BASE_URL) is a fixed, deployment-pinned origin — same kind of anchor as the CA
  // fallback above, not a per-company guess (the origin is identical regardless of which company
  // the capability belongs to).
  if (capabilities.some(c => c.endsWith('-employee-portal'))) {
    return { trusted: true, originAllowlist: ['https://identuslabel.cz'] };
  }

  // Trusted for the capability itself, but no known safe origin for this connection.
  // `originAllowlist: undefined` means the CALLER must reject a `mode: redirect` grant (nothing
  // to check its accessUrl against) — `mode: payload` grants have no accessUrl to spoof, so
  // trust for those is fully determined by the capability check above.
  return { trusted: true, originAllowlist: undefined };
}
