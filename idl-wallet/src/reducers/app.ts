import { PayloadAction, createSlice } from "@reduxjs/toolkit";
// Using SDK for initial state - direct import (memory managed elsewhere)
import SDK from "@hyperledger/identus-edge-agent-sdk";
import { v4 as uuidv4 } from "uuid";
import { DBPreload, Message, Credential, Mediator, Connection } from "@/actions/types";
import { acceptCredentialOffer, acceptPresentationRequest, connectDatabase, initAgent, rejectCredentialOffer, sendMessage, startAgent, stopAgent, refreshConnections, refreshCredentials, deleteConnection } from "../actions";

// IDL Wallet configuration
const getWalletConfig = () => {
    return {
        walletId: 'idl',
        walletName: 'IDL Wallet',
        dbName: 'identus-wallet-idl', // Unique database per wallet
        storagePrefix: 'wallet-idl-' // Unique storage prefix
    };
};

// Updated to single HTTP endpoint only (no WebSocket) - mediator restarted on 2025-10-11
const defaultMediatorDID = "did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y.Vz6Mkhh1e5CEYYq6JBUcTZ6Cp2ranCWRrv7Yax3Le4N59R6dd.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHBzOi8vaWRlbnR1c2xhYmVsLmN6L21lZGlhdG9yIiwiYSI6WyJkaWRjb21tL3YyIl19fQ";

export type ApiCall = {
    title: string,
    description: string,
    method: string,
    endpoint: (store: Store) => string,
    requestBody: (store: Store) => any,
    curlCommand: (url: string, method: string, body?: string | null) => string
}

export type Component = (props: any) => React.JSX.Element;
export type Content = CodeBlock | ApiCall | Component;
export type Store = { [name: string]: any }
export type Step = {
    title: string,
    description: string,
    content: Content[],
    onNext?: (store: Store) => Promise<void>
}
export type CodeBlock = {
    language: string,
    code: string
}


class TraceableError extends Error {

    constructor(...params) {
        super(...params)
    }

    public id = uuidv4();
    static fromError(err: Error) {
        return new TraceableError(err.message);
    }
}

export enum DBStatus {
    "disconnected" = "disconnected",
    "connected" = "connected"
}

// Create defaultSeed with fallback for memory issues
let defaultSeed: SDK.Domain.Seed;
try {
    defaultSeed = new SDK.Apollo().createSeed([
        "repeat",
        "spider",
        "frozen",
        "drama",
        "april",
        "step",
        "engage",
        "pitch",
        "purity",
        "arrest",
        "orchard",
        "grocery",
        "green",
        "chapter",
        "know",
        "disease",
        "attend",
        "notable",
        "usage",
        "add",
        "trash",
        "dry",
        "refuse",
        "jewel"
    ]);
} catch (error) {
    console.warn('⚠️ SDK not available at initialization, using placeholder seed');
    // Create a placeholder seed that will be replaced when SDK loads
    defaultSeed = {
        value: new Uint8Array(64), // Placeholder 64-byte seed
        size: 64
    } as SDK.Domain.Seed;
}

const walletConfig = getWalletConfig();

export const initialState: RootState = {
    errors: [],
    wallet: walletConfig,
    db: {
        instance: null,
        connected: false,
        isConnecting: false,
        hasConnected: false,
    },
    messages: [],
    chatMessages: [],
    protocolMessages: [],
    currentConversation: null,
    messageSendingStatus: {},
    connections: [],
    credentials: [],
    presentationRequests: [],  // Initialize empty presentation requests array
    prismDIDs: [],  // Long-form PRISM DIDs for credential issuance
    isCreatingPrismDID: false,
    mediatorDID: (() => {
        try {
            return SDK.Domain.DID.fromString(defaultMediatorDID);
        } catch (error) {
            console.warn('⚠️ SDK not available at initialization, using placeholder mediatorDID');
            // Create a placeholder DID that will be replaced when SDK loads
            return {
                method: 'peer',
                methodId: 'placeholder',
                toString: () => defaultMediatorDID
            } as SDK.Domain.DID;
        }
    })(),
    defaultSeed: defaultSeed,
    agent: {
        instance: null,
        hasStarted: false,
        isStarting: false,
        isSendingMessage: false,
        hasSentMessage: false,
        selfDID: null
    }
}

export type ExtendedMessage = SDK.Domain.Message & { isAnswering: boolean; hasAnswered: boolean, error: TraceableError | null }

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'received';

export type ChatMessage = {
    id: string;
    content: string;
    from: string;
    to: string;
    timestamp: Date;
    direction: SDK.Domain.MessageDirection;
    status: MessageStatus;
    connectionId?: string;
};

export type WalletConfig = {
    walletId: string;
    walletName: string;
    dbName: string;
    storagePrefix: string;
};

// Presentation request status tracking
export type PresentationRequestStatus = 'pending' | 'sent' | 'declined';

// Presentation request state structure
export type PresentationRequest = {
    id: string;                                  // Request message ID
    from: string;                                // Sender DID
    schemaId?: string;                           // Optional schema ID for auto-credential selection
    requestMessage: SDK.Domain.Message;          // Full RequestPresentation message
    timestamp: string;                           // ISO timestamp
    status: PresentationRequestStatus;
};

export type RootState = {
    errors: TraceableError[];
    wallet: WalletConfig;
    db: {
        instance: SDK.Domain.Pluto | null,
        connected: boolean
        isConnecting: boolean,
        hasConnected: boolean
    },
    messages: ExtendedMessage[],
    chatMessages: ChatMessage[],  // New: separated chat messages
    protocolMessages: SDK.Domain.Message[],  // New: connection/credential messages
    currentConversation: string | null,  // New: selected conversation
    messageSendingStatus: { [messageId: string]: MessageStatus },  // New: track sending status
    connections: SDK.Domain.DIDPair[],
    credentials: SDK.Domain.Credential[],
    presentationRequests: PresentationRequest[],  // New: track presentation requests for manual VC selection
    prismDIDs: any[],  // Long-form PRISM DIDs for credential issuance (SDK.Domain.PrismDID[])
    isCreatingPrismDID: boolean,
    mediatorDID: SDK.Domain.DID,
    defaultSeed: SDK.Domain.Seed,
    agent: {
        instance: SDK.Agent | null,
        selfDID: SDK.Domain.DID | null,
        isStarting: boolean,
        hasStarted: boolean,
        isSendingMessage: boolean,
        hasSentMessage: boolean
    }
};

function removeDuplicates(messages: SDK.Domain.Message[] | SDK.Domain.Credential[]) {
    const uniqueMessages = new Map();
    messages.forEach(message => {
        uniqueMessages.set(message.id, message);
    });
    return Array.from(uniqueMessages.values());
}

const appSlice = createSlice({
    name: "app",
    initialState: initialState,
    reducers: {
        [Mediator.update]: (
            state,
            action: PayloadAction<{
                mediator: string
            }>
        ) => {
            state.mediatorDID = SDK.Domain.DID.fromString(action.payload.mediator)
        },
        [DBPreload.complete]: (
            state,
            action: PayloadAction<{
                messages: SDK.Domain.Message[],
                connections: SDK.Domain.DIDPair[],
                credentials: SDK.Domain.Credential[]
            }>
        ) => {
            // ✅ FIX: Deduplicate messages loaded from IndexedDB to prevent React duplicate key warnings
            state.messages = removeDuplicates(action.payload.messages) as any;
            state.connections = action.payload.connections;
            state.credentials = action.payload.credentials;
        },
        [Credential.success]: (
            state,
            action: PayloadAction<SDK.Domain.Credential>
        ) => {
            state.credentials = removeDuplicates([
                ...state.credentials,
                action.payload,
            ]);
        },
        [Connection.success]: (
            state,
            action: PayloadAction<SDK.Domain.DIDPair>
        ) => {
            // Add new connection to state with deduplication by host+receiver DID
            const existingIndex = state.connections.findIndex(conn =>
                conn.host.toString() === action.payload.host.toString() &&
                conn.receiver.toString() === action.payload.receiver.toString()
            );

            if (existingIndex >= 0) {
                // Update existing connection (e.g., name change)
                state.connections[existingIndex] = action.payload;
                console.log('🔄 [Redux] Updated existing connection in state:', action.payload.name);
            } else {
                // Add new connection
                state.connections = [...state.connections, action.payload];
                console.log('✅ [Redux] Added new connection to state:', action.payload.name);
            }
        },
        [Message.success]: (
            state,
            action: PayloadAction<SDK.Domain.Message[]>
        ) => {
            // ✅ FIX: Use Map-based deduplication for O(n) performance
            // Create a Map of existing messages by ID for O(1) lookup
            const existingMessagesMap = new Map(
                state.messages.map(msg => [msg.id, msg])
            );

            // Process new messages: update existing or add new
            action.payload.forEach(newMessage => {
                existingMessagesMap.set(newMessage.id, newMessage);
            });

            // Collect thread IDs from new messages to mark related messages as answered
            const newMessageThreadIds = new Set(
                action.payload.map(m => m.thid).filter(Boolean)
            );

            // Convert Map back to array with updated flags for thread responses
            state.messages = Array.from(existingMessagesMap.values()).map(msg => {
                // If an existing message has a thread response in the new messages, mark it as answered
                if (msg.id && newMessageThreadIds.has(msg.id)) {
                    return {
                        ...msg,
                        isAnswering: false,
                        hasAnswered: true
                    };
                }
                return msg;
            }) as ExtendedMessage[];
        },
        "updateAgent": (
            state,
            action: PayloadAction<{ agent: SDK.Agent, selfDID: SDK.Domain.DID, pluto: SDK.Domain.Pluto }>
        ) => {
            state.agent.isStarting = false;
            state.agent.hasStarted = true;
            state.agent.instance = action.payload.agent;
            state.agent.selfDID = action.payload.selfDID;
            state.db.hasConnected = true;
            state.db.isConnecting = false;
            state.db.instance = action.payload.pluto;
            state.db.connected = true;
        },
        // Presentation request management reducers for manual VC selection workflow
        presentationRequestReceived: (
            state,
            action: PayloadAction<{
                id: string;
                from: string;
                schemaId?: string;
                requestMessage: SDK.Domain.Message;
                timestamp: string;
            }>
        ) => {
            // Add new presentation request with pending status
            state.presentationRequests.push({
                id: action.payload.id,
                from: action.payload.from,
                schemaId: action.payload.schemaId,
                requestMessage: action.payload.requestMessage,
                timestamp: action.payload.timestamp,
                status: 'pending'
            });
        },
        presentationRequestResponded: (
            state,
            action: PayloadAction<{ requestId: string }>
        ) => {
            // Update request status to 'sent' after user sends selected VC
            // ✅ Immutable update - React detects state change and triggers re-render
            state.presentationRequests = state.presentationRequests.map(req =>
                req.id === action.payload.requestId
                    ? { ...req, status: 'sent' }
                    : req
            );
        },
        presentationRequestDeclined: (
            state,
            action: PayloadAction<{ requestId: string }>
        ) => {
            // Update request status to 'declined' when user rejects
            // ✅ Immutable update - React detects state change and triggers re-render
            state.presentationRequests = state.presentationRequests.map(req =>
                req.id === action.payload.requestId
                    ? { ...req, status: 'declined' }
                    : req
            );
        },
        clearOldPresentationRequests: (
            state,
            action: PayloadAction<{ olderThan: string }>
        ) => {
            // Remove completed requests (sent/declined) older than threshold
            const thresholdDate = new Date(action.payload.olderThan);
            state.presentationRequests = state.presentationRequests.filter(req => {
                // Keep pending requests regardless of age
                if (req.status === 'pending') return true;

                // Remove completed requests older than threshold
                const requestDate = new Date(req.timestamp);
                return requestDate >= thresholdDate;
            });
        },
        // PRISM DID management reducers
        setPrismDIDs: (
            state,
            action: PayloadAction<any[]>
        ) => {
            state.prismDIDs = action.payload;
        },
        setCreatingPrismDID: (
            state,
            action: PayloadAction<boolean>
        ) => {
            state.isCreatingPrismDID = action.payload;
        },
        prismDIDCreated: (
            state,
            action: PayloadAction<any>
        ) => {
            state.prismDIDs = [...state.prismDIDs, action.payload];
            state.isCreatingPrismDID = false;
        },
    },
    extraReducers: (builder) => {

        builder.addCase(sendMessage.fulfilled, (state, action) => {
            state.agent.isSendingMessage = false;
            state.agent.hasSentMessage = true;
        })

        builder.addCase(sendMessage.pending, (state, action) => {
            state.agent.isSendingMessage = true;
            state.agent.hasSentMessage = false;
            // ✅ FIX: Removed premature message state update
            // Message will be added via messageSuccess action after it's actually created
        })

        builder.addCase(sendMessage.rejected, (state, action) => {
            state.agent.isSendingMessage = false;
            state.agent.hasSentMessage = false;
            state.errors.push(TraceableError.fromError(action.payload as Error));
        })

        builder.addCase(stopAgent.fulfilled, (state, action) => {
            state.agent.isStarting = false;
            state.agent.hasStarted = false;
        });

        builder.addCase(stopAgent.rejected, (state, action) => {
            state.agent.isStarting = false;
            state.agent.hasStarted = false;
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        builder.addCase(startAgent.pending, (state, action) => {
            state.agent.isStarting = true;
            state.agent.hasStarted = false;
        });

        builder.addCase(startAgent.fulfilled, (state, action) => {
            state.agent.isStarting = false;
            state.agent.hasStarted = true;
            state.agent.instance = action.payload.agent;
            state.agent.selfDID = action.payload.selfDID;
        });

        builder.addCase(startAgent.rejected, (state, action) => {
            state.agent.isStarting = false;
            state.agent.hasStarted = false;
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        builder.addCase(initAgent.pending, (state, action) => {
            state.agent.instance = null;
        });

        builder.addCase(refreshConnections.fulfilled, (state, action) => {
            state.connections = action.payload.connections;
        });

        builder.addCase(refreshConnections.rejected, (state, action) => {
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        // ✅ NEW: Delete connection - Direct Redux state mutation (Layer 2)
        builder.addCase(deleteConnection.fulfilled, (state, action) => {
            const { hostDID } = action.payload;
            console.log('🗑️ [REDUCER] deleteConnection.fulfilled - Removing connection from state:', hostDID.substring(0, 50) + '...');
            console.log('📊 [REDUCER] Connections before deletion:', state.connections.length);

            // LAYER 2: Direct state mutation - Remove connection from array
            state.connections = state.connections.filter(
                c => c.host.toString() !== hostDID
            );

            console.log('📊 [REDUCER] Connections after deletion:', state.connections.length);
            console.log('✅ [REDUCER] Connection removed from Redux state successfully');
        });

        builder.addCase(deleteConnection.rejected, (state, action) => {
            console.error('❌ [REDUCER] deleteConnection.rejected:', action.payload);
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        builder.addCase(refreshCredentials.fulfilled, (state, action) => {
            console.log('🔄 [REDUCER] refreshCredentials.fulfilled');
            console.log('📊 [REDUCER] Previous credential count:', state.credentials.length);
            console.log('📊 [REDUCER] New credential count:', action.payload.credentials.length);

            // 🔍 DIAGNOSTIC: Log credential IDs before/after
            console.log('🔍 [REDUCER] Previous credential IDs:', state.credentials.map(c => c.id));
            console.log('🔍 [REDUCER] New credential IDs:', action.payload.credentials.map(c => c.id));

            state.credentials = action.payload.credentials;

            console.log('✅ [REDUCER] State updated with new credentials');
        });

        builder.addCase(refreshCredentials.rejected, (state, action) => {
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        builder.addCase(initAgent.rejected, (state, action) => {
            state.agent.instance = null;
            state.errors.push(TraceableError.fromError(action.payload as Error));
        });

        builder.addCase(initAgent.fulfilled, (state, action) => {
            state.agent.instance = action.payload.agent;
        });

        builder.addCase(connectDatabase.fulfilled, (state, action) => {
            state.db.hasConnected = true;
            state.db.isConnecting = false;
            state.db.instance = action.payload.db;
            state.db.connected = true;
        });

        builder.addCase(connectDatabase.rejected, (state, action) => {
            state.errors.push(TraceableError.fromError(action.payload as Error));
            state.db.hasConnected = false;
            state.db.isConnecting = false;
            state.db.instance = null;
            state.db.connected = false;
        });

        builder.addCase(connectDatabase.pending, (state) => {
            state.db.hasConnected = false;
            state.db.isConnecting = true;
            state.db.instance = null;
            state.db.connected = false;
        });

        builder.addCase(acceptPresentationRequest.pending, (state, action) => {
            const message = action.meta.arg.message;
            state.messages = state.messages.map((currentMessage) => {
                if (currentMessage.id === message.id) {
                    return {
                        ...currentMessage,
                        isAnswering: true,
                        hasAnswered: false,
                        error: null
                    }
                }
                return currentMessage
            })
        })

        builder.addCase(acceptPresentationRequest.rejected, (state, action) => {
            const message = action.meta.arg.message;
            state.messages = state.messages.map((currentMessage) => {
                if (currentMessage.id === message.id) {
                    return {
                        ...currentMessage,
                        isAnswering: false,
                        hasAnswered: false,
                        error: TraceableError.fromError(action.payload as Error)
                    }
                }
                return currentMessage
            })
        })

        builder.addCase(acceptPresentationRequest.fulfilled, (state, action) => {
            const message = action.meta.arg.message;
            // ✅ Remove message from state after successful acceptance (message already deleted from IndexedDB in action)
            state.messages = state.messages.filter((currentMessage) => currentMessage.id !== message.id)
        })

        builder.addCase(acceptCredentialOffer.pending, (state, action) => {
            const message = action.meta.arg.message;
            state.messages = state.messages.map((currentMessage) => {
                if (currentMessage.id === message.id) {
                    return {
                        ...currentMessage,
                        isAnswering: true,
                        hasAnswered: false,
                        error: null
                    }
                }
                return currentMessage
            })
        })

        builder.addCase(acceptCredentialOffer.rejected, (state, action) => {
            // Remove the rejected offer message from Redux state (already deleted from database in action)
            // Modal should close even if credential request failed
            const messageId = action.meta.arg.message.id;
            state.messages = state.messages.filter(m => m.id !== messageId);
            console.log('⚠️ [REDUCER] Removed failed offer message from state:', messageId);
            console.error('❌ [REDUCER] Credential offer acceptance failed:', action.payload);
        })

        builder.addCase(acceptCredentialOffer.fulfilled, (state, action) => {
            // Remove the accepted offer message from Redux state (already deleted from database in action)
            const messageId = action.meta.arg.message.id;
            state.messages = state.messages.filter(m => m.id !== messageId);
            console.log('✅ [REDUCER] Removed accepted offer message from state:', messageId);
        })

        builder.addCase(rejectCredentialOffer.rejected, (state, action) => {
            const message = action.meta.arg.message;
            state.messages = state.messages.map((currentMessage) => {
                if (currentMessage.id === message.id) {
                    return {
                        ...currentMessage,
                        isAnswering: false,
                        hasAnswered: false,
                        error: TraceableError.fromError(action.payload as Error)
                    }
                }
                return currentMessage
            })
        })

        builder.addCase(rejectCredentialOffer.fulfilled, (state, action) => {
            const message = action.meta.arg.message;
            state.messages = state.messages.filter((currentMessage) => currentMessage.id !== message.id)
        })
    }
});

export default appSlice.reducer;
export const reduxActions = appSlice.actions;
