import React, { useState, useEffect } from 'react';
import { useMountedApp, useAppSelector } from '@/reducers/store';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { DIDSelectionModal } from './DIDSelectionModal';

/**
 * CredentialOfferModal Component
 *
 * Displays pending credential offers in a modal window and allows users to
 * accept or reject credential offers from issuers.
 *
 * Features:
 * - Shows one pending offer at a time (FIFO)
 * - Displays all credential attributes from credential_preview
 * - Shows issuer DID, schema ID, and timestamp information
 * - Provides "Accept Credential" and "Reject Credential" actions
 * - Modal overlay with gradient header matching PresentationRequestModal style
 */

interface CredentialAttribute {
    name: string;
    value: string;
    media_type?: string;
}

interface CredentialPreview {
    body: {
        attributes: CredentialAttribute[];
    };
    schema_id: string;
    type?: string;
}

interface CredentialOfferData {
    id: string;
    message: SDK.Domain.Message;
    from: string;
    timestamp: number;
    credentialPreview: CredentialPreview;
}

export const CredentialOfferModal: React.FC = () => {
    const app = useMountedApp();

    // Filter pending credential offer messages
    const pendingOffers: CredentialOfferData[] = app.messages
        .filter(msg => msg.piuri === 'https://didcomm.org/issue-credential/3.0/offer-credential')
        .map(msg => {
            try {
                const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
                // Convert SDK timestamp (seconds) to milliseconds for Date constructor
                const timestampMs = msg.createdTime
                    ? (msg.createdTime < 1000000000000 ? msg.createdTime * 1000 : msg.createdTime)
                    : Date.now();

                return {
                    id: msg.id,
                    message: msg,
                    from: msg.from?.toString() || 'Unknown Issuer',
                    timestamp: timestampMs,
                    credentialPreview: body.credential_preview
                };
            } catch (error) {
                console.error('❌ Error parsing credential offer:', error);
                return null;
            }
        })
        .filter((offer): offer is CredentialOfferData => offer !== null && offer.credentialPreview !== undefined);

    // Get existing PRISM DIDs from Redux store
    const prismDIDs = useAppSelector(state => state.app.prismDIDs) || [];

    // Local state
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showDIDSelection, setShowDIDSelection] = useState(false);
    const [pendingOffer, setPendingOffer] = useState<CredentialOfferData | null>(null);

    // Reset error when offers change
    useEffect(() => {
        setError(null);
        setIsProcessing(false);
        setShowDIDSelection(false);
        setPendingOffer(null);
    }, [pendingOffers.length]);

    // Don't render modal until agent has fully started (prevents blocking initialization)
    if (!app.agent?.hasStarted) {
        return null;
    }

    // Don't render if no pending offers
    if (pendingOffers.length === 0) return null;

    // Show first pending offer (FIFO)
    const currentOffer = pendingOffers[0];

    /**
     * Show DID selection modal when user clicks Accept
     * If there are existing credential DIDs, let user choose
     */
    const handleAcceptClick = () => {
        if (!app.agent?.instance || isProcessing) return;

        // Show all PRISM DIDs (including CA connection DID) for user selection
        const credentialDIDs = prismDIDs;

        if (credentialDIDs.length > 0) {
            // Show DID selection modal
            setPendingOffer(currentOffer);
            setShowDIDSelection(true);
        } else {
            // No existing DIDs, proceed directly with new DID creation
            handleAcceptWithDID(null);
        }
    };

    /**
     * Actually accept the credential with the selected DID
     */
    const handleAcceptWithDID = async (selectedDID: string | null) => {
        if (!app.agent?.instance || isProcessing) return;

        setShowDIDSelection(false);
        setIsProcessing(true);
        setError(null);

        const offerToAccept = pendingOffer || currentOffer;

        try {
            console.log('🟢 [CREDENTIAL OFFER] Accepting offer:', offerToAccept.id);
            if (selectedDID) {
                console.log('🔄 [CREDENTIAL OFFER] Using existing DID:', selectedDID.substring(0, 50) + '...');
            } else {
                console.log('🆕 [CREDENTIAL OFFER] Creating new DID');
            }

            await app.acceptCredentialOffer({
                agent: app.agent.instance,
                message: offerToAccept.message,
                selectedDID: selectedDID || undefined
            });

            console.log('✅ [CREDENTIAL OFFER] Offer accepted successfully');
            setPendingOffer(null);

            // Modal auto-closes because Redux state update removes message
        } catch (err) {
            console.error('❌ [CREDENTIAL OFFER] Failed to accept offer:', err);
            setError(err instanceof Error ? err.message : 'Failed to accept credential offer');

            // Delete the failed offer message so modal doesn't reappear
            try {
                await app.agent.instance.pluto.deleteMessage(offerToAccept.id);
                console.log('✅ [CREDENTIAL OFFER] Deleted failed offer message:', offerToAccept.id);
            } catch (deleteError) {
                console.warn('⚠️ [CREDENTIAL OFFER] Failed to delete message:', deleteError);
            }
        } finally {
            setIsProcessing(false);
            setPendingOffer(null);
        }
    };

    /**
     * Handle DID selection modal close (cancel)
     */
    const handleDIDSelectionClose = () => {
        setShowDIDSelection(false);
        setPendingOffer(null);
    };

    const handleReject = async () => {
        if (!app.agent?.instance || isProcessing) return;

        setIsProcessing(true);
        setError(null);

        try {
            console.log('🔴 [CREDENTIAL OFFER] Rejecting offer:', currentOffer.id);

            await app.rejectCredentialOffer({
                message: currentOffer.message,
                pluto: app.agent.instance.pluto
            });

            console.log('✅ [CREDENTIAL OFFER] Offer rejected successfully');

            // Modal auto-closes because Redux state update removes message
        } catch (err) {
            console.error('❌ [CREDENTIAL OFFER] Failed to reject offer:', err);
            setError(err instanceof Error ? err.message : 'Failed to reject credential offer');
        } finally {
            setIsProcessing(false);
        }
    };

    /**
     * Format DID for display (truncate if too long)
     */
    const formatDID = (did: string): string => {
        if (did.length <= 40) return did;
        return `${did.substring(0, 20)}...${did.substring(did.length - 17)}`;
    };

    /**
     * Format attribute name from camelCase to Title Case
     */
    const formatAttributeName = (name: string): string => {
        return name
            .replace(/([A-Z])/g, ' $1') // Add space before capital letters
            .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
            .trim();
    };

    const attributes = currentOffer.credentialPreview.body.attributes;
    const schemaId = currentOffer.credentialPreview.schema_id;

    // Find connection name from issuer DID
    const getConnectionName = (): string => {
        const issuerDID = currentOffer.from;
        // Check both host and receiver since connection structure varies
        const connection = app.connections.find(
            conn => conn.host.toString() === issuerDID || conn.receiver.toString() === issuerDID
        );
        return (connection as any)?.name || 'Unknown Issuer';
    };

    // Extract credential type from attributes
    const getCredentialType = (): string => {
        const typeAttr = attributes.find(
            attr => attr.name.toLowerCase() === 'credentialtype'
        );
        if (typeAttr) {
            // Convert "RealPersonIdentity" to "RealPerson Identity"
            return typeAttr.value.replace(/([A-Z])/g, ' $1').trim();
        }
        return 'Verifiable';
    };

    const connectionName = getConnectionName();
    const credentialType = getCredentialType();

    return (
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center"
        >
            <div
                className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="mb-4">
                    <div className="flex items-center space-x-3">
                        <span className="text-2xl">🎫</span>
                        <div>
                            <h2 className="text-xl font-bold text-white">
                                {connectionName} is offering you {credentialType} Credential
                            </h2>
                        </div>
                    </div>
                </div>

                {/* Attributes Table */}
                <div className="mb-4">
                    <h3 className="text-lg font-semibold text-white mb-4">
                        Credential Attributes:
                    </h3>

                    {attributes.length === 0 ? (
                        <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
                            <p className="text-yellow-400 text-sm">
                                ⚠️ No attributes found in this credential offer.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="bg-slate-800 border-b border-slate-700">
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-300 uppercase tracking-wider">
                                            Attribute
                                        </th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-300 uppercase tracking-wider">
                                            Value
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {attributes.map((attr, index) => (
                                        <tr
                                            key={index}
                                            className="border-b border-slate-700/50 last:border-b-0"
                                        >
                                            <td className="px-4 py-3 text-sm font-medium text-white">
                                                {formatAttributeName(attr.name)}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-slate-300">
                                                {attr.value}
                                                {attr.media_type && (
                                                    <span className="ml-2 text-xs text-slate-400">
                                                        ({attr.media_type})
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Time */}
                <div className="mb-4">
                    <div className="text-sm text-slate-400 text-right">
                        <span className="font-medium">Received:</span> {new Date(currentOffer.timestamp).toLocaleString()}
                    </div>
                </div>

                {/* Error Display */}
                {error && (
                    <div className="mb-4">
                        <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-3">
                            <p className="text-red-400 text-sm">
                                ❌ {error}
                            </p>
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="mt-6">
                    <div className="flex space-x-3">
                        <button
                            onClick={handleReject}
                            disabled={isProcessing}
                            className="flex-1 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-xl text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isProcessing ? '⏳ Processing...' : '❌ Reject Credential'}
                        </button>
                        <button
                            onClick={handleAcceptClick}
                            disabled={isProcessing || attributes.length === 0}
                            className="flex-1 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 rounded-xl text-white font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isProcessing ? '⏳ Processing...' : '🎫 Accept Credential'}
                        </button>
                    </div>

                    {/* Helper Text */}
                    <p className="text-xs text-slate-400 text-center mt-3">
                        {pendingOffers.length > 1
                            ? `${pendingOffers.length} pending offers (showing oldest first)`
                            : 'This is the only pending offer'
                        }
                    </p>
                </div>
            </div>

            {/* DID Selection Modal */}
            <DIDSelectionModal
                isOpen={showDIDSelection}
                onClose={handleDIDSelectionClose}
                onSelect={handleAcceptWithDID}
                existingDIDs={prismDIDs.map((did: any) => ({
                    did: did.did || did.toString(),
                    alias: did.alias
                }))}
                credentialType={credentialType}
            />
        </div>
    );
};
