import { useMountedApp } from "@/reducers/store";
import Link from "next/link";
import React, { useState, useMemo } from "react";

export function PageHeader({ children }) {
    const app = useMountedApp();
    const { db } = app;

    const agent = app.agent.instance;

    // Database connection state
    const [dbPassword, setDbPassword] = useState("elribonazo");
    const [isConnecting, setIsConnecting] = useState(false);

    const handleDatabaseConnect = async () => {
        if (!dbPassword) {
            alert('Please enter database password');
            return;
        }

        setIsConnecting(true);
        try {
            console.log('🔐 [PageHeader] Connecting to database...');
            await app.connectDatabase({
                encryptionKey: Buffer.from(dbPassword)
            });
            console.log('✅ [PageHeader] Database connected successfully');
            // Auto-initialization will trigger from index.tsx
        } catch (error) {
            console.error('❌ [PageHeader] Database connection failed:', error);
            alert(`Failed to connect database: ${error.message || error}`);
        } finally {
            setIsConnecting(false);
        }
    };

    // NOTE: Start/Stop handlers removed - auto-start now handled by index.tsx
    // Wallet automatically starts after database connection, no manual start needed

    const [isClicked, setIsClicked] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    // Get uniqueId from RealPerson VC
    const realPersonUniqueId = useMemo(() => {
        const credentials = app.credentials || [];

        for (const cred of credentials) {
            try {
                // Get the credential subject from claims[0]
                const subject = cred.claims?.[0];
                if (!subject) continue;

                // Check if this is a RealPerson credential
                const credType = subject.credentialType;
                const isRealPerson = credType === 'RealPersonIdentity' || credType === 'RealPerson';

                // Field is 'uniqueId' not 'holderUniqueId'
                if (isRealPerson && subject.uniqueId) {
                    return subject.uniqueId;
                }
            } catch (e) {
                console.error('[PageHeader] Error parsing credential:', e);
            }
        }
        return null;
    }, [app.credentials]);

    return (
        <div className="relative w-full max-w-screen-lg mx-auto">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-center p-4 text-white">
                {/* Left Side: Title or Children */}
                <div className="mb-2 sm:mb-0">
                    <div className="flex items-center gap-3">
                        <div className="text-lg sm:text-xl font-semibold">
                            {children}
                        </div>
                        <span className="px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-full">
                            {app.wallet.walletName}
                        </span>
                    </div>
                </div>

                {/* Right Side: Database Login OR Status/Buttons */}
                <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-3">
                    {!db.connected ? (
                        /* DATABASE LOGIN (when disconnected) */
                        <>
                            <input
                                type="password"
                                value={dbPassword}
                                onChange={(e) => setDbPassword(e.target.value)}
                                onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleDatabaseConnect()}
                                placeholder="Database password"
                                className="px-3 py-1.5 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                style={{ width: '160px' }}
                                disabled={isConnecting}
                            />
                            <button
                                onClick={handleDatabaseConnect}
                                disabled={isConnecting}
                                className={`px-4 py-1.5 text-sm font-medium text-white rounded-md transition-colors ${
                                    isConnecting
                                        ? 'bg-gray-400 cursor-not-allowed'
                                        : 'bg-blue-600 hover:bg-blue-700'
                                }`}
                            >
                                {isConnecting ? '🔄 Connecting...' : '🔒 Connect'}
                            </button>
                        </>
                    ) : (
                        /* WALLET STATUS (when connected) */
                        <>
                            {/* Status Display */}
                            <div className="text-center sm:text-left">
                                <p className="text-sm sm:text-base font-medium">
                                    <b>Status:</b> {app.agent.instance?.state ?? "initializing..."}
                                </p>
                                {app.agent.instance?.state === "running" && realPersonUniqueId && (
                                    <button
                                        onClick={() => {
                                            navigator.clipboard
                                                .writeText(realPersonUniqueId)
                                                .then(() => {
                                                    setIsClicked(true);
                                                    setTimeout(() => setIsClicked(false), 300);
                                                });
                                        }}
                                        className={`text-xs sm:text-sm text-blue-500 transition-transform duration-300 ${isClicked ? "scale-110" : ""
                                            }`}
                                        title={`Unique ID: ${realPersonUniqueId}`}
                                    >
                                        Copy Unique ID
                                    </button>
                                )}
                            </div>
                        </>
                    )}

                    {/* Menu Button (Visible on small screens) */}
                    <button
                        onClick={() => setMenuOpen(!menuOpen)}
                        className="text-white px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 sm:hidden"
                    >
                        {/* Hamburger Icon */}
                        <svg
                            className="w-6 h-6"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 6h16M4 12h16M4 18h16"
                            />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Menu for large screens */}
            <div className="hidden sm:block ">
                <ul className="flex justify-center space-x-4 text-white py-2">
                    <li>
                        <Link
                            href="/"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Edge Agent
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/connections"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Connections
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/credentials"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Credentials
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/did-management"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            DIDs
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/configuration"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Configuration
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/my-documents"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            My Docs
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/messages"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Messages
                        </Link>
                    </li>
                    <li>
                        <Link
                            href="/debug"
                            className="px-4 py-2 hover:bg-gray-700 rounded"
                        >
                            Debug
                        </Link>
                    </li>
                </ul>
            </div>

            {/* Responsive Menu for small screens */}
            {menuOpen && (
                <div
                    onMouseLeave={() => setMenuOpen(false)}
                    className="absolute inset-0 text-white flex flex-col items-center justify-center z-10 bg-gray-800 sm:hidden"
                >
                    <ul className="w-full text-center">
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/"
                                className="inline-block w-full px-4 py-2"
                            >
                                Edge Agent
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/connections"
                                className="inline-block w-full px-4 py-2"
                            >
                                Connections
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/credentials"
                                className="inline-block w-full px-4 py-2"
                            >
                                Credentials
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/did-management"
                                className="inline-block w-full px-4 py-2"
                            >
                                DIDs
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/my-documents"
                                className="inline-block w-full px-4 py-2"
                            >
                                My Docs
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/messages"
                                className="inline-block w-full px-4 py-2"
                            >
                                Messages
                            </Link>
                        </li>
                        <li className="px-5 py-3 hover:bg-gray-700 rounded-lg">
                            <Link
                                href="/debug"
                                className="inline-block w-full px-4 py-2"
                            >
                                Debug
                            </Link>
                        </li>
                    </ul>
                </div>
            )}
        </div>
    );
}
