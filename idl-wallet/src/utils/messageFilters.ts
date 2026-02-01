import SDK from '@hyperledger/identus-edge-agent-sdk';

// Message type constants
export const MESSAGE_TYPES = {
  BASIC_MESSAGE: 'https://didcomm.org/basicmessage/2.0/message',
  CONNECTION_REQUEST: 'https://atalaprism.io/mercury/connections/1.0/request',
  CONNECTION_RESPONSE: 'https://atalaprism.io/mercury/connections/1.0/response',
  // ✅ DIDExchange protocol support (standard DIDComm)
  DIDEXCHANGE_REQUEST: 'https://didcomm.org/didexchange/1.0/request',
  DIDEXCHANGE_RESPONSE: 'https://didcomm.org/didexchange/1.0/response',
  DIDEXCHANGE_COMPLETE: 'https://didcomm.org/didexchange/1.0/complete',
  CREDENTIAL_OFFER: 'https://didcomm.org/issue-credential/3.0/offer-credential',
  CREDENTIAL_REQUEST: 'https://didcomm.org/issue-credential/3.0/request-credential',
  CREDENTIAL_ISSUE: 'https://didcomm.org/issue-credential/3.0/issue-credential',
  PRESENTATION_REQUEST: 'https://didcomm.atalaprism.io/present-proof/3.0/request-presentation',
  PRESENTATION: 'https://didcomm.atalaprism.io/present-proof/3.0/presentation',
};

export interface ChatMessage {
  id: string;
  content: string;
  from: string;
  to: string;
  timestamp: Date;
  direction: SDK.Domain.MessageDirection;
  status?: 'sending' | 'sent' | 'failed' | 'received';
  connectionId?: string;
}

export interface GroupedMessages {
  chatMessages: SDK.Domain.Message[];
  protocolMessages: SDK.Domain.Message[];
  connectionMessages: SDK.Domain.Message[];
  credentialMessages: SDK.Domain.Message[];
}

/**
 * Filter messages to only return basic chat messages
 */
export function filterChatMessages(messages: SDK.Domain.Message[]): SDK.Domain.Message[] {
  return messages.filter(msg => msg.piuri === MESSAGE_TYPES.BASIC_MESSAGE);
}

/**
 * Filter messages to only return connection protocol messages
 */
export function filterConnectionMessages(messages: SDK.Domain.Message[]): SDK.Domain.Message[] {
  return messages.filter(msg =>
    msg.piuri === MESSAGE_TYPES.CONNECTION_REQUEST ||
    msg.piuri === MESSAGE_TYPES.CONNECTION_RESPONSE ||
    // ✅ DIDExchange protocol support
    msg.piuri === MESSAGE_TYPES.DIDEXCHANGE_REQUEST ||
    msg.piuri === MESSAGE_TYPES.DIDEXCHANGE_RESPONSE ||
    msg.piuri === MESSAGE_TYPES.DIDEXCHANGE_COMPLETE
  );
}

/**
 * Filter messages to only return credential protocol messages
 */
export function filterCredentialMessages(messages: SDK.Domain.Message[]): SDK.Domain.Message[] {
  return messages.filter(msg =>
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_OFFER ||
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_REQUEST ||
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_ISSUE ||
    msg.piuri === MESSAGE_TYPES.PRESENTATION_REQUEST ||
    msg.piuri === MESSAGE_TYPES.PRESENTATION
  );
}

/**
 * Filter messages to return both chat messages and credential messages
 */
export function filterChatAndCredentialMessages(messages: SDK.Domain.Message[]): SDK.Domain.Message[] {
  return messages.filter(msg =>
    msg.piuri === MESSAGE_TYPES.BASIC_MESSAGE ||
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_OFFER ||
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_REQUEST ||
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_ISSUE ||
    msg.piuri === MESSAGE_TYPES.PRESENTATION_REQUEST ||
    msg.piuri === MESSAGE_TYPES.PRESENTATION
  );
}

/**
 * Group messages by type
 */
export function groupMessagesByType(messages: SDK.Domain.Message[]): GroupedMessages {
  return {
    chatMessages: filterChatMessages(messages),
    protocolMessages: messages.filter(msg => msg.piuri !== MESSAGE_TYPES.BASIC_MESSAGE),
    connectionMessages: filterConnectionMessages(messages),
    credentialMessages: filterCredentialMessages(messages),
  };
}

/**
 * Group chat messages by connection (conversation)
 */
export function groupChatMessagesByConnection(messages: SDK.Domain.Message[]): Map<string, SDK.Domain.Message[]> {
  const chatMessages = filterChatMessages(messages);
  const grouped = new Map<string, SDK.Domain.Message[]>();

  chatMessages.forEach(message => {
    // Create a unique conversation ID based on the DIDs involved
    const conversationId = getConversationId(message);

    if (!grouped.has(conversationId)) {
      grouped.set(conversationId, []);
    }
    grouped.get(conversationId)?.push(message);
  });

  // Sort messages within each conversation by timestamp
  grouped.forEach((msgs, key) => {
    msgs.sort((a, b) => {
      const timeA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
      const timeB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
      return timeA - timeB;
    });
  });

  return grouped;
}

/**
 * Get a unique conversation ID for a message based on the DIDs involved
 */
export function getConversationId(message: SDK.Domain.Message): string {
  const from = message.from?.toString() || '';
  const to = message.to?.toString() || '';

  // Sort DIDs to ensure consistent conversation ID regardless of direction
  const dids = [from, to].sort();
  return `${dids[0]}_${dids[1]}`;
}

/**
 * Extract connection name from a message or connection
 */
export function getConnectionName(
  message: SDK.Domain.Message,
  connections: SDK.Domain.DIDPair[]
): string {
  const from = message.from?.toString();
  const to = message.to?.toString();

  // Find matching connection
  const connection = connections.find(conn => {
    const hostStr = conn.host.toString();
    const receiverStr = conn.receiver.toString();
    return (hostStr === from || hostStr === to) &&
           (receiverStr === from || receiverStr === to);
  });

  return connection?.name || 'Unknown Contact';
}

/**
 * Convert SDK message to chat message format
 */
export function toChatMessage(message: SDK.Domain.Message): ChatMessage | null {
  if (message.piuri !== MESSAGE_TYPES.BASIC_MESSAGE) {
    return null;
  }

  let content = '';
  try {
    const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
    content = body.content || '';
  } catch (e) {
    content = message.body?.toString() || '';
  }

  return {
    id: message.id,
    content,
    from: message.from?.toString() || '',
    to: message.to?.toString() || '',
    timestamp: message.createdTime ? new Date(message.createdTime) : new Date(),
    direction: message.direction,
    status: message.direction === SDK.Domain.MessageDirection.RECEIVED ? 'received' : 'sent',
    connectionId: getConversationId(message),
  };
}

/**
 * Get pending credential offers that need user action
 */
export function getPendingCredentialOffers(messages: SDK.Domain.Message[]): SDK.Domain.Message[] {
  return messages.filter(msg =>
    msg.piuri === MESSAGE_TYPES.CREDENTIAL_OFFER &&
    msg.direction === SDK.Domain.MessageDirection.RECEIVED
  );
}

/**
 * Check if a message needs user action (for connection requests, credential offers, etc.)
 */
export function needsUserAction(message: SDK.Domain.Message): boolean {
  return (
    (message.piuri === MESSAGE_TYPES.CONNECTION_REQUEST &&
     message.direction === SDK.Domain.MessageDirection.RECEIVED) ||
    // ✅ DIDExchange connection requests also need user action
    (message.piuri === MESSAGE_TYPES.DIDEXCHANGE_REQUEST &&
     message.direction === SDK.Domain.MessageDirection.RECEIVED) ||
    (message.piuri === MESSAGE_TYPES.CREDENTIAL_OFFER &&
     message.direction === SDK.Domain.MessageDirection.RECEIVED)
  );
}

/**
 * Extract credential preview data from a credential offer message
 */
export function extractCredentialOfferData(message: SDK.Domain.Message) {
  try {
    const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
    return {
      credentialPreview: body.credential_preview,
      issuerDID: message.from?.toString() || '',
      messageId: message.id,
      attributes: body.credential_preview?.body?.attributes || []
    };
  } catch (error) {
    console.error('Error extracting credential offer data:', error);
    return null;
  }
}