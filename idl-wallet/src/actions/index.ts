import { addRxPlugin } from "rxdb";

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
import { getConnectionMetadata, saveConnectionMetadata, updateConnectionMetadata } from '../utils/connectionMetadata';
import { getCredentialType } from '../utils/credentialTypeDetector';

// SecureDashboardBridge agent setter for Pluto fallback
import { setSecureDashboardAgent } from '../utils/SecureDashboardBridge';
import { setDocumentStorageWalletId } from '../utils/documentStorage';

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

        await pluto.deleteMessage(message.id);
        console.log('✅ [CREDENTIAL OFFER] Offer message deleted from IndexedDB:', message.id);
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

            await agent.pluto.deleteMessage(message.id);
            console.log('✅ [CREDENTIAL OFFER] Offer message deleted from IndexedDB:', message.id);

            // Refresh PRISM DIDs list so newly created DID appears in DID Management page
            api.dispatch(refreshPrismDIDs({ agent }));
            console.log('🔄 [CREDENTIAL OFFER] Refreshed PRISM DIDs list');

        } catch (err: any) {
            console.error('❌ Failed to send credential request:', err);
            console.error('❌ Error details:', JSON.stringify({
                message: err?.message,
                status: err?.status,
                statusCode: err?.statusCode,
                code: err?.code,
                name: err?.name,
            }));

            // Always delete the offer from Pluto on any sendMessage failure.
            // A failed send means the offer can never be accepted, and leaving it
            // in Pluto causes it to reappear on every wallet restart.
            try {
                await agent.pluto.deleteMessage(message.id);
                console.log('🗑️ [CREDENTIAL OFFER] Deleted failed offer from Pluto:', message.id);
            } catch (deleteErr) {
                console.warn('⚠️ [CREDENTIAL OFFER] Could not delete offer from Pluto:', deleteErr);
            }

            throw err;
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
    const issuedCredentials = externalMessages.filter((message) =>
        message.piuri === "https://didcomm.org/issue-credential/3.0/issue-credential" ||
        message.piuri === "https://didcomm.atalaprism.io/issue-credential/3.0/issue-credential"
    );
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

            // Entity-agnostic service discovery: persist connection metadata from VC contents
            const senderDID = issuedCredential.from?.toString();
            const accessTargetKey   = (credential.claims?.['accessTarget']   as any)?.value as string | undefined;
            const accessTargetLabel = (credential.claims?.['accessTargetLabel'] as any)?.value as string | undefined;
            const accessTargetIcon  = (credential.claims?.['accessTargetIcon']  as any)?.value as string | undefined;
            if (senderDID) {
                const currentState = (getState() as { app: RootState }).app;
                const matchingConn = currentState.connections?.find(
                    (c: SDK.Domain.DIDPair) => c.receiver.toString() === senderDID
                );
                if (matchingConn) {
                    const hostDID = matchingConn.host.toString();
                    const meta = getConnectionMetadata(hostDID);
                    const metaUpdates: Record<string, any> = {};

                    // Save the peer DID used by the remote party (for future reference)
                    if (!meta?.remotePartyDid) metaUpdates.remotePartyDid = senderDID;

                    // Auto-flag CA connections by credential type (entity-agnostic: no name checks)
                    const credType = getCredentialType(credential);
                    const CA_TYPES = ['RealPersonIdentity', 'SecurityClearance', 'CertificationAuthorityIdentity'];
                    if (CA_TYPES.includes(credType) && !meta?.isCAConnection) {
                        metaUpdates.isCAConnection = true;
                        console.log(`🔐 [IssueCredential] Marking connection as CA (credential type: ${credType})`);
                    }

                    // Persist explicit accessTarget if VC contains one
                    if (accessTargetKey) {
                        const newTarget = { key: accessTargetKey, label: accessTargetLabel ?? accessTargetKey, icon: accessTargetIcon ?? '🔗' };
                        const existing = meta?.supportedTargets ?? [];
                        if (!existing.some(t => t.key === newTarget.key)) {
                            metaUpdates.supportedTargets = [...existing, newTarget];
                            console.log(`🎯 [IssueCredential] Stored access target "${accessTargetKey}" for connection ${hostDID.substring(0, 40)}...`);
                        }
                    }

                    if (Object.keys(metaUpdates).length > 0) {
                        if (meta) {
                            updateConnectionMetadata(hostDID, metaUpdates);
                        } else {
                            saveConnectionMetadata(hostDID, { walletType: 'local', ...metaUpdates });
                        }
                    }
                }
            }
        }
    }

    // ✅ ENHANCED LOGGING: Show ALL external messages for debugging
    console.log(`📋 [handleMessages] External messages summary (${externalMessages.length} total):`);
    externalMessages.forEach((msg, idx) => {
        console.log(`  ${idx + 1}. piuri="${msg.piuri}"`);
        console.log(`      from="${msg.from?.toString().substring(0, 50)}..."`);
        console.log(`      direction=${msg.direction} (0=SENT, 1=RECEIVED)`);
    });

    // HANDLE BASIC MESSAGES: Chat messages — store and dispatch, no protocol action needed
    const BASIC_MESSAGE_PIURI = "https://didcomm.org/basicmessage/2.0/message";
    const basicMessages = externalMessages.filter(msg => msg.piuri === BASIC_MESSAGE_PIURI);
    if (basicMessages.length > 0) {
        console.log(`💬 [handleMessages] Received ${basicMessages.length} basic message(s) — will be dispatched to Redux`);
    }

    // AUTO-RESPOND: Security Clearance VC presentation requests
    // This enables automatic VC handshake without user approval (like TLS)
    console.log(`🔍 [AUTO-RESPONSE] Filtering for presentation requests...`);
    const PRESENTATION_REQUEST_PIURIS = new Set([
        "https://didcomm.atalaprism.io/present-proof/3.0/request-presentation",
        "https://didcomm.org/present-proof/3.0/request-presentation",
    ]);
    const presentationRequests = externalMessages.filter(
        (message) => {
            const isMatch = PRESENTATION_REQUEST_PIURIS.has(message.piuri);
            console.log(`  🔍 Message piuri="${message.piuri}" matches presentation request? ${isMatch}`);
            return isMatch;
        }
    );
    console.log(`🔍 [AUTO-RESPONSE] Found ${presentationRequests.length} presentation request(s)`);

    // HANDLE CONNECTION REQUESTS: Detect and log for visibility
    console.log(`🔍 [CONNECTION REQUEST] Filtering for connection requests...`);
    const CONNECTION_REQUEST_PIURIS = new Set([
        SDK.ProtocolType.DidcommconnectionRequest,
        "https://didcomm.org/didexchange/1.0/request",
    ]);
    const connectionRequests = externalMessages.filter(
        (message) => {
            const isMatch = CONNECTION_REQUEST_PIURIS.has(message.piuri);

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

                // Parse once up front — reused below both for the domain-based schema hint
                // and for the later presentation_definition field extraction.
                const requestPresentation = RequestPresentation.fromMessage(requestMessage);

                try {
                    // The Cloud Agent (verified live, 2026-07) does NOT forward goalCode/goal/
                    // comment/claims/proofTypes into the actual DIDComm wire message for JWT-format
                    // present-proof requests — presentation_definition.input_descriptors is always
                    // empty and requestMessage.body carries none of those fields, so every check
                    // below this one has nothing to match against and schemaId ends up undefined.
                    // `options.domain` is the one request-configurable field confirmed (via a live
                    // GET on the Cloud Agent's own presentation record) to survive to the wire
                    // message unmodified, so the server side encodes the requested schema into it
                    // (see certification-authority/server.js and company-admin-portal/server.js).
                    const attachmentOptions = (requestPresentation.decodedAttachments?.at(0) as any)?.options;
                    const requestDomain = attachmentOptions?.domain;
                    if (requestDomain && typeof requestDomain === 'string') {
                        const DOMAIN_SCHEMA_HINTS: Array<[string, string]> = [
                            ['realperson', 'RealPerson'],
                            ['clearance', 'SecurityClearance'],
                            ['employeerole', 'EmployeeRole'],
                        ];
                        const lowerDomain = requestDomain.toLowerCase();
                        const hint = DOMAIN_SCHEMA_HINTS.find(([token]) => lowerDomain.includes(token));
                        if (hint) {
                            schemaId = hint[1];
                        }
                    }

                    // Access RAW message body before SDK parsing

                    if (!schemaId && rawBody && typeof rawBody === 'object') {
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

                        // Fallback: Try goal_code field. The CA sends goalCode as "schema:RealPerson" /
                        // "schema:SecurityClearance" (same convention as the goal/comment fields above),
                        // so try that pattern here too — not just the older literal goal codes below.
                        if (!schemaId && (rawBody as any).goal_code && typeof (rawBody as any).goal_code === 'string') {
                            const goalCode = (rawBody as any).goal_code;
                            const goalCodeSchemaMatch = goalCode.match(/schema:([A-Za-z0-9_-]+)/);
                            if (goalCodeSchemaMatch) {
                                schemaId = goalCodeSchemaMatch[1];
                            } else if (goalCode === 'authentication.identity') {
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
                                        'ba309a53-9661-33df-92a3-2023b4a56fd5': 'SecurityClearance',
                                        '6c39cc8e-b292-30aa-bbef-98ca2fdc6abe': 'EmployeeRole'
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
                            // Check for EmployeeRole pattern (email, prismDid, role, department)
                            else if (claims.email !== undefined && claims.prismDid !== undefined) {
                                schemaId = 'EmployeeRole';
                            }
                        }
                    }
                    // ✅ SMART FIX: No dangerous fallback - if schema unclear, show modal for user selection
                } catch (err) {
                    console.warn('⚠️ [VC-HANDSHAKE] Could not extract schema ID:', err);
                }

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

                // EmployeeRole proof requests must never be handled by the personal wallet.
                // They are an enterprise-domain operation: the enterprise wallet sends the
                // access request via the enterprise DIDComm channel, and the proof request
                // is answered entirely via EnterpriseAgentClient REST calls in connections.tsx.
                // If one arrives here it means routing is wrong — log and skip silently.
                if (schemaId === 'EmployeeRole') {
                    console.warn('⚠️ [VC-HANDSHAKE] EmployeeRole proof request received on personal wallet channel — routing error, skipping. Portal login must use the enterprise DIDComm channel.');
                    continue;
                }

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
                            // For EmployeeRole, match credentials with prismDid + email + role + department
                            if (schemaId === 'EmployeeRole') {
                                const cs = (cred as any).credentialSubject;
                                if (cs?.prismDid && cs?.email && cs?.role && cs?.department) return true;
                                if (cred.claims && cred.claims.length > 0) {
                                    const c = cred.claims[0];
                                    if (c.prismDid && c.email && c.role && c.department) return true;
                                }
                            }
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
                            return levelB - levelA; // Descending order (SECRET=4 > RESTRICTED=3 > CONFIDENTIAL=2)
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
            await agent.startFetchingMessages(5); // Poll every 5 seconds (SDK takes seconds, multiplies by 1000 internally)

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
                await agent.startFetchingMessages(5); // SDK takes seconds
                console.log('✅ [startAgent] Message polling started (after DIDComm error recovery)');
            } else {
                // Re-throw other unexpected errors
                throw startError;
            }
        }

        // Register all connection peer DIDs with mediator keylist.
        // This must run regardless of whether agent.start() took the happy path or the
        // DIDComm-error recovery path — the error path previously skipped this block,
        // leaving the receiver's peer DIDs unregistered and causing the mediator to drop
        // inbound messages silently.
        try {
            if (agent.connectionManager?.mediationHandler) {
                const allPairs = await agent.pluto.getAllDidPairs();
                if (allPairs.length > 0) {
                    const hostDIDs = allPairs.map((p: any) => p.host);
                    await agent.connectionManager.mediationHandler.updateKeyListWithDIDs(hostDIDs);
                    console.log(`✅ [startAgent] Registered ${hostDIDs.length} peer DID(s) with mediator keylist`);
                }
            } else {
                console.warn('⚠️ [startAgent] mediationHandler not available — peer DIDs not registered with mediator');
            }
        } catch (mediatorError: any) {
            console.warn('⚠️ [startAgent] Failed to register peer DIDs with mediator on startup:', mediatorError?.message);
        }

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
    // Using empty claims object to accept any credential — validateSecurityClearanceVC()
    // does the real issuer/schema/clearanceLevel checks after receipt.
    // NOTE: requesting a claim with an empty filter object (e.g. `{ clearanceLevel: {} }`)
    // triggers a bug in the SDK's Pollux.validateInputDescriptor: an empty filter `{}` is
    // truthy but has no .pattern/.enum/.const, so that code path can never mark the field
    // valid even when it genuinely exists in the credential — agent.handlePresentation()
    // would then always reject the presentation. Keep this claims filter empty.
    const presentationClaims: PresentationClaims<SDK.Domain.CredentialType> = {
        claims: {}
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

                    // 🔒 SECURITY: Reject multi-attachment responses outright. agent.handlePresentation()
                    // (below) only cryptographically verifies attachments[0]'s descriptor-mapped credential
                    // (SDK's HandlePresentation.run() reads presentation.attachments.at(0) only) — if we
                    // let extraction scan the full attachments array afterward, a forged extra attachment
                    // could ride along unverified and still be picked up as "the" recipient VC. A legitimate
                    // single-VC presentation_submission only ever carries one attachment.
                    if (!presentationResponse.attachments || presentationResponse.attachments.length !== 1) {
                        clearInterval(checkInterval);
                        reject(new Error('Recipient presentation has an unexpected number of attachments — rejecting as potentially forged.'));
                        return;
                    }

                    // 🔒 SECURITY: Cryptographically verify the presentation BEFORE trusting
                    // any of its claims (clearanceLevel, x25519PublicKey). Without this, the
                    // fields below are parsed from an unsigned JSON payload — any peer could
                    // fabricate a fake Security Clearance VC claiming arbitrary clearance.
                    // Reuses the same SDK verification path as the "Verify the Proof" button
                    // in components/Message.tsx (agent.handlePresentation resolves the issuer
                    // DID and checks the JWS signature via Pollux; it throws or returns false
                    // on any forged/unsigned/tampered presentation).
                    console.log('🔒 [VC-HANDSHAKE] Verifying presentation signature via agent.handlePresentation()...');
                    try {
                        const verified = await agent.handlePresentation(SDK.Presentation.fromMessage(presentationResponse));
                        if (!verified) {
                            clearInterval(checkInterval);
                            reject(new Error('Recipient presentation failed cryptographic verification — cannot trust claimed clearance.'));
                            return;
                        }
                        console.log('✅ [VC-HANDSHAKE] Presentation cryptographically verified');
                    } catch (verifyError: any) {
                        clearInterval(checkInterval);
                        reject(new Error(`Recipient presentation verification failed: ${verifyError.message || 'invalid or forged credential'}`));
                        return;
                    }

                    // ✅ FIX: Extract VC directly from presentation response attachments
                    // instead of searching database (avoids DID type mismatch issues)
                    // (attachments.length is guaranteed 1 here, so this extracts exactly the
                    // attachment that was just cryptographically verified above — not a scan
                    // of an independently-untrusted array)
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
    // Empty claims filter — see rationale in initiateVCHandshake() above (a non-empty
    // but pattern/enum/const-less filter object breaks Pollux's validateInputDescriptor).
    const presentationClaims: PresentationClaims<SDK.Domain.CredentialType> = {
        claims: {}
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

                    // 🔒 SECURITY: Reject multi-attachment responses — see identical guard and
                    // rationale in initiateVCHandshake() above (handlePresentation only verifies
                    // attachments[0]; extraction must not scan a wider, unverified array).
                    if (!presentationResponse.attachments || presentationResponse.attachments.length !== 1) {
                        clearInterval(checkInterval);
                        reject(new Error('Sender presentation has an unexpected number of attachments — rejecting as potentially forged.'));
                        return;
                    }

                    // 🔒 SECURITY: Cryptographically verify the presentation BEFORE trusting any of
                    // its claims (clearanceLevel), same rationale and API as initiateVCHandshake()
                    // above — this function previously trusted SDK.JWTCredential.fromJWS() output
                    // (no signature check) gated only by a plain string/field match.
                    console.log('🔒 [ensureSenderVC] Verifying presentation signature via agent.handlePresentation()...');
                    try {
                        const verified = await agent.handlePresentation(SDK.Presentation.fromMessage(presentationResponse));
                        if (!verified) {
                            clearInterval(checkInterval);
                            reject(new Error('Sender presentation failed cryptographic verification — cannot trust claimed clearance.'));
                            return;
                        }
                        console.log('✅ [ensureSenderVC] Presentation cryptographically verified');
                    } catch (verifyError: any) {
                        clearInterval(checkInterval);
                        reject(new Error(`Sender presentation verification failed: ${verifyError.message || 'invalid or forged credential'}`));
                        return;
                    }

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
                        // recipientVC is used locally for this send only — NOT stored in own wallet credentials
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

/**
 * Send a DIDComm service-access/1.0 request message to a connection.
 * The body is a JSON protocol envelope transported inside a BasicMessage,
 * because the Cloud Agent only fires webhooks for BasicMessage piuri.
 * Protocol: https://identuslabel.cz/protocols/service-access/1.0/request
 * (see packages/service-access-didcomm/PROTOCOL.md)
 */
export const sendProtocolAccessRequest = createAsyncThunk<
    void,
    { agent: SDK.Agent; connection: SDK.Domain.DIDPair; target: string }
>('sendProtocolAccessRequest', async ({ agent, connection, target }, api) => {
    const requestId = `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const protocolEnvelope = JSON.stringify({
        type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
        id: requestId,
        body: { capability: target }
    });

    // Wrap in StandardMessageBody (matches the format the CA unwraps)
    const standardBody = createPlaintextMessageBody(protocolEnvelope);
    const basicMsgBody = { content: JSON.stringify(standardBody) };

    const finalMessage = new BasicMessage(
        basicMsgBody as any,
        connection.host,
        connection.receiver
    ).makeMessage();

    await agent.sendMessage(finalMessage);

    try {
        const existing = await agent.pluto.getMessage(finalMessage.id);
        if (!existing) await agent.pluto.storeMessage(finalMessage);
    } catch (_) { /* non-fatal */ }

    api.dispatch(reduxActions.messageSuccess([finalMessage]));
});

// ── Document Service DIDComm Protocol Thunks ────────────────────────────────

/**
 * Send a document upload request to the document service connection.
 * File is base64-encoded in the attachment; the service will request VP proof next.
 */
export const sendDocumentUploadRequest = createAsyncThunk<
    void,
    {
        agent: SDK.Agent;
        connection: SDK.Domain.DIDPair;
        title: string;
        clearanceLevel: string;
        releasableTo: string[];
        fileBuffer: ArrayBuffer;
        filename: string;
        mimeType: string;
    }
>('sendDocumentUploadRequest', async ({ agent, connection, title, clearanceLevel, releasableTo, fileBuffer, filename, mimeType }, api) => {
    const requestId = `dup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const base64Data = Buffer.from(fileBuffer).toString('base64');

    const protocolEnvelope = JSON.stringify({
        type: 'https://identuslabel.cz/protocols/document-upload/1.0/request',
        id: requestId,
        body: { title, clearanceLevel, releasableTo, filename, department: null },
        attachments: [{ id: 'file', mediaType: mimeType, data: { base64: base64Data } }]
    });

    const basicMsgBody = { content: protocolEnvelope };
    const finalMessage = new BasicMessage(
        basicMsgBody as any,
        connection.host,
        connection.receiver
    ).makeMessage();

    await agent.sendMessage(finalMessage);
    try {
        const existing = await agent.pluto.getMessage(finalMessage.id);
        if (!existing) await agent.pluto.storeMessage(finalMessage);
    } catch (_) { /* non-fatal */ }
    api.dispatch(reduxActions.messageSuccess([finalMessage]));
});

/**
 * Send a document branch (update/fork) request to the document service connection.
 */
export const sendDocumentBranchRequest = createAsyncThunk<
    void,
    {
        agent: SDK.Agent;
        connection: SDK.Domain.DIDPair;
        parentDocumentDID: string;
        title: string;
        clearanceLevel?: string;
        releasableTo?: string[];
        fileBuffer: ArrayBuffer;
        filename: string;
        mimeType: string;
    }
>('sendDocumentBranchRequest', async ({ agent, connection, parentDocumentDID, title, clearanceLevel, releasableTo, fileBuffer, filename, mimeType }, api) => {
    const requestId = `dbr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const base64Data = Buffer.from(fileBuffer).toString('base64');

    const protocolEnvelope = JSON.stringify({
        type: 'https://identuslabel.cz/protocols/document-upload/1.0/branch',
        id: requestId,
        body: { parentDocumentDID, title, clearanceLevel, releasableTo, filename },
        attachments: [{ id: 'file', mediaType: mimeType, data: { base64: base64Data } }]
    });

    const basicMsgBody = { content: protocolEnvelope };
    const finalMessage = new BasicMessage(
        basicMsgBody as any,
        connection.host,
        connection.receiver
    ).makeMessage();

    await agent.sendMessage(finalMessage);
    try {
        const existing = await agent.pluto.getMessage(finalMessage.id);
        if (!existing) await agent.pluto.storeMessage(finalMessage);
    } catch (_) { /* non-fatal */ }
    api.dispatch(reduxActions.messageSuccess([finalMessage]));
});

/**
 * Send a DIDComm document access request. Service will request VP, then deliver a DEK via a
 * service-access/1.0 grant (capability: "document-access", mode: "payload") — see
 * packages/service-access-didcomm/PROTOCOL.md. `documentDID` rides along as a capability-
 * specific field in `body` (the protocol's `request` message allows extra fields beyond
 * `capability` itself for exactly this).
 */
export const sendDocumentAccessRequest = createAsyncThunk<
    void,
    { agent: SDK.Agent; connection: SDK.Domain.DIDPair; documentDID: string }
>('sendDocumentAccessRequest', async ({ agent, connection, documentDID }, api) => {
    const requestId = `dar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const protocolEnvelope = JSON.stringify({
        type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
        id: requestId,
        body: { capability: 'document-access', documentDID }
    });

    const basicMsgBody = { content: protocolEnvelope };
    const finalMessage = new BasicMessage(
        basicMsgBody as any,
        connection.host,
        connection.receiver
    ).makeMessage();

    await agent.sendMessage(finalMessage);
    try {
        const existing = await agent.pluto.getMessage(finalMessage.id);
        if (!existing) await agent.pluto.storeMessage(finalMessage);
    } catch (_) { /* non-fatal */ }
    api.dispatch(reduxActions.messageSuccess([finalMessage]));
});

// Connection states this custom Cloud Agent build reports as "handshake complete, usable for
// messaging" — same list used at pages/connections.tsx:179/998 and pages/messages.tsx:189.
const DOC_SERVICE_ACTIVE_STATES = new Set(['ConnectionResponseSent', 'ConnectionResponseReceived', 'Active', 'ACTIVE', 'active']);

// Guards concurrent callers (e.g. a double-click) from racing past the listConnections() check
// and each minting their own "Document Service" connection before either finishes.
let _docServiceConnectionPromise: Promise<string> | null = null;

/**
 * Reuse an existing "Document Service" connection on the enterprise agent if one is already
 * usable, instead of always requesting a fresh OOB invitation. The enterprise agent's connection
 * list is server-side (shared across browsers/devices for the company), so this also dedupes
 * across sessions, not just within one — it's what previously caused a distinct connection to be
 * minted on every login (see /connect always returning a brand-new invitation, and this caller
 * unconditionally accepting it).
 */
async function getOrCreateDocumentServiceConnection(client: any, DOC_SERVICE_BASE: string): Promise<string> {
    if (_docServiceConnectionPromise) return _docServiceConnectionPromise;

    _docServiceConnectionPromise = (async () => {
        const listResp = await client.listConnections().catch((e: any) => {
            console.warn('[DocService] listConnections() threw, will create a new connection:', e?.message || e);
            return null;
        });
        if (listResp && !listResp.success) {
            console.warn('[DocService] listConnections() returned an error, will create a new connection:', listResp.error);
        }
        // Match on goalCode, not label: this Cloud Agent build only persists/returns `label` for
        // the inviter side of a connection — the wallet is always the Invitee here, and its
        // connection records come back with an empty label regardless of what was passed to
        // acceptInvitation(). goalCode ("document-access", set by DocumentDIDCommService's
        // createConnectionInvitation) survives on both sides and is what's actually queryable.
        const existing = (listResp?.data?.contents || []).find((c: any) =>
            (c?.goalCode === 'document-access' || c?.label === 'Document Service') && DOC_SERVICE_ACTIVE_STATES.has(c?.state)
        );
        if (existing?.connectionId) {
            return existing.connectionId as string;
        }

        const connectRes = await fetch(`${DOC_SERVICE_BASE}/connect`);
        const connectJson = await connectRes.json();
        if (!connectRes.ok || !connectJson.success) {
            throw new Error(connectJson.message || connectJson.error || 'Could not get a document service invitation');
        }
        const inv = connectJson.invitation;
        const invitationUrl = inv?.invitation?.invitationUrl || inv?.invitationUrl || inv?.invitation || inv;
        if (!invitationUrl || typeof invitationUrl !== 'string') {
            throw new Error('Document service returned no invitation URL');
        }

        // serviceDid is Document Service's own published, stable identity — distinct from the
        // peer DID this invitation will establish for the connection itself (see
        // DocumentServiceStartup.js's _ensureServiceDid). It isn't used to gate the connection
        // (an older, not-yet-upgraded deployment simply won't send it), but surfacing it lets an
        // operator pin it into idl-wallet/src/config/serviceTrust.ts's TRUSTED_SERVICES, the way
        // that file's own doc comment already anticipates for a service with one fixed DID.
        if (connectJson.serviceDid) {
            console.info(`[DocService] Connected to Document Service, published DID: ${connectJson.serviceDid}`);
        } else {
            console.warn('[DocService] Document service did not return a serviceDid — deployment may need updating');
        }

        const acceptResp = await client.acceptInvitation(invitationUrl, 'Document Service');
        const connectionId = acceptResp?.data?.connectionId;
        if (!acceptResp?.success || !connectionId) {
            throw new Error(acceptResp?.error || 'Failed to connect to the document service');
        }
        return connectionId as string;
    })();

    try {
        return await _docServiceConnectionPromise;
    } finally {
        _docServiceConnectionPromise = null;
    }
}

/**
 * Request document access via the ENTERPRISE-AGENT channel (correct holder binding for
 * enterprise-custodied credentials — the enterprise agent holds the credential subject key and
 * signs the challenge-bound VP, per SSI proof-of-possession requirements).
 *
 * Flow:
 *   1. Reuse an existing DIDComm connection to the document service on the enterprise agent, or
 *      open a new one (via /connect) if none is usable yet.
 *   2. Send a service-access/1.0 "document-access" request over it (carries the ephemeral X25519
 *      public key the DEK will be sealed to).
 *   3. The document service sends a present-proof RequestPresentation to the enterprise wallet;
 *      the running enterprise proof poller surfaces it in UnifiedProofRequestModal, the user
 *      approves, and the enterprise agent signs the challenge-bound VP.
 *   4. The document service independently verifies the VP and posts a grant (DEK nacl.box-sealed
 *      to our ephemeral key + Iagon link) to an HTTP-pollable transport keyed by requestId.
 *   5. We poll access-grant-status and return the grant for the caller to decrypt.
 */
export const requestDocumentAccessViaEnterprise = createAsyncThunk<
    { sections: any[]; iagonDownloadUrl: string; filename?: string; documentDID: string },
    { documentDID: string; ephemeralPublicKey: string; timeoutMs?: number }
>('requestDocumentAccessViaEnterprise', async ({ documentDID, ephemeralPublicKey, timeoutMs = 3 * 60 * 1000 }, api) => {
    const DOC_SERVICE_BASE = 'https://identuslabel.cz/document-service';
    const state = api.getState() as RootState;
    const client: any = (state as any).enterpriseAgent?.client;
    if (!client) {
        throw new Error('Company wallet not configured — cannot request document access via the enterprise agent.');
    }

    const connectionId = await getOrCreateDocumentServiceConnection(client, DOC_SERVICE_BASE);

    // 2. Wait until the connection is usable before messaging over it (no-op if reused, since
    //    it was already filtered to an active state above).
    const connDeadline = Date.now() + 30000;
    while (Date.now() < connDeadline) {
        const c = await client.getConnection(connectionId);
        const st = c?.data?.state;
        if (st && st !== 'InvitationGenerated' && st !== 'ConnectionRequestPending') break;
        await new Promise(r => setTimeout(r, 1500));
    }

    // 3. Send the service-access/1.0 document-access request (with the ephemeral key to seal the DEK to).
    //    - requestId: high-entropy UUID (not a guessable timestamp) so the grant poll can't be raced.
    //    - accessToken: a fresh secret that gates grant retrieval (server binds consumeGrant to it).
    //    - ts: request timestamp so the service can reject stale/replayed requests.
    const requestId = `dar-${crypto.randomUUID()}`;
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const accessToken = btoa(String.fromCharCode(...tokenBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const envelope = JSON.stringify({
        type: 'https://identuslabel.cz/protocols/service-access/1.0/request',
        id: requestId,
        body: { capability: 'document-access', documentDID, ephemeralPublicKey, accessToken, ts: Date.now() }
    });
    const sendResp = await client.sendBasicMessage(connectionId, envelope);
    if (!sendResp?.success) {
        throw new Error(sendResp?.error || 'Failed to send the access request to the document service');
    }

    // 4. Poll for the grant. Meanwhile the user approves the incoming proof request in the wallet.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2500));
        try {
            const gs = await fetch(`${DOC_SERVICE_BASE}/access-grant-status?requestId=${encodeURIComponent(requestId)}&token=${encodeURIComponent(accessToken)}`);
            const gj = await gs.json();
            if (gj.status === 'granted' && gj.grant) {
                // service-access/1.0 `mode: "payload"` grants nest the capability payload
                // (sections, iagonDownloadUrl, deliveryId) under `grant.result` — the outer
                // object only carries protocol metadata (capability, label, mode, expiresAt).
                const payload = gj.grant.result || gj.grant;
                return { ...payload, documentDID };
            }
            if (gj.status === 'error') {
                throw new Error(gj.message || gj.error || 'Document access denied');
            }
        } catch (e: any) {
            // Network blips are transient; keep polling until the deadline.
            if (e?.message && /denied|rejected/i.test(e.message)) throw e;
        }
    }
    throw new Error('Timed out waiting for the document access grant — did you approve the credential request in your wallet?');
});

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
        const url = "https://identuslabel.cz/cloud-agent/dids/" + didString;
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
        username?: string,
    },
    { state: { app: RootState } }
>("connectDatabase", async (options, api) => {
    try {
        const state = api.getState().app;
        const hashedPassword = sha512(options.encryptionKey)

        // Use username-specific DB name when provided for per-user isolation
        const dbName = options.username
            ? `identus-wallet-idl-${options.username.toLowerCase()}`
            : state.wallet.dbName;

        if (options.username) {
            api.dispatch(reduxActions.setUsername(options.username));
            // Scope the 4 hand-rolled per-user IndexedDB stores (connection requests,
            // invitation states, message rejections, classified documents) to this user —
            // same derivation as the Pluto dbName suffix above, so it's consistent.
            const walletId = options.username.toLowerCase();
            api.dispatch(reduxActions.setWalletId(walletId));
            setDocumentStorageWalletId(walletId);
        }

        const apollo = new SDK.Apollo();
        const store = new SDK.Store({
            name: dbName,
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
 * Delete a credential from Pluto (IndexedDB) and refresh Redux credentials state.
 *
 * Used when the user removes a ServiceConfiguration VC so it cannot be
 * re-discovered by syncCredentialsToStorage on the next render.
 *
 * @param vcId - The credential's `id` or `uuid` field
 */
export const deleteCredentialByVcId = createAsyncThunk(
    'credentials/deleteByVcId',
    async (vcId: string, api) => {
        const state = api.getState() as { app: { db: { instance: SDK.Domain.Pluto | null }, credentials: SDK.Domain.Credential[] } };
        const db = state.app.db.instance;

        if (!db) {
            throw new Error('Database not connected');
        }

        // Find matching VC by id or uuid
        const vc = state.app.credentials.find(
            (c: SDK.Domain.Credential) => (c as any).id === vcId || (c as any).uuid === vcId
        );

        if (vc) {
            console.log('[deleteCredentialByVcId] Deleting VC from Pluto:', vcId);
            await db.deleteCredential(vc);
        } else {
            console.warn('[deleteCredentialByVcId] VC not found in Redux state, vcId:', vcId);
        }

        // Reload credentials from Pluto so Redux reflects the deletion
        api.dispatch(refreshCredentials());

        return vcId;
    }
);

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

// ─────────────────────────────────────────────────────────────────────────────
// IAGON WALLET BACKUP / RESTORE
// ─────────────────────────────────────────────────────────────────────────────

import { encryptBackup, decryptBackup, generateCredentialHash, generateContentHash, WalletBackupPayload } from '../utils/walletCrypto';

/**
 * backupToIagon
 *
 * 1. Calls agent.backup.createJWE() to get a full SDK backup token.
 * 2. Encrypts the JWE + seed bytes client-side (PBKDF2 + AES-256-GCM).
 * 3. POSTs the encrypted blob to /api/wallet/upload for server-side Iagon storage.
 */
export const backupToIagon = createAsyncThunk<
    void,
    { username: string; password: string },
    { state: { app: RootState } }
>('app/backupToIagon', async ({ username, password }, { getState, dispatch }) => {
    dispatch(reduxActions.setIagonBackupStatus({ status: 'uploading' }));
    try {
        const state = getState().app;
        const agent = state.agent.instance;
        if (!agent) throw new Error('Agent not started');

        const credHash = await generateCredentialHash(username, password);
        const jwe: string = await (agent as any).backup.createJWE();
        const contentHash = await generateContentHash(jwe);

        const payload: WalletBackupPayload = {
            version: 2,
            username,
            createdAt: new Date().toISOString(),
            seedValue: Array.from(state.defaultSeed.value),
            jwe,
        };

        const encryptedBase64 = await encryptBackup(payload, password, username);

        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const response = await fetch(`${basePath}/api/wallet/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credHash, contentHash, data: encryptedBase64 }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Upload failed');
        }

        dispatch(reduxActions.setIagonBackupStatus({ status: 'synced' }));
        console.log('✅ [backupToIagon] Wallet backed up to Iagon successfully');
    } catch (err: any) {
        console.error('❌ [backupToIagon] Failed:', err.message);
        dispatch(reduxActions.setIagonBackupStatus({ status: 'error', error: err.message }));
        throw err;
    }
});

/**
 * restoreFromIagon
 *
 * 1. Downloads encrypted backup from /api/wallet/download.
 * 2. Decrypts client-side with password.
 * 3. Stores the restored seed in Redux (initAgent will pick it up).
 * 4. Calls agent.backup.restore(jwe) to re-populate IndexedDB.
 * 5. Refreshes Redux state from the restored DB.
 */
export const restoreFromIagon = createAsyncThunk<
    { restored: true },
    { username: string; password: string },
    { state: { app: RootState } }
>('app/restoreFromIagon', async ({ username, password }, { getState, dispatch }) => {
    dispatch(reduxActions.setIagonBackupStatus({ status: 'downloading' }));
    try {
        const credHash = await generateCredentialHash(username, password);

        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const downloadRes = await fetch(`${basePath}/api/wallet/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credHash }),
        });

        if (!downloadRes.ok) {
            const err = await downloadRes.json();
            throw new Error(err.error || 'Download failed');
        }

        const { data: encryptedBase64 } = await downloadRes.json();

        dispatch(reduxActions.setIagonBackupStatus({ status: 'restoring' }));

        const payload = await decryptBackup(encryptedBase64, password, username);

        // Restore the seed so the next initAgent call uses the correct keys
        const restoredSeed: SDK.Domain.Seed = {
            value: new Uint8Array(payload.seedValue),
            size: payload.seedValue.length,
        };
        dispatch(reduxActions.setDefaultSeed(restoredSeed));

        // Restore wallet data via SDK JWE restore
        const state = getState().app;
        const agent = state.agent.instance;
        if (!agent) throw new Error('Agent not available for restore');

        // Clear the RxDB/Dexie store before restore.
        // agent.backup.restore() calls assertStoreIsEmpty() which fails if any data exists.
        // pluto-encrypted uses RxDB+Dexie: each collection is a SEPARATE Dexie database
        // named `rxdb-dexie-${dbName}--${schemaVersion}--${collectionName}`.
        // Strategy: stop Pluto (destroys the running RxDB instance), then delete all matching
        // per-collection Dexie IDB databases via indexedDB.deleteDatabase(), then restart Pluto.
        // We know dbHasData was false so no user data is lost.
        const db = state.db.instance;
        if (db) {
            try {
                // 1. Stop Pluto — destroys the live RxDB instance cleanly
                await (db as any).stop?.();

                // 2. Drop all rxdb-dexie IDB databases for this user
                if (typeof window !== 'undefined' && typeof (window.indexedDB as any).databases === 'function') {
                    const allDbs: { name: string }[] = await (window.indexedDB as any).databases();
                    const prefix = `rxdb-dexie-identus-wallet-idl-${username.toLowerCase()}`;
                    const toDelete = allDbs.filter((d) => d.name?.startsWith(prefix));
                    await Promise.all(toDelete.map((d) =>
                        new Promise<void>((resolve) => {
                            const req = window.indexedDB.deleteDatabase(d.name);
                            req.onsuccess = () => resolve();
                            req.onerror   = () => resolve();
                        })
                    ));
                    console.log(`🧹 [restoreFromIagon] Deleted ${toDelete.length} Dexie IDB databases for clean restore`);
                }

                // 3. Restart Pluto — creates fresh empty RxDB + collections
                await (db as any).start?.();
            } catch (clearErr: any) {
                console.warn('⚠️ [restoreFromIagon] DB clear failed, attempting restore anyway:', clearErr.message);
            }
        }

        await (agent as any).backup.restore(payload.jwe);

        // Refresh Redux state from restored DB
        if (db) {
            let messages: SDK.Domain.Message[] = [];
            try { messages = await db.getAllMessages(); } catch { /* ignore */ }
            const connections = await db.getAllDidPairs();
            const credentials = await db.getAllCredentials();
            dispatch(reduxActions.dbPreload({ messages, connections, credentials }));
        }

        dispatch(reduxActions.setIagonBackupStatus({ status: 'synced' }));
        console.log('✅ [restoreFromIagon] Wallet restored from Iagon successfully');
        return { restored: true };
    } catch (err: any) {
        console.error('❌ [restoreFromIagon] Failed:', err.message);
        dispatch(reduxActions.setIagonBackupStatus({ status: 'error', error: err.message }));
        throw err;
    }
});

/**
 * syncWalletBackup
 *
 * Called at startup for all wallets (new and returning).
 * Computes SHA-256 of the current JWE and compares it to the stored contentHash.
 * Uploads a new backup only when the wallet content has actually changed.
 */
export const syncWalletBackup = createAsyncThunk<
    { skipped: boolean },
    { username: string; password: string },
    { state: { app: RootState } }
>('app/syncWalletBackup', async ({ username, password }, { getState, dispatch }) => {
    try {
        const state = getState().app;
        const agent = state.agent.instance;
        if (!agent) return { skipped: true };

        const credHash = await generateCredentialHash(username, password);
        const jwe: string = await (agent as any).backup.createJWE();
        const currentContentHash = await generateContentHash(jwe);

        // Check what the server has stored
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const checkRes = await fetch(`${basePath}/api/wallet/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credHash }),
        });
        const checkData = await checkRes.json();

        if (checkData.exists && checkData.contentHash === currentContentHash) {
            console.log('✅ [syncWalletBackup] Backup up to date, skipping upload');
            dispatch(reduxActions.setIagonBackupStatus({ status: 'synced' }));
            return { skipped: true };
        }

        console.log('🔄 [syncWalletBackup] Content changed, uploading new backup...');
        dispatch(reduxActions.setIagonBackupStatus({ status: 'uploading' }));

        const payload: WalletBackupPayload = {
            version: 2,
            username,
            createdAt: new Date().toISOString(),
            seedValue: Array.from(state.defaultSeed.value),
            jwe,
        };
        const encryptedBase64 = await encryptBackup(payload, password, username);

        const uploadRes = await fetch(`${basePath}/api/wallet/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credHash, contentHash: currentContentHash, data: encryptedBase64 }),
        });

        if (!uploadRes.ok) {
            const err = await uploadRes.json();
            throw new Error(err.error || 'Sync upload failed');
        }

        dispatch(reduxActions.setIagonBackupStatus({ status: 'synced' }));
        console.log('✅ [syncWalletBackup] Sync backup uploaded successfully');
        return { skipped: false };
    } catch (err: any) {
        console.error('❌ [syncWalletBackup] Failed:', err.message);
        dispatch(reduxActions.setIagonBackupStatus({ status: 'error', error: err.message }));
        throw err;
    }
});