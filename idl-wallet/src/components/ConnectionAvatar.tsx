/**
 * ConnectionAvatar
 *
 * Shows the actual photo of the person/entity behind a DIDComm connection, resolved from
 * whichever of that connection's matched credentials (see connectionCredentialMatcher.ts)
 * carries a `photo` claim — falling back to a generic placeholder when none is resolvable.
 *
 * Reuses usePhotoDID exactly as CredentialCardTypeLayouts.tsx's IDCardLayout already does
 * (same hook, unmodified) — this is a proper component instantiated via JSX per connection row,
 * so calling a hook inside it is safe regardless of the row itself being rendered from a
 * `connections.map(...)` callback (the rules-of-hooks constraint is on the map callback calling
 * hooks directly, not on it rendering child components that call their own hooks).
 */
import React from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { usePhotoDID } from '@/hooks/usePhotoDID';
import { getCredentialSubject, getCredentialType, getCredentialTypeAccent } from '@/utils/credentialTypeDetector';

interface ConnectionAvatarProps {
  photoBearingCredentials: SDK.Domain.Credential[];
  /** Fixed pixel size — only used by the 'circle' shape. */
  size?: number;
  /**
   * 'circle' (default): fixed-size circular avatar (e.g. a chat header).
   * 'fill': responsive edge-to-edge rectangle (4:3) that fills its parent's width — the
   * ConnectionCard grid's photo, which is meant to read as the card's own single bordered shape
   * rather than a separate bordered box inside the card, so no ring/border is drawn here at all.
   */
  shape?: 'circle' | 'fill';
  /**
   * Used only when no photoBearingCredentials candidate yields a photo — sourced from
   * ConnectionMetadata.verifiedCredentialSubject's `photo`/`uniqueId` fields, persisted by
   * OOB.tsx's live post-connection identity verification, for connections that passed
   * proof-of-possession but never actually had a Credential issued/stored (so there's nothing in
   * photoBearingCredentials to begin with).
   */
  fallbackPhoto?: string;
  fallbackUniqueId?: string;
}

export function ConnectionAvatar({ photoBearingCredentials, size = 40, shape = 'circle', fallbackPhoto, fallbackUniqueId }: ConnectionAvatarProps) {
  // Preference when multiple candidates exist: RealPersonIdentity (CA-issued ground truth) over
  // EmployeeRole (a workplace-display copy of the same photo) over whatever else matched.
  const preferred =
    photoBearingCredentials.find(c => getCredentialType(c) === 'RealPersonIdentity') ??
    photoBearingCredentials.find(c => getCredentialType(c) === 'EmployeeRole') ??
    photoBearingCredentials[0] ??
    null;

  const subject = preferred ? getCredentialSubject(preferred) : null;
  const photoValue: string | undefined = subject?.photo ?? fallbackPhoto;
  const uniqueId: string | undefined = subject?.uniqueId ?? fallbackUniqueId;

  // Only call the hook when there's an actual candidate — the common case (no photo-bearing
  // credential matched this connection) must render instantly with no resolution attempt.
  const resolvedPhoto = usePhotoDID(photoValue ?? null, uniqueId);

  const personSilhouette = (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z" />
    </svg>
  );

  if (shape === 'fill') {
    if (resolvedPhoto) {
      return <img src={resolvedPhoto} alt="" className="w-full aspect-[4/3] object-cover block" />;
    }
    return (
      <div className="w-full aspect-[4/3] flex items-center justify-center bg-slate-700/50 text-slate-400">
        <div className="w-10 h-10">{personSilhouette}</div>
      </div>
    );
  }

  const accent = preferred ? getCredentialTypeAccent(getCredentialType(preferred)) : null;
  const style = { width: size, height: size };

  if (resolvedPhoto) {
    return (
      <img
        src={resolvedPhoto}
        alt=""
        style={style}
        className={`rounded-full object-cover ring-2 flex-shrink-0 ${accent?.ringClass ?? 'ring-slate-500/50'}`}
      />
    );
  }

  return (
    <div
      style={style}
      className="rounded-full bg-slate-700/50 border border-slate-600/50 flex items-center justify-center flex-shrink-0 text-slate-400"
    >
      <div style={{ width: size * 0.5, height: size * 0.5 }}>{personSilhouette}</div>
    </div>
  );
}
