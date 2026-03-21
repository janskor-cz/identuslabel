
import React, { useState, useEffect } from "react";

import '../app/index.css'
import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { useAppSelector } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { Credential } from "@/components/Credential";
import { CredentialCard } from "@/components/CredentialCard";
import { getCredentialLayout } from '@/components/CredentialCardTypeLayouts';
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { verifyCredentialStatus } from "@/utils/credentialStatus";
import {
    getCredentialType,
    isCredentialExpired,
    sortCredentialsAlphabetically,
    getEnterpriseCredentialType,
    getEnterpriseAttr
} from "@/utils/credentialTypeDetector";
import { IdentificationIcon, ShieldCheckIcon, ClockIcon, OfficeBuildingIcon } from '@heroicons/react/solid';
import {
    selectEnterpriseCredentials,
    selectIsEnterpriseConfigured,
    selectIsLoadingCredentials,
    selectActiveConfiguration
} from "@/reducers/enterpriseAgent";

// ====================================================================
// STATUS CHECK CACHE - Prevents WebAssembly memory leak
// ====================================================================
// Cache credential status checks with 30-second TTL to prevent
// continuous WASM memory allocation from repeated verifications
// during auto-refresh cycles.
//
// Memory Impact:
// - WITHOUT cache: 2-5 MB WASM allocated every 30 seconds (unbounded growth)
// - WITH cache: Single verification, then cached results (memory plateaus)
// ====================================================================
interface StatusCacheEntry {
    status: {
        revoked: boolean;
        suspended: boolean;
        verified: boolean;
        statusListUrl?: string;
        error?: string;
    };
    timestamp: number;
}

const statusCheckCache = new Map<string, StatusCacheEntry>();
const CACHE_TTL_MS = 30000; // 30 seconds (matches auto-refresh interval)

/**
 * Get cached status or verify credential if cache miss/expired
 */
async function getCachedCredentialStatus(credential: any): Promise<any> {
    const cacheKey = credential.id;
    const cached = statusCheckCache.get(cacheKey);
    const now = Date.now();

    // Check if cache hit and not expired
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        console.log(`✅ [Cache] HIT for credential ${cacheKey.substring(0, 20)}... (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
        return cached.status;
    }

    // Cache miss or expired - verify credential
    if (cached) {
        console.log(`⏰ [Cache] EXPIRED for credential ${cacheKey.substring(0, 20)}... (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
    } else {
        console.log(`❌ [Cache] MISS for credential ${cacheKey.substring(0, 20)}...`);
    }

    // Perform actual verification (WASM allocation happens here)
    const status = await verifyCredentialStatus(credential);

    // Store in cache
    statusCheckCache.set(cacheKey, {
        status,
        timestamp: now
    });

    console.log(`💾 [Cache] STORED status for credential ${cacheKey.substring(0, 20)}... (revoked: ${status.revoked}, suspended: ${status.suspended})`);

    return status;
}

/**
 * Clear cache entries for deleted credentials
 */
function cleanupStatusCache(validCredentialIds: string[]) {
    const validIdSet = new Set(validCredentialIds);
    let removedCount = 0;

    for (const cacheKey of statusCheckCache.keys()) {
        if (!validIdSet.has(cacheKey)) {
            statusCheckCache.delete(cacheKey);
            removedCount++;
        }
    }

    if (removedCount > 0) {
        console.log(`🧹 [Cache] Cleaned up ${removedCount} stale cache entries`);
    }
}

function buildEnterpriseCredentialAdapter(rawCred: any) {
    // Handle both JWT format (claims as plain object) and AnonCreds (credentialAttributes array)
    let attrMap: Record<string, string> = {};
    if (rawCred.claims && typeof rawCred.claims === 'object' && !Array.isArray(rawCred.claims)) {
        // JWT: claims is a flat object
        Object.entries(rawCred.claims).forEach(([k, v]) => { attrMap[k] = String(v ?? ''); });
    } else if (Array.isArray(rawCred.credentialAttributes)) {
        // AnonCreds: [{name, value}] array
        rawCred.credentialAttributes.forEach((a: any) => { attrMap[a.name] = a.value; });
    }
    const enterpriseType = getEnterpriseCredentialType(rawCred);
    const holderName = attrMap.employeeName || attrMap.email || attrMap.employeeId || 'Enterprise User';

    // Derive companyName from email domain if not explicitly set
    if (!attrMap.companyName && attrMap.email) {
        const domain = attrMap.email.split('@')[1] || '';
        // Strip TLD and capitalize: "techcorp.test" → "Techcorp"
        const base = domain.split('.')[0];
        attrMap.companyName = base.charAt(0).toUpperCase() + base.slice(1);
    }

    // Derive issuedAt from cloud agent createdAt if not set
    const issuedAt = rawCred.issuedAt || rawCred.createdAt || attrMap.hireDate || attrMap.effectiveDate || '';

    return {
        ...rawCred,
        issuedAt,
        credentialSubject: {
            ...attrMap,
            credentialType: enterpriseType,
            holderName,
        },
        id: rawCred.recordId,
        issuanceDate: issuedAt,
    };
}

export default function App() {
    const app = useMountedApp();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [deletingCredentialId, setDeletingCredentialId] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    // Top-level wallet tab
    const [walletTab, setWalletTab] = useState<'personal' | 'enterprise'>('personal');
    // Sub-tabs for personal wallet
    const [activeTab, setActiveTab] = useState<'active' | 'old' | 'others'>('active');

    // Grouped credentials (Personal Wallet)
    const [activeCredentials, setActiveCredentials] = useState<any[]>([]);
    const [oldCredentials, setOldCredentials] = useState<any[]>([]);
    const [otherCredentials, setOtherCredentials] = useState<any[]>([]);
    const [credentialStatuses, setCredentialStatuses] = useState<Map<string, any>>(new Map());

    // Enterprise Wallet State
    const enterpriseCredentials = useAppSelector(selectEnterpriseCredentials);
    const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
    const isLoadingEnterpriseCredentials = useAppSelector(selectIsLoadingCredentials);
    const enterpriseConfig = useAppSelector(selectActiveConfiguration);

    // Group and sort credentials by type
    useEffect(() => {
        const checkAndGroupCredentials = async () => {
            console.log('🔄 [Credentials] Starting credential grouping and status check...');

            const active: any[] = [];
            const old: any[] = [];
            const others: any[] = [];
            const statusMap = new Map();

            // Deduplicate credentials by semantic content key.
            // Keep the last (most recently issued) copy when duplicates exist.
            const deduped = new Map<string, any>();
            for (const credential of app.credentials) {
                // Extract subject from credentialSubject getter (works for SDK JWTCredential)
                let sub: any = null;
                try { sub = (credential as any).credentialSubject; } catch { /* ignore */ }
                const key: string =
                    sub?.enterpriseAgentWalletId ||   // ServiceConfiguration: unique per employee wallet
                    sub?.uniqueId ||                   // RealPersonIdentity
                    sub?.credentialId ||               // SecurityClearance / others
                    credential.id;                     // fallback: treat every JWT as unique
                // Later entries overwrite earlier ones — keeps newest issued copy
                deduped.set(key, credential);
            }
            const dedupedCredentials = Array.from(deduped.values());
            const removedCount = app.credentials.length - dedupedCredentials.length;
            if (removedCount > 0) {
                console.log(`🧹 [Credentials] Deduplicated ${removedCount} duplicate credential(s)`);
            }

            // Clean up cache for deleted credentials
            const validCredentialIds = dedupedCredentials.map(c => c.id);
            cleanupStatusCache(validCredentialIds);

            for (const credential of dedupedCredentials) {
                try {
                    // Check revocation status WITH CACHING
                    const status = await getCachedCredentialStatus(credential);
                    statusMap.set(credential.id, status);

                    // If revoked/suspended, add to old
                    if (status.revoked || status.suspended) {
                        old.push(credential);
                        continue;
                    }

                    // Check if expired
                    const expired_flag = isCredentialExpired(credential);

                    if (expired_flag) {
                        old.push(credential);
                    } else {
                        const type = getCredentialType(credential);
                        if (type === 'ServiceConfiguration') {
                            // Shown in Configuration tab only — skip here
                        } else if (type === 'CertificationAuthorityIdentity' || type === 'CompanyIdentity') {
                            others.push(credential);
                        } else {
                            active.push(credential);
                        }
                    }
                } catch (error) {
                    console.error('Error checking credential status:', error);
                    active.push(credential);
                }
            }

            setActiveCredentials(sortCredentialsAlphabetically(active));
            setOldCredentials(sortCredentialsAlphabetically(old));
            setOtherCredentials(sortCredentialsAlphabetically(others));
            setCredentialStatuses(statusMap);

            console.log('✅ [Credentials] Grouping completed:', {
                active: active.length,
                old: old.length,
                others: others.length,
                cacheSize: statusCheckCache.size
            });
        };

        checkAndGroupCredentials();
    }, [app.credentials, refreshKey]);

    // Periodic revocation status check every 30 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            console.log('🔄 [REVOCATION] Checking credential revocation status...');
            console.log(`📊 [Cache] Current cache size: ${statusCheckCache.size} entries`);
            setRefreshKey(prev => prev + 1);
        }, 30000);

        return () => clearInterval(interval);
    }, []);

    // Cleanup cache on component unmount
    useEffect(() => {
        return () => {
            console.log('🧹 [Cache] Component unmounting, clearing cache');
            statusCheckCache.clear();
        };
    }, []);

    const handleRefreshCredentials = async () => {
        if (!app.db.instance) {
            console.error('❌ Database not connected - cannot refresh credentials');
            return;
        }

        console.log('🔄 Starting manual credential refresh...');
        setIsRefreshing(true);

        try {
            await app.refreshCredentials();
            console.log('✅ Manual credential refresh completed');
        } catch (error) {
            console.error('❌ Manual credential refresh failed:', error);
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleDeleteCredential = async (credential: any) => {
        if (!app.db.instance) {
            console.error('❌ Database not connected - cannot delete credential');
            alert('Database not connected. Cannot delete credential.');
            return;
        }

        // Confirmation dialog (enhanced for ServiceConfiguration VCs)
        const issuerInfo = credential.issuer || 'Unknown Issuer';
        const credentialType = credential.credentialType || credential.type || 'Unknown';
        const isServiceConfig = credentialType === 'ServiceConfiguration' ||
            (credential.credentialSubject?.enterpriseAgentUrl);

        let confirmMessage;
        if (isServiceConfig) {
            confirmMessage =
                `⚠️ DELETE SERVICECONFIGURATION CREDENTIAL?\n\n` +
                `Issuer: ${issuerInfo}\n\n` +
                `WARNING: This will permanently disconnect your wallet from the enterprise agent.\n\n` +
                `All enterprise features will be disabled and you will need to re-establish ` +
                `the connection to restore access.\n\n` +
                `This action cannot be undone. Are you sure?`;
        } else {
            confirmMessage =
                `Are you sure you want to delete this credential?\n\n` +
                `Issuer: ${issuerInfo}\n\n` +
                `This action cannot be undone.`;
        }

        if (!confirm(confirmMessage)) {
            return;
        }

        // 🔍 DIAGNOSTIC: Log credential count BEFORE deletion
        const credentialCountBefore = app.credentials.length;
        console.log('═══════════════════════════════════════════════════════');
        console.log('🗑️ [DELETE] Starting credential deletion...');
        console.log('📊 [DELETE] Credential count BEFORE deletion:', credentialCountBefore);
        console.log('🔍 [DELETE] Credential to delete:', {
            id: credential.id,
            uuid: credential.uuid,
            restoreId: credential.restoreId,
            issuer: credential.issuer,
            credentialType: credential.credentialType,
            hasId: !!credential.id,
            hasUuid: !!credential.uuid,
            hasRestoreId: !!credential.restoreId,
        });

        // 🔍 DIAGNOSTIC: Safe JSON stringification to avoid circular reference crashes
        try {
            const safeCredential = JSON.stringify(credential, null, 2);
            console.log('🔍 [DELETE] Full credential structure:', safeCredential);
        } catch (jsonError) {
            console.error('⚠️ [DELETE] Cannot stringify credential (circular reference):', jsonError.message);
            console.log('🔍 [DELETE] Credential keys:', Object.keys(credential));
            console.log('🔍 [DELETE] Credential prototype:', Object.getPrototypeOf(credential)?.constructor?.name);
        }

        setDeletingCredentialId(credential.id);

        try {
            // LAYER 1: Delete from database (Pluto)
            console.log('🗄️ [DELETE] Attempting database deletion...');
            await app.db.instance.deleteCredential(credential);
            console.log('✅ [DELETE] Database deletion call completed');

            // 🔍 DIAGNOSTIC: Check credential count immediately after deletion
            const credentialCountAfterDelete = app.credentials.length;
            console.log('📊 [DELETE] Credential count AFTER database deletion:', credentialCountAfterDelete);
            console.log('📊 [DELETE] Expected change: -1, Actual change:', credentialCountAfterDelete - credentialCountBefore);

            // 🔧 FIX: Wait for IndexedDB transaction to commit
            console.log('⏳ [DELETE] Waiting for IndexedDB transaction to commit...');
            await new Promise(resolve => setTimeout(resolve, 100));
            console.log('✅ [DELETE] Transaction commit delay completed');

            // Clear cache entry for deleted credential
            statusCheckCache.delete(credential.id);
            console.log('🧹 [Cache] Removed cache entry for deleted credential');

            // 🔧 NEW: Check if this is a ServiceConfiguration VC and clean up
            const credentialType = credential.credentialType || credential.type || 'Unknown';
            if (credentialType === 'ServiceConfiguration' ||
                (credential.credentialSubject?.enterpriseAgentUrl)) {
                console.log('🗑️ [DELETE] Detected ServiceConfiguration VC - clearing configuration...');

                try {
                    // Dynamically import configuration utilities
                    const { getAllConfigurations, getActiveConfiguration, clearActiveConfiguration } =
                        await import('@/utils/configurationStorage');
                    const { removeConfiguration } =
                        await import('@/actions/enterpriseAgentActions');

                    // Find configuration matching this VC's ID
                    const allConfigs = getAllConfigurations();
                    const matchingConfig = allConfigs.find(
                        stored => stored.config.vcId === credential.id
                    );

                    if (matchingConfig) {
                        console.log('🗑️ [DELETE] Found matching configuration:', matchingConfig.config.credentialId);

                        // Check if this is the active configuration
                        const activeConfig = getActiveConfiguration();
                        const isActive = activeConfig?.vcId === credential.id;

                        if (isActive) {
                            // Clear active configuration and Redux state
                            console.log('🗑️ [DELETE] Clearing ACTIVE configuration via Redux...');
                            await app.dispatch(removeConfiguration()).unwrap();
                            console.log('✅ [DELETE] Active configuration cleared from Redux and localStorage');
                        } else {
                            // Just remove from localStorage (not active)
                            console.log('🗑️ [DELETE] Removing INACTIVE configuration from storage...');
                            clearActiveConfiguration();
                            console.log('✅ [DELETE] Inactive configuration removed');
                        }

                        console.log('✅ [DELETE] ServiceConfiguration cleanup completed');
                    } else {
                        console.log('ℹ️ [DELETE] No matching configuration found in storage (may have been deactivated)');
                    }
                } catch (configError) {
                    console.error('⚠️ [DELETE] Failed to clean up ServiceConfiguration:', configError);
                    // Don't fail the deletion if config cleanup fails
                }
            }

            // LAYER 2: Refresh credentials in Redux state
            console.log('🔄 [DELETE] Refreshing credential list from database...');
            await app.refreshCredentials();

            // 🔍 DIAGNOSTIC: Check credential count after refresh
            const credentialCountAfterRefresh = app.credentials.length;
            console.log('📊 [DELETE] Credential count AFTER refresh:', credentialCountAfterRefresh);
            console.log('📊 [DELETE] Change from refresh:', credentialCountAfterRefresh - credentialCountAfterDelete);

            // 🔍 DIAGNOSTIC: Log all credential IDs after refresh
            console.log('🔍 [DELETE] All credential IDs after refresh:',
                app.credentials.map(c => ({
                    id: c.id,
                    uuid: c.uuid,
                    issuer: c.issuer,
                    type: c.credentialType
                }))
            );

            if (credentialCountAfterRefresh >= credentialCountBefore) {
                console.error('⚠️ [DELETE] BUG DETECTED: Credential count did NOT decrease!');
                console.error('⚠️ [DELETE] Before:', credentialCountBefore, 'After:', credentialCountAfterRefresh);
                console.error('⚠️ [DELETE] This indicates the deletion failed or refresh created duplicates');
            }

            console.log('═══════════════════════════════════════════════════════');
            alert('Credential deleted successfully!');
        } catch (error) {
            console.error('❌ [DELETE] Failed to delete credential:', error);
            console.error('❌ [DELETE] Error details:', {
                message: error.message,
                stack: error.stack,
                error: error
            });
            alert(`Failed to delete credential: ${error.message || error}`);
        } finally {
            setDeletingCredentialId(null);
        }
    };

    return (
        <div>
            {/* Header */}
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-1">Credentials</h2>
                <p className="text-slate-400 text-sm">Manage your verifiable credentials and security clearances</p>
            </header>

            <DBConnect>
                <Box>
                        {/* Refresh Button */}
                        <div className="mb-6">
                            <button
                                onClick={handleRefreshCredentials}
                                disabled={isRefreshing || !app.db.instance}
                                className={`inline-flex items-center px-4 py-2 text-sm font-medium text-white border-0 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 ${
                                    isRefreshing || !app.db.instance
                                        ? 'bg-slate-700/50 cursor-not-allowed opacity-50'
                                        : 'bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600'
                                }`}
                            >
                                {isRefreshing ? (
                                    <>
                                        <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Refreshing...
                                    </>
                                ) : (
                                    <>
                                        🔄 Refresh Credentials
                                    </>
                                )}
                            </button>
                            <p className="mt-2 text-sm text-slate-400">
                                Click to manually refresh credentials from database
                            </p>
                        </div>

                        {/* Wallet Tabs */}
                        <div className="flex gap-1 mb-6 bg-slate-800/60 p-1 rounded-xl border border-slate-700/50 w-fit">
                            <button
                                onClick={() => setWalletTab('personal')}
                                className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                                    walletTab === 'personal'
                                        ? 'bg-slate-700 text-white shadow'
                                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                }`}
                            >
                                🪪 Personal
                                {activeCredentials.length > 0 && (
                                    <span className={`px-1.5 py-0.5 text-xs rounded-full ${walletTab === 'personal' ? 'bg-cyan-500/30 text-cyan-300' : 'bg-slate-700 text-slate-400'}`}>
                                        {activeCredentials.length}
                                    </span>
                                )}
                            </button>
                            {isEnterpriseConfigured && (
                                <button
                                    onClick={() => setWalletTab('enterprise')}
                                    className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                                        walletTab === 'enterprise'
                                            ? 'bg-slate-700 text-white shadow'
                                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                    }`}
                                >
                                    🏢 {enterpriseConfig?.agentName || 'Enterprise'}
                                    {enterpriseCredentials.length > 0 && (
                                        <span className={`px-1.5 py-0.5 text-xs rounded-full ${walletTab === 'enterprise' ? 'bg-cyan-500/30 text-cyan-300' : 'bg-slate-700 text-slate-400'}`}>
                                            {enterpriseCredentials.length}
                                        </span>
                                    )}
                                    {isLoadingEnterpriseCredentials && (
                                        <svg className="animate-spin h-3.5 w-3.5 text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    )}
                                </button>
                            )}
                        </div>

                        {/* ── PERSONAL WALLET ── */}
                        {walletTab === 'personal' && (
                        <>
                        {app.credentials.length <= 0 ? (
                            <div className="text-center py-8">
                                <p className="text-lg font-normal text-slate-300 lg:text-xl">No credentials found.</p>
                                <p className="text-sm text-slate-400 mt-2">If you have accepted credential offers, try clicking "Refresh Credentials" above.</p>
                            </div>
                        ) : (
                            <>
                                {/* Sub-Tab Bar */}
                                <div className="flex gap-1 mb-6 bg-slate-800/50 p-1 rounded-xl border border-slate-700/50 w-fit">
                                    {(['active', 'old', 'others'] as const).map(tab => {
                                        const count = tab === 'active' ? activeCredentials.length : tab === 'old' ? oldCredentials.length : otherCredentials.length;
                                        const labels = { active: 'Active', old: 'Old', others: 'Others' };
                                        const isActive = activeTab === tab;
                                        return (
                                            <button
                                                key={tab}
                                                onClick={() => setActiveTab(tab)}
                                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                                                    isActive
                                                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                                }`}
                                            >
                                                {labels[tab]}
                                                {count > 0 && (
                                                    <span className={`px-1.5 py-0.5 text-xs rounded-full ${isActive ? 'bg-cyan-500/30 text-cyan-300' : 'bg-slate-700 text-slate-400'}`}>
                                                        {count}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Active Tab */}
                                {activeTab === 'active' && (
                                    activeCredentials.length === 0 ? (
                                        <div className="text-center py-8 text-slate-400">No active credentials.</div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {activeCredentials.map((credential, i) => (
                                                <ErrorBoundary key={`active-${refreshKey}-${credential.id}-${i}`} componentName={`CredentialCard-Active-${i}`}>
                                                    <div className="relative">
                                                        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                                                            <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-full">✓ Valid</span>
                                                            <button onClick={() => handleDeleteCredential(credential)} className="p-1 rounded-lg hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Delete credential">
                                                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                                                            </button>
                                                        </div>
                                                        {getCredentialLayout(credential)}
                                                    </div>
                                                </ErrorBoundary>
                                            ))}
                                        </div>
                                    )
                                )}

                                {/* Old Tab */}
                                {activeTab === 'old' && (
                                    oldCredentials.length === 0 ? (
                                        <div className="text-center py-8 text-slate-400">No expired or revoked credentials.</div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {oldCredentials.map((credential, i) => {
                                                const st = credentialStatuses.get(credential.id);
                                                const isRevoked = st?.revoked || st?.suspended;
                                                return (
                                                    <ErrorBoundary key={`old-${refreshKey}-${credential.id}-${i}`} componentName={`CredentialCard-Old-${i}`}>
                                                        <div className="relative opacity-70">
                                                            <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                                                                {isRevoked
                                                                    ? <span className="px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-full">✗ Revoked</span>
                                                                    : <span className="px-2 py-0.5 text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-full">⏱ Expired</span>
                                                                }
                                                                <button onClick={() => handleDeleteCredential(credential)} className="p-1 rounded-lg hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Delete credential">
                                                                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                                                                </button>
                                                            </div>
                                                            {getCredentialLayout(credential)}
                                                        </div>
                                                    </ErrorBoundary>
                                                );
                                            })}
                                        </div>
                                    )
                                )}

                                {/* Others Tab */}
                                {activeTab === 'others' && (
                                    otherCredentials.length === 0 ? (
                                        <div className="text-center py-8 text-slate-400">No other credentials.</div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {otherCredentials.map((credential, i) => (
                                                <ErrorBoundary key={`others-${refreshKey}-${credential.id}-${i}`} componentName={`CredentialCard-Others-${i}`}>
                                                    <div className="relative">
                                                        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                                                            <button onClick={() => handleDeleteCredential(credential)} className="p-1 rounded-lg hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Delete credential">
                                                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                                                            </button>
                                                        </div>
                                                        {getCredentialLayout(credential)}
                                                    </div>
                                                </ErrorBoundary>
                                            ))}
                                        </div>
                                    )
                                )}

                            </>
                        )}
                        </>
                        )}

                        {/* ── ENTERPRISE WALLET ── */}
                        {walletTab === 'enterprise' && isEnterpriseConfigured && (
                            <>
                                {isLoadingEnterpriseCredentials && (
                                    <div className="flex items-center gap-2 text-cyan-400 py-4">
                                        <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        <span className="text-sm">Loading enterprise credentials…</span>
                                    </div>
                                )}
                                {!isLoadingEnterpriseCredentials && enterpriseCredentials.length === 0 && (
                                    <div className="text-center py-8 text-slate-400">
                                        No enterprise credentials found.
                                    </div>
                                )}
                                {!isLoadingEnterpriseCredentials && enterpriseCredentials.length > 0 && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {enterpriseCredentials.map((rawCredential, i) => {
                                            const adapted = buildEnterpriseCredentialAdapter(rawCredential);
                                            return (
                                                <ErrorBoundary
                                                    key={`enterprise-${refreshKey}-${rawCredential.recordId || i}`}
                                                    componentName={`EnterpriseCredential-${i}`}
                                                >
                                                    <div className="relative">
                                                        {rawCredential.protocolState && (
                                                            <span className="absolute top-3 right-3 z-10 px-2 py-0.5 text-xs font-medium border rounded-full bg-slate-700/50 text-slate-400 border-slate-600/30">
                                                                {rawCredential.protocolState}
                                                            </span>
                                                        )}
                                                        {getCredentialLayout(adapted)}
                                                    </div>
                                                </ErrorBoundary>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                </Box>
            </DBConnect>
        </div>
    );
}
