/**
 * Enhanced Credential Card Component
 *
 * Modern credential card with:
 * - Expand/collapse functionality (collapsed by default)
 * - Type-specific layouts (ID card vs Certificate)
 * - Status badges (Valid/Revoked/Expired)
 * - Smooth animations
 *
 * Created: November 2, 2025
 * Purpose: Enhanced visual presentation replacing simple Credential.tsx
 */

import React, { useState } from 'react';
import { ChevronRightIcon, ChevronDownIcon, TrashIcon } from '@heroicons/react/solid';
import { getCredentialLayout } from './CredentialCardTypeLayouts';
import {
  getCredentialType,
  getCredentialHolderName,
  isCredentialExpired
} from '@/utils/credentialTypeDetector';
import { checkCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';

interface CredentialCardProps {
  credential: any;
  onDelete?: (credential: any) => void;
  status?: CredentialStatus;
}

/**
 * Enhanced Credential Card
 *
 * Displays credential in collapsed or expanded state:
 * - Collapsed: Name + Type badge + Status badge + Expand button
 * - Expanded: Full type-specific layout with all details
 */
export function CredentialCard({ credential, onDelete, status }: CredentialCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Get credential metadata
  const credentialType = getCredentialType(credential);
  const holderName = getCredentialHolderName(credential);
  const isExpired = isCredentialExpired(credential);

  // Determine overall status
  const displayStatus = isExpired ? 'expired' : (status === 'revoked' ? 'revoked' : 'valid');

  // Get type display name and icon
  const getTypeInfo = () => {
    switch (credentialType) {
      case 'RealPersonIdentity':
        return { name: 'Identity', icon: '🪪', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' };
      case 'SecurityClearance':
        return { name: 'Clearance', icon: '🛡️', color: 'bg-red-500/20 text-red-400 border-red-500/30' };
      case 'ServiceConfiguration':
        return { name: 'Enterprise Config', icon: '🏢', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' };
      case 'EmployeeRole':
        return { name: 'Employee Role', icon: '👔', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' };
      default:
        return { name: 'Unknown', icon: '❓', color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' };
    }
  };

  const typeInfo = getTypeInfo();

  // Get status badge
  const getStatusBadge = () => {
    switch (displayStatus) {
      case 'valid':
        return <span className="px-2 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-full">✓ Valid</span>;
      case 'revoked':
        return <span className="px-2 py-1 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-full">✗ REVOKED</span>;
      case 'expired':
        return <span className="px-2 py-1 text-xs font-semibold bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded-full">⏱️ EXPIRED</span>;
      default:
        return <span className="px-2 py-1 text-xs font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-full">? Unknown</span>;
    }
  };

  // Handle delete
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent expand/collapse when clicking delete

    if (!onDelete) return;

    const confirmed = window.confirm(`Are you sure you want to delete this credential?\n\n${holderName} (${typeInfo.name})`);

    if (confirmed) {
      setIsDeleting(true);
      try {
        await onDelete(credential);
      } catch (error) {
        console.error('Failed to delete credential:', error);
        alert('Failed to delete credential. Please try again.');
        setIsDeleting(false);
      }
    }
  };

  return (
    <div className={`bg-slate-800/30 border border-slate-700/50 rounded-2xl backdrop-blur-sm overflow-hidden transition-all duration-200 ${
      isExpanded ? 'shadow-lg' : 'shadow-md hover:shadow-lg'
    } ${isDeleting ? 'opacity-50' : ''}`}>
      {/* Collapsed View - Always Visible */}
      <div
        className="p-4 cursor-pointer hover:bg-slate-700/30 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          {/* Left: Name + Type */}
          <div className="flex items-center gap-3 flex-1">
            {/* Expand/Collapse Icon */}
            <div className="flex-shrink-0">
              {isExpanded ? (
                <ChevronDownIcon className="w-5 h-5 text-slate-400" />
              ) : (
                <ChevronRightIcon className="w-5 h-5 text-slate-400" />
              )}
            </div>

            {/* Credential Name */}
            <div className="flex-1">
              <div className="font-semibold text-white">{holderName}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`px-2 py-0.5 text-xs font-medium border rounded-full ${typeInfo.color}`}>
                  {typeInfo.icon} {typeInfo.name}
                </span>
              </div>
            </div>
          </div>

          {/* Right: Status Badge + Delete Button */}
          <div className="flex items-center gap-3">
            {getStatusBadge()}

            {onDelete && (
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="p-2 rounded-xl hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                title="Delete credential"
              >
                <TrashIcon className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded View - Type-Specific Layout */}
      {isExpanded && (
        <div className="border-t border-slate-700/50 p-4 bg-slate-900/30 animate-fadeIn">
          {getCredentialLayout(credential)}

          {/* Issuer Information */}
          <div className="mt-4 pt-4 border-t border-slate-700/50">
            <div className="text-xs text-slate-400">
              <span className="font-semibold">Issuer:</span>{' '}
              <span className="font-mono">{credential.issuer || 'Unknown'}</span>
            </div>
            {credential.id && (
              <div className="text-xs text-slate-400 mt-1">
                <span className="font-semibold">Credential ID:</span>{' '}
                <span className="font-mono text-xs">{credential.id}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default CredentialCard;
