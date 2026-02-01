/**
 * AutoStartAgent Component
 *
 * Automatically starts the agent after database connection.
 * Also initializes enterprise agent if active configuration exists.
 * This component is mounted globally in _app.tsx to ensure auto-start works on all pages.
 */
import { useEffect, useState } from "react";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { useDispatch } from "react-redux";
import { setConfiguration } from "@/reducers/enterpriseAgent";
import { getActiveConfiguration } from "@/utils/configurationStorage";

export function AutoStartAgent() {
  const app = useMountedApp();
  const { db, mediatorDID, initAgent, startAgent } = app;
  const dispatch = useDispatch();
  const enterpriseAgent = useAppSelector((state) => state.enterpriseAgent);

  // 🔧 FIX #8: Track error state for user-visible feedback
  const [initError, setInitError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // 🔧 RESTORED CONFIG LOADING: Load enterprise configuration from localStorage on startup
  // This hydrates Redux state from persisted localStorage after page refresh
  // User still must click "Apply" for first-time activation (user control preserved)
  useEffect(() => {
    // CRITICAL FIX: Do NOT run enterprise features until wallet has started
    if (!app.agent.hasStarted) return;

    try {
      const activeConfig = getActiveConfiguration();

      if (activeConfig) {
        // Restore configuration to Redux (hydrates state from localStorage)
        // This does NOT apply/activate - just loads existing state
        import('@/actions/enterpriseAgentActions').then(({ applyConfiguration }) => {
          applyConfiguration(activeConfig)(app.dispatch, app.getState);

          // Auto-refresh enterprise data after Redux store is fully ready
          // Delay ensures store initialization completes before refresh calls
          setTimeout(() => {
            import('@/actions/enterpriseAgentActions').then(({ refreshEnterpriseConnections, refreshEnterpriseCredentials }) => {
              app.dispatch(refreshEnterpriseConnections());
              app.dispatch(refreshEnterpriseCredentials());

              // ⚠️ NOTE: Proof request polling is started AFTER agent connection (see agent start handler below)
              // This ensures credentials are loaded before modal can appear
            });
          }, 200);
        });
      }
    } catch (error) {
      console.error('⚠️ [AutoStartAgent] Error restoring configuration:', error);
    }

    // Cleanup polling intervals on unmount
    return () => {
      if ((window as any).__enterprisePollingInterval) {
        clearInterval((window as any).__enterprisePollingInterval);
      }
      if ((window as any).__didcommPollingInterval) {
        clearInterval((window as any).__didcommPollingInterval);
      }
    };
  }, [app.agent.hasStarted]); // Run when wallet starts

  // Initialize agent when database connects
  useEffect(() => {
    if (!app.agent.instance && db.instance) {
      try {
        initAgent({ mediatorDID, pluto: db.instance, defaultSeed: app.defaultSeed });
        setInitError(null); // Clear any previous errors
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown init error';
        console.error('❌ [AutoStartAgent] Agent initialization failed:', error);
        setInitError(errorMessage);
      }
    }
  }, [db.instance, app.agent.instance]);

  // Auto-start agent when it becomes available
  useEffect(() => {
    if (app.agent.instance && !app.agent.hasStarted && !app.agent.isStarting) {
      startAgent({ agent: app.agent.instance })
        .then(() => {
          setStartError(null); // Clear any previous errors

          // ✅ START ENTERPRISE POLLING: Now that agent is connected and credentials are loaded
          // Check if enterprise configuration exists before starting polling
          const activeConfig = getActiveConfiguration();
          if (activeConfig) {
            // Import all polling actions
            import('@/actions/enterpriseAgentActions').then(({
              pollPendingProofRequests,
              pollPendingCredentialOffers
            }) => {
              // Initial polls immediately
              app.dispatch(pollPendingProofRequests());
              app.dispatch(pollPendingCredentialOffers());

              // Then poll every 10 seconds (2x slower than before)
              const pollingInterval = setInterval(() => {
                app.dispatch(pollPendingProofRequests());
                app.dispatch(pollPendingCredentialOffers());
              }, 10000);

              // Store interval ID for cleanup
              (window as any).__enterprisePollingInterval = pollingInterval;
            });

            // ✅ AUTO-ACCEPT DIDCOMM CREDENTIAL OFFERS
            // Poll for DIDComm credential offer messages in IndexedDB and auto-accept them
            const didcommPollingInterval = setInterval(async () => {
              try {
                const agent = app.agent.instance;
                if (!agent) return;

                // Get all messages
                const messages = await agent.pluto.getAllMessages();

                // Find credential offer messages (piuri: https://didcomm.org/issue-credential/3.0/offer-credential)
                const offerMessages = messages.filter((msg: any) =>
                  msg.piuri?.includes('offer-credential')
                );

                if (offerMessages.length > 0) {
                  // Import acceptCredentialOffer action
                  const { acceptCredentialOffer } = await import('@/actions');

                  for (const offerMsg of offerMessages) {
                    try {
                      await app.dispatch(acceptCredentialOffer({ agent, message: offerMsg })).unwrap();
                    } catch (error) {
                      console.error(`[AutoStartAgent] Failed to accept DIDComm offer:`, error);
                    }
                  }
                }
              } catch (error) {
                console.error('[AutoStartAgent] DIDComm polling error:', error);
              }
            }, 10000); // 10 seconds (2x slower than original 5s)

            (window as any).__didcommPollingInterval = didcommPollingInterval;
          }
        })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown start error';
          console.error('❌ [AutoStartAgent] Agent start failed:', error);
          setStartError(errorMessage);
        });
    }
  }, [app.agent.instance, app.agent.hasStarted, app.agent.isStarting]);

  // 🔧 FIX #8: Render user-visible error notification if agent fails
  if (initError || startError) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white p-4 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div className="flex-1">
            <p className="font-bold">Wallet Agent Failed to Start</p>
            <p className="text-sm text-red-100 mt-1">
              {initError || startError}
            </p>
          </div>
          <button
            className="px-4 py-2 bg-white text-red-600 rounded hover:bg-red-50 transition-colors font-semibold"
            onClick={() => window.location.reload()}
          >
            Reload Wallet
          </button>
        </div>
      </div>
    );
  }

  // This component doesn't render anything when no errors
  return null;
}
