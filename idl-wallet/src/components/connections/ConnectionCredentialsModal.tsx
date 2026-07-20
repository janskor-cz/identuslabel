/**
 * ConnectionCredentialsModal — dedicated view for "which VCs did this connection issue to me,"
 * replacing the credentials list that used to be buried inside ConnectionDetailsModal. Reuses
 * the same connection→credential match (getCredentialsForConnection, passed in by the caller)
 * so there's exactly one matching implementation (see connectionCredentialMatcher.ts's header
 * comment on why credential.subject can't be used for this).
 *
 * This wallet is holder-only (never issues VCs to anyone, and doesn't track VPs it has sent to a
 * connection — see connections.tsx/credentials.tsx history), so there is only ever a "Received"
 * side to show here. The optional `verifiedCredential` section above it is NOT a credential this
 * wallet holds — it's the connected party's own identity, proven live via challenge/response (see
 * utils/liveIdentityVerification.ts) but never issued to or stored by this wallet as a VC (see
 * ConnectionMetadata.verifiedCredentialSubject's doc comment). It IS, however, rendered through
 * the exact same type-specific layout (getCredentialLayout) a real held credential's expanded
 * view uses — the full VC-shaped credentialSubject actually was exchanged live, so there's no
 * reason to hand-rewrite a second, poorer display for it — kept visually distinct from the
 * "Received VC" list below only via its own bordered section/caption, not a different renderer.
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { CredentialCard } from '@/components/CredentialCard';
import { getCredentialLayout } from '@/components/CredentialCardTypeLayouts';
import { verifyCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';

interface ConnectionCredentialsModalProps {
  displayName: string;
  receiverDID: string;
  credentials: SDK.Domain.Credential[];
  // Live-verified (never issued/stored) identity of the connected party, in the same
  // { credentialSubject } shape a real held credential has — see this file's header comment and
  // ConnectionMetadata.verifiedCredentialSubject. Caller (connections.tsx) already applies the
  // 90-day freshness gate before passing this, so its mere presence here means "show it."
  verifiedCredential?: { credentialSubject: Record<string, any> };
  onClose: () => void;
}

export function ConnectionCredentialsModal({ displayName, receiverDID, credentials, verifiedCredential, onClose }: ConnectionCredentialsModalProps) {
  const router = useRouter();
  const [statusMap, setStatusMap] = useState<Map<string, CredentialStatus>>(new Map());

  useEffect(() => {
    let cancelled = false;
    Promise.all(credentials.map(async (credential) => {
      try {
        const status = await verifyCredentialStatus(credential);
        return [credential.id, status] as const;
      } catch {
        return null;
      }
    })).then(results => {
      if (cancelled) return;
      const next = new Map<string, CredentialStatus>();
      for (const entry of results) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setStatusMap(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const viewInCredentials = () => {
    onClose();
    router.push(`/credentials?connection=${encodeURIComponent(receiverDID)}`);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">Received Credentials</h2>
            <p className="text-slate-400 text-sm mt-1 truncate">{displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white hover:bg-slate-800/50 rounded-lg p-2 transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3">
          {verifiedCredential && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">
                Verified Identity
              </p>
              {getCredentialLayout(verifiedCredential)}
              <p className="text-xs text-slate-500 mt-2">
                Proven live by this connection via cryptographic challenge/response — this wallet is
                holder-only, so it is the connected party&apos;s own verified identity, not a credential
                held by you.
              </p>
            </div>
          )}

          <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
            Received VC ({credentials.length})
          </p>

          {credentials.length === 0 ? (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 text-sm text-slate-400">
              No credentials received from this connection yet.
            </div>
          ) : (
            <div className="space-y-2">
              {credentials.map((credential, idx) => (
                <CredentialCard key={credential.id ?? idx} credential={credential} status={statusMap.get(credential.id)} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-700/50">
          <button
            onClick={viewInCredentials}
            className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            View in Credentials page →
          </button>
        </div>
      </div>
    </div>
  );
}
