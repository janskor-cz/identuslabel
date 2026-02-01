import React, { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/reducers/store';
import {
  selectEnterpriseDIDs,
  selectIsEnterpriseConfigured,
  selectIsLoadingDIDs,
  selectEnterpriseClient,
  startLoadingDIDs,
  setEnterpriseDIDs,
  setError
} from '@/reducers/enterpriseAgent';
import { ClipboardCopyIcon, CheckCircleIcon, IdentificationIcon, OfficeBuildingIcon } from '@heroicons/react/solid';

/**
 * DIDs Page
 *
 * Displays DIDs from both:
 * 1. Personal DIDs (Edge Wallet SDK)
 * 2. Enterprise DIDs (Cloud Agent API) - if Service Configuration VC present
 *
 * Features:
 * - Dual-section layout with visual separator
 * - Copy to clipboard functionality
 * - Auto-refresh every 30 seconds
 * - Loading and empty states
 */
const DIDsPage: React.FC = () => {
  const dispatch = useAppDispatch();

  // Redux state
  const enterpriseDIDs = useAppSelector(selectEnterpriseDIDs);
  const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
  const isLoadingEnterpriseDIDs = useAppSelector(selectIsLoadingDIDs);
  const enterpriseClient = useAppSelector(selectEnterpriseClient);

  // Local state
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [copiedDID, setCopiedDID] = useState<string | null>(null);
  const [personalDIDs, setPersonalDIDs] = useState<any[]>([]);
  const [loadingPersonalDIDs, setLoadingPersonalDIDs] = useState(true);

  /**
   * Load personal DIDs from edge wallet SDK
   */
  const loadPersonalDIDs = async () => {
    try {
      setLoadingPersonalDIDs(true);

      // Get agent from Redux store
      const agent = (window as any).agent;

      if (!agent || !agent.pluto) {
        console.log('[DIDs] Agent not initialized yet');
        setPersonalDIDs([]);
        setLoadingPersonalDIDs(false);
        return;
      }

      // Get all DIDs from Pluto storage
      const dids = await agent.pluto.getAllPeerDIDs();

      console.log('[DIDs] Loaded', dids.length, 'personal DIDs from edge wallet');
      setPersonalDIDs(dids || []);
    } catch (error) {
      console.error('[DIDs] Error loading personal DIDs:', error);
      setPersonalDIDs([]);
    } finally {
      setLoadingPersonalDIDs(false);
    }
  };

  /**
   * Load enterprise DIDs from Cloud Agent API
   */
  const loadEnterpriseDIDs = async () => {
    if (!isEnterpriseConfigured || !enterpriseClient) {
      console.log('[DIDs] Enterprise not configured, skipping enterprise DIDs fetch');
      return;
    }

    try {
      dispatch(startLoadingDIDs());

      const response = await enterpriseClient.listDIDs();

      console.log('[DIDs] Loaded', response.contents?.length || 0, 'enterprise DIDs from Cloud Agent');

      // Transform Cloud Agent response to EnterpriseDID format
      const dids = (response.contents || []).map((did: any) => ({
        did: did.did,
        status: did.status,
        method: did.method || 'prism',
        createdAt: did.createdAt,
        updatedAt: did.updatedAt
      }));

      dispatch(setEnterpriseDIDs(dids));
    } catch (error: any) {
      console.error('[DIDs] Error loading enterprise DIDs:', error);
      dispatch(setError(error.message || 'Failed to load enterprise DIDs'));
      dispatch(setEnterpriseDIDs([]));
    }
  };

  /**
   * Copy DID to clipboard
   */
  const copyToClipboard = (did: string) => {
    navigator.clipboard.writeText(did).then(() => {
      setCopiedDID(did);
      setTimeout(() => setCopiedDID(null), 2000);
    });
  };

  /**
   * Format DID for display (truncate middle)
   */
  const formatDID = (did: string): string => {
    if (did.length <= 40) return did;
    return `${did.substring(0, 20)}...${did.substring(did.length - 20)}`;
  };

  /**
   * Initial load
   */
  useEffect(() => {
    loadPersonalDIDs();
    loadEnterpriseDIDs();
  }, [refreshKey]);

  /**
   * Auto-refresh every 30 seconds
   */
  useEffect(() => {
    const interval = setInterval(() => {
      console.log('[DIDs] Auto-refreshing DIDs...');
      setRefreshKey(prev => prev + 1);
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6 text-gray-800">Decentralized Identifiers (DIDs)</h1>

      {/* Personal DIDs Section */}
      <div className="mb-8">
        <div className="flex items-center mb-4">
          <IdentificationIcon className="w-8 h-8 text-purple-600 mr-3" />
          <h2 className="text-2xl font-semibold text-gray-700">Personal DIDs</h2>
        </div>

        {loadingPersonalDIDs ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
          </div>
        ) : personalDIDs.length === 0 ? (
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-8 text-center backdrop-blur-sm">
            <IdentificationIcon className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-300">No personal DIDs found</p>
            <p className="text-sm text-slate-500 mt-2">
              DIDs will appear here after connecting to services
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {personalDIDs.map((did, index) => {
              const didString = did.toString();
              return (
                <div
                  key={index}
                  className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-4 hover:shadow-md transition-shadow backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <span className="text-xs font-semibold text-purple-400 bg-purple-500/20 border border-purple-500/30 px-2 py-1 rounded">
                          PEER
                        </span>
                        <span className="text-sm text-slate-300 font-mono">
                          {formatDID(didString)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => copyToClipboard(didString)}
                      className="ml-4 p-2 text-slate-400 hover:text-purple-400 hover:bg-purple-500/20 rounded-xl transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedDID === didString ? (
                        <CheckCircleIcon className="w-5 h-5 text-green-600" />
                      ) : (
                        <ClipboardCopyIcon className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Visual Separator */}
      <div className="border-t-4 border-cyan-500/50 my-8"></div>

      {/* Enterprise DIDs Section */}
      <div>
        <div className="bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-t-2xl p-4 flex items-center">
          <OfficeBuildingIcon className="w-8 h-8 mr-3" />
          <h2 className="text-2xl font-semibold">Enterprise DIDs (Cloud Agent)</h2>
        </div>

        {!isEnterpriseConfigured ? (
          <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-8 text-center backdrop-blur-sm">
            <OfficeBuildingIcon className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-300 font-semibold mb-2">Enterprise wallet not configured</p>
            <p className="text-sm text-slate-500">
              Connect to your organization&apos;s Cloud Agent by obtaining a Service Configuration credential
            </p>
          </div>
        ) : isLoadingEnterpriseDIDs ? (
          <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-12 backdrop-blur-sm">
            <div className="flex justify-center items-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400"></div>
            </div>
          </div>
        ) : enterpriseDIDs.length === 0 ? (
          <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-8 text-center backdrop-blur-sm">
            <IdentificationIcon className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-300">No enterprise DIDs found</p>
            <p className="text-sm text-slate-500 mt-2">
              Enterprise DIDs will appear here after they are created in your Cloud Agent
            </p>
          </div>
        ) : (
          <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-6 space-y-3 backdrop-blur-sm">
            {enterpriseDIDs.map((did, index) => (
              <div
                key={index}
                className="bg-cyan-500/20 border border-cyan-500/30 rounded-xl p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-3 mb-2">
                      <span className="text-xs font-semibold text-cyan-300 bg-cyan-500/30 px-2 py-1 rounded uppercase">
                        {did.method || 'PRISM'}
                      </span>
                      <span
                        className={`text-xs font-semibold px-2 py-1 rounded ${
                          did.status === 'PUBLISHED'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : did.status === 'PUBLICATION_PENDING'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                        }`}
                      >
                        {did.status}
                      </span>
                    </div>
                    <div className="text-sm text-slate-300 font-mono break-all">
                      {did.did}
                    </div>
                    {did.createdAt && (
                      <div className="text-xs text-slate-500 mt-2">
                        Created: {new Date(did.createdAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => copyToClipboard(did.did)}
                    className="ml-4 p-2 text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/20 rounded-xl transition-colors flex-shrink-0"
                    title="Copy to clipboard"
                  >
                    {copiedDID === did.did ? (
                      <CheckCircleIcon className="w-5 h-5 text-green-600" />
                    ) : (
                      <ClipboardCopyIcon className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Refresh Info */}
      <div className="mt-6 text-center text-sm text-slate-500">
        Auto-refreshing every 30 seconds
      </div>
    </div>
  );
};

export default DIDsPage;
