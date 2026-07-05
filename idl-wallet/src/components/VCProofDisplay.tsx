import React, { useState } from 'react';
import { InviterIdentity, FIELD_LABELS } from '../types/invitations';
import { usePhotoDID } from '../hooks/usePhotoDID';

interface VCProofDisplayProps {
  inviterIdentity: InviterIdentity;
  className?: string;
}

/**
 * VCProofDisplay Component
 *
 * Displays Verifiable Credential proof information with the following features:
 * - ALWAYS shows VC contents regardless of verification status
 * - Smart badge display based on validation result
 * - Revealed claims/data display with human-readable labels
 * - Credential metadata (issuer, dates, type)
 * - Expandable raw JSON view for technical inspection
 * - Copy-to-clipboard for DIDs
 *
 * This component implements the core design principle: Users must see what the
 * inviter is sharing, even if the credential uses a different schema or fails validation.
 */
export const VCProofDisplay: React.FC<VCProofDisplayProps> = ({
  inviterIdentity,
  className = ''
}) => {
  const [showRawVC, setShowRawVC] = useState(false);

  const { isVerified, vcProof, validationResult, revealedData } = inviterIdentity;

  // Resolve photo at component level (hook must not be inside loop)
  const rawPhotoValue = revealedData?.photo as string | undefined;
  const resolvedPhoto = usePhotoDID(rawPhotoValue, revealedData?.uniqueId as string | undefined);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert(`${label} copied to clipboard!`);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <div className={`vc-proof-display space-y-4 ${className}`}>
      {/* Credential Type */}
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase mb-1">
          Credential Type:
        </p>
        <p className="text-base font-medium text-white">
          {vcProof.type?.join(', ') || 'Unknown Type'}
        </p>
      </div>

      {/* Issuer Information */}
      {validationResult.issuer && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase mb-1">
            Issued By:
          </p>
          <div className="flex items-center space-x-2">
            <p className="flex-1 font-mono text-xs text-slate-300 bg-slate-800/50 px-2 py-1 rounded-xl break-all">
              {validationResult.issuer}
            </p>
            <button
              onClick={() => copyToClipboard(validationResult.issuer!, 'Issuer DID')}
              className="flex-shrink-0 p-1 text-cyan-400 hover:bg-cyan-500/20 rounded-xl"
              title="Copy Issuer DID"
            >
              📋
            </button>
          </div>
        </div>
      )}

      {/* Revealed Claims - ALWAYS DISPLAY regardless of verification status */}
      {revealedData && Object.keys(revealedData).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase mb-2">
            Credential Data:
          </p>
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 space-y-2">
            {Object.entries(revealedData).map(([field, value]) => {
              // Photo field: use pre-resolved URL (handles both DID refs and legacy base64)
              const isPhotoField = field === 'photo';
              const imgSrc = isPhotoField ? resolvedPhoto : null;
              const isImage = imgSrc !== null || (typeof value === 'string' && value.startsWith('data:image/'));
              const displaySrc = imgSrc || (typeof value === 'string' && value.startsWith('data:image/') ? value : null);

              return (
                <div key={field} className={`flex ${isImage ? 'flex-col items-start' : 'justify-between items-center'}`}>
                  <span className="text-sm font-medium text-slate-400">
                    • {FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field}:
                  </span>
                  {displaySrc ? (
                    <img
                      src={displaySrc}
                      alt={field}
                      className="mt-1 rounded-lg border border-slate-600 object-cover object-top"
                      style={{ maxWidth: '120px', maxHeight: '160px' }}
                    />
                  ) : isPhotoField && !resolvedPhoto ? (
                    // Photo DID not yet resolved — show placeholder while loading
                    <span className="text-sm text-slate-400 italic">Loading photo...</span>
                  ) : (
                    <span className="text-sm text-white font-semibold">{value as string}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Credential Dates */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        {validationResult.issuedAt && (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase">
              Issued:
            </p>
            <p className="text-white">
              {new Date(validationResult.issuedAt).toLocaleDateString()}
            </p>
          </div>
        )}
        {validationResult.expiresAt && (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase">
              Expires:
            </p>
            <p className="text-white">
              {new Date(validationResult.expiresAt).toLocaleDateString()}
            </p>
          </div>
        )}
      </div>

      {/* Show Raw Data Button */}
      <button
        onClick={() => setShowRawVC(!showRawVC)}
        className="w-full text-sm text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
      >
        {showRawVC ? '▲ Hide Raw Data' : '▼ Show Raw Data'}
      </button>

      {/* Raw VC Data */}
      {showRawVC && vcProof && (
        <div className="bg-slate-900 rounded-xl p-4 overflow-x-auto">
          <pre className="text-xs text-emerald-400 font-mono">
            {JSON.stringify(vcProof, null, 2)}
          </pre>
        </div>
      )}

      {/* Verification Notes - Show errors/warnings if present */}
      {validationResult.errors && validationResult.errors.length > 0 && (
        <div className="bg-amber-500/20 border border-amber-500/30 rounded-xl p-4">
          <h4 className="text-sm font-semibold text-amber-400 mb-2">
            ⚠️ Verification Notes:
          </h4>
          <ul className="text-sm text-amber-300 space-y-1">
            {validationResult.errors.map((error, index) => (
              <li key={index}>• {error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
