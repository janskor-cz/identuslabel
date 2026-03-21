import '../app/index.css'

import React, { useEffect, useState } from "react";
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
import { refreshConnections, deleteConnection } from "@/actions";
import { filterConnectionMessages } from "@/utils/messageFilters";
import { connectionRequestQueue, ConnectionRequestItem } from "@/utils/connectionRequestQueue";
import { messageRejection } from "@/utils/rejectionManager";
import { CAConnectionEnforcementModal } from "@/components/CAConnectionEnforcementModal";
import { PendingRequestsModal } from "@/components/PendingRequestsModal";
import { getConnectionNameWithFallback } from "@/utils/connectionNameResolver";
import { getConnectionMetadata } from "@/utils/connectionMetadata";

export default function App() {

    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => { setIsMounted(true); }, []);

    const app = useMountedApp();
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

    // CA connection enforcement modal state
    const [hasCAConnection, setHasCAConnection] = useState<boolean | null>(null); // null = checking
    const [showCAEnforcementModal, setShowCAEnforcementModal] = useState(false);

    // Pending requests modal state
    const [showPendingRequestsModal, setShowPendingRequestsModal] = useState(false);

    // New connection modal
    const [showNewConnectionModal, setShowNewConnectionModal] = useState(false);

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

    // Check for existing CA connection and show enforcement modal if missing
    useEffect(() => {
        const checkCAConnection = async () => {
            if (!app.db.instance || !app.db.connected || !app.agent.instance) return;

            try {
                const allConnections = await app.agent.instance.pluto.getAllDidPairs();
                const caConnection = allConnections.find(pair => {
                    const pairName = pair.name?.toLowerCase() || '';
                    return pairName === 'certification authority' || pairName.includes('certification');
                });

                setHasCAConnection(!!caConnection);
                setShowCAEnforcementModal(!caConnection);
            } catch (error) {
                console.error('[CONNECTIONS] Error checking CA connection:', error);
                setHasCAConnection(false);
                setShowCAEnforcementModal(true);
            }
        };

        checkCAConnection();
    }, [app.db.instance, app.db.connected, app.agent.instance, connections])

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

    // Load persistent connection requests from IndexedDB
    const loadPersistentRequests = async () => {
        try {
            setQueueLoading(true);
            setQueueError(null);

            // Get wallet ID from app configuration
            const walletId = app.agent?.walletId || 'idl'; // fallback to alice

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
    const saveRequestToPersistentQueue = async (message: SDK.Domain.Message) => {
        try {
            const walletId = app.agent?.walletId || 'idl';

            // Extract attached credential if any
            const attachedCredential = extractCredentialFromMessage(message);

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
            const walletId = app.agent?.walletId || 'idl';

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
                        await saveRequestToPersistentQueue(request);
                    } else {
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
            const walletId = app.agent?.walletId || 'idl';
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
                {/* CA Connection Enforcement Modal */}
                    <CAConnectionEnforcementModal
                        visible={showCAEnforcementModal && hasCAConnection === false}
                        onConnectionEstablished={() => {
                            setHasCAConnection(true);
                            setShowCAEnforcementModal(false);
                            app.dispatch(refreshConnections());
                        }}
                        agent={app.agent.instance}
                        dispatch={app.dispatch}
                        defaultSeed={app.defaultSeed}
                    />

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
                                return enterpriseConnections.map((connection, i) => {
                                    const displayName = connection.label || `Connection ${connection.connectionId.substring(0, 8)}...`;
                                    const isConnected = connection.state === 'ConnectionResponseSent' || connection.state === 'Active';
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
                                                    <button
                                                        onClick={() => toggleDetails(i)}
                                                        title={isDetailsShown ? 'Hide details' : 'Show details'}
                                                        className={`p-1.5 rounded-lg transition-all ${isDetailsShown ? 'text-cyan-300 bg-cyan-500/10' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                                                    >
                                                        {isDetailsShown ? '▲' : '▼'}
                                                    </button>
                                                </div>
                                            </div>
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
                                });
                            } else {
                                return connections.map((connection, i) => {
                                    const isEstablished = true;
                                    const isDetailsShown = showDetails[i] || false;

                                    const displayName = connection.name || getConnectionName(
                                        connection.receiver.toString(),
                                        app.credentials
                                    );

                                    const connectionMetadata = getConnectionMetadata(connection.host.toString());
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

                                    return (
                                        <div key={`connection${i}`} className="bg-slate-800/30 border border-slate-700/50 rounded-xl mb-2 hover:border-slate-600/50 transition-all duration-200">
                                            <div className="flex items-center justify-between px-4 py-3">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEstablished ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
                                                    <span className="font-medium text-white text-sm truncate">{displayName}</span>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClasses}`}>
                                                        {badgeLabel}
                                                    </span>
                                                    <button title="Send Message" className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-lg transition-all">
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
                                                                    await app.dispatch(deleteConnection({ connectionHostDID: connection.host.toString() }));
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
            </DBConnect>
        </div>
    );
}