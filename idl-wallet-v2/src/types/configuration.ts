/**
 * TypeScript type definitions for ServiceConfiguration system
 */

import { WalletConfiguration, ServiceEndpoint, ValidationResult } from '../utils/serviceConfigManager';

// Re-export types from serviceConfigManager for convenience
export type { WalletConfiguration, ServiceEndpoint, ValidationResult };

/**
 * Configuration storage key format
 */
export const STORAGE_KEYS = {
  ACTIVE_CONFIG: 'active-configuration',
  ALL_CONFIGS: 'all-configurations',
  ENCRYPTED_API_KEY: 'encrypted-api-key'
} as const;

/**
 * Configuration application status
 */
export enum ConfigurationStatus {
  NOT_APPLIED = 'not_applied',
  APPLIED = 'applied',
  EXPIRED = 'expired',
  ERROR = 'error'
}

/**
 * Configuration application result
 */
export interface ConfigurationApplicationResult {
  success: boolean;
  configId: string;
  message: string;
  error?: string;
}

/**
 * Stored configuration metadata
 */
export interface StoredConfiguration {
  config: WalletConfiguration;
  status: ConfigurationStatus;
  appliedAt?: number;
  lastUsed?: number;
  errorMessage?: string;
}
