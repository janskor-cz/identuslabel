import React, { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/reducers/store';
import { acceptCredentialOffer } from '@/actions/enterpriseAgentActions';

/**
 * EnterpriseCredentialOfferModal Component
 *
 * Displays pending enterprise credential offers in a modal window and allows users to
 * accept or reject credential offers from the Enterprise Cloud Agent.
 *
 * Features:
 * - Shows one pending offer at a time (FIFO)
 * - Displays credential type and record information
 * - Shows protocol state, role, and timestamp
 * - Provides "Accept Credential" and "Reject Credential" actions
 * - Modal overlay with gradient header matching CredentialOfferModal style
 */

interface EnterpriseCredentialOfferData {
    recordId: string;
    protocolState: string;
    role: string;
    credentialFormat?: string;
    subjectId?: string;
    createdAt: string;
    updatedAt?: string;
}

export const EnterpriseCredentialOfferModal: React.FC = () => {
    const dispatch = useAppDispatch();
    const app = useAppSelector((state) => state.app);
    const enterpriseAgent = useAppSelector((state) => state.enterpriseAgent);
    const credentials = enterpriseAgent.credentials || [];

    // Filter pending credential offer records (OfferReceived state, Holder role)
    // Note: Redux state uses 'state' property (mapped from API's 'protocolState')
    const pendingOffers: EnterpriseCredentialOfferData[] = credentials
        .filter((record: any) =>
            record.state === 'OfferReceived' &&
            record.role === 'Holder'
        )
        .map((record: any) => ({
            recordId: record.recordId,
            protocolState: record.state,  // Use 'state' from Redux (mapped from API's protocolState)
            role: record.role,
            credentialFormat: record.credentialFormat,
            subjectId: record.subjectId,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        }));

    // Local state
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset error when offers change
    useEffect(() => {
        setError(null);
        setIsProcessing(false);
    }, [pendingOffers.length]);

    // Don't render until wallet has started
    if (!app.agent.hasStarted) {
        return null;
    }

    // Don't render if no enterprise configuration
    if (!enterpriseAgent.activeConfiguration || !enterpriseAgent.activeConfiguration.isActive) {
        return null;
    }

    // Don't render if no pending offers
    if (pendingOffers.length === 0) {
        return null;
    }

    // Show first pending offer (FIFO)
    const currentOffer = pendingOffers[0];

    const handleAccept = async () => {
        if (isProcessing) return;

        setIsProcessing(true);
        setError(null);

        try {
            // Get employee PRISM DID from EmployeeRole VC
            // Filter for ONLY issued credentials (CredentialReceived state)
            // ✅ FIX: Use 'state' property (mapped from API's protocolState in Redux)
            const issuedCredentials = credentials.filter((record: any) =>
                record.state === 'CredentialReceived' &&
                record.role === 'Holder' &&
                record.credential
            );

            // Find EmployeeRole VC
            const employeeRoleRecord = issuedCredentials.find((record: any) => {
                const cred = record.credential;
                if (!cred) return false;


                // Handle JWT string, base64-wrapped JWT, JSON-encoded JWT, and object formats
                let subject: any;
                if (typeof cred === 'string') {
                    // Case 1: Base64-encoded JWT (e.g., "ZXlKMGVYQW...")
                    try {
                        const decodedJwt = atob(cred);  // Base64 → Plain JWT
                        const parts = decodedJwt.split('.');
                        if (parts.length === 3) {
                            const payload = JSON.parse(atob(parts[1]));
                            subject = payload.credentialSubject || payload.vc?.credentialSubject;
                        }
                    } catch (base64Error) {

                        // Case 2: JSON-encoded JWT string (e.g., "eyJ0eXAi...")
                        try {
                            const parsedCred = JSON.parse(cred);
                            const parts = parsedCred.split('.');
                            if (parts.length === 3) {
                                const payload = JSON.parse(atob(parts[1]));
                                subject = payload.credentialSubject || payload.vc?.credentialSubject;
                            }
                        } catch (jsonError) {
                            // Case 3: Plain JWT string (no JSON encoding)
                            try {
                                const parts = cred.split('.');
                                if (parts.length === 3) {
                                    const payload = JSON.parse(atob(parts[1]));
                                    subject = payload.credentialSubject || payload.vc?.credentialSubject;
                                }
                            } catch (jwtError) {
                                console.error('[EnterpriseCredentialOfferModal] Failed to parse credential:', jwtError);
                                return false;
                            }
                        }
                    }
                } else if (cred.base64) {
                    // ✅ Case 2: Object with base64 property (Enterprise Cloud Agent format)
                    try {
                        const jwt = atob(cred.base64);
                        const parts = jwt.split('.');
                        if (parts.length === 3) {
                            const payload = JSON.parse(atob(parts[1]));
                            subject = payload.credentialSubject || payload.vc?.credentialSubject;
                        }
                    } catch (e) {
                        console.error('[EnterpriseCredentialOfferModal] Failed to decode base64 JWT:', e);
                        return false;
                    }
                } else {
                    // Case 3: Plain object
                    subject = cred.credentialSubject || cred.claims || cred.vc?.credentialSubject;
                }

                // ✅ FIX: EmployeeRole VC has employeeId, role, department, prismDid (NOT email!)
                return subject?.employeeId && subject?.role && subject?.department && subject?.prismDid;
            });

            if (!employeeRoleRecord) {
                throw new Error('EmployeeRole credential not found. Please complete employee onboarding first.');
            }

            // Extract PRISM DID
            const employeeRoleCred = employeeRoleRecord.credential;
            let subject: any;

            if (typeof employeeRoleCred === 'string') {
                // Case 1: Base64-encoded JWT (e.g., "ZXlKMGVYQW...")
                try {
                    const decodedJwt = atob(employeeRoleCred);  // Base64 → Plain JWT
                    const parts = decodedJwt.split('.');
                    if (parts.length === 3) {
                        const payload = JSON.parse(atob(parts[1]));
                        subject = payload.credentialSubject || payload.vc?.credentialSubject;
                    }
                } catch (base64Error) {
                    // Case 2: JSON-encoded JWT string (e.g., "eyJ0eXAi...")
                    try {
                        const parsedCred = JSON.parse(employeeRoleCred);
                        const parts = parsedCred.split('.');
                        if (parts.length === 3) {
                            const payload = JSON.parse(atob(parts[1]));
                            subject = payload.credentialSubject || payload.vc?.credentialSubject;
                        }
                    } catch (jsonError) {
                        // Case 3: Plain JWT string (no JSON encoding)
                        try {
                            const parts = employeeRoleCred.split('.');
                            if (parts.length === 3) {
                                const payload = JSON.parse(atob(parts[1]));
                                subject = payload.credentialSubject || payload.vc?.credentialSubject;
                            }
                        } catch (jwtError) {
                            console.error('[EnterpriseCredentialOfferModal] Failed to parse JWT for PRISM DID:', jwtError);
                        }
                    }
                }
            } else if (employeeRoleCred.base64) {
                // ✅ Case 2: Object with base64 property (Enterprise Cloud Agent format)
                try {
                    const jwt = atob(employeeRoleCred.base64);
                    const parts = jwt.split('.');
                    if (parts.length === 3) {
                        const payload = JSON.parse(atob(parts[1]));
                        subject = payload.credentialSubject || payload.vc?.credentialSubject;
                    }
                } catch (e) {
                    console.error('[EnterpriseCredentialOfferModal] Failed to decode base64 JWT for PRISM DID:', e);
                }
            } else {
                // Case 3: Plain object
                subject = employeeRoleCred.credentialSubject
                    || employeeRoleCred.claims
                    || employeeRoleCred.vc?.credentialSubject;
            }

            const employeePrismDid = subject?.prismDid;

            if (!employeePrismDid) {
                throw new Error('PRISM DID not found in EmployeeRole credential');
            }

            // Accept the offer
            await dispatch(acceptCredentialOffer({
                recordId: currentOffer.recordId,
                subjectId: employeePrismDid
            })).unwrap();

            // Modal auto-closes because Redux state update removes the offer
        } catch (err) {
            console.error('❌ [ENTERPRISE CREDENTIAL OFFER] Failed to accept offer:', err);
            setError(err instanceof Error ? err.message : 'Failed to accept credential offer');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleReject = async () => {
        if (isProcessing) return;

        setIsProcessing(true);
        setError(null);

        try {
            // TODO: Implement reject API call when available
            // For now, just log that it's not implemented
            console.warn('⚠️ [ENTERPRISE CREDENTIAL OFFER] Reject functionality not yet implemented');
            setError('Reject functionality not yet implemented. Please contact your administrator.');

        } catch (err) {
            console.error('❌ [ENTERPRISE CREDENTIAL OFFER] Failed to reject offer:', err);
            setError(err instanceof Error ? err.message : 'Failed to reject credential offer');
        } finally {
            setIsProcessing(false);
        }
    };

    const formatTimestamp = (timestamp: string): string => {
        try {
            return new Date(timestamp).toLocaleString();
        } catch (e) {
            return timestamp;
        }
    };

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
                        <span className="text-2xl">🏢</span>
                        <div>
                            <h2 className="text-xl font-bold text-white">Enterprise Credential Offer</h2>
                            <p className="text-slate-400 text-sm mt-1">
                                {enterpriseAgent.activeConfiguration?.enterpriseAgentName || 'Your organization'} is offering you a credential
                            </p>
                        </div>
                    </div>
                </div>

                {/* Record Info */}
                <div className="mb-4">
                    <div className="space-y-2">
                        <div>
                            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Record ID:</span>
                            <p className="text-xs font-mono text-gray-600 dark:text-gray-400 mt-1 break-all">
                                {currentOffer.recordId}
                            </p>
                        </div>
                        <div>
                            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">State:</span>
                            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                                    {currentOffer.protocolState}
                                </span>
                            </p>
                        </div>
                        <div>
                            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Role:</span>
                            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                                {currentOffer.role}
                            </p>
                        </div>
                        {currentOffer.credentialFormat && (
                            <div>
                                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Format:</span>
                                <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                                    {currentOffer.credentialFormat}
                                </p>
                            </div>
                        )}
                        <div>
                            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Created:</span>
                            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                                {formatTimestamp(currentOffer.createdAt)}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Info Note */}
                <div className="px-6 py-4">
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                        <div className="flex">
                            <div className="flex-shrink-0">
                                <span className="text-2xl">ℹ️</span>
                            </div>
                            <div className="ml-3">
                                <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                                    Enterprise Credential Offer
                                </h3>
                                <div className="mt-2 text-sm text-blue-700 dark:text-blue-300">
                                    <p>
                                        This credential is being offered by your organization's Enterprise Cloud Agent.
                                        Once accepted, it will be stored in the enterprise credential store and can be
                                        used for company-related identity verification.
                                    </p>
                                </div>
                            </div>
                        </div>
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
                            onClick={handleAccept}
                            disabled={isProcessing}
                            className="flex-1 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 rounded-xl text-white font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isProcessing ? '⏳ Processing...' : '🏢 Accept Credential'}
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
        </div>
    );
};
