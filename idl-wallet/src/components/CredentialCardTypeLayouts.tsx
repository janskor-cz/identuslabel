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
import { getClearanceBadgeClasses, getCredentialType, getCredentialSubject, getEnterpriseAttr } from '@/utils/credentialTypeDetector';
import { usePhotoDID } from '../hooks/usePhotoDID';
import { useCAPortal } from '@/utils/CAPortalContext';

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
  const photoValue = subject?.photo || null;
  const photo = usePhotoDID(photoValue, uniqueId !== 'N/A' ? uniqueId : undefined);
  const photoIsDid = typeof photoValue === 'string' && photoValue.startsWith('did:');

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
    <div className="bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 rounded-xl p-3">
      <div className="flex gap-3">
        {/* Photo — fixed 3:4 portrait aspect ratio (standard ID photo) */}
        <div className="flex-shrink-0 border-2 border-cyan-500/30 rounded-lg overflow-hidden bg-slate-800/50"
             style={{ width: '64px', height: '86px' }}>
          {photo ? (
            <img src={photo} alt="ID Photo"
                 className="w-full h-full object-cover object-top" />
          ) : photoIsDid ? (
            <div className="flex flex-col items-center justify-center w-full h-full">
              <CameraIcon className="w-6 h-6 text-amber-400 opacity-70" />
              <div className="text-slate-400" style={{fontSize:'9px', textAlign:'center', padding:'2px'}}>DID<br/>linked</div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center w-full h-full">
              <CameraIcon className="w-6 h-6 text-cyan-400 opacity-50" />
              <div className="text-xs mt-1 text-slate-500">Photo</div>
            </div>
          )}
        </div>

        {/* Personal Details */}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-cyan-400 font-semibold uppercase tracking-wide">Identity</div>
          <div className="text-base font-bold text-white truncate">{firstName} {lastName}</div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mt-2">
            <div>
              <div className="text-cyan-400 uppercase" style={{fontSize:'10px'}}>Date of Birth</div>
              <div className="text-slate-300">{formatDate(dateOfBirth)}</div>
            </div>
            <div>
              <div className="text-cyan-400 uppercase" style={{fontSize:'10px'}}>Gender</div>
              <div className="text-slate-300">{gender}</div>
            </div>
            <div className="col-span-2">
              <div className="text-cyan-400 uppercase" style={{fontSize:'10px'}}>Unique ID</div>
              <div className="font-mono text-slate-300 truncate">{uniqueId}</div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 pt-1 mt-2 flex gap-4 text-xs">
            <div><span className="text-cyan-400">Issued </span><span className="text-slate-300">{formatDate(issuedDate)}</span></div>
            <div><span className="text-cyan-400">Exp </span><span className="text-slate-300">{formatDate(expiryDate)}</span></div>
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
    <div className="bg-gradient-to-r from-red-500/20 to-rose-500/20 border border-red-500/30 rounded-xl p-3">
      <div className="flex gap-3">
        {/* Seal Icon */}
        <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center border-2 border-red-500/30">
          <ShieldCheckIcon className="w-7 h-7 text-red-400" />
        </div>

        {/* Clearance Details */}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-red-400 font-semibold uppercase tracking-wide">Security Clearance</div>
          <div className="text-base font-bold text-white">{clearanceLevel}</div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mt-2">
            <div className="col-span-2">
              <div className="text-red-400 uppercase" style={{fontSize:'10px'}}>Holder</div>
              <div className="text-slate-300 truncate">{holderName}</div>
            </div>
            <div className="col-span-2">
              <div className="text-red-400 uppercase" style={{fontSize:'10px'}}>Holder ID</div>
              <div className="font-mono text-slate-400 truncate">{holderUniqueId}</div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 pt-1 mt-2 flex gap-4 text-xs">
            <div><span className="text-red-400">Issued </span><span className="text-slate-300">{formatDate(issuedDate)}</span></div>
            <div><span className="text-red-400">Exp </span><span className="text-slate-300">{formatDate(expiryDate)}</span></div>
          </div>

          {(ed25519PublicKey || x25519PublicKey) && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-red-400 hover:underline">🔑 Crypto Keys</summary>
              <div className="mt-1 space-y-1 text-xs bg-slate-800/50 p-2 rounded-lg">
                {ed25519PublicKey && <div><span className="text-slate-400">Ed25519: </span><span className="font-mono text-slate-500">{truncateKey(ed25519PublicKey, 30)}</span></div>}
                {x25519PublicKey && <div><span className="text-slate-400">X25519: </span><span className="font-mono text-slate-500">{truncateKey(x25519PublicKey, 30)}</span></div>}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function EnterpriseIDLayout({ credential }: { credential: any }) {
  const { openCAPortal } = useCAPortal();
  // Support both enterprise (claims/credentialAttributes) and personal wallet (credentialSubject via SDK) shapes
  const subject = getCredentialSubject(credential);
  const attr = (name: string) => getEnterpriseAttr(credential, name) || subject?.[name] || '';
  const role = attr('role');
  const company = attr('companyName');
  const department = attr('department');
  const email = attr('email');
  const employeeId = attr('employeeId');
  const portalUrl = attr('portalUrl') || (email
    ? `https://identuslabel.cz/company-admin/employee-portal-login.html?email=${encodeURIComponent(email)}`
    : null);
  const issuedRaw = credential.issuedAt || attr('effectiveDate') || attr('hireDate');
  const issued = issuedRaw ? new Date(issuedRaw).toLocaleDateString() : '—';

  return (
    <div className="bg-gradient-to-r from-indigo-500/20 to-blue-500/20 rounded-xl p-4 border border-indigo-500/30">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-14 h-14 rounded-full bg-indigo-500/30 flex items-center justify-center text-2xl">🏢</div>
        <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="col-span-2">
            <div className="text-xs text-indigo-400 font-semibold uppercase tracking-wide">Role</div>
            <div className="text-white font-bold text-base">{role || '—'}</div>
          </div>
          <div><div className="text-xs text-slate-400">Company</div><div className="text-slate-200">{company || '—'}</div></div>
          <div><div className="text-xs text-slate-400">Department</div><div className="text-slate-200">{department || '—'}</div></div>
          <div><div className="text-xs text-slate-400">Email</div><div className="text-slate-200 truncate">{email || '—'}</div></div>
          <div><div className="text-xs text-slate-400">Employee ID</div><div className="text-slate-300 font-mono text-xs">{employeeId || '—'}</div></div>
          <div><div className="text-xs text-slate-400">Issued</div><div className="text-slate-200">{issued}</div></div>
          {portalUrl && (
            <div className="col-span-2 mt-1">
              <button
                onClick={() => openCAPortal(portalUrl)}
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 underline"
              >
                🏢 Employee Portal
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CISTrainingLayout({ credential }: { credential: any }) {
  const employeeName = getEnterpriseAttr(credential, 'employeeName');
  const trainingYear = getEnterpriseAttr(credential, 'trainingYear');
  const completionDate = getEnterpriseAttr(credential, 'completionDate');
  const certNumber = getEnterpriseAttr(credential, 'certificateNumber');
  const employeeId = getEnterpriseAttr(credential, 'employeeId');

  return (
    <div className="bg-gradient-to-r from-green-500/20 to-emerald-500/20 rounded-xl p-4 border border-green-500/30">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-14 h-14 rounded-full bg-green-500/30 flex items-center justify-center text-2xl">🎓</div>
        <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="col-span-2 flex items-center gap-3">
            <div>
              <div className="text-xs text-green-400 font-semibold uppercase tracking-wide">CIS/ICS Training</div>
              <div className="text-white font-bold text-base">{employeeName || '—'}</div>
            </div>
            {trainingYear && (
              <span className="px-2 py-0.5 text-xs font-bold bg-green-500/30 text-green-300 border border-green-500/40 rounded-full">{trainingYear}</span>
            )}
          </div>
          <div><div className="text-xs text-slate-400">Completion Date</div><div className="text-slate-200">{completionDate || '—'}</div></div>
          <div><div className="text-xs text-slate-400">Employee ID</div><div className="text-slate-300 font-mono text-xs">{employeeId || '—'}</div></div>
          <div className="col-span-2"><div className="text-xs text-slate-400">Certificate No.</div><div className="text-slate-300 font-mono text-xs">{certNumber || '—'}</div></div>
        </div>
      </div>
    </div>
  );
}

function ServiceConfigurationLayout({ credential }: CredentialLayoutProps) {
  const subject = getCredentialSubject(credential);
  const url = subject?.enterpriseAgentUrl || '—';
  const walletId = subject?.enterpriseAgentWalletId || '—';
  const agentName = subject?.enterpriseAgentName || '—';
  const apiKey = subject?.enterpriseAgentApiKey || '';
  const maskedKey = apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : '—';

  return (
    <div className="bg-gradient-to-r from-purple-500/20 to-violet-500/20 rounded-xl p-3 border border-purple-500/30">
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-purple-500/30 flex items-center justify-center text-lg">⚙️</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-purple-400 font-semibold uppercase tracking-wide">Enterprise Config</div>
          <div className="text-sm font-bold text-white truncate">{url}</div>
          <div className="grid grid-cols-1 gap-y-1 text-xs mt-2">
            <div><span className="text-purple-400">Wallet ID </span><span className="font-mono text-slate-300">{walletId.slice(0, 18)}…</span></div>
            <div><span className="text-purple-400">Agent </span><span className="font-mono text-slate-400 truncate block">{agentName.length > 30 ? agentName.slice(0, 30) + '…' : agentName}</span></div>
            <div><span className="text-purple-400">API Key </span><span className="font-mono text-slate-400">{maskedKey}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CertificationAuthorityLayout({ credential }: CredentialLayoutProps) {
  const subject = getCredentialSubject(credential);
  const orgName = subject?.organizationName || '—';
  const website = subject?.website || '—';
  const regNumber = subject?.registrationNumber || '—';
  const jurisdiction = subject?.jurisdiction || '—';
  const established = subject?.establishedDate || subject?.issuedDate || '—';
  const authScope = subject?.authorizationScope || '—';

  return (
    <div className="bg-gradient-to-r from-amber-500/20 to-yellow-500/20 rounded-xl p-3 border border-amber-500/30">
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/30 flex items-center justify-center text-lg">🏛️</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-amber-400 font-semibold uppercase tracking-wide">Certification Authority</div>
          <div className="text-sm font-bold text-white truncate">{orgName}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mt-2">
            <div><div className="text-amber-400 uppercase" style={{fontSize:'10px'}}>Website</div><div className="text-slate-300 truncate">{website}</div></div>
            <div><div className="text-amber-400 uppercase" style={{fontSize:'10px'}}>Reg. No.</div><div className="text-slate-300">{regNumber}</div></div>
            <div><div className="text-amber-400 uppercase" style={{fontSize:'10px'}}>Jurisdiction</div><div className="text-slate-300">{jurisdiction}</div></div>
            <div><div className="text-amber-400 uppercase" style={{fontSize:'10px'}}>Established</div><div className="text-slate-300">{established}</div></div>
            <div className="col-span-2"><div className="text-amber-400 uppercase" style={{fontSize:'10px'}}>Scope</div><div className="text-slate-300 truncate">{authScope}</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocumentMetadataLayout({ credential }: CredentialLayoutProps) {
  const subject = getCredentialSubject(credential);
  const clearanceLevel = subject?.classificationLevel || 'UNCLASSIFIED';
  const badgeClasses = getClearanceBadgeClasses(clearanceLevel);

  return (
    <div className="bg-slate-800/40 rounded-xl p-3 border border-slate-600/40">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">📄</span>
        <span className="text-sm font-medium text-slate-200 truncate flex-1">
          {subject?.documentTitle || 'Document'}
        </span>
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${badgeClasses}`}>
          {clearanceLevel}
        </span>
      </div>
      <div className="space-y-1 text-xs">
        {subject?.documentType && (
          <div className="flex gap-2">
            <span className="text-slate-400 shrink-0 w-28">Type</span>
            <span className="text-slate-300">{subject.documentType}</span>
          </div>
        )}
        {subject?.createdBy && (
          <div className="flex gap-2">
            <span className="text-slate-400 shrink-0 w-28">Created by</span>
            <span className="text-slate-300">{subject.createdBy}</span>
          </div>
        )}
        {subject?.createdAt && (
          <div className="flex gap-2">
            <span className="text-slate-400 shrink-0 w-28">Date</span>
            <span className="text-slate-300">{new Date(subject.createdAt).toLocaleDateString()}</span>
          </div>
        )}
        {subject?.documentDescription && (
          <div className="flex gap-2">
            <span className="text-slate-400 shrink-0 w-28">Description</span>
            <span className="text-slate-300 truncate">{subject.documentDescription}</span>
          </div>
        )}
        {subject?.encryptionManifestId && (
          <div className="flex gap-2 pt-1 border-t border-slate-700/50 mt-1">
            <span className="text-slate-500 shrink-0 w-28">Key manifest</span>
            <span className="font-mono text-slate-500 truncate text-xs">{subject.encryptionManifestId}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function UnknownCredentialLayout({ credential }: CredentialLayoutProps) {
  const subject = getCredentialSubject(credential);
  const entries = subject ? Object.entries(subject).filter(([k]) => k !== 'id') : [];

  return (
    <div className="bg-slate-800/40 rounded-xl p-3 border border-slate-600/40">
      <details>
        <summary className="cursor-pointer flex items-center gap-2 text-sm text-slate-300 select-none">
          <span className="text-base">❓</span>
          <span className="font-medium">Unknown credential</span>
          <span className="ml-auto text-xs text-slate-500">{entries.length} fields — click to expand</span>
        </summary>
        <div className="mt-3 space-y-1 text-xs border-t border-slate-700/50 pt-3">
          {entries.length === 0 ? (
            <div className="text-slate-500 italic">No subject fields found</div>
          ) : entries.map(([key, val]) => (
            <div key={key} className="flex gap-2">
              <span className="text-slate-400 shrink-0 w-32 truncate">{key}</span>
              <span className="font-mono text-slate-300 truncate">{String(val)}</span>
            </div>
          ))}
          {credential.issuer && (
            <div className="flex gap-2 pt-2 border-t border-slate-700/50 mt-2">
              <span className="text-slate-400 shrink-0 w-32">issuer</span>
              <span className="font-mono text-slate-500 truncate text-xs">{String(credential.issuer)}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/**
 * Get appropriate layout component based on credential type
 */
export function getCredentialLayout(credential: any) {
  const type = getCredentialType(credential);

  switch (type) {
    case 'RealPersonIdentity':
      return <IDCardLayout credential={credential} />;
    case 'SecurityClearance':
      return <CertificateLayout credential={credential} />;
    case 'EmployeeRole':
      return <EnterpriseIDLayout credential={credential} />;
    case 'CISTrainingCertificate':
      return <CISTrainingLayout credential={credential} />;
    case 'ServiceConfiguration':
      return <ServiceConfigurationLayout credential={credential} />;
    case 'CertificationAuthorityIdentity':
      return <CertificationAuthorityLayout credential={credential} />;
    case 'DocumentMetadata':
      return <DocumentMetadataLayout credential={credential} />;
    default:
      return <UnknownCredentialLayout credential={credential} />;
  }
}
