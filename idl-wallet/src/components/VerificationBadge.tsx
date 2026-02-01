import React from 'react';
import { InviterIdentity } from '../types/invitations';

interface VerificationBadgeProps {
  inviterIdentity: InviterIdentity | null;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

export type BadgeStatus = 'verified' | 'unverified' | 'no-identity' | 'different-schema' | 'invalid';

/**
 * VerificationBadge Component
 *
 * Displays smart verification status badges based on VC proof validation results.
 *
 * Badge Types:
 * - ✅ Verified (Green): Credential is valid and matches expected schema
 * - ⚠️ Unverified (Amber): Credential present but verification failed
 * - ℹ️ Different Schema (Blue): Valid credential but uses different/unknown schema
 * - ❌ Invalid (Red): Credential is corrupted or cryptographically invalid
 * - ℹ️ No Identity (Gray): No credential attached to invitation
 *
 * Design Philosophy:
 * The badge provides immediate visual feedback about credential status without
 * blocking the user from viewing the actual credential contents.
 */
export const VerificationBadge: React.FC<VerificationBadgeProps> = ({
  inviterIdentity,
  size = 'md',
  showLabel = true
}) => {
  const badgeStatus = determineBadgeStatus(inviterIdentity);
  const badgeConfig = getBadgeConfig(badgeStatus, size, showLabel);

  return (
    <div className={badgeConfig.className}>
      <span className={badgeConfig.iconSize}>{badgeConfig.icon}</span>
      {showLabel && (
        <span className={badgeConfig.labelSize}>{badgeConfig.label}</span>
      )}
    </div>
  );
};

/**
 * Determine badge status based on inviter identity validation
 */
function determineBadgeStatus(inviterIdentity: InviterIdentity | null): BadgeStatus {
  if (!inviterIdentity) {
    return 'no-identity';
  }

  const { isVerified, validationResult } = inviterIdentity;

  // Fully verified credential
  if (isVerified) {
    return 'verified';
  }

  // Check for different schema (valid but not recognized)
  const isDifferentSchema = validationResult.errors?.some(e =>
    e.includes('different schema') ||
    e.includes('Unknown') ||
    e.includes('not recognized') ||
    e.includes('schema mismatch')
  );

  if (isDifferentSchema) {
    return 'different-schema';
  }

  // Check for invalid/corrupted credential
  const isInvalid = validationResult.errors?.some(e =>
    e.includes('Invalid') ||
    e.includes('corrupted') ||
    e.includes('signature') ||
    e.includes('verification failed')
  );

  if (isInvalid) {
    return 'invalid';
  }

  // Default: unverified
  return 'unverified';
}

/**
 * Get badge configuration based on status and size
 */
function getBadgeConfig(status: BadgeStatus, size: 'sm' | 'md' | 'lg', showLabel: boolean) {
  // Size configurations
  const sizeConfig = {
    sm: {
      containerClass: 'px-2 py-0.5 text-xs',
      iconSize: 'text-sm',
      labelSize: 'text-xs'
    },
    md: {
      containerClass: 'px-3 py-1.5 text-sm',
      iconSize: 'text-base',
      labelSize: 'text-sm'
    },
    lg: {
      containerClass: 'px-4 py-2 text-base',
      iconSize: 'text-lg',
      labelSize: 'text-base'
    }
  };

  const currentSize = sizeConfig[size];
  const baseClass = `flex items-center ${showLabel ? 'space-x-2' : ''} rounded-full font-semibold ${currentSize.containerClass}`;

  switch (status) {
    case 'verified':
      return {
        className: `${baseClass} text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-900`,
        icon: '✅',
        label: 'Verified Identity',
        iconSize: currentSize.iconSize,
        labelSize: currentSize.labelSize
      };

    case 'different-schema':
      return {
        className: `${baseClass} text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900`,
        icon: 'ℹ️',
        label: 'Different Schema',
        iconSize: currentSize.iconSize,
        labelSize: currentSize.labelSize
      };

    case 'invalid':
      return {
        className: `${baseClass} text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900`,
        icon: '❌',
        label: 'Invalid Credential',
        iconSize: currentSize.iconSize,
        labelSize: currentSize.labelSize
      };

    case 'unverified':
      return {
        className: `${baseClass} text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900`,
        icon: '⚠️',
        label: 'Unverified',
        iconSize: currentSize.iconSize,
        labelSize: currentSize.labelSize
      };

    case 'no-identity':
    default:
      return {
        className: `${baseClass} text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700`,
        icon: 'ℹ️',
        label: 'No Identity Verification',
        iconSize: currentSize.iconSize,
        labelSize: currentSize.labelSize
      };
  }
}

/**
 * Get simple text description of badge status (useful for accessibility/tooltips)
 */
export function getBadgeStatusDescription(status: BadgeStatus): string {
  switch (status) {
    case 'verified':
      return 'Credential verified successfully';
    case 'different-schema':
      return 'Valid credential but uses a different schema';
    case 'invalid':
      return 'Credential is invalid or corrupted';
    case 'unverified':
      return 'Credential could not be verified';
    case 'no-identity':
      return 'No credential attached';
    default:
      return 'Unknown status';
  }
}

/**
 * Compact badge variant (icon only, with tooltip)
 */
export const CompactVerificationBadge: React.FC<{ inviterIdentity: InviterIdentity | null }> = ({
  inviterIdentity
}) => {
  const badgeStatus = determineBadgeStatus(inviterIdentity);
  const description = getBadgeStatusDescription(badgeStatus);

  return (
    <div title={description}>
      <VerificationBadge
        inviterIdentity={inviterIdentity}
        size="sm"
        showLabel={false}
      />
    </div>
  );
};
