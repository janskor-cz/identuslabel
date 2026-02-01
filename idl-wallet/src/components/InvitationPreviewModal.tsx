import React, { useState, useEffect, useMemo } from 'react';
import { InviterIdentity, FIELD_LABELS } from '../types/invitations';
import { VerificationBadge } from './VerificationBadge';
import { VCProofDisplay } from './VCProofDisplay';
import { SelectiveDisclosure } from './SelectiveDisclosure';
import { invitationStateManager } from '../utils/InvitationStateManager';
import { useAppSelector } from '../reducers/store';
import { ValidatedCAConfig } from '../utils/caValidation';
import { ValidatedCompanyConfig } from '../utils/companyValidation';
import { getCredentialType } from '../utils/credentialTypeDetector';

/**
 * Simplified display component for RealPersonIdentity credentials
 * Shows a clean profile view with verification status
 */
const RealPersonIdentityDisplay: React.FC<{
  revealedData: Record<string, any>;
  isVerified: boolean;
}> = ({ revealedData, isVerified }) => {
  const displayFields = [
    { key: 'firstName', label: 'First Name' },
    { key: 'lastName', label: 'Last Name' },
    { key: 'uniqueId', label: 'Unique ID' },
    { key: 'dateOfBirth', label: 'Date of Birth' },
    { key: 'gender', label: 'Gender' },
    { key: 'nationality', label: 'Nationality' },
    { key: 'placeOfBirth', label: 'Place of Birth' },
  ].filter(f => revealedData[f.key]);

  const borderColor = isVerified
    ? 'border-emerald-500/30'
    : 'border-amber-500/30';
  const bgGradient = isVerified
    ? 'from-emerald-500/20 to-green-500/20'
    : 'from-amber-500/20 to-yellow-500/20';

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-5 bg-gradient-to-br ${bgGradient} border-2 ${borderColor}`}>
        {/* Profile header */}
        <div className="flex items-start space-x-4 mb-4">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl ${
            isVerified ? 'bg-emerald-500/20' : 'bg-amber-500/20'
          }`}>
            👤
          </div>
          <div className="flex-1">
            {(revealedData.firstName || revealedData.lastName) && (
              <h4 className="text-xl font-bold text-white">
                {[revealedData.firstName, revealedData.lastName].filter(Boolean).join(' ')}
              </h4>
            )}
            {revealedData.uniqueId && (
              <p className="text-sm font-mono text-slate-400">
                ID: {revealedData.uniqueId}
              </p>
            )}
          </div>
        </div>

        {/* Additional fields grid */}
        {displayFields.filter(f => !['firstName', 'lastName', 'uniqueId'].includes(f.key)).length > 0 && (
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-700/50">
            {displayFields
              .filter(f => !['firstName', 'lastName', 'uniqueId'].includes(f.key))
              .map(field => (
                <div key={field.key}>
                  <p className="text-xs font-semibold text-slate-500 uppercase">{field.label}</p>
                  <p className="text-sm font-medium text-white">
                    {revealedData[field.key]}
                  </p>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};

interface InvitationPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<void>;
  onReject?: () => Promise<void>; // ✅ PHASE 3: Add reject callback
  inviterIdentity: InviterIdentity | null;
  inviterLabel: string;
  invitationData?: {
    id?: string;
    from?: string;
    type?: string;
    goal?: string;
  };
  // ✅ NEW: Credential selection props for response
  availableCredentials?: any[];
  selectedVCForRequest?: any | null;
  onVCSelectionChange?: (credential: any | null) => void;
  onFieldSelection?: (fields: string[], level: 'minimal' | 'partial' | 'full') => void;
  // ✅ CA IDENTITY VERIFICATION: CA config props
  caConfig?: ValidatedCAConfig | null;
  isCAInvitation?: boolean;
  caAlreadyPinned?: boolean;
  // ✅ COMPANY IDENTITY VERIFICATION: Company config props
  companyConfig?: ValidatedCompanyConfig | null;
  isCompanyInvitation?: boolean;
  companyAlreadyPinned?: boolean;
  companyCAVerification?: { verified: boolean; caName?: string; issuerDID?: string } | null;
  // ✅ WALLET SELECTION: Wallet selection props
  walletType?: 'local' | 'cloud';
  cloudConfig?: any;
  onWalletSelect?: (walletType: 'local' | 'cloud') => void;
  // ✅ REALPERSON UX: Default wallet type from connections page context
  defaultWalletType?: 'local' | 'cloud';
}

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({
  isOpen,
  onClose,
  onAccept,
  onReject, // ✅ PHASE 3: Extract reject callback
  inviterIdentity,
  inviterLabel,
  invitationData,
  // ✅ NEW: Extract credential selection props
  availableCredentials,
  selectedVCForRequest,
  onVCSelectionChange,
  onFieldSelection,
  // ✅ CA IDENTITY VERIFICATION: Extract CA props
  caConfig,
  isCAInvitation,
  caAlreadyPinned,
  // ✅ COMPANY IDENTITY VERIFICATION: Extract company props
  companyConfig,
  isCompanyInvitation,
  companyAlreadyPinned,
  companyCAVerification,
  // ✅ WALLET SELECTION: Extract wallet selection props
  walletType = 'local',
  cloudConfig,
  onWalletSelect,
  // ✅ REALPERSON UX: Extract default wallet type
  defaultWalletType
}) => {
  const [isAccepting, setIsAccepting] = useState(false);
  const [walletSelectionExpanded, setWalletSelectionExpanded] = useState(false);
  const app = useAppSelector((state) => state.app);

  // ✅ REALPERSON UX: Detect if invitation has RealPersonIdentity credential attached
  const isRealPersonInvitation = useMemo(() => {
    if (!inviterIdentity?.vcProof || !inviterIdentity?.revealedData) return false;

    // Check if revealedData has credentialType field or characteristic RealPerson fields
    const revealedData = inviterIdentity.revealedData;

    // Method 1: Check credentialType field
    if (revealedData.credentialType === 'RealPersonIdentity') return true;

    // Method 2: Check for characteristic RealPerson fields (firstName, lastName, uniqueId)
    const hasRealPersonFields = revealedData.firstName && revealedData.lastName && revealedData.uniqueId;
    if (hasRealPersonFields) return true;

    // Method 3: Use getCredentialType helper with mock credential structure
    const mockCredential = { credentialSubject: revealedData };
    const credType = getCredentialType(mockCredential);

    console.log('[MODAL] Detected invitation credential type:', credType);
    return credType === 'RealPersonIdentity';
  }, [inviterIdentity]);

  // ✅ REALPERSON UX: Dynamic header configuration based on verification status
  const headerConfig = useMemo(() => {
    if (!isRealPersonInvitation) {
      return {
        title: 'Connection Invitation',
        subtitle: 'Review invitation details before accepting',
        bgClass: 'bg-slate-900',
        iconBgClass: 'bg-cyan-500/20',
        iconTextClass: 'text-cyan-400',
        icon: '🔗'
      };
    }

    if (inviterIdentity?.isVerified) {
      return {
        title: 'Verified Connection Invitation',
        subtitle: 'Identity verified via credential proof',
        bgClass: 'bg-emerald-500/10',
        iconBgClass: 'bg-emerald-500/20',
        iconTextClass: 'text-emerald-400',
        icon: '✅'
      };
    }

    return {
      title: 'Unverified Connection Invitation',
      subtitle: 'Identity could not be verified',
      bgClass: 'bg-amber-500/10',
      iconBgClass: 'bg-amber-500/20',
      iconTextClass: 'text-amber-400',
      icon: '⚠️'
    };
  }, [isRealPersonInvitation, inviterIdentity?.isVerified]);

  // ✅ REALPERSON UX: Set default wallet type from connections page context
  useEffect(() => {
    if (isOpen && defaultWalletType && onWalletSelect) {
      console.log('[MODAL] Setting default wallet type:', defaultWalletType);
      onWalletSelect(defaultWalletType);
    }
  }, [isOpen, defaultWalletType, onWalletSelect]);

  // ✅ REALPERSON UX: Auto-select first RealPersonIdentity credential when modal opens
  useEffect(() => {
    if (!isOpen || !isRealPersonInvitation || !availableCredentials?.length) return;
    if (selectedVCForRequest) return; // Don't override existing selection

    const realPersonVC = availableCredentials.find(cred =>
      getCredentialType(cred) === 'RealPersonIdentity'
    );

    if (realPersonVC && onVCSelectionChange) {
      console.log('[MODAL] Auto-selecting RealPersonIdentity credential for response');
      onVCSelectionChange(realPersonVC);
    }
  }, [isOpen, isRealPersonInvitation, availableCredentials, selectedVCForRequest, onVCSelectionChange]);

  // ✅ PHASE 3: Mark invitation as previewed when modal opens
  useEffect(() => {
    const markAsPreviewed = async () => {
      if (!isOpen || !invitationData?.id || !app.wallet?.walletId) return;

      try {
        const success = await invitationStateManager.markPreviewed(
          app.wallet.walletId,
          invitationData.id
        );

        if (success) {
          console.log('✅ [INVITATION STATE] Marked invitation as InvitationPreviewed:', invitationData.id);
        } else {
          console.warn('⚠️ [INVITATION STATE] Could not mark as previewed (invitation may not exist):', invitationData.id);
        }
      } catch (error) {
        console.error('❌ [INVITATION STATE] Failed to mark invitation as previewed:', error);
        // Don't throw - modal should still display
      }
    };

    markAsPreviewed();
  }, [isOpen, invitationData?.id, app.wallet?.walletId]);

  if (!isOpen) return null;

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      await onAccept();
      // Don't close modal here - let parent handle it after successful connection
    } catch (error) {
      console.error('Failed to accept invitation:', error);
      alert('Failed to accept invitation. Please try again.');
    } finally {
      setIsAccepting(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert(`${label} copied to clipboard!`);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          {/* Modal Header - Dynamic based on RealPerson detection */}
          <div className={`sticky top-0 ${headerConfig.bgClass} border-b border-slate-700/50 px-6 py-4 flex items-center justify-between z-10`}>
            <div className="flex items-center space-x-3">
              <div className={`w-10 h-10 ${headerConfig.iconBgClass} rounded-xl flex items-center justify-center`}>
                <span className={`${headerConfig.iconTextClass} text-xl`}>{headerConfig.icon}</span>
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white">
                  {headerConfig.title}
                </h2>
                <p className="text-sm text-slate-400">
                  {headerConfig.subtitle}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <span className="text-2xl">×</span>
            </button>
          </div>

          {/* Modal Body */}
          <div className="px-6 py-6 space-y-6">
            {/* Inviter Identity Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                  Invitation From:
                </h3>
                {companyCAVerification ? (
                  // Show CA verification status if available
                  companyCAVerification.verified ? (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      ✅ Verified by {companyCAVerification.caName}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                      ⚠️ Unverified (TOFU)
                    </span>
                  )
                ) : (
                  // Fallback to VerificationBadge for non-company invitations
                  <VerificationBadge inviterIdentity={inviterIdentity} size="md" showLabel={true} />
                )}
              </div>

              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-3">
                {/* Inviter Label */}
                {inviterLabel && (
                  <div className="flex items-center space-x-3">
                    <div className="flex-shrink-0 w-10 h-10 bg-cyan-500/20 rounded-full flex items-center justify-center">
                      <span className="text-xl">👤</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-lg font-bold text-white truncate">
                        {inviterLabel}
                      </p>
                    </div>
                  </div>
                )}

                {/* Inviter DID - Hidden for RealPerson invitations */}
                {!isRealPersonInvitation && invitationData?.from && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-slate-400 uppercase">
                      Inviter DID:
                    </p>
                    <div className="flex items-center space-x-2">
                      <p className="flex-1 font-mono text-xs text-slate-300 bg-slate-800/50 px-2 py-1 rounded-xl break-all">
                        {invitationData.from}
                      </p>
                      <button
                        onClick={() => copyToClipboard(invitationData.from!, 'DID')}
                        className="flex-shrink-0 p-1 text-cyan-400 hover:bg-cyan-500/20 rounded-xl"
                        title="Copy DID"
                      >
                        📋
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ✅ CA IDENTITY VERIFICATION: CA Identity Section */}
            {isCAInvitation && caConfig && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                    🏛️ Certification Authority Identity:
                  </h3>
                  {caAlreadyPinned ? (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      ✅ Previously Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                      🆕 First Connection (TOFU)
                    </span>
                  )}
                </div>

                <div className="bg-gradient-to-br from-cyan-500/20 to-purple-500/20 rounded-2xl border-2 border-cyan-500/30 p-5 space-y-4">
                  {/* Organization Name */}
                  <div className="flex items-start space-x-3">
                    <div className="flex-shrink-0 w-12 h-12 bg-cyan-500/30 rounded-xl flex items-center justify-center">
                      <span className="text-2xl">🏛️</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-400 uppercase mb-1">
                        Organization Name
                      </p>
                      <p className="text-xl font-bold text-white">
                        {caConfig.organizationName}
                      </p>
                    </div>
                  </div>

                  {/* Website */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-400 uppercase">
                      Website
                    </p>
                    <a
                      href={caConfig.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-2 text-cyan-400 hover:text-cyan-300"
                    >
                      <span>{caConfig.website}</span>
                      <span className="text-sm">🔗</span>
                    </a>
                  </div>

                  {/* Jurisdiction & Registration Number */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Jurisdiction
                      </p>
                      <p className="text-base font-medium text-white">
                        {caConfig.jurisdiction}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Registration #
                      </p>
                      <p className="text-base font-medium text-white font-mono">
                        {caConfig.registrationNumber}
                      </p>
                    </div>
                  </div>

                  {/* Authority Level */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-400 uppercase">
                      Authority Level
                    </p>
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
                      {caConfig.authorityLevel}
                    </span>
                  </div>

                  {/* CA DID */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-400 uppercase">
                      CA DID (Identifier)
                    </p>
                    <div className="flex items-center space-x-2">
                      <p className="flex-1 font-mono text-xs text-slate-300 bg-slate-800/50 px-3 py-2 rounded-xl border border-slate-700/50 break-all">
                        {caConfig.caDID}
                      </p>
                      <button
                        onClick={() => copyToClipboard(caConfig.caDID, 'CA DID')}
                        className="flex-shrink-0 p-2 text-cyan-400 hover:bg-cyan-500/20 rounded-xl transition-colors"
                        title="Copy CA DID"
                      >
                        📋
                      </button>
                    </div>
                  </div>

                  {/* TOFU Information Badge */}
                  {!caAlreadyPinned && (
                    <div className="bg-cyan-500/20 border border-cyan-500/30 rounded-xl p-3">
                      <div className="flex items-start space-x-2">
                        <span className="text-cyan-400 text-lg flex-shrink-0">ℹ️</span>
                        <div className="text-sm text-cyan-300">
                          <p className="font-semibold mb-1">Trust On First Use (TOFU)</p>
                          <p>
                            This is your first connection to this Certification Authority.
                            By accepting, you will trust this CA's identity. Future connections
                            will be verified against this saved identity to detect any changes
                            (potential man-in-the-middle attacks).
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Re-verification Badge */}
                  {caAlreadyPinned && (
                    <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-xl p-3">
                      <div className="flex items-start space-x-2">
                        <span className="text-emerald-400 text-lg flex-shrink-0">✅</span>
                        <div className="text-sm text-emerald-300">
                          <p className="font-semibold mb-1">CA Identity Verified</p>
                          <p>
                            This Certification Authority's identity has been verified against
                            your saved pin. The CA DID matches your previous connection,
                            confirming this is the same trusted authority.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ✅ COMPANY IDENTITY VERIFICATION: Company Identity Section */}
            {isCompanyInvitation && companyConfig && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                    🏢 Company Identity:
                  </h3>
                  {companyAlreadyPinned ? (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      ✅ Previously Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                      🆕 First Connection (TOFU)
                    </span>
                  )}
                </div>

                {/* ✅ CA VERIFICATION: Display CA trust status */}
                {companyCAVerification && (
                  <div className={`rounded-xl p-3 ${companyCAVerification.verified ? 'bg-emerald-500/20 border border-emerald-500/30' : 'bg-yellow-500/20 border border-yellow-500/30'}`}>
                    {companyCAVerification.verified ? (
                      <div className="flex items-start space-x-2">
                        <span className="text-lg">✅</span>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-emerald-400">
                            Verified by Certification Authority
                          </p>
                          <p className="text-xs text-emerald-300 mt-1">
                            This company's identity credential was issued by <span className="font-mono font-bold">{companyCAVerification.caName}</span>, a CA you have an established connection with.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start space-x-2">
                        <span className="text-lg">⚠️</span>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-yellow-400">
                            Unverified Issuer - TOFU Applies
                          </p>
                          <p className="text-xs text-yellow-300 mt-1">
                            This company's credential was not issued by a known CA. Trust-On-First-Use (TOFU) security model applies.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="bg-gradient-to-br from-emerald-500/20 to-green-500/20 rounded-2xl border-2 border-emerald-500/30 p-5 space-y-4">
                  {/* Company Name */}
                  <div className="flex items-start space-x-3">
                    <div className="flex-shrink-0 w-12 h-12 bg-emerald-500/30 rounded-xl flex items-center justify-center">
                      <span className="text-2xl">🏢</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-400 uppercase mb-1">
                        Company Name
                      </p>
                      <p className="text-xl font-bold text-white">
                        {companyConfig.companyName}
                      </p>
                    </div>
                  </div>

                  {/* Website (if present) */}
                  {companyConfig.website && (
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Website
                      </p>
                      <a
                        href={companyConfig.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center space-x-2 text-emerald-400 hover:text-emerald-300"
                      >
                        <span>{companyConfig.website}</span>
                        <span className="text-sm">🔗</span>
                      </a>
                    </div>
                  )}

                  {/* Jurisdiction & Registration Number */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Jurisdiction
                      </p>
                      <p className="text-base font-medium text-white">
                        {companyConfig.jurisdiction}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Registration #
                      </p>
                      <p className="text-base font-medium text-white font-mono">
                        {companyConfig.registrationNumber}
                      </p>
                    </div>
                  </div>

                  {/* Industry (if present) */}
                  {companyConfig.industry && (
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Industry
                      </p>
                      <p className="text-base font-medium text-white">
                        {companyConfig.industry}
                      </p>
                    </div>
                  )}

                  {/* Address (if present) */}
                  {companyConfig.address && (
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Address
                      </p>
                      <p className="text-base font-medium text-white">
                        {companyConfig.address}
                      </p>
                    </div>
                  )}

                  {/* Contact Email (if present) */}
                  {companyConfig.contactEmail && (
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-slate-400 uppercase">
                        Contact Email
                      </p>
                      <a
                        href={`mailto:${companyConfig.contactEmail}`}
                        className="inline-flex items-center space-x-2 text-emerald-400 hover:text-emerald-300"
                      >
                        <span>{companyConfig.contactEmail}</span>
                        <span className="text-sm">📧</span>
                      </a>
                    </div>
                  )}

                  {/* Company DID */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-400 uppercase">
                      Company DID (Identifier)
                    </p>
                    <div className="flex items-center space-x-2">
                      <p className="flex-1 font-mono text-xs text-slate-300 bg-slate-800/50 px-3 py-2 rounded-xl border border-slate-700/50 break-all">
                        {companyConfig.companyDID}
                      </p>
                      <button
                        onClick={() => copyToClipboard(companyConfig.companyDID, 'Company DID')}
                        className="flex-shrink-0 p-2 text-emerald-400 hover:bg-emerald-500/20 rounded-xl transition-colors"
                        title="Copy Company DID"
                      >
                        📋
                      </button>
                    </div>
                  </div>

                  {/* TOFU Information Badge */}
                  {!companyAlreadyPinned && (
                    <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-xl p-3">
                      <div className="flex items-start space-x-2">
                        <span className="text-emerald-400 text-lg flex-shrink-0">ℹ️</span>
                        <div className="text-sm text-emerald-300">
                          <p className="font-semibold mb-1">Trust On First Use (TOFU)</p>
                          <p>
                            This is your first connection to this company.
                            By accepting, you will trust this company's identity. Future connections
                            will be verified against this saved identity to detect any changes
                            (potential man-in-the-middle attacks).
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Re-verification Badge */}
                  {companyAlreadyPinned && (
                    <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-xl p-3">
                      <div className="flex items-start space-x-2">
                        <span className="text-emerald-400 text-lg flex-shrink-0">✅</span>
                        <div className="text-sm text-emerald-300">
                          <p className="font-semibold mb-1">Company Identity Verified</p>
                          <p>
                            This company's identity has been verified against
                            your saved pin. The Company DID matches your previous connection,
                            confirming this is the same trusted company.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* VC Proof Section - Conditional rendering for RealPerson vs other types */}
            {inviterIdentity && inviterIdentity.vcProof && (
              <div className="space-y-4">
                {isRealPersonInvitation ? (
                  /* ✅ REALPERSON UX: Simplified identity display */
                  <RealPersonIdentityDisplay
                    revealedData={inviterIdentity.revealedData}
                    isVerified={inviterIdentity.isVerified}
                  />
                ) : (
                  /* Standard VC Proof display for other credential types */
                  <>
                    <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                      Attached Credential Proof:
                    </h3>
                    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                      <VCProofDisplay inviterIdentity={inviterIdentity} />
                    </div>
                  </>
                )}

                {/* ✅ PHASE 2: Show validation warnings for unverified credentials */}
                {!inviterIdentity.isVerified && inviterIdentity.validationResult.warnings && inviterIdentity.validationResult.warnings.length > 0 && (
                  <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-xl p-3">
                    <div className="flex items-start space-x-2">
                      <span className="text-yellow-400 text-lg flex-shrink-0">⚠️</span>
                      <div className="text-sm text-yellow-300">
                        <p className="font-semibold mb-1">Validation Warnings:</p>
                        <ul className="space-y-1 ml-4 list-disc">
                          {inviterIdentity.validationResult.warnings.map((warning: string, i: number) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* ✅ PHASE 2: Show validation errors if present */}
                {inviterIdentity.validationResult.errors && inviterIdentity.validationResult.errors.length > 0 && (
                  <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-3">
                    <div className="flex items-start space-x-2">
                      <span className="text-red-400 text-lg flex-shrink-0">🚨</span>
                      <div className="text-sm text-red-300">
                        <p className="font-semibold mb-1">Validation Errors:</p>
                        <ul className="space-y-1 ml-4 list-disc">
                          {inviterIdentity.validationResult.errors.map((error: string, i: number) => (
                            <li key={i}>{error}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ✅ NEW: Credential Selection Section */}
            {availableCredentials && availableCredentials.length > 0 && onVCSelectionChange && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                  Share Your Credential (Optional):
                </h3>

                <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-3">
                  {/* Credential Dropdown */}
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-300">
                      Select a credential to share:
                    </label>
                    <select
                      value={selectedVCForRequest ? JSON.stringify({ id: selectedVCForRequest.id }) : ''}
                      onChange={(e) => {
                        if (e.target.value === '') {
                          onVCSelectionChange(null);
                        } else {
                          const selectedId = JSON.parse(e.target.value).id;
                          const credential = availableCredentials.find(c => c.id === selectedId);
                          onVCSelectionChange(credential || null);
                        }
                      }}
                      className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                    >
                      <option value="">-- None (Skip credential sharing) --</option>
                      {availableCredentials.map((credential) => {
                        const credentialSubject = credential.credentialSubject || credential.vc?.credentialSubject;
                        const displayName = credentialSubject?.firstName && credentialSubject?.lastName
                          ? `${credentialSubject.firstName} ${credentialSubject.lastName}`
                          : credential.id?.substring(0, 20) || 'Unknown Credential';
                        return (
                          <option key={credential.id} value={JSON.stringify({ id: credential.id })}>
                            {displayName}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {/* Disclosure Level Selection (if credential selected) */}
                  {selectedVCForRequest && onFieldSelection && (
                    <div className="pt-4 border-t border-slate-700/50">
                      <SelectiveDisclosure
                        credential={selectedVCForRequest}
                        onFieldSelection={onFieldSelection}
                        initialLevel={isRealPersonInvitation ? 'standard' : 'minimal'}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Invitation Details Section */}
            {invitationData && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
                  Invitation Details:
                </h3>

                <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-3 text-sm">
                  {invitationData.id && (
                    <div className="flex justify-between items-center">
                      <span className="font-medium text-slate-400">Invitation ID:</span>
                      <span className="font-mono text-xs text-white">{invitationData.id.substring(0, 20)}...</span>
                    </div>
                  )}
                  {invitationData.type && (
                    <div className="flex justify-between items-center">
                      <span className="font-medium text-slate-400">Type:</span>
                      <span className="text-white">RFC 0434 Out-of-Band</span>
                    </div>
                  )}
                  {invitationData.goal && (
                    <div className="flex justify-between items-center">
                      <span className="font-medium text-slate-400">Purpose:</span>
                      <span className="text-white">{invitationData.goal}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Security Notice */}
            <div className="bg-cyan-500/20 border border-cyan-500/30 rounded-xl p-4">
              <div className="flex items-start space-x-3">
                <span className="text-cyan-400 text-xl flex-shrink-0">ℹ️</span>
                <div className="text-sm text-cyan-300">
                  <p className="font-semibold mb-1">Security Recommendation:</p>
                  <p>
                    Review the inviter's identity and attached credentials before accepting.
                    Only accept invitations from trusted sources.
                  </p>
                </div>
              </div>
            </div>

            {/* Wallet Selection Section - Collapsible */}
            {onWalletSelect && (
              <div className="space-y-3">
                {/* Collapsible Header */}
                <button
                  onClick={() => setWalletSelectionExpanded(!walletSelectionExpanded)}
                  className="w-full flex items-center justify-between text-left py-2 px-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
                >
                  <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide flex items-center space-x-2">
                    <span>🔐</span>
                    <span>Wallet Selection</span>
                  </h3>
                  <div className="flex items-center space-x-3">
                    {/* Show current selection when collapsed */}
                    {!walletSelectionExpanded && (
                      <span className="text-sm text-slate-400 flex items-center space-x-1">
                        <span>{walletType === 'local' ? '💻' : '☁️'}</span>
                        <span>{walletType === 'local' ? 'Personal' : 'Enterprise'}</span>
                      </span>
                    )}
                    <span className="text-slate-400 text-sm">{walletSelectionExpanded ? '▲' : '▼'}</span>
                  </div>
                </button>

                {/* Collapsible Content */}
                {walletSelectionExpanded && (
                  <div className="space-y-3 pl-2">
                    {/* Personal Local Wallet Option */}
                    <label
                      className={`flex items-start space-x-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        walletType === 'local'
                          ? 'border-cyan-500 bg-cyan-500/20'
                          : 'border-slate-700/50 hover:border-cyan-500/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="wallet-selection"
                        value="local"
                        checked={walletType === 'local'}
                        onChange={() => onWalletSelect('local')}
                        className="mt-1 w-4 h-4 text-cyan-500 focus:ring-cyan-500 accent-cyan-500"
                      />
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className="text-lg">💻</span>
                          <p className="font-semibold text-white">
                            Personal Local Wallet
                          </p>
                        </div>
                        <p className="text-sm text-slate-400">
                          Connection stored in your browser's local wallet (IndexedDB).
                          Full control, always available.
                        </p>
                      </div>
                    </label>

                    {/* Enterprise Cloud Wallet Option */}
                    <label
                      className={`flex items-start space-x-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        walletType === 'cloud'
                          ? 'border-cyan-500 bg-cyan-500/20'
                          : cloudConfig
                          ? 'border-slate-700/50 hover:border-cyan-500/50'
                          : 'border-slate-700/50 bg-slate-800/30 opacity-60 cursor-not-allowed'
                      }`}
                    >
                      <input
                        type="radio"
                        name="wallet-selection"
                        value="cloud"
                        checked={walletType === 'cloud'}
                        onChange={() => cloudConfig && onWalletSelect('cloud')}
                        disabled={!cloudConfig}
                        className="mt-1 w-4 h-4 text-cyan-500 focus:ring-cyan-500 accent-cyan-500 disabled:opacity-50"
                      />
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className="text-lg">☁️</span>
                          <p className="font-semibold text-white">
                            Enterprise Cloud Wallet
                            {cloudConfig && (
                              <span className="ml-2 text-xs text-emerald-400">
                                ✓ Available
                              </span>
                            )}
                          </p>
                        </div>
                        {cloudConfig ? (
                          <>
                            <p className="text-sm text-slate-400 mb-2">
                              Connection managed by {cloudConfig.enterpriseAgentName || 'Enterprise Cloud Agent'}.
                              Company-managed enterprise identity.
                            </p>
                            <div className="text-xs text-slate-500 space-y-1">
                              <p>🏢 Agent: {cloudConfig.enterpriseAgentName || 'Enterprise Agent'}</p>
                              <p>🔗 URL: {cloudConfig.enterpriseAgentUrl || 'N/A'}</p>
                            </div>
                          </>
                        ) : (
                          <p className="text-sm text-slate-500">
                            ⚠️ Enterprise wallet not configured. Accept a ServiceConfiguration VC to enable.
                          </p>
                        )}
                      </div>
                    </label>

                    {/* Info Notice */}
                    <div className="bg-amber-500/20 border border-amber-500/30 rounded-xl p-3">
                      <div className="flex items-start space-x-2">
                        <span className="text-amber-400 text-sm flex-shrink-0 mt-0.5">💡</span>
                        <p className="text-xs text-amber-300">
                          <strong>Choose carefully:</strong> This determines which wallet will store the connection.
                          Personal wallet for private connections, Enterprise wallet for company-managed identities.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="sticky bottom-0 bg-slate-900 border-t border-slate-700/50 px-6 py-4 flex items-center justify-between">
            <button
              onClick={onClose}
              className="px-4 py-2 text-slate-300 bg-transparent hover:bg-slate-800 rounded-xl transition-colors"
              disabled={isAccepting}
            >
              Close
            </button>

            {/* ✅ PHASE 3: Action buttons - Reject and Accept */}
            <div className="flex space-x-3">
              {onReject && (
                <button
                  onClick={onReject}
                  disabled={isAccepting}
                  className="px-6 py-3 bg-red-500/20 border border-red-500/30 text-red-400 font-semibold rounded-xl hover:bg-red-500/30 focus:ring-4 focus:ring-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
                >
                  ✗ Reject
                </button>
              )}
              <button
                onClick={handleAccept}
                disabled={isAccepting}
                className="px-8 py-3 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-semibold rounded-xl hover:opacity-90 focus:ring-4 focus:ring-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
              >
                {isAccepting ? '⏳ Accepting...' : '✓ Accept Invitation'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
