/**
 * Service Configuration Manager
 *
 * Utilities for managing ServiceConfiguration Verifiable Credentials
 * received from enterprise cloud agents via DIDComm.
 *
 * Minimal Structure (3 fields):
 * - enterpriseAgentUrl: HTTPS endpoint of Enterprise Cloud Agent
 * - enterpriseAgentName: Display name of the agent
 * - enterpriseAgentApiKey: 64-character hex authentication key
 *
 * All other information (employeePrismDid, walletId, mediator, services, etc.)
 * should be queried dynamically after configuration is applied.
 *
 * Responsibilities:
 * - Extract minimal configuration from ServiceConfiguration VCs
 * - Validate configuration structure
 * - Format configuration for storage and usage
 */

/**
 * Minimal parsed configuration from ServiceConfiguration VC
 */
export interface WalletConfiguration {
  // VC Metadata
  vcId: string;
  credentialId: string;

  // Enterprise Cloud Agent Configuration (4 fields from VC v3.0.0)
  enterpriseAgentUrl: string;
  enterpriseAgentName: string;
  enterpriseAgentApiKey: string;
  enterpriseAgentWalletId: string;

  // Application Status
  appliedAt?: number; // timestamp when configuration was applied
  isActive: boolean;
}

/**
 * Configuration validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Extract minimal configuration from ServiceConfiguration VC
 *
 * @param credential - The ServiceConfiguration credential (JWT format)
 * @returns Parsed configuration or null if invalid
 */
export function extractConfiguration(credential: any): WalletConfiguration | null {
  try {
    console.log('[ServiceConfigManager] Extracting minimal configuration from VC');

    // Extract credential subject from various possible locations
    let credentialSubject: any;
    let vcId: string;
    let extractionSource: string;

    // Try credential.credentialSubject first (most common)
    if (credential.credentialSubject) {
      credentialSubject = credential.credentialSubject;
      vcId = credential.id || 'unknown';
      extractionSource = 'credentialSubject';
    }
    // Try credential.claims[0] (SDK format)
    else if (credential.claims && Array.isArray(credential.claims) && credential.claims[0]) {
      credentialSubject = credential.claims[0];
      vcId = credential.id || 'unknown';
      extractionSource = 'claims[0]';
    }
    // Try credential.vc.credentialSubject (JWT format)
    else if (credential.vc?.credentialSubject) {
      credentialSubject = credential.vc.credentialSubject;
      vcId = credential.id || credential.vc.id || 'unknown';
      extractionSource = 'vc.credentialSubject';
    }
    else {
      console.error('[ServiceConfigManager] Invalid credential structure: no credentialSubject found');
      console.error('[ServiceConfigManager] Credential keys:', Object.keys(credential));
      return null;
    }

    console.log(`[ServiceConfigManager] Extracted from: ${extractionSource}`);
    console.log('[ServiceConfigManager] credentialSubject keys:', Object.keys(credentialSubject));

    // Extract the 4 required fields (v3.0.0 schema)
    const enterpriseAgentUrl = credentialSubject.enterpriseAgentUrl;
    const enterpriseAgentName = credentialSubject.enterpriseAgentName;
    const enterpriseAgentApiKey = credentialSubject.enterpriseAgentApiKey;
    const enterpriseAgentWalletId = credentialSubject.enterpriseAgentWalletId;

    console.log('[ServiceConfigManager] Extracted fields:', {
      enterpriseAgentUrl,
      enterpriseAgentName,
      enterpriseAgentWalletId,
      apiKeyLength: enterpriseAgentApiKey?.length || 0
    });

    const config: WalletConfiguration = {
      vcId,
      credentialId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Random ID
      enterpriseAgentUrl,
      enterpriseAgentName,
      enterpriseAgentApiKey,
      enterpriseAgentWalletId,
      isActive: false // Not applied yet
    };

    console.log('[ServiceConfigManager] ✅ Minimal configuration extracted successfully');

    return config;

  } catch (error) {
    console.error('[ServiceConfigManager] Error extracting configuration:', error);
    return null;
  }
}

/**
 * Validate minimal configuration structure
 *
 * @param config - Configuration to validate
 * @returns Validation result with errors and warnings
 */
export function validateConfiguration(config: WalletConfiguration): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate the 4 required fields (v3.0.0 schema)
  if (!config.enterpriseAgentUrl) {
    errors.push('Missing enterpriseAgentUrl');
  } else {
    // Validate URL format
    try {
      new URL(config.enterpriseAgentUrl);
    } catch (e) {
      errors.push('Invalid enterpriseAgentUrl format');
    }
  }

  if (!config.enterpriseAgentName) {
    errors.push('Missing enterpriseAgentName');
  }

  if (!config.enterpriseAgentApiKey) {
    errors.push('Missing enterpriseAgentApiKey');
  } else if (config.enterpriseAgentApiKey.length !== 64) {
    errors.push('Invalid enterpriseAgentApiKey (must be 64-character hex string)');
  }

  if (!config.enterpriseAgentWalletId) {
    errors.push('Missing enterpriseAgentWalletId');
  }

  const isValid = errors.length === 0;

  if (isValid) {
    console.log('[ServiceConfigManager] ✅ Minimal configuration validation passed');
  } else {
    console.error('[ServiceConfigManager] ❌ Configuration validation failed:', errors);
  }

  if (warnings.length > 0) {
    console.warn('[ServiceConfigManager] ⚠️ Configuration warnings:', warnings);
  }

  return { isValid, errors, warnings };
}

/**
 * Format configuration for display
 *
 * @param config - Configuration to format
 * @returns Human-readable configuration summary
 */
export function formatConfigurationSummary(config: WalletConfiguration): string {
  return `${config.enterpriseAgentName} (${config.enterpriseAgentUrl})`;
}

/**
 * Compare two configurations to determine if they are different
 *
 * @param config1 - First configuration
 * @param config2 - Second configuration
 * @returns True if configurations are different
 */
export function isConfigurationDifferent(
  config1: WalletConfiguration,
  config2: WalletConfiguration
): boolean {
  // Compare key fields that would constitute a different configuration
  return (
    config1.enterpriseAgentUrl !== config2.enterpriseAgentUrl ||
    config1.enterpriseAgentName !== config2.enterpriseAgentName ||
    config1.enterpriseAgentApiKey !== config2.enterpriseAgentApiKey ||
    config1.enterpriseAgentWalletId !== config2.enterpriseAgentWalletId
  );
}

/**
 * Check if a configuration has expired
 *
 * ServiceConfiguration credentials do not expire at the configuration level.
 * Expiration is managed through the underlying Verifiable Credential's
 * validity period (issuedDate/expiryDate) and revocation status.
 *
 * @param config - Configuration to check
 * @returns Always false (configurations do not expire)
 */
export function isConfigurationExpired(config: WalletConfiguration): boolean {
  // Configurations do not have independent expiration logic
  // The underlying VC's validity should be checked separately via:
  // 1. VC expiryDate field
  // 2. StatusList2021 revocation check
  return false;
}
