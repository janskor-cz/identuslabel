import SDK from "@hyperledger/identus-edge-agent-sdk";
import React, { useEffect, useState, useCallback } from "react";
import '../app/index.css'
import { FooterNavigation } from "@/components/FooterNavigation";
import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AgentRequire } from "@/components/AgentRequire";
import { ConnectionSelect } from "@/components/ConnectionSelect";
import { Chat } from "@/components/Chat";
import { filterChatMessages, filterChatAndCredentialMessages, groupChatMessagesByConnection, MESSAGE_TYPES } from "@/utils/messageFilters";
import { sendMessage } from "@/actions";
import { getItem, setItem } from "@/utils/prefixedStorage";
import { getConnectionMetadata } from "@/utils/connectionMetadata";

// Helper to get the "last viewed" timestamp for a conversation
function getLastViewedTimestamp(connectionHostDID: string): number {
    const key = `conversation-last-viewed-${connectionHostDID}`;
    const timestamp = getItem(key);
    return timestamp ? Number(timestamp) : 0;
}

// Helper to mark a conversation as viewed (stores current timestamp)
function markConversationAsViewed(connectionHostDID: string): void {
    const key = `conversation-last-viewed-${connectionHostDID}`;
    setItem(key, Date.now());
}




export default function App() {
    const app = useMountedApp();

    const [messages, setMessages] = useState(app.messages);
    const [selectedConnection, setSelectedConnection] = useState<SDK.Domain.DIDPair | null>(null);
    const [conversationMessages, setConversationMessages] = useState<SDK.Domain.Message[]>([]);

    useEffect(() => {
        setMessages(app.messages)
    }, [app.messages, app.db])

    useEffect(() => {
        // Filter messages for selected conversation
        if (selectedConnection && messages.length > 0) {

            const chatMessages = filterChatAndCredentialMessages(messages);

            const filtered = chatMessages.filter(msg => {
                const from = msg.from?.toString();
                const to = msg.to?.toString();
                const hostStr = selectedConnection.host.toString();
                const receiverStr = selectedConnection.receiver.toString();

                // Primary matching: exact DID match
                const exactMatch = (from === hostStr && to === receiverStr) ||
                                  (from === receiverStr && to === hostStr);

                // Fallback matching: check if either DID appears in the message
                const fallbackMatch = (from === hostStr || from === receiverStr) ||
                                     (to === hostStr || to === receiverStr);

                const matches = exactMatch || fallbackMatch;


                return matches;
            });

            // Sort messages by timestamp for chronological order
            const sortedMessages = filtered.sort((a, b) => {
                const aTime = a.createdTime ? new Date(a.createdTime).getTime() : 0;
                const bTime = b.createdTime ? new Date(b.createdTime).getTime() : 0;
                return aTime - bTime; // Oldest first
            });


            setConversationMessages(sortedMessages);
        } else {
            setConversationMessages([]);
        }
    }, [selectedConnection, messages])

    async function handleSendMessage(content: string, toDID: string, securityLevel?: number) {

        if (!content || content === "") {
            throw new Error("Message content is required");
        }

        if (!selectedConnection) {
            throw new Error("No connection selected");
        }

        const agent = app.agent.instance!;

        // NEW: If securityLevel is provided, use the enhanced sendMessage with encryption
        if (securityLevel !== undefined && securityLevel > 0) {
            try {
                // Use the new encryption-enabled sendMessage action
                const result = await app.dispatch(sendMessage({
                    agent,
                    content,
                    recipientDID: toDID,
                    securityLevel
                }));
                return;
            } catch (error) {
                console.error('❌ [DEBUG] Encrypted sendMessage failed:', error);
                throw error;
            }
        }

        // LEGACY: Plaintext message flow (backwards compatible)
        // Use the stored connection DIDs instead of creating new ephemeral DIDs
        const fromDID = selectedConnection.host;  // Sender's DID from the connection
        const toDIDObj = selectedConnection.receiver;  // Recipient's DID from the connection

        const message = new SDK.BasicMessage(
            { content },
            fromDID,
            toDIDObj
        );

        const messageObj = message.makeMessage();

        try {
            const result = await app.dispatch(sendMessage({ agent, message: messageObj }));
        } catch (error) {
            console.error('❌ [DEBUG] sendMessage failed:', error);
            throw error;
        }
    }

    return (
        <div>
            {/* Header */}
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-1">Messages</h2>
                <p className="text-slate-400 text-sm">Chat with your connections via DIDComm</p>
            </header>

            <DBConnect>
                    <AgentRequire>
                        <div className="flex flex-col lg:flex-row gap-4 w-full">
                            {/* Conversation List */}
                            <Box className="w-full lg:w-80 xl:w-96 flex-shrink-0">
                                <h2 className="text-xl font-bold mb-4 text-white">
                                    Conversations
                                </h2>
                                {(() => {
                                    // Filter connections to only show those with RealPersonVC proof
                                    // OR show all if no metadata (existing connections grandfathered)
                                    const filteredConnections = app.connections.filter(connection => {
                                        const metadata = getConnectionMetadata(connection.host.toString());
                                        return metadata?.establishedWithVCProof === true || !metadata;
                                    });

                                    if (filteredConnections.length === 0) {
                                        return (
                                            <p className="text-slate-400">
                                                No verified connections yet
                                            </p>
                                        );
                                    }

                                    return (
                                        <div className="space-y-2">
                                            {filteredConnections.map((connection, i) => {
                                            const isSelected = selectedConnection?.host.toString() === connection.host.toString();
                                            const connectionHostDID = connection.host.toString();

                                            // Get the timestamp when this conversation was last viewed
                                            const lastViewedTime = getLastViewedTimestamp(connectionHostDID);

                                            // Count only UNREAD received BasicMessages for this connection
                                            // (messages received AFTER the last time user viewed this conversation)
                                            const basicMessages = filterChatMessages(messages);
                                            const unreadMessages = basicMessages.filter(msg => {
                                                const from = msg.from?.toString();
                                                const to = msg.to?.toString();
                                                const hostStr = connection.host.toString();
                                                const receiverStr = connection.receiver.toString();

                                                // Only messages FROM the other party TO us
                                                const isReceivedFromOther = from === receiverStr && to === hostStr;
                                                if (!isReceivedFromOther) return false;

                                                // Only messages received AFTER the last viewed timestamp
                                                // Handle both seconds and milliseconds timestamps
                                                const msgTime = msg.createdTime
                                                    ? (msg.createdTime < 10000000000 ? msg.createdTime * 1000 : msg.createdTime)
                                                    : 0;
                                                return msgTime > lastViewedTime;
                                            });
                                            const hasUnreadMessages = unreadMessages.length > 0;

                                            // Handle click: select connection AND mark as viewed
                                            const handleConnectionClick = () => {
                                                setSelectedConnection(connection);
                                                markConversationAsViewed(connectionHostDID);
                                            };

                                            return (
                                                <div
                                                    key={`connection-${i}`}
                                                    onClick={handleConnectionClick}
                                                    className={`p-3 rounded-xl cursor-pointer transition-all ${
                                                        isSelected
                                                            ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border-l-4 border-cyan-500'
                                                            : 'hover:bg-slate-800/30'
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex-1">
                                                            <p className="font-semibold text-white">
                                                                {connection.name || 'Unknown Contact'}
                                                            </p>
                                                            <p className="text-xs text-slate-500 truncate">
                                                                {connection.receiver.toString().substring(0, 30)}...
                                                            </p>
                                                        </div>
                                                        {hasUnreadMessages && (
                                                            <span className="bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-xs px-2 py-1 rounded-full">
                                                                {unreadMessages.length}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        </div>
                                    );
                                })()}
                            </Box>

                            {/* Chat Area */}
                            <Box className="flex-1 min-w-0 overflow-hidden">
                                {selectedConnection ? (
                                    <div className="h-full flex flex-col">
                                        <div className="flex-1 overflow-hidden">
                                            <ErrorBoundary componentName="Chat">
                                                <Chat
                                                    messages={conversationMessages}
                                                    connection={selectedConnection}
                                                    onSendMessage={handleSendMessage}
                                                />
                                            </ErrorBoundary>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="h-full flex items-center justify-center text-slate-400">
                                        <div className="text-center">
                                            <p className="text-2xl mb-2">💬</p>
                                            <p>Select a conversation to start messaging</p>
                                        </div>
                                    </div>
                                )}
                            </Box>
                        </div>
                    </AgentRequire>
            </DBConnect>
        </div>
    );
}