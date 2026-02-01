/**
 * Credential Card Type-Specific Layouts
 *
 * Provides modern digital card layouts for different credential types:
 * - RealPersonIdentity: ID card style with photo placeholder
 * - SecurityClearance: Certificate style with clearance badge and seal icon
 *
 * Created: November 2, 2025
 * Purpose: Enhanced visual presentation of credentials in wallet
 */

import React from 'react';
import { ShieldCheckIcon, CameraIcon } from '@heroicons/react/solid';
import { getClearanceBadgeClasses, getCredentialType, getCredentialSubject } from '@/utils/credentialTypeDetector';

interface CredentialLayoutProps {
  credential: any;
}

/**
 * ID Card Layout for RealPersonIdentity credentials
 *
 * Layout:
 * - Left: Empty square frame (photo placeholder with camera icon)
 * - Right: Personal details (name, DOB, gender, unique ID, dates)
 */
export function IDCardLayout({ credential }: CredentialLayoutProps) {
  // Use helper to handle all credential formats (including SDK JWTCredential with properties Map)
  const subject = getCredentialSubject(credential);

  const firstName = subject?.firstName || 'Unknown';
  const lastName = subject?.lastName || '';
  const dateOfBirth = subject?.dateOfBirth || 'N/A';
  const gender = subject?.gender || 'N/A';
  const uniqueId = subject?.uniqueId || 'N/A';
  const issuedDate = subject?.issuedDate || credential.issuanceDate || 'N/A';
  const expiryDate = subject?.expiryDate || credential.expirationDate || 'N/A';

  // Format dates
  const formatDate = (dateStr: string) => {
    if (dateStr === 'N/A') return dateStr;
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 rounded-2xl p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Identity Credential</h3>
        <div className="text-xs bg-cyan-500/20 border border-cyan-500/30 px-3 py-1 rounded-full text-cyan-400">
          ID Card
        </div>
      </div>

      {/* Main Content */}
      <div className="flex gap-6">
        {/* Photo Placeholder - Empty Square Frame */}
        <div className="flex-shrink-0">
          <div className="w-32 h-40 border-4 border-cyan-500/30 rounded-xl flex items-center justify-center bg-slate-800/50">
            <div className="text-center">
              <CameraIcon className="w-12 h-12 mx-auto text-cyan-400 opacity-50" />
              <div className="text-xs mt-2 text-slate-400">Photo</div>
            </div>
          </div>
        </div>

        {/* Personal Details */}
        <div className="flex-1 space-y-2">
          <div>
            <div className="text-2xl font-bold text-white">{firstName} {lastName}</div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mt-4">
            <div>
              <div className="text-cyan-400 text-xs uppercase">Date of Birth</div>
              <div className="font-medium text-slate-300">{formatDate(dateOfBirth)}</div>
            </div>

            <div>
              <div className="text-cyan-400 text-xs uppercase">Gender</div>
              <div className="font-medium text-slate-300">{gender}</div>
            </div>

            <div className="col-span-2">
              <div className="text-cyan-400 text-xs uppercase">Unique ID</div>
              <div className="font-mono text-xs text-slate-300">{uniqueId}</div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 pt-3 mt-4 grid grid-cols-2 gap-x-4 text-xs">
            <div>
              <div className="text-cyan-400">Issued</div>
              <div className="text-slate-300">{formatDate(issuedDate)}</div>
            </div>
            <div>
              <div className="text-cyan-400">Expires</div>
              <div className="text-slate-300">{formatDate(expiryDate)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Certificate Layout for SecurityClearance credentials
 *
 * Layout:
 * - Left: Official seal icon (shield-check)
 * - Right: Clearance details (level with color badge, holder name, dates, keys)
 */
export function CertificateLayout({ credential }: CredentialLayoutProps) {
  // Use helper to handle all credential formats (including SDK JWTCredential with properties Map)
  const subject = getCredentialSubject(credential);

  const clearanceLevel = subject?.clearanceLevel || 'UNKNOWN';
  const holderName = subject?.holderName ||
                     (subject?.firstName && subject?.lastName ?
                       `${subject.firstName} ${subject.lastName}` : 'Unknown');
  const holderUniqueId = subject?.holderUniqueId || subject?.uniqueId || 'N/A';
  const issuedDate = subject?.issuedDate || credential.issuanceDate || 'N/A';
  const expiryDate = subject?.expiryDate || credential.expirationDate || 'N/A';

  // Cryptographic keys (optional display)
  const ed25519PublicKey = subject?.ed25519PublicKey;
  const x25519PublicKey = subject?.x25519PublicKey;
  const ed25519Fingerprint = subject?.ed25519Fingerprint;
  const x25519Fingerprint = subject?.x25519Fingerprint;

  // Get color scheme for clearance level
  const badgeClasses = getClearanceBadgeClasses(clearanceLevel);

  // Format dates
  const formatDate = (dateStr: string) => {
    if (dateStr === 'N/A') return dateStr;
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  // Truncate key for display
  const truncateKey = (key: string | undefined, length: number = 20) => {
    if (!key) return 'N/A';
    return key.length > length ? `${key.substring(0, length)}...` : key;
  };

  return (
    <div className="bg-gradient-to-r from-red-500/20 to-rose-500/20 border-2 border-red-500/30 rounded-2xl p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Security Clearance Certificate</h3>
        <div className="text-xs bg-red-500/30 text-white px-3 py-1 rounded-full font-semibold">
          {clearanceLevel}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex gap-6">
        {/* Official Seal Icon */}
        <div className="flex-shrink-0">
          <div className="w-24 h-24 rounded-full bg-red-500/20 flex items-center justify-center border-4 border-red-500/30">
            <ShieldCheckIcon className="w-16 h-16 text-red-400" />
          </div>
        </div>

        {/* Clearance Details */}
        <div className="flex-1 space-y-3">
          <div>
            <div className="text-red-400 text-xs uppercase font-medium">Clearance Level</div>
            <div className="text-2xl font-bold text-white">{clearanceLevel}</div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="col-span-2">
              <div className="text-red-400 text-xs uppercase">Holder Name</div>
              <div className="font-medium text-slate-300">{holderName}</div>
            </div>

            <div className="col-span-2">
              <div className="text-red-400 text-xs uppercase">Holder ID</div>
              <div className="font-mono text-xs text-slate-400">{holderUniqueId}</div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 pt-3 grid grid-cols-2 gap-x-4 text-xs">
            <div>
              <div className="text-red-400">Issued</div>
              <div className="text-slate-300">{formatDate(issuedDate)}</div>
            </div>
            <div>
              <div className="text-red-400">Expires</div>
              <div className="text-slate-300">{formatDate(expiryDate)}</div>
            </div>
          </div>

          {/* Cryptographic Keys (Collapsible Detail) */}
          {(ed25519PublicKey || x25519PublicKey) && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-red-400 hover:underline">
                🔑 Cryptographic Keys
              </summary>
              <div className="mt-2 space-y-2 text-xs bg-slate-800/50 p-3 rounded-xl">
                {ed25519PublicKey && (
                  <div>
                    <div className="font-semibold text-slate-300">Ed25519 (Signing)</div>
                    <div className="font-mono text-slate-400">{truncateKey(ed25519PublicKey, 40)}</div>
                    {ed25519Fingerprint && (
                      <div className="text-slate-500 text-xs mt-1">
                        Fingerprint: {ed25519Fingerprint.substring(0, 30)}...
                      </div>
                    )}
                  </div>
                )}
                {x25519PublicKey && (
                  <div>
                    <div className="font-semibold text-slate-300">X25519 (Encryption)</div>
                    <div className="font-mono text-slate-400">{truncateKey(x25519PublicKey, 40)}</div>
                    {x25519Fingerprint && (
                      <div className="text-slate-500 text-xs mt-1">
                        Fingerprint: {x25519Fingerprint.substring(0, 30)}...
                      </div>
                    )}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Get appropriate layout component based on credential type
 *
 * @param credential - Credential object
 * @returns Layout component (IDCardLayout or CertificateLayout)
 */
export function getCredentialLayout(credential: any) {
  const type = getCredentialType(credential);

  switch (type) {
    case 'RealPersonIdentity':
      return <IDCardLayout credential={credential} />;
    case 'SecurityClearance':
      return <CertificateLayout credential={credential} />;
    default:
      // Fallback for unknown types - simple display
      return (
        <div className="bg-slate-800/30 border-2 border-slate-700/50 rounded-2xl p-6">
          <div className="text-slate-300">
            <div className="font-semibold mb-2">Unknown Credential Type</div>
            <div className="text-sm text-slate-400">
              This credential type is not recognized for enhanced display.
            </div>
          </div>
        </div>
      );
  }
}
