import React from 'react';
import { InviterIdentity, FIELD_LABELS } from '../types/invitations';

interface InviterVerificationProps {
  inviterIdentity: InviterIdentity;
  className?: string;
}

export const InviterVerification: React.FC<InviterVerificationProps> = ({
  inviterIdentity,
  className = ''
}) => {
  const { isVerified, revealedData, validationResult } = inviterIdentity;

  const getVerificationBadge = () => {
    if (isVerified) {
      return (
        <div className="flex items-center space-x-2 text-emerald-300 bg-emerald-500/20 px-3 py-1 rounded-full border border-emerald-500/30">
          <span className="text-lg">✅</span>
          <span className="font-semibold">Verified Identity</span>
        </div>
      );
    } else {
      return (
        <div className="flex items-center space-x-2 text-red-300 bg-red-500/20 px-3 py-1 rounded-full border border-red-500/30">
          <span className="text-lg">⚠️</span>
          <span className="font-semibold">Unverified</span>
        </div>
      );
    }
  };


  return (
    <div className={`inviter-verification p-4 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">👤 Inviter Identity</h3>
        {getVerificationBadge()}
      </div>

      {isVerified ? (
        <div className="verified-content">
          {/* Revealed Information */}
          <div className="revealed-info mb-4">
            {Object.keys(revealedData).length === 0 ? (
              <div>
                <h4 className="font-medium text-slate-300 mb-2">Shared Information:</h4>
                <div className="text-slate-500 italic">No information shared</div>
              </div>
            ) : (
              <div>
                <h4 className="font-medium text-slate-300 mb-2">
                  Inviter is sharing: {Object.keys(revealedData).map(field =>
                    FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field
                  ).join(', ')}
                </h4>
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 space-y-2">
                  {Object.entries(revealedData).map(([field, value]) => (
                    <div key={field} className="flex justify-between">
                      <span className="font-medium text-slate-400">
                        {FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field}:
                      </span>
                      <span className="text-white">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Credential Information */}
          <div className="credential-info">
            <h4 className="font-medium text-slate-300 mb-2">Credential Details:</h4>
            <div className="text-sm text-slate-400 space-y-1">
              {validationResult.issuer && (
                <div>
                  <span className="font-medium">Issuer:</span> {validationResult.issuer}
                </div>
              )}
              {validationResult.issuedAt && (
                <div>
                  <span className="font-medium">Issued:</span>{' '}
                  {new Date(validationResult.issuedAt).toLocaleDateString()}
                </div>
              )}
              {validationResult.expiresAt && (
                <div>
                  <span className="font-medium">Expires:</span>{' '}
                  {new Date(validationResult.expiresAt).toLocaleDateString()}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="unverified-content">
          <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-3">
            <h4 className="font-medium text-red-300 mb-2">Verification Issues:</h4>
            <ul className="text-sm text-red-400 space-y-1">
              {validationResult.errors.map((error, index) => (
                <li key={index}>• {error}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Trust Indicator */}
      <div className="trust-indicator mt-4 pt-3 border-t border-slate-700/50">
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-slate-400">Trust Level:</span>
          {isVerified ? (
            <span className="text-emerald-400 font-medium">High - Verified credential from trusted issuer</span>
          ) : (
            <span className="text-red-400 font-medium">Low - No verified credential provided</span>
          )}
        </div>
      </div>
    </div>
  );
};
