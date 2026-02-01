
import { useMountedApp } from "@/reducers/store";
import { refreshConnections } from "@/actions";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import React, { useCallback, useEffect } from "react";
import { AgentRequire } from "./AgentRequire";

const ListenerKey = SDK.ListenerKey;

export const OOB: React.FC<{ agent: SDK.Agent, pluto: SDK.Domain.Pluto; }> = props => {
    const app = useMountedApp();
    const dispatch = app.dispatch;
    const agent = app.agent.instance;

    const CONNECTION_EVENT = ListenerKey.CONNECTION;
    const [connections, setConnections] = React.useState<Array<any>>([]);
    const [oob, setOOB] = React.useState<string>();
    const [alias, setAlias] = React.useState<string>();

    // Invitation creation state
    const [invitationLabel, setInvitationLabel] = React.useState<string>('');
    const [createdInvitation, setCreatedInvitation] = React.useState<string>('');
    const [activeTab, setActiveTab] = React.useState<'accept' | 'create'>('accept');

    const handleConnections = useCallback((event: any) => {
        setConnections([...connections, event]);
    }, []);

    useEffect(() => {
        if (agent) {
            agent.addListener(CONNECTION_EVENT, handleConnections);
        }
        return () => {
            if (agent) {
                agent.removeListener(CONNECTION_EVENT, handleConnections);
            }
        }
    }, [agent])

    const handleOnChange = (e: any) => {
        setOOB(e.target.value);
    };

    async function onConnectionHandleClick() {
        if (!oob) {
            return;
        }

        if (!agent) {
            throw new Error("Start the agent first")
        }
        try {
            const parsed = await agent.parseOOBInvitation(new URL(oob));
            const connection = await agent.acceptInvitation(parsed, alias);

            // Store the connection in the database for persistence
            if (connection && agent.pluto) {
                await agent.pluto.storeDIDPair(connection);
                console.log("Connection stored to database:", connection);

                // Refresh Redux connections state to show new connection in UI
                console.log('🔄 Refreshing connections state...');
                await dispatch(refreshConnections());
                console.log('✅ Connections state refreshed');
            }

        } catch (err) {
            if (!alias) {
                return;
            }
            const from = await agent.createNewPeerDID(
                [],
                true
            );
            const resolved = await agent.castor.resolveDID(from.toString());
            const accept = resolved.services.reduce((_, service) => ([..._, ...service.serviceEndpoint.accept]), [])
            const to = SDK.Domain.DID.fromString(oob);
            const message = new SDK.HandshakeRequest({
                accept: accept,
            },
                from,
                to
            );
            await agent.sendMessage(message.makeMessage())
            const didPair = new SDK.Domain.DIDPair(from, to, alias);
            await agent.connectionManager.addConnection(didPair);

            // Store the connection in the database for persistence
            if (agent.pluto) {
                await agent.pluto.storeDIDPair(didPair);
                console.log("Manual connection stored to database:", didPair);

                // Refresh Redux connections state to show new connection in UI
                console.log('🔄 Refreshing connections state...');
                await dispatch(refreshConnections());
                console.log('✅ Connections state refreshed');
            }
        }

    }

    async function onCreateInvitationClick() {
        if (!invitationLabel || !agent) {
            return;
        }

        try {
            console.log('🔑 Creating well-known DID for invitation...');
            // Use the same pattern as working wallet: createNewPeerDID([], true)
            const wellKnownDID = await agent.createNewPeerDID([], true);
            console.log(`✅ Well-known DID: ${wellKnownDID.toString().substring(0, 60)}...`);

            // Validate the DID has mediator service endpoints
            const didDoc = await agent.castor.resolveDID(wellKnownDID.toString());
            console.log(`📄 Services found: ${didDoc.services?.length || 0}`);

            // Create proper DIDComm v2.0 invitation body
            const invitationBody = {
                accept: ["didcomm/v2"],
                goal_code: "connect",
                goal: `Connect with ${invitationLabel}`,
                label: invitationLabel
            };

            // Create proper DIDComm v2.0 invitation structure manually
            const invitationId = `invitation-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const invitation = {
                id: invitationId,
                type: "https://didcomm.org/out-of-band/2.0/invitation",
                from: wellKnownDID.toString(),
                body: invitationBody
            };

            console.log('✅ DIDComm invitation created');
            console.log(`   ID: ${invitation.id}`);
            console.log(`   Type: ${invitation.type}`);
            console.log(`   From: ${invitation.from.substring(0, 60)}...`);
            console.log(`   Label: ${invitation.body.label}`);

            // Create proper invitation JSON structure
            const invitationJson = JSON.stringify(invitation);

            // Encode to base64 for URL
            const base64Invitation = btoa(invitationJson);
            const invitationUrl = `${window.location.origin}/connect?_oob=${base64Invitation}`;

            console.log('🔍 Debug invitation generation:');
            console.log('   Raw JSON:', invitationJson);
            console.log('   Base64:', base64Invitation.substring(0, 100) + '...');
            console.log('   Final URL:', invitationUrl);

            setCreatedInvitation(invitationUrl);

        } catch (error) {
            console.error('❌ Invitation creation failed:', error);
            alert(`Failed to create invitation: ${error.message}`);
        }
    }

    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            alert('Invitation copied to clipboard!');
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    };

    const connection = connections.at(0);

    return (
        <div className="space-y-6">
            {/* Header Section */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
                <div className="flex items-center space-x-3 mb-4">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900 rounded-lg flex items-center justify-center">
                        <span className="text-blue-600 dark:text-blue-400 text-xl">🔗</span>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                            DIDComm Connections
                        </h1>
                        <p className="text-gray-600 dark:text-gray-400">
                            Create and accept secure connection invitations
                        </p>
                    </div>
                </div>

                <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                        <strong>How it works:</strong> Create Out-of-Band (OOB) invitations for others to connect with you, or accept invitations from other identities, wallets, or agents to establish secure, decentralized connections.
                    </p>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
                <div className="border-b border-gray-200 dark:border-gray-700">
                    <nav className="flex space-x-8 px-6">
                        <button
                            onClick={() => setActiveTab('create')}
                            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                                activeTab === 'create'
                                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                            }`}
                        >
                            📨 Create Invitation
                        </button>
                        <button
                            onClick={() => setActiveTab('accept')}
                            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                                activeTab === 'accept'
                                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                            }`}
                        >
                            📥 Accept Invitation
                        </button>
                    </nav>
                </div>

                {/* Tab Content */}
                <AgentRequire text="Agent required. You cannot process invitations while the agent is not running.">
                    <div className="p-6">
                        {activeTab === 'create' && (
                            <div className="space-y-6">
                                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                                    Create Invitation
                                </h2>

                                {/* Invitation Label Input */}
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                        Invitation Label
                                    </label>
                                    <input
                                        className="w-full p-4 text-sm text-gray-900 bg-gray-50 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500 transition-colors"
                                        placeholder="Enter a label for your invitation (e.g., 'Alice's Wallet', 'My Company')"
                                        type="text"
                                        value={invitationLabel}
                                        onChange={(e) => setInvitationLabel(e.target.value)}
                                    />
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        This label will be shown to users when they receive your invitation
                                    </p>
                                </div>

                                {/* Create Invitation Button */}
                                <div className="flex justify-end">
                                    <button
                                        className="px-8 py-3 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 focus:ring-4 focus:ring-green-300 dark:focus:ring-green-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 transform hover:scale-105"
                                        onClick={onCreateInvitationClick}
                                        disabled={!invitationLabel || invitationLabel.trim() === ""}
                                    >
                                        📨 Create Invitation
                                    </button>
                                </div>

                                {/* Created Invitation Display */}
                                {createdInvitation && (
                                    <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg p-4">
                                        <h3 className="text-sm font-semibold text-green-800 dark:text-green-200 mb-2">
                                            ✅ Invitation Created Successfully!
                                        </h3>
                                        <p className="text-xs text-green-700 dark:text-green-300 mb-3">
                                            Share this invitation URL with others to connect:
                                        </p>
                                        <div className="bg-white dark:bg-gray-800 rounded border p-3 mb-3">
                                            <code className="text-xs text-gray-600 dark:text-gray-400 break-all">
                                                {createdInvitation}
                                            </code>
                                        </div>
                                        <button
                                            onClick={() => copyToClipboard(createdInvitation)}
                                            className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
                                        >
                                            📋 Copy to Clipboard
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'accept' && (
                            <div className="space-y-6">
                                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                                    Accept Invitation
                                </h2>

                                {/* Connection Name Input */}
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                        Connection Name (Optional)
                                    </label>
                                    <input
                                        className="w-full p-4 text-sm text-gray-900 bg-gray-50 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500 transition-colors"
                                        placeholder="Enter a friendly name for this connection (e.g., 'Certification Authority')"
                                        type="text"
                                        value={alias ?? ""}
                                        onChange={(e) => { setAlias(e.target.value) }}
                                    />
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        This helps you identify the connection later
                                    </p>
                                </div>

                                {/* OOB Invitation Input */}
                                <div>
                                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                        OOB Invitation or DID
                                    </label>
                                    <textarea
                                        className="w-full p-4 text-sm text-gray-900 bg-gray-50 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500 transition-colors resize-none"
                                        placeholder="Paste the Out-of-Band invitation URL, QR code content, or DID here..."
                                        rows={4}
                                        value={oob ?? ""}
                                        onChange={handleOnChange}
                                    />
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        Supports OOB invitation URLs (starting with https://) or DID strings
                                    </p>
                                </div>

                                {/* Accept Connection Button */}
                                <div className="flex justify-end">
                                    <button
                                        className="px-8 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:focus:ring-blue-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 transform hover:scale-105"
                                        onClick={onConnectionHandleClick}
                                        disabled={!oob || oob.trim() === ""}
                                    >
                                        🚀 Accept Invitation
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </AgentRequire>
            </div>

            {/* Success Feedback */}
            {!!connection && (
                <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-xl p-6">
                    <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-green-100 dark:bg-green-800 rounded-full flex items-center justify-center">
                            <span className="text-green-600 dark:text-green-400">✅</span>
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-green-800 dark:text-green-200">
                                Connection Established!
                            </h3>
                            <p className="text-green-700 dark:text-green-300">
                                Successfully connected as <strong>"{connection.name || 'Unnamed Connection'}"</strong>
                            </p>
                            <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                                You can now securely exchange messages and credentials with this connection.
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
