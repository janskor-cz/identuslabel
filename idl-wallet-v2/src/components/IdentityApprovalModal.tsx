/**
 * IdentityApprovalModal — the inviter's decision point, moved to where the information is.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 * The inviter used to be asked exactly one question, at exactly the wrong time: an "approve this
 * connection request" card carrying a raw peer DID and nothing else, shown before any identity
 * had been exchanged. It looked like an authorisation gate but blocked nothing — the invitee's
 * `agent.acceptInvitation()` opens the channel on its own — and it offered nothing to decide with.
 * Meanwhile the invitee's actual verifiable credential arrived ~15 s later, was live-verified
 * against a fresh nonce-bound challenge, and was applied to the connection silently. The user
 * approved the meaningless thing and never saw the meaningful one.
 *
 * This modal is the meaningful one. It appears only after
 * `liveIdentityVerification.verifyLiveIdentity` returns `verified: true`, so everything shown here
 * has been proved by the peer signing our challenge with an `authentication`-scoped key, over a
 * credential from a pinned issuer whose `subjectDID`/`uniqueId` still match the anchors they
 * originally disclosed (the bait-and-switch defence).
 *
 * ── WHY DECLINE DELETES ─────────────────────────────────────────────────────────────────────
 * Cryptographic verification answers "is this credential genuine and does this peer hold it" — not
 * "do I want to know this person". Only the user answers the second, and a decline that left the
 * connection in place would leave a routable, message-accepting channel to someone the user just
 * rejected. Deleting the DIDPair matches what rejecting a connection request has always done.
 * There is no protocol message for "I changed my mind", so the peer is not notified — their
 * connection simply stops routing anywhere, which is the pre-existing behaviour of reject.
 */
import React, { useState } from 'react';
import { ConnectionAvatar } from '@/components/ConnectionAvatar';

export interface PendingIdentityApproval {
  /** Connection host DID — the key ConnectionMetadata and deleteConnection are both keyed by. */
  hostDID: string;
  /** Live-verified credentialSubject snapshot (never the unverified disclosure). */
  subject: Record<string, any>;
  /** Credential type that was verified, e.g. 'RealPersonIdentity'. */
  credentialType: string;
}

interface IdentityApprovalModalProps {
  approval: PendingIdentityApproval;
  onAccept: () => void;
  onDecline: () => Promise<void> | void;
}

/** Field order is deliberate: what identifies a person first, provenance last. */
const DISPLAY_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'dateOfBirth', label: 'Date of birth' },
  { key: 'gender', label: 'Gender' },
  { key: 'uniqueId', label: 'Identity number' },
  { key: 'credentialId', label: 'Credential ID' },
  { key: 'issuedDate', label: 'Issued' },
  { key: 'expiryDate', label: 'Expires' },
];

export function IdentityApprovalModal({ approval, onAccept, onDecline }: IdentityApprovalModalProps) {
  const [isDeclining, setIsDeclining] = useState(false);
  const { subject, credentialType } = approval;

  const firstName = (subject.firstName || '').trim();
  const lastName = (subject.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unnamed contact';

  const rows = DISPLAY_FIELDS
    .filter(({ key }) => subject[key] !== undefined && subject[key] !== '')
    .map(({ key, label }) => ({ label, value: String(subject[key]) }));

  const handleDecline = async () => {
    if (isDeclining) return;
    setIsDeclining(true);
    try {
      await onDecline();
    } finally {
      // Left true on success too — the modal is unmounted by the parent once the connection is
      // gone, and re-enabling the buttons mid-teardown would allow a second click.
      setIsDeclining(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-slate-700/60">
          <div className="flex items-center gap-2 text-green-400 mb-1">
            <span className="text-lg">✅</span>
            <span className="text-sm font-semibold">Identity verified</span>
          </div>
          <p className="text-xs text-slate-400">
            They answered your live challenge and signed it with a key from their DID document.
          </p>
        </div>

        <div className="px-6 py-5 flex gap-4 items-start">
          <div className="w-20 shrink-0">
            <ConnectionAvatar
              photoBearingCredentials={[]}
              shape="fill"
              fallbackPhoto={subject.photo}
              fallbackUniqueId={subject.uniqueId}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-white truncate">{fullName}</h3>
            <p className="text-xs text-cyan-400 mb-3">{credentialType}</p>
            <dl className="space-y-1">
              {rows.map((row) => (
                <div key={row.label} className="flex gap-2 text-xs">
                  <dt className="text-slate-500 shrink-0">{row.label}</dt>
                  <dd className="text-slate-300 truncate">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="px-6 pb-6 pt-2 flex gap-3">
          <button
            onClick={onAccept}
            disabled={isDeclining}
            className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
          >
            Add contact
          </button>
          <button
            onClick={handleDecline}
            disabled={isDeclining}
            className="flex-1 bg-slate-700 hover:bg-red-600 disabled:opacity-50 text-slate-200 hover:text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
          >
            {isDeclining ? 'Removing…' : 'Decline'}
          </button>
        </div>

        <p className="px-6 pb-5 -mt-3 text-[11px] text-slate-500">
          Declining deletes this connection and its messages. They are not notified.
        </p>
      </div>
    </div>
  );
}
