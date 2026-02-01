/**
 * CAConnectionEnforcementModal Component
 *
 * Blocking modal that enforces CA connection establishment.
 * Appears when user visits Connections tab without an existing CA connection.
 *
 * Features:
 * - Cannot be dismissed (no close button, no backdrop click)
 * - Name input field (required for PRISM DID alias)
 * - Automatic PRISM DID creation
 * - Connection establishment with retry logic
 * - Nested CACredentialConfirmationModal support
 * - Explains why CA connection is needed
 */

import React, { useState, useEffect } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { CERTIFICATION_AUTHORITY } from '@/config/certificationAuthority';
import { CACredentialConfirmationModal } from './CACredentialConfirmationModal';
import { getItem, setItem, removeItem, getKeysByPattern } from '@/utils/prefixedStorage';
import { getConnectionMetadata, saveConnectionMetadata } from '@/utils/connectionMetadata';
import { createLongFormPrismDID } from '@/actions';

interface CAConnectionEnforcementModalProps {
  visible: boolean;
  onConnectionEstablished: () => void;
  agent: SDK.Agent | null;
  dispatch: any;
  defaultSeed: any;
}

export const CAConnectionEnforcementModal: React.FC<CAConnectionEnforcementModalProps> = ({
  visible,
  onConnectionEstablished,
  agent,
  dispatch,
  defaultSeed
}) => {
  // User name input state (required for PRISM DID creation)
  const [userName, setUserName] = useState<string>('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Connection states
  const [connecting, setConnecting] = useState(false);
  const [creatingPrismDID, setCreatingPrismDID] = useState(false);
  const [createdPrismDID, setCreatedPrismDID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Prevent concurrent connection attempts
  const [isConnecting, setIsConnecting] = useState(false);

  // Mediator status
  const [mediatorConfigured, setMediatorConfigured] = useState(false);

  // CA credential modal state (nested modal)
  const [caCredential, setCaCredential] = useState<any>(null);
  const [showCACredentialModal, setShowCACredentialModal] = useState(false);
  const [pendingInvitationUrl, setPendingInvitationUrl] = useState<string | null>(null);
  const [pendingInvitationData, setPendingInvitationData] = useState<any>(null);

  // Check mediator status
  useEffect(() => {
    const checkMediatorStatus = () => {
      if (agent) {
        const mediatorDID = agent.currentMediatorDID;
        const isConfigured = !!mediatorDID;
        setMediatorConfigured(isConfigured);
        return isConfigured;
      }
      setMediatorConfigured(false);
      return false;
    };

    const isConfigured = checkMediatorStatus();

    // Poll every 2 seconds if not configured
    let pollInterval: NodeJS.Timeout | null = null;
    if (agent && !isConfigured) {
      pollInterval = setInterval(() => {
        const nowConfigured = checkMediatorStatus();
        if (nowConfigured && pollInterval) {
          clearInterval(pollInterval);
        }
      }, 2000);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [agent]);

  // Success handler - notify parent and close
  useEffect(() => {
    if (success) {
      // Small delay to show success state before closing
      const timer = setTimeout(() => {
        onConnectionEstablished();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [success, onConnectionEstablished]);

  const handleConnectToCA = async () => {
    // Local flag to track modal display (avoids React state timing issues)
    let shouldShowCredentialModal = false;

    // Prevent concurrent connection attempts
    if (isConnecting) {
      console.log('[CA MODAL] Connection already in progress');
      return;
    }

    // Validate name field
    if (!userName.trim()) {
      setNameError('Name is required to create your PRISM DID');
      return;
    }
    setNameError(null);

    try {
      setIsConnecting(true);
      setConnecting(true);
      setError(null);
      setCreatedPrismDID(null);

      if (!agent) {
        throw new Error('Wallet agent not initialized. Please start the agent first.');
      }

      // Check mediator configuration
      const mediatorDID = agent.currentMediatorDID;
      if (!mediatorDID) {
        throw new Error(
          'Mediator configuration required. Please initialize the wallet with mediator on the main page first.'
        );
      }

      console.log('[CA MODAL] Fetching well-known invitation from CA...');

      // Include userName as query parameter
      const baseEndpoint = CERTIFICATION_AUTHORITY.getInvitationEndpoint();
      const fetchUrl = userName.trim()
        ? `${baseEndpoint}?userName=${encodeURIComponent(userName.trim())}`
        : baseEndpoint;

      // Fetch invitation from CA
      const response = await fetch(fetchUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch CA invitation: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to get CA invitation');
      }

      console.log('[CA MODAL] Received CA invitation');

      // Check for existing CA connection
      const connections = await agent.pluto.getAllDidPairs();
      const caDID = data.caDID;

      const existingCAConnection = connections.find(pair => {
        const receiverDID = pair.receiver.toString();
        const pairName = pair.name;
        return receiverDID === caDID || pairName === "Certification Authority";
      });

      if (existingCAConnection) {
        console.log('[CA MODAL] Found existing CA connection');

        // Check if this connection already has a PRISM DID
        const connectionMetadata = getConnectionMetadata(existingCAConnection.host.toString());

        if (connectionMetadata?.prismDid) {
          // Already has PRISM DID, nothing to do
          console.log('[CA MODAL] Existing connection already has PRISM DID:',
              connectionMetadata.prismDid.substring(0, 50) + '...');
          setSuccess(true);
          setIsConnecting(false);
          return;
        }

        // Existing connection but NO PRISM DID - create one or reuse from localStorage
        const existingCAPrismDID = getItem('ca-connection-prism-did');
        let newPrismDID: string | null = null;

        if (existingCAPrismDID) {
          console.log('[CA MODAL] Reusing existing PRISM DID for existing connection:',
              existingCAPrismDID.substring(0, 60) + '...');
          newPrismDID = existingCAPrismDID;
          setCreatedPrismDID(newPrismDID);
        } else {
          console.log('[CA MODAL] Creating PRISM DID for existing connection...');
          setCreatingPrismDID(true);

          try {
            const result = await dispatch(createLongFormPrismDID({
              agent,
              alias: userName.trim() || 'CA Connection Identity',
              defaultSeed,
              mediatorUri: 'https://identuslabel.cz/mediator'
            })).unwrap();

            newPrismDID = result.did.toString();
            setCreatedPrismDID(newPrismDID);
            console.log('[CA MODAL] PRISM DID created for existing connection:',
                newPrismDID.substring(0, 60) + '...');

            // Store immediately to prevent duplicates on retry
            setItem('ca-connection-prism-did', newPrismDID);
          } catch (prismError: any) {
            console.error('[CA MODAL] Failed to create PRISM DID:', prismError);
            // Continue anyway - connection already exists
          } finally {
            setCreatingPrismDID(false);
          }
        }

        // Store in connection metadata (always update to ensure linkage)
        if (newPrismDID) {
          saveConnectionMetadata(existingCAConnection.host.toString(), {
            ...connectionMetadata,
            walletType: 'local',
            prismDid: newPrismDID
          });
        }

        setSuccess(true);
        setIsConnecting(false);
        return;
      }

      // Step 1: Create PRISM DID (or reuse existing one)
      // Check if we already have a PRISM DID created for CA connection (prevents duplicates)
      const existingCAPrismDID = getItem('ca-connection-prism-did');
      let newPrismDID: string;

      if (existingCAPrismDID) {
        console.log('[CA MODAL] Reusing existing PRISM DID:', existingCAPrismDID.substring(0, 60) + '...');
        newPrismDID = existingCAPrismDID;
        setCreatedPrismDID(newPrismDID);
      } else {
        console.log('[CA MODAL] Creating PRISM DID with alias:', userName.trim());
        setCreatingPrismDID(true);

        try {
          const result = await dispatch(createLongFormPrismDID({
            agent,
            alias: userName.trim(),
            defaultSeed,
            mediatorUri: 'https://identuslabel.cz/mediator'
          })).unwrap();

          newPrismDID = result.did.toString();
          setCreatedPrismDID(newPrismDID);
          console.log('[CA MODAL] PRISM DID created:', newPrismDID.substring(0, 60) + '...');

          // Store immediately to prevent duplicates on retry
          setItem('ca-connection-prism-did', newPrismDID);
        } catch (prismError: any) {
          console.error('[CA MODAL] Failed to create PRISM DID:', prismError);
          setCreatingPrismDID(false);
          throw new Error(`Failed to create PRISM DID: ${prismError.message}`);
        } finally {
          setCreatingPrismDID(false);
        }
      }

      // Step 2: Parse invitation
      const invitationUrl = data.invitation.invitationUrl;

      if (!invitationUrl) {
        throw new Error('Invitation URL not found in CA response');
      }

      const urlObj = new URL(invitationUrl);
      const oobParam = urlObj.searchParams.get('_oob');

      if (!oobParam) {
        throw new Error('Invalid invitation URL format');
      }

      const invitationJson = atob(oobParam);
      const invitationData = JSON.parse(invitationJson);

      // Check for CA credential in attachments
      const requestsAttach = invitationData.requests_attach || invitationData.attachments || [];
      const caCredentialAttachment = requestsAttach.find(
        (attach: any) => {
          const attachId = attach['@id'] || attach.id;
          return attachId === 'ca-authority-credential';
        }
      );

      if (caCredentialAttachment) {
        console.log('[CA MODAL] Found CA credential in invitation');
        const credentialData = caCredentialAttachment.data?.json || caCredentialAttachment.payload || caCredentialAttachment.data;

        if (credentialData) {
          setPendingInvitationUrl(invitationUrl);
          setPendingInvitationData(invitationData);
          setCaCredential(credentialData);
          setShowCACredentialModal(true);
          shouldShowCredentialModal = true;
          setConnecting(false);
          return;
        }
      }

      // Step 3: Establish connection
      if (invitationData.type === 'https://didcomm.org/out-of-band/2.0/invitation') {
        const parsed = await agent.parseOOBInvitation(new URL(invitationUrl));
        await agent.acceptDIDCommInvitation(parsed, "Certification Authority");

        console.log('[CA MODAL] Connection request sent');

        // Wait for connection to be created (retry loop)
        let newConnection: SDK.Domain.DIDPair | undefined = undefined;
        let retries = 0;
        const maxRetries = 10;

        while (!newConnection && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;

          const allConnections = await agent.pluto.getAllDidPairs();
          newConnection = allConnections.find(pair =>
            pair.receiver.toString() === invitationData.from
          );

          console.log(`[CA MODAL] Connection search attempt ${retries}/${maxRetries}${newConnection ? ' - FOUND!' : ''}`);
        }

        if (newConnection) {
          // Update connection name
          await agent.pluto.storeDIDPair(
            newConnection.host,
            newConnection.receiver,
            "Certification Authority"
          );

          // Store PRISM DID association
          if (newPrismDID) {
            saveConnectionMetadata(newConnection.host.toString(), {
              walletType: 'local',
              prismDid: newPrismDID
            });
            console.log('[CA MODAL] PRISM DID associated with connection');
          }
        } else {
          console.warn('[CA MODAL] Connection not found after retries - may still complete asynchronously');
        }

        // Clean up invitation metadata
        const invitationKeys = getKeysByPattern('invitation-');
        for (const key of invitationKeys) {
          const storedData = getItem(key);
          if (storedData?.invitationUrl === invitationUrl) {
            removeItem(key);
          }
        }

        setSuccess(true);
      } else {
        // Legacy format
        const parsed = await agent.parseInvitation(invitationUrl);
        await agent.acceptInvitation(parsed, "Certification Authority");
        // acceptInvitation is void - success means no exception thrown
        setSuccess(true);
      }
    } catch (error: any) {
      console.error('[CA MODAL] Failed to connect to CA:', error);

      let errorMessage = error.message || 'Failed to connect to Certification Authority';

      if (error.message?.includes('No mediator available') || error.message?.includes('mediator')) {
        errorMessage = 'Mediator not available. Please initialize the wallet on the main page first.';
      }

      setError(errorMessage);
    } finally {
      setConnecting(false);
      setIsConnecting(false);

      if (!success && !shouldShowCredentialModal) {
        setCaCredential(null);
        setShowCACredentialModal(false);
        setPendingInvitationUrl(null);
        setPendingInvitationData(null);
      }
    }
  };

  // Handle CA credential acceptance
  const handleAcceptCACredential = async () => {
    setShowCACredentialModal(false);

    if (!pendingInvitationUrl || !pendingInvitationData || !agent) {
      setError('Failed to process connection - missing data');
      return;
    }

    try {
      setConnecting(true);
      setError(null);

      // Store the CA credential
      if (caCredential) {
        console.log('[CA MODAL] Storing CA credential...');

        try {
          const jwtCredential = caCredential.credential || caCredential;
          const credentialPayload = typeof jwtCredential === 'string'
            ? jwtCredential
            : JSON.stringify(jwtCredential);
          const credData = Uint8Array.from(Buffer.from(credentialPayload));

          const parsedCredential = await agent.pollux.parseCredential(credData, {
            type: SDK.Domain.CredentialType.JWT
          });

          const existingCreds = await agent.pluto.getAllCredentials();
          const alreadyExists = existingCreds.some((cred) => cred.id === parsedCredential.id);

          if (!alreadyExists) {
            await agent.pluto.storeCredential(parsedCredential);
            console.log('[CA MODAL] CA credential stored');
          }
        } catch (storeError: any) {
          console.error('[CA MODAL] Failed to store CA credential:', storeError);
        }
      }

      // Proceed with connection
      await proceedWithConnection(pendingInvitationUrl, pendingInvitationData, createdPrismDID);

    } catch (error: any) {
      console.error('[CA MODAL] Failed to accept CA credential:', error);
      setError(error.message || 'Failed to accept CA credential');
      setConnecting(false);
    }
  };

  // Handle CA credential rejection
  const handleRejectCACredential = () => {
    console.log('[CA MODAL] User rejected CA credential');
    setShowCACredentialModal(false);
    setPendingInvitationUrl(null);
    setPendingInvitationData(null);
    setCaCredential(null);
    setError('Connection cancelled - CA credential rejected');
  };

  // Complete connection after credential acceptance
  const proceedWithConnection = async (invitationUrl: string, invitationData: any, prismDID: string | null) => {
    try {
      if (invitationData.type === 'https://didcomm.org/out-of-band/2.0/invitation') {
        const parsed = await agent!.parseOOBInvitation(new URL(invitationUrl));
        await agent!.acceptDIDCommInvitation(parsed, "Certification Authority");

        // Wait for connection with retry
        let newConnection: SDK.Domain.DIDPair | undefined = undefined;
        let retries = 0;
        const maxRetries = 10;

        while (!newConnection && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;

          const allConnections = await agent!.pluto.getAllDidPairs();
          newConnection = allConnections.find(pair =>
            pair.receiver.toString() === invitationData.from
          );
        }

        if (newConnection) {
          await agent!.pluto.storeDIDPair(
            newConnection.host,
            newConnection.receiver,
            "Certification Authority"
          );

          if (prismDID) {
            saveConnectionMetadata(newConnection.host.toString(), {
              walletType: 'local',
              prismDid: prismDID
            });
          }
        }

        setSuccess(true);
      } else {
        const parsed = await agent!.parseInvitation(invitationUrl);
        await agent!.acceptInvitation(parsed, "Certification Authority");
        // acceptInvitation is void - success means no exception thrown
        setSuccess(true);
      }

      // Clear pending state
      setPendingInvitationUrl(null);
      setPendingInvitationData(null);
      setCaCredential(null);

    } catch (error: any) {
      console.error('[CA MODAL] Connection failed:', error);
      throw error;
    } finally {
      setConnecting(false);
    }
  };

  if (!visible) return null;

  return (
    <>
      {/* Nested CA Credential Modal */}
      <CACredentialConfirmationModal
        credential={caCredential}
        onAccept={handleAcceptCACredential}
        onReject={handleRejectCACredential}
        visible={showCACredentialModal}
      />

      {/* Main Modal */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] flex items-center justify-center"
      >
        <div
          className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="mb-4">
            <div className="flex items-center space-x-4">
              <div className="w-14 h-14 bg-slate-800/50 rounded-full flex items-center justify-center">
                <span className="text-3xl">🏛️</span>
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white">Connect to Certification Authority</h2>
                <p className="text-slate-400 text-sm mt-1">
                  Required to receive your identity credentials
                </p>
              </div>
            </div>
          </div>

          {/* Explanation */}
          <div className="mb-4">
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
              <div className="flex items-start space-x-3">
                <span className="text-cyan-400 text-xl">ℹ️</span>
                <div>
                  <p className="text-sm text-white font-medium">
                    Why is this connection required?
                  </p>
                  <p className="text-sm text-slate-300 mt-1">
                    The Certification Authority issues your personal identity credentials.
                    Without this connection, you won't be able to receive verifiable credentials
                    that prove your identity to other parties.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Name Input */}
          <div className="mb-4">
            <label htmlFor="userName" className="block text-sm font-medium text-white mb-2">
              Your Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              id="userName"
              value={userName}
              onChange={(e) => {
                setUserName(e.target.value.slice(0, 100));
                if (nameError) setNameError(null);
              }}
              placeholder="Enter your name..."
              maxLength={100}
              className={`w-full px-4 py-2 bg-slate-800/50 border rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed ${nameError ? 'border-red-500/30' : 'border-slate-700/50'}`}
              disabled={connecting || creatingPrismDID || !agent || !mediatorConfigured || success}
            />
            {nameError && (
              <p className="text-sm text-red-400 mt-2">
                {nameError}
              </p>
            )}
            <p className="text-xs text-slate-400 mt-2">
              This name will be used as the alias for your PRISM DID created during connection.
            </p>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-4">
              <div className="p-4 bg-red-500/20 border border-red-500/30 rounded-xl">
                <p className="text-sm text-red-400">
                  <strong>Error:</strong> {error}
                </p>
              </div>
            </div>
          )}

          {/* Success Display */}
          {success && (
            <div className="mb-4">
              <div className="p-4 bg-green-500/20 border border-green-500/30 rounded-xl">
                <div className="flex items-center space-x-2">
                  <span className="text-2xl">✅</span>
                  <p className="text-sm text-green-400 font-medium">
                    Successfully connected to Certification Authority!
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Agent Not Ready Warning */}
          {!agent && (
            <div className="mb-4">
              <div className="p-4 bg-yellow-900/20 border border-yellow-700/30 rounded-xl">
                <p className="text-sm text-yellow-400">
                  <strong>Note:</strong> Please start the wallet agent before connecting.
                </p>
              </div>
            </div>
          )}

          {/* Mediator Not Ready Warning */}
          {agent && !mediatorConfigured && (
            <div className="mb-4">
              <div className="p-4 bg-orange-900/20 border border-orange-700/30 rounded-xl">
                <p className="text-sm text-orange-400">
                  <strong>Waiting for Mediator...</strong> The wallet is initializing connection to the mediator.
                  This should only take a moment.
                </p>
              </div>
            </div>
          )}

          {/* Connect Button */}
          <div className="mt-6">
            <button
              onClick={handleConnectToCA}
              disabled={connecting || creatingPrismDID || !agent || success || !userName.trim() || !mediatorConfigured}
              className={`w-full px-6 py-4 rounded-xl font-semibold text-lg transition-all duration-200 ${
                connecting || creatingPrismDID || !agent || success || !userName.trim() || !mediatorConfigured
                  ? success
                    ? 'bg-green-500/20 border border-green-500/30 text-green-400 cursor-default'
                    : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:shadow-lg hover:shadow-cyan-500/25'
              }`}
            >
              {creatingPrismDID ? (
                <span className="flex items-center justify-center space-x-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Creating PRISM DID...</span>
                </span>
              ) : connecting ? (
                <span className="flex items-center justify-center space-x-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Connecting...</span>
                </span>
              ) : success ? (
                <span>✅ Connected!</span>
              ) : (
                <span>🔗 Connect to Certification Authority</span>
              )}
            </button>

            <p className="text-xs text-slate-400 text-center mt-3">
              This connection is required to use the wallet
            </p>
          </div>
        </div>
      </div>
    </>
  );
};
