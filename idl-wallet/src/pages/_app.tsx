import { MountSDK } from '@/components/Agent';
import { AutoStartAgent } from '@/components/AutoStartAgent';
import WasmMemoryGuard from '@/components/WasmMemoryGuard';
import { CredentialOfferModal } from '@/components/CredentialOfferModal';
import { EnterpriseCredentialOfferModal } from '@/components/EnterpriseCredentialOfferModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MainLayout } from '@/components/layouts/MainLayout';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';

const UnifiedProofRequestModal = dynamic(
  () => import('@/components/UnifiedProofRequestModal').then(mod => ({ default: mod.UnifiedProofRequestModal })),
  { ssr: false }
);
import { useEffect } from 'react';
import { routeMemoryCleanup } from '@/utils/RouteMemoryCleanup';
import { memoryMonitor } from '@/utils/MemoryMonitor';
import { testEncryptionRoundtrip, testEncryptionWithStoredKeys } from '@/utils/messageEncryption';
import { initSecureDashboardBridge, cleanupSecureDashboardBridge } from '@/utils/SecureDashboardBridge';
import { initConsoleLogger, cleanupConsoleLogger } from '@/utils/ConsoleLogger';
// Import cleanup utilities to auto-export to browser console
import '@/utils/clearWalletData';
import '@/utils/cleanupOrphanedPeerDIDs';

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
                <UnifiedProofRequestModal />
                <CredentialOfferModal />
                <EnterpriseCredentialOfferModal />
                <MainLayout>
                    <Component {...pageProps} />
                </MainLayout>
            </MountSDK>
        </ErrorBoundary>
    );
}

export default App;