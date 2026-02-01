/**
 * Configuration Storage Utility
 *
 * Manages persistence of ServiceConfiguration data in localStorage
 * using wallet-specific prefixes to avoid collisions.
 *
 * Storage structure:
 * - wallet-{walletId}-active-configuration: Currently active configuration
 * - wallet-{walletId}-all-configurations: Array of all received configurations
 * - wallet-{walletId}-config-{configId}: Individual configuration details
 */

import { getItem, setItem, removeItem, getKeysByPattern } from './prefixedStorage';
import {
  WalletConfiguration,
  isConfigurationExpired,
  isConfigurationDifferent
} from './serviceConfigManager';
import {
  STORAGE_KEYS,
  ConfigurationStatus,
  StoredConfiguration,
  ConfigurationApplicationResult
} from '../types/configuration';

/**
 * Store a new configuration
 *
 * @param config - Configuration to store
 * @returns Success status
 */
export function storeConfiguration(config: WalletConfiguration): boolean {
  try {
    // Get existing configurations
    const allConfigs = getAllConfigurations();

    // Check if this configuration already exists
    const existingIndex = allConfigs.findIndex(
      stored => stored.config.vcId === config.vcId
    );

    const storedConfig: StoredConfiguration = {
      config,
      status: ConfigurationStatus.NOT_APPLIED,
      appliedAt: undefined,
      lastUsed: undefined
    };

    // 🔧 NEW: Check if a DIFFERENT configuration is already active
    const activeConfig = getActiveConfiguration();

    if (activeConfig && activeConfig.vcId !== config.vcId) {
      console.warn('[ConfigStorage] ⚠️ CONFLICT DETECTED: Different configuration already active!');
      console.warn('[ConfigStorage] Active config:', activeConfig.enterpriseAgentName);
      console.warn('[ConfigStorage] New config:', config.enterpriseAgentName);
      console.error('[ConfigStorage] ❌ Cannot store multiple configurations. Deactivate the current configuration first.');

      // Prevent storage to avoid conflicts
      throw new Error(
        `Configuration conflict: "${activeConfig.enterpriseAgentName}" is already active. ` +
        `Please deactivate it before storing "${config.enterpriseAgentName}".`
      );
    }

    if (existingIndex >= 0) {
      // Update existing configuration
      allConfigs[existingIndex] = storedConfig;
    } else {
      // Add new configuration
      allConfigs.push(storedConfig);
    }

    // Store updated list
    setItem(STORAGE_KEYS.ALL_CONFIGS, allConfigs);

    // Store individual config for direct access
    setItem(`config-${config.credentialId}`, storedConfig);

    return true;

  } catch (error) {
    console.error('[ConfigStorage] Error storing configuration:', error);
    return false;
  }
}

/**
 * Get all stored configurations
 *
 * @returns Array of stored configurations
 */
export function getAllConfigurations(): StoredConfiguration[] {
  try {
    const configs = getItem(STORAGE_KEYS.ALL_CONFIGS);
    return Array.isArray(configs) ? configs : [];
  } catch (error) {
    console.error('[ConfigStorage] Error getting configurations:', error);
    return [];
  }
}

/**
 * Get configuration by credential ID
 *
 * @param credentialId - Configuration credential ID
 * @returns Stored configuration or null
 */
export function getConfiguration(credentialId: string): StoredConfiguration | null {
  try {
    const config = getItem(`config-${credentialId}`);
    return config || null;
  } catch (error) {
    console.error('[ConfigStorage] Error getting configuration:', error);
    return null;
  }
}

/**
 * Get active configuration
 *
 * @returns Active configuration or null if none active
 */
export function getActiveConfiguration(): WalletConfiguration | null {
  try {
    const stored = getItem(STORAGE_KEYS.ACTIVE_CONFIG);

    if (!stored) {
      return null;
    }

    // Check if configuration is expired
    if (isConfigurationExpired(stored)) {
      console.warn('[ConfigStorage] Active configuration is expired');
      // Clear expired active configuration
      removeItem(STORAGE_KEYS.ACTIVE_CONFIG);
      return null;
    }

    return stored;

  } catch (error) {
    console.error('[ConfigStorage] Error getting active configuration:', error);
    return null;
  }
}

/**
 * Set active configuration
 *
 * @param config - Configuration to set as active
 * @returns Application result
 */
export function setActiveConfiguration(
  config: WalletConfiguration
): ConfigurationApplicationResult {
  try {
    // Validate configuration is not expired
    if (isConfigurationExpired(config)) {
      return {
        success: false,
        configId: config.credentialId,
        message: 'Cannot apply expired configuration',
        error: 'EXPIRED'
      };
    }

    // Get current active configuration
    const currentActive = getActiveConfiguration();

    // If there's an active config and it's different, warn user
    if (currentActive && isConfigurationDifferent(currentActive, config)) {
      console.warn('[ConfigStorage] Replacing different active configuration');
    }

    // Mark configuration as applied
    const updatedConfig: WalletConfiguration = {
      ...config,
      appliedAt: Date.now(),
      isActive: true
    };

    // Store as active
    setItem(STORAGE_KEYS.ACTIVE_CONFIG, updatedConfig);

    // Note: API key is stored directly in the configuration object (signed VC)
    // No encryption needed - the VC signature provides integrity protection
    // and IndexedDB provides browser-level access control

    // Update in all configurations list
    const allConfigs = getAllConfigurations();
    const index = allConfigs.findIndex(
      stored => stored.config.vcId === config.vcId
    );

    if (index >= 0) {
      allConfigs[index].status = ConfigurationStatus.APPLIED;
      allConfigs[index].appliedAt = Date.now();
      setItem(STORAGE_KEYS.ALL_CONFIGS, allConfigs);

      // Update individual stored config
      setItem(`config-${config.credentialId}`, allConfigs[index]);
    }

    return {
      success: true,
      configId: config.credentialId,
      message: 'Configuration applied successfully'
    };

  } catch (error) {
    console.error('[ConfigStorage] Error setting active configuration:', error);
    return {
      success: false,
      configId: config.credentialId,
      message: 'Failed to apply configuration',
      error: String(error)
    };
  }
}

/**
 * Clear active configuration
 *
 * @returns Success status
 */
export function clearActiveConfiguration(): boolean {
  try {
    const activeConfig = getActiveConfiguration();

    if (activeConfig) {
      // Note: API key is stored in the configuration object itself
      // No separate encrypted storage to clear

      // Update status in all configurations
      const allConfigs = getAllConfigurations();
      const index = allConfigs.findIndex(
        stored => stored.config.vcId === activeConfig.vcId
      );

      if (index >= 0) {
        allConfigs[index].status = ConfigurationStatus.NOT_APPLIED;
        allConfigs[index].appliedAt = undefined;
        setItem(STORAGE_KEYS.ALL_CONFIGS, allConfigs);

        // Update individual stored config
        setItem(`config-${activeConfig.credentialId}`, allConfigs[index]);
      }
    }

    // Remove active configuration
    removeItem(STORAGE_KEYS.ACTIVE_CONFIG);

    return true;

  } catch (error) {
    console.error('[ConfigStorage] Error clearing active configuration:', error);
    return false;
  }
}

/**
 * Remove configuration permanently
 *
 * @param credentialId - Configuration credential ID to remove
 * @returns Success status
 */
export function removeConfiguration(credentialId: string): boolean {
  try {
    // Get all configurations
    const allConfigs = getAllConfigurations();

    // Find the configuration being removed
    const configToRemove = allConfigs.find(
      stored => stored.config.credentialId === credentialId
    );

    if (!configToRemove) {
      console.warn('[ConfigStorage] Configuration not found:', credentialId);
      return false;
    }

    // Note: API key is stored in the configuration object itself
    // No separate encrypted storage to clear

    // Filter out the configuration to remove
    const filtered = allConfigs.filter(
      stored => stored.config.credentialId !== credentialId
    );

    // Update all configurations list
    setItem(STORAGE_KEYS.ALL_CONFIGS, filtered);

    // Remove individual config
    removeItem(`config-${credentialId}`);

    // If this was the active configuration, clear it
    const activeConfig = getActiveConfiguration();
    if (activeConfig && activeConfig.credentialId === credentialId) {
      removeItem(STORAGE_KEYS.ACTIVE_CONFIG);
    }

    return true;

  } catch (error) {
    console.error('[ConfigStorage] Error removing configuration:', error);
    return false;
  }
}

/**
 * Clear all configurations
 *
 * @returns Success status
 */
export function clearAllConfigurations(): boolean {
  try {
    // Clear all configurations list
    removeItem(STORAGE_KEYS.ALL_CONFIGS);

    // Clear active configuration
    removeItem(STORAGE_KEYS.ACTIVE_CONFIG);

    // Clear individual configs
    const configKeys = getKeysByPattern('config-');
    configKeys.forEach(key => removeItem(key));

    return true;

  } catch (error) {
    console.error('[ConfigStorage] Error clearing all configurations:', error);
    return false;
  }
}

/**
 * Get configuration statistics
 *
 * @returns Configuration statistics
 */
export function getConfigurationStats(): {
  total: number;
  applied: number;
  expired: number;
  pending: number;
} {
  try {
    const allConfigs = getAllConfigurations();

    const stats = {
      total: allConfigs.length,
      applied: 0,
      expired: 0,
      pending: 0
    };

    allConfigs.forEach(stored => {
      if (stored.status === ConfigurationStatus.APPLIED) {
        stats.applied++;
      } else if (isConfigurationExpired(stored.config)) {
        stats.expired++;
      } else {
        stats.pending++;
      }
    });

    return stats;

  } catch (error) {
    console.error('[ConfigStorage] Error getting configuration stats:', error);
    return { total: 0, applied: 0, expired: 0, pending: 0 };
  }
}

/**
 * Update configuration last used timestamp
 *
 * @param credentialId - Configuration credential ID
 */
export function updateLastUsed(credentialId: string): void {
  try {
    const allConfigs = getAllConfigurations();
    const index = allConfigs.findIndex(
      stored => stored.config.credentialId === credentialId
    );

    if (index >= 0) {
      allConfigs[index].lastUsed = Date.now();
      setItem(STORAGE_KEYS.ALL_CONFIGS, allConfigs);
      setItem(`config-${credentialId}`, allConfigs[index]);
    }

  } catch (error) {
    console.error('[ConfigStorage] Error updating last used:', error);
  }
}
