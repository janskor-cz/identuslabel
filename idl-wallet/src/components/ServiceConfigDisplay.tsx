/**
 * ServiceConfigDisplay Component
 *
 * Displays ServiceConfiguration Verifiable Credentials and allows
 * users to apply or remove wallet configurations.
 */

import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '@/reducers/store';
import {
  WalletConfiguration,
  ValidationResult,
  validateConfiguration,
  formatConfigurationSummary
} from '../utils/serviceConfigManager';
import {
  removeConfiguration as removeConfigFromStorage,
  ConfigurationApplicationResult
} from '../utils/configurationStorage';
import {
  applyConfiguration,
  removeConfiguration as removeConfigRedux
} from '../actions/enterpriseAgentActions';

interface ServiceConfigDisplayProps {
  config: WalletConfiguration;
  isActive: boolean;
  onApply?: (config: WalletConfiguration) => void;
  onRemove?: (credentialId: string) => void;
  onRefresh?: () => void;
}

export const ServiceConfigDisplay: React.FC<ServiceConfigDisplayProps> = ({
  config,
  isActive,
  onApply,
  onRemove,
  onRefresh
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const [showDetails, setShowDetails] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate configuration
  const validation: ValidationResult = validateConfiguration(config);

  /**
   * Handle apply configuration (using Redux)
   */
  const handleApply = async () => {
    try {
      setApplying(true);
      setError(null);

      console.log('[ServiceConfigDisplay] Applying configuration via Redux:', config.credentialId);

      // Dispatch Redux action to apply configuration
      // This will:
      // 1. Store configuration in localStorage
      // 2. Encrypt and store API key
      // 3. Create EnterpriseAgentClient
      // 4. Update Redux state
      // 5. Auto-refresh enterprise data
      await dispatch(applyConfiguration(config)).unwrap();

      console.log('[ServiceConfigDisplay] ✅ Configuration applied successfully via Redux');

      // Notify parent component
      if (onApply) {
        onApply(config);
      }

      // Refresh to show updated state
      if (onRefresh) {
        onRefresh();
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to apply configuration: ${errorMsg}`);
      console.error('[ServiceConfigDisplay] Error applying configuration:', err);
    } finally {
      setApplying(false);
    }
  };

  /**
   * Handle remove configuration
   */
  const handleRemove = async () => {
    if (!confirm(`Remove configuration for ${config.employeeName}?`)) {
      return;
    }

    try {
      console.log('[ServiceConfigDisplay] Removing configuration:', config.credentialId);

      // If this is the active configuration, use Redux to remove it
      // Otherwise, just remove from storage
      if (isActive) {
        await dispatch(removeConfigRedux()).unwrap();
      } else {
        const success = removeConfigFromStorage(config.credentialId);
        if (!success) {
          setError('Failed to remove configuration');
          return;
        }
      }

      console.log('[ServiceConfigDisplay] ✅ Configuration removed successfully');

      // Notify parent component
      if (onRemove) {
        onRemove(config.credentialId);
      }

      // Refresh to show updated state
      if (onRefresh) {
        onRefresh();
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to remove configuration: ${errorMsg}`);
      console.error('[ServiceConfigDisplay] Error removing configuration:', err);
    }
  };

  /**
   * Handle deactivate configuration (using Redux)
   */
  const handleDeactivate = async () => {
    const confirmMessage =
      '⚠️ DEACTIVATE CONFIGURATION?\n\n' +
      'This will disconnect your wallet from the enterprise agent, ' +
      'but the ServiceConfiguration credential will remain in your wallet.\n\n' +
      '✓ You can re-activate it later by clicking "Apply"\n' +
      '✓ To permanently remove, delete the credential from the Credentials page\n\n' +
      'Continue with deactivation?';

    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      console.log('[ServiceConfigDisplay] Deactivating configuration via Redux');

      // Dispatch Redux action to remove configuration
      // This will:
      // 1. Clear configuration from localStorage
      // 2. Clear encrypted API key
      // 3. Clear Redux state
      // 4. Switch back to main agent context
      await dispatch(removeConfigRedux()).unwrap();

      console.log('[ServiceConfigDisplay] ✅ Configuration deactivated successfully via Redux');

      // Refresh to show updated state
      if (onRefresh) {
        onRefresh();
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to deactivate configuration: ${errorMsg}`);
      console.error('[ServiceConfigDisplay] Error deactivating configuration:', err);
    }
  };

  // Status badge styling
  const getStatusBadgeClass = () => {
    if (isActive) return 'bg-green-500';
    if (!validation.isValid) return 'bg-red-500';
    return 'bg-gray-500';
  };

  const getStatusText = () => {
    if (isActive) return 'Active';
    if (!validation.isValid) return 'Invalid';
    return 'Available';
  };

  return (
    <div className={`bg-slate-800/30 border rounded-2xl backdrop-blur-sm p-4 mb-4 ${isActive ? 'border-emerald-500/50' : 'border-slate-700/50'}`}>
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-white">
            {config.enterpriseAgentName}
          </h3>
          <p className="text-sm text-slate-400">
            Service Configuration
          </p>
        </div>
        <span className={`px-3 py-1 rounded-full text-white text-sm ${getStatusBadgeClass()}`}>
          {getStatusText()}
        </span>
      </div>

      {/* Enterprise Agent Configuration */}
      <div className="mb-3 p-3 bg-purple-500/20 border border-purple-500/30 rounded-xl">
        <p className="text-sm font-medium text-purple-400 mb-2">📡 Enterprise Cloud Agent</p>

        <div className="mb-2">
          <p className="text-xs font-medium text-purple-300">URL</p>
          <p className="text-sm text-slate-300 font-mono break-all">{config.enterpriseAgentUrl}</p>
        </div>

        <div className="mb-2">
          <p className="text-xs font-medium text-purple-300">Name</p>
          <p className="text-sm text-slate-300">{config.enterpriseAgentName}</p>
        </div>

        <div>
          <p className="text-xs font-medium text-purple-300">API Key</p>
          <p className="text-sm text-slate-300 font-mono">
            {config.enterpriseAgentApiKey.substring(0, 16)}...{config.enterpriseAgentApiKey.substring(config.enterpriseAgentApiKey.length - 4)}
          </p>
        </div>
      </div>

      {/* Info Note */}
      <div className="mb-3 p-2 bg-slate-700/30 border border-slate-600/50 rounded-xl">
        <p className="text-xs text-slate-400">
          ℹ️ Additional information (DID, wallet ID, mediator) can be queried dynamically from the Enterprise Agent after applying this configuration.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-3 p-2 bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Validation Errors */}
      {!validation.isValid && (
        <div className="mb-3 p-2 bg-yellow-500/20 border border-yellow-500/30 rounded-xl">
          <p className="text-sm font-medium text-yellow-400">Configuration Issues:</p>
          <ul className="list-disc list-inside text-sm text-yellow-300">
            {validation.errors.map((err, index) => (
              <li key={index}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2">
        {!isActive && validation.isValid && (
          <button
            onClick={handleApply}
            disabled={applying}
            className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {applying ? 'Applying...' : '✅ Apply Configuration'}
          </button>
        )}

        {isActive && (
          <button
            onClick={handleDeactivate}
            className="px-4 py-2 bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 rounded-xl hover:bg-yellow-500/30 transition-colors"
          >
            ⏸️ Deactivate
          </button>
        )}

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="px-4 py-2 bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 text-slate-300 rounded-xl transition-colors"
        >
          {showDetails ? '▲ Hide Details' : '▼ Show Details'}
        </button>

        {!isActive && (
          <button
            onClick={handleRemove}
            className="px-4 py-2 bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl hover:bg-red-500/30 transition-colors ml-auto"
          >
            🗑️ Remove
          </button>
        )}
      </div>

      {/* Detailed View */}
      {showDetails && (
        <div className="mt-4 pt-4 border-t border-slate-700/50">
          <h4 className="text-sm font-semibold text-white mb-2">Configuration Details</h4>

          {/* Full API Key */}
          <div className="mb-3">
            <p className="text-sm font-medium text-slate-300">Full API Key</p>
            <p className="text-xs text-slate-400 font-mono break-all">
              {config.enterpriseAgentApiKey}
            </p>
          </div>

          {/* Full URL */}
          <div className="mb-3">
            <p className="text-sm font-medium text-slate-300">Enterprise Agent URL</p>
            <p className="text-xs text-slate-400 font-mono break-all">
              {config.enterpriseAgentUrl}
            </p>
          </div>

          {/* Validation Warnings */}
          {validation.warnings.length > 0 && (
            <div className="mb-3">
              <p className="text-sm font-medium text-slate-300 mb-1">Warnings</p>
              <ul className="list-disc list-inside text-sm text-slate-400">
                {validation.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* VC Metadata */}
          <div className="text-xs text-slate-500">
            <p>VC ID: {config.vcId}</p>
            <p>Credential ID: {config.credentialId}</p>
            {config.appliedAt && (
              <p>Applied: {new Date(config.appliedAt).toLocaleString()}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ServiceConfigDisplay;
