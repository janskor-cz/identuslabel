import React, { useState } from 'react';
import { Box } from "@/app/Box";
import { AgentRequire } from "@/components/AgentRequire";
import { useMountedApp } from "@/reducers/store";

interface SecurityClearanceRequestorProps {}

export function SecurityClearanceRequestor(props: SecurityClearanceRequestorProps) {
    const app = useMountedApp();
    const [selectedLevel, setSelectedLevel] = useState<string>('confidential');
    const [publicKey, setPublicKey] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [result, setResult] = useState<any>(null);
    const [error, setError] = useState<string>('');

    const clearanceLevels = [
        { value: 'internal', label: 'Internal', description: 'Basic internal access level' },
        { value: 'confidential', label: 'Confidential', description: 'Standard confidential clearance' },
        { value: 'restricted', label: 'Restricted', description: 'Higher restricted clearance' },
        { value: 'top-secret', label: 'Top Secret', description: 'Highest security clearance' }
    ];

    const requestSecurityClearance = async () => {
        if (!publicKey.trim()) {
            setError('Please enter your Ed25519 public key. Use the Security Clearance Key Manager above to generate and copy a public key.');
            return;
        }

        // Basic Ed25519 public key validation (base64url, 43 characters)
        if (publicKey.trim().length !== 43) {
            setError('Invalid Ed25519 public key format. Expected 43 characters in base64url format.');
            return;
        }

        if (!app.agent.instance) {
            setError('Agent not initialized');
            return;
        }

        setIsLoading(true);
        setError('');
        setResult(null);

        try {
            // Get wallet's DID for this request from Redux store connections
            const connections = app.connections;
            console.log('🔍 Available connections:', connections.length);

            if (connections.length === 0) {
                throw new Error('No DIDComm connections found. Please establish a connection with the Certification Authority first.');
            }

            // Use the first available connection (could enhance this to let user choose)
            const connection = connections[0];
            const walletDID = connection.receiver.toString(); // Our wallet's DID in the connection

            console.log('🔐 Requesting Security Clearance with:');
            console.log('   📋 Level:', selectedLevel);
            console.log('   🔑 Public Key:', publicKey.substring(0, 20) + '...');
            console.log('   👤 Wallet DID:', walletDID.substring(0, 60) + '...');

            // Make DIDComm Security Clearance request to CA
            const requestPayload = {
                walletDID: walletDID,
                clearanceLevel: selectedLevel,
                publicKey: publicKey.trim(),
                userInfo: {
                    name: "IDL Wallet User",
                    walletId: "idl"
                }
            };

            console.log('📤 Sending request to CA:', requestPayload);

            // Call the CA's DIDComm endpoint
            const response = await fetch('http://91.99.4.54:3005/api/didcomm/request-security-clearance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestPayload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
            }

            const responseData = await response.json();
            console.log('✅ Security Clearance request successful:', responseData);

            setResult(responseData);

        } catch (err: any) {
            console.error('❌ Security Clearance request failed:', err);
            setError(err.message || 'Request failed');
        } finally {
            setIsLoading(false);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    return (
        <Box>
            <div className="w-full bg-white border border-gray-200 rounded-lg shadow dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6">
                    <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                        🔐 Request Security Clearance
                    </h2>
                    <p className="text-gray-600 dark:text-gray-400 mb-6">
                        Request a Security Clearance Verifiable Credential directly from your wallet using DIDComm.
                    </p>

                    <AgentRequire text="to request security clearance">
                        <div className="space-y-4">
                            {/* Clearance Level Selection */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    Security Clearance Level
                                </label>
                                <select
                                    value={selectedLevel}
                                    onChange={(e) => setSelectedLevel(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                                >
                                    {clearanceLevels.map(level => (
                                        <option key={level.value} value={level.value}>
                                            {level.label} - {level.description}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Ed25519 Public Key Input */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    Ed25519 Public Key (Base64URL)
                                </label>
                                <textarea
                                    value={publicKey}
                                    onChange={(e) => setPublicKey(e.target.value)}
                                    placeholder="Enter your Ed25519 public key in base64url format (43 characters)"
                                    rows={3}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white font-mono text-sm"
                                />
                                <p className="text-sm text-gray-500 mt-1">
                                    Use the Security Clearance Key Manager above to generate an Ed25519 key pair.
                                </p>
                            </div>

                            {/* Request Button */}
                            <button
                                onClick={requestSecurityClearance}
                                disabled={isLoading || !publicKey.trim()}
                                className="w-full bg-blue-600 text-white px-4 py-3 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
                            >
                                {isLoading ? (
                                    <span className="flex items-center justify-center">
                                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Requesting...
                                    </span>
                                ) : (
                                    `🔐 Request ${selectedLevel.toUpperCase()} Clearance`
                                )}
                            </button>

                            {/* Error Display */}
                            {error && (
                                <div className="p-4 bg-red-50 border border-red-200 rounded-md">
                                    <div className="flex">
                                        <div className="ml-3">
                                            <h3 className="text-sm font-medium text-red-800">Request Failed</h3>
                                            <div className="mt-2 text-sm text-red-700">{error}</div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Success Result */}
                            {result && (
                                <div className="p-4 bg-green-50 border border-green-200 rounded-md">
                                    <div className="flex">
                                        <div className="ml-3 w-full">
                                            <h3 className="text-sm font-medium text-green-800 mb-2">✅ Request Successful!</h3>
                                            <div className="text-sm text-green-700 space-y-2">
                                                <p><strong>Message:</strong> {result.message}</p>
                                                <p><strong>Clearance ID:</strong>
                                                    <span className="font-mono ml-2">{result.clearanceId}</span>
                                                    <button
                                                        onClick={() => copyToClipboard(result.clearanceId)}
                                                        className="ml-2 text-blue-600 hover:text-blue-800"
                                                        title="Copy to clipboard"
                                                    >📋</button>
                                                </p>
                                                <p><strong>Valid Until:</strong> {new Date(result.validUntil).toLocaleDateString()}</p>
                                                <p><strong>Key Fingerprint:</strong>
                                                    <span className="font-mono text-xs ml-2">{result.keyFingerprint}</span>
                                                </p>
                                                <div className="mt-3 p-3 bg-blue-50 rounded border">
                                                    <h4 className="font-medium text-blue-800 mb-1">📨 Next Steps:</h4>
                                                    <p className="text-blue-700">{result.instructions}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </AgentRequire>
                </div>
            </div>
        </Box>
    );
}