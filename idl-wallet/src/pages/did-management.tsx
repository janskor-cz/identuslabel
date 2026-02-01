import React, { useState, useEffect } from 'react';
import '../app/index.css';
import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector, useAppDispatch } from '@/reducers/store';
import { DBConnect } from '@/components/DBConnect';
import { PrismDIDCard } from '@/components/PrismDIDCard';
import { createLongFormPrismDID, refreshPrismDIDs } from '@/actions';
import { refreshEnterpriseDIDs } from '@/actions/enterpriseAgentActions';
import {
    FingerPrintIcon,
    PlusIcon,
    RefreshIcon,
    OfficeBuildingIcon,
    IdentificationIcon
} from '@heroicons/react/solid';
import {
    selectEnterpriseDIDs,
    selectIsEnterpriseConfigured,
    selectIsLoadingDIDs
} from '@/reducers/enterpriseAgent';

/**
 * DID Management Page
 *
 * Provides UI for creating and managing DIDs:
 * 1. Long-form PRISM DIDs (self-resolving, for credential issuance)
 * 2. Enterprise DIDs (from Cloud Agent, if configured)
 *
 * Shows all PRISM DIDs including those created during credential acceptance.
 */
const DIDManagementPage: React.FC = () => {
    const dispatch = useAppDispatch();
    const app = useMountedApp();

    // Redux state
    const prismDIDs = useAppSelector(state => state.app.prismDIDs);
    const isCreating = useAppSelector(state => state.app.isCreatingPrismDID);
    const enterpriseDIDs = useAppSelector(selectEnterpriseDIDs);
    const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
    const isLoadingEnterpriseDIDs = useAppSelector(selectIsLoadingDIDs);

    // Local state
    const [alias, setAlias] = useState('');
    const [createSuccess, setCreateSuccess] = useState<string | null>(null);
    const [createError, setCreateError] = useState<string | null>(null);

    // Get agent from Redux store via useMountedApp hook
    const agent = app.agent.instance;

    // Show all PRISM DIDs (including those created during credential acceptance)
    const displayedPrismDIDs = prismDIDs || [];

    /**
     * Load PRISM DIDs from Pluto storage
     */
    const loadPrismDIDs = async () => {
        if (agent) {
            dispatch(refreshPrismDIDs({ agent }));
        }
    };

    /**
     * Load Enterprise DIDs from Cloud Agent
     */
    const loadEnterpriseDIDs = async () => {
        if (isEnterpriseConfigured) {
            dispatch(refreshEnterpriseDIDs());
        }
    };

    /**
     * Create a new long-form PRISM DID
     */
    const handleCreatePrismDID = async () => {
        if (!agent) {
            setCreateError('Agent not initialized. Please wait for wallet to start.');
            return;
        }

        setCreateError(null);
        setCreateSuccess(null);

        try {
            const result = await dispatch(createLongFormPrismDID({
                agent,
                alias: alias.trim() || undefined,
                defaultSeed: app.defaultSeed,
                mediatorUri: 'https://identuslabel.cz/mediator'
            })).unwrap();

            setCreateSuccess(`Created: ${result.did.toString().substring(0, 50)}...`);
            setAlias('');

            // Clear success message after 5 seconds
            setTimeout(() => setCreateSuccess(null), 5000);
        } catch (error: any) {
            console.error('[DID Management] Failed to create PRISM DID:', error);
            setCreateError(error?.message || 'Failed to create PRISM DID');
        }
    };

    // Initial load
    useEffect(() => {
        loadPrismDIDs();
    }, [agent]);

    // Load enterprise DIDs when enterprise is configured
    useEffect(() => {
        if (isEnterpriseConfigured) {
            console.log('[DID Management] Enterprise configured, loading DIDs...');
            loadEnterpriseDIDs();
        }
    }, [isEnterpriseConfigured]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            console.log('[DID Management] Auto-refreshing DIDs...');
            loadPrismDIDs();
            if (isEnterpriseConfigured) {
                loadEnterpriseDIDs();
            }
        }, 30000);

        return () => clearInterval(interval);
    }, [agent, isEnterpriseConfigured]);

    return (
        <div>
            {/* Header */}
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-1">DID Management</h2>
                <p className="text-slate-400 text-sm">Create and manage your PRISM DIDs</p>
            </header>

            <DBConnect>
                <Box>
                    {/* Create Long-Form PRISM DID Section */}
                    <div className="mb-8 bg-emerald-500/20 border-2 border-emerald-500/30 rounded-2xl p-6 backdrop-blur-sm">
                        <div className="flex items-center mb-4">
                            <FingerPrintIcon className="w-8 h-8 text-emerald-400 mr-3" />
                            <h2 className="text-2xl font-semibold text-emerald-300">
                                Create Long-Form PRISM DID
                            </h2>
                        </div>

                        <p className="text-slate-300 mb-4">
                            Create a self-resolving PRISM DID for use as holder/subject in Verifiable Credentials.
                            Long-form DIDs don't require blockchain publication and can be used immediately.
                        </p>

                        <div className="flex flex-col sm:flex-row gap-4">
                            <input
                                type="text"
                                placeholder="Optional alias (e.g., 'Work Identity')"
                                value={alias}
                                onChange={(e) => setAlias(e.target.value)}
                                className="flex-1 px-4 py-2 bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50"
                                disabled={isCreating}
                            />
                            <button
                                onClick={handleCreatePrismDID}
                                disabled={isCreating || !agent}
                                className="px-6 py-2 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                            >
                                {isCreating ? (
                                    <>
                                        <RefreshIcon className="w-5 h-5 mr-2 animate-spin" />
                                        Creating...
                                    </>
                                ) : (
                                    <>
                                        <PlusIcon className="w-5 h-5 mr-2" />
                                        Create PRISM DID
                                    </>
                                )}
                            </button>
                        </div>

                        {/* Success/Error Messages */}
                        {createSuccess && (
                            <div className="mt-4 p-3 bg-emerald-500/20 border border-emerald-500/30 rounded-xl text-emerald-300 text-sm">
                                {createSuccess}
                            </div>
                        )}
                        {createError && (
                            <div className="mt-4 p-3 bg-red-500/20 border border-red-500/30 rounded-xl text-red-300 text-sm">
                                {createError}
                            </div>
                        )}
                    </div>

                    {/* My PRISM DIDs Section */}
                    <div className="mb-8">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center">
                                <FingerPrintIcon className="w-6 h-6 text-emerald-400 mr-2" />
                                <h2 className="text-xl font-semibold text-emerald-300">
                                    My PRISM DIDs ({displayedPrismDIDs.length})
                                </h2>
                            </div>
                            <button
                                onClick={loadPrismDIDs}
                                className="p-2 text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/20 rounded-xl transition-colors"
                                title="Refresh PRISM DIDs"
                            >
                                <RefreshIcon className="w-5 h-5" />
                            </button>
                        </div>

                        {displayedPrismDIDs.length === 0 ? (
                            <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-6 text-center backdrop-blur-sm">
                                <FingerPrintIcon className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                                <p className="text-slate-300">No PRISM DIDs created yet</p>
                                <p className="text-sm text-slate-500 mt-2">
                                    Create a PRISM DID with an alias above to see it here
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {displayedPrismDIDs.map((did, index) => (
                                    <PrismDIDCard key={index} did={did} index={index} agent={agent} />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Visual Separator */}
                    <div className="border-t-4 border-cyan-500/50 my-8"></div>

                    {/* Enterprise DIDs Section */}
                    <div>
                        <div className="bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-t-2xl p-4 flex items-center justify-between">
                            <div className="flex items-center">
                                <OfficeBuildingIcon className="w-8 h-8 mr-3" />
                                <h2 className="text-xl font-semibold">
                                    Enterprise DIDs (Cloud Agent) {isEnterpriseConfigured && `(${enterpriseDIDs.length})`}
                                </h2>
                            </div>
                            {isEnterpriseConfigured && (
                                <button
                                    onClick={loadEnterpriseDIDs}
                                    disabled={isLoadingEnterpriseDIDs}
                                    className="p-2 text-white hover:bg-white/20 rounded-xl transition-colors disabled:opacity-50"
                                    title="Refresh Enterprise DIDs"
                                >
                                    <RefreshIcon className={`w-5 h-5 ${isLoadingEnterpriseDIDs ? 'animate-spin' : ''}`} />
                                </button>
                            )}
                        </div>

                        {!isEnterpriseConfigured ? (
                            <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-8 text-center backdrop-blur-sm">
                                <OfficeBuildingIcon className="w-16 h-16 text-slate-600 mx-auto mb-4" />
                                <p className="text-slate-300 font-semibold mb-2">Enterprise wallet not configured</p>
                                <p className="text-sm text-slate-500">
                                    Connect to your organization's Cloud Agent by obtaining a Service Configuration credential
                                </p>
                            </div>
                        ) : isLoadingEnterpriseDIDs ? (
                            <div className="bg-slate-800/30 border-4 border-cyan-500/50 border-t-0 rounded-b-2xl p-12 backdrop-blur-sm">
                                <div className="flex justify-center">
                                    <RefreshIcon className="w-8 h-8 text-cyan-400 animate-spin" />
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
                                        <div className="flex items-center space-x-3 mb-2">
                                            <span className="text-xs font-semibold text-cyan-300 bg-cyan-500/30 px-2 py-1 rounded uppercase">
                                                {did.method || 'PRISM'}
                                            </span>
                                            <span className={`text-xs font-semibold px-2 py-1 rounded ${
                                                did.status === 'PUBLISHED'
                                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                    : did.status === 'PUBLICATION_PENDING'
                                                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                    : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                                            }`}>
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
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Refresh Info */}
                    <div className="mt-6 text-center text-sm text-slate-500">
                        Auto-refreshing every 30 seconds
                    </div>
                </Box>
            </DBConnect>
        </div>
    );
};

export default DIDManagementPage;
