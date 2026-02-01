/**
 * SecurityLevelSelector Component
 *
 * Dropdown selector for message security classification levels.
 * Only displays levels the user has clearance to use.
 */

import React from 'react';
import { SecurityLevel, SECURITY_LEVEL_NAMES, getLevelColor, getLevelIcon, getAccessibleLevels } from '../utils/securityLevels';

interface SecurityLevelSelectorProps {
  selectedLevel: SecurityLevel;
  userMaxLevel: SecurityLevel;
  onChange: (level: SecurityLevel) => void;
  disabled?: boolean;
}

/**
 * Get Tailwind CSS color classes for security level badges
 */
function getBadgeColorClasses(level: SecurityLevel): string {
  switch (level) {
    case SecurityLevel.TOP_SECRET:
      return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900 dark:text-red-200 dark:border-red-700';
    case SecurityLevel.RESTRICTED:
      return 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900 dark:text-orange-200 dark:border-orange-700';
    case SecurityLevel.CONFIDENTIAL:
      return 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900 dark:text-yellow-200 dark:border-yellow-700';
    case SecurityLevel.INTERNAL:
    default:
      return 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900 dark:text-green-200 dark:border-green-700';
  }
}

/**
 * Get select dropdown color classes
 */
function getSelectColorClasses(level: SecurityLevel): string {
  switch (level) {
    case SecurityLevel.TOP_SECRET:
      return 'border-red-400 focus:border-red-500 focus:ring-red-500';
    case SecurityLevel.RESTRICTED:
      return 'border-orange-400 focus:border-orange-500 focus:ring-orange-500';
    case SecurityLevel.CONFIDENTIAL:
      return 'border-yellow-400 focus:border-yellow-500 focus:ring-yellow-500';
    case SecurityLevel.INTERNAL:
    default:
      return 'border-green-400 focus:border-green-500 focus:ring-green-500';
  }
}

export const SecurityLevelSelector: React.FC<SecurityLevelSelectorProps> = ({
  selectedLevel,
  userMaxLevel,
  onChange,
  disabled = false
}) => {
  // Get all levels the user has clearance for
  const accessibleLevels = getAccessibleLevels(userMaxLevel);

  // Check if user has no clearance (only INTERNAL available)
  const hasNoClearance = userMaxLevel === SecurityLevel.INTERNAL;

  return (
    <div className="mb-3">
      <label
        htmlFor="security-level-select"
        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        Message Classification
      </label>

      <div className="flex items-center gap-2">
        {/* Security Level Dropdown */}
        <select
          id="security-level-select"
          value={selectedLevel}
          onChange={(e) => onChange(Number(e.target.value) as SecurityLevel)}
          disabled={disabled}
          className={`
            flex-1 px-3 py-2 rounded-lg border-2
            bg-white dark:bg-gray-800
            text-gray-900 dark:text-white
            focus:outline-none focus:ring-2
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors duration-200
            text-sm font-medium
            ${getSelectColorClasses(selectedLevel)}
          `}
          aria-label="Select message security classification level"
        >
          {accessibleLevels.map((level) => (
            <option key={level} value={level}>
              {getLevelIcon(level)} {SECURITY_LEVEL_NAMES[level]}
            </option>
          ))}
        </select>

        {/* Visual Badge */}
        <div
          className={`
            px-3 py-2 rounded-lg border-2 text-xs font-bold
            whitespace-nowrap flex items-center gap-1
            ${getBadgeColorClasses(selectedLevel)}
          `}
          aria-hidden="true"
        >
          <span className="text-base">{getLevelIcon(selectedLevel)}</span>
          <span>{SECURITY_LEVEL_NAMES[selectedLevel]}</span>
        </div>
      </div>

      {/* Clearance Info Text */}
      {hasNoClearance && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          You have no Security Clearance credential. Only unclassified messages available.
        </p>
      )}

      {!hasNoClearance && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          Your clearance: <span className="font-semibold">{SECURITY_LEVEL_NAMES[userMaxLevel]}</span>
          {' '}(can send up to {SECURITY_LEVEL_NAMES[userMaxLevel]} messages)
        </p>
      )}
    </div>
  );
};
