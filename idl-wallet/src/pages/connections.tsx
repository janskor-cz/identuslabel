import '../app/index.css'

import React, { useEffect, useRef, useState } from "react";
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { FooterNavigation } from "@/components/FooterNavigation";

import { Box } from "@/app/Box";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { selectEnterpriseConnections, selectIsEnterpriseConfigured, selectActiveConfiguration } from "@/reducers/enterpriseAgent";
import { refreshEnterpriseConnections } from "@/actions/enterpriseAgentActions";
import { DBConnect } from "@/components/DBConnect";
import { OOB } from "@/components/OOB";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { copyToClipboardWithLog } from "@/utils/clipboard";
import { refreshConnections, deleteConnection, sendMessage, sendProtocolAccessRequest } from "@/actions";
import { filterConnectionMessages, filterChatAndCredentialMessages } from "@/utils/messageFilters";
import { connectionRequestQueue, ConnectionRequestItem } from "@/utils/connectionRequestQueue";
import { messageRejection } from "@/utils/rejectionManager";
import { PendingRequestsModal } from "@/components/PendingRequestsModal";
import { getConnectionNameWithFallback } from "@/utils/connectionNameResolver";
import { getConnectionMetadata, saveConnectionMetadata, updateConnectionMetadata } from "@/utils/connectionMetadata";
import { getCredentialType } from "@/utils/credentialTypeDetector";
import { getPinnedCA } from "@/utils/prefixedStorage";
import { Chat } from "@/components/Chat";
import { useCAPortal } from "@/utils/CAPortalContext";
import { EnterpriseAgentClient, ColleagueRecord, PendingColleagueInvitation, ColleagueMessage } from "@/utils/EnterpriseAgentClient";
import { getItem, setItem, removeItem, getKeysByPattern } from "@/utils/prefixedStorage";


export default function App() {

    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => { setIsMounted(true); }, []);

    const app = useMountedApp();
    const { setPendingAccessRequest, pendingAccessRequest, openCAPortal } = useCAPortal();
    const [connections, setConnections] = React.useState<SDK.Domain.DIDPair[]>([]);
    const [showDetails, setShowDetails] = React.useState<{[key: number]: boolean}>({});

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
    const [colleagueChatFor, setColleagueChatFor] = useState<string | null>(null); // connectionId
    const [colleagueMessages, setColleagueMessages] = useState<Map<string, ColleagueMessage[]>>(new Map()); // connId → msgs
    const [lastMessagePoll, setLastMessagePoll] = useState(0);

    // Inline chat: stores the host DID of the connection whose chat panel is open
    const [openChatFor, setOpenChatFor] = useState<string | null>(null);

    // Request Access dropdown: stores host DID of the connection with the menu open
    const [accessMenuFor, setAccessMenuFor] = useState<string | null>(null);
    // Stores host DID of a connection with an in-flight access request
    const [accessPendingFor, setAccessPendingFor] = useState<string | null>(null);


    const getTargetsForConnection = (conn: SDK.Domain.DIDPair) => {
        const hostDID = conn.host.toString();
        const meta = getConnectionMetadata(hostDID);

        // Primary: capabilities recorded at connection-establishment time (service-access/1.0).
        if (meta?.capabilities?.length) {
            return meta.capabilities.map(key => {
                const known = CA_TARGETS.find(t => t.key === key);
                const supported = meta.supportedTargets?.find(t => t.key === key);
                return { key, label: known?.label ?? supported?.label ?? key, icon: known?.icon ?? supported?.icon ?? '🔗' };
            });
        }

        // @deprecated fallback: the old isCAConnection flag, for connections not yet backfilled.
        if (meta?.isCAConnection) return CA_TARGETS;

        // Fallback for connections created before entity-agnostic discovery was added:
        // match any name that mentions the CA (case-insensitive substring match).
        const connName = ((conn as any).name ?? (conn as any).alias ?? '').toLowerCase();
        if (connName.includes('certification authority') || connName.startsWith('ca connection')) {
            const CA_CAPABILITIES = CA_TARGETS.map(t => t.key);
            // Persist so future renders skip the name check
            if (meta) {
                updateConnectionMetadata(hostDID, { isCAConnection: true, capabilities: CA_CAPABILITIES });
            } else {
                saveConnectionMetadata(hostDID, { walletType: 'local', isCAConnection: true, capabilities: CA_CAPABILITIES });
            }
            return CA_TARGETS;
        }

        return meta?.supportedTargets ?? [];
    };

    const CA_TARGETS = [
        { key: 'portal',             label: 'CA Portal',          icon: '🏛️' },
        { key: 'security-clearance', label: 'Security Clearance', icon: '🔐' },
        { key: 'login',              label: 'CA Login',            icon: '🔑' },
    ];

    const handleRequestAccess = async (connection: SDK.Domain.DIDPair, target: string) => {
        if (!app.agent.instance || accessPendingFor) return;
        const hostDID = connection.host.toString();
        setAccessMenuFor(null);
        setAccessPendingFor(hostDID);
        const targetInfo = getTargetsForConnection(connection).find(t => t.key === target);
        setPendingAccessRequest({ target, label: targetInfo?.label ?? target, icon: targetInfo?.icon ?? '🔗' });
        try {
            await app.dispatch(sendProtocolAccessRequest({ agent: app.agent.instance, connection, target }));
        } catch (e: any) {
            console.error('[Connections] Access request failed:', e.message);
            setPendingAccessRequest(null);
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
        if (result.success && result.data) setColleagues(result.data.colleagues ?? (result.data as any));
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

    const handleSendColleagueMessage = async (connectionId: string, content: string) => {
        if (!activeConfig) return;
        const client = new EnterpriseAgentClient(activeConfig);
        const result = await client.sendBasicMessage(connectionId, content);
        if (result.success) {
            // Optimistically add to local messages
            setColleagueMessages(prev => {
                const next = new Map(prev);
                const existing = next.get(connectionId) || [];
                next.set(connectionId, [...existing, {
                    id: result.data?.id || Date.now().toString(),
                    fromEmail: 'me',
                    fromName: 'You',
                    content,
                    timestamp: Date.now(),
                    connectionId
                }]);
                return next;
            });
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

    // Colleague invitation polling + message polling (enterprise mode only)
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
            if (!result.success || !result.data?.invitations?.length) return;
            for (const inv of result.data.invitations) {
                console.log(`[ColleagueChat] Auto-accepting invitation from ${inv.fromEmail}`);
                const accepted = await client.acceptInvitation(inv.oobBase64, inv.fromName || inv.fromEmail);
                if (accepted.success && accepted.data?.connectionId) {
                    await client.consumeColleagueInvitation(inv.id, accepted.data.connectionId);
                    await app.dispatch(refreshEnterpriseConnections());
                    console.log(`[ColleagueChat] Connected to ${inv.fromEmail} (conn: ${accepted.data.connectionId})`);
                }
            }
        };

        const pollMessages = async () => {
            const result = await client.getColleagueMessages(lastMessagePoll);
            if (!result.success || !result.data?.messages?.length) return;
            setColleagueMessages(prev => {
                const next = new Map(prev);
                for (const msg of result.data!.messages) {
                    const existing = next.get(msg.connectionId) || [];
                    if (!existing.find(m => m.id === msg.id)) {
                        next.set(msg.connectionId, [...existing, msg]);
                    }
                }
                return next;
            });
            setLastMessagePoll(Date.now());
        };

        pollInvitations();
        pollMessages();

        const invInterval  = setInterval(pollInvitations,  15000);
        const msgInterval  = setInterval(pollMessages,      5000);
        return () => { clearInterval(invInterval); clearInterval(msgInterval); };
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

    const toggleDetails = (index: number) => {
        setShowDetails(prev => ({
            ...prev,
            [index]: !prev[index]
        }));
    };

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

                            if (isEnterpriseMode) {
                                return (<>
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs text-slate-500">{enterpriseConnections.length} connection{enterpriseConnections.length !== 1 ? 's' : ''}</span>
                                        <button
                                            onClick={handleEnterprisePortalLogin}
                                            disabled={!!accessPendingFor || !!pendingAccessRequest || !!pendingGrantBase || portalLoginPending}
                                            className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                                        >
                                            {pendingGrantBase
                                                ? '⌛ Approve proof in wallet...'
                                                : portalLoginPending
                                                    ? '⏳ Sending request...'
                                                    : '🏢 Login to Employee Portal'}
                                        </button>
                                    </div>
                                    {enterpriseConnections.map((connection, i) => {
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
                                    const displayName = connection.goalCode === 'document-access'
                                        ? 'Document Service'
                                        : (activeConfig?.enterpriseAgentName || connection.label || connection.goal || `Connection ${connection.connectionId.substring(0, 8)}...`);
                                    const isConnected = ['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active', 'ACTIVE', 'active'].includes(connection.state);
                                    const isDetailsShown = showDetails[i] || false;

                                    const copyToClipboard = async (text: string, label: string) => {
                                        try {
                                            await copyToClipboardWithLog(text, label);
                                        } catch (error) {
                                            console.error(`Failed to copy ${label}:`, error);
                                        }
                                    };

                                    return (
                                        <div key={`ent-connection-${connection.connectionId}`} className="bg-slate-800/30 border border-slate-700/50 rounded-xl mb-2 hover:border-slate-600/50 transition-all duration-200">
                                            <div className="flex items-center justify-between px-4 py-3">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
                                                    <span className="font-medium text-white text-sm truncate">{displayName}</span>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                                                        ☁️ Enterprise
                                                    </span>
                                                    {isConnected && (
                                                        <button
                                                            onClick={() => setColleagueChatFor(prev => prev === connection.connectionId ? null : connection.connectionId)}
                                                            title="Chat"
                                                            className={`p-1.5 rounded-lg transition-all text-sm ${colleagueChatFor === connection.connectionId ? 'text-emerald-300 bg-emerald-500/10' : 'text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10'}`}
                                                        >
                                                            💬
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => toggleDetails(i)}
                                                        title={isDetailsShown ? 'Hide details' : 'Show details'}
                                                        className={`p-1.5 rounded-lg transition-all ${isDetailsShown ? 'text-cyan-300 bg-cyan-500/10' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                                                    >
                                                        {isDetailsShown ? '▲' : '▼'}
                                                    </button>
                                                </div>
                                            </div>
                                            {colleagueChatFor === connection.connectionId && (
                                                <div className="border-t border-slate-700/50">
                                                    <ColleagueChatPanel
                                                        connectionId={connection.connectionId}
                                                        displayName={displayName}
                                                        messages={colleagueMessages.get(connection.connectionId) || []}
                                                        onSend={(content) => handleSendColleagueMessage(connection.connectionId, content)}
                                                    />
                                                </div>
                                            )}
                                            {isDetailsShown && (
                                                <div className="px-4 pb-4 space-y-3 border-t border-slate-700/50 pt-3 animate-fadeIn">
                                                    <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                                                        <label className="text-sm font-semibold text-slate-300 block mb-2">Connection ID</label>
                                                        <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">
                                                            {connection.connectionId}
                                                        </p>
                                                    </div>
                                                    {connection.myDid && (
                                                        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                                                            <div className="flex items-center justify-between mb-2">
                                                                <label className="text-sm font-semibold text-slate-300">My DID</label>
                                                                <button onClick={() => copyToClipboard(connection.myDid!, 'My DID')} className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">📋 Copy</button>
                                                            </div>
                                                            <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">{connection.myDid}</p>
                                                        </div>
                                                    )}
                                                    {connection.theirDid && (
                                                        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                                                            <div className="flex items-center justify-between mb-2">
                                                                <label className="text-sm font-semibold text-slate-300">Their DID</label>
                                                                <button onClick={() => copyToClipboard(connection.theirDid!, 'Their DID')} className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">📋 Copy</button>
                                                            </div>
                                                            <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">{connection.theirDid}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                </>);
                            } else {
                                return connections.map((connection, i) => {
                                    const isEstablished = true;
                                    const isDetailsShown = showDetails[i] || false;
                                    const hostDID = connection.host.toString();
                                    const isChatOpen = openChatFor === hostDID;

                                    const displayName = connection.name || getConnectionNameWithFallback(
                                        connection.receiver.toString(),
                                        app.credentials
                                    );

                                    const connectionMetadata = getConnectionMetadata(hostDID);
                                    const walletType = connectionMetadata?.walletType || 'local';
                                    const isCloudWallet = walletType === 'cloud';

                                    const copyToClipboard = async (text: string, label: string) => {
                                        try {
                                            await copyToClipboardWithLog(text, label);
                                        } catch (error) {
                                            console.error(`Failed to copy ${label}:`, error);
                                        }
                                    };

                                    const badgeLabel = isCloudWallet ? '☁️ Cloud' : '🏠 Local';
                                    const badgeClasses = isCloudWallet
                                        ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                                        : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';

                                    // Messages for this specific connection
                                    const conversationMessages = isChatOpen
                                        ? filterChatAndCredentialMessages(app.messages)
                                            .filter(msg => {
                                                const from = msg.from?.toString();
                                                const to = msg.to?.toString();
                                                const receiverStr = connection.receiver.toString();
                                                return (from === hostDID && to === receiverStr) ||
                                                       (from === receiverStr && to === hostDID) ||
                                                       from === hostDID || from === receiverStr ||
                                                       to === hostDID || to === receiverStr;
                                            })
                                            .sort((a, b) => {
                                                const aTime = a.createdTime ? (a.createdTime < 10000000000 ? a.createdTime * 1000 : a.createdTime) : 0;
                                                const bTime = b.createdTime ? (b.createdTime < 10000000000 ? b.createdTime * 1000 : b.createdTime) : 0;
                                                return aTime - bTime;
                                            })
                                        : [];

                                    const handleSendMessage = async (content: string, toDID: string, securityLevel?: number) => {
                                        if (!content) throw new Error('Message content is required');
                                        const agent = app.agent.instance!;
                                        if (securityLevel !== undefined && securityLevel > 0) {
                                            await app.dispatch(sendMessage({ agent, content, recipientDID: toDID, securityLevel }));
                                            return;
                                        }
                                        const message = new SDK.BasicMessage({ content }, connection.host, connection.receiver).makeMessage();
                                        await app.dispatch(sendMessage({ agent, message }));
                                    };

                                    return (
                                        <div key={`connection${i}`} className="bg-slate-800/30 border border-slate-700/50 rounded-xl mb-2 hover:border-slate-600/50 transition-all duration-200">
                                            {/* Connection row */}
                                            <div className="flex items-center justify-between px-4 py-3">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEstablished ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
                                                    <span className="font-medium text-white text-sm truncate">{displayName}</span>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClasses}`}>
                                                        {badgeLabel}
                                                    </span>
                                                    {/* Request Access dropdown — only shown when targets exist for this connection */}
                                                    {getTargetsForConnection(connection).length > 0 && (
                                                    <div className="relative">
                                                        <button
                                                            onClick={() => setAccessMenuFor(accessMenuFor === hostDID ? null : hostDID)}
                                                            disabled={accessPendingFor === hostDID}
                                                            title="Request access via VC proof"
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                                                                       bg-cyan-500/20 hover:bg-cyan-500/40 border border-cyan-500/40
                                                                       text-cyan-300 hover:text-cyan-100 transition-all
                                                                       disabled:opacity-50 disabled:cursor-not-allowed"
                                                        >
                                                            {accessPendingFor === hostDID ? '⏳' : '🔓'} Request Access
                                                        </button>
                                                        {accessMenuFor === hostDID && (
                                                            <div className="absolute right-0 top-full mt-1 z-50 min-w-max
                                                                            bg-slate-900 border border-slate-600/60 rounded-xl shadow-xl overflow-hidden">
                                                                <p className="px-3 py-2 text-xs text-slate-400 border-b border-slate-700/50">
                                                                    CA will send a VC proof request
                                                                </p>
                                                                {getTargetsForConnection(connection).map(({ key, label, icon }) => (
                                                                    <button
                                                                        key={key}
                                                                        onClick={() => handleRequestAccess(connection, key)}
                                                                        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-white
                                                                                   hover:bg-cyan-500/20 transition-colors text-left"
                                                                    >
                                                                        <span>{icon}</span>
                                                                        <span>{label}</span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                    )}
                                                    <button
                                                        onClick={() => setOpenChatFor(isChatOpen ? null : hostDID)}
                                                        title={isChatOpen ? 'Close chat' : 'Open chat'}
                                                        className={`p-1.5 rounded-lg transition-all ${isChatOpen ? 'text-cyan-300 bg-cyan-500/10' : 'text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10'}`}
                                                    >
                                                        💬
                                                    </button>
                                                    <button
                                                        onClick={() => toggleDetails(i)}
                                                        title={isDetailsShown ? 'Hide details' : 'Show details'}
                                                        className={`p-1.5 rounded-lg transition-all ${isDetailsShown ? 'text-cyan-300 bg-cyan-500/10' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                                                    >
                                                        {isDetailsShown ? '▲' : '▼'}
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            if (confirm(`Are you sure you want to delete the connection with "${displayName}"?\n\nThis will remove all associated messages and cannot be undone.`)) {
                                                                try {
                                                                    await app.dispatch(deleteConnection({ connectionHostDID: hostDID }));
                                                                } catch (error) {
                                                                    console.error('❌ [UI] Failed to delete connection:', error);
                                                                    alert('Failed to delete connection. Please try again.');
                                                                }
                                                            }
                                                        }}
                                                        title="Delete connection"
                                                        className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                                                    >
                                                        🗑
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Inline chat panel */}
                                            {isChatOpen && (
                                                <div className="border-t border-slate-700/50">
                                                    <ErrorBoundary componentName="Chat">
                                                        <Chat
                                                            messages={conversationMessages}
                                                            connection={connection}
                                                            onSendMessage={handleSendMessage}
                                                        />
                                                    </ErrorBoundary>
                                                </div>
                                            )}

                                            {/* Technical details panel */}
                                            {isDetailsShown && (
                                                <div className="px-4 pb-4 space-y-3 border-t border-slate-700/50 pt-3 animate-fadeIn">
                                                    {isCloudWallet && connectionMetadata && (
                                                        <div className="bg-purple-500/20 rounded-xl p-4 border border-purple-500/30 backdrop-blur-sm">
                                                            <div className="flex items-center space-x-2 mb-3">
                                                                <span className="text-lg">☁️</span>
                                                                <label className="text-sm font-semibold text-purple-300">Cloud Wallet Configuration</label>
                                                            </div>
                                                            {connectionMetadata.prismDid && (
                                                                <div className="mb-3">
                                                                    <div className="flex items-center justify-between mb-1">
                                                                        <label className="text-xs font-semibold text-purple-300">PRISM DID</label>
                                                                        <button onClick={() => copyToClipboard(connectionMetadata.prismDid!, 'PRISM DID')} className="text-xs text-purple-400 hover:text-purple-300 transition-colors">📋 Copy</button>
                                                                    </div>
                                                                    <p className="text-xs font-mono text-purple-300 break-all bg-purple-900/40 p-2 rounded border border-purple-500/30">{connectionMetadata.prismDid}</p>
                                                                </div>
                                                            )}
                                                            {connectionMetadata.enterpriseAgentUrl && (
                                                                <div className="mb-3">
                                                                    <label className="text-xs font-semibold text-purple-300 block mb-1">Enterprise Agent URL</label>
                                                                    <p className="text-xs text-purple-300 break-all bg-purple-900/40 p-2 rounded border border-purple-500/30">{connectionMetadata.enterpriseAgentUrl}</p>
                                                                </div>
                                                            )}
                                                            <div className="text-xs text-purple-400 mt-2">ℹ️ This connection uses your company's cloud-managed wallet</div>
                                                        </div>
                                                    )}
                                                    <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <label className="text-sm font-semibold text-slate-300">Host DID (Your Identity)</label>
                                                            <button onClick={() => copyToClipboard(connection.host.toString(), 'Host DID')} className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">📋 Copy</button>
                                                        </div>
                                                        <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">{connection.host.toString()}</p>
                                                    </div>
                                                    <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <label className="text-sm font-semibold text-slate-300">Receiver DID (Connected Party)</label>
                                                            <button onClick={() => copyToClipboard(connection.receiver.toString(), 'Receiver DID')} className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">📋 Copy</button>
                                                        </div>
                                                        <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">{connection.receiver.toString()}</p>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                });
                            }
                        })()}
            </Box>

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
            </DBConnect>
        </div>
    );
}

// ─── Colleague Chat Panel ────────────────────────────────────────────────────

function ColleagueChatPanel({ connectionId, displayName, messages, onSend }: {
    connectionId: string;
    displayName: string;
    messages: ColleagueMessage[];
    onSend: (content: string) => void;
}) {
    const [input, setInput] = React.useState('');
    const bottomRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const send = () => {
        const text = input.trim();
        if (!text) return;
        onSend(text);
        setInput('');
    };

    return (
        <div className="flex flex-col h-64 bg-slate-900/50">
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {messages.length === 0 && (
                    <p className="text-xs text-slate-500 text-center pt-4">No messages yet. Say hello!</p>
                )}
                {messages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.fromEmail === 'me' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] px-3 py-2 rounded-xl text-sm ${msg.fromEmail === 'me' ? 'bg-emerald-600/40 text-emerald-100' : 'bg-slate-700/60 text-slate-200'}`}>
                            {msg.fromEmail !== 'me' && <p className="text-xs text-slate-400 mb-0.5">{msg.fromName}</p>}
                            {msg.content}
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
            <div className="flex gap-2 p-3 border-t border-slate-700/50">
                <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && send()}
                    placeholder={`Message ${displayName}...`}
                    className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                />
                <button onClick={send} className="px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm font-semibold transition-all">Send</button>
            </div>
        </div>
    );
}