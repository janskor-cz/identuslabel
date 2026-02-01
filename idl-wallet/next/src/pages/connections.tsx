import '../app/index.css'

import React, { useEffect } from "react";
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { FooterNavigation } from "@/components/FooterNavigation";

import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { DBConnect } from "@/components/DBConnect";
import { OOB } from "@/components/OOB";
import { PageHeader } from "@/components/PageHeader";

export default function App() {

    const app = useMountedApp();
    const [connections, setConnections] = React.useState<SDK.Domain.DIDPair[]>([]);
    const [showDetails, setShowDetails] = React.useState<{[key: number]: boolean}>({});

    useEffect(() => {
        setConnections(app.connections)
    }, [app.connections])

    const toggleDetails = (index: number) => {
        setShowDetails(prev => ({
            ...prev,
            [index]: !prev[index]
        }));
    };

    return (
        <>
            <div className="mx-10 mt-5 mb-30">
                <PageHeader>
                    <h1 className="mb-4 text-4xl font-extrabold tracking-tight leading-none text-gray-900 md:text-5xl lg:text-6xl dark:text-white">
                        Connections
                    </h1>
                </PageHeader>
                <DBConnect>
                    <Box>
                        <OOB agent={app.agent.instance!} pluto={app.db.instance!} />
                        {
                            connections.length <= 0 ?
                                <p className=" text-lg font-normal text-gray-500 lg:text-xl  dark:text-gray-400">
                                    No connections.
                                </p>
                                :
                                null
                        }
                        {
                            connections.map((connection, i) => {
                                // Determine connection status - for now we assume all stored connections are established
                                const isEstablished = true; // connection exists in storage = established
                                const statusText = isEstablished ? 'Connected' : 'Pending';
                                const statusBgColor = isEstablished ? 'bg-green-100' : 'bg-yellow-100';
                                const statusTextColor = isEstablished ? 'text-green-800' : 'text-yellow-800';
                                const isDetailsShown = showDetails[i] || false;

                                const copyToClipboard = (text: string, label: string) => {
                                    navigator.clipboard.writeText(text).then(() => {
                                        console.log(`${label} copied to clipboard`);
                                    });
                                };

                                return (
                                    <div key={`connection${i}`} className={`glass-card p-6 mb-4 ${isEstablished ? 'border-l-4 border-green-500' : 'border-l-4 border-yellow-500'} hover:transform hover:scale-105 transition-all duration-300`}>
                                        {/* Simplified Connection Display */}
                                        <div className={`${statusBgColor} ${statusTextColor} rounded-lg p-4 text-center`}>
                                            <h2 className="text-2xl font-bold mb-2 gradient-text">
                                                {connection.name || 'Unnamed Connection'}
                                            </h2>
                                            <div className="flex items-center justify-center space-x-2">
                                                <div className={`w-3 h-3 rounded-full ${isEstablished ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`}></div>
                                                <span className="text-lg font-semibold">
                                                    {statusText}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Action Buttons */}
                                        <div className="flex space-x-3 mt-4">
                                            <button className="btn-primary flex-1">
                                                💬 Send Message
                                            </button>
                                            <button
                                                onClick={() => toggleDetails(i)}
                                                className="px-4 py-2 glass-card border-2 border-white/20 hover:border-white/40 transition-all duration-300 rounded-lg"
                                            >
                                                {isDetailsShown ? '🔼 Hide' : '🔽 Details'}
                                            </button>
                                        </div>

                                        {/* Collapsible Technical Details */}
                                        {isDetailsShown && (
                                            <div className="mt-6 space-y-4 animate-fadeIn">
                                                <div className="glass-card p-4">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <label className="text-sm font-semibold opacity-80">
                                                            Host DID (Your Identity)
                                                        </label>
                                                        <button
                                                            onClick={() => copyToClipboard(connection.host.toString(), 'Host DID')}
                                                            className="text-sm opacity-60 hover:opacity-100 transition-opacity"
                                                        >
                                                            📋 Copy
                                                        </button>
                                                    </div>
                                                    <p className="text-xs font-mono opacity-70 break-all glass-card p-2 border border-white/10">
                                                        {connection.host.toString()}
                                                    </p>
                                                </div>

                                                <div className="glass-card p-4">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <label className="text-sm font-semibold opacity-80">
                                                            Receiver DID (Connected Party)
                                                        </label>
                                                        <button
                                                            onClick={() => copyToClipboard(connection.receiver.toString(), 'Receiver DID')}
                                                            className="text-sm opacity-60 hover:opacity-100 transition-opacity"
                                                        >
                                                            📋 Copy
                                                        </button>
                                                    </div>
                                                    <p className="text-xs font-mono opacity-70 break-all glass-card p-2 border border-white/10">
                                                        {connection.receiver.toString()}
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        }
                    </Box>
                </DBConnect>
            </div>
        </>
    );
}