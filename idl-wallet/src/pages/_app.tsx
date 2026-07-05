import { MountSDK } from '@/components/Agent';
import { AutoStartAgent } from '@/components/AutoStartAgent';
import WasmMemoryGuard from '@/components/WasmMemoryGuard';
import { CredentialOfferModal } from '@/components/CredentialOfferModal';
import { EnterpriseCredentialOfferModal } from '@/components/EnterpriseCredentialOfferModal';
import { CAPortalModal } from '@/components/CAPortalModal';
import { CAPortalProvider, useCAPortal } from '@/utils/CAPortalContext';
import { AccessRequestStatusModal } from '@/components/AccessRequestStatusModal';
import { useAppSelector } from '@/reducers/store';
import { useMountedApp } from '@/reducers/store';
import { reduxActions } from '@/reducers/app';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MainLayout } from '@/components/layouts/MainLayout';
import { CAConnectionEnforcementModal } from '@/components/CAConnectionEnforcementModal';
import { refreshConnections } from '@/actions';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

const UnifiedProofRequestModal = dynamic(
  () => import('@/components/UnifiedProofRequestModal').then(mod => ({ default: mod.UnifiedProofRequestModal })),
  { ssr: false }
);
import { routeMemoryCleanup } from '@/utils/RouteMemoryCleanup';
import { memoryMonitor } from '@/utils/MemoryMonitor';
import { testEncryptionRoundtrip, testEncryptionWithStoredKeys } from '@/utils/messageEncryption';
import { initSecureDashboardBridge, cleanupSecureDashboardBridge } from '@/utils/SecureDashboardBridge';
import { initConsoleLogger, cleanupConsoleLogger } from '@/utils/ConsoleLogger';
import { getConnectionMetadata, saveConnectionMetadata } from '@/utils/connectionMetadata';
import { parseServiceAccessGrant, isTrustedGrantSender } from '@/utils/serviceAccessGrant';
import { CA_CAPABILITIES } from '@/config/serviceTrust';
// Import cleanup utilities to auto-export to browser console
import '@/utils/clearWalletData';
import '@/utils/cleanupOrphanedPeerDIDs';

function GlobalCAEnforcer() {
    const app = useMountedApp();
    const [hasCAConnection, setHasCAConnection] = useState<boolean | null>(null);
    const [showModal, setShowModal] = useState(false);
    const iagonStatus = app.iagonBackup?.status ?? 'idle';

    useEffect(() => {
        // Don't check while a restore is in progress — Pluto is being rebuilt.
        if (iagonStatus === 'checking' || iagonStatus === 'downloading' || iagonStatus === 'restoring') return;
        // After a restore (iagonStatus was 'checking'), wait until the agent has fully started
        // before checking — startAgent writes mediator data to Pluto and signals the agent is ready.
        // For normal logins (iagonStatus stays 'idle'), agent.hasStarted is still the right gate.
        if (!app.agent.hasStarted) return;

        const checkCAConnection = async () => {
            try {
                const allConnections = await app.agent.instance!.pluto.getAllDidPairs();
                const caConnection = allConnections.find(pair => {
                    const pairName = (pair.name ?? '').toLowerCase();
                    return pairName === 'certification authority' || pairName.includes('certification');
                });
                // Backfill capabilities for connections established before service-access/1.0
                // existed — GlobalGrantWatcher requires a DID-keyed capability list to trust an
                // incoming grant and auto-open the CA portal iframe; without it, grants are
                // silently dropped. SECURITY: require an EXACT name match here (unlike the
                // `includes()` check above, which only gates whether to show the "connect to CA"
                // nudge modal) — this backfill is a trust decision, so it must not match an
                // arbitrary connection whose locally-chosen name merely contains "certification".
                if (caConnection && (caConnection.name ?? '').toLowerCase() === 'certification authority') {
                    const hostDID = caConnection.host.toString();
                    const meta = getConnectionMetadata(hostDID);
                    if (!meta?.capabilities?.length) {
                        // isCAConnection is written alongside for connections.tsx, which still
                        // reads it too — @deprecated, removed once that's repointed as well.
                        saveConnectionMetadata(hostDID, {
                            ...(meta ?? { walletType: 'local' }),
                            isCAConnection: true,
                            capabilities: CA_CAPABILITIES
                        });
                    }
                }
                setHasCAConnection(!!caConnection);
                setShowModal(!caConnection);
            } catch {
                setHasCAConnection(false);
                setShowModal(true);
            }
        };
        checkCAConnection();
    }, [app.agent.hasStarted, iagonStatus]);

    if (!showModal || hasCAConnection !== false) return null;

    return (
        <CAConnectionEnforcementModal
            visible={true}
            onConnectionEstablished={() => {
                setHasCAConnection(true);
                setShowModal(false);
                app.dispatch(refreshConnections());
            }}
            agent={app.agent.instance}
            dispatch={app.dispatch}
            defaultSeed={app.defaultSeed}
        />
    );
}

// Watches all incoming messages for service-access/1.0 grant envelopes and auto-opens the
// portal (mode: redirect) or dispatches to a capability-specific consumer (mode: payload).
// Trust is checked against the message's actual sender DID via isTrustedGrantSender — see
// src/utils/serviceAccessGrant.ts for why this replaces the old isCAConnection display-name-
// derived flag.
function GlobalGrantWatcher() {
    const app = useMountedApp();
    const { openCAPortal } = useCAPortal();
    const seenGrantIds = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!app.messages?.length) return;
        for (const message of app.messages) {
            const parsed = parseServiceAccessGrant(message);
            if (!parsed) continue;

            const grantId = parsed.id;
            if (seenGrantIds.current.has(grantId)) continue;
            seenGrantIds.current.add(grantId);

            const msgId = message.id;
            // Always clean up the grant message (delete + remove from Redux) regardless of
            // whether it passes validation below — otherwise a rejected/stale/foreign grant
            // stays in the message store and gets reprocessed (and reopens the same dead
            // iframe) on every future login, since seenGrantIds resets on reload.
            const cleanupGrantMessage = () => {
                if (app.db.instance) {
                    app.db.instance.deleteMessage(msgId).catch((err) => {
                        console.error('[GlobalGrantWatcher] Failed to delete processed grant message:', msgId, err);
                    });
                }
                app.dispatch(reduxActions.messageRemoved(msgId));
            };

            const notExpired = Date.now() < parsed.expiresAt;
            const { trusted, originAllowlist } = isTrustedGrantSender(message, app.connections, parsed.capability);

            if (parsed.mode === 'redirect') {
                const urlOnTrustedOrigin = !!parsed.accessUrl && !!originAllowlist && (() => {
                    try { return originAllowlist.includes(new URL(parsed.accessUrl!).origin); }
                    catch { return false; }
                })();

                if (notExpired && trusted && urlOnTrustedOrigin) {
                    openCAPortal(parsed.accessUrl!); // also clears pendingAccessRequest in context
                } else {
                    console.warn('[GlobalGrantWatcher] Ignoring redirect grant that failed validation', {
                        capability: parsed.capability, notExpired, trusted, urlOnTrustedOrigin
                    });
                }
            } else {
                // mode: payload — no generic UI to open; dispatch by capability once a payload-
                // mode capability is wired up (e.g. document-access). Until then, log and drop.
                if (notExpired && trusted) {
                    console.warn(`[GlobalGrantWatcher] No consumer registered for payload capability "${parsed.capability}" — ignoring`);
                } else {
                    console.warn('[GlobalGrantWatcher] Ignoring payload grant that failed validation', {
                        capability: parsed.capability, notExpired, trusted
                    });
                }
            }

            cleanupGrantMessage();
        }
    }, [app.messages, app.connections, openCAPortal]);

    return null;
}

function CAPortalRenderer() {
    const { caPortalUrl, closeCAPortal, isMinimized, minimizeCAPortal, restoreCAPortal,
            setPendingDocumentDID, pendingAccessRequest, setPendingAccessRequest } = useCAPortal();
    const router = useRouter();
    const app = useMountedApp();
    const enterprisePendingRequests = useAppSelector(
        state => state.enterpriseAgent?.pendingProofRequests?.length ?? 0
    );
    const personalPendingRequests = (app.presentationRequests ?? []).filter(r => r.status === 'pending').length;
    const hasPendingRequests = enterprisePendingRequests > 0 || personalPendingRequests > 0;

    // Listen for wallet:openDocument custom events dispatched by SecureDashboardBridge.
    useEffect(() => {
        const handler = (e: Event) => {
            const { documentDID } = (e as CustomEvent).detail ?? {};
            if (documentDID) setPendingDocumentDID(documentDID);
            router.push('/documents');
        };
        window.addEventListener('wallet:openDocument', handler);
        return () => window.removeEventListener('wallet:openDocument', handler);
    }, [setPendingDocumentDID, router]);

    const handleOpenDocument = (documentDID: string) => {
        setPendingDocumentDID(documentDID);
        router.push('/documents');
    };

    return (
        <>
            {/* Login-in-progress modal — shown while waiting for grant, dismissed on portal open */}
            {pendingAccessRequest && !caPortalUrl && (
                <AccessRequestStatusModal
                    request={pendingAccessRequest}
                    onClose={() => setPendingAccessRequest(null)}
                />
            )}
            {caPortalUrl && (
                <CAPortalModal
                    url={caPortalUrl}
                    isMinimized={isMinimized}
                    hasPendingRequests={hasPendingRequests}
                    onClose={closeCAPortal}
                    onMinimize={minimizeCAPortal}
                    onRestore={restoreCAPortal}
                    onOpenDocument={handleOpenDocument}
                />
            )}
        </>
    );
}

function App({ Component, pageProps }) {
    const router = useRouter();

    useEffect(() => {
        // Initialize memory management systems
        memoryMonitor.startMonitoring();
        routeMemoryCleanup.initialize(router);

        // Initialize Secure Dashboard Bridge (BroadcastChannel for local decryption)
        if (typeof window !== 'undefined') {
            initSecureDashboardBridge('idl');
        }

        // Initialize Console Logger (captures browser logs to server)
        if (typeof window !== 'undefined') {
            initConsoleLogger('idl');
        }

        // 🧪 Expose test functions for debugging encrypted messaging
        if (typeof window !== 'undefined') {
            (window as any).testEncryptionRoundtrip = testEncryptionRoundtrip;
            (window as any).testEncryptionWithStoredKeys = testEncryptionWithStoredKeys;
            console.log('🧪 [DEBUG] Test functions exposed:');
            console.log('  - window.testEncryptionRoundtrip() - Manual key input');
            console.log('  - window.testEncryptionWithStoredKeys() - Auto localStorage retrieval');
        }

        // 🔧 FIX #7: Add global error handlers to prevent silent crashes
        const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
            // ✅ Gracefully handle DIDComm secret errors (non-fatal)
            // These occur when encrypted messages arrive before peer DID keys are persisted
            if (event.reason?.message?.includes('No recipient secrets found') ||
                event.reason?.message?.includes('SecretNotFound') ||
                event.reason?.message?.includes('DIDCommSecretNotFound')) {
                console.warn('⚠️ [Global] DIDComm decryption failed - recipient keys not yet available');
                console.warn('⚠️ [Global] This is normal during connection establishment');
                console.warn('⚠️ [Global] The SDK will retry decryption on next message poll');
                event.preventDefault(); // Prevent default behavior
                return; // Don't show alert - this is expected behavior
            }

            // All other errors - log and show alert
            console.error('🚨 [Global] Unhandled Promise Rejection:', event.reason);
            console.error('🚨 [Global] Promise:', event.promise);

            // Prevent default behavior (silent crash)
            event.preventDefault();

            // Show user-visible error notification
            alert('⚠️ Wallet Error: An unexpected error occurred. Please reload the wallet if issues persist.');
        };

        const handleError = (event: ErrorEvent) => {
            console.error('🚨 [Global] Uncaught Error:', event.error);
            console.error('🚨 [Global] Message:', event.message);
            console.error('🚨 [Global] File:', event.filename);
            console.error('🚨 [Global] Line:', event.lineno);

            // Prevent default behavior
            event.preventDefault();

            // Show user-visible error notification
            alert('⚠️ Wallet Error: An unexpected error occurred. Please reload the wallet if issues persist.');
        };

        // Attach global error handlers
        window.addEventListener('unhandledrejection', handleUnhandledRejection);
        window.addEventListener('error', handleError);

        console.log('✅ [Global] Error handlers attached');

        // Cleanup on app unmount
        return () => {
            routeMemoryCleanup.destroy();
            memoryMonitor.destroy();
            cleanupSecureDashboardBridge();
            cleanupConsoleLogger();

            // Remove global error handlers
            window.removeEventListener('unhandledrejection', handleUnhandledRejection);
            window.removeEventListener('error', handleError);
        };
    }, [router]);

    return (
        <CAPortalProvider>
        <ErrorBoundary
            componentName="App Root"
            fallback={
                <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
                    <div className="max-w-md w-full bg-slate-800/30 border border-slate-700/50 backdrop-blur-sm shadow-lg rounded-2xl p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-4xl">⚠️</span>
                            <h2 className="text-2xl font-bold text-white">Wallet Error</h2>
                        </div>
                        <p className="text-slate-300 mb-6">
                            The wallet encountered an unexpected error. This could be due to a temporary issue or corrupted state.
                        </p>
                        <button
                            className="w-full px-4 py-3 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl hover:from-cyan-600 hover:to-purple-600 transition-all font-semibold"
                            onClick={() => window.location.reload()}
                        >
                            Reload Wallet
                        </button>
                    </div>
                </div>
            }
        >
            <MountSDK>
                <AutoStartAgent />
                <WasmMemoryGuard />
                <GlobalCAEnforcer />
                <GlobalGrantWatcher />
                <UnifiedProofRequestModal />
                <CredentialOfferModal />
                <EnterpriseCredentialOfferModal />
                <CAPortalRenderer />
                <MainLayout>
                    <Component {...pageProps} />
                </MainLayout>
            </MountSDK>
        </ErrorBoundary>
        </CAPortalProvider>
    );
}

export default App;