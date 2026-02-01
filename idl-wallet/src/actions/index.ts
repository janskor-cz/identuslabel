import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";

addRxPlugin(RxDBDevModePlugin);

import { AnyAction, ThunkDispatch, createAsyncThunk } from "@reduxjs/toolkit";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import { sha512 } from '@noble/hashes/sha512'
import { RootState, reduxActions } from "@/reducers/app";
import IndexDB from '@pluto-encrypted/indexdb'
import { PresentationClaims } from "../../../../src/domain";

// Phase 2: Message Encryption Imports
import { SecurityLevel, parseSecurityLevel, SECURITY_LEVEL_NAMES } from '../utils/securityLevels';
import { encryptMessage, decryptMessage } from '../utils/messageEncryption';
import { verifyKeyVCBinding, getVCClearanceLevel, getSecurityKeyByFingerprint, getSecurityKeyByFingerprintAsync, validateSecurityClearanceVC } from '../utils/keyVCBinding';
import { base64url } from 'jose';

// Phase 3: Standard Message Format
import { createEncryptedMessageBody, createPlaintextMessageBody } from '../types/StandardMessageBody';

// Connection metadata for PRISM DID lookup and storage
import { getConnectionMetadata, saveConnectionMetadata } from '../utils/connectionMetadata';

// SecureDashboardBridge agent setter for Pluto fallback
import { setSecureDashboardAgent } from '../utils/SecureDashboardBridge';

// Track pending VC requests to prevent duplicates
const pendingVCRequests: Map<string, Promise<{ vc: any, connectionDID: string }>> = new Map();

// Timestamp helper for human-readable logging
const ts = () => new Date().toISOString().substr(11, 12); // Returns HH:MM:SS.mmm


const Agent = SDK.Agent;
const BasicMessage = SDK.BasicMessage;
const OfferCredential = SDK.OfferCredential;
const ListenerKey = SDK.ListenerKey;
const IssueCredential = SDK.IssueCredential;
const RequestPresentation = SDK.RequestPresentation;


export const acceptPresentationRequest = createAsyncThunk<
    any,
    {
        agent: any, // Changed from SDK.Agent to any for lazy loading
        message: any, // Changed from SDK.Domain.Message to any
        credential: any // Changed from SDK.Domain.Credential to any
    }
>("acceptPresentationRequest", async (options, api) => {
    try {
        const { agent, message, credential } = options;
        const requestPresentation = RequestPresentation.fromMessage(message);
        try {
            const presentation = await agent.createPresentationForRequestProof(requestPresentation, credential);
            await agent.sendMessage(presentation.makeMessage());

            // ✅ Delete the proof request message after successful response
            await agent.pluto.deleteMessage(message.id);

        } catch (err) {
            // Continue silently after error
        }
        return api.fulfillWithValue(null);
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})

export const rejectPresentationRequest = createAsyncThunk<
    any,
    {
        message: SDK.Domain.Message,
        pluto: SDK.Domain.Pluto
    }
>("rejectPresentationRequest", async (options, api) => {
    try {
        const { message, pluto } = options;
        const requestPresentation = RequestPresentation.fromMessage(message);
        await pluto.deleteMessage(message.id)
        return api.fulfillWithValue(requestPresentation);
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})

// ============================================================================
// PRISM DID Management Actions
// Long-form PRISM DIDs for use as holder/subject DIDs in Verifiable Credentials
// ============================================================================

export const createLongFormPrismDID = createAsyncThunk<
    { did: SDK.Domain.DID; privateKey: SDK.Domain.PrivateKey; ed25519Key?: SDK.Domain.PrivateKey; x25519Key?: SDK.Domain.PrivateKey },
    { agent: any; alias?: string; defaultSeed: SDK.Domain.Seed; mediatorUri?: string }
>("createLongFormPrismDID", async (options, api) => {
    const { agent, alias, defaultSeed, mediatorUri } = options;
    api.dispatch(reduxActions.setCreatingPrismDID(true));

    try {
        const apollo = new SDK.Apollo();
        const castor = new SDK.Castor(apollo);

        // Convert wallet seed to hex string (REQUIRED for key derivation)
        const seedHex = Buffer.from(defaultSeed.value).toString("hex");

        // Create SECP256K1 master key (required for PRISM DID)
        const masterKey = apollo.createPrivateKey({
            type: SDK.Domain.KeyTypes.EC,
            curve: SDK.Domain.Curve.SECP256K1,
            seed: seedHex,
        });

        // Create SECP256K1 key for authentication/signing (matches original SDK behavior for credential signing)
        const authKey = apollo.createPrivateKey({
            type: SDK.Domain.KeyTypes.EC,
            curve: SDK.Domain.Curve.SECP256K1,
            seed: seedHex,
        });

        // Create X25519 key for key agreement/encryption (used for Security Clearance encryption)
        const x25519Key = apollo.createPrivateKey({
            type: SDK.Domain.KeyTypes.Curve25519,
            curve: SDK.Domain.Curve.X25519,
            seed: seedHex,
        });

        console.log('[PRISM DID] Created SECP256K1 key for authentication, curve:', authKey.curve);
        console.log('[PRISM DID] Created X25519 key for key agreement, curve:', x25519Key.curve);

        // Build DIDComm service endpoint if mediator available
        const services: SDK.Domain.Service[] = [];
        const mediator = agent.mediationHandler?.mediator;
        if (mediator || mediatorUri) {
            const uri = mediatorUri || 'https://identuslabel.cz/mediator';
            const routingKeys: string[] = [];

            // Add routing DID if available from mediator
            if (mediator?.routingDID) {
                routingKeys.push(mediator.routingDID.toString());
            }

            // ServiceEndpoint constructor: (uri, accept, routingKeys)
            const serviceEndpoint = new SDK.Domain.ServiceEndpoint(
                uri,
                ["didcomm/v2"],
                routingKeys
            );

            // Service constructor: (id, type, serviceEndpoint)
            const didcommService = new SDK.Domain.Service(
                "#didcomm-1",
                ["DIDCommMessaging"],
                serviceEndpoint
            );
            services.push(didcommService);
            console.log('[PRISM DID] Added DIDComm service endpoint:', uri);
            if (routingKeys.length > 0) {
                console.log('[PRISM DID] Routing keys:', routingKeys);
            }
        }

        // Create long-form PRISM DID with master key, SECP256K1 authentication key, and X25519 key agreement key
        // Format: did:prism:[stateHash]:[encodedState]
        // SECP256K1 for authentication matches original SDK behavior - required for credential signing verification
        const prismDID = await castor.createPrismDID(
            masterKey.publicKey(),
            services,  // DIDComm service endpoint pointing to mediator
            [authKey.publicKey()],  // SECP256K1 for authentication (signing) - matches SDK default
            [],  // no issuance keys
            [x25519Key.publicKey()]  // X25519 for key agreement (encryption)
        );

        // Store DID with ALL private keys in Pluto (master + auth + X25519)
        await agent.pluto.storeDID(prismDID, [masterKey, authKey, x25519Key], alias);

        console.log('[PRISM DID] Created long-form DID with SECP256K1 auth + X25519:', prismDID.toString().substring(0, 60) + '...');

        // Refresh the list
        api.dispatch(refreshPrismDIDs({ agent }));

        return api.fulfillWithValue({ did: prismDID, privateKey: masterKey, authKey, x25519Key });
    } catch (err) {
        console.error('[PRISM DID] Failed to create:', err);
        api.dispatch(reduxActions.setCreatingPrismDID(false));
        return api.rejectWithValue(err as Error);
    }
});

export const refreshPrismDIDs = createAsyncThunk<
    { prismDIDs: Array<{ did: string; alias?: string }> },
    { agent: any }
>("refreshPrismDIDs", async (options, api) => {
    const { agent } = options;

    try {
        const prismDIDObjects = await agent.pluto.getAllPrismDIDs();
        // Convert SDK PrismDID objects to serializable objects with alias preserved
        const allPrismDIDs = (prismDIDObjects || []).map((prismDID: any) => {
            // PrismDID has .did property (DID object) and .alias property
            const did = prismDID?.did || prismDID;
            return {
                did: did?.toString?.() || String(did),
                alias: prismDID?.alias  // Preserve alias for filtering
            };
        });

        // Deduplicate by DID string (Pluto may return duplicates when storing with multiple keys)
        const seenDIDs = new Set<string>();
        const prismDIDs = allPrismDIDs.filter((item: { did: string; alias?: string }) => {
            if (seenDIDs.has(item.did)) {
                return false; // Skip duplicate
            }
            seenDIDs.add(item.did);
            return true;
        });

        const duplicatesRemoved = allPrismDIDs.length - prismDIDs.length;
        if (duplicatesRemoved > 0) {
            console.log('[PRISM DID] Removed', duplicatesRemoved, 'duplicate entries');
        }
        console.log('[PRISM DID] Refreshed list, count:', prismDIDs.length, 'with aliases:', prismDIDs.filter((d: { alias?: string }) => d.alias).length);
        api.dispatch(reduxActions.setPrismDIDs(prismDIDs));
        return api.fulfillWithValue({ prismDIDs });
    } catch (err) {
        console.error('[PRISM DID] Failed to refresh:', err);
        return api.rejectWithValue(err as Error);
    }
});

// ============================================================================
// Credential Offer Actions
// ============================================================================

export const rejectCredentialOffer = createAsyncThunk<
    any,
    {
        message: SDK.Domain.Message,
        pluto: SDK.Domain.Pluto
    }
>("rejectCredentialOffer", async (options, api) => {
    try {
        const { message, pluto } = options;
        const credentialOffer = OfferCredential.fromMessage(message);

        // Delete offer message from IndexedDB
        await pluto.deleteMessage(message.id);
        console.log('🗑️ [CREDENTIAL OFFER] Attempting to delete offer message:', message.id);

        // CRITICAL: Verify message was actually deleted from IndexedDB
        const allMessages = await pluto.getAllMessages();
        const stillExists = allMessages.find(m => m.id === message.id);

        if (stillExists) {
            console.error('❌ [CREDENTIAL OFFER] Message deletion FAILED - message still exists in IndexedDB:', message.id);
            throw new Error(`Failed to delete credential offer message from IndexedDB: ${message.id}`);
        }

        console.log('✅ [CREDENTIAL OFFER] Message successfully deleted from IndexedDB:', message.id);
        return api.fulfillWithValue(credentialOffer);
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})

export const acceptCredentialOffer = createAsyncThunk<
    any,
    {
        agent: SDK.Agent,
        message: SDK.Domain.Message,
        selectedDID?: string  // Optional: User-selected existing DID to reuse
    }
>("acceptCredentialOffer", async (options, api) => {
    try {
        const { agent, message, selectedDID } = options;
        const credentialOffer = OfferCredential.fromMessage(message);

        // Extract credential type from offer to use as alias for new PRISM DID
        let alias: string | undefined;
        try {
            const offerAttachment = credentialOffer.attachments?.at(0);
            if (offerAttachment?.payload) {
                const payload = typeof offerAttachment.payload === 'string'
                    ? JSON.parse(offerAttachment.payload)
                    : offerAttachment.payload;
                // Look for type in various locations in the payload
                const vcType = payload?.credential?.type?.[1] || payload?.type?.[1] || payload?.vct;
                if (vcType) {
                    alias = `For ${vcType}`;
                    console.log(`📋 [CREDENTIAL OFFER] Credential type: "${vcType}"`);
                }
            }
        } catch (aliasError) {
            console.log(`📋 [CREDENTIAL OFFER] Could not extract alias from offer:`, aliasError);
        }

        let requestCredential;
        try {
            if (selectedDID) {
                // User chose to reuse an existing DID
                console.log(`🔄 [CREDENTIAL OFFER] Reusing existing DID: ${selectedDID.substring(0, 50)}...`);
                const subjectDID = SDK.Domain.DID.fromString(selectedDID);
                requestCredential = await agent.prepareRequestCredentialWithIssuer(credentialOffer, { subjectDID });
            } else {
                // Create new DID with alias (default behavior)
                console.log(`🆕 [CREDENTIAL OFFER] Creating new DID with alias: "${alias || 'none'}"`);
                requestCredential = await agent.prepareRequestCredentialWithIssuer(credentialOffer, { alias });
            }
        } catch (prepareError) {
            console.error('❌ [ERROR] Failed to prepare credential request:', prepareError);
            console.error('❌ [ERROR] Error type:', prepareError.constructor.name);
            console.error('❌ [ERROR] Error message:', prepareError.message);
            console.error('❌ [ERROR] Error stack:', prepareError.stack);

            throw prepareError; // Re-throw to trigger the outer catch
        }
        try {
            const requestMessage = requestCredential.makeMessage()
            await agent.sendMessage(requestMessage);

            // Delete offer message from IndexedDB
            await agent.pluto.deleteMessage(message.id);
            console.log('🗑️ [CREDENTIAL OFFER] Attempting to delete offer message:', message.id);

            // CRITICAL: Verify message was actually deleted from IndexedDB
            const allMessages = await agent.pluto.getAllMessages();
            const stillExists = allMessages.find(m => m.id === message.id);

            if (stillExists) {
                console.error('❌ [CREDENTIAL OFFER] Message deletion FAILED - message still exists in IndexedDB:', message.id);
                throw new Error(`Failed to delete credential offer message from IndexedDB: ${message.id}`);
            }

            console.log('✅ [CREDENTIAL OFFER] Message successfully deleted from IndexedDB:', message.id);

            // Refresh PRISM DIDs list so newly created DID appears in DID Management page
            api.dispatch(refreshPrismDIDs({ agent }));
            console.log('🔄 [CREDENTIAL OFFER] Refreshed PRISM DIDs list');

        } catch (err) {
            console.error('❌ Failed to send credential request:', err);
            throw err; // Re-throw the error instead of silencing it
        }
        return api.fulfillWithValue(null);
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})


/**
 * Enhanced handleMessages with decryption support
 * Processes incoming messages, decrypting encrypted ones if user has clearance
 */
async function handleMessages(
    options: {
        dispatch: ThunkDispatch<unknown, unknown, AnyAction>,
        agent: SDK.Agent,
        getState: () => any
    },
    newMessages: SDK.Domain.Message[]
) {
    const { agent, dispatch, getState } = options;

    try {
        // 🔍 DEBUG: Log ALL incoming messages
        console.log(`📬 [handleMessages] Processing ${newMessages.length} new message(s)`);
        newMessages.forEach((msg, idx) => {
            console.log(`  Message ${idx + 1}: piuri="${msg.piuri}", id="${msg.id.substring(0, 30)}...", direction="${msg.direction}"`);
        });

    // ✅ FIX #1: Filter out SENT messages - only process RECEIVED messages
    // This prevents processing our own outgoing messages (e.g., presentation requests)
    const receivedMessages = newMessages.filter(
        msg => msg.direction === SDK.Domain.MessageDirection.RECEIVED
    );

    console.log(`📬 [handleMessages] After direction filter: ${receivedMessages.length} RECEIVED message(s)`);

    // ✅ FIX #2: Filter out messages FROM ourselves (self-DID check)
    // SDK sometimes stores outgoing messages with wrong direction, so we need this second layer
    const state = getState() as { app: RootState };
    const selfDID = state.app.agent.selfDID?.toString();

    const externalMessages = receivedMessages.filter(msg => {
        const fromDID = msg.from?.toString();
        const isSelfMessage = selfDID && fromDID === selfDID;

        if (isSelfMessage) {
            console.log(`🔄 [handleMessages] Skipping self-message from ${fromDID?.substring(0, 50)}...`);
            return false;
        }

        return true;
    });

    console.log(`📬 [handleMessages] After self-DID filter: ${externalMessages.length} external message(s)`);

    if (externalMessages.length === 0) {
        console.log('ℹ️ [handleMessages] No external messages to process');
        return;
    }

    // Process issued credentials
    const issuedCredentials = externalMessages.filter((message) => message.piuri === "https://didcomm.org/issue-credential/3.0/issue-credential");
    if (issuedCredentials.length) {
        for (const issuedCredential of issuedCredentials) {
            const issueCredential = IssueCredential.fromMessage(issuedCredential);
            const credential = await agent.processIssuedCredentialMessage(issueCredential);

            // ✅ FIX: Credentials are SDK class instances (_JWTCredential, etc.)
            // Redux can handle them as-is since they're already stored in Pluto DB
            // The reducer will deduplicate by ID if needed
            dispatch(
                reduxActions.credentialSuccess(
                    credential
                )
            )
        }
    }

    // ✅ ENHANCED LOGGING: Show ALL external messages for debugging
    console.log(`📋 [handleMessages] External messages summary (${externalMessages.length} total):`);
    externalMessages.forEach((msg, idx) => {
        console.log(`  ${idx + 1}. piuri="${msg.piuri}"`);
        console.log(`      from="${msg.from?.toString().substring(0, 50)}..."`);
        console.log(`      direction=${msg.direction} (0=SENT, 1=RECEIVED)`);
    });

    // AUTO-RESPOND: Security Clearance VC presentation requests
    // This enables automatic VC handshake without user approval (like TLS)
    console.log(`🔍 [AUTO-RESPONSE] Filtering for presentation requests...`);
    const presentationRequests = externalMessages.filter(
        (message) => {
            // ✅ FIX: Handle multiple possible piuri formats
            // Different SDK versions or configurations may use different piuris
            const isMatch =
                message.piuri === "https://didcomm.atalaprism.io/present-proof/3.0/request-presentation" ||
                message.piuri === "https://didcomm.org/present-proof/3.0/request-presentation" ||
                message.piuri.includes("request-presentation");
            console.log(`  🔍 Message piuri="${message.piuri}" matches presentation request? ${isMatch}`);
            return isMatch;
        }
    );
    console.log(`🔍 [AUTO-RESPONSE] Found ${presentationRequests.length} presentation request(s)`);

    // HANDLE CONNECTION REQUESTS: Detect and log for visibility
    console.log(`🔍 [CONNECTION REQUEST] Filtering for connection requests...`);
    const connectionRequests = externalMessages.filter(
        (message) => {
            const isMatch =
                message.piuri === SDK.ProtocolType.DidcommconnectionRequest ||
                message.piuri === "https://didcomm.org/didexchange/1.0/request" ||
                (message.piuri.includes("/connections/") && message.piuri.includes("/request"));

            if (isMatch) {
                console.log(`🤝 [CONNECTION REQUEST] Found connection request: ${message.piuri}`);
                console.log(`🤝 [CONNECTION REQUEST] From: ${message.from?.toString().substring(0, 50)}...`);
            }
            return isMatch;
        }
    );

    if (connectionRequests.length > 0) {
        console.log(`🤝 [CONNECTION REQUEST] Received ${connectionRequests.length} connection request(s)`);
        console.log(`🤝 [CONNECTION REQUEST] These will be available in the Connections tab`);
    }

    if (presentationRequests.length) {
        console.log(`🤝 [VC-HANDSHAKE] Received ${presentationRequests.length} presentation request(s)`);

        for (const requestMessage of presentationRequests) {
            try {
                // ✅ CRITICAL FIX: Extract schema BEFORE SDK parsing strips the 'claims' field
                // The SDK's RequestPresentation.fromMessage() removes claims from body
                let schemaId: string | undefined;
                const rawBody = requestMessage.body; // Move outside try-catch for debug logging access
                try {
                    // Access RAW message body before SDK parsing

                    if (rawBody && typeof rawBody === 'object') {
                        // Check for explicit schema field in message body
                        schemaId = (rawBody as any).schemaId || (rawBody as any).credentialSchema;

                        // If no explicit schema, try extracting from goal field (format: "schema:RealPerson - ...")
                        if (!schemaId && (rawBody as any).goal && typeof (rawBody as any).goal === 'string') {
                            const goalText = (rawBody as any).goal;
                            // Match "schema:RealPerson" or "schema:SecurityClearance" pattern
                            const schemaMatch = goalText.match(/schema:([A-Za-z0-9_-]+)/);
                            if (schemaMatch) {
                                schemaId = schemaMatch[1];
                            }
                        }

                        // Try extracting from comment field (Cloud Agent preserves this)
                        if (!schemaId && (rawBody as any).comment && typeof (rawBody as any).comment === 'string') {
                            const commentText = (rawBody as any).comment;
                            // Match "schema:RealPerson" or "schema:SecurityClearance" pattern
                            const schemaMatch = commentText.match(/schema:([A-Za-z0-9_-]+)/);
                            if (schemaMatch) {
                                schemaId = schemaMatch[1];
                            }
                        }

                        // Fallback: Try goal_code field (authentication.identity → RealPerson)
                        if (!schemaId && (rawBody as any).goal_code) {
                            const goalCode = (rawBody as any).goal_code;
                            if (goalCode === 'authentication.identity') {
                                schemaId = 'RealPerson';
                            } else if (goalCode === 'authentication.clearance') {
                                schemaId = 'SecurityClearance';
                            }
                        }

                        // Try extracting from proofTypes array
                        if (!schemaId && (rawBody as any).proofTypes && Array.isArray((rawBody as any).proofTypes)) {
                            const proofTypes = (rawBody as any).proofTypes;
                            if (proofTypes.length > 0 && proofTypes[0].schema) {
                                const schemaUrl = proofTypes[0].schema;
                                // Extract GUID from schema URL
                                const guidMatch = schemaUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                                if (guidMatch) {
                                    const guid = guidMatch[1].toLowerCase();
                                    // Map GUID to schema type
                                    const SCHEMA_MAP: Record<string, string> = {
                                        'e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f': 'RealPerson',
                                        'ba309a53-9661-33df-92a3-2023b4a56fd5': 'SecurityClearance'
                                    };
                                    schemaId = SCHEMA_MAP[guid];
                                }
                            }
                        }

                        // Legacy fallback: Try inferring from claims structure (for older messages)
                        if (!schemaId && (rawBody as any).claims) {
                            const claims = (rawBody as any).claims;
                            // Check for RealPerson pattern (firstName, lastName, uniqueId)
                            if (claims.firstName !== undefined && claims.lastName !== undefined && claims.uniqueId !== undefined) {
                                schemaId = 'RealPerson';
                            }
                            // Check for SecurityClearance pattern (clearanceLevel)
                            else if (claims.clearanceLevel !== undefined) {
                                schemaId = 'SecurityClearance';
                            }
                        }
                    }
                    // ✅ SMART FIX: No dangerous fallback - if schema unclear, show modal for user selection
                } catch (err) {
                    console.warn('⚠️ [VC-HANDSHAKE] Could not extract schema ID:', err);
                }

                // NOW parse with SDK (this will strip claims, but we already have schemaId)
                const requestPresentation = RequestPresentation.fromMessage(requestMessage);

                // Dispatch to Redux state
                dispatch(
                    reduxActions.presentationRequestReceived({
                        id: requestMessage.id,
                        from: requestMessage.from?.toString() || 'Unknown',
                        schemaId: schemaId,
                        requestMessage: requestMessage,
                        timestamp: new Date().toISOString()
                    })
                );

                console.log('📋 [VC-HANDSHAKE] Presentation request received');
                console.log('📋 [VC-HANDSHAKE] Request from:', requestMessage.from?.toString());
                console.log('📋 [VC-HANDSHAKE] Schema ID:', schemaId);

                // ✅ SMART AUTO-SEND: Only auto-send if schema is confidently identified
                if (!schemaId) {
                    console.log('⚠️ [AUTO-SEND] Schema unclear - showing modal for manual credential selection');
                    continue; // Skip auto-send, modal will appear for user choice
                }

                // Schema is clear - proceed with auto-send
                try {
                    // Fetch credentials directly from database instead of Redux state
                    const credentials = await agent.pluto.getAllCredentials();

                    console.log('🤖 [AUTO-SEND] Searching for matching credentials...');
                    console.log('🤖 [AUTO-SEND] Total credentials in wallet:', credentials.length);
                    console.log('🤖 [AUTO-SEND] Looking for schema:', schemaId);

                    // Find credentials matching the schema
                    const matchingCredentials = credentials.filter(cred => {
                        try {
                            // For Security Clearance, match credentials with clearanceLevel field
                            if (schemaId && schemaId.includes('SecurityClearance')) {
                                // Check credentialSubject (use 'as any' to bypass type checking)
                                if ((cred as any).credentialSubject?.clearanceLevel) return true;
                                // Check claims array
                                if (cred.claims && cred.claims.length > 0) {
                                    const firstClaim = cred.claims[0];
                                    if (firstClaim.clearanceLevel) return true;
                                }
                            }
                            // Add more schema matching logic here as needed
                            return false;
                        } catch (err) {
                            return false;
                        }
                    });

                    if (matchingCredentials.length > 0) {
                        // ✅ FIX: Sort by clearance level (highest first)
                        const sortedCredentials = matchingCredentials.sort((a, b) => {
                            const levelA = getVCClearanceLevel(a) || 0;
                            const levelB = getVCClearanceLevel(b) || 0;
                            return levelB - levelA; // Descending order (TOP-SECRET=3 > SECRET=2 > CONFIDENTIAL=1)
                        });

                        const selectedCredential = sortedCredentials[0];
                        const selectedLevel = getVCClearanceLevel(selectedCredential);
                        console.log('✅ [AUTO-SEND] Found matching credential:', selectedCredential.id);
                        console.log('✅ [AUTO-SEND] Selected clearance level:', selectedLevel, '(highest available)');
                        console.log('🚀 [AUTO-SEND] Automatically sending credential...');

                        // Automatically send the credential
                        await dispatch(sendVerifiablePresentation({
                            requestId: requestMessage.id,
                            credentialId: selectedCredential.id
                        }));

                        console.log('✅ [AUTO-SEND] Credential sent automatically - no user interaction needed');
                    } else {
                        console.log('⚠️ [AUTO-SEND] No matching credentials found - will show modal for manual selection');
                    }
                } catch (autoSendError) {
                    console.error('❌ [AUTO-SEND] Auto-send failed, will show modal:', autoSendError);
                    // If auto-send fails, the modal will still appear for manual selection
                }

            } catch (error) {
                console.error('❌ [VC-HANDSHAKE] Error handling presentation request:', error);
            }
        }
    }

    // Phase 2: Decrypt encrypted messages
    const processedMessages = await Promise.all(
        externalMessages.map(async (message) => {
            try {
                // Check if message is encrypted by examining body
                const bodyStr = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);
                let bodyObj: any;

                try {
                    bodyObj = JSON.parse(bodyStr);
                } catch (e) {
                    // Not JSON, treat as plaintext
                    return message;
                }

                // ✅ FIX: Parse body.content to detect StandardMessageBody format (nested JSON)
                let standardBody: any = null;
                if (bodyObj.content && typeof bodyObj.content === 'string') {
                    try {
                        const parsedContent = JSON.parse(bodyObj.content);
                        // Check if it's StandardMessageBody format (has encrypted and timestamp fields)
                        if (parsedContent && typeof parsedContent === 'object' &&
                            'encrypted' in parsedContent && 'timestamp' in parsedContent) {
                            console.log('✅ [handleMessages] StandardMessageBody detected');
                            standardBody = parsedContent;
                        }
                    } catch (e) {
                        // Not nested JSON, use bodyObj as-is
                    }
                }

                // ✅ Just preserve StandardMessageBody structure - let Chat.tsx handle decryption on-demand
                const encryptedBody = standardBody || bodyObj;

                // ✅ Preserve StandardMessageBody timestamp if available
                const standardTimestamp = encryptedBody.timestamp;

                console.log('📦 [handleMessages] Message received, preserving encrypted format for on-demand decryption');

                // Return message with encrypted body intact (Chat.tsx will decrypt on-demand)
                return {
                    ...message,
                    body: bodyObj,
                    standardTimestamp // Add timestamp from StandardMessageBody
                } as any;
            } catch (error: any) {
                console.error('❌ [handleMessages] Message parsing failed:', error);
                return message; // Return original message if parsing fails
            }
        })
    );

    // ✅ FIX: Filter out messages that already exist in Redux state
    const reduxState = getState() as { app: RootState };
    const existingIds = new Set(reduxState.app.messages.map(m => m.id));
    const newUniqueMessages = processedMessages.filter(
        msg => !existingIds.has(msg.id)
    );

    // Only dispatch if there are truly new messages
    if (newUniqueMessages.length > 0) {
        console.log(`✅ [handleMessages] Dispatching ${newUniqueMessages.length} new unique messages (filtered ${processedMessages.length - newUniqueMessages.length} duplicates)`);
        dispatch(
            reduxActions.messageSuccess(
                newUniqueMessages as SDK.Domain.Message[]
            )
        );
    } else {
        console.log(`ℹ️ [handleMessages] All ${processedMessages.length} messages already exist in state, skipping dispatch`);
    }
    } catch (error: any) {
        // ✅ Graceful error handling for DIDComm secret errors
        // These errors occur when encrypted messages arrive before peer DID keys are persisted
        if (error?.message?.includes('No recipient secrets found') ||
            error?.message?.includes('SecretNotFound') ||
            error?.message?.includes('DIDCommSecretNotFound')) {
            console.warn('⚠️ [handleMessages] Cannot decrypt message - recipient keys not yet available');
            console.warn('⚠️ [handleMessages] This is normal for messages arriving during connection establishment');
            console.warn('⚠️ [handleMessages] The SDK will retry decryption on next message poll');
            // Don't throw - allow connection request UI to continue working
            return;
        }

        // Re-throw other unexpected errors
        console.error('❌ [handleMessages] Unexpected error processing messages:', error);
        throw error;
    }
}

export const stopAgent = createAsyncThunk<
    { agent: SDK.Agent },
    { agent: SDK.Agent }
>("stopAgent", async (options, api) => {
    try {
        const { agent } = options
        agent.removeListener(ListenerKey.MESSAGE, handleMessages.bind({}, { dispatch: api.dispatch, agent, getState: api.getState }));
        await agent.stop()
        return api.fulfillWithValue({ agent })
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})


export const startAgent = createAsyncThunk<
    { agent: SDK.Agent, selfDID: SDK.Domain.DID },
    { agent: SDK.Agent }
>("startAgent", async (options, api) => {
    try {
        const { agent } = options;

        agent.addListener(ListenerKey.MESSAGE, handleMessages.bind({}, { dispatch: api.dispatch, agent, getState: api.getState }));

        // 🔧 FIX #8: Wrap agent.start() with graceful DIDComm error handling
        // DIDComm secret errors occur when encrypted messages arrive before peer DID keys are persisted
        // These are NON-FATAL errors during connection establishment - the SDK will retry decryption
        try {
            await agent.start()

            // ✅ CRITICAL: Start continuous message fetching from mediator
            // This enables the wallet to receive connection responses and credentials
            // Per https://hyperledger-identus.github.io/docs/home/quick-start
            await agent.startFetchingMessages(5000); // Poll every 5 seconds

            // Set agent for SecureDashboardBridge Pluto fallback
            setSecureDashboardAgent(agent);
            console.log('✅ [startAgent] SecureDashboardBridge agent set for Pluto fallback');
        } catch (startError: any) {
            // ✅ Gracefully handle DIDComm secret errors (non-fatal)
            // These occur when encrypted messages arrive before peer DID keys are persisted
            if (startError?.message?.includes('No recipient secrets found') ||
                startError?.message?.includes('SecretNotFound') ||
                startError?.message?.includes('DIDCommSecretNotFound')) {
                console.warn('⚠️ [startAgent] DIDComm decryption failed during agent.start() - recipient keys not yet available');
                console.warn('⚠️ [startAgent] This is normal during connection establishment');
                console.warn('⚠️ [startAgent] The SDK will retry decryption on next message poll');
                console.warn('⚠️ [startAgent] Continuing agent initialization...');

                // Don't throw - allow agent to continue initialization
                // The agent is still functional, just couldn't decrypt some messages yet

                // ✅ CRITICAL FIX: Set agent for SecureDashboardBridge even when DIDComm errors occur
                // This was previously skipped because setSecureDashboardAgent is in the try block
                setSecureDashboardAgent(agent);
                console.log('✅ [startAgent] SecureDashboardBridge agent set for Pluto fallback (after DIDComm error recovery)');
            } else {
                // Re-throw other unexpected errors
                throw startError;
            }
        }

        // ✅ FIX: Don't update mediator during initial startup (mediator registration is async)
        // The mediator handshake completes in the background, but isn't ready yet
        // Peer DID will be registered with mediator automatically later when sending messages
        const selfDID = await agent.createNewPeerDID([], false);

        return api.fulfillWithValue({ agent, selfDID })
    } catch (err) {
        console.error('❌ [startAgent] ACTION FAILED:', err);
        console.error('❌ [startAgent] Error type:', err.constructor.name);
        console.error('❌ [startAgent] Error message:', err.message);
        console.error('❌ [startAgent] Error stack:', err.stack);
        return api.rejectWithValue(err as Error);
    }
})

/**
 * Phase 2: Helper Functions for Message Encryption
 */

/**
 * Automatic VC Handshake: Initiate Security Clearance VC exchange
 *
 * Similar to TLS certificate exchange - automatically requests and waits for
 * recipient's Security Clearance VC without user approval.
 *
 * @param agent - Edge Agent SDK instance
 * @param recipientDID - Recipient's DID
 * @param credentials - Current wallet credentials (to find our VC for auto-response)
 * @param timeoutMs - Timeout in milliseconds (default 5 minutes)
 * @returns Promise that resolves when recipient's VC is received
 */
async function initiateVCHandshake(
    agent: SDK.Agent,
    recipientDID: SDK.Domain.DID,
    credentials: SDK.Domain.Credential[],
    timeoutMs: number = 300000
): Promise<{ vc: any, connectionDID: string }> {
    console.log('🤝 [VC-HANDSHAKE] Initiating automatic Security Clearance VC exchange...');
    console.log(`🤝 [VC-HANDSHAKE] Recipient: ${recipientDID.toString().substring(0, 50)}...`);

    // STEP 1: Send presentation request for Security Clearance VC
    // Using empty claims object to accept any credential
    // We'll validate the received VC using validateSecurityClearanceVC() instead
    const presentationClaims: PresentationClaims<SDK.Domain.CredentialType> = {
        claims: {}  // Required field - empty object accepts any credential
    };

    console.log('🔍 [HANDSHAKE-SEND] About to call agent.initiatePresentationRequest()...');
    console.log('🔍 [HANDSHAKE-SEND] Recipient DID:', recipientDID.toString().substring(0, 60) + '...');
    console.log('🔍 [HANDSHAKE-SEND] Credential type: JWT');
    console.log('🔍 [HANDSHAKE-SEND] Presentation claims:', JSON.stringify(presentationClaims));

    // Record the timestamp before sending request (for filtering new messages)
    const handshakeStartTime = Date.now();

    try {
        await agent.initiatePresentationRequest(
            SDK.Domain.CredentialType.JWT,
            recipientDID,
            presentationClaims
        );
        console.log('✅ [VC-HANDSHAKE] Presentation request sent successfully (empty claims - will validate on receipt)');
    } catch (error: any) {
        console.error('❌ [VC-HANDSHAKE] CRITICAL ERROR sending presentation request:', error);
        console.error('❌ [VC-HANDSHAKE] Error type:', error.constructor?.name);
        console.error('❌ [VC-HANDSHAKE] Error message:', error.message);
        console.error('❌ [VC-HANDSHAKE] Error stack:', error.stack);
        throw new Error('Failed to initiate VC handshake: ' + error.message);
    }

    // STEP 2: Wait for recipient's VC (with timeout) AND capture connection DID
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const checkInterval = setInterval(async () => {
            try {
                // Check if we've exceeded timeout
                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    reject(new Error(
                        'Recipient does not have a Security Clearance credential or did not respond to the verification request. ' +
                        'The recipient must obtain a valid Security Clearance VC to receive encrypted messages.'
                    ));
                    return;
                }

                // ✅ FIX: Get NEW messages to find the presentation response
                // Match by sender DID AND timestamp to prevent using old cached responses
                const allMessages = await agent.pluto.getAllMessages();
                console.log(`[${ts()}] 🔍 [VC-HANDSHAKE] Found ${allMessages.length} total messages in database`);

                const presentationResponse = allMessages.find(msg => {
                    if (msg.piuri !== "https://didcomm.atalaprism.io/present-proof/3.0/presentation") return false;
                    if (msg.direction !== SDK.Domain.MessageDirection.RECEIVED) return false;
                    if (msg.from?.toString() !== recipientDID.toString()) return false;

                    // 🔧 PART C: Only accept messages received AFTER handshake started
                    // This prevents using old cached presentation responses with stale keys
                    // Handle Unix timestamps (createdTime is always a number in SDK)
                    let msgTime: number;
                    if (typeof msg.createdTime === 'number') {
                        // SDK stores timestamps in SECONDS, but Date.now() returns MILLISECONDS
                        // Convert seconds to milliseconds for comparison
                        msgTime = msg.createdTime < 10000000000 ? msg.createdTime * 1000 : msg.createdTime;
                    } else {
                        // Fallback: undefined or unexpected type
                        msgTime = 0;
                    }

                    console.log(`[${ts()}] 🔍 [VC-HANDSHAKE] Timestamp check: msgTime=${msgTime}, handshakeStartTime=${handshakeStartTime}, msgId=${msg.id}`);

                    // CRITICAL FIX: Accept messages with msgTime === 0 during active handshake
                    // Messages may have undefined createdTime (falls through to 0)
                    if (msgTime === 0) {
                        console.warn(`[${ts()}] ⚠️ [VC-HANDSHAKE] Message has no valid timestamp - accepting during active handshake (msgId=${msg.id})`);
                        return true;  // Accept anyway since we're actively waiting for a response
                    }

                    return msgTime >= handshakeStartTime;
                });

                if (presentationResponse) {
                    console.log('🤝 [VC-HANDSHAKE] Presentation response found!');

                    // ✅ CRITICAL: Extract connection DID from message sender
                    const connectionDID = presentationResponse.from?.toString();

                    if (!connectionDID) {
                        clearInterval(checkInterval);
                        reject(new Error('Presentation response missing sender DID'));
                        return;
                    }

                    console.log('🔑 [VC-HANDSHAKE] Connection DID extracted:', connectionDID.substring(0, 50) + '...');

                    // ✅ FIX: Extract VC directly from presentation response attachments
                    // instead of searching database (avoids DID type mismatch issues)
                    console.log('🔍 [VC-HANDSHAKE] Extracting VC from presentation response attachments');

                    // Fetch fresh credentials from database to find newly-received VCs
                    const updatedCredentials = await agent.pluto.getAllCredentials();

                    // Extract credentials from message attachments using SDK utilities
                    const attachments = presentationResponse.attachments.reduce((acc: any[], attachment: any) => {
                        if ("base64" in attachment.data) {
                            const decoded = Buffer.from(attachment.data.base64, "base64").toString();

                            // Log attachment format and preview
                            console.log('🔍 [VC-HANDSHAKE] ========== ATTACHMENT ANALYSIS ==========');
                            console.log('🔍 [VC-HANDSHAKE] Attachment format:', attachment.format);
                            console.log('🔍 [VC-HANDSHAKE] Decoded preview:', decoded.substring(0, 200) + '...');

                            // Handle JWT credentials
                            if (attachment.format === SDK.Domain.AttachmentFormats.JWT) {
                                try {
                                    const credential = SDK.JWTCredential.fromJWS(decoded);
                                    console.log('✅ [VC-HANDSHAKE] JWT parsing succeeded');
                                    console.log('🔍 [VC-HANDSHAKE] JWT credential structure:', {
                                        topLevelKeys: Object.keys(credential),
                                        hasCredentialSchema: !!credential.credentialSchema,
                                        hasVc: !!credential.vc,
                                        vcKeys: credential.vc ? Object.keys(credential.vc) : 'N/A',
                                        vcHasCredentialSchema: credential.vc ? !!credential.vc.credentialSchema : false
                                    });
                                    return acc.concat(credential);
                                } catch (err) {
                                    console.warn('⚠️ [VC-HANDSHAKE] Failed to parse JWT credential:', {
                                        error: err instanceof Error ? err.message : String(err),
                                        errorStack: err instanceof Error ? err.stack : undefined,
                                        decodedPreview: decoded.substring(0, 100)
                                    });
                                }
                            }

                            // Handle SD-JWT credentials
                            if (attachment.format === SDK.Domain.AttachmentFormats.SDJWT) {
                                try {
                                    const credential = SDK.SDJWTCredential.fromJWS(decoded);
                                    console.log('✅ [VC-HANDSHAKE] SD-JWT parsing succeeded');
                                    return acc.concat(credential);
                                } catch (err) {
                                    console.warn('⚠️ [VC-HANDSHAKE] Failed to parse SD-JWT credential:', {
                                        error: err instanceof Error ? err.message : String(err),
                                        decodedPreview: decoded.substring(0, 100)
                                    });
                                }
                            }

                            // Fallback: Try parsing as JSON for legacy VCs or DIF Presentation Exchange
                            try {
                                const parsed = JSON.parse(decoded);
                                console.log('✅ [VC-HANDSHAKE] JSON fallback parsing succeeded');
                                console.log('🔍 [VC-HANDSHAKE] JSON parsed structure:', {
                                    topLevelKeys: Object.keys(parsed),
                                    keyCount: Object.keys(parsed).length,
                                    hasCredentialSchema: !!parsed.credentialSchema,
                                    hasPresentationSubmission: !!parsed.presentation_submission,
                                    hasVerifiablePresentation: !!parsed.verifiablePresentation
                                });

                                // Check if this is a DIF Presentation Exchange submission wrapper
                                if (parsed.presentation_submission && parsed.verifiablePresentation) {
                                    console.log('🔍 [VC-HANDSHAKE] DIF Presentation Exchange format detected');
                                    console.log('🔍 [VC-HANDSHAKE] Extracting VC from verifiablePresentation[0]');

                                    // verifiablePresentation[0] is a VP JWT that wraps the actual VC
                                    try {
                                        const vpJWT = parsed.verifiablePresentation[0];

                                        // Parse the VP JWT to get its payload
                                        console.log('🔍 [VC-HANDSHAKE] Parsing VP JWT to extract nested VC...');
                                        const vpCredential = SDK.JWTCredential.fromJWS(vpJWT);

                                        // The VP's vp property contains verifiableCredential array with the actual VC JWT
                                        const vpPayload = vpCredential.vp;
                                        console.log('🔍 [VC-HANDSHAKE] VP payload:', vpPayload);

                                        if (vpPayload && vpPayload.verifiableCredential && vpPayload.verifiableCredential.length > 0) {
                                            const vcJWT = vpPayload.verifiableCredential[0];
                                            console.log('✅ [VC-HANDSHAKE] Found nested VC JWT in VP');
                                            console.log('🔍 [VC-HANDSHAKE] Parsing nested VC JWT...');

                                            // Now parse the actual VC JWT - this should populate the vc property
                                            const credential = SDK.JWTCredential.fromJWS(vcJWT);
                                            console.log('🔍 [VC-HANDSHAKE] VC credential has credentialSchema:', !!credential.credentialSchema);
                                            console.log('🔍 [VC-HANDSHAKE] VC credential has vc property:', !!credential.vc);
                                            console.log('🔍 [VC-HANDSHAKE] ========================================');
                                            return acc.concat(credential);
                                        } else {
                                            console.error('❌ [VC-HANDSHAKE] VP does not contain verifiableCredential array');
                                            console.log('🔍 [VC-HANDSHAKE] ========================================');
                                        }
                                    } catch (jwtErr) {
                                        console.error('❌ [VC-HANDSHAKE] Failed to parse VP/VC JWTs:', jwtErr);
                                        console.log('🔍 [VC-HANDSHAKE] ========================================');
                                    }
                                }

                                // Otherwise, treat as regular VC
                                console.log('🔍 [VC-HANDSHAKE] Standard VC format');
                                console.log('🔍 [VC-HANDSHAKE] ========================================');
                                return acc.concat(parsed);
                            } catch (err) {
                                // Not JSON - skip
                                console.log('⚠️ [VC-HANDSHAKE] JSON parsing also failed - skipping attachment');
                                console.log('🔍 [VC-HANDSHAKE] ========================================');
                            }
                        }
                        return acc;
                    }, []);

                    if (attachments.length === 0) {
                        console.warn('⚠️ [VC-HANDSHAKE] Presentation response has no valid credential attachments');
                        return; // Continue polling
                    }

                    console.log(`🔍 [VC-HANDSHAKE] Extracted ${attachments.length} credential(s) from attachments`);

                    // Validate extracted credentials to find Security Clearance VC
                    const recipientVC = attachments.find((cred: any) => {
                        try {
                            // Validate schema and issuer trust (no DID comparison needed)
                            if (!validateSecurityClearanceVC(cred)) {
                                console.log('⚠️ [VC-HANDSHAKE] Attachment is not a valid Security Clearance VC');
                                return false;
                            }

                            console.log('✅ [VC-HANDSHAKE] Valid Security Clearance VC extracted from attachment!');
                            return true;
                        } catch (e) {
                            console.error('❌ [VC-HANDSHAKE] Error validating VC:', e);
                            return false;
                        }
                    });

                    if (recipientVC) {
                        clearInterval(checkInterval);
                        console.log('✅ [VC-HANDSHAKE] Recipient Security Clearance VC received!');
                        const recipientVCWithSubject = recipientVC as any;
                        console.log('✅ [VC-HANDSHAKE] FINAL ACCEPTED VC DETAILS:', {
                            schema: recipientVCWithSubject.credentialSchema?.[0]?.id?.substring(0, 80),
                            subjectDID: (recipientVCWithSubject.credentialSubject?.id || recipientVC.subject?.id)?.substring(0, 60),
                            holderName: recipientVCWithSubject.credentialSubject?.holderName || recipientVC.claims?.[0]?.holderName,
                            clearanceLevel: recipientVCWithSubject.credentialSubject?.clearanceLevel || recipientVC.claims?.[0]?.clearanceLevel
                        });
                        console.log('✅ [VC-HANDSHAKE] Returning both VC and connection DID');
                        resolve({ vc: recipientVC, connectionDID });
                    }
                }
            } catch (error) {
                clearInterval(checkInterval);
                reject(error);
            }
        }, 500); // Check every 500ms
    });
}

/**
 * Receiver-Initiated VC Request: ALWAYS request fresh sender VC
 *
 * This function eliminates stale cache issues by always requesting the sender's
 * Security Clearance VC directly when receiving an encrypted message.
 * No caching - always fresh, no infinite loops, no 3-second waits.
 *
 * @param agent - Edge Agent SDK instance
 * @param senderDID - Sender's DID (from encrypted message)
 * @param timeoutMs - Timeout in milliseconds (default 5 minutes)
 * @returns Promise with sender's VC and connection DID
 */
async function ensureSenderVC(
    agent: any,
    senderDID: SDK.Domain.DID,
    timeoutMs: number = 300000
): Promise<{ vc: any, connectionDID: string }> {
    console.log('🔄 [ensureSenderVC] Requesting fresh sender VC (ignoring any cached VCs)...');
    console.log(`🔄 [ensureSenderVC] Sender: ${senderDID.toString().substring(0, 50)}...`);

    // STEP 1: Send presentation request for sender's Security Clearance VC
    const presentationClaims: PresentationClaims<SDK.Domain.CredentialType> = {
        claims: {}  // Accept any credential - will validate on receipt
    };

    console.log('📤 [ensureSenderVC] Sending presentation request to sender...');

    try {
        await agent.initiatePresentationRequest(
            SDK.Domain.CredentialType.JWT,
            senderDID,
            presentationClaims
        );
        console.log('✅ [ensureSenderVC] Presentation request sent successfully');
    } catch (error: any) {
        console.error('❌ [ensureSenderVC] Failed to send presentation request:', error);
        throw new Error('Failed to request sender VC: ' + error.message);
    }

    // STEP 2: Poll for presentation response (same pattern as initiateVCHandshake)
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const checkInterval = setInterval(async () => {
            try {
                // Check timeout
                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    reject(new Error(
                        'ensureSenderVC timeout: Sender did not respond with their Security Clearance VC within 15 seconds'
                    ));
                    return;
                }

                // Look for presentation response from sender
                const allMessages = await agent.pluto.getAllMessages();
                const presentationResponse = allMessages.find((msg: any) =>
                    msg.piuri === "https://didcomm.atalaprism.io/present-proof/3.0/presentation" &&
                    msg.direction === SDK.Domain.MessageDirection.RECEIVED &&
                    msg.from?.toString() === senderDID.toString()
                );

                if (presentationResponse) {
                    console.log('📬 [ensureSenderVC] Presentation response received from sender');

                    // Extract connection DID
                    const connectionDID = presentationResponse.from?.toString();
                    if (!connectionDID) {
                        clearInterval(checkInterval);
                        reject(new Error('Presentation response missing sender DID'));
                        return;
                    }

                    console.log('🔑 [ensureSenderVC] Connection DID extracted:', connectionDID.substring(0, 50) + '...');

                    // ✅ FIX: Extract VC directly from presentation response attachments
                    console.log('🔍 [ensureSenderVC] Extracting VC from presentation response attachments');

                    // Extract credentials from message attachments using SDK utilities
                    const attachments = presentationResponse.attachments.reduce((acc: any[], attachment: any) => {
                        if ("base64" in attachment.data) {
                            const decoded = Buffer.from(attachment.data.base64, "base64").toString();

                            // Handle JWT credentials
                            if (attachment.format === SDK.Domain.AttachmentFormats.JWT) {
                                try {
                                    const credential = SDK.JWTCredential.fromJWS(decoded);
                                    return acc.concat(credential);
                                } catch (err) {
                                    console.warn('⚠️ [ensureSenderVC] Failed to parse JWT credential:', err);
                                }
                            }

                            // Handle SD-JWT credentials
                            if (attachment.format === SDK.Domain.AttachmentFormats.SDJWT) {
                                try {
                                    const credential = SDK.SDJWTCredential.fromJWS(decoded);
                                    return acc.concat(credential);
                                } catch (err) {
                                    console.warn('⚠️ [ensureSenderVC] Failed to parse SD-JWT credential:', err);
                                }
                            }

                            // Fallback: Try parsing as JSON for legacy VCs
                            try {
                                const parsed = JSON.parse(decoded);
                                return acc.concat(parsed);
                            } catch (err) {
                                // Not JSON - skip
                            }
                        }
                        return acc;
                    }, []);

                    if (attachments.length === 0) {
                        console.warn('⚠️ [ensureSenderVC] Presentation response has no valid credential attachments');
                        return; // Continue polling
                    }

                    console.log(`🔍 [ensureSenderVC] Extracted ${attachments.length} credential(s) from attachments`);

                    // Validate extracted credentials to find Security Clearance VC
                    const senderVC = attachments.find((cred: any) => {
                        try {
                            // SECURITY CHECK: Validate schema and issuer trust
                            if (!validateSecurityClearanceVC(cred)) {
                                console.log('⚠️ [ensureSenderVC] Attachment is not a valid Security Clearance VC');
                                return false;
                            }

                            console.log('✅ [ensureSenderVC] Valid Security Clearance VC extracted from attachment!');
                            return true;
                        } catch (e) {
                            console.error('❌ [ensureSenderVC] Error validating VC:', e);
                            return false;
                        }
                    });

                    if (senderVC) {
                        clearInterval(checkInterval);
                        console.log('✅ [ensureSenderVC] Sender Security Clearance VC validated and ready');
                        resolve({ vc: senderVC, connectionDID });
                    }
                }
            } catch (error) {
                clearInterval(checkInterval);
                reject(error);
            }
        }, 500); // Poll every 500ms
    });
}

/**
 * Get recipient's Security Clearance VC from stored credentials
 * @param recipientDID The recipient's DID
 * @param credentials Array of stored credentials
 * @returns Security Clearance VC or null if not found
 */
function getRecipientSecurityClearanceVC(
    recipientDID: string,
    credentials: SDK.Domain.Credential[]
): any | null {
    // 🔧 TEMPORARY FIX: Always return null to force fresh VC handshake
    // This prevents using stale cached VCs with mismatched encryption keys
    // When recipient gets a new Security Clearance VC, we must re-fetch it
    console.warn('⚠️ [getRecipientVC] Forcing fresh VC handshake - ignoring cached VCs (temporary fix for stale keys)');
    return null;

    /* ORIGINAL CODE - DISABLED TEMPORARILY
    // Strategy 1: Check if we have recipient's VC in our credentials
    // This happens when we've verified their credentials before
    const recipientVC = credentials.find(
        (cred: any) => {
            try {
                const subject = cred.credentialSubject || cred.subject;
                const types = cred.type || [];

                return subject?.id === recipientDID &&
                       (types.includes('SecurityClearanceCredential') ||
                        types.includes('SecurityClearance'));
            } catch (e) {
                return false;
            }
        }
    );

    if (recipientVC) {
        console.log('✅ [getRecipientVC] Found Security Clearance VC for recipient');
        return recipientVC;
    }

    console.warn('⚠️ [getRecipientVC] No Security Clearance VC found for recipient:', recipientDID.substring(0, 50) + '...');
    return null;
    */
}

/**
 * Get recipient's Ed25519 public key from their Security Clearance VC
 * @param recipientVC The recipient's Security Clearance VC
 * @returns Public key as Uint8Array
 * @throws Error if public key not found
 */
/**
 * Enhanced sendMessage with encryption support
 * @param content - Plaintext message content OR pre-built SDK.Domain.Message
 * @param recipientDID - Recipient's DID (required for encryption)
 * @param securityLevel - Classification level (UNCLASSIFIED by default)
 */
export const sendMessage = createAsyncThunk<
    { message: SDK.Domain.Message },
    {
        agent: SDK.Agent,
        message?: SDK.Domain.Message,  // Legacy support: pre-built message
        content?: string,              // New: plaintext content
        recipientDID?: string,         // Required for encryption
        securityLevel?: SecurityLevel  // Classification level
    },
    { state: { app: RootState } }
>('sendMessage', async (options, api) => {
    try {
        const {
            agent,
            message: prebuiltMessage,
            content,
            recipientDID,
            securityLevel = SecurityLevel.INTERNAL
        } = options;

        let finalMessage: SDK.Domain.Message;

        // LEGACY MODE: Pre-built message provided (backwards compatibility)
        if (prebuiltMessage) {
            console.log('📤 [sendMessage] Legacy mode: sending pre-built message');
            finalMessage = prebuiltMessage;
        }
        // NEW MODE: Content + security level (encryption support)
        else if (content !== undefined && recipientDID) {
            console.log(`📤 [sendMessage] Sending message with security level: ${SECURITY_LEVEL_NAMES[securityLevel]}`);

            // Get Redux state for credentials
            const state = api.getState().app;
            const credentials = state.credentials || [];

            // CLASSIFIED MESSAGE: Encrypt before sending
            if (securityLevel > SecurityLevel.INTERNAL) {
                console.log('🔒 [sendMessage] Encrypting classified message...');

                // STEP 1: Get sender's Security Clearance VC
                console.log('🔍 [DEBUG-SEND] ============================================');
                console.log('🔍 [DEBUG-SEND] Searching for Security Clearance VC...');
                console.log('🔍 [DEBUG-SEND] Total credentials in Redux state:', credentials.length);
                console.log('🔍 [DEBUG-SEND] All credentials summary:', JSON.stringify(credentials.map((c: any) => ({
                    id: c.id,
                    credentialType: c.credentialType,
                    type: c.type,
                    hasClaims: !!c.claims,
                    claimsCount: Array.isArray(c.claims) ? c.claims.length : (c.claims ? 'object' : 0),
                    firstClaimKeys: (Array.isArray(c.claims) && c.claims[0]) ? Object.keys(c.claims[0]) : (c.claims ? Object.keys(c.claims) : []),
                    hasCredentialSubject: !!c.credentialSubject,
                    credentialSubjectKeys: c.credentialSubject ? Object.keys(c.credentialSubject) : []
                })), null, 2));

                const senderVC = credentials.find((cred: any) => {
                    console.log('🔍 [DEBUG-CHECK] Checking credential:', cred.id || 'no-id');

                    try {
                        // SECURITY CHECK: Validate schema and issuer trust FIRST
                        console.log('  → SECURITY VALIDATION: Checking schema and issuer...');
                        if (!validateSecurityClearanceVC(cred)) {
                            console.log('  ❌ REJECTED: Schema/issuer validation failed (untrusted or malformed)');
                            return false;
                        }
                        console.log('  ✅ SECURITY PASSED: Schema and issuer validated');

                        // Check type array (for legacy VCs)
                        const types = cred.type || [];
                        console.log('  → Pattern 1 (type array):', types);
                        if (types.includes('SecurityClearanceCredential') || types.includes('SecurityClearance')) {
                            console.log('  ✅ MATCH: type array includes SecurityClearance');
                            return true;
                        }

                        // Check for clearanceLevel in claims (JWT credentials from Cloud Agent)
                        console.log('  → Pattern 2 (claims array):');
                        console.log('    - hasClaims:', !!cred.claims);
                        console.log('    - claims type:', typeof cred.claims);
                        console.log('    - claims isArray:', Array.isArray(cred.claims));
                        console.log('    - claimsLength:', Array.isArray(cred.claims) ? cred.claims.length : 'N/A');
                        if (cred.claims && cred.claims.length > 0) {
                            console.log('    - claims[0]:', JSON.stringify(cred.claims[0], null, 2));
                            console.log('    - claims[0].clearanceLevel:', cred.claims[0]?.clearanceLevel);
                            if (cred.claims[0]?.clearanceLevel) {
                                console.log('  ✅ MATCH: claims[0].clearanceLevel exists');
                                return true;
                            }
                        }

                        // Check credentialSubject (alternative JWT structure)
                        console.log('  → Pattern 3 (credentialSubject):');
                        console.log('    - hasCredentialSubject:', !!cred.credentialSubject);
                        if (cred.credentialSubject) {
                            console.log('    - credentialSubject:', JSON.stringify(cred.credentialSubject, null, 2));
                            console.log('    - credentialSubject.clearanceLevel:', cred.credentialSubject.clearanceLevel);
                            if (cred.credentialSubject.clearanceLevel) {
                                console.log('  ✅ MATCH: credentialSubject.clearanceLevel exists');
                                return true;
                            }
                        }

                        console.log('  ❌ NO MATCH: None of the 3 patterns matched');
                        return false;
                    } catch (e) {
                        console.error('  ❌ ERROR during credential check:', e);
                        return false;
                    }
                });

                if (!senderVC) {
                    throw new Error(
                        `Cannot send ${SECURITY_LEVEL_NAMES[securityLevel]} message: You do not have a Security Clearance VC`
                    );
                }

                // STEP 2: Validate sender has sufficient clearance
                const senderClearance = getVCClearanceLevel(senderVC);
                if (senderClearance < securityLevel) {
                    throw new Error(
                        `Cannot send ${SECURITY_LEVEL_NAMES[securityLevel]} message: ` +
                        `Your clearance is ${SECURITY_LEVEL_NAMES[senderClearance]}`
                    );
                }

                // STEP 3: PRE-SEND VALIDATION - Check recipient's clearance
                console.log('🔍 [PRE-HANDSHAKE] Checking if recipient VC exists...');
                console.log('🔍 [PRE-HANDSHAKE] Recipient DID:', recipientDID.substring(0, 60) + '...');
                console.log('🔍 [PRE-HANDSHAKE] Total credentials available:', credentials.length);
                let recipientVC = getRecipientSecurityClearanceVC(recipientDID, credentials);
                console.log('🔍 [PRE-HANDSHAKE] Recipient VC found:', !!recipientVC);

                // ✅ Variable to store connection DID (peer DID) - different from VC subject DID (PRISM DID)
                let recipientConnectionDID: string | undefined;

                // 🧹 PART A+B: Clear stale recipient VCs and presentation responses before handshake
                // This prevents using old cached keys that cause decryption failures
                console.log('🧹 [sendMessage] Clearing stale recipient VCs and presentation responses...');

                // Part A: Delete old recipient VCs
                const oldRecipientVCs = credentials.filter(cred => {
                    // Access credentialSubject via type assertion (JWTCredential has this getter)
                    const credWithSubject = cred as any;
                    const subject = credWithSubject.credentialSubject || cred.subject;
                    const types = credWithSubject.type || [];
                    return subject?.id === recipientDID &&
                           (types.includes('SecurityClearanceCredential') || types.includes('SecurityClearance'));
                });

                for (const oldVC of oldRecipientVCs) {
                    console.log('🗑️ [sendMessage] Deleting old recipient VC:', oldVC.id);
                    await agent.pluto.deleteCredential(oldVC);
                }
                console.log('✅ [sendMessage] Cleared', oldRecipientVCs.length, 'stale VC(s)');

                // Part B: Delete old presentation response messages
                // SAFETY: Only delete messages older than 10 seconds to avoid race conditions
                const now = Date.now();
                const SAFETY_MARGIN_MS = 10000; // 10 seconds
                const allMessages = await agent.pluto.getAllMessages();
                const oldPresentations = allMessages.filter(msg => {
                    if (msg.piuri !== "https://didcomm.atalaprism.io/present-proof/3.0/presentation") return false;
                    if (msg.direction !== SDK.Domain.MessageDirection.RECEIVED) return false;
                    if (msg.from?.toString() !== recipientDID) return false;

                    // Get message timestamp (createdTime is always a number in SDK)
                    const msgTime = typeof msg.createdTime === 'number'
                        ? msg.createdTime
                        : 0;

                    // Only delete if older than safety margin (or has no timestamp)
                    const isOld = msgTime === 0 || (now - msgTime) > SAFETY_MARGIN_MS;
                    if (!isOld) {
                        console.log(`[${ts()}] ⚠️ [sendMessage] Skipping recent message (${Math.floor((now - msgTime) / 1000)}s old): ${msg.id}`);
                    }
                    return isOld;
                });

                for (const oldMsg of oldPresentations) {
                    console.log(`[${ts()}] 🗑️ [sendMessage] Deleting old presentation message: ${oldMsg.id}`);
                    await agent.pluto.deleteMessage(oldMsg.id);
                }
                console.log(`[${ts()}] ✅ [sendMessage] Cleared ${oldPresentations.length} old presentation message(s)`);

                // AUTOMATIC VC HANDSHAKE: If recipient VC not found, initiate automatic exchange
                if (!recipientVC) {
                    console.log('🤝 [sendMessage] Recipient Security Clearance VC not found - initiating automatic handshake...');
                    console.log('🤝 [sendMessage] About to call initiateVCHandshake()...');

                    try {
                        // Initiate handshake and wait for recipient's VC AND connection DID
                        const recipientDIDObj = SDK.Domain.DID.fromString(recipientDID);
                        console.log('🤝 [sendMessage] Calling initiateVCHandshake with timeout 300000ms (5 minutes)...');
                        const handshakeResult = await initiateVCHandshake(agent, recipientDIDObj, credentials, 300000);
                        recipientVC = handshakeResult.vc;
                        recipientConnectionDID = handshakeResult.connectionDID;  // ✅ Assign to outer variable

                        console.log('✅ [sendMessage] VC handshake completed - recipient clearance verified');
                        console.log('✅ [sendMessage] Captured connection DID for lookup:', recipientConnectionDID.substring(0, 50) + '...');

                        // SDK already stored credential during VC handshake - no need to store again
                        // Update credentials in Redux state so it's available for future messages
                        api.dispatch(
                            reduxActions.credentialSuccess(recipientVC)
                        );
                    } catch (handshakeError: any) {
                        throw new Error(
                            `❌ Cannot send ${SECURITY_LEVEL_NAMES[securityLevel]} message: Recipient does not have the required Security Clearance credential. ` +
                            `${handshakeError.message || 'The recipient must obtain a Security Clearance VC to receive encrypted messages.'}`
                        );
                    }
                }

                const recipientClearance = getVCClearanceLevel(recipientVC);
                if (recipientClearance < securityLevel) {
                    throw new Error(
                        `Cannot send: Recipient has ${SECURITY_LEVEL_NAMES[recipientClearance]} clearance, ` +
                        `message requires ${SECURITY_LEVEL_NAMES[securityLevel]}`
                    );
                }

                console.log('✅ [sendMessage] Recipient clearance validated:', SECURITY_LEVEL_NAMES[recipientClearance]);

                // STEP 4: Extract sender's X25519 encryption keys from v3.0.0 VC
                const senderVCWithSubject = senderVC as any;
                const senderSubject = senderVCWithSubject.credentialSubject || senderVC.subject;
                const senderX25519Fingerprint = senderSubject?.x25519Fingerprint;

                if (!senderX25519Fingerprint) {
                    throw new Error('Security Clearance VC missing x25519Fingerprint (v3.0.0 required)');
                }

                // Use async lookup with Pluto fallback for PRISM DID-issued VCs
                const senderKey = await getSecurityKeyByFingerprintAsync(senderX25519Fingerprint, agent);
                if (!senderKey) {
                    throw new Error('X25519 encryption key not found in storage or Pluto. Generate a new v3.0.0 Security Clearance VC.');
                }

                // Verify this is a dual-key structure (v3.0.0)
                const isDualKey = 'x25519' in senderKey;
                if (!isDualKey) {
                    throw new Error('Legacy single-key format detected. Please generate a v3.0.0 dual-key Security Clearance VC.');
                }

                // STEP 5: Extract X25519 encryption keys (direct base64url decode, no SDK transformation)
                const senderX25519PrivateKey = base64url.decode((senderKey as any).x25519.privateKeyBytes);
                const senderX25519PublicKey = base64url.decode((senderKey as any).x25519.publicKeyBytes);

                // Extract recipient's VC subject (contains their X25519 public key)
                const recipientVCWithSubject = recipientVC as any;
                const recipientSubject = recipientVCWithSubject.credentialSubject || recipientVC.subject;
                const recipientX25519PublicKey = base64url.decode(recipientSubject.x25519PublicKey);

                console.log('🔑 [sendMessage] Using X25519 encryption keys (v3.0.0)');
                console.log('🔑 [sendMessage] Sender X25519 fingerprint:', senderX25519Fingerprint);
                console.log('🔑 [sendMessage] Recipient X25519 fingerprint:', recipientSubject.x25519Fingerprint);

                // STEP 6: Encrypt message with X25519 keys
                const encryptedBody = await encryptMessage(
                    content,
                    senderX25519PrivateKey,
                    senderX25519PublicKey,
                    recipientX25519PublicKey
                );

                console.log('🔑 [DEBUG] Encrypted body senderPublicKey (base64url, first 32 chars):', encryptedBody.senderPublicKey.substring(0, 32) + '...');
                console.log('🔑 [DEBUG-ENCRYPTION-KEYS] ========================================');

                console.log('✅ [sendMessage] Message encrypted successfully with security level:', SECURITY_LEVEL_NAMES[securityLevel]);

                // STEP 7: Create DIDComm message with encrypted body
                // ✅ FIX: Look up existing connection using peer DID (not PRISM DID)
                // Use recipientConnectionDID from handshake if available, fallback to recipientDID
                const lookupDID = recipientConnectionDID || recipientDID;
                console.log('🔍 [sendMessage] Looking up existing connection to recipient...');
                console.log('🔍 [sendMessage] Using DID for lookup:', lookupDID.substring(0, 50) + '...');
                const connections = await agent.pluto.getAllDidPairs();
                const connection = connections.find(pair =>
                    pair.receiver.toString() === lookupDID
                );

                if (!connection) {
                    throw new Error(
                        'No DIDComm connection found to recipient. Please establish a connection first.'
                    );
                }

                console.log('✅ [sendMessage] Using connection DIDs - sender:', connection.host.toString().substring(0, 50) + '...');
                console.log('✅ [sendMessage] Using connection DIDs - recipient:', connection.receiver.toString().substring(0, 50) + '...');

                const senderDIDObj = connection.host;
                const recipientDIDObj = connection.receiver;

                // ✅ Create StandardMessageBody for encrypted message
                const standardBody = createEncryptedMessageBody(
                    encryptedBody.ciphertext,
                    encryptedBody.nonce,
                    encryptedBody.recipientPublicKey,
                    encryptedBody.senderPublicKey,
                    encryptedBody.algorithm,
                    SECURITY_LEVEL_NAMES[securityLevel],
                    securityLevel
                );

                // Create BasicMessage with proper body structure
                const basicMsgBody = { content: JSON.stringify(standardBody) };
                finalMessage = new BasicMessage(
                    basicMsgBody as any,  // SDK expects BasicMessageBody type
                    senderDIDObj,
                    recipientDIDObj
                ).makeMessage();

                // Add metadata to message extraHeaders (if SDK supports it)
                // This allows the recipient to know the classification level
                try {
                    (finalMessage as any).extraHeaders = {
                        securityLevel: SECURITY_LEVEL_NAMES[securityLevel],
                        classificationNumeric: securityLevel,
                        encryptionKeyFingerprint: senderX25519Fingerprint,
                        securityClearanceVcId: senderVC.id || 'unknown',
                        encryptedAt: new Date().toISOString()
                    };
                } catch (e) {
                    console.warn('⚠️ [sendMessage] Could not add extraHeaders (SDK may not support)');
                }
            }
            // UNCLASSIFIED MESSAGE: Send as plaintext
            else {
                console.log('📝 [sendMessage] Sending unclassified plaintext message');

                // ✅ FIX: Look up existing connection using peer DID (not PRISM DID)
                const lookupDID = recipientDID;
                console.log('🔍 [sendMessage] Looking up existing connection to recipient...');
                console.log('🔍 [sendMessage] Using DID for lookup:', lookupDID.substring(0, 50) + '...');
                const connections = await agent.pluto.getAllDidPairs();
                const connection = connections.find(pair =>
                    pair.receiver.toString() === lookupDID
                );

                if (!connection) {
                    throw new Error(
                        'No DIDComm connection found to recipient. Please establish a connection first.'
                    );
                }

                console.log('✅ [sendMessage] Using connection DIDs - sender:', connection.host.toString().substring(0, 50) + '...');
                console.log('✅ [sendMessage] Using connection DIDs - recipient:', connection.receiver.toString().substring(0, 50) + '...');

                const senderDIDObj = connection.host;
                const recipientDIDObj = connection.receiver;

                // ✅ Create StandardMessageBody for plaintext message
                const standardBody = createPlaintextMessageBody(content);

                // Create BasicMessage with proper body structure
                const basicMsgBody = { content: JSON.stringify(standardBody) };
                finalMessage = new BasicMessage(
                    basicMsgBody as any,
                    senderDIDObj,
                    recipientDIDObj
                ).makeMessage();
            }
        } else {
            throw new Error('sendMessage requires either "message" or "content + recipientDID"');
        }

        // Send message via agent
        await agent.sendMessage(finalMessage);

        // ✅ FIX: Check if message already exists before attempting insert
        try {
            const existing = await agent.pluto.getMessage(finalMessage.id);

            if (!existing) {
                await agent.pluto.storeMessage(finalMessage);
                console.log('✅ [Redux] Message stored successfully');
            } else {
                console.log('ℹ️ [Redux] Message already exists in database, skipping storage');
            }
        } catch (storeError: any) {
            console.error('❌ [Redux] Failed to store message:', storeError.message);
            console.warn('📤 [Redux] Message was sent but not stored locally');
        }

        // Always dispatch success to update UI, even if storage failed
        api.dispatch(
            reduxActions.messageSuccess(
                [finalMessage]
            )
        )
        return api.fulfillWithValue({ message: finalMessage });
    } catch (err: any) {
        console.error('❌ [Redux] sendMessage COMPLETE FAILURE:', err);
        console.error('❌ [Redux] Error type:', err.constructor?.name);
        console.error('❌ [Redux] Error message:', err.message);
        console.error('❌ [Redux] Error stack:', err.stack);
        console.error('❌ [Redux] Full error object:', JSON.stringify(err, null, 2));
        return api.rejectWithValue(err);
    }
})

export const initiatePresentationRequest = createAsyncThunk<
    any,
    {
        agent: SDK.Agent,
        toDID: SDK.Domain.DID,
        presentationClaims: PresentationClaims<SDK.Domain.CredentialType>,
        type: SDK.Domain.CredentialType
    }
>("initiatePresentationRequest", async (options, api) => {
    try {
        const {
            agent,
            presentationClaims,
            toDID,
            type
        } = options;

        await agent.initiatePresentationRequest<typeof type>(
            type,
            toDID,
            presentationClaims
        );

        return api.fulfillWithValue(null)
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})

//This is for demonstration purposes and assumes that
//The Cloud agent is running on port ::::::
//Resolver at some point will be configurable to run on specific universal resolver endpoints
//for testnet, mainnet switching, etc
class ShortFormDIDResolverSample implements SDK.Domain.DIDResolver {
    method: string = "prism"

    private async parseResponse(response: Response) {
        const data = await response.text();
        try {
            return JSON.parse(data);
        }
        catch {
            return data;
        }
    }

    async resolve(didString: string): Promise<SDK.Domain.DIDDocument> {
        const url = "http://localhost:8000/cloud-agent/dids/" + didString;
        const response = await fetch(url, {
            "headers": {
                "accept": "*/*",
                "accept-language": "en",
                "cache-control": "no-cache",
                "pragma": "no-cache",
                "sec-gpc": "1"
            },
            "method": "GET",
            "mode": "cors",
            "credentials": "omit"
        })
        if (!response.ok) {
            throw new Error('Failed to fetch data');
        }
        const data = await response.json();
        const didDocument = data.didDocument;

        const servicesProperty = new SDK.Domain.Services(
            didDocument.service
        )
        const verificationMethodsProperty = new SDK.Domain.VerificationMethods(
            didDocument.verificationMethod
        )
        const coreProperties: SDK.Domain.DIDDocumentCoreProperty[] = [];
        const authenticate: SDK.Domain.Authentication[] = [];
        const assertion: SDK.Domain.AssertionMethod[] = [];

        for (const verificationMethod of didDocument.verificationMethod) {
            const isAssertion = didDocument.assertionMethod.find((method) => method === verificationMethod.id)
            if (isAssertion) {
                assertion.push(new SDK.Domain.AssertionMethod([isAssertion], [verificationMethod]))
            }
            const isAuthentication = didDocument.authentication.find((method) => method === verificationMethod.id)
            if (isAuthentication) {
                authenticate.push(new SDK.Domain.Authentication([isAuthentication], [verificationMethod]));
            }
        }

        coreProperties.push(...authenticate);
        coreProperties.push(servicesProperty);
        coreProperties.push(verificationMethodsProperty);

        const resolved = new SDK.Domain.DIDDocument(
            SDK.Domain.DID.fromString(didString),
            coreProperties
        );

        return resolved;
    }
}

export const initAgent = createAsyncThunk<
    { agent: SDK.Agent },
    {
        mediatorDID: SDK.Domain.DID,
        pluto: SDK.Domain.Pluto,
        defaultSeed: SDK.Domain.Seed
    }
>("initAgent", async (options, api) => {
    try {
        const { mediatorDID, pluto, defaultSeed } = options;

        const apollo = new SDK.Apollo();
        const extraResolvers = [
            ShortFormDIDResolverSample
        ];
        const castor = new SDK.Castor(apollo, extraResolvers)
        const agent = await Agent.initialize({
            apollo,
            castor,
            mediatorDID,
            pluto,
            seed: defaultSeed
        });
        return api.fulfillWithValue({
            agent,
        })
    } catch (err) {
        return api.rejectWithValue(err as Error);
    }
})

export const connectDatabase = createAsyncThunk<
    {
        db: any // Changed from SDK.Domain.Pluto to any for lazy loading compatibility
    },
    {
        encryptionKey: Uint8Array,
    },
    { state: { app: RootState } }
>("connectDatabase", async (options, api) => {
    try {
        const state = api.getState().app;
        const hashedPassword = sha512(options.encryptionKey)

        const apollo = new SDK.Apollo();
        const store = new SDK.Store({
            name: state.wallet.dbName, // Use wallet-specific database name
            storage: IndexDB,
            password: Buffer.from(hashedPassword).toString("hex")
        });

        const db = new SDK.Pluto(store, apollo);
        await db.start();

        // ✅ DEFENSIVE ERROR HANDLING: Gracefully handle corrupted messages
        // If message deserialization fails (e.g., UnsupportedAttachmentType), continue initialization
        let messages: SDK.Domain.Message[] = [];
        try {
            messages = await db.getAllMessages();
        } catch (messageError: any) {
            console.error('⚠️ [connectDatabase] Failed to load messages (possible corruption):', messageError.message);
            // Continue initialization - wallet can still function without messages
        }

        const connections = await db.getAllDidPairs()
        const credentials = await db.getAllCredentials();

        api.dispatch(
            reduxActions.dbPreload(
                { messages, connections, credentials }
            )
        );

        return api.fulfillWithValue({ db });
    } catch (err) {
        console.error('❌ [connectDatabase] Database connection failed:', err);
        return api.rejectWithValue(err as Error);
    }
});

export const refreshConnections = createAsyncThunk(
    'connections/refresh',
    async (_: void, api) => {
    try {
        const state = api.getState() as { app: { db: { instance: SDK.Domain.Pluto | null } } };
        const db = state.app.db.instance;

        if (!db) {
            console.error('❌ Database not connected in refreshConnections');
            throw new Error("Database not connected");
        }

        const connections = await db.getAllDidPairs();

        return { connections };
    } catch (err) {
        console.error('❌ RefreshConnections failed:', err);
        return api.rejectWithValue(err as Error);
    }
});

export const deleteConnection = createAsyncThunk<
    { success: boolean },
    { connectionHostDID: string },
    { state: { app: { db: { instance: SDK.Domain.Pluto | null } } } }
>(
    'connections/delete',
    async (options, api) => {
        try {
            const { connectionHostDID } = options;
            const state = api.getState() as { app: { db: { instance: SDK.Domain.Pluto | null } } };
            const db = state.app.db.instance;

            if (!db) {
                console.error('❌ [deleteConnection] Database not connected');
                throw new Error("Database not connected");
            }

            const allConnections = await db.getAllDidPairs();
            const connectionToDelete = allConnections.find(c => c.host.toString() === connectionHostDID);

            if (!connectionToDelete) {
                console.warn('⚠️ [deleteConnection] Connection not found:', connectionHostDID.substring(0, 50) + '...');
                throw new Error('Connection not found');
            }

            // ✅ STEP 1: Delete DIDLink records AND DIDs using three-tier fallback system
            console.log('🗑️ [deleteConnection] Starting deletion for connection:', connectionHostDID.substring(0, 50) + '...');
            console.log('🗑️ [deleteConnection] Connection details:', {
                hostDID: connectionToDelete.host.toString().substring(0, 50) + '...',
                receiverDID: connectionToDelete.receiver.toString().substring(0, 50) + '...',
                name: connectionToDelete.name
            });

            const {
                deleteConnectionUsingRepository,
                deleteConnectionUsingRxDB,
                deleteConnectionFromIndexedDB
            } = await import('../utils/connectionDeletion');

            let deletionResult = false;

            // Try METHOD 1: Repository Pattern (cleanest, uses SDK's internal API)
            console.log('🔧 [deleteConnection] Attempting Method 1: Repository Pattern...');
            try {
                deletionResult = await deleteConnectionUsingRepository(db, connectionHostDID);
                console.log(`✅ [deleteConnection] Repository method result: ${deletionResult}`);
            } catch (repoError) {
                console.error('❌ [deleteConnection] Repository method threw error:', repoError);
                deletionResult = false;
            }

            // Try METHOD 2: RxDB Collection Access (if Repository fails)
            if (!deletionResult) {
                console.warn('⚠️ [deleteConnection] Repository method failed, trying Method 2: RxDB...');
                try {
                    deletionResult = await deleteConnectionUsingRxDB(db, connectionHostDID);
                    console.log(`✅ [deleteConnection] RxDB method result: ${deletionResult}`);
                } catch (rxdbError) {
                    console.error('❌ [deleteConnection] RxDB method threw error:', rxdbError);
                    deletionResult = false;
                }
            }

            // Try METHOD 3: Direct IndexedDB (if RxDB fails)
            if (!deletionResult) {
                console.warn('⚠️ [deleteConnection] RxDB method failed, trying Method 3: Direct IndexedDB...');
                try {
                    deletionResult = await deleteConnectionFromIndexedDB(db, connectionHostDID);
                    console.log(`✅ [deleteConnection] IndexedDB method result: ${deletionResult}`);
                } catch (idbError) {
                    console.error('❌ [deleteConnection] IndexedDB method threw error:', idbError);
                    deletionResult = false;
                }
            }

            // All three methods failed
            if (!deletionResult) {
                console.error('❌ [deleteConnection] All three deletion methods failed');
                throw new Error('Failed to delete connection records after trying all methods');
            }

            console.log('✅ [deleteConnection] Connection deletion successful');


            // ✅ STEP 2: Delete all messages associated with this connection
            const allMessages = await db.getAllMessages();
            const associatedMessages = allMessages.filter(m =>
                m.from?.toString() === connectionToDelete.host.toString() ||
                m.to?.toString() === connectionToDelete.host.toString() ||
                m.from?.toString() === connectionToDelete.receiver.toString() ||
                m.to?.toString() === connectionToDelete.receiver.toString()
            );

            for (const message of associatedMessages) {
                try {
                    await db.deleteMessage(message.id);
                } catch (msgError) {
                    console.warn(`⚠️ [deleteConnection] Failed to delete message ${message.id}:`, msgError);
                }
            }

            // ✅ STEP 3: Return hostDID for direct Redux state mutation (no refresh needed)
            console.log('✅ [deleteConnection] Returning deletion result for Redux state update');
            return api.fulfillWithValue({
                success: true,
                hostDID: connectionHostDID
            });
        } catch (err) {
            console.error('❌ [deleteConnection] Failed to delete connection:', err);
            return api.rejectWithValue(err as Error);
        }
    }
);

export const refreshCredentials = createAsyncThunk(
    'credentials/refresh',
    async (_: void, api) => {
    try {
        console.log('🔄 [REFRESH] refreshCredentials called');
        const state = api.getState() as { app: { db: { instance: SDK.Domain.Pluto | null } } };
        const db = state.app.db.instance;

        if (!db) {
            console.error('❌ [REFRESH] Database not connected');
            throw new Error("Database not connected");
        }

        console.log('🗄️ [REFRESH] Fetching all credentials from IndexedDB...');
        const credentials = await db.getAllCredentials();

        console.log('📊 [REFRESH] Retrieved credentials from database:', credentials.length);

        // 🔍 DIAGNOSTIC: Log credential IDs and types
        console.log('🔍 [REFRESH] Credential details:',
            credentials.map(c => ({
                id: c.id,
                uuid: c.uuid,
                recoveryId: c.recoveryId,
                issuer: c.issuer,
                credentialType: c.credentialType || 'unknown',
                hasId: !!c.id,
                hasUuid: !!c.uuid,
                hasRecoveryId: !!c.recoveryId
            }))
        );

        // 🔍 DIAGNOSTIC: Check for duplicate IDs
        const idMap = new Map();
        const duplicateIds: string[] = [];
        credentials.forEach(c => {
            const id = c.id || c.uuid || c.recoveryId || 'no-id';
            if (idMap.has(id)) {
                duplicateIds.push(id);
                console.warn(`⚠️ [REFRESH] DUPLICATE ID DETECTED: ${id}`);
            }
            idMap.set(id, (idMap.get(id) || 0) + 1);
        });

        if (duplicateIds.length > 0) {
            console.error('❌ [REFRESH] CRITICAL: Found duplicate credential IDs:', duplicateIds);
            console.error('❌ [REFRESH] ID counts:', Object.fromEntries(idMap));
        }

        console.log('✅ [REFRESH] Returning credentials to reducer');
        return { credentials };
    } catch (err) {
        console.error('❌ [REFRESH] RefreshCredentials failed:', err);
        return api.rejectWithValue(err as Error);
    }
});

/**
 * Send verifiable presentation in response to a presentation request
 *
 * This thunk handles the complete presentation flow:
 * 1. Validates request and credential exist in Redux state
 * 2. Prepares the verifiable presentation using the SDK
 * 3. Sends the presentation message via DIDComm
 * 4. Updates Redux state to mark request as responded
 *
 * @param requestId - The ID of the presentation request
 * @param credentialId - The ID of the credential to present
 */
export const sendVerifiablePresentation = createAsyncThunk<
    void,
    { requestId: string; credentialId: string },
    { state: { app: RootState } }
>(
    'app/sendVerifiablePresentation',
    async ({ requestId, credentialId }, { getState, dispatch }) => {
        const state = getState().app;
        const agent = state.agent.instance;

        console.log('📤 [PRESENTATION] Starting presentation send process');
        console.log('📤 [PRESENTATION] Request ID:', requestId);
        console.log('📤 [PRESENTATION] Credential ID:', credentialId);

        if (!agent) {
            console.error('❌ [PRESENTATION] Agent not initialized');
            throw new Error('Agent not initialized');
        }

        // STEP 1: Find the presentation request in Redux state
        const request = state.presentationRequests.find(req => req.id === requestId);
        if (!request) {
            console.error('❌ [PRESENTATION] Request not found:', requestId);
            throw new Error(`Presentation request ${requestId} not found`);
        }

        console.log('✅ [PRESENTATION] Found presentation request');
        console.log('📋 [PRESENTATION] Request from:', request.from.substring(0, 50) + '...');
        console.log('📋 [PRESENTATION] Request status:', request.status);

        // STEP 2: Find the selected credential
        const credential = state.credentials.find(cred => cred.id === credentialId);
        if (!credential) {
            console.error('❌ [PRESENTATION] Credential not found:', credentialId);
            throw new Error(`Credential ${credentialId} not found`);
        }

        console.log('✅ [PRESENTATION] Found credential to present');
        console.log('📋 [PRESENTATION] Credential type:', credential.credentialType || 'Unknown');

        try {
            // STEP 3: Prepare the verifiable presentation using SDK
            console.log('🔧 [PRESENTATION] Preparing presentation using SDK...');
            const requestPresentation = RequestPresentation.fromMessage(request.requestMessage);
            const presentation = await agent.createPresentationForRequestProof(
                requestPresentation,
                credential
            );

            console.log('✅ [PRESENTATION] Presentation prepared successfully');

            // STEP 4: Send the presentation message via DIDComm
            console.log('📤 [PRESENTATION] Sending presentation message...');
            const presentationMessage = presentation.makeMessage();
            await agent.sendMessage(presentationMessage);

            console.log('✅ [PRESENTATION] Presentation sent successfully');
            console.log('📬 [PRESENTATION] Message ID:', presentationMessage.id);

            // STEP 5: Update Redux state to mark request as responded
            console.log('🔄 [PRESENTATION] Updating Redux state...');
            dispatch(reduxActions.presentationRequestResponded({ requestId }));

            console.log('✅ [PRESENTATION] Complete - presentation workflow finished');

        } catch (error: any) {
            console.error('❌ [PRESENTATION] Error during presentation send:', error);
            console.error('❌ [PRESENTATION] Error type:', error.constructor?.name);
            console.error('❌ [PRESENTATION] Error message:', error.message);
            console.error('❌ [PRESENTATION] Error stack:', error.stack);
            throw error; // Re-throw to be caught by UI
        }
    }
);

/**
 * Decline a presentation request
 *
 * Simply marks the request as declined in Redux state without sending
 * any response message to the requester.
 *
 * @param requestId - The ID of the presentation request to decline
 */
export const declinePresentation = createAsyncThunk<
    void,
    { requestId: string },
    { state: { app: RootState } }
>(
    'app/declinePresentation',
    async ({ requestId }, { getState, dispatch }) => {
        console.log('❌ [PRESENTATION] Declining presentation request:', requestId);

        const state = getState().app;

        // Verify request exists
        const request = state.presentationRequests.find(req => req.id === requestId);
        if (!request) {
            console.warn('⚠️ [PRESENTATION] Request not found when declining:', requestId);
            throw new Error(`Presentation request ${requestId} not found`);
        }

        console.log('📋 [PRESENTATION] Declining request from:', request.from.substring(0, 50) + '...');

        // Simply mark as declined in Redux state
        dispatch(reduxActions.presentationRequestDeclined({ requestId }));

        console.log('✅ [PRESENTATION] Request marked as declined');
    }
);