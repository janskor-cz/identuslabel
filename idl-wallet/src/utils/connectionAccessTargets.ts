/**
 * Shared service-access/1.0 target resolution — was independently hand-duplicated in
 * connections.tsx and Chat.tsx (same capability lookup, same CA-name-matching fallback in
 * spirit) until ConnectionCard needed the same logic as a third consumer.
 */
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { getConnectionMetadata, saveConnectionMetadata, updateConnectionMetadata } from '@/utils/connectionMetadata';
import { getAllTrustedIssuers, getTrustedIssuerInfo } from '@/utils/trustRegistry';
import { sendProtocolAccessRequest } from '@/actions';

export interface AccessTarget {
  key: string;
  label: string;
  icon: string;
}

export const CA_TARGETS: AccessTarget[] = [
  { key: 'portal',             label: 'CA Portal',          icon: '🏛️' },
  { key: 'security-clearance', label: 'Security Clearance', icon: '🔐' },
  { key: 'login',              label: 'CA Login',            icon: '🔑' },
];

// Legal-entity suffixes stripped when deriving a company's short slug — generic (not tied to any
// specific company name), so this keeps matching correctly as new companies are onboarded.
const LEGAL_SUFFIX_RE = /\s+(corporation|corp\.?|incorporated|inc\.?|industries|company|co\.?|llc|ltd\.?|gmbh|s\.?a\.?)$/i;

/**
 * Derive the service-access/1.0 capability key a company's own server registers for its employee
 * portal (see company-admin-portal/server.js's `techcorpDIDComm`/`acmeDIDComm` — literally
 * `'techcorp-employee-portal'` / `'acme-employee-portal'`, i.e. `${company.name.toLowerCase()}-employee-portal`
 * with no separators since `company.name` is a single word today). `name` may be either the short
 * form (`companyValidation.ts`'s `ValidatedCompanyConfig.companyName`, e.g. "TechCorp" — what
 * OOB.tsx has on hand at connection-establishment time) or a full legal name carrying a suffix
 * (trustRegistry.ts's `TrustedIssuer.name`, e.g. "TechCorp Corporation" — what the fallback below
 * has on hand for a pre-existing connection); either way this strips any trailing legal-entity
 * suffix and slugifies what remains, so both callers can share one derivation with no drift.
 * Returns null for an empty/unusable name — callers must treat that as "no capability to request."
 */
export function companyEmployeePortalCapabilityKey(name?: string | null): string | null {
  if (!name) return null;
  const shortName = name.replace(LEGAL_SUFFIX_RE, '').trim();
  const slug = shortName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `${slug}-employee-portal` : null;
}

/** Fallback label/icon for a capability key with no explicit CA_TARGETS/supportedTargets entry —
 *  currently only the `${slug}-employee-portal` shape company capabilities use (see
 *  companyEmployeePortalCapabilityKey above). Returns null for anything else so callers keep
 *  falling back to the raw key. */
function defaultLabelIconForCapability(key: string): { label: string; icon: string } | null {
  if (key.endsWith('-employee-portal')) return { label: 'Employee Portal Login', icon: '🏢' };
  return null;
}

export function getTargetsForConnection(conn: SDK.Domain.DIDPair): AccessTarget[] {
  const hostDID = conn.host.toString();
  const meta = getConnectionMetadata(hostDID);

  // Primary: capabilities recorded at connection-establishment time (service-access/1.0).
  if (meta?.capabilities?.length) {
    return meta.capabilities.map(key => {
      const known = CA_TARGETS.find(t => t.key === key);
      const supported = meta.supportedTargets?.find(t => t.key === key);
      const fallback = defaultLabelIconForCapability(key);
      return {
        key,
        label: known?.label ?? supported?.label ?? fallback?.label ?? key,
        icon: known?.icon ?? supported?.icon ?? fallback?.icon ?? '🔗'
      };
    });
  }

  // @deprecated fallback: the old isCAConnection flag, for connections not yet backfilled.
  if (meta?.isCAConnection) return CA_TARGETS;

  // Fallback for connections created before entity-agnostic discovery was added:
  // match any name that mentions the CA (case-insensitive substring match).
  const connName = ((conn as any).name ?? (conn as any).alias ?? '').toLowerCase();
  if (connName.includes('certification authority') || connName.startsWith('ca connection')) {
    const CA_CAPABILITIES = CA_TARGETS.map(t => t.key);
    // Persist so future renders skip the name check
    if (meta) {
      updateConnectionMetadata(hostDID, { isCAConnection: true, capabilities: CA_CAPABILITIES });
    } else {
      saveConnectionMetadata(hostDID, { walletType: 'local', isCAConnection: true, capabilities: CA_CAPABILITIES });
    }
    return CA_TARGETS;
  }

  // Fallback for company connections created before company capabilities were recorded at
  // connection-establishment time (see OOB.tsx) — mirrors the CA fallback above, but derives the
  // match from trustRegistry.ts's existing, already-extensible list of EmployeeRole-trusted
  // organizations (the same registry company-admin-portal's own trust check is keyed against)
  // rather than a company list hardcoded here, so this keeps working automatically as new
  // companies are onboarded (added to trustRegistry.ts) without a wallet code change.
  // (No separate `meta?.isCompanyConnection` shortcut here — every write site sets it together
  // with `capabilities`, which the "Primary" branch above already handles.)
  for (const did of getAllTrustedIssuers()) {
    const info = getTrustedIssuerInfo(did);
    if (!info || info.organizationType !== 'Company' || !info.authorizedCredentialTypes.includes('EmployeeRole')) continue;
    const shortName = info.name.replace(LEGAL_SUFFIX_RE, '').trim().toLowerCase();
    if (!shortName || !connName.includes(shortName)) continue;
    const capKey = companyEmployeePortalCapabilityKey(info.name);
    if (!capKey) continue;
    const target: AccessTarget = { key: capKey, label: 'Employee Portal Login', icon: '🏢' };
    // Persist so future renders skip the name check
    if (meta) {
      updateConnectionMetadata(hostDID, { isCompanyConnection: true, capabilities: [capKey] });
    } else {
      saveConnectionMetadata(hostDID, { walletType: 'local', isCompanyConnection: true, capabilities: [capKey] });
    }
    return [target];
  }

  return meta?.supportedTargets ?? [];
}

/**
 * Sends the service-access/1.0 request and arms the pending-grant indicator. Callers own their
 * own pending/menu UI state (shapes differ slightly between connections.tsx and Chat.tsx) — this
 * only wraps the part that was byte-for-byte identical: target resolution + dispatch + the
 * CAPortalContext `pendingAccessRequest` handoff.
 */
export async function requestConnectionAccess(params: {
  agent: SDK.Agent;
  dispatch: (action: any) => Promise<any>;
  connection: SDK.Domain.DIDPair;
  target: string;
  setPendingAccessRequest: (v: { target: string; label: string; icon: string } | null) => void;
}): Promise<void> {
  const { agent, dispatch, connection, target, setPendingAccessRequest } = params;
  const targetInfo = getTargetsForConnection(connection).find(t => t.key === target);
  setPendingAccessRequest({ target, label: targetInfo?.label ?? target, icon: targetInfo?.icon ?? '🔗' });
  try {
    await dispatch(sendProtocolAccessRequest({ agent, connection, target }));
  } catch (e: any) {
    console.error('[connectionAccessTargets] Access request failed:', e.message);
    setPendingAccessRequest(null);
  }
}
