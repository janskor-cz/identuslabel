import { MountSDK } from '@/components/Agent';
import { AutoStartAgent } from '@/components/AutoStartAgent';
import WasmMemoryGuard from '@/components/WasmMemoryGuard';
import { CredentialOfferModal } from '@/components/CredentialOfferModal';
import { EnterpriseCredentialOfferModal } from '@/components/EnterpriseCredentialOfferModal';
import { CAPortalModal } from '@/components/CAPortalModal';
import { CAPortalProvider, useCAPortal } from '@/utils/CAPortalContext';
import { AccessRequestStatusModal } from '@/components/AccessRequestStatusModal';
import { IdentityApprovalModal, PendingIdentityApproval } from '@/components/IdentityApprovalModal';
import { useAppSelector } from '@/reducers/store';
import { useMountedApp, store } from '@/reducers/store';
import { reduxActions } from '@/reducers/app';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MainLayout } from '@/components/layouts/MainLayout';
import { CAConnectionEnforcementModal } from '@/components/CAConnectionEnforcementModal';
import { refreshConnections, deleteConnection } from '@/actions';
import { useRouter } from 'next/router';
import Head from 'next/head';
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
import * as SDK from '@hyperledger/identus-edge-agent-sdk';
import { getConnectionMetadata, saveConnectionMetadata, removeConnectionMetadata } from '@/utils/connectionMetadata';
import { extractSubjectFromVCProof } from '@/utils/connectionNameResolver';
import { detectLiveVerifiableIdentityType } from '@/utils/vcValidation';
import { verifyAndRecordLiveIdentity } from '@/utils/liveIdentityVerification';
import { parseServiceAccessGrant, isTrustedGrantSender, parseServiceAccessError } from '@/utils/serviceAccessGrant';
import { CA_CAPABILITIES } from '@/config/serviceTrust';
// Import cleanup utilities to auto-export to browser console
import '@/utils/clearWalletData';
import '@/utils/cleanupOrphanedPeerDIDs';
import { WALLET_ID, BUILD_STAMP, SDK_VERSION } from '@/config/walletNamespace';

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
    const { openCAPortal, pendingAccessRequest, setPendingAccessRequest } = useCAPortal();
    const seenGrantIds = useRef<Set<string>>(new Set());
    const seenErrorIds = useRef<Set<string>>(new Set());
    // The scan diagnostic below is worth keeping, but this effect re-runs on every render of
    // the owning tree (openCAPortal/setPendingAccessRequest are fresh identities each render),
    // so logging unconditionally re-dumped the WHOLE inbox each time — measured 2026-07-31:
    // 70 messages logged 24x = 1680 JSON.stringify + console.log calls in one session, all
    // captured to the debug log file. Log each message once instead; the diagnostic still
    // shows every message and whether it parsed.
    const loggedScanIds = useRef<Set<string>>(new Set());
    // pendingAccessRequest changes on every render of the owning tree while a request is in
    // flight; read the current value inside the effect via a ref so the effect doesn't need to
    // re-run (and doesn't need pendingAccessRequest in its dep array) just because that state
    // changed elsewhere.
    const pendingAccessRequestRef = useRef(pendingAccessRequest);
    pendingAccessRequestRef.current = pendingAccessRequest;

    useEffect(() => {
        if (!app.messages?.length) return;
        for (const message of app.messages) {
            const parsed = parseServiceAccessGrant(message);
            // Diagnostic: parseServiceAccessGrant fails silently by design (any shape mismatch
            // returns null), which made a real parsing bug indistinguishable from "not a grant
            // message" - this makes that visible without weakening the parser itself.
            if (!loggedScanIds.current.has(message.id)) {
                loggedScanIds.current.add(message.id);
                console.log('[GlobalGrantWatcher] Scanning message', {
                    id: message.id,
                    piuri: (message as any).piuri,
                    bodyPreview: typeof message.body === 'string' ? message.body.slice(0, 200) : JSON.stringify(message.body).slice(0, 200),
                    parsed: parsed ? { capability: parsed.capability, mode: parsed.mode } : null
                });
            }

            if (!parsed) {
                // Not a grant — check whether it's the service's failure counterpart. Without
                // this, a service-access/1.0/error (e.g. schema mismatch, untrusted issuer,
                // expired request) was silently dropped and the "Waiting for VC proof
                // request…" status modal spun forever with no indication anything went wrong.
                const parsedError = parseServiceAccessError(message);
                if (!parsedError) continue;

                const errorId = `${message.id}:${parsedError.thid ?? ''}`;
                if (seenErrorIds.current.has(errorId)) continue;
                seenErrorIds.current.add(errorId);

                const msgId = message.id;
                if (app.db.instance) {
                    app.db.instance.deleteMessage(msgId).catch((err) => {
                        console.error('[GlobalGrantWatcher] Failed to delete processed error message:', msgId, err);
                    });
                }
                app.dispatch(reduxActions.messageRemoved(msgId));

                const current = pendingAccessRequestRef.current;
                if (current && parsedError.thid && current.requestId === parsedError.thid) {
                    console.warn('[GlobalGrantWatcher] Access request failed', parsedError);
                    setPendingAccessRequest({ ...current, error: { code: parsedError.code, message: parsedError.message } });
                } else {
                    console.warn('[GlobalGrantWatcher] Ignoring service-access error with no matching pending request', {
                        thid: parsedError.thid, pendingRequestId: current?.requestId
                    });
                }
                continue;
            }

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
    }, [app.messages, app.connections, openCAPortal, setPendingAccessRequest]);

    return null;
}

const VC_PROOF_SHARING_PIURI = 'https://identuslabel.cz/protocols/vc-proof-sharing/1.0/proof';

/**
 * Live-verify a peer who has just disclosed their identity to us, so verification is SYMMETRIC.
 *
 * ── THE ASYMMETRY THIS CLOSES ────────────────────────────────────────────────────────────────
 * Only the INVITEE ran a live identity check. It gets the inviter's VC as a `vc-proof-0` preview
 * inside the OOB invitation, so after connecting it challenges the inviter with a fresh
 * present-proof request (OOB.tsx's `performLiveIdentityVerificationAndMaybeRespond`) and, once
 * that passes, discloses its own identity back over `vc-proof-sharing/1.0/proof`.
 *
 * The INVITER got nothing comparable. `ConnectionRequest.tsx` does have a counterpart
 * (`performLiveIdentityVerificationOfInvitee`), but it is gated on the incoming connection request
 * carrying a VC preview — and it never does: OOB.tsx strips all attachments before handing the
 * invitation to the SDK ("Stripped N attachment(s) ... for SDK compatibility"), so the request
 * arrives bare. Confirmed in the 13:37 logs: "No attached credential", then "No credentials found
 * — showing basic connection request UI".
 *
 * The invitee's disclosure then lands ~5 s AFTER the inviter has already accepted, too late for
 * connections.tsx's late-arrival path (which only upgrades a request still sitting in the queue).
 * All the inviter ever did with it was scrape a display name via
 * `getVerifiedNameFromVCProofSharing`. Net effect: the inviter's connection card showed a name and
 * no photo, because the photo comes from `ConnectionMetadata.verifiedCredentialSubject`, which
 * ONLY `liveIdentityVerification.ts` writes — and on the inviter's side nothing ever called it.
 *
 * ── WHY A CHALLENGE, RATHER THAN JUST TRUSTING THE DISCLOSURE ───────────────────────────────
 * The `vc-proof-sharing` message is unsolicited and its embedded JWT is decoded without signature
 * verification (see `extractSubjectFromVCProof`). Copying its credentialSubject into
 * `verifiedCredentialSubject` would show the photo immediately and silently redefine that field
 * from "cryptographically live-verified" to "whatever the peer claimed" — every consumer of it
 * (the avatar, the credential modal, the name priority chain) would inherit the weakening.
 *
 * So the disclosure is treated exactly like OOB.tsx treats the `vc-proof-0` preview: as an
 * UNVERIFIED anchor. Its `id`/`uniqueId` feed `verifyAndRecordLiveIdentity`, which issues a fresh
 * nonce-bound present-proof request and only records a verified subject if the peer signs the
 * live challenge with an `authentication` key AND the live credential still matches those anchors.
 * Same fail-closed helper, same bait-and-switch defense, both directions.
 *
 * No loop: the peer answers with `present-proof/3.0/presentation`, never another
 * `vc-proof-sharing`. Fire-and-forget and non-throwing throughout — a failure leaves the
 * connection exactly as it was, never tears one down.
 */
function GlobalIdentityDisclosureWatcher() {
    const app = useMountedApp();
    // Guards against re-firing within a session. The persisted 'pending'/'verified' status below
    // is the cross-session guard; this ref covers the window before that write lands, since this
    // effect re-runs on every messages/connections change.
    const startedFor = useRef<Set<string>>(new Set());
    // Every gate below is a silent `continue` by design — a disclosure we cannot act on must never
    // tear down or downgrade a connection. But that made "the watcher ran and rejected this
    // message" indistinguishable from "the watcher never ran at all", which cost a full test round
    // trip on 2026-07-31 (16:36 logs: the disclosure arrived, GlobalGrantWatcher logged it, and
    // this watcher produced nothing). Report the bail reason ONCE per message id — same approach,
    // and same motivation, as GlobalGrantWatcher's scan diagnostic above.
    const loggedSkipIds = useRef<Set<string>>(new Set());
    // Verified identities waiting on the user's Add contact / Decline. A queue, not a single slot:
    // the effect can resolve two verifications concurrently, and dropping one would silently keep
    // a connection the user never agreed to.
    const [approvalQueue, setApprovalQueue] = useState<PendingIdentityApproval[]>([]);

    useEffect(() => {
        const agent = app.agent.instance;
        if (!agent || !app.messages?.length || !app.connections?.length) return;

        const skip = (message: SDK.Domain.Message, reason: string, detail?: Record<string, any>) => {
            if (loggedSkipIds.current.has(message.id)) return;
            loggedSkipIds.current.add(message.id);
            console.log(`🔎 [DISCLOSURE-VERIFY] Not acting on disclosure ${message.id}: ${reason}`, detail ?? '');
        };

        for (const message of app.messages) {
            if (message.piuri !== VC_PROOF_SHARING_PIURI) continue;
            // Not logged: our OWN outbound disclosure appears here on the sender's side, and
            // reporting it as a skip would put a confusing line in every invitee log.
            if (message.direction !== SDK.Domain.MessageDirection.RECEIVED) continue;

            const senderDID = message.from?.toString();
            if (!senderDID) {
                skip(message, 'message has no sender DID');
                continue;
            }

            // Metadata is keyed by the connection's HOST DID everywhere else (see
            // connectionMetadata.ts), so resolve the pair rather than keying off the sender.
            const connection = app.connections.find(
                (c: SDK.Domain.DIDPair) => c.receiver.toString() === senderDID
            );
            if (!connection) {
                skip(message, 'no connection whose receiver matches the sender', {
                    sender: senderDID.substring(0, 40) + '...',
                    knownReceivers: app.connections.map(
                        (c: SDK.Domain.DIDPair) => c.receiver.toString().substring(0, 40) + '...'
                    ),
                });
                continue;
            }

            const hostDID = connection.host.toString();
            if (startedFor.current.has(hostDID)) continue;

            const metadata = getConnectionMetadata(hostDID);
            const status = metadata?.identityVerificationStatus;
            // 'failed' is deliberately retryable — the most common cause is a transport blip or
            // the peer dismissing the proof prompt, both of which a later disclosure can resolve.
            if (status === 'verified' || status === 'pending') {
                skip(message, `connection identityVerificationStatus is already '${status}'`);
                continue;
            }

            let vcProof: any = null;
            try {
                const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
                vcProof = body?.vcProof ?? null;
            } catch { /* not a disclosure we can read — reported just below */ }
            if (!vcProof) {
                skip(message, 'body carried no readable vcProof');
                continue;
            }

            const subject = extractSubjectFromVCProof(vcProof);
            const subjectDID: string | undefined = subject?.id;
            const uniqueId: string | undefined = subject?.uniqueId;
            const liveVerifiableType = subject
                ? detectLiveVerifiableIdentityType({ vcProof, revealedData: subject })
                : null;

            if (!subjectDID || liveVerifiableType === null) {
                // Not a type liveIdentityVerification.ts knows how to trust-check, or no subject
                // DID to anchor against — leave the connection unverified rather than guessing.
                skip(message, 'disclosure is not an anchorable live-verifiable identity', {
                    hasSubject: !!subject,
                    subjectKeys: subject ? Object.keys(subject) : [],
                    hasSubjectDID: !!subjectDID,
                    liveVerifiableType,
                });
                continue;
            }

            startedFor.current.add(hostDID);
            console.log(
                `🔐 [DISCLOSURE-VERIFY] Peer disclosed a ${liveVerifiableType} — live-verifying before trusting it:`,
                senderDID.substring(0, 40) + '...'
            );

            // Deliberately not awaited: the round trip needs a human on the peer's device to
            // approve a presentation request (see liveIdentityVerification.ts's doc comment).
            void verifyAndRecordLiveIdentity(
                agent,
                hostDID,
                connection.receiver,
                metadata?.walletType ?? 'local',
                subjectDID,
                uniqueId,
                liveVerifiableType
            ).then((result) => {
                if (result.verified) {
                    console.log('✅ [DISCLOSURE-VERIFY] Peer identity live-verified — connection upgraded');
                    // Hand the verified identity to the user for the ONE decision that is actually
                    // theirs to make (see IdentityApprovalModal's doc comment). Queued rather than
                    // replaced, so two pairings completing close together don't drop one silently.
                    setApprovalQueue((q) =>
                        q.some((a) => a.hostDID === hostDID)
                            ? q
                            : [...q, { hostDID, subject: result.verifiedSubject ?? {}, credentialType: liveVerifiableType }]
                    );
                } else {
                    console.warn('⚠️ [DISCLOSURE-VERIFY] Peer identity live verification FAILED:', result.error);
                    // Allow a later disclosure from this peer to retry (status is now 'failed').
                    startedFor.current.delete(hostDID);
                }
            });
        }
    }, [app.messages, app.connections, app.agent.instance]);

    const current = approvalQueue[0];
    if (!current) return null;

    const dismiss = () => setApprovalQueue((q) => q.filter((a) => a.hostDID !== current.hostDID));

    return (
        <IdentityApprovalModal
            approval={current}
            onAccept={() => {
                console.log('👍 [DISCLOSURE-VERIFY] User accepted the verified contact:', current.hostDID.substring(0, 40) + '...');
                dismiss();
            }}
            onDecline={async () => {
                console.log('🚫 [DISCLOSURE-VERIFY] User declined the verified contact — deleting connection:', current.hostDID.substring(0, 40) + '...');
                try {
                    await app.dispatch(deleteConnection({ connectionHostDID: current.hostDID }));
                    // Metadata lives in localStorage, outside Pluto, so deleteConnection does not
                    // reach it — leaving it behind would resurrect the declined party's verified
                    // name and photo on any future connection reusing this host DID.
                    removeConnectionMetadata(current.hostDID);
                    // Let a fresh disclosure from this peer start over rather than being suppressed
                    // by the in-session guard.
                    startedFor.current.delete(current.hostDID);
                } catch (e) {
                    console.error('❌ [DISCLOSURE-VERIFY] Failed to delete declined connection:', e);
                    alert('Could not remove the connection. It is still in your Connections list — you can delete it from there.');
                }
                dismiss();
            }}
        />
    );
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
            initSecureDashboardBridge(WALLET_ID);
        }

        // Initialize Console Logger (captures browser logs to server)
        if (typeof window !== 'undefined') {
            initConsoleLogger(WALLET_ID);
            // FIRST thing in every debug log: which bundle this tab is actually running. See
            // BUILD_STAMP's doc comment — a rebuilt server does not reach an already-open tab, so
            // without this a silent code path is ambiguous between "ran and bailed" and "not
            // loaded". Compare against the build you expect before drawing any other conclusion.
            console.log(`🏷️ [BUILD] wallet=${WALLET_ID} sdk=v${SDK_VERSION} built=${BUILD_STAMP}`);
        }

        // 🧪 Expose test functions for debugging encrypted messaging
        if (typeof window !== 'undefined') {
            (window as any).testEncryptionRoundtrip = testEncryptionRoundtrip;
            (window as any).testEncryptionWithStoredKeys = testEncryptionWithStoredKeys;
            // Read-only accessor for the live SDK agent instance - Redux state isn't a
            // global, so there's otherwise no console access to agent.pluto/etc for debugging.
            (window as any).getWalletAgent = () => store.getState().app.agent.instance;
            console.log('🧪 [DEBUG] Test functions exposed:');
            console.log('  - window.testEncryptionRoundtrip() - Manual key input');
            console.log('  - window.testEncryptionWithStoredKeys() - Auto localStorage retrieval');
            console.log('  - window.getWalletAgent() - Live SDK agent instance (e.g. getWalletAgent().pluto.getDIDPrivateKeysByDID(did))');
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
        <>
        <Head>
            <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        </Head>
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
                <GlobalIdentityDisclosureWatcher />
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
        </>
    );
}

export default App;