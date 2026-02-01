import React, { useState, useEffect } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useMountedApp } from '@/reducers/store';
import { refreshConnections, initiatePresentationRequest } from '@/actions';
import { v4 as uuid } from 'uuid';
import { messageRejection } from '@/utils/rejectionManager';
import { connectionRequestQueue } from '@/utils/connectionRequestQueue';
import { invitationStateManager } from '@/utils/InvitationStateManager';
import { verifyCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';
import { getItem, setItem, removeItem, getKeysByPattern } from '@/utils/prefixedStorage';

interface ConnectionRequestProps {
  message: SDK.Domain.Message;
  attachedCredential?: any;  // ✅ NEW: Pre-extracted credential from persistent queue
  onRequestHandled?: () => void;
}

export const ConnectionRequest: React.FC<ConnectionRequestProps> = ({
  message,
  attachedCredential: attachedCredentialProp,  // ✅ NEW: Pre-extracted credential from persistent queue
  onRequestHandled
}) => {
  const app = useMountedApp();
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasHandled, setHasHandled] = useState(false);
  const [showVCRequestDialog, setShowVCRequestDialog] = useState(false);
  const [vcRequestType, setVcRequestType] = useState<'RealPerson' | 'SecurityClearance'>('RealPerson');

  // Credential presentation detection and verification
  const [attachedCredential, setAttachedCredential] = useState<any>(null);
  const [verificationStatus, setVerificationStatus] = useState<'pending' | 'verifying' | 'verified' | 'invalid'>('pending');
  const [verificationResult, setVerificationResult] = useState<any>(null);
  const [showCredentialDetails, setShowCredentialDetails] = useState(false);

  // Identity extraction from credential
  const [senderIdentity, setSenderIdentity] = useState<any>(null);

  // Rejection state
  const [isRejecting, setIsRejecting] = useState(false);
  const [showRejectConfirmation, setShowRejectConfirmation] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');


  // Parse the connection request body
  const getRequestDetails = () => {
    try {
      const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
      return {
        label: body.label || 'Unknown'
      };
    } catch (e) {
      return {
        label: 'Unknown'
      };
    }
  };

  const requestDetails = getRequestDetails();

  // Extract human-readable identity from credential
  const extractIdentityFromCredential = (credential: any) => {
    try {
      console.log('👤 [IDENTITY EXTRACTION] Extracting identity from credential...');

      // Get credential subject data
      let credentialSubject = null;
      if (credential.credentialSubject) {
        credentialSubject = credential.credentialSubject;
      } else if (credential.vc && credential.vc.credentialSubject) {
        credentialSubject = credential.vc.credentialSubject;
      } else if (credential.claims && Array.isArray(credential.claims) && credential.claims.length > 0) {
        // Handle claims array structure
        const firstClaim = credential.claims[0];
        credentialSubject = firstClaim.credentialData || firstClaim.credential || firstClaim;
        if (credentialSubject && credentialSubject.credentialSubject) {
          credentialSubject = credentialSubject.credentialSubject;
        }
      }

      if (!credentialSubject) {
        console.warn('⚠️ [IDENTITY EXTRACTION] No credentialSubject found');
        return null;
      }

      console.log('👤 [IDENTITY EXTRACTION] Found credentialSubject:', credentialSubject);

      // Extract RealPerson identity information
      const identity = {
        firstName: credentialSubject.firstName || '',
        lastName: credentialSubject.lastName || '',
        fullName: '',
        uniqueId: credentialSubject.uniqueId || '',
        dateOfBirth: credentialSubject.dateOfBirth || '',
        gender: credentialSubject.gender || '',
        hasIdentity: false
      };

      // Build full name
      if (identity.firstName && identity.lastName) {
        identity.fullName = `${identity.firstName} ${identity.lastName}`;
        identity.hasIdentity = true;
      } else if (identity.firstName) {
        identity.fullName = identity.firstName;
        identity.hasIdentity = true;
      } else if (identity.lastName) {
        identity.fullName = identity.lastName;
        identity.hasIdentity = true;
      }

      console.log('✅ [IDENTITY EXTRACTION] Extracted identity:', identity);
      return identity;

    } catch (error) {
      console.error('❌ [IDENTITY EXTRACTION] Error extracting identity:', error);
      return null;
    }
  };

  // Search for related presentation messages using RFC 0434 thread correlation
  const findRelatedPresentationMessage = async () => {
    try {
      if (!app.db.instance) {
        console.warn('⚠️ [MESSAGE CORRELATION] Database not available for message search');
        return null;
      }

      // First, try to find the invitation ID that this connection request relates to
      const senderDID = message.from?.toString();
      let invitationId = null;

      // Check localStorage for stored invitation metadata matching this sender
      if (typeof window !== 'undefined') {
        console.log('🔍 [THREAD CORRELATION] Searching for invitation metadata...');

        // Look through all stored invitations to find one that matches this connection
        const invitationKeys = getKeysByPattern('invitation-');
        for (const key of invitationKeys) {
          try {
            const invitationData = JSON.parse(getItem(key) || '{}');
            console.log(`🔍 [THREAD CORRELATION] Checking invitation: ${key}`, {
              from: invitationData.from?.substring(0, 50) + '...',
              hasVCRequest: invitationData.includeVCRequest
            });

            // For now, use the most recent invitation with VC request
            // In production, you'd implement more sophisticated matching
            if (invitationData.includeVCRequest) {
              invitationId = invitationData.id;
              console.log('🎯 [THREAD CORRELATION] Found potential invitation ID:', invitationId);
              break;
            }
          } catch (e) {
            console.warn('⚠️ [THREAD CORRELATION] Could not parse invitation data for key:', key);
          }
        }
      }

      if (!invitationId) {
        console.log('ℹ️ [THREAD CORRELATION] No invitation ID found for thread correlation');
        // Fallback to old DID-based correlation temporarily
        return await findPresentationMessageByDID();
      }

      console.log('🔍 [THREAD CORRELATION] Searching for presentation messages with invitation thread ID:', invitationId);

      // Get all messages from database
      const allMessages = await app.db.instance.getAllMessages();
      console.log('📊 [THREAD CORRELATION] Total messages in database:', allMessages.length);

      // Find presentation messages that reference this invitation ID in their thread
      const presentationMessages = allMessages.filter(msg => {
        const isPresentationMessage = msg.piuri && (
          msg.piuri.includes('present-proof') ||
          msg.piuri.includes('presentation')
        );

        // Check if message has thread information linking to our invitation
        let hasMatchingThread = false;
        try {
          if (msg.body && typeof msg.body === 'string') {
            const messageBody = JSON.parse(msg.body);
            // Check for parent thread ID matching our invitation ID
            hasMatchingThread = messageBody.pthid === invitationId ||
                              messageBody.thid === invitationId ||
                              messageBody['~thread']?.pthid === invitationId;
          }
        } catch (e) {
          // Message body is not JSON, check the message ID or other fields
          hasMatchingThread = msg.id?.includes(invitationId) || false;
        }

        console.log(`🔍 [THREAD CORRELATION] Checking message ${msg.id}:`);
        console.log(`    PIURI: ${msg.piuri}`);
        console.log(`    Is presentation: ${isPresentationMessage}`);
        console.log(`    Has matching thread: ${hasMatchingThread}`);

        return isPresentationMessage && hasMatchingThread;
      });

      console.log('🎯 [THREAD CORRELATION] Found thread-correlated presentation messages:', presentationMessages.length);

      if (presentationMessages.length > 0) {
        // Sort by timestamp (most recent first) and take the latest
        const latestPresentation = presentationMessages.sort((a, b) => {
          const aTime = a.createdTime || 0;
          const bTime = b.createdTime || 0;
          return bTime - aTime;
        })[0];

        console.log('✅ [THREAD CORRELATION] Using latest thread-correlated presentation message:', {
          id: latestPresentation.id,
          piuri: latestPresentation.piuri,
          timestamp: latestPresentation.createdTime
        });

        return latestPresentation;
      }

      console.log('ℹ️ [THREAD CORRELATION] No thread-correlated presentation messages found');
      return null;

    } catch (error) {
      console.error('❌ [THREAD CORRELATION] Error searching for presentation messages:', error);
      return null;
    }
  };

  // Fallback function for DID-based correlation (legacy support)
  const findPresentationMessageByDID = async () => {
    try {
      const senderDID = message.from?.toString();
      if (!senderDID) return null;

      const allMessages = await app.db.instance.getAllMessages();

      const presentationMessages = allMessages.filter(msg => {
        const msgFromDID = msg.from?.toString();
        const isPresentationMessage = msg.piuri && (
          msg.piuri.includes('present-proof') ||
          msg.piuri.includes('presentation')
        );
        return msgFromDID === senderDID && isPresentationMessage;
      });

      if (presentationMessages.length > 0) {
        return presentationMessages.sort((a, b) => {
          const aTime = a.createdTime || 0;
          const bTime = b.createdTime || 0;
          return bTime - aTime;
        })[0];
      }

      return null;
    } catch (error) {
      console.error('❌ [DID CORRELATION] Error in fallback correlation:', error);
      return null;
    }
  };

  // ✅ TASK 4: Enhanced credential extraction with support for Bob's AttachmentDescriptor format
  const extractAttachedCredential = () => {
    try {
      console.log('🔍 [CREDENTIAL EXTRACTION] Checking message for attached credentials...');
      console.log('🔍 [CREDENTIAL EXTRACTION] Message attachments:', message.attachments);
      console.log('🔍 [CREDENTIAL EXTRACTION] Message body:', message.body);

      // Check for attachments in the message
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          console.log('📎 [CREDENTIAL EXTRACTION] Processing attachment:', attachment);
          console.log('📎 [CREDENTIAL EXTRACTION] Attachment ID:', attachment.id);

          // ✅ TASK 4: Priority check for "vc-proof-response" from Bob
          if (attachment.id === 'vc-proof-response') {
            console.log('✅ [CREDENTIAL EXTRACTION] Found vc-proof-response attachment from Bob!');

            // ✅ TASK 4: Handle SDK AttachmentDescriptor format (data as base64 string)
            if (attachment.data) {
              try {
                // AttachmentDescriptor stores data as base64 string directly (not in data.base64)
                const base64Data = attachment.data.toString();
                const decodedData = atob(base64Data);
                console.log('🔓 [CREDENTIAL EXTRACTION] Decoded vc-proof-response:', decodedData.substring(0, 100) + '...');

                const parsedData = JSON.parse(decodedData);
                console.log('✅ [CREDENTIAL EXTRACTION] Parsed credential from Bob:', parsedData);

                // Validate it's a credential
                if (parsedData.type || parsedData.credentialType || parsedData.credentialSubject) {
                  console.log('💳 [CREDENTIAL EXTRACTION] Valid credential structure confirmed');
                  return parsedData;
                } else {
                  console.warn('⚠️ [CREDENTIAL EXTRACTION] Data does not have credential structure');
                }
              } catch (bobError) {
                console.error('❌ [CREDENTIAL EXTRACTION] Failed to extract Bob\'s credential:', bobError);
              }
            }
          }

          // ✅ TASK 4: Legacy format support (data.base64)
          if (attachment.data && attachment.data.base64) {
            try {
              const decodedData = atob(attachment.data.base64);
              const parsedData = JSON.parse(decodedData);
              console.log('✅ [CREDENTIAL EXTRACTION] Decoded attachment data:', parsedData);

              // Check if this contains a credential presentation
              if (parsedData.verifiableCredential || parsedData.credentials || parsedData.credential) {
                console.log('💳 [CREDENTIAL EXTRACTION] Found credential presentation in attachment');
                return parsedData;
              }

              // ✅ TASK 4: Check if decoded data IS the credential directly
              if (parsedData.type || parsedData.credentialType || parsedData.credentialSubject) {
                console.log('💳 [CREDENTIAL EXTRACTION] Decoded data is directly a credential');
                return parsedData;
              }

              // Check for nested presentation data
              if (parsedData.presentation && parsedData.presentation.verifiableCredential) {
                console.log('💳 [CREDENTIAL EXTRACTION] Found nested credential presentation');
                return parsedData.presentation;
              }
            } catch (decodeError) {
              console.warn('⚠️ [CREDENTIAL EXTRACTION] Failed to decode attachment:', decodeError);
            }
          }

          // ✅ TASK 4: data.json format support
          if (attachment.data && attachment.data.json) {
            console.log('💳 [CREDENTIAL EXTRACTION] Found JSON attachment data:', attachment.data.json);
            const jsonData = attachment.data.json;

            // Check if this contains a credential presentation
            if (jsonData.verifiableCredential || jsonData.credentials || jsonData.credential) {
              console.log('💳 [CREDENTIAL EXTRACTION] Found credential presentation in JSON');
              return jsonData;
            }

            // ✅ TASK 4: Check if JSON data IS the credential directly
            if (jsonData.type || jsonData.credentialType || jsonData.credentialSubject) {
              console.log('💳 [CREDENTIAL EXTRACTION] JSON data is directly a credential');
              return jsonData;
            }
          }
        }
      }

      // ✅ NEW: Check message body for requests_attach field (Bob's new pattern)
      try {
        let messageBody;
        if (typeof message.body === 'string') {
          messageBody = JSON.parse(message.body);
        } else if (typeof message.body === 'object' && message.body !== null) {
          messageBody = message.body;
        }

        if (messageBody && messageBody.requests_attach && messageBody.requests_attach.length > 0) {
          console.log('✅ [CREDENTIAL EXTRACTION] Found requests_attach in message body!');

          for (const attachment of messageBody.requests_attach) {
            if (attachment["@id"] === "vc-proof-response") {
              console.log('✅ [CREDENTIAL EXTRACTION] Found vc-proof-response in requests_attach!');

              if (attachment.data && attachment.data.json) {
                let credentialData = attachment.data.json;
                console.log('✅ [CREDENTIAL EXTRACTION] Extracted credential from data.json field');

                // ✅ FALLBACK: Unwrap SDK.Domain.Credential wrapper if present
                if (credentialData.credentialType === 'prism/jwt' &&
                    credentialData.recoveryId === 'jwt+credential' &&
                    !credentialData.credentialSubject) {
                  console.log('🔧 [CREDENTIAL EXTRACTION] Detected SDK wrapper, attempting to unwrap...');

                  // Try multiple extraction methods
                  if (typeof credentialData.verifiableCredential === 'function') {
                    credentialData = credentialData.verifiableCredential();
                    console.log('✅ [CREDENTIAL EXTRACTION] Unwrapped using verifiableCredential() method');
                  } else if (credentialData.vc) {
                    credentialData = credentialData.vc;
                    console.log('✅ [CREDENTIAL EXTRACTION] Unwrapped using .vc property');
                  } else if (credentialData.properties) {
                    credentialData = credentialData.properties;
                    console.log('✅ [CREDENTIAL EXTRACTION] Unwrapped from .properties');
                  } else {
                    console.warn('⚠️ [CREDENTIAL EXTRACTION] SDK wrapper detected but unable to unwrap');
                  }
                }

                if (credentialData.type || credentialData.credentialType || credentialData.credentialSubject) {
                  console.log('💳 [CREDENTIAL EXTRACTION] Valid credential found in message body!');
                  return credentialData;
                }
              }
            }
          }
        }
      } catch (bodyExtractError) {
        console.warn('⚠️ [CREDENTIAL EXTRACTION] Failed to extract from message body:', bodyExtractError);
      }

      // Check message body for embedded credentials (legacy)
      const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
      if (body && body.attachments) {
        console.log('🔍 [CREDENTIAL EXTRACTION] Checking body attachments:', body.attachments);
        for (const attachment of body.attachments) {
          if (attachment.data && attachment.data.base64) {
            try {
              const decodedData = atob(attachment.data.base64);
              const parsedData = JSON.parse(decodedData);

              if (parsedData.verifiableCredential || parsedData.credentials || parsedData.credential) {
                console.log('💳 [CREDENTIAL EXTRACTION] Found credential in body attachment');
                return parsedData;
              }
            } catch (decodeError) {
              console.warn('⚠️ [CREDENTIAL EXTRACTION] Failed to decode body attachment:', decodeError);
            }
          }
        }
      }

      console.log('ℹ️ [CREDENTIAL EXTRACTION] No credential presentations found in message');
      return null;
    } catch (error) {
      console.error('❌ [CREDENTIAL EXTRACTION] Error extracting credentials:', error);
      return null;
    }
  };

  // Extract credential from presentation message
  const extractCredentialFromPresentation = (presentationMessage: SDK.Domain.Message) => {
    try {
      console.log('🎯 [PRESENTATION EXTRACTION] Extracting credential from presentation message');
      console.log('🎯 [PRESENTATION EXTRACTION] Message body type:', typeof presentationMessage.body);

      const body = typeof presentationMessage.body === 'string'
        ? JSON.parse(presentationMessage.body)
        : presentationMessage.body;

      console.log('🎯 [PRESENTATION EXTRACTION] Parsed body:', body);

      // Look for credential in various possible locations
      let credential = null;

      // Check for credentials in body
      if (body.credentials && Array.isArray(body.credentials) && body.credentials.length > 0) {
        credential = body.credentials[0];
        console.log('✅ [PRESENTATION EXTRACTION] Found credential in body.credentials');
      } else if (body.credential) {
        credential = body.credential;
        console.log('✅ [PRESENTATION EXTRACTION] Found credential in body.credential');
      } else if (body.verifiableCredential) {
        credential = Array.isArray(body.verifiableCredential)
          ? body.verifiableCredential[0]
          : body.verifiableCredential;
        console.log('✅ [PRESENTATION EXTRACTION] Found credential in body.verifiableCredential');
      }

      // Check for base64 encoded credential data
      if (!credential && body.format === 'prism/jwt' && body.data) {
        try {
          if (typeof body.data === 'string') {
            // JWT format - try to decode
            const parts = body.data.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1]));
              console.log('✅ [PRESENTATION EXTRACTION] Decoded JWT payload:', payload);
              credential = payload.vc || payload;
            }
          }
        } catch (jwtError) {
          console.warn('⚠️ [PRESENTATION EXTRACTION] Failed to decode JWT:', jwtError);
        }
      }

      if (credential) {
        console.log('🎯 [PRESENTATION EXTRACTION] Successfully extracted credential:', credential);
        return credential;
      } else {
        console.log('ℹ️ [PRESENTATION EXTRACTION] No credential found in presentation message');
        return null;
      }

    } catch (error) {
      console.error('❌ [PRESENTATION EXTRACTION] Error extracting credential from presentation:', error);
      return null;
    }
  };

  // Verify attached credential
  const verifyAttachedCredential = async (credential: any) => {
    if (!app.agent.instance) {
      console.warn('⚠️ [CREDENTIAL VERIFICATION] Agent not available for verification');
      return;
    }

    setVerificationStatus('verifying');

    try {
      console.log('🔐 [CREDENTIAL VERIFICATION] Starting verification for:', credential);

      // Extract the actual credential from various possible structures
      let actualCredential = credential;
      if (credential.verifiableCredential) {
        actualCredential = Array.isArray(credential.verifiableCredential)
          ? credential.verifiableCredential[0]
          : credential.verifiableCredential;
      } else if (credential.credentials) {
        actualCredential = Array.isArray(credential.credentials)
          ? credential.credentials[0]
          : credential.credentials;
      } else if (credential.credential) {
        actualCredential = credential.credential;
      }

      console.log('🔐 [CREDENTIAL VERIFICATION] Extracted credential for verification:', actualCredential);

      // Basic validation - check for required credential fields
      const hasValidStructure = actualCredential &&
        (actualCredential.credentialSubject || actualCredential.vc?.credentialSubject);

      if (!hasValidStructure) {
        throw new Error('Invalid credential structure - missing credentialSubject');
      }

      // Extract credential data for display
      const credentialSubject = actualCredential.credentialSubject || actualCredential.vc?.credentialSubject;
      const issuer = actualCredential.issuer || actualCredential.vc?.issuer;
      const type = actualCredential.type || actualCredential.vc?.type || ['VerifiableCredential'];

      // NEW: Check revocation status
      console.log('🔍 [REVOCATION CHECK] Verifying credential revocation status...');
      const revocationStatus: CredentialStatus = await verifyCredentialStatus(actualCredential);

      console.log('📊 [REVOCATION CHECK] Status:', revocationStatus);

      // Flag if credential is revoked or suspended
      const isRevoked = revocationStatus.revoked;
      const isSuspended = revocationStatus.suspended;

      if (isRevoked) {
        console.error('❌ [REVOCATION CHECK] Credential has been REVOKED by issuer!');
      } else if (isSuspended) {
        console.warn('⚠️ [REVOCATION CHECK] Credential has been SUSPENDED by issuer!');
      } else {
        console.log('✅ [REVOCATION CHECK] Credential is VALID');
      }

      const result = {
        isValid: !isRevoked && !isSuspended, // Mark as invalid if revoked/suspended
        credentialSubject,
        issuer,
        type,
        issuanceDate: actualCredential.issuanceDate || actualCredential.vc?.issuanceDate,
        expirationDate: actualCredential.expirationDate || actualCredential.vc?.expirationDate,
        revocationStatus, // Add revocation status to result
        errors: isRevoked ? ['⛔ This credential has been REVOKED by the issuer'] :
                isSuspended ? ['⚠️ This credential has been SUSPENDED by the issuer'] : []
      };

      console.log('✅ [CREDENTIAL VERIFICATION] Verification completed:', result);
      setVerificationResult(result);
      setVerificationStatus(isRevoked || isSuspended ? 'invalid' : 'verified');

    } catch (error) {
      console.error('❌ [CREDENTIAL VERIFICATION] Verification failed:', error);
      setVerificationResult({
        isValid: false,
        errors: [error.message || 'Verification failed'],
        credentialSubject: null,
        issuer: null,
        type: null
      });
      setVerificationStatus('invalid');
    }
  };

  // Extract credential on component mount
  useEffect(() => {
    const loadCredentialData = async () => {
      console.log('🚀 [CONNECTION REQUEST] Component mounted for message:', message.id);
      console.log('🔍 [CONNECTION REQUEST] Message structure:', {
        id: message.id,
        piuri: message.piuri,
        hasAttachments: !!(message.attachments && message.attachments.length > 0),
        attachmentCount: message.attachments?.length || 0,
        body: typeof message.body === 'string' ? 'string' : 'object',
        from: message.from?.toString().substring(0, 50) + '...'
      });

      // ✅ PRIORITY 1: Use pre-extracted credential from persistent queue
      if (attachedCredentialProp) {
        console.log('💳 [CONNECTION REQUEST] Using pre-extracted credential from queue');
        setAttachedCredential(attachedCredentialProp);
        verifyAttachedCredential(attachedCredentialProp);

        // Extract identity information for display
        const identity = extractIdentityFromCredential(attachedCredentialProp);
        if (identity) {
          setSenderIdentity(identity);
          console.log('👤 [CONNECTION REQUEST] Extracted sender identity:', identity.fullName);
        }

        return;
      }

      // Priority 2: Try to find credential attached directly to connection request
      let credential = extractAttachedCredential();

      if (credential) {
        console.log('💳 [CONNECTION REQUEST] Found attached credential, initiating verification');
        setAttachedCredential(credential);
        verifyAttachedCredential(credential);

        // Extract identity information for display
        const identity = extractIdentityFromCredential(credential);
        if (identity) {
          setSenderIdentity(identity);
          console.log('👤 [CONNECTION REQUEST] Extracted sender identity:', identity.fullName);
        }

        return;
      }

      // If no attached credential, search for related presentation messages
      console.log('🔍 [CONNECTION REQUEST] No attached credential - searching for related presentation messages...');
      const presentationMessage = await findRelatedPresentationMessage();

      if (presentationMessage) {
        console.log('🎯 [CONNECTION REQUEST] Found related presentation message, extracting credential...');
        credential = extractCredentialFromPresentation(presentationMessage);

        if (credential) {
          console.log('✅ [CONNECTION REQUEST] Successfully extracted credential from presentation message');
          setAttachedCredential(credential);
          verifyAttachedCredential(credential);

          // Extract identity information for display
          const identity = extractIdentityFromCredential(credential);
          if (identity) {
            setSenderIdentity(identity);
            console.log('👤 [CONNECTION REQUEST] Extracted sender identity:', identity.fullName);
          }

          return;
        }
      }

      console.log('ℹ️ [CONNECTION REQUEST] No credentials found - showing basic connection request UI');
    };

    loadCredentialData();
  }, [message, attachedCredentialProp]);  // ✅ Add attachedCredentialProp to dependencies

  const handleAcceptRequest = async () => {
    if (!app.agent.instance || isProcessing || hasHandled) return;

    setIsProcessing(true);
    try {
      console.log('🤝 Accepting connection request from:', message.from?.toString());

      // Create Alice's response DID with mediator service endpoints
      const responseDID = await app.agent.instance.createNewPeerDID([], true);
      console.log('✅ Alice response DID created:', responseDID.toString().substring(0, 60) + '...');

      // Create connection response message
      const responseBody = {
        accept: ['didcomm/v2'],
        goal_code: 'connect',
        goal: 'Response to connection request',
        label: requestDetails.label
      };

      // Ensure toDID is a proper DID object
      let toDID: SDK.Domain.DID;
      if (typeof message.from === 'string') {
        toDID = SDK.Domain.DID.fromString(message.from);
      } else if (message.from && typeof message.from === 'object' && 'toString' in message.from) {
        toDID = SDK.Domain.DID.fromString(message.from.toString());
      } else {
        throw new Error('Invalid DID in message.from field');
      }

      const responseMessage = new SDK.Domain.Message(
        JSON.stringify(responseBody),
        uuid(),
        SDK.ProtocolType.DidcommconnectionResponse,
        responseDID,
        toDID,
        [],
        message.id
      );

      console.log('📤 Sending connection response...');
      await app.agent.instance.sendMessage(responseMessage);

      // Create and store the DIDPair connection
      // Use verified identity name if available, otherwise fall back to request label
      const connectionName = (senderIdentity && senderIdentity.hasIdentity && senderIdentity.fullName)
        ? senderIdentity.fullName
        : requestDetails.label;

      console.log(`💾 Storing connection with name: "${connectionName}"`);

      const didPair = new SDK.Domain.DIDPair(
        responseDID,  // Alice's DID (host)
        toDID,        // Bob's ephemeral DID (receiver)
        connectionName  // Use verified identity name or request label
      );

      // 🔧 FIX: Check if connection already exists before storing (prevent duplicates)
      const existingConnections = await app.agent.instance.pluto.getAllDidPairs();
      const connectionExists = existingConnections.some((conn) => {
        return conn.host.toString() === responseDID.toString() &&
               conn.receiver.toString() === toDID.toString();
      });

      if (connectionExists) {
        console.log('ℹ️ [ConnectionRequest] Connection already exists, skipping storage');
        console.log('   Host DID:', responseDID.toString());
        console.log('   Receiver DID:', toDID.toString());
      } else {
        console.log('💾 Storing connection using connectionManager...');
        await app.agent.instance.connectionManager.addConnection(didPair);
        console.log('✅ Connection stored successfully');
      }

      // ✅ PHASE 4: Update invitation state when Alice accepts Bob's connection request
      try {
        const walletId = app.wallet.walletId;

        // Find the invitation ID that corresponds to this connection request
        // Search through localStorage for invitations matching this sender
        let invitationId = null;
        const senderDID = message.from?.toString();

        if (typeof window !== 'undefined' && senderDID) {
          console.log('🔍 [INVITATION STATE] Searching for invitation matching sender DID:', senderDID.substring(0, 50) + '...');

          // Look through all stored invitations
          const invitationKeys = getKeysByPattern('invitation-');
          for (const key of invitationKeys) {
            try {
              const invitationData = JSON.parse(getItem(key) || '{}');

              // For now, use the most recent invitation
              // In production, you'd implement more sophisticated matching based on DID correlation
              if (invitationData.id) {
                invitationId = invitationData.id;
                console.log('🎯 [INVITATION STATE] Found invitation ID:', invitationId);
                break; // Use the first (most recent) invitation for now
              }
            } catch (e) {
              console.warn('⚠️ [INVITATION STATE] Could not parse invitation data for key:', key);
            }
          }
        }

        if (invitationId) {
          const success = await invitationStateManager.acceptConnection(
            walletId,
            invitationId,
            message.id // Use message ID as request ID
          );

          if (success) {
            console.log('✅ [INVITATION STATE] Marked invitation as Connected:', invitationId);
          } else {
            console.warn('⚠️ [INVITATION STATE] Could not update invitation state (invitation may not exist)');
          }
        } else {
          console.log('ℹ️ [INVITATION STATE] No invitation ID found for connection request');
        }
      } catch (stateError) {
        console.error('❌ [INVITATION STATE] Failed to update invitation state:', stateError);
        // Don't throw - connection should still proceed
      }

      // Refresh connections state
      await app.dispatch(refreshConnections());

      setHasHandled(true);
      onRequestHandled?.();

    } catch (error) {
      console.error('❌ Failed to accept connection request:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRejectRequest = async () => {
    if (!app.agent?.instance || isRejecting || hasHandled) return;

    setIsRejecting(true);
    try {
      console.log('🚫 [CONNECTION REQUEST] Rejecting connection request:', message.id);
      console.log('🚫 [CONNECTION REQUEST] From DID:', message.from?.toString());
      console.log('🚫 [CONNECTION REQUEST] Rejection reason:', rejectionReason || 'No reason provided');

      const walletId = app.wallet.walletId;

      // 1. Mark message as rejected in rejection manager
      await messageRejection.rejectMessage(
        walletId,
        message,
        rejectionReason || 'Connection request rejected by user',
        30 // Expire rejection after 30 days
      );

      // 2. Update persistent connection request queue if applicable
      try {
        // Check if this message exists in the persistent queue
        const persistentRequests = await connectionRequestQueue.getPendingRequests(walletId);
        const existingRequest = persistentRequests.find(req => req.message.id === message.id);

        if (existingRequest) {
          await connectionRequestQueue.handleRequest(
            walletId,
            existingRequest.id,
            'rejected',
            {
              reason: rejectionReason || 'Connection request rejected by user',
              rejectedAt: Date.now()
            }
          );
          console.log('✅ [CONNECTION REQUEST] Updated persistent queue with rejection');
        }
      } catch (queueError) {
        console.warn('⚠️ [CONNECTION REQUEST] Failed to update persistent queue:', queueError);
        // Continue with rejection even if queue update fails
      }

      // 3. Delete message from IndexedDB to prevent re-appearance
      if (app.db.instance) {
        try {
          await app.db.instance.deleteMessage(message.id);
          console.log('✅ [CONNECTION REQUEST] Deleted message from IndexedDB:', message.id);
        } catch (deleteError) {
          console.warn('⚠️ [CONNECTION REQUEST] Failed to delete message from IndexedDB:', deleteError);
          // Continue even if deletion fails - rejection tracking will prevent re-showing
        }
      }

      // ✅ PHASE 4: Update invitation state when Alice rejects Bob's connection request
      try {
        // Find the invitation ID that corresponds to this connection request
        let invitationId = null;
        const senderDID = message.from?.toString();

        if (typeof window !== 'undefined' && senderDID) {
          console.log('🔍 [INVITATION STATE] Searching for invitation to reject, sender DID:', senderDID.substring(0, 50) + '...');

          // Look through all stored invitations
          const invitationKeys = getKeysByPattern('invitation-');
          for (const key of invitationKeys) {
            try {
              const invitationData = JSON.parse(getItem(key) || '{}');

              // For now, use the most recent invitation
              // In production, you'd implement more sophisticated matching based on DID correlation
              if (invitationData.id) {
                invitationId = invitationData.id;
                console.log('🎯 [INVITATION STATE] Found invitation ID to reject:', invitationId);
                break; // Use the first (most recent) invitation for now
              }
            } catch (e) {
              console.warn('⚠️ [INVITATION STATE] Could not parse invitation data for key:', key);
            }
          }
        }

        if (invitationId) {
          const success = await invitationStateManager.rejectConnection(
            walletId,
            invitationId,
            message.id // Use message ID as request ID
          );

          if (success) {
            console.log('✅ [INVITATION STATE] Marked invitation as Rejected:', invitationId);
          } else {
            console.warn('⚠️ [INVITATION STATE] Could not update invitation state (invitation may not exist)');
          }
        } else {
          console.log('ℹ️ [INVITATION STATE] No invitation ID found for rejected connection request');
        }
      } catch (stateError) {
        console.error('❌ [INVITATION STATE] Failed to update invitation state on rejection:', stateError);
        // Don't throw - rejection should still proceed
      }

      // 4. Update UI state
      setHasHandled(true);
      setShowRejectConfirmation(false);

      // 5. Notify parent component
      if (onRequestHandled) {
        await onRequestHandled();
      }

      console.log('✅ [CONNECTION REQUEST] Connection request rejection completed successfully');

    } catch (error) {
      console.error('❌ [CONNECTION REQUEST] Failed to reject connection request:', error);

      // Show user-friendly error message
      alert('Failed to reject connection request. Please try again.');
    } finally {
      setIsRejecting(false);
    }
  };

  const confirmRejectRequest = () => {
    setShowRejectConfirmation(true);
  };

  const cancelRejectRequest = () => {
    setShowRejectConfirmation(false);
    setRejectionReason('');
  };

  const handleVCRequest = async () => {
    if (!app.agent.instance || !message.from) return;

    try {
      setIsProcessing(true);

      // Find the correct connection DID to send VC request to
      // Don't use message.from (connection request DID), use the actual connection DID
      console.log('🔍 [VC REQUEST] Finding correct target DID...');
      console.log('🔍 [VC REQUEST] Message from DID:', message.from.toString());
      console.log('🔍 [VC REQUEST] Available connections:', app.connections.length);

      // Debug: Log all available connections
      app.connections.forEach((conn, idx) => {
        console.log(`🔍 [VC REQUEST] Connection ${idx + 1}:`, {
          name: conn.name,
          host: conn.host.toString().substring(0, 60) + '...',
          receiver: conn.receiver.toString().substring(0, 60) + '...'
        });
      });

      // Find matching connection based on the connection request sender
      let targetDID = message.from; // fallback to original logic

      if (app.connections && app.connections.length > 0) {
        // Look for a connection where either host or receiver matches the message sender
        const matchingConnection = app.connections.find(conn => {
          const hostMatches = conn.host.toString() === message.from?.toString();
          const receiverMatches = conn.receiver.toString() === message.from?.toString();
          return hostMatches || receiverMatches;
        });

        if (matchingConnection) {
          // Use the receiver DID (the other party's current DID)
          targetDID = matchingConnection.receiver;
          console.log('✅ [VC REQUEST] Found matching connection, using receiver DID:', targetDID.toString().substring(0, 60) + '...');
        } else {
          console.log('⚠️ [VC REQUEST] No matching connection found, using message.from as fallback');
        }
      } else {
        console.log('⚠️ [VC REQUEST] No connections available, using message.from as fallback');
      }

      // Create presentation claims based on VC type
      let presentationClaims;
      let credentialType;

      if (vcRequestType === 'RealPerson') {
        presentationClaims = {
          "uniqueId": {
            type: "string",
            pattern: ".*"
          },
          "firstName": {
            type: "string",
            pattern: ".*"
          },
          "lastName": {
            type: "string",
            pattern: ".*"
          }
        };
        credentialType = SDK.Domain.CredentialType.JWT;
      } else {
        // SecurityClearance VC request
        presentationClaims = {
          "clearanceLevel": {
            type: "string",
            pattern: ".*"
          },
          "clearanceId": {
            type: "string",
            pattern: ".*"
          },
          "publicKeyFingerprint": {
            type: "string",
            pattern: ".*"
          }
        };
        credentialType = SDK.Domain.CredentialType.JWT;
      }

      console.log(`📋 Requesting ${vcRequestType} VC from Bob...`);
      console.log('🔍 [VC REQUEST] Connection details:', {
        messageFromDID: message.from?.toString(),
        resolvedTargetDID: targetDID.toString(),
        messageType: message.piuri,
        messageDirection: message.direction,
        credentialType: credentialType,
        presentationClaims: presentationClaims
      });

      await app.dispatch(initiatePresentationRequest({
        agent: app.agent.instance,
        toDID: targetDID,
        presentationClaims,
        type: credentialType
      }));

      console.log('✅ VC request sent successfully');
      setShowVCRequestDialog(false);

    } catch (error) {
      console.error('❌ Failed to request VC:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatTime = (timestamp?: string | number): string => {
    // If no timestamp at all, use current time as "just received"
    if (timestamp === undefined || timestamp === null) {
      return new Date().toLocaleString();
    }

    let date: Date;

    if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else if (typeof timestamp === 'number') {
      // Handle numeric timestamp - convert seconds to milliseconds if needed
      // Threshold: 10000000000 ms = Nov 20, 2286 (timestamps before this are in seconds)
      const timestampMs = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
      date = new Date(timestampMs);
    } else {
      return new Date().toLocaleString();
    }

    // Check if the date is invalid or shows Unix epoch (1970)
    if (isNaN(date.getTime()) || date.getFullYear() < 1990) {
      return new Date().toLocaleString();
    }

    return date.toLocaleString();
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-4 shadow-lg">
      {/* Header */}
      <div className="flex items-center mb-4">
        <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mr-4">
          <span className="text-2xl">🤝</span>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {senderIdentity && senderIdentity.hasIdentity
              ? `Connection Request from ${senderIdentity.fullName}`
              : 'Connection Request'
            }
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {formatTime(message.createdTime)}
          </p>
        </div>
        <div className="px-3 py-1 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 text-sm rounded-full">
          Pending
        </div>
      </div>

      {/* Request Details */}
      <div className="mb-6 space-y-3">
        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            <strong>From:</strong>
          </p>
          {senderIdentity && senderIdentity.hasIdentity ? (
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <span className="text-lg">👤</span>
                <p className="text-base font-semibold text-gray-900 dark:text-white">
                  {senderIdentity.fullName}
                </p>
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  ✅ Verified Identity
                </span>
              </div>
              {senderIdentity.uniqueId && (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  ID: {senderIdentity.uniqueId}
                </p>
              )}
              <p className="text-xs font-mono text-gray-500 dark:text-gray-500 break-all">
                {message.from?.toString()}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <span className="text-lg">🔗</span>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Unknown Contact
                </p>
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  No Identity Verification
                </span>
              </div>
              <p className="text-xs font-mono text-gray-800 dark:text-gray-200 break-all">
                {message.from?.toString()}
              </p>
            </div>
          )}
        </div>

        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            <strong>Request:</strong>
          </p>
          <p className="text-sm text-gray-800 dark:text-gray-200">
            "{requestDetails.label}" wants to connect with you.
          </p>
          {requestDetails.goal && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              Goal: {requestDetails.goal}
            </p>
          )}
        </div>

        {/* Attached Credential Display */}
        {attachedCredential && (
          <div className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900 dark:to-purple-900 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-2">
                <span className="text-blue-600 dark:text-blue-400 text-lg">💳</span>
                <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                  Attached Credential Presentation
                </h4>
              </div>
              <div className="flex items-center space-x-2">
                {verificationStatus === 'verifying' && (
                  <div className="flex items-center space-x-1 text-yellow-600 dark:text-yellow-400">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="text-xs">Verifying...</span>
                  </div>
                )}
                {verificationStatus === 'verified' && verificationResult?.isValid && (
                  <div className="flex items-center space-x-1 text-green-600 dark:text-green-400">
                    <span className="text-sm">✅</span>
                    <span className="text-xs font-medium">Verified</span>
                  </div>
                )}
                {verificationStatus === 'invalid' && (
                  <div className="flex items-center space-x-1 text-red-600 dark:text-red-400">
                    <span className="text-sm">❌</span>
                    <span className="text-xs font-medium">Invalid</span>
                  </div>
                )}
                <button
                  onClick={() => setShowCredentialDetails(!showCredentialDetails)}
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 text-xs font-medium"
                >
                  {showCredentialDetails ? 'Hide Details' : 'View Details'}
                </button>
              </div>
            </div>

            <p className="text-sm text-blue-700 dark:text-blue-300 mb-3">
              This connection request includes identity verification. Review the credential details below before accepting.
            </p>

            {/* Quick Identity Summary */}
            {verificationResult && verificationResult.isValid && (
              <div className="bg-white dark:bg-gray-800 rounded-lg p-3 mb-3 border border-blue-200 dark:border-blue-600">
                <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Identity Summary:</h5>
                <div className="space-y-1">
                  {verificationResult.credentialSubject && Object.entries(verificationResult.credentialSubject).map(([key, value]) => {
                    if (key === 'id' || !value) return null;
                    return (
                      <div key={key} className="flex justify-between text-xs">
                        <span className="text-gray-600 dark:text-gray-400 capitalize">{key.replace(/([A-Z])/g, ' $1')}:</span>
                        <span className="text-gray-900 dark:text-gray-100 font-medium">{String(value)}</span>
                      </div>
                    );
                  })}
                  {verificationResult.type && (
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400">Credential Type:</span>
                      <span className="text-gray-900 dark:text-gray-100 font-medium">
                        {Array.isArray(verificationResult.type)
                          ? verificationResult.type.filter(t => t !== 'VerifiableCredential').join(', ') || 'Standard'
                          : verificationResult.type
                        }
                      </span>
                    </div>
                  )}
                  {verificationResult.issuer && (
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400">Issued by:</span>
                      <span className="text-gray-900 dark:text-gray-100 font-medium font-mono text-xs">
                        {typeof verificationResult.issuer === 'string'
                          ? verificationResult.issuer.substring(0, 30) + '...'
                          : verificationResult.issuer?.id?.substring(0, 30) + '...' || 'Unknown'
                        }
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Detailed Credential View */}
            {showCredentialDetails && (
              <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-blue-200 dark:border-blue-600">
                <h5 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">Credential Details</h5>

                {verificationResult && !verificationResult.isValid && (
                  <div className="bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-700 rounded-lg p-3 mb-3">
                    <h6 className="text-sm font-semibold text-red-800 dark:text-red-200 mb-2">Verification Errors:</h6>
                    <ul className="text-xs text-red-700 dark:text-red-300 space-y-1">
                      {verificationResult.errors?.map((error, index) => (
                        <li key={index}>• {error}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <h6 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Raw Credential Data:</h6>
                    <pre className="text-xs bg-gray-100 dark:bg-gray-700 p-2 rounded border overflow-x-auto max-h-40">
                      {JSON.stringify(attachedCredential, null, 2)}
                    </pre>
                  </div>

                  {verificationResult && (
                    <div>
                      <h6 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Verification Result:</h6>
                      <pre className="text-xs bg-gray-100 dark:bg-gray-700 p-2 rounded border overflow-x-auto max-h-32">
                        {JSON.stringify(verificationResult, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Verification Actions */}
            {attachedCredential && verificationStatus === 'pending' && (
              <div className="mt-3">
                <button
                  onClick={() => verifyAttachedCredential(attachedCredential)}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:focus:ring-blue-900 transition-colors"
                >
                  🔐 Verify Credential
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      {!hasHandled && (
        <div className="space-y-3">
          {/* Credential Verification Status */}
          {attachedCredential && (
            <div className="flex items-center justify-center p-3 rounded-lg bg-blue-50 dark:bg-blue-900">
              {verificationStatus === 'verifying' && (
                <div className="flex items-center space-x-2 text-blue-600 dark:text-blue-400">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="text-sm font-medium">Verifying credential...</span>
                </div>
              )}
              {verificationStatus === 'verified' && verificationResult?.isValid && (
                <div className="flex items-center space-x-2 text-green-600 dark:text-green-400">
                  <span className="text-lg">✅</span>
                  <span className="text-sm font-medium">Identity verified! Safe to connect.</span>
                </div>
              )}
              {verificationStatus === 'invalid' && (
                <div className="flex items-center space-x-2 text-red-600 dark:text-red-400">
                  <span className="text-lg">⚠️</span>
                  <span className="text-sm font-medium">Credential verification failed. Review carefully.</span>
                </div>
              )}
              {verificationStatus === 'pending' && (
                <div className="flex items-center space-x-2 text-yellow-600 dark:text-yellow-400">
                  <span className="text-lg">📋</span>
                  <span className="text-sm font-medium">Credential attached. Click "Verify Credential" above to review.</span>
                </div>
              )}
            </div>
          )}

          {/* Main Action Buttons */}
          <div className="flex space-x-2">
            <button
              onClick={handleAcceptRequest}
              disabled={isProcessing || (attachedCredential && verificationStatus === 'verifying')}
              className={`flex-1 px-3 py-2 font-semibold rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 text-sm ${
                attachedCredential && verificationResult?.isValid
                  ? 'bg-green-600 hover:bg-green-700 text-white focus:ring-green-500'
                  : attachedCredential && verificationStatus === 'invalid'
                  ? 'bg-yellow-500 hover:bg-yellow-600 text-white focus:ring-yellow-500'
                  : attachedCredential && verificationStatus === 'pending'
                  ? 'bg-gray-400 text-gray-700 cursor-not-allowed'
                  : 'bg-green-500 hover:bg-green-600 text-white focus:ring-green-500'
              } ${isProcessing || (attachedCredential && verificationStatus === 'verifying') ? 'bg-gray-400 text-gray-700' : ''}`}
            >
              {isProcessing ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin h-4 w-4 mr-1" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Accepting...
                </span>
              ) : attachedCredential && verificationResult?.isValid ? (
                '✅ Accept Verified Connection'
              ) : attachedCredential && verificationStatus === 'invalid' ? (
                '⚠️ Accept Despite Issues'
              ) : attachedCredential && verificationStatus === 'pending' ? (
                '🔒 Verify Credential First'
              ) : (
                '🤝 Accept Connection'
              )}
            </button>

            {/* Only show VC Request button if no credential is attached */}
            {!attachedCredential && (
              <button
                onClick={() => setShowVCRequestDialog(true)}
                disabled={isProcessing}
                className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400
                         text-white rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                📋 Request VC
              </button>
            )}

            <button
              onClick={confirmRejectRequest}
              disabled={isProcessing || isRejecting}
              className="flex-1 px-3 py-2 bg-red-500 hover:bg-red-600 disabled:bg-gray-400
                       text-white rounded-lg transition-colors duration-200
                       disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
            >
              {isRejecting ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin h-4 w-4 mr-1" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Rejecting...
                </span>
              ) : (
                '❌ Reject'
              )}
            </button>
          </div>

          {/* Help Text */}
          {attachedCredential && verificationStatus === 'pending' && (
            <p className="text-xs text-gray-600 dark:text-gray-400 text-center">
              💡 This request includes identity verification. Review the credential above before accepting.
            </p>
          )}
        </div>
      )}

      {hasHandled && (
        <div className="bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 p-3 rounded-lg text-center">
          {attachedCredential && verificationResult?.isValid
            ? '✅ Verified connection established successfully'
            : 'Connection request handled'
          }
        </div>
      )}

      {/* Reject Confirmation Dialog */}
      {showRejectConfirmation && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center mb-4">
              <span className="text-red-600 dark:text-red-400 text-2xl mr-3">⚠️</span>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Reject Connection Request
              </h3>
            </div>

            <div className="mb-4">
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                Are you sure you want to reject this connection request from <strong>{requestDetails.label}</strong>?
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                This action will permanently remove the request and prevent it from reappearing.
              </p>

              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Reason for rejection (optional):
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g., 'Not a trusted contact', 'Spam request', etc."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                           bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm
                           focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none"
                  rows={3}
                  maxLength={200}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {rejectionReason.length}/200 characters
                </p>
              </div>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={handleRejectRequest}
                disabled={isRejecting}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400
                         text-white rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500 font-medium"
              >
                {isRejecting ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Rejecting...
                  </span>
                ) : (
                  '❌ Confirm Rejection'
                )}
              </button>
              <button
                onClick={cancelRejectRequest}
                disabled={isRejecting}
                className="flex-1 px-4 py-2 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400
                         text-white rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VC Request Dialog */}
      {showVCRequestDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Request Verifiable Credential
            </h3>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Credential Type:
              </label>
              <select
                value={vcRequestType}
                onChange={(e) => setVcRequestType(e.target.value as 'RealPerson' | 'SecurityClearance')}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                         bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              >
                <option value="RealPerson">RealPerson Credential</option>
                <option value="SecurityClearance">Security Clearance Credential</option>
              </select>
            </div>

            <div className="mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {vcRequestType === 'RealPerson'
                  ? 'This will request the user\'s personal identity information (firstName, lastName, uniqueId).'
                  : 'This will request the user\'s security clearance information (clearanceLevel, clearanceId, publicKeyFingerprint).'
                }
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={handleVCRequest}
                disabled={isProcessing}
                className="flex-1 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400
                         text-white rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {isProcessing ? 'Requesting...' : 'Send Request'}
              </button>
              <button
                onClick={() => setShowVCRequestDialog(false)}
                disabled={isProcessing}
                className="flex-1 px-4 py-2 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400
                         text-white rounded-lg transition-colors duration-200
                         disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};