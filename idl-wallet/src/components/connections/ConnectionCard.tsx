/**
 * ConnectionCard — one bordered shape for the connections grid (replaces the old full-width list
 * row, and an earlier iteration of this card that nested a separate bordered avatar box inside
 * the card's own border — see the design mockups this was iterated against in conversation).
 * The photo/entity icon fills the card's own top edge flush (no inner border/background of its
 * own), the name sits below it, and the action row is collapsed by default — tapping the photo
 * or name toggles it open. Touch-friendly by construction: no behavior depends on hover, since
 * this app is used on both desktop and mobile.
 *
 * Purely presentational: connections.tsx computes everything (photo candidates, verified flag,
 * access targets) and passes callbacks; this component owns only its own open/closed state and
 * the access-target popover's open state.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { ConnectionAvatar } from '@/components/ConnectionAvatar';
import { AccessTarget } from '@/utils/connectionAccessTargets';

interface ConnectionCardProps {
  displayName: string;
  /** Shows a checkmark overlaid on the photo's top-right corner — omitted entirely when false. */
  verified?: boolean;
  /** Person photo path — pass the connection's matched photo-bearing credentials. */
  photoBearingCredentials?: SDK.Domain.Credential[];
  /** Live-verified preview photo fallback — see ConnectionAvatar's fallbackPhoto doc comment. */
  fallbackPhoto?: string;
  fallbackUniqueId?: string;
  /** Entity/service path (no photo claim exists at all) — icon + accent shown instead of a photo. */
  entityIcon?: string;
  entityAccentClass?: string;
  accessTargets?: AccessTarget[];
  accessPending?: boolean;
  onMessage: () => void;
  onRequestAccess?: (targetKey: string) => void;
  /** credential-issuance/1.0 entry point (see CredentialIssuanceRequestor.tsx) — omitted entirely
   *  unless the caller knows this connection exposes an issuance capability (e.g. the CA). */
  onRequestIssuance?: () => void;
  onViewCredentials?: () => void;
  onViewDetails: () => void;
  onDelete?: () => void;
}

export function ConnectionCard({
  displayName,
  verified = false,
  photoBearingCredentials,
  fallbackPhoto,
  fallbackUniqueId,
  entityIcon,
  entityAccentClass = 'bg-slate-700/50 text-slate-400',
  accessTargets = [],
  accessPending = false,
  onMessage,
  onRequestAccess,
  onRequestIssuance,
  onViewCredentials,
  onViewDetails,
  onDelete,
}: ConnectionCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAccessMenu, setShowAccessMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const accessButtonRef = useRef<HTMLButtonElement>(null);
  const hasAccess = accessTargets.length > 0 && !!onRequestAccess;

  const toggleOpen = () => {
    setIsOpen(v => !v);
    setShowAccessMenu(false);
  };

  const toggleAccessMenu = () => {
    setShowAccessMenu(v => {
      const next = !v;
      if (next && accessButtonRef.current) {
        const rect = accessButtonRef.current.getBoundingClientRect();
        setMenuPos({ left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 4 });
      }
      return next;
    });
  };

  // The popover is rendered via a portal (see render below) because this card's own root, and
  // the collapsible action row above it, both need `overflow-hidden` (rounded photo corners /
  // grid-based collapse animation) — a normal `absolute` child would be clipped to invisibility
  // by either ancestor, which is why the menu used to silently fail to appear.
  useEffect(() => {
    if (!showAccessMenu) return;
    const close = () => setShowAccessMenu(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [showAccessMenu]);

  return (
    <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl hover:border-slate-600/50 transition-all duration-200 overflow-hidden flex flex-col">
      <div className="relative cursor-pointer" onClick={toggleOpen}>
        {entityIcon ? (
          <div className={`w-full aspect-[4/3] flex items-center justify-center text-4xl ${entityAccentClass}`}>
            {entityIcon}
          </div>
        ) : (
          <ConnectionAvatar
            photoBearingCredentials={photoBearingCredentials ?? []}
            fallbackPhoto={fallbackPhoto}
            fallbackUniqueId={fallbackUniqueId}
            shape="fill"
          />
        )}
        {verified && (
          <div
            className="absolute top-2 right-2 w-5 h-5 rounded-full bg-emerald-500 border-2 border-slate-900 flex items-center justify-center text-[10px] font-bold text-slate-950"
            title="Verified identity"
          >
            ✓
          </div>
        )}
      </div>

      <span
        className="font-medium text-white text-sm text-center truncate w-full px-2 py-2.5 cursor-pointer"
        title={displayName}
        onClick={toggleOpen}
      >
        {displayName}
      </span>

      <div className={`grid transition-[grid-template-rows] duration-200 ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="w-full flex border-t border-slate-700/50">
            <button
              onClick={onMessage}
              title="Message"
              className="flex-1 py-2.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors border-r border-slate-700/50 min-h-11"
            >
              💬
            </button>

            {hasAccess && (
              <div className="relative flex-1 border-r border-slate-700/50">
                <button
                  ref={accessButtonRef}
                  onClick={toggleAccessMenu}
                  disabled={accessPending}
                  title="Request access via VC proof"
                  className="w-full h-full py-2.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors disabled:opacity-50 min-h-11"
                >
                  {accessPending ? '⏳' : '🔓'}
                </button>
                {showAccessMenu && menuPos && typeof document !== 'undefined' && createPortal(
                  <>
                    <div className="fixed inset-0 z-[9998]" onClick={() => setShowAccessMenu(false)} />
                    <div
                      style={{ left: menuPos.left, bottom: menuPos.bottom }}
                      className="fixed -translate-x-1/2 z-[9999] min-w-max bg-slate-900 border border-slate-600/60 rounded-xl shadow-xl overflow-hidden"
                    >
                      <p className="px-3 py-2 text-xs text-slate-400 border-b border-slate-700/50">
                        Select target
                      </p>
                      {accessTargets.map(({ key, label, icon }) => (
                        <button
                          key={key}
                          onClick={() => {
                            setShowAccessMenu(false);
                            onRequestAccess?.(key);
                          }}
                          className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-white hover:bg-cyan-500/20 transition-colors text-left"
                        >
                          <span>{icon}</span>
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body
                )}
              </div>
            )}

            {onRequestIssuance && (
              <button
                onClick={onRequestIssuance}
                title="Request a credential via DIDComm"
                className="flex-1 py-2.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors border-r border-slate-700/50 min-h-11"
              >
                🪪
              </button>
            )}

            {onViewCredentials && (
              <button
                onClick={onViewCredentials}
                title="Received credentials"
                className="flex-1 py-2.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors border-r border-slate-700/50 min-h-11"
              >
                📜
              </button>
            )}

            <button
              onClick={onViewDetails}
              title="Details"
              className={`flex-1 py-2.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors min-h-11 ${onDelete ? 'border-r border-slate-700/50' : ''}`}
            >
              ℹ️
            </button>

            {onDelete && (
              <button
                onClick={onDelete}
                title="Delete"
                className="flex-1 py-2.5 text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-colors min-h-11"
              >
                🗑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
