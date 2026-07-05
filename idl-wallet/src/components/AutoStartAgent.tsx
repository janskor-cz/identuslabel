/**
 * AutoStartAgent Component
 *
 * Automatically starts the agent after database connection.
 * Also initializes enterprise agent if active configuration exists.
 * This component is mounted globally in _app.tsx to ensure auto-start works on all pages.
 */
import { useEffect, useMemo, useState } from "react";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { useDispatch } from "react-redux";
import { clearConfiguration } from "@/reducers/enterpriseAgent";
import { clearActiveConfiguration } from "@/utils/configurationStorage";
import { getCredentialType } from "@/utils/credentialTypeDetector";
import { extractConfiguration, validateConfiguration } from "@/utils/serviceConfigManager";

export function AutoStartAgent() {
  const app = useMountedApp();
  const { db, mediatorDID, initAgent, startAgent } = app;
  const dispatch = useDispatch();
  const enterpriseAgent = useAppSelector((state) => state.enterpriseAgent);
  const iagonStatus = app.iagonBackup?.status ?? 'idle';

  // 🔧 FIX #8: Track error state for user-visible feedback
  const [initError, setInitError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // Identifies the ServiceConfiguration credential (if any) by its own uuid, not by the whole
  // app.credentials array reference — so the effect below only re-runs its (non-idempotent-ish:
  // re-applies config, refreshes enterprise state, restarts polling) side effects when this
  // specific credential newly appears or is replaced, not on every unrelated credential arriving
  // (e.g. a later CISTraining/SecurityClearanceGrant VC) which would otherwise thrash them.
  const serviceConfigCredentialId = useMemo(() => {
    const cred = (app.credentials ?? []).find(
      (c: any) => getCredentialType(c) === 'ServiceConfiguration'
    );
    return cred ? (cred.uuid ?? cred.id ?? null) : null;
  }, [app.credentials]);

  // CONFIG LOADING: Derive enterprise configuration from actual credentials in IndexedDB.
  // This replaces the old localStorage-based approach which caused stale configs from
  // previous sessions to bleed into new ones.
  // Flow: agent starts → credentials loaded from IndexedDB into app.credentials →
  //       scan for ServiceConfiguration VC → extract + validate → apply if found,
  //       clear any stale localStorage entry if not found.
  // TODO: add revocation check (StatusList2021) once a lightweight check utility exists.
  useEffect(() => {
    if (!app.agent.hasStarted) return;

    try {
      const serviceConfigCred = (app.credentials ?? []).find(
        (cred: any) => getCredentialType(cred) === 'ServiceConfiguration'
      );

      if (serviceConfigCred) {
        const config = extractConfiguration(serviceConfigCred);
        if (config) {
          const validation = validateConfiguration(config);
          if (validation.isValid) {
            console.log('✅ [AutoStartAgent] ServiceConfiguration VC found — applying enterprise config');
            import('@/actions/enterpriseAgentActions').then(({ applyConfiguration }) => {
              applyConfiguration(config)(app.dispatch, app.getState);

              setTimeout(() => {
                import('@/actions/enterpriseAgentActions').then(({ refreshEnterpriseConnections, refreshEnterpriseCredentials }) => {
                  app.dispatch(refreshEnterpriseConnections());
                  app.dispatch(refreshEnterpriseCredentials());
                });
              }, 200);
            });

            // Start enterprise proof/offer polling as soon as a valid ServiceConfiguration VC is
            // present — reactive (this effect now depends on serviceConfigCredentialId), not a
            // one-shot check at agent-start. Previously the only check ran once, synchronously
            // right after startAgent() resolved; if the ServiceConfiguration VC (and the
            // enterprise connection it enables) arrived *after* that check — the normal case
            // during onboarding, since the wallet tab is typically already open and running —
            // polling never started for the rest of the session. Any present-proof request the
            // enterprise agent then sent sat unpolled in RequestReceived until it timed out
            // server-side, and required a hard refresh (which re-ran this check with the VC
            // already loaded) to recover.
            //
            // Guard is checked again *inside* the resolved import callback, not just before
            // starting it: `import()` of an already-loaded module still resolves as a microtask,
            // so two effect runs in quick succession (e.g. two credentials arriving back to back)
            // could otherwise both pass the outer check before either had assigned the interval,
            // leaking one. Since a resolved .then() callback runs to completion without
            // interleaving, re-checking here makes "has an interval already been started"
            // effectively atomic.
            if (!(window as any).__enterprisePollingInterval) {
              import('@/actions/enterpriseAgentActions').then(({
                pollPendingProofRequests,
                pollPendingCredentialOffers
              }) => {
                if ((window as any).__enterprisePollingInterval) return;

                app.dispatch(pollPendingProofRequests());
                app.dispatch(pollPendingCredentialOffers());

                const pollingInterval = setInterval(() => {
                  app.dispatch(pollPendingProofRequests());
                  app.dispatch(pollPendingCredentialOffers());
                }, 10000);

                (window as any).__enterprisePollingInterval = pollingInterval;
              });
            }
          } else {
            console.warn('⚠️ [AutoStartAgent] ServiceConfiguration VC invalid:', validation.errors);
            clearActiveConfiguration();
            app.dispatch(clearConfiguration());
          }
        } else {
          clearActiveConfiguration();
          app.dispatch(clearConfiguration());
        }
      } else {
        // No ServiceConfiguration VC in wallet — clear any stale localStorage entry
        console.log('ℹ️ [AutoStartAgent] No ServiceConfiguration VC in wallet — clearing stale enterprise config');
        clearActiveConfiguration();
        app.dispatch(clearConfiguration());
      }
    } catch (error) {
      console.error('⚠️ [AutoStartAgent] Error deriving enterprise configuration from credentials:', error);
    }

    // Cleanup on unmount AND before every re-run (e.g. when app.credentials changes again) —
    // paired with the `!(window as any).__enterprisePollingInterval` guard above, this makes
    // restarting the interval on each re-run idempotent rather than stacking intervals.
    return () => {
      if ((window as any).__enterprisePollingInterval) {
        clearInterval((window as any).__enterprisePollingInterval);
        (window as any).__enterprisePollingInterval = null;
      }
    };
  }, [app.agent.hasStarted, serviceConfigCredentialId]); // Re-run when the ServiceConfiguration VC itself appears/changes, not on every unrelated credential

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

  // Auto-start agent when it becomes available.
  // Block while a backup restore is in progress — agent.start() writes mediator data
  // to Pluto, which would cause backup.restore(jwe) to fail with "Pluto Store not empty".
  // The restore runs first (triggered by MainLayout), then iagonStatus changes to 'synced'
  // which unblocks this effect.
  useEffect(() => {
    if (iagonStatus === 'checking' || iagonStatus === 'downloading' || iagonStatus === 'restoring') return;
    if (app.agent.instance && !app.agent.hasStarted && !app.agent.isStarting) {
      startAgent({ agent: app.agent.instance })
        .then(() => {
          setStartError(null); // Clear any previous errors

          // Enterprise proof/credential-offer polling is started by the config-derivation effect
          // above, which reacts to serviceConfigCredentialId (not just this one-time hasStarted
          // flip) — it fires here too, since hasStarted flipping true re-runs that effect on the
          // same tick, and again later if a ServiceConfiguration VC arrives mid-session.
          //
          // CredentialOfferModal (mounted globally in _app.tsx) handles DIDComm
          // offer-credential messages and presents them to the user for manual acceptance.
          // DO NOT auto-accept here — blind auto-acceptance of all offers causes
          // repeated concurrent IndexedDB writes (one new PRISM DID per offer per cycle)
          // that corrupt the credential store.
        })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown start error';
          console.error('❌ [AutoStartAgent] Agent start failed:', error);
          setStartError(errorMessage);
        });
    }
  }, [app.agent.instance, app.agent.hasStarted, app.agent.isStarting, iagonStatus]);

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
