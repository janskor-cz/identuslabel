import React from 'react';

/**
 * CACredentialConfirmationModal Component
 *
 * Displays CA credentials embedded in invitation's requests_attach field
 * and allows users to accept or reject the credential before establishing
 * the DIDComm connection.
 *
 * Security Features:
 * - Shows credential details transparently
 * - Warns user about automatic credential storage
 * - Blocks connection until user makes a decision
 * - Different from CredentialOfferModal (invitation context, not issued VC)
 */

interface CACredentialProps {
    credential: any; // Credential from requests_attach
    onAccept: () => void;
    onReject: () => void;
    visible: boolean;
}

export const CACredentialConfirmationModal: React.FC<CACredentialProps> = ({
    credential,
    onAccept,
    onReject,
    visible
}) => {
    if (!visible) return null;

    /**
     * Extract credential attributes from various VC formats
     */
    const extractCredentialData = () => {
        try {
            // Handle different credential formats
            const credentialSubject = credential?.credentialSubject || credential?.claims;
            const issuerDID = credential?.issuerDID || credential?.issuer || 'Unknown Issuer';
            const credentialType = credential?.credentialType || credential?.type || ['VerifiableCredential'];
            const issuedDate = credential?.issuedDate || credential?.issuanceDate || new Date().toISOString();

            // Extract attributes from credentialSubject or claims
            const attributes: { name: string; value: string }[] = [];

            if (credentialSubject && typeof credentialSubject === 'object') {
                Object.entries(credentialSubject).forEach(([key, value]) => {
                    // Skip internal fields
                    if (key === 'id' || key === '@context') return;

                    attributes.push({
                        name: key,
                        value: String(value)
                    });
                });
            }

            return {
                attributes,
                issuerDID,
                credentialType: Array.isArray(credentialType) ? credentialType.join(', ') : credentialType,
                issuedDate
            };
        } catch (error) {
            console.error('❌ [CA CREDENTIAL] Failed to extract credential data:', error);
            return {
                attributes: [],
                issuerDID: 'Unknown',
                credentialType: 'Unknown',
                issuedDate: new Date().toISOString()
            };
        }
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

    /**
     * Format DID for display (truncate if too long)
     */
    const formatDID = (did: string): string => {
        if (did.length <= 40) return did;
        return `${did.substring(0, 20)}...${did.substring(did.length - 17)}`;
    };

    const { attributes, issuerDID, credentialType, issuedDate } = extractCredentialData();

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
                        <span className="text-2xl">🏛️</span>
                        <div>
                            <h2 className="text-xl font-bold text-white">Certification Authority Credential</h2>
                            <p className="text-slate-400 text-sm mt-1">
                                The CA is providing its identity credential for verification
                            </p>
                        </div>
                    </div>
                </div>

                {/* Issuer Info */}
                <div className="mb-4">
                    <div className="space-y-2">
                        <div>
                            <span className="text-sm font-medium text-slate-400">Issuer DID:</span>
                            <p className="text-sm font-mono text-white mt-1 break-all">
                                {formatDID(issuerDID)}
                            </p>
                        </div>
                        <div>
                            <span className="text-sm font-medium text-slate-400">Credential Type:</span>
                            <p className="text-sm text-slate-300 mt-1">
                                {credentialType}
                            </p>
                        </div>
                        <div>
                            <span className="text-sm font-medium text-slate-400">Issued Date:</span>
                            <p className="text-sm text-slate-300 mt-1">
                                {new Date(issuedDate).toLocaleString()}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Security Notice */}
                <div className="mb-4">
                    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                        <div className="flex items-start space-x-3">
                            <span className="text-cyan-400 text-xl">ℹ️</span>
                            <div>
                                <p className="text-sm text-white font-medium">
                                    About this credential:
                                </p>
                                <p className="text-sm text-slate-300 mt-1">
                                    This credential is embedded in the connection invitation from the Certification Authority.
                                    If you accept, this credential will be automatically stored in your wallet.
                                </p>
                            </div>
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
                                ⚠️ No attributes found in this credential.
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
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="mt-6">
                    <div className="flex space-x-3">
                        <button
                            onClick={onReject}
                            className="flex-1 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-xl text-red-400 transition-colors"
                        >
                            ❌ Reject & Cancel Connection
                        </button>
                        <button
                            onClick={onAccept}
                            disabled={attributes.length === 0}
                            className="flex-1 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 rounded-xl text-white font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            ✅ Accept CA Credential
                        </button>
                    </div>

                    {/* Helper Text */}
                    <p className="text-xs text-slate-400 text-center mt-3">
                        This credential will be stored in your wallet if you accept
                    </p>
                </div>
            </div>
        </div>
    );
};
