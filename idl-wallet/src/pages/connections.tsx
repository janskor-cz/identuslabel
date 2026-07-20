import '../app/index.css'

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { FooterNavigation } from "@/components/FooterNavigation";

import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { selectEnterpriseConnections, selectIsEnterpriseConfigured, selectActiveConfiguration } from "@/reducers/enterpriseAgent";
import { refreshEnterpriseConnections } from "@/actions/enterpriseAgentActions";
import { DBConnect } from "@/components/DBConnect";
import { OOB } from "@/components/OOB";
import { refreshConnections, deleteConnection } from "@/actions";
import { filterConnectionMessages } from "@/utils/messageFilters";
import { connectionRequestQueue, ConnectionRequestItem } from "@/utils/connectionRequestQueue";
import { messageRejection } from "@/utils/rejectionManager";
import { PendingRequestsModal } from "@/components/PendingRequestsModal";
import { getConnectionNameWithFallback } from "@/utils/connectionNameResolver";
import { getCredentialsForConnection, getPhotoBearingCredentialsForConnection } from "@/utils/connectionCredentialMatcher";
import { ConnectionCard } from "@/components/connections/ConnectionCard";
import { CredentialIssuanceRequestor } from "@/components/CredentialIssuanceRequestor";
import { ConnectionDetailsModal, ConnectionDetailsField } from "@/components/connections/ConnectionDetailsModal";
import { ConnectionCredentialsModal } from "@/components/connections/ConnectionCredentialsModal";
import { getConnectionMetadata } from "@/utils/connectionMetadata";
import { getTargetsForConnection, requestConnectionAccess } from "@/utils/connectionAccessTargets";
import { getCredentialType } from "@/utils/credentialTypeDetector";
import { getPinnedCA } from "@/utils/prefixedStorage";
import { useCAPortal } from "@/utils/CAPortalContext";
import { EnterpriseAgentClient, ColleagueRecord, PendingColleagueInvitation } from "@/utils/EnterpriseAgentClient";
import { getItem, setItem, removeItem, getKeysByPattern } from "@/utils/prefixedStorage";

// Staleness cutoff for connectionMetadata.verifiedCredentialSubject (see that field's doc comment
// in connectionMetadata.ts) — SSI-Agent security review flagged this as a point-in-time snapshot
// with no ongoing revocation check, so it's not trusted indefinitely.
const PREVIEW_PHOTO_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export default function App() {

    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => { setIsMounted(true); }, []);

    const app = useMountedApp();
    const router = useRouter();
    const { setPendingAccessRequest, pendingAccessRequest, openCAPortal } = useCAPortal();
    const [connections, setConnections] = React.useState<SDK.Domain.DIDPair[]>([]);
    const [connectionFilter, setConnectionFilter] = useState('');
    const [detailsModal, setDetailsModal] = useState<{ displayName: string; fields: ConnectionDetailsField[] } | null>(null);
    // Connection a credential-issuance/1.0 request is being made against — see ConnectionCard's
    // 🪪 button (isCA-gated below) and CredentialIssuanceRequestor.tsx.
    const [issuanceRequestFor, setIssuanceRequestFor] = useState<SDK.Domain.DIDPair | null>(null);
    const [credentialsModal, setCredentialsModal] = useState<{
        displayName: string;
        receiverDID: string;
        credentials: SDK.Domain.Credential[];
        // Live-verified (never issued/stored) identity of the connected party, in the same
        // { credentialSubject } shape a real held credential has — see
        // ConnectionMetadata.verifiedCredentialSubject's doc comment. Same 90-day freshness gate as
        // ConnectionAvatar's fallbackPhoto/fallbackUniqueId (previewPhotoFresh below); omitted
        // entirely once stale.
        verifiedCredential?: { credentialSubject: Record<string, any> };
    } | null>(null);

    // Enterprise connections from Redux
    const enterpriseConnections = useAppSelector(selectEnterpriseConnections);
    const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
    const activeConfig = useAppSelector(selectActiveConfiguration);

    // Persistent connection request queue state (hidden from UI, but still processed)
    const [persistentRequests, setPersistentRequests] = useState<ConnectionRequestItem[]>([]);
    const [queueLoading, setQueueLoading] = useState(false);
    const [queueError, setQueueError] = useState<string | null>(null);
    const [queueStats, setQueueStats] = useState<any>(null);

    // Rejection tracking state
    const [rejectionStats, setRejectionStats] = useState<any>(null);

    // Processing flag to prevent race conditions
    const [isProcessingMessages, setIsProcessingMessages] = useState(false);

    // Pending requests modal state
    const [showPendingRequestsModal, setShowPendingRequestsModal] = useState(false);

    // New connection modal
    const [showNewConnectionModal, setShowNewConnectionModal] = useState(false);

    // Colleague chat state
    const [showColleagueDirectory, setShowColleagueDirectory] = useState(false);
    const [colleagues, setColleagues] = useState<ColleagueRecord[]>([]);
    const [colleagueDirectoryLoading, setColleagueDirectoryLoading] = useState(false);
    const [connectingTo, setConnectingTo] = useState<string | null>(null);
    const [colleagueFilter, setColleagueFilter] = useState('');
    const [portalLoginPending, setPortalLoginPending] = useState(false);
    // Grant polling: set after sending access-request, cleared when grant arrives or times out
    const pendingGrantIdsRef = useRef<string[]>([]);
    const [pendingGrantBase, setPendingGrantBase] = useState<string | null>(null);

    // Stores host DID of a connection with an in-flight access request (ConnectionCard owns its
    // own popover open/close state; this only tracks the pending spinner across cards).
    const [accessPendingFor, setAccessPendingFor] = useState<string | null>(null);

    const handleRequestAccess = async (connection: SDK.Domain.DIDPair, target: string) => {
        if (!app.agent.instance || accessPendingFor) return;
        const hostDID = connection.host.toString();
        setAccessPendingFor(hostDID);
        try {
            await requestConnectionAccess({
                agent: app.agent.instance,
                dispatch: app.dispatch,
                connection,
                target,
                setPendingAccessRequest,
            });
        } finally {
            setAccessPendingFor(null);
        }
    };

    const handleOpenColleagueDirectory = async () => {
        if (!activeConfig) return;
        setColleagueFilter('');
        setColleagueDirectoryLoading(true);
        setShowColleagueDirectory(true);
        const client = new EnterpriseAgentClient(activeConfig);
        const result = await client.getColleagues();
        if (result.success && result.data) setColleagues(result.data);
        setColleagueDirectoryLoading(false);
    };

    const handleEnterprisePortalLogin = async () => {
        if (!activeConfig || accessPendingFor || pendingAccessRequest || portalLoginPending || pendingGrantBase) return;
        setPortalLoginPending(true);
        const client = new EnterpriseAgentClient(activeConfig);

        try {
            // Find EmployeeRole VC to resolve target key and connection
            const credsResult = await client.listCredentials();
            const allCreds = (credsResult.data as any)?.contents ?? [];
            const employeeRoleVC = allCreds.find((vc: any) => {
                const c = vc.claims ?? vc.credentialSubject ?? {};
                return c.credentialType === 'EmployeeRole' || c.accessTarget;
            });
            if (!employeeRoleVC) throw new Error('No EmployeeRole credential found in enterprise wallet.');

            const claims = employeeRoleVC.claims ?? employeeRoleVC.credentialSubject ?? {};
            const targetKey = claims.accessTarget;
            if (!targetKey) throw new Error('EmployeeRole VC is missing accessTarget field.');

            // Resolve enterprise connection ID
            let enterpriseConnectionId: string | undefined = claims.enterpriseConnectionId;
            if (!enterpriseConnectionId) {
                const companyPrefix = targetKey.split('-employee-portal')[0];
                const ACTIVE_STATES = ['ConnectionResponseReceived', 'ConnectionResponseSent', 'Active', 'ACTIVE', 'active'];
                const matched = enterpriseConnections.find(c =>
                    ACTIVE_STATES.includes(c.state) &&
                    (companyPrefix ? c.label?.toLowerCase().includes(companyPrefix.toLowerCase()) : true)
                ) ?? enterpriseConnections.find(c => ACTIVE_STATES.includes(c.state));
                enterpriseConnectionId = matched?.connectionId;
            }
            if (!enterpriseConnectionId) throw new Error('No active enterprise DIDComm connection found. Connect to your company in the Enterprise tab first.');

            // Derive company-admin base URL for grant polling
            let companyAdminBase: string | null = null;
            try {
                const svcUrl = new URL(claims.serviceUrl as string);
                const seg = svcUrl.pathname.split('/').filter(Boolean)[0];
                companyAdminBase = `${svcUrl.origin}${seg ? '/' + seg : ''}`;
            } catch { /* serviceUrl absent or malformed */ }

            // Send access request — company portal processes it via DIDComm and creates a proof.
            // SelectiveDisclosure handles user approval; HTTP polling below picks up the grant.
            const requestId = `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            const envelope = JSON.stringify({
                type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
                id: requestId,
                body: { capability: targetKey }
            });
            console.log(`[EnterprisePortalLogin] Sending access request, target=${targetKey}, conn=${enterpriseConnectionId}`);
            const sendResult = await client.sendBasicMessage(enterpriseConnectionId, envelope);
            if (!sendResult.success) throw new Error(`Failed to send access request: ${sendResult.error}`);

            // Register requestId for background grant polling
            pendingGrantIdsRef.current = [...pendingGrantIdsRef.current, requestId];
            if (companyAdminBase && !pendingGrantBase) setPendingGrantBase(companyAdminBase);
            console.log(`[EnterprisePortalLogin] Access request sent (${requestId}) — grant poller started.`);

        } catch (e: any) {
            console.error('[EnterprisePortalLogin] Failed:', e.message);
            alert(`Enterprise portal login failed: ${e.message}`);
        } finally {
            setPortalLoginPending(false);
        }
    };

    const handleConnectColleague = async (colleague: ColleagueRecord) => {
        if (!activeConfig || connectingTo) return;
        setConnectingTo(colleague.email);
        try {
            const client = new EnterpriseAgentClient(activeConfig);
            const inv = await client.createInvitation(colleague.full_name);
            if (!inv.success || !inv.data) throw new Error(inv.error || 'Failed to create invitation');
            const oob = inv.data.invitation?.invitationUrl ?? '';
            const oobBase64 = oob.includes('_oob=') ? oob.split('_oob=')[1] : oob;
            const send = await client.sendColleagueInvite(colleague.email, oobBase64, inv.data.connectionId, colleague.full_name);
            if (!send.success) throw new Error(send.error || 'Failed to send invitation');
            setConnectionNames(prev => new Map(prev).set(inv.data!.connectionId, colleague.full_name));
            alert(`Invitation sent to ${colleague.full_name}. They will be connected automatically.`);
        } catch (e: any) {
            alert(`Failed to connect: ${e.message}`);
        } finally {
            setConnectingTo(null);
        }
    };

    // Wallet tab selection
    const [walletTab, setWalletTab] = useState<'personal' | 'enterprise' | null>(null);
    const [enterpriseConfig, setEnterpriseConfig] = useState<{
        available: boolean;
        enterpriseAgentUrl?: string;
        enterpriseAgentName?: string;
        enterpriseAgentApiKey?: string;
    }>({ available: false });

    // Detect enterprise wallet context from ServiceConfiguration credentials
    useEffect(() => {
        const detectWalletContext = async () => {
            if (!app.db.instance) {
                console.log('ℹ️ [WALLET CONTEXT] Database not initialized yet');
                return;
            }

            try {
                console.log('🏢 [WALLET CONTEXT] Checking for ServiceConfiguration credential...');
                const credentials = await app.db.instance.getAllCredentials();

                // Look for ServiceConfiguration credential
                const serviceConfigVC = credentials.find((cred: any) => {
                    const credentialSubject = cred.credentialSubject;
                    const vcTypes = cred.credentialType || cred.type || [];
                    const typesArray = Array.isArray(vcTypes) ? vcTypes : [vcTypes];

                    // Check EITHER type field OR presence of enterprise fields
                    const hasServiceConfigType = typesArray.includes('ServiceConfiguration');
                    const hasEnterpriseFields = credentialSubject &&
                        credentialSubject.enterpriseAgentUrl &&
                        credentialSubject.enterpriseAgentName &&
                        credentialSubject.enterpriseAgentApiKey;

                    const isServiceConfig = hasServiceConfigType || hasEnterpriseFields;

                    if (isServiceConfig) {
                        console.log('✅ [WALLET CONTEXT] Found ServiceConfiguration credential:', {
                            types: typesArray,
                            hasTypeField: hasServiceConfigType,
                            hasEnterpriseFields: hasEnterpriseFields,
                            credentialSubject
                        });
                    }

                    return isServiceConfig;
                });

                if (serviceConfigVC) {
                    const credentialSubject = serviceConfigVC.credentialSubject;

                    console.log('🏢 [WALLET CONTEXT] Enterprise wallet available:', {
                        url: credentialSubject.enterpriseAgentUrl,
                        name: credentialSubject.enterpriseAgentName
                    });

                    setWalletTab('enterprise');
                    setEnterpriseConfig({
                        available: true,
                        enterpriseAgentUrl: credentialSubject.enterpriseAgentUrl,
                        enterpriseAgentName: credentialSubject.enterpriseAgentName,
                        enterpriseAgentApiKey: credentialSubject.enterpriseAgentApiKey
                    });
                } else {
                    console.log('ℹ️ [WALLET CONTEXT] No ServiceConfiguration credential found');
                    setWalletTab('personal');
                    setEnterpriseConfig({ available: false });
                }
            } catch (error) {
                console.error('❌ [WALLET CONTEXT] Error detecting wallet context:', error);
                setWalletTab('personal');
                setEnterpriseConfig({ available: false });
            }
        };

        detectWalletContext();
    }, [app.db.instance, app.credentials]);

    useEffect(() => {
        setConnections(app.connections)
    }, [app.connections])


    // Fetch enterprise connections when switching to enterprise mode
    useEffect(() => {
        const fetchEnterpriseConnections = async () => {
            if (walletTab === 'enterprise' && isEnterpriseConfigured) {
                console.log('🔄 [CONNECTIONS] Fetching enterprise connections...');

                try {
                    await app.dispatch(refreshEnterpriseConnections()).unwrap();
                    console.log('✅ [CONNECTIONS] Enterprise connections refreshed');
                } catch (error) {
                    console.error('❌ [CONNECTIONS] Failed to fetch enterprise connections:', error);
                }
            }
        };

        fetchEnterpriseConnections();

        // Set up polling interval
        const interval = setInterval(() => {
            if (walletTab === 'enterprise' && isEnterpriseConfigured) {
                fetchEnterpriseConnections();
            }
        }, 30000); // Poll every 30 seconds

        return () => clearInterval(interval);
    }, [walletTab, isEnterpriseConfigured, app.dispatch]);

    // Colleague invitation auto-accept polling (enterprise mode only) — message polling for the
    // enterprise chat itself now lives in messages.tsx, which owns that conversation UI.
    useEffect(() => {
        if (walletTab !== 'enterprise' || !isEnterpriseConfigured || !activeConfig) return;

        const client = new EnterpriseAgentClient(activeConfig);

        // Register this wallet's webhook so the company portal can forward BasicMessageReceived events
        const webhookUrl = `https://identuslabel.cz/company-admin/api/enterprise-messages-webhook?walletId=${activeConfig.enterpriseAgentWalletId}`;
        client.registerWebhook(webhookUrl).then(r => {
            if (!r.success) console.warn('[ColleagueChat] Webhook registration failed:', r.error);
            else console.log('[ColleagueChat] Webhook registered:', webhookUrl);
        });

        const pollInvitations = async () => {
            const result = await client.getColleagueInvitations();
            if (!result.success || !result.data?.length) return;
            for (const inv of result.data) {
                console.log(`[ColleagueChat] Auto-accepting invitation from ${inv.fromEmail}`);
                const accepted = await client.acceptInvitation(inv.oobBase64, inv.fromName || inv.fromEmail);
                if (accepted.success && accepted.data?.connectionId) {
                    await client.consumeColleagueInvitation(inv.id, accepted.data.connectionId);
                    await app.dispatch(refreshEnterpriseConnections());
                    console.log(`[ColleagueChat] Connected to ${inv.fromEmail} (conn: ${accepted.data.connectionId})`);
                }
            }
        };

        pollInvitations();

        const invInterval  = setInterval(pollInvitations,  15000);
        return () => { clearInterval(invInterval); };
    }, [walletTab, isEnterpriseConfigured, activeConfig]);

    // Background grant polling: starts when access-request is sent, stops on grant or 2-min timeout.
    // The grant arrives at the enterprise wallet (not personal wallet), so GlobalGrantWatcher can't
    // see it. We poll the company-admin HTTP endpoint which mirrors the DIDCommCommandService grant map.
    useEffect(() => {
        if (!pendingGrantBase) return;
        let cancelled = false;
        const deadline = Date.now() + 120_000;

        const poll = async () => {
            while (!cancelled && Date.now() < deadline) {
                const ids = [...pendingGrantIdsRef.current];
                for (const reqId of ids) {
                    try {
                        const res = await fetch(`${pendingGrantBase}/api/enterprise-portal/grant-status?requestId=${encodeURIComponent(reqId)}`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data.success && data.grant?.accessUrl) {
                                console.log(`[EnterpriseGrantPoller] Grant received for ${reqId.slice(0, 12)}`);
                                openCAPortal(data.grant.accessUrl);
                                pendingGrantIdsRef.current = [];
                                setPendingGrantBase(null);
                                return;
                            }
                            if (data.error) {
                                console.warn(`[EnterpriseGrantPoller] Access request failed for ${reqId.slice(0, 12)}: ${data.error} — ${data.message ?? ''}`);
                                pendingGrantIdsRef.current = [];
                                setPendingGrantBase(null);
                                return;
                            }
                        }
                    } catch { /* transient */ }
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            if (!cancelled) {
                console.warn('[EnterpriseGrantPoller] Timed out waiting for grant');
                pendingGrantIdsRef.current = [];
                setPendingGrantBase(null);
            }
        };

        poll();
        return () => { cancelled = true; };
    }, [pendingGrantBase, openCAPortal]);

    // Load persistent connection requests from IndexedDB
    const loadPersistentRequests = async () => {
        try {
            setQueueLoading(true);
            setQueueError(null);

            // Get wallet ID from app configuration
            const walletId = app.wallet.walletId;

            const requests = await connectionRequestQueue.getPendingRequests(walletId);

            setPersistentRequests(requests);

            // Load queue statistics
            const stats = await connectionRequestQueue.getStats(walletId);
            setQueueStats(stats);

            // Load rejection statistics
            try {
                const rejectionStats = await messageRejection.getStats(walletId);
                setRejectionStats(rejectionStats);
            } catch (rejectionError) {
                console.warn('⚠️ [REJECTION MANAGER] Failed to load rejection stats:', rejectionError);
            }

        } catch (error) {
            console.error('❌ [PERSISTENT QUEUE] Failed to load requests:', error);
            setQueueError(error.message || 'Failed to load connection requests');
        } finally {
            setQueueLoading(false);
        }
    };


    // Save new connection requests to persistent queue
    const saveRequestToPersistentQueue = async (message: SDK.Domain.Message, vcOverride?: any) => {
        try {
            const walletId = app.wallet.walletId;

            // Extract attached credential — vcOverride takes priority (vc-proof-sharing path)
            const attachedCredential = vcOverride ?? extractCredentialFromMessage(message);

            const requestId = await connectionRequestQueue.addRequest(
                walletId,
                message,
                attachedCredential,
                24 // expire in 24 hours
            );


            // Reload the queue to show the new request
            await loadPersistentRequests();

        } catch (error) {
            console.error('❌ [PERSISTENT QUEUE] Failed to save request:', error);
        }
    };

    // Handle connection request acceptance/rejection
    const handlePersistentRequestAction = async (
        requestId: string,
        action: 'accepted' | 'rejected',
        verificationResult?: any
    ) => {
        try {
            const walletId = app.wallet.walletId;

            await connectionRequestQueue.handleRequest(walletId, requestId, action, verificationResult);

            // Reload the queue to update the UI
            await loadPersistentRequests();


        } catch (error) {
            console.error('❌ [PERSISTENT QUEUE] Failed to handle request action:', error);
        }
    };

    // Enhanced credential extraction from message attachments AND body
    const extractCredentialFromMessage = (message: SDK.Domain.Message): any => {
        try {

            // PRIORITY 1: Check message body for requests_attach field (NEW PATTERN)
            // This pattern survives IndexedDB serialization (body can be string or object)
            try {
                // FIX: Handle both string and object body types
                let messageBody;
                if (typeof message.body === 'string') {
                    messageBody = JSON.parse(message.body);
                } else if (typeof message.body === 'object' && message.body !== null) {
                    messageBody = message.body;
                } else {
                    console.warn('⚠️ [VC-EXTRACTION] Message body has unexpected type:', typeof message.body);
                    throw new Error('Invalid message body type');
                }

                if (messageBody.requests_attach && messageBody.requests_attach.length > 0) {

                    for (const attachment of messageBody.requests_attach) {

                        // Look for vc-proof-response in requests_attach
                        if (attachment["@id"] === "vc-proof-response") {

                            // Extract credential from data.json field (NOT data.base64)
                            if (attachment.data && attachment.data.json) {
                                let credentialData = attachment.data.json;

                                // FALLBACK: Unwrap SDK.Domain.Credential wrapper if present
                                if (credentialData.credentialType === 'prism/jwt' &&
                                    credentialData.recoveryId === 'jwt+credential' &&
                                    !credentialData.credentialSubject) {

                                    // Try multiple extraction methods
                                    if (typeof credentialData.verifiableCredential === 'function') {
                                        credentialData = credentialData.verifiableCredential();
                                    } else if (credentialData.vc) {
                                        credentialData = credentialData.vc;
                                    } else if (credentialData.properties) {
                                        credentialData = credentialData.properties;
                                    } else {
                                        console.warn('⚠️ [VC-EXTRACTION] SDK wrapper detected but unable to unwrap');
                                    }
                                }

                                // Validate credential structure
                                if (credentialData.type || credentialData.credentialType || credentialData.credentialSubject) {
                                    return credentialData;
                                } else {
                                    console.warn('⚠️ [VC-EXTRACTION] Data does not look like a valid credential');
                                }
                            } else {
                                console.warn('⚠️ [VC-EXTRACTION] Attachment missing data.json field');
                            }
                        }
                    }
                } else {
                }
            } catch (bodyParseError) {
            }

            // PRIORITY 2: Check SDK attachments array (LEGACY FALLBACK)
            if (message.attachments && message.attachments.length > 0) {
                for (const attachment of message.attachments) {

                    // Priority check for "vc-proof-response" attachment ID
                    if (attachment.id === 'vc-proof-response') {

                        // Handle both base64 and raw data formats
                        let credentialData = null;

                        // Try base64 format first
                        if (attachment.data) {
                            try {
                                // AttachmentDescriptor stores data as base64 string directly
                                const decodedData = atob(attachment.data.toString());
                                credentialData = JSON.parse(decodedData);
                            } catch (base64Error) {
                                console.warn('⚠️ [VC-EXTRACTION] Failed to decode as base64, trying as direct data:', base64Error.message);
                                // Try direct data access
                                credentialData = attachment.data;
                            }
                        }

                        // Validate credential structure
                        if (credentialData) {
                            // Check if it's a valid VC (has type, credentialSubject, etc.)
                            if (credentialData.type || credentialData.credentialType || credentialData.credentialSubject) {
                                return credentialData;
                            } else {
                                console.warn('⚠️ [VC-EXTRACTION] Data does not look like a valid credential');
                            }
                        }
                    }

                    // Fallback to legacy extraction for backward compatibility
                    if (attachment.data && attachment.data.base64) {
                        try {
                            const decodedData = atob(attachment.data.base64);
                            const parsedData = JSON.parse(decodedData);

                            // Check for various credential wrapper formats
                            if (parsedData.verifiableCredential) {
                                return parsedData.verifiableCredential;
                            }
                            if (parsedData.credentials) {
                                return parsedData.credentials[0] || parsedData.credentials;
                            }
                            if (parsedData.credential) {
                                return parsedData.credential;
                            }

                            // Check if the decoded data itself is a credential
                            if (parsedData.type || parsedData.credentialType || parsedData.credentialSubject) {
                                return parsedData;
                            }
                        } catch (legacyError) {
                            console.warn('⚠️ [VC-EXTRACTION] Legacy extraction failed:', legacyError.message);
                        }
                    }
                }

            } else {
            }
        } catch (error) {
            console.error('❌ [VC-EXTRACTION] Error extracting credential from message:', error);
        }
        return null;
    };

    const extractPthid = (msg: SDK.Domain.Message): string | null => {
        try {
            const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
            return (body?.pthid || body?.['~thread']?.pthid) ?? null;
        } catch { return null; }
    };

    const extractVCFromSharingMessage = (msg: SDK.Domain.Message): any | null => {
        try {
            const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
            return body?.vcProof ?? null;
        } catch { return null; }
    };

    // Refresh connections and load persistent requests when page loads
    useEffect(() => {

        if (app.db.instance && app.db.connected) {
            app.dispatch(refreshConnections());

            // Load persistent connection requests
            loadPersistentRequests();
        } else {
        }
    }, [app.db.instance, app.db.connected, app.dispatch])

    // Monitor for new connection requests and save them to persistent queue
    useEffect(() => {
        const processMessages = async () => {
            // Prevent concurrent executions with processing flag
            if (isProcessingMessages) {
                return;
            }

            setIsProcessingMessages(true);

            try {
                // Filter for both Mercury AND DIDExchange protocol connection requests
                const connectionRequests = filterConnectionMessages(app.messages).filter(
                    msg => (
                        msg.piuri === 'https://atalaprism.io/mercury/connections/1.0/request' ||
                        msg.piuri === 'https://didcomm.org/didexchange/1.0/request'
                    ) &&
                    msg.direction === SDK.Domain.MessageDirection.RECEIVED &&
                    !hasAcceptedConnection(msg)
                );

                // Filter out rejected messages
                const nonRejectedRequests = await filterRejectedMessages(connectionRequests);

                // Use for...of instead of forEach for proper async/await
                for (const request of nonRejectedRequests) {
                    const existingRequest = persistentRequests.find(pr => pr.message.id === request.id);
                    if (!existingRequest) {
                        const senderDID = request.from?.toString();

                        // Check whether the vc-proof-sharing message already arrived from this sender
                        const vcMsg = senderDID
                            ? (app.messages as SDK.Domain.Message[]).find((m: SDK.Domain.Message) =>
                                m.piuri === 'https://identuslabel.cz/protocols/vc-proof-sharing/1.0/proof' &&
                                m.from?.toString() === senderDID &&
                                m.direction === SDK.Domain.MessageDirection.RECEIVED
                              )
                            : undefined;

                        if (vcMsg) {
                            // VC proof arrived — queue with credential attached
                            const vcProof = extractVCFromSharingMessage(vcMsg);
                            console.log('✅ [VC PROOF DEFERRED] vc-proof-sharing found for sender:', senderDID?.substring(0, 50), '| vcProof keys:', vcProof ? Object.keys(vcProof) : null);
                            await saveRequestToPersistentQueue(request, vcProof ?? undefined);
                            removeItem(`vc-wait-${request.id}`);
                        } else {
                            // No vc-proof yet. Defer only if any active invitation requested VC proof.
                            const invitationKeys = getKeysByPattern('invitation-');
                            let hasActiveVCRequest = false;
                            for (const key of invitationKeys) {
                                const meta = getItem(key);
                                if (meta?.includeVCRequest === true) {
                                    hasActiveVCRequest = true;
                                    break;
                                }
                            }

                            if (hasActiveVCRequest) {
                                // Defer — vc-proof-sharing will arrive shortly; re-check on next poll
                                if (!getItem(`vc-wait-${request.id}`)) {
                                    setItem(`vc-wait-${request.id}`, String(Date.now()));
                                }
                                const waitedMs = Date.now() - parseInt(getItem(`vc-wait-${request.id}`) || '0', 10);
                                if (waitedMs > 30000) {
                                    // 30 s timeout: surface without VC as graceful fallback
                                    await saveRequestToPersistentQueue(request);
                                    removeItem(`vc-wait-${request.id}`);
                                }
                                // else: effect re-runs when app.messages changes (next poll)
                            } else {
                                // No invitation required VC proof — queue immediately
                                await saveRequestToPersistentQueue(request);
                            }
                        }
                    }
                }

            } catch (error) {
                console.error('❌ [MESSAGE PROCESSING] Error processing messages:', error);
            } finally {
                setIsProcessingMessages(false);
            }
        };

        processMessages();
    }, [app.messages, persistentRequests])

    // Helper function to check if a connection request already has an established connection
    const hasAcceptedConnection = (message: SDK.Domain.Message): boolean => {
        try {
            // Check if we have an established connection for this message's sender
            const senderDID = message.from?.toString();
            if (!senderDID) return false;

            // Look for a connection with this DID
            const existingConnection = app.connections.find(conn => {
                const receiverDID = conn.receiver?.toString();
                return receiverDID === senderDID;
            });

            return !!existingConnection;
        } catch (error) {
            console.error('❌ [CONNECTION CHECK] Error checking for existing connection:', error);
            return false;
        }
    };

    // Helper function to filter out rejected messages
    const filterRejectedMessages = async (messages: SDK.Domain.Message[]): Promise<SDK.Domain.Message[]> => {
        try {
            const walletId = app.wallet.walletId;
            const nonRejectedMessages: SDK.Domain.Message[] = [];

            for (const message of messages) {
                const isRejected = await messageRejection.isRejected(walletId, message.id);
                if (!isRejected) {
                    nonRejectedMessages.push(message);
                }
            }

            return nonRejectedMessages;
        } catch (error) {
            console.error('❌ [REJECTION FILTER] Error filtering rejected messages:', error);
            return messages; // Return all messages if filtering fails
        }
    };

    if (!isMounted) {
        return (
            <div>
                <header className="mb-8">
                    <h2 className="text-2xl font-bold text-white mb-1">Connections</h2>
                    <p className="text-slate-400 text-sm">Manage your DIDComm connections</p>
                </header>
            </div>
        );
    }

    return (
        <div>
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-1">Connections</h2>
                <p className="text-slate-400 text-sm">Manage your DIDComm connections</p>
            </header>

            <DBConnect>
                    {/* Pending Requests Modal */}
                    <PendingRequestsModal
                        visible={showPendingRequestsModal}
                        onClose={() => setShowPendingRequestsModal(false)}
                        requests={persistentRequests}
                        onRequestHandled={handlePersistentRequestAction}
                        queueLoading={queueLoading}
                        queueError={queueError}
                        refreshConnections={async () => {
                            await app.dispatch(refreshConnections());
                        }}
                        deleteMessage={async (messageId: string) => {
                            if (app.db.instance) {
                                await app.db.instance.deleteMessage(messageId);
                            }
                        }}
                    />

                    {/* Connections Section */}
                    <Box>
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-bold text-white">
                                Established Connections
                            </h2>
                            <div className="flex items-center gap-2">
                                {persistentRequests.length > 0 && (
                                    <button
                                        onClick={() => setShowPendingRequestsModal(true)}
                                        className="relative px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 text-white rounded-xl transition-all font-medium text-sm"
                                    >
                                        <span className="absolute -top-2 -right-2 bg-red-500/90 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold border-2 border-slate-900">
                                            {persistentRequests.length > 9 ? '9+' : persistentRequests.length}
                                        </span>
                                        Pending Requests
                                    </button>
                                )}
                                {walletTab === 'enterprise' && isEnterpriseConfigured && (
                                    <button
                                        onClick={handleOpenColleagueDirectory}
                                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white rounded-xl transition-all font-medium text-sm"
                                    >
                                        <span>👥</span>
                                        Connect to Colleague
                                    </button>
                                )}
                                <button
                                    onClick={() => setShowNewConnectionModal(true)}
                                    className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 text-white rounded-xl transition-all font-medium text-sm"
                                >
                                    <span className="font-bold">+</span>
                                    New Connection
                                </button>
                            </div>
                        </div>

                        {/* Wallet Tabs */}
                        <div className="flex flex-wrap gap-1 mb-6 bg-slate-800/60 p-1 rounded-xl border border-slate-700/50 w-fit">
                            <button
                                onClick={() => setWalletTab('personal')}
                                className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                                    walletTab === 'personal'
                                        ? 'bg-slate-700 text-white shadow'
                                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                }`}
                            >
                                🪪 Personal
                                {connections.length > 0 && (
                                    <span className={`px-1.5 py-0.5 text-xs rounded-full ${walletTab === 'personal' ? 'bg-cyan-500/30 text-cyan-300' : 'bg-slate-700 text-slate-400'}`}>
                                        {connections.length}
                                    </span>
                                )}
                            </button>
                            {isEnterpriseConfigured && (
                                <button
                                    onClick={() => enterpriseConfig.available && setWalletTab('enterprise')}
                                    className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                                        walletTab === 'enterprise'
                                            ? 'bg-slate-700 text-white shadow'
                                            : enterpriseConfig.available
                                            ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                            : 'text-slate-600 cursor-not-allowed'
                                    }`}
                                >
                                    🏢 Enterprise
                                    {enterpriseConnections.length > 0 && (
                                        <span className={`px-1.5 py-0.5 text-xs rounded-full ${walletTab === 'enterprise' ? 'bg-cyan-500/30 text-cyan-300' : 'bg-slate-700 text-slate-400'}`}>
                                            {enterpriseConnections.length}
                                        </span>
                                    )}
                                </button>
                            )}
                        </div>
                        {/* Filter by connection name — shared between Personal and Enterprise tabs */}
                        <div className="mb-4 max-w-md">
                            <input
                                type="text"
                                value={connectionFilter}
                                onChange={(e) => setConnectionFilter(e.target.value)}
                                placeholder="🔍 Filter by connection name…"
                                className="w-full px-4 py-2 bg-slate-800/60 border border-slate-700/50 rounded-xl text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500"
                            />
                        </div>

                        {/* Conditional connection source based on wallet tab */}
                        {(() => {
                            const isEnterpriseMode = walletTab === 'enterprise';
                            const connectionsToDisplay = isEnterpriseMode ? enterpriseConnections : connections;
                            const hasConnections = connectionsToDisplay.length > 0;

                            if (!hasConnections) {
                                return (
                                    <p className="text-lg font-normal text-slate-300 lg:text-xl">
                                        {isEnterpriseMode
                                            ? 'No enterprise connections established.'
                                            : 'No established connections.'}
                                    </p>
                                );
                            }

                            const filterLower = connectionFilter.trim().toLowerCase();

                            if (isEnterpriseMode) {
                                // `label` is nearly always empty for these (see EnterpriseConnection's
                                // `goal` field comment — the Cloud Agent's invitee-side accept endpoint
                                // has no `label` field at all). `goal` is transmitted to the invitee, but
                                // it's a full sentence ("Establish connection between...") when present,
                                // and absent entirely for connections whose inviter only set `goalCode`
                                // (e.g. document-service's invitation, which sets goalCode: 'document-access'
                                // with no goal string) — so it's inconsistent as the primary label. Prefer
                                // a proper name we already control: activeConfig.enterpriseAgentName comes
                                // from the applied ServiceConfiguration VC, not from the Cloud Agent's
                                // per-connection fields, so it's always a real name once configured. The
                                // one known goalCode value that means something different (document-service)
                                // is called out explicitly so the two enterprise connections aren't both
                                // shown under the same label.
                                const withNames = enterpriseConnections.map(connection => ({
                                    connection,
                                    displayName: connection.goalCode === 'document-access'
                                        ? 'Document Service'
                                        : (activeConfig?.enterpriseAgentName || connection.label || connection.goal || `Connection ${connection.connectionId.substring(0, 8)}...`),
                                }));
                                const filtered = filterLower
                                    ? withNames.filter(({ displayName }) => displayName.toLowerCase().includes(filterLower))
                                    : withNames;

                                return (<>
                                    <div className="mb-4">
                                        <span className="text-xs text-slate-500">{filtered.length} connection{filtered.length !== 1 ? 's' : ''}</span>
                                    </div>
                                    {filtered.length === 0 ? (
                                        <p className="text-slate-400 text-sm">No connections match "{connectionFilter}".</p>
                                    ) : (
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
                                            {filtered.map(({ connection, displayName }) => {
                                                const isConnected = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active', 'ACTIVE', 'active'].includes(connection.state);
                                                const isDocumentService = connection.goalCode === 'document-access';

                                                return (
                                                    <ConnectionCard
                                                        key={`ent-connection-${connection.connectionId}`}
                                                        displayName={displayName}
                                                        entityIcon={isDocumentService ? '📄' : '🏢'}
                                                        entityAccentClass="bg-indigo-500/10 text-indigo-300"
                                                        accessTargets={isConnected ? [{ key: 'portal-login', label: 'Employee Portal Login', icon: '🏢' }] : []}
                                                        accessPending={portalLoginPending || !!pendingGrantBase}
                                                        onMessage={() => router.push(`/messages?connection=${encodeURIComponent(connection.connectionId)}&mode=enterprise`)}
                                                        onRequestAccess={() => handleEnterprisePortalLogin()}
                                                        onViewDetails={() => setDetailsModal({
                                                            displayName,
                                                            fields: [
                                                                { label: 'Connection ID', value: connection.connectionId },
                                                                ...(connection.myDid ? [{ label: 'My DID', value: connection.myDid }] : []),
                                                                ...(connection.theirDid ? [{ label: 'Their DID', value: connection.theirDid }] : []),
                                                            ],
                                                        })}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                </>);
                            } else {
                                // Plain function calls, not hooks — safe to call directly in this
                                // map callback. usePhotoDID itself only runs inside ConnectionAvatar,
                                // which is a real component rendered via JSX inside ConnectionCard, so
                                // rules-of-hooks is satisfied without needing to hoist this whole card
                                // into its own component. Matches via the issue-credential message that
                                // delivered each credential (from === receiverDID), not credential.subject
                                // — see connectionCredentialMatcher.ts for why.
                                const withNames = connections.map(connection => ({
                                    connection,
                                    displayName: connection.name || getConnectionNameWithFallback(
                                        connection.receiver.toString(),
                                        app.credentials,
                                        undefined,
                                        app.messages
                                    ),
                                }));
                                const filtered = filterLower
                                    ? withNames.filter(({ displayName }) => displayName.toLowerCase().includes(filterLower))
                                    : withNames;

                                if (filtered.length === 0) {
                                    return <p className="text-slate-400 text-sm">No connections match "{connectionFilter}".</p>;
                                }

                                return (
                                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
                                        {filtered.map(({ connection, displayName }) => {
                                            const hostDID = connection.host.toString();
                                            const receiverDID = connection.receiver.toString();

                                            const matchingCredentials = getCredentialsForConnection(receiverDID, app.credentials, app.messages);
                                            const photoCandidates = getPhotoBearingCredentialsForConnection(receiverDID, app.credentials, app.messages);

                                            const connectionMetadata = getConnectionMetadata(hostDID);
                                            const walletType = connectionMetadata?.walletType || 'local';
                                            const isCloudWallet = walletType === 'cloud';

                                            // Post-connection live identity verification (RealPerson-typed
                                            // invitations only — see utils/liveIdentityVerification.ts and
                                            // OOB.tsx's performLiveIdentityVerificationAndMaybeRespond). Absent
                                            // entirely for connections that never carried a RealPerson preview.
                                            // Shown as a checkmark overlaid on the card's photo — 'pending'/
                                            // 'failed' aren't surfaced on the card itself (no icon clutter for a
                                            // check that hasn't resolved either way); Details still shows the
                                            // error via identityVerificationError if it's ever needed.
                                            const identityVerificationStatus = connectionMetadata?.identityVerificationStatus;

                                            // Connections that expose service-access/1.0 capabilities, or that
                                            // carried an EmployeeRole VC (issued BY a company, to the wallet
                                            // holder — the photo on it is the holder's own face, not the
                                            // company's), are to an organization/service rather than an
                                            // individual contact — show a logo glyph instead of ConnectionAvatar,
                                            // which would otherwise either find nothing or show the wrong photo.
                                            const accessTargets = getTargetsForConnection(connection);
                                            const hasEmployeeRoleCredential = matchingCredentials.some(c => getCredentialType(c) === 'EmployeeRole');
                                            const isEntityConnection = accessTargets.length > 0 || hasEmployeeRoleCredential;
                                            const isCA = !!connectionMetadata?.isCAConnection || displayName.toLowerCase().includes('certification authority');

                                            const detailFields: ConnectionDetailsField[] = [];
                                            if (isCloudWallet && connectionMetadata?.prismDid) {
                                                detailFields.push({ label: 'PRISM DID', value: connectionMetadata.prismDid });
                                            }
                                            if (isCloudWallet && connectionMetadata?.enterpriseAgentUrl) {
                                                detailFields.push({ label: 'Enterprise Agent URL', value: connectionMetadata.enterpriseAgentUrl });
                                            }
                                            detailFields.push({ label: 'Host DID (Your Identity)', value: hostDID });
                                            detailFields.push({ label: 'Receiver DID (Connected Party)', value: receiverDID });

                                            const previewPhotoFresh = !!connectionMetadata?.identityVerifiedAt
                                                && (Date.now() - connectionMetadata.identityVerifiedAt) < PREVIEW_PHOTO_TTL_MS;

                                            return (
                                                <ConnectionCard
                                                    key={`connection-${hostDID}`}
                                                    displayName={displayName}
                                                    verified={identityVerificationStatus === 'verified'}
                                                    {...(isEntityConnection
                                                        ? {
                                                            entityIcon: isCA ? '🏛️' : '🏢',
                                                            entityAccentClass: isCA
                                                                ? 'bg-amber-500/10 text-amber-300'
                                                                : 'bg-indigo-500/10 text-indigo-300',
                                                        }
                                                        : {
                                                            photoBearingCredentials: photoCandidates,
                                                            fallbackPhoto: previewPhotoFresh ? connectionMetadata?.verifiedCredentialSubject?.photo : undefined,
                                                            fallbackUniqueId: previewPhotoFresh ? connectionMetadata?.verifiedCredentialSubject?.uniqueId : undefined,
                                                        })}
                                                    accessTargets={accessTargets}
                                                    accessPending={accessPendingFor === hostDID}
                                                    onMessage={() => router.push(`/messages?connection=${encodeURIComponent(hostDID)}&mode=personal`)}
                                                    onRequestAccess={(key) => handleRequestAccess(connection, key)}
                                                    onRequestIssuance={isCA ? () => setIssuanceRequestFor(connection) : undefined}
                                                    onViewCredentials={() => setCredentialsModal({
                                                        displayName,
                                                        receiverDID,
                                                        credentials: matchingCredentials,
                                                        // Same previewPhotoFresh gate as ConnectionAvatar's fallbackPhoto/fallbackUniqueId above —
                                                        // omit entirely once stale rather than showing a point-in-time snapshot as current.
                                                        // getCredentialLayout/IDCardLayout/CertificateLayout already tolerate a missing issuer and
                                                        // missing issued/expiry dates (rendered as 'N/A') — no need to fabricate those here.
                                                        verifiedCredential: previewPhotoFresh && connectionMetadata?.verifiedCredentialSubject
                                                            ? { credentialSubject: connectionMetadata.verifiedCredentialSubject }
                                                            : undefined,
                                                    })}
                                                    onViewDetails={() => setDetailsModal({ displayName, fields: detailFields })}
                                                    onDelete={async () => {
                                                        if (confirm(`Are you sure you want to delete the connection with "${displayName}"?\n\nThis will remove all associated messages and cannot be undone.`)) {
                                                            try {
                                                                await app.dispatch(deleteConnection({ connectionHostDID: hostDID }));
                                                            } catch (error) {
                                                                console.error('❌ [UI] Failed to delete connection:', error);
                                                                alert('Failed to delete connection. Please try again.');
                                                            }
                                                        }
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                );
                            }
                        })()}
            </Box>

            {/* Credential Issuance Modal — opened from a ConnectionCard's 🪪 button (CA connections only) */}
            {issuanceRequestFor && app.agent.instance && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <CredentialIssuanceRequestor
                        agent={app.agent.instance}
                        connection={issuanceRequestFor}
                        capability="realperson"
                        onClose={() => setIssuanceRequestFor(null)}
                    />
                </div>
            )}

            {/* New Connection Modal */}
            {showNewConnectionModal && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto pt-8 pb-8">
                    <div className="relative w-full max-w-2xl mx-4">
                        <div className="bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl">
                            <div className="flex items-center justify-between p-5 border-b border-slate-700/50">
                                <h3 className="text-lg font-bold text-white">New Connection</h3>
                                <button
                                    onClick={() => setShowNewConnectionModal(false)}
                                    className="text-slate-400 hover:text-white transition-colors text-xl font-bold w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700"
                                >
                                    ✕
                                </button>
                            </div>
                            <div className="p-5">
                                <OOB
                                    agent={app.agent.instance!}
                                    pluto={app.db.instance!}
                                    onNewConnectionRequest={saveRequestToPersistentQueue}
                                    walletContext={walletTab}
                                    enterpriseConfig={enterpriseConfig}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* Colleague Directory Modal */}
            {showColleagueDirectory && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto pt-8 pb-8">
                    <div className="relative w-full max-w-lg mx-4">
                        <div className="bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl">
                            <div className="flex items-center justify-between p-5 border-b border-slate-700/50">
                                <h3 className="text-lg font-bold text-white">👥 Connect to Colleague</h3>
                                <button onClick={() => setShowColleagueDirectory(false)} className="text-slate-400 hover:text-white transition-colors text-xl font-bold w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700">✕</button>
                            </div>
                            <div className="p-5">
                                {colleagueDirectoryLoading ? (
                                    <p className="text-slate-400 text-center py-8">Loading colleagues...</p>
                                ) : colleagues.length === 0 ? (
                                    <p className="text-slate-400 text-center py-8">No colleagues found.</p>
                                ) : (
                                    <div className="space-y-2">
                                        <input
                                            type="text"
                                            placeholder="Filter by email or name…"
                                            value={colleagueFilter}
                                            onChange={e => setColleagueFilter(e.target.value)}
                                            className="w-full px-3 py-2 bg-slate-800/60 border border-slate-700/50 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 mb-1"
                                        />
                                        {colleagues
                                            .filter(c => {
                                                const q = colleagueFilter.toLowerCase();
                                                return !q || c.email.toLowerCase().includes(q) || c.full_name.toLowerCase().includes(q);
                                            })
                                            .map(c => (
                                                <div key={c.email} className="flex items-center justify-between p-3 bg-slate-800/50 rounded-xl border border-slate-700/50">
                                                    <div>
                                                        <p className="text-sm font-medium text-white">{c.full_name}</p>
                                                        <p className="text-xs text-slate-400">{c.department} · {c.email}</p>
                                                    </div>
                                                    <button
                                                        onClick={() => handleConnectColleague(c)}
                                                        disabled={connectingTo === c.email}
                                                        className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                                                    >
                                                        {connectingTo === c.email ? 'Sending...' : '+ Connect'}
                                                    </button>
                                                </div>
                                            ))}
                                        {colleagueFilter && !colleagues.some(c => {
                                            const q = colleagueFilter.toLowerCase();
                                            return c.email.toLowerCase().includes(q) || c.full_name.toLowerCase().includes(q);
                                        }) && (
                                            <p className="text-center text-slate-500 text-sm py-4">No colleagues match "{colleagueFilter}"</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Connection Details Modal — opened from a ConnectionCard's ℹ️ menu item */}
            {detailsModal && (
                <ConnectionDetailsModal
                    displayName={detailsModal.displayName}
                    fields={detailsModal.fields}
                    onClose={() => setDetailsModal(null)}
                />
            )}

            {/* Connection Credentials Modal — opened from a ConnectionCard's 📜 menu item */}
            {credentialsModal && (
                <ConnectionCredentialsModal
                    displayName={credentialsModal.displayName}
                    receiverDID={credentialsModal.receiverDID}
                    credentials={credentialsModal.credentials}
                    verifiedCredential={credentialsModal.verifiedCredential}
                    onClose={() => setCredentialsModal(null)}
                />
            )}
            </DBConnect>
        </div>
    );
}