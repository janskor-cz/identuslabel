import React, { useState } from 'react';
import { Box } from "@/app/Box";
import { AgentRequire } from "@/components/AgentRequire";
import { useMountedApp } from "@/reducers/store";

interface CAHyperlinkGeneratorProps {}

export function CAHyperlinkGenerator(props: CAHyperlinkGeneratorProps) {
    const app = useMountedApp();
    const [selectedConnectionId, setSelectedConnectionId] = useState<string>('');
    const [generatedUrl, setGeneratedUrl] = useState<string>('');

    const generateCALoginUrl = () => {
        if (!selectedConnectionId) {
            alert('Please select a connection first');
            return;
        }

        const baseUrl = 'http://91.99.4.54:3005/login';
        const urlWithConnection = `${baseUrl}?connectionId=${encodeURIComponent(selectedConnectionId)}`;
        setGeneratedUrl(urlWithConnection);
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text).then(() => {
            alert('URL copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    };

    const openUrl = (url: string) => {
        window.open(url, '_blank');
    };

    return (
        <Box>
            <div className="w-full bg-white border border-gray-200 rounded-lg shadow dark:bg-gray-800 dark:border-gray-700">
                <div className="p-6">
                    <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                        🔗 CA Login Link Generator
                    </h2>
                    <p className="text-gray-600 dark:text-gray-400 mb-6">
                        Generate connection-directed links to the Certification Authority for seamless DIDComm workflows.
                    </p>

                    <AgentRequire text="to generate CA links">
                        <div className="space-y-4">
                            {/* Connection Selection */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    Select DIDComm Connection
                                </label>
                                {app.connections && app.connections.length > 0 ? (
                                    <select
                                        value={selectedConnectionId}
                                        onChange={(e) => setSelectedConnectionId(e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value="">Choose a connection...</option>
                                        {app.connections.map((connection, index) => {
                                            // For DIDPair connections, use the receiver DID as the connection identifier
                                            // This allows the CA to map the DID to its internal connection ID
                                            const actualConnectionId = connection.receiver?.toString() || `Connection ${index + 1}`;

                                            // Create readable display version (truncated for display only)
                                            const displayConnectionId = actualConnectionId.length > 40
                                                                       ? actualConnectionId.substring(0, 40) + '...'
                                                                       : actualConnectionId;

                                            const displayName = connection.alias ||
                                                              connection.name ||
                                                              connection.label ||
                                                              `Connection ${index + 1}`;

                                            return (
                                                <option key={index} value={actualConnectionId}>
                                                    {displayName} ({displayConnectionId})
                                                </option>
                                            );
                                        })}
                                    </select>
                                ) : (
                                    <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                                        <p className="text-yellow-800">
                                            No DIDComm connections found. Please establish a connection with the Certification Authority first.
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Generate Button */}
                            <button
                                onClick={generateCALoginUrl}
                                disabled={!selectedConnectionId}
                                className="w-full bg-blue-600 text-white px-4 py-3 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
                            >
                                🔗 Generate CA Login URL
                            </button>

                            {/* Generated URL Display */}
                            {generatedUrl && (
                                <div className="p-4 bg-green-50 border border-green-200 rounded-md">
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-medium text-green-800">✅ Connection-Directed URL Generated!</h3>

                                        <div className="bg-white border rounded p-3">
                                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                                Generated CA Login URL:
                                            </label>
                                            <div className="font-mono text-sm bg-gray-50 p-2 rounded border break-all">
                                                {generatedUrl}
                                            </div>
                                        </div>

                                        <div className="flex space-x-2">
                                            <button
                                                onClick={() => copyToClipboard(generatedUrl)}
                                                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 text-sm"
                                            >
                                                📋 Copy URL
                                            </button>
                                            <button
                                                onClick={() => openUrl(generatedUrl)}
                                                className="flex-1 bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 text-sm"
                                            >
                                                🌐 Open CA
                                            </button>
                                        </div>

                                        <div className="mt-3 p-3 bg-blue-50 rounded border">
                                            <h4 className="font-medium text-blue-800 mb-1">📨 How to Use:</h4>
                                            <ol className="text-blue-700 text-sm space-y-1">
                                                <li>1. Click "🌐 Open CA" or copy the URL to your browser</li>
                                                <li>2. The CA will automatically detect your connection</li>
                                                <li>3. Present your RealPerson VC through proper DIDComm protocol</li>
                                                <li>4. Request Security Clearance through the same connection</li>
                                            </ol>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Connection Info */}
                            {app.connections && app.connections.length > 0 && (
                                <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-md">
                                    <h4 className="font-medium text-gray-800 mb-2">🔍 Available Connections:</h4>
                                    <div className="space-y-2">
                                        {app.connections.map((connection, index) => {
                                            // Debug logging
                                            console.log(`🔍 Connection ${index}:`, {
                                                connectionId: connection.connectionId,
                                                id: connection.id,
                                                alias: connection.alias,
                                                name: connection.name,
                                                label: connection.label,
                                                host: connection.host?.toString(),
                                                receiver: connection.receiver?.toString(),
                                                fullObject: connection
                                            });

                                            const actualConnectionId = connection.receiver?.toString() || `Connection ${index + 1}`;

                                            return (
                                                <div key={index} className="text-sm border-l-4 border-blue-500 pl-3">
                                                    <span className="font-medium">
                                                        {connection.alias || connection.name || connection.label || `Connection ${index + 1}`}
                                                    </span>
                                                    <div className="text-gray-600 font-mono text-xs space-y-1">
                                                        <div><strong>Connection ID (Receiver DID):</strong> {actualConnectionId.substring(0, 50)}...</div>
                                                        <div><strong>Host:</strong> {connection.host?.toString().substring(0, 50)}...</div>
                                                        <div><strong>Receiver:</strong> {connection.receiver?.toString().substring(0, 50)}...</div>
                                                    </div>
                                                </div>
                                            );
                                        })}
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