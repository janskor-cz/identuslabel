/**
 * EncryptedMessageBadge Component
 *
 * Displays a classification badge on encrypted messages.
 * Shows lock icon indicating whether user can decrypt the message.
 */

import React from 'react';
import { SecurityLevel, SECURITY_LEVEL_NAMES, getLevelIcon } from '../utils/securityLevels';

interface EncryptedMessageBadgeProps {
  level: SecurityLevel;
  canDecrypt: boolean;
}

/**
 * Get badge color classes based on security level
 */
function getBadgeColorClasses(level: SecurityLevel, canDecrypt: boolean): string {
  const opacity = canDecrypt ? '' : 'opacity-90';

  switch (level) {
    case SecurityLevel.TOP_SECRET:
      return `bg-red-500 text-white border-red-600 ${opacity}`;
    case SecurityLevel.RESTRICTED:
      return `bg-orange-500 text-white border-orange-600 ${opacity}`;
    case SecurityLevel.CONFIDENTIAL:
      return `bg-yellow-500 text-white border-yellow-600 ${opacity}`;
    case SecurityLevel.INTERNAL:
    default:
      return `bg-green-500 text-white border-green-600 ${opacity}`;
  }
}

export const EncryptedMessageBadge: React.FC<EncryptedMessageBadgeProps> = ({
  level,
  canDecrypt
}) => {
  // Hide badge for internal (lowest) level messages
  if (level === SecurityLevel.INTERNAL) {
    return null;
  }

  const levelName = SECURITY_LEVEL_NAMES[level];
  const lockIcon = canDecrypt ? '🔓' : '🔒';
  const tooltipText = canDecrypt
    ? `${levelName} - You have clearance to view this message`
    : `${levelName} - Insufficient clearance to decrypt`;

  return (
    <div
      className={`
        inline-flex items-center gap-1 px-2 py-1
        rounded-md border-2 text-xs font-bold
        whitespace-nowrap
        ${getBadgeColorClasses(level, canDecrypt)}
      `}
      title={tooltipText}
      role="status"
      aria-label={tooltipText}
    >
      <span className="text-sm">{lockIcon}</span>
      <span>{levelName}</span>
    </div>
  );
};
