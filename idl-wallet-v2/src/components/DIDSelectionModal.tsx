import React, { useState } from 'react';

/**
 * DIDSelectionModal Component
 *
 * Allows users to choose between creating a new PRISM DID or reusing
 * an existing one when accepting a credential offer.
 *
 * Shows ALL PRISM DIDs including CA-connection DIDs for maximum user flexibility.
 */

interface ExistingDID {
    did: string;
    alias?: string;
}

interface DIDSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (selectedDID: string | null) => void;  // null = create new
    existingDIDs: ExistingDID[];
    credentialType: string;  // e.g., "RealPerson"
}

export const DIDSelectionModal: React.FC<DIDSelectionModalProps> = ({
    isOpen,
    onClose,
    onSelect,
    existingDIDs,
    credentialType
}) => {
    // Default to "create new"
    const [selectedOption, setSelectedOption] = useState<string>('new');

    if (!isOpen) return null;

    // Show all PRISM DIDs (including CA connection DID) for user selection
    const credentialDIDs = existingDIDs;

    const handleConfirm = () => {
        if (selectedOption === 'new') {
            onSelect(null);  // null means create new DID
        } else {
            onSelect(selectedOption);  // Pass selected DID string
        }
    };

    const formatDID = (did: string): string => {
        if (did.length <= 50) return did;
        return `${did.substring(0, 25)}...${did.substring(did.length - 20)}`;
    };

    return (
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[10000] flex items-center justify-center"
            onClick={onClose}
        >
            <div
                className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[80vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="mb-4">
                    <div className="flex items-center space-x-3">
                        <span className="text-2xl">🔑</span>
                        <div>
                            <h2 className="text-xl font-bold text-white">
                                Select DID for {credentialType} Credential
                            </h2>
                            <p className="text-slate-400 text-sm mt-1">
                                Choose which identity to use for this credential
                            </p>
                        </div>
                    </div>
                </div>

                {/* Options */}
                <div className="space-y-3">
                    {/* Create New DID Option */}
                    <label
                        className={`
                            block p-3 rounded-xl cursor-pointer transition-colors
                            ${selectedOption === 'new'
                                ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/30'
                                : 'bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50'
                            }
                        `}
                    >
                        <div className="flex items-start">
                            <input
                                type="radio"
                                name="did-selection"
                                value="new"
                                checked={selectedOption === 'new'}
                                onChange={(e) => setSelectedOption(e.target.value)}
                                className="mt-1 h-4 w-4 text-cyan-500 focus:ring-cyan-500/50"
                            />
                            <div className="ml-3">
                                <div className="flex items-center">
                                    <span className="font-medium text-white">
                                        Create New PRISM DID
                                    </span>
                                    <span className="ml-2 px-2 py-0.5 text-xs font-semibold bg-green-500/20 text-green-400 border border-green-500/30 rounded">
                                        Recommended
                                    </span>
                                </div>
                                <p className="text-sm text-slate-400 mt-1">
                                    Creates a new identity specifically for this credential
                                </p>
                            </div>
                        </div>
                    </label>

                    {/* Existing DIDs */}
                    {credentialDIDs.length > 0 && (
                        <>
                            <div className="relative py-2">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                                </div>
                                <div className="relative flex justify-center">
                                    <span className="px-3 bg-white dark:bg-gray-800 text-sm text-gray-500">
                                        Or reuse existing DID
                                    </span>
                                </div>
                            </div>

                            {credentialDIDs.map((did, index) => (
                                <label
                                    key={index}
                                    className={`
                                        block p-4 rounded-lg border-2 cursor-pointer transition-all
                                        ${selectedOption === did.did
                                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                            : 'border-gray-200 dark:border-gray-700 hover:border-blue-300'
                                        }
                                    `}
                                >
                                    <div className="flex items-start">
                                        <input
                                            type="radio"
                                            name="did-selection"
                                            value={did.did}
                                            checked={selectedOption === did.did}
                                            onChange={(e) => setSelectedOption(e.target.value)}
                                            className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500"
                                        />
                                        <div className="ml-3 flex-1 min-w-0">
                                            <div className="font-medium text-gray-900 dark:text-white">
                                                {did.alias || 'Unnamed DID'}
                                            </div>
                                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono break-all">
                                                {formatDID(did.did)}
                                            </p>
                                        </div>
                                    </div>
                                </label>
                            ))}
                        </>
                    )}

                    {credentialDIDs.length === 0 && (
                        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                            <p className="text-sm">No existing credential DIDs found.</p>
                            <p className="text-xs mt-1">A new DID will be created for this credential.</p>
                        </div>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="mt-6">
                    <div className="flex space-x-3">
                        <button
                            onClick={onClose}
                            className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="flex-1 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 rounded-xl text-white font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all"
                        >
                            Confirm Selection
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
