import React, { useEffect, useRef, useState } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useMountedApp } from '@/reducers/store';
import { ChatMessage, MessageStatus } from '@/reducers/app';
import { SecurityLevel, SECURITY_LEVEL_NAMES, parseSecurityLevel } from '../utils/securityLevels';
import { getVCClearanceLevel, validateSecurityClearanceVC, getSecurityKeyByFingerprint, getSecurityKeyByFingerprintAsync } from '../utils/keyVCBinding';
import { SecurityLevelSelector } from './SecurityLevelSelector';
import { EncryptedMessageBadge } from './EncryptedMessageBadge';
import { decryptMessage } from '../utils/messageEncryption';
import { base64url } from 'jose';
import { verifyCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';

interface ChatProps {
  messages: SDK.Domain.Message[];
  connection: SDK.Domain.DIDPair;
  onSendMessage: (content: string, toDID: string, securityLevel?: SecurityLevel) => Promise<void>;
}

export const Chat: React.FC<ChatProps> = ({ messages, connection, onSendMessage }) => {
  const app = useMountedApp();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [messageText, setMessageText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selectedSecurityLevel, setSelectedSecurityLevel] = useState<SecurityLevel>(SecurityLevel.INTERNAL);

  // ✅ NEW: Store decrypted message content (cache)
  const [decryptedMessages, setDecryptedMessages] = useState<Map<string, string>>(new Map());

  // ✅ NEW: Security clearance revocation state
  const [clearanceRevoked, setClearanceRevoked] = useState<boolean>(false);
  const [clearanceRevocationReason, setClearanceRevocationReason] = useState<string>('');

  const selfDID = app.agent.selfDID?.toString();
  // ✅ FIX: In DIDPair structure, connection.host is ALWAYS this wallet's DID,
  // and connection.receiver is ALWAYS the remote party's DID.
  // Previous conditional logic was incorrect and caused sending messages to self.
  const otherDID = connection.receiver.toString();

  // Get user's maximum security clearance level
  const userSecurityClearanceVC = app.credentials.find(
    (cred: any) => {
      try {
        // Check type array (for legacy VCs)
        const types = cred.type || [];
        if (types.includes('SecurityClearanceCredential') || types.includes('SecurityClearance')) {
          return true;
        }

        // Check for clearanceLevel in claims (JWT credentials from Cloud Agent)
        const claims = cred.claims || [];
        if (claims.length > 0) {
          // Check first claim for clearanceLevel field
          const claim = claims[0];
          if (claim.clearanceLevel) {
            return true;
          }
        }

        // Check credentialSubject (alternative JWT structure)
        const subject = cred.credentialSubject;
        if (subject && subject.clearanceLevel) {
          return true;
        }

        return false;
      } catch (e) {
        return false;
      }
    }
  );
  const userMaxLevel = userSecurityClearanceVC
    ? getVCClearanceLevel(userSecurityClearanceVC)
    : SecurityLevel.INTERNAL;

  // ✅ NEW: Check user's security clearance revocation status
  useEffect(() => {
    const checkUserClearance = async () => {
      if (userSecurityClearanceVC) {
        const validity = await checkSecurityClearanceValidity(userSecurityClearanceVC);
        setClearanceRevoked(!validity.valid);
        if (!validity.valid) {
          setClearanceRevocationReason(validity.reason);
          console.warn('⚠️ [SECURITY] User clearance invalid:', validity.reason);
        }
      } else {
        // No clearance VC - reset state
        setClearanceRevoked(false);
        setClearanceRevocationReason('');
      }
    };

    checkUserClearance();
  }, [userSecurityClearanceVC]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ✅ NEW: Decrypt encrypted messages on-demand
  useEffect(() => {
    const decryptMessagesAsync = async () => {
      if (!app.agent.instance) return;

      const agent = app.agent.instance;
      const newDecrypted = new Map(decryptedMessages);
      let hasNewDecryptions = false;

      for (const message of messages) {
        // Skip if already decrypted
        if (newDecrypted.has(message.id)) continue;

        try {
          // Parse message body
          const body = typeof message.body === 'string'
            ? JSON.parse(message.body)
            : message.body;

          // Try to parse body.content for StandardMessageBody format
          let standardBody: any = null;
          if (body.content && typeof body.content === 'string') {
            try {
              const parsedContent = JSON.parse(body.content);
              if (parsedContent && typeof parsedContent === 'object' &&
                  'encrypted' in parsedContent && 'timestamp' in parsedContent) {
                standardBody = parsedContent;
              }
            } catch (e) {
              // Not nested JSON
            }
          }

          // Check if message is encrypted
          const encryptedBody = standardBody || body;
          if (encryptedBody.encrypted !== true || !encryptedBody.encryptionMeta) {
            continue; // Not encrypted or no metadata
          }

          console.log('🔓 [Chat] Decrypting message on-demand:', message.id.substring(0, 30) + '...');
          console.log('🔍 [Chat] EncryptionMeta:', {
            algorithm: encryptedBody.encryptionMeta.algorithm,
            hasSenderPublicKey: !!encryptedBody.encryptionMeta.senderPublicKey,
            hasRecipientPublicKey: !!encryptedBody.encryptionMeta.recipientPublicKey,
            hasCiphertext: !!encryptedBody.encryptionMeta.ciphertext,
            hasNonce: !!encryptedBody.encryptionMeta.nonce,
            messageDirection: message.direction, // 0=SENT, 1=RECEIVED
            from: message.from?.toString().substring(0, 50) + '...',
            to: message.to?.toString().substring(0, 50) + '...'
          });

          // Get user's v3.0.0 Security Clearance VC (with X25519 encryption keys)
          const credentials = await agent.pluto.getAllCredentials();

          // First pass: Try sync lookup (fast path for localStorage keys)
          let userVC: any = credentials.find((cred: any) => {
            try {
              if (!validateSecurityClearanceVC(cred)) return false;

              const credSubject = cred.credentialSubject || cred.subject;
              const x25519Fingerprint = credSubject?.x25519Fingerprint;

              if (!x25519Fingerprint) {
                console.log('⏭️ [Chat] Skipping VC - no x25519Fingerprint (not v3.0.0)');
                return false;
              }

              // Check if we have the private key for this VC in localStorage (fast sync check)
              const hasPrivateKey = getSecurityKeyByFingerprint(x25519Fingerprint) !== undefined;
              if (!hasPrivateKey) {
                console.log('⏭️ [Chat] Skipping VC in sync check - no localStorage key');
                return false;
              }

              // v3.0.0 Security Clearance VC found with localStorage key
              return true;
            } catch (e) {
              return false;
            }
          });

          // Second pass: If no VC found with localStorage key, try Pluto fallback (PRISM DID keys)
          if (!userVC) {
            console.log('🔍 [Chat] No localStorage key found, trying Pluto fallback...');
            for (const cred of credentials) {
              try {
                if (!validateSecurityClearanceVC(cred)) continue;

                const credSubject = (cred as any).credentialSubject || (cred as any).subject;
                const x25519Fingerprint = credSubject?.x25519Fingerprint;

                if (!x25519Fingerprint) continue;

                // Try async lookup with Pluto fallback
                const key = await getSecurityKeyByFingerprintAsync(x25519Fingerprint, agent);
                if (key) {
                  console.log('✅ [Chat] Found key via Pluto fallback');
                  userVC = cred;
                  break;
                }
              } catch (e) {
                continue;
              }
            }
          }

          if (!userVC) {
            console.warn('⚠️ [Chat] No v3.0.0 Security Clearance VC - cannot decrypt');
            newDecrypted.set(message.id, '🔒 [No v3.0.0 Security Clearance VC - upgrade required]');
            hasNewDecryptions = true;
            continue;
          }

          // Extract X25519 fingerprint from VC
          const userSubject = userVC.credentialSubject || userVC.subject;
          const userX25519Fingerprint = userSubject?.x25519Fingerprint;
          if (!userX25519Fingerprint) {
            console.error('❌ [Chat] v3.0.0 VC missing x25519Fingerprint');
            newDecrypted.set(message.id, '🔒 [Invalid v3.0.0 VC structure]');
            hasNewDecryptions = true;
            continue;
          }

          // Get dual-key from storage by X25519 fingerprint (with Pluto fallback for PRISM DID keys)
          const userKey = await getSecurityKeyByFingerprintAsync(userX25519Fingerprint, agent);
          if (!userKey) {
            console.error('❌ [Chat] X25519 private key not found in localStorage or Pluto');
            newDecrypted.set(message.id, '🔒 [X25519 key not found in storage or Pluto]');
            hasNewDecryptions = true;
            continue;
          }

          // Verify this is a dual-key structure
          const isDualKey = 'x25519' in userKey;
          if (!isDualKey) {
            console.error('❌ [Chat] Key is not dual-key format');
            newDecrypted.set(message.id, '🔒 [Legacy key format - v3.0.0 required]');
            hasNewDecryptions = true;
            continue;
          }

          // Decode X25519 private and public keys directly (no SDK transformation)
          const userX25519PrivateKey = base64url.decode((userKey as any).x25519.privateKeyBytes);
          const userX25519PublicKey = base64url.decode((userKey as any).x25519.publicKeyBytes);

          console.log('🔑 [Chat] Using X25519 encryption keys for decryption');
          console.log('   User X25519 fingerprint:', userX25519Fingerprint.substring(0, 20) + '...');

          // KEY VERIFICATION: For RECEIVED messages, verify our public key matches what sender used
          if (message.direction === 1) {  // RECEIVED
            const messageRecipientKey = encryptedBody.encryptionMeta.recipientPublicKey;
            const ourPublicKeyBase64 = base64url.encode(userX25519PublicKey);

            console.log('🔐 [Chat] KEY VERIFICATION:');
            console.log('   Message encrypted for (recipientPublicKey):', messageRecipientKey.substring(0, 32) + '...');
            console.log('   Our public key (from VC):', ourPublicKeyBase64.substring(0, 32) + '...');

            if (messageRecipientKey !== ourPublicKeyBase64) {
              console.error('❌ [Chat] KEY MISMATCH! Message was encrypted for a DIFFERENT public key.');
              console.error('   This means the sender has an OLD version of your Security Clearance VC.');
              console.error('   You may have regenerated your encryption keys since the last VC handshake.');
              newDecrypted.set(message.id, '🔒 [KEY MISMATCH - Sender has old VC. Re-exchange VCs needed]');
              hasNewDecryptions = true;
              continue;
            }
            console.log('✅ [Chat] Keys match - decryption should succeed');
          }

          // Select the OTHER party's public key based on message direction
          // SENT (0): Use recipientPublicKey (we encrypted FOR them)
          // RECEIVED (1): Use senderPublicKey (they encrypted FOR us)
          const otherPartyPublicKey = message.direction === 0
            ? encryptedBody.encryptionMeta.recipientPublicKey  // SENT: recipient's key
            : encryptedBody.encryptionMeta.senderPublicKey;     // RECEIVED: sender's key

          console.log('🔑 [Chat] Message direction:', message.direction === 0 ? 'SENT' : 'RECEIVED');
          console.log('🔑 [Chat] Using public key from:', message.direction === 0 ? 'recipient' : 'sender');

          // Transform StandardMessageBody.encryptionMeta to EncryptedMessageBody format
          const encryptedMessageBody = {
            encrypted: true,
            algorithm: encryptedBody.encryptionMeta.algorithm,
            version: '1.0',
            ciphertext: encryptedBody.encryptionMeta.ciphertext,
            nonce: encryptedBody.encryptionMeta.nonce,
            recipientPublicKey: otherPartyPublicKey,  // Use selected key
            senderPublicKey: otherPartyPublicKey       // Both should be the OTHER party's key
          };

          // Decrypt using X25519 keys (direct libsodium, no SDK transformations)
          const decryptedContent = await decryptMessage(
            encryptedMessageBody as any,
            userX25519PrivateKey,
            userX25519PublicKey
          );

          console.log('✅ [Chat] Message decrypted successfully with X25519 keys');

          // Store in cache
          newDecrypted.set(message.id, decryptedContent);
          hasNewDecryptions = true;
        } catch (error: any) {
          console.error('❌ [Chat] Decryption failed:', error);
          // Store error placeholder
          newDecrypted.set(message.id, '🔒 [DECRYPTION FAILED]');
          hasNewDecryptions = true;
        }
      }

      if (hasNewDecryptions) {
        setDecryptedMessages(newDecrypted);
      }
    };

    decryptMessagesAsync();
  }, [messages, app.agent.instance, app.credentials]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  /**
   * Check if a security clearance VC is valid (not revoked/suspended)
   */
  const checkSecurityClearanceValidity = async (clearanceVC: any) => {
    if (!clearanceVC) {
      return { valid: false, reason: 'No security clearance provided' };
    }

    try {
      const status = await verifyCredentialStatus(clearanceVC);

      if (status.revoked) {
        console.error('❌ [SECURITY] Security clearance has been REVOKED');
        return {
          valid: false,
          reason: '⛔ Security clearance has been REVOKED by issuer',
          status
        };
      }

      if (status.suspended) {
        console.warn('⚠️ [SECURITY] Security clearance has been SUSPENDED');
        return {
          valid: false,
          reason: '⚠️ Security clearance has been SUSPENDED by issuer',
          status
        };
      }

      console.log('✅ [SECURITY] Security clearance is VALID');
      return { valid: true, status };
    } catch (error) {
      console.error('❌ [SECURITY] Error checking clearance validity:', error);
      return {
        valid: false,
        reason: 'Error checking security clearance status',
        error
      };
    }
  };

  const handleSendMessage = async () => {
    if (!messageText.trim() || isSending) return;

    const messageContent = messageText;
    setMessageText(''); // Clear input immediately
    setIsSending(true);
    setSendError(null);

    // ✅ SECURITY CHECK: Verify clearance validity before sending encrypted message
    if (selectedSecurityLevel !== SecurityLevel.INTERNAL) {
      // Check if clearance is revoked
      if (clearanceRevoked) {
        setMessageText(messageContent); // Restore message
        setSendError(`Cannot send encrypted message: ${clearanceRevocationReason}`);
        setIsSending(false);
        return;
      }

      // Additional real-time check (in case status changed since last check)
      const validity = await checkSecurityClearanceValidity(userSecurityClearanceVC);
      if (!validity.valid) {
        setMessageText(messageContent); // Restore message
        setSendError(`Cannot send encrypted message: ${validity.reason}`);
        setClearanceRevoked(true);
        setClearanceRevocationReason(validity.reason);
        setIsSending(false);
        return;
      }
    }

    // Add clearance label prefix for classified messages
    let finalMessageContent = messageContent;
    if (selectedSecurityLevel !== SecurityLevel.INTERNAL) {
      const levelName = SECURITY_LEVEL_NAMES[selectedSecurityLevel];
      finalMessageContent = `${levelName} - ${messageContent}`;
    }

    try {
      await onSendMessage(finalMessageContent, otherDID, selectedSecurityLevel);
      // Message sent successfully - reset to unclassified
      setSelectedSecurityLevel(SecurityLevel.INTERNAL);
    } catch (error: any) {
      // On error, restore the message text so user can retry
      setMessageText(messageContent);
      setSendError(error.message || 'Failed to send message. Please try again.');
      console.error('Failed to send message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Parse message body content (handles both plaintext and encrypted)
  const getMessageContent = (message: SDK.Domain.Message): string => {
    try {
      // Check if message was decrypted by handleMessages
      if ((message as any).decrypted === true) {
        return message.body?.toString() || '';
      }

      // Check for decryption errors
      if ((message as any).decryptionError) {
        return getDecryptionErrorMessage((message as any).decryptionError);
      }

      // Parse normal plaintext message
      const body = typeof message.body === 'string'
        ? JSON.parse(message.body)
        : message.body;

      // ✅ NEW: Try to parse body.content to detect StandardMessageBody format
      let messageContent = body.content;
      if (typeof messageContent === 'string') {
        try {
          const parsedContent = JSON.parse(messageContent);
          // Check if it's StandardMessageBody format (has encrypted and timestamp fields)
          if (parsedContent && typeof parsedContent === 'object' &&
              'encrypted' in parsedContent && 'timestamp' in parsedContent) {

            console.log('✅ [Chat] StandardMessageBody detected:', parsedContent);

            // ✅ Check if body indicates encryption (not yet decrypted)
            if (parsedContent.encrypted === true) {
              // Check decrypted cache first
              const decrypted = decryptedMessages.get(message.id);
              if (decrypted) {
                return decrypted; // Return decrypted content from cache
              }
              // Still decrypting
              return '🔓 Decrypting...';
            }

            // Return the actual content from StandardMessageBody
            return parsedContent.content || '';
          }
        } catch (e) {
          // Not JSON, use messageContent as-is
        }
      }

      // Fallback: Check if body itself indicates encryption (legacy format)
      if (body?.encrypted === true) {
        return '🔒 ENCRYPTED MESSAGE - Unable to decrypt';
      }

      return messageContent || body.content || '';
    } catch (e) {
      return message.body?.toString() || '';
    }
  };

  // Get decryption error message for display
  const getDecryptionErrorMessage = (errorCode: string): string => {
    switch (errorCode) {
      case 'NO_CLEARANCE':
        return '🔒 ENCRYPTED - You do not have a Security Clearance credential';
      case 'INSUFFICIENT_CLEARANCE':
        return '🔒 CLASSIFIED - Insufficient Security Clearance';
      case 'KEY_NOT_FOUND':
        return '🔒 ENCRYPTED - Decryption key unavailable (credential may be revoked)';
      case 'DECRYPTION_FAILED':
        return '🔒 ENCRYPTED - Decryption failed';
      case 'SENDER_VC_NOT_FOUND':
        return '🔒 ENCRYPTED - Cannot verify sender\'s credentials';
      case 'VC_INVALID':
        return '🔒 ENCRYPTED - Invalid Security Clearance credential';
      default:
        return '🔒 ENCRYPTED - Unable to decrypt message';
    }
  };

  // Check if message is encrypted
  const isEncryptedMessage = (message: SDK.Domain.Message): boolean => {
    try {
      const body = typeof message.body === 'string'
        ? JSON.parse(message.body)
        : message.body;
      return body?.encrypted === true || (message as any).decryptionError !== undefined;
    } catch (e) {
      return false;
    }
  };

  // Get security level from message
  const getMessageSecurityLevel = (message: SDK.Domain.Message): SecurityLevel => {
    try {
      // Check if level was set during decryption
      if ((message as any).securityLevel !== undefined) {
        return (message as any).securityLevel;
      }

      // Check extraHeaders
      const extraHeaders = (message as any).extraHeaders;
      if (extraHeaders?.securityLevel) {
        return parseSecurityLevel(extraHeaders.securityLevel);
      }

      return SecurityLevel.INTERNAL;
    } catch (e) {
      return SecurityLevel.INTERNAL;
    }
  };

  // Check if user can decrypt the message
  const canDecryptMessage = (message: SDK.Domain.Message): boolean => {
    // If message was successfully decrypted, user can read it
    if ((message as any).decrypted === true) {
      return true;
    }

    // If there's a decryption error, user cannot read it
    if ((message as any).decryptionError) {
      return false;
    }

    // Plaintext messages are always readable
    return true;
  };

  // Format timestamp
  const formatTime = (message: SDK.Domain.Message): string => {
    // ✅ Prefer StandardMessageBody timestamp if available (more accurate for encrypted messages)
    const timestamp = (message as any).standardTimestamp || message.createdTime;

    if (!timestamp) {
      return 'No time';
    }

    // ✅ Convert SDK timestamp (seconds) to milliseconds if needed
    // Threshold: 10 billion (year 2286 in seconds) - any timestamp below this is in seconds
    const timestampMs = typeof timestamp === 'number' && timestamp < 10000000000
      ? timestamp * 1000
      : timestamp;

    const date = new Date(timestampMs);

    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Filter only basic messages for chat display
  const chatMessages = messages.filter(
    msg => msg.piuri === 'https://didcomm.org/basicmessage/2.0/message'
  );

  // Determine if message is from self using DID comparison
  const isOwnMessage = (message: SDK.Domain.Message): boolean => {
    const messageFromDID = message.from?.toString();
    const myDID = connection.host.toString(); // This wallet's DID in the connection


    return messageFromDID === myDID;
  };

  return (
    <div className="flex flex-col h-full max-h-[600px] bg-slate-800/30 rounded-2xl backdrop-blur-sm border border-slate-700/50">
      {/* Chat Header */}
      <div className="bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-white p-4 rounded-t-2xl border-b border-cyan-500/30">
        <h3 className="text-lg font-semibold">
          💬 Chat with {connection.name || 'Unknown Contact'}
        </h3>
        <p className="text-xs text-slate-400 truncate">
          {otherDID.substring(0, 50)}...
        </p>
      </div>

      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-900/30">
        {chatMessages.length === 0 ? (
          <div className="text-center text-slate-400 py-8">
            <p>No messages yet. Start a conversation!</p>
          </div>
        ) : (
          chatMessages.map((message) => {
            const isOwn = isOwnMessage(message);
            const content = getMessageContent(message);
            const time = formatTime(message);
            const isEncrypted = isEncryptedMessage(message);
            const securityLevel = getMessageSecurityLevel(message);
            const canDecrypt = canDecryptMessage(message);
            const hasDecryptionError = (message as any).decryptionError !== undefined;

            return (
              <div
                key={message.id}
                className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-2 rounded-xl ${
                    isOwn
                      ? 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white'
                      : 'bg-slate-800/50 text-white border border-slate-700/50'
                  }`}
                >
                  {/* Security Level Badge (for encrypted messages) */}
                  {isEncrypted && securityLevel !== SecurityLevel.INTERNAL && (
                    <div className="mb-2">
                      <EncryptedMessageBadge level={securityLevel} canDecrypt={canDecrypt} />
                    </div>
                  )}

                  {/* Message Content */}
                  <p
                    className={`text-sm break-words ${
                      hasDecryptionError ? 'italic text-gray-400' : ''
                    }`}
                  >
                    {content}
                  </p>

                  {/* Timestamp */}
                  <div
                    className={`text-xs mt-1 ${
                      isOwn ? 'text-white/70' : 'text-slate-400'
                    }`}
                  >
                    {time}
                    {isOwn && (
                      <span className="ml-2">
                        {/* Add status indicators here if needed */}
                        ✓✓
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error Message */}
      {sendError && (
        <div className="px-4 py-2 bg-red-500/20 text-red-300 text-sm border-t border-red-500/30">
          {sendError}
        </div>
      )}

      {/* Message Input */}
      <div className="border-t border-slate-700/50 p-4">
        {/* Security Clearance Revocation Warning */}
        {clearanceRevoked && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/30 rounded-xl">
            <div className="flex items-center">
              <span className="text-red-300 text-sm font-medium">
                {clearanceRevocationReason}
              </span>
            </div>
            <p className="mt-1 text-sm text-red-400">
              Encrypted messaging is disabled. Only public messages can be sent.
            </p>
          </div>
        )}

        {/* Security Level Selector */}
        <SecurityLevelSelector
          selectedLevel={selectedSecurityLevel}
          userMaxLevel={userMaxLevel}
          onChange={setSelectedSecurityLevel}
          disabled={isSending || clearanceRevoked}
        />

        {/* Message Input and Send Button */}
        <div className="flex space-x-2">
          <input
            type="text"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type a message..."
            disabled={isSending}
            className="flex-1 px-4 py-2 border border-slate-700/50 rounded-xl
                     bg-slate-800/50 text-white placeholder-slate-500
                     focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50
                     disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSendMessage}
            disabled={!messageText.trim() || isSending}
            className="px-6 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600
                     disabled:from-slate-600 disabled:to-slate-600
                     text-white rounded-xl transition-all duration-200
                     disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          >
            {isSending ? (
              <span className="flex items-center">
                <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sending...
              </span>
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};