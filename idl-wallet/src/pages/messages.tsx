import SDK from "@hyperledger/identus-edge-agent-sdk";
import React, { useEffect, useState, useCallback, useRef } from "react";
import '../app/index.css'
import { FooterNavigation } from "@/components/FooterNavigation";
import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AgentRequire } from "@/components/AgentRequire";
import { Chat } from "@/components/Chat";
import { filterChatMessages, filterChatAndCredentialMessages, groupChatMessagesByConnection, MESSAGE_TYPES } from "@/utils/messageFilters";
import { sendMessage, refreshEnterpriseConnections } from "@/actions";
import { getItem, setItem } from "@/utils/prefixedStorage";
import { getConnectionMetadata } from "@/utils/connectionMetadata";
import { useSelector, useDispatch } from "react-redux";
import {
  selectEnterpriseConnections,
  selectIsEnterpriseConfigured,
  selectEnterpriseClient,
  mergeColleagueMessages,
  addSentColleagueMessage,
  selectAllColleagueMessages,
  EnterpriseConnection
} from "@/reducers/enterpriseAgent";
import { ColleagueMessage } from "@/utils/EnterpriseAgentClient";

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

// Unified connection type for the sidebar
type ChatMode = 'personal' | 'enterprise';
interface UnifiedConnection {
    mode: ChatMode;
    id: string; // host DID (personal) or connectionId (enterprise)
    name: string;
    personal?: SDK.Domain.DIDPair;
    enterprise?: EnterpriseConnection;
}

export default function App() {
    const app = useMountedApp();
    const dispatch = useDispatch();

    const [messages, setMessages] = useState(app.messages);
    const [selectedConn, setSelectedConn] = useState<UnifiedConnection | null>(null);
    const [conversationMessages, setConversationMessages] = useState<SDK.Domain.Message[]>([]);

    // Enterprise state
    const enterpriseConnections = useSelector(selectEnterpriseConnections);
    const isEnterpriseConfigured = useSelector(selectIsEnterpriseConfigured);
    const enterpriseClient = useSelector(selectEnterpriseClient);
    const allColleagueMessages = useSelector(selectAllColleagueMessages);

    // Enterprise chat send state
    const [enterpriseSendText, setEnterpriseSendText] = useState('');
    const [enterpriseSending, setEnterpriseSending] = useState(false);
    const enterpriseMsgEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setMessages(app.messages);
    }, [app.messages, app.db]);

    // Fetch enterprise connections on mount if configured
    useEffect(() => {
        if (isEnterpriseConfigured) {
            dispatch(refreshEnterpriseConnections() as any);
        }
    }, [isEnterpriseConfigured]);

    // Poll colleague messages every 5s when an enterprise connection is selected
    useEffect(() => {
        if (!isEnterpriseConfigured || !enterpriseClient || selectedConn?.mode !== 'enterprise') return;
        const connId = selectedConn.id;
        let cancelled = false;
        async function poll() {
            if (cancelled || !enterpriseClient) return;
            const since = allColleagueMessages[connId]?.at(-1)?.timestamp;
            const result = await enterpriseClient.getColleagueMessages(since);
            if (!cancelled && result.success && result.data && result.data.length > 0) {
                const forThis = result.data.filter(m => m.connectionId === connId);
                if (forThis.length > 0) {
                    dispatch(mergeColleagueMessages({ connectionId: connId, messages: forThis }));
                }
            }
        }
        poll();
        const timer = setInterval(poll, 5000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [selectedConn, isEnterpriseConfigured, enterpriseClient]);

    // Scroll enterprise messages to bottom when they change
    useEffect(() => {
        if (selectedConn?.mode === 'enterprise') {
            enterpriseMsgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [allColleagueMessages, selectedConn]);

    // Filter personal messages for selected conversation
    useEffect(() => {
        if (selectedConn?.mode !== 'personal' || !selectedConn.personal) {
            setConversationMessages([]);
            return;
        }
        const connection = selectedConn.personal;
        if (messages.length === 0) { setConversationMessages([]); return; }

        const chatMessages = filterChatAndCredentialMessages(messages);
        const filtered = chatMessages.filter(msg => {
            const from = msg.from?.toString();
            const to = msg.to?.toString();
            const hostStr = connection.host.toString();
            const receiverStr = connection.receiver.toString();
            const exactMatch = (from === hostStr && to === receiverStr) ||
                              (from === receiverStr && to === hostStr);
            const fallbackMatch = (from === hostStr || from === receiverStr) ||
                                 (to === hostStr || to === receiverStr);
            return exactMatch || fallbackMatch;
        });

        const sortedMessages = filtered.sort((a, b) => {
            const aTime = a.createdTime ? new Date(a.createdTime).getTime() : 0;
            const bTime = b.createdTime ? new Date(b.createdTime).getTime() : 0;
            return aTime - bTime;
        });
        setConversationMessages(sortedMessages);
    }, [selectedConn, messages]);

    async function handleSendMessage(content: string, toDID: string, securityLevel?: number) {
        if (!content || content === "") throw new Error("Message content is required");
        if (!selectedConn?.personal) throw new Error("No connection selected");

        const agent = app.agent.instance!;
        if (securityLevel !== undefined && securityLevel > 0) {
            await app.dispatch(sendMessage({ agent, content, recipientDID: toDID, securityLevel }));
            return;
        }

        const fromDID = selectedConn.personal.host;
        const toDIDObj = selectedConn.personal.receiver;
        const message = new SDK.BasicMessage({ content }, fromDID, toDIDObj);
        const messageObj = message.makeMessage();
        await app.dispatch(sendMessage({ agent, message: messageObj }));
    }

    async function handleEnterpriseSend() {
        const content = enterpriseSendText.trim();
        if (!content || !selectedConn?.enterprise || !enterpriseClient) return;
        setEnterpriseSending(true);
        setEnterpriseSendText('');
        try {
            const result = await enterpriseClient.sendBasicMessage(selectedConn.id, content);
            if (result.success) {
                const sentMsg: ColleagueMessage = {
                    id: `sent-${Date.now()}`,
                    fromEmail: 'me',
                    fromName: 'You',
                    content,
                    timestamp: Date.now(),
                    connectionId: selectedConn.id
                };
                dispatch(addSentColleagueMessage({ connectionId: selectedConn.id, message: sentMsg }));
            }
        } catch (e) {
            console.error('[EnterpriseSend]', e);
        }
        setEnterpriseSending(false);
    }

    // Build unified connection list
    const personalFiltered = app.connections.filter(connection => {
        const metadata = getConnectionMetadata(connection.host.toString());
        return metadata?.establishedWithVCProof === true
            || metadata?.isCAConnection === true
            || connection.name?.includes('Certification Authority')
            || !metadata;
    });

    const activeEnterpriseConns = enterpriseConnections.filter(c =>
        ['ConnectionResponseSent', 'ConnectionResponseReceived', 'ACTIVE', 'active'].includes(c.state)
    );

    const unifiedList: UnifiedConnection[] = [
        ...personalFiltered.map(c => ({
            mode: 'personal' as ChatMode,
            id: c.host.toString(),
            name: c.name || 'Unknown Contact',
            personal: c
        })),
        ...activeEnterpriseConns.map(c => ({
            mode: 'enterprise' as ChatMode,
            id: c.connectionId,
            name: c.label || c.connectionId.slice(0, 12),
            enterprise: c
        }))
    ];

    function selectConnection(conn: UnifiedConnection) {
        setSelectedConn(conn);
        if (conn.mode === 'personal') {
            markConversationAsViewed(conn.id);
        }
    }

    const currentEnterpriseMessages = selectedConn?.mode === 'enterprise'
        ? (allColleagueMessages[selectedConn.id] || [])
        : [];

    return (
        <div>
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-1">Messages</h2>
                <p className="text-slate-400 text-sm">Chat with your connections via DIDComm</p>
            </header>

            <DBConnect>
                <AgentRequire>
                    <div className="flex flex-col lg:flex-row gap-4 w-full">
                        {/* Conversation List */}
                        <Box className="w-full lg:w-80 xl:w-96 flex-shrink-0">
                            <h2 className="text-xl font-bold mb-4 text-white">Conversations</h2>
                            {unifiedList.length === 0 ? (
                                <p className="text-slate-400">No verified connections yet</p>
                            ) : (
                                <div className="space-y-2">
                                    {unifiedList.map((conn, i) => {
                                        const isSelected = selectedConn?.id === conn.id;
                                        let unreadCount = 0;
                                        if (conn.mode === 'personal' && conn.personal) {
                                            const lastViewed = getLastViewedTimestamp(conn.id);
                                            const basicMsgs = filterChatMessages(messages);
                                            const hostStr = conn.personal.host.toString();
                                            const recStr = conn.personal.receiver.toString();
                                            unreadCount = basicMsgs.filter(msg => {
                                                const from = msg.from?.toString();
                                                const to = msg.to?.toString();
                                                if (!(from === recStr && to === hostStr)) return false;
                                                const msgTime = msg.createdTime
                                                    ? (msg.createdTime < 10000000000 ? msg.createdTime * 1000 : msg.createdTime)
                                                    : 0;
                                                return msgTime > lastViewed;
                                            }).length;
                                        }

                                        return (
                                            <div
                                                key={`conn-${i}`}
                                                onClick={() => selectConnection(conn)}
                                                className={`p-3 rounded-xl cursor-pointer transition-all ${
                                                    isSelected
                                                        ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border-l-4 border-cyan-500'
                                                        : 'hover:bg-slate-800/30'
                                                }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <p className="font-semibold text-white truncate">{conn.name}</p>
                                                            {conn.mode === 'enterprise' && (
                                                                <span className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded flex-shrink-0">
                                                                    Enterprise
                                                                </span>
                                                            )}
                                                        </div>
                                                        <p className="text-xs text-slate-500 truncate">
                                                            {conn.mode === 'personal'
                                                                ? conn.personal!.receiver.toString().substring(0, 30) + '...'
                                                                : conn.enterprise!.label
                                                                    ? conn.enterprise!.label.substring(0, 35)
                                                                    : (conn.enterprise!.theirDid?.substring(0, 30) ?? conn.id.slice(0, 12)) + '...'}
                                                        </p>
                                                    </div>
                                                    {unreadCount > 0 && (
                                                        <span className="bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-xs px-2 py-1 rounded-full ml-2 flex-shrink-0">
                                                            {unreadCount}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </Box>

                        {/* Chat Area */}
                        <Box className="flex-1 min-w-0 overflow-hidden">
                            {!selectedConn && (
                                <div className="h-full flex items-center justify-center text-slate-400">
                                    <div className="text-center">
                                        <p className="text-2xl mb-2">💬</p>
                                        <p>Select a conversation to start messaging</p>
                                    </div>
                                </div>
                            )}

                            {selectedConn?.mode === 'personal' && selectedConn.personal && (
                                <div className="h-full flex flex-col">
                                    <div className="flex-1 overflow-hidden">
                                        <ErrorBoundary componentName="Chat">
                                            <Chat
                                                messages={conversationMessages}
                                                connection={selectedConn.personal}
                                                onSendMessage={handleSendMessage}
                                            />
                                        </ErrorBoundary>
                                    </div>
                                </div>
                            )}

                            {selectedConn?.mode === 'enterprise' && (
                                <div className="h-full flex flex-col" style={{ minHeight: 400 }}>
                                    {/* Header */}
                                    <div className="flex items-center gap-2 mb-4 pb-3 border-b border-slate-700">
                                        <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-1 rounded">Enterprise</span>
                                        <span className="font-semibold text-white">{selectedConn.name}</span>
                                    </div>

                                    {/* Messages */}
                                    <div className="flex-1 overflow-y-auto space-y-3 pr-1 mb-4" style={{ maxHeight: 400 }}>
                                        {currentEnterpriseMessages.length === 0 ? (
                                            <p className="text-slate-500 text-center mt-8">No messages yet. Send the first message!</p>
                                        ) : (
                                            currentEnterpriseMessages.map((msg, i) => {
                                                const isMine = msg.fromEmail === 'me';
                                                const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                                return (
                                                    <div key={msg.id || i} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'} gap-1`}>
                                                        <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl text-sm ${
                                                            isMine
                                                                ? 'bg-gradient-to-r from-cyan-500 to-purple-600 text-white'
                                                                : 'bg-slate-700 text-slate-100'
                                                        }`}>
                                                            {msg.content}
                                                        </div>
                                                        <p className="text-xs text-slate-500">
                                                            {isMine ? 'You' : (msg.fromName || msg.fromEmail)} · {time}
                                                        </p>
                                                    </div>
                                                );
                                            })
                                        )}
                                        <div ref={enterpriseMsgEndRef} />
                                    </div>

                                    {/* Input */}
                                    <div className="flex gap-2 items-center border-t border-slate-700 pt-3">
                                        <input
                                            type="text"
                                            value={enterpriseSendText}
                                            onChange={e => setEnterpriseSendText(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEnterpriseSend(); } }}
                                            placeholder="Type a message…"
                                            className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500"
                                            disabled={enterpriseSending}
                                        />
                                        <button
                                            onClick={handleEnterpriseSend}
                                            disabled={enterpriseSending || !enterpriseSendText.trim()}
                                            className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
                                        >
                                            Send
                                        </button>
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
