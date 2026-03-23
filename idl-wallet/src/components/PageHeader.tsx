import { useMountedApp } from "@/reducers/store";
import { reduxActions } from "@/reducers/app";
import Link from "next/link";
import React, { useState, useMemo, useEffect, useRef } from "react";

const IAGON_STATUS_LABELS: Record<string, string> = {
    idle: '',
    checking: 'Checking backup...',
    downloading: 'Downloading backup...',
    restoring: 'Restoring wallet...',
    uploading: 'Uploading backup...',
    synced: 'Synced with Iagon',
    error: 'Backup error',
};

export function PageHeader({ children }) {
    const app = useMountedApp();
    const { db } = app;

    const agent = app.agent.instance;

    // Login form state
    const [username, setUsername] = useState('');
    const [dbPassword, setDbPassword] = useState('');
    const [isConnecting, setIsConnecting] = useState(false);
    const [loginError, setLoginError] = useState('');

    const iagonStatus = app.iagonBackup?.status ?? 'idle';
    const iagonLabel = IAGON_STATUS_LABELS[iagonStatus] ?? '';

    // Store password in a ref so the restore effect can access it without stale closure
    const passwordRef = useRef('');
    const usernameRef = useRef('');

    // Trigger Iagon restore once agent has started and a backup was found
    useEffect(() => {
        const shouldRestore =
            app.agent.hasStarted &&
            (iagonStatus === 'downloading' || iagonStatus === 'restoring') &&
            passwordRef.current &&
            usernameRef.current;

        if (!shouldRestore) return;

        const storedUsername = usernameRef.current;
        const storedPassword = passwordRef.current;

        app.restoreFromIagon({ username: storedUsername, password: storedPassword })
            .catch((err) => console.error('[PageHeader] restoreFromIagon failed:', err));
    }, [app.agent.hasStarted, iagonStatus]);

    // Auto-backup after agent has started for the first time (new wallet)
    useEffect(() => {
        const shouldBackup =
            app.agent.hasStarted &&
            iagonStatus === 'idle' &&
            passwordRef.current &&
            usernameRef.current;

        if (!shouldBackup) return;

        const storedUsername = usernameRef.current;
        const storedPassword = passwordRef.current;

        app.backupToIagon({ username: storedUsername, password: storedPassword })
            .catch((err) => console.error('[PageHeader] backupToIagon failed:', err));
    }, [app.agent.hasStarted]);

    const handleLogin = async () => {
        if (!username.trim()) {
            setLoginError('Please enter your username');
            return;
        }
        if (!dbPassword) {
            setLoginError('Please enter your password');
            return;
        }

        setIsConnecting(true);
        setLoginError('');
        try {
            console.log('🔐 [PageHeader] Logging in as:', username);
            // Store credentials in refs so the restore/backup effects can access them
            passwordRef.current = dbPassword;
            usernameRef.current = username.trim();

            // Check if Iagon backup exists for this user
            app.dispatch(reduxActions.setIagonBackupStatus({ status: 'checking' }));
            const checkRes = await fetch('/api/wallet/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim() }),
            });
            const checkData = await checkRes.json();

            if (checkData.exists) {
                // Restore seed from backup before connecting DB
                // The seed is embedded in the encrypted backup on Iagon.
                // We first connect the DB (creates it fresh), then after agent starts,
                // restoreFromIagon will download the backup, restore seed + JWE.
                // The IagonBackup status guides index.tsx to trigger restore.
                console.log('📦 [PageHeader] Backup found in Iagon, will restore after agent starts');
                app.dispatch(reduxActions.setIagonBackupStatus({ status: 'downloading' }));
            } else {
                console.log('🆕 [PageHeader] No backup found, creating new wallet for:', username);
                app.dispatch(reduxActions.setIagonBackupStatus({ status: 'idle' }));
            }

            await app.connectDatabase({
                encryptionKey: Buffer.from(dbPassword),
                username: username.trim(),
            });
            console.log('✅ [PageHeader] Database connected successfully');
            // Auto-initialization will trigger from index.tsx
        } catch (error) {
            console.error('❌ [PageHeader] Login failed:', error);
            setLoginError(`Login failed: ${error.message || error}`);
            app.dispatch(reduxActions.setIagonBackupStatus({ status: 'idle' }));
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

                {/* Right Side: Login form OR Status/Buttons */}
                <div className="flex flex-row items-center gap-2">
                <div className="flex flex-col items-end space-y-1">
                    {!db.connected ? (
                        /* LOGIN FORM (username + password) */
                        <div className="flex flex-col items-end gap-1">
                            <div className="flex flex-col sm:flex-row gap-1.5">
                                <input
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleLogin()}
                                    placeholder="Username"
                                    autoComplete="username"
                                    className="px-3 py-1.5 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    style={{ width: '130px' }}
                                    disabled={isConnecting}
                                />
                                <input
                                    type="password"
                                    value={dbPassword}
                                    onChange={(e) => setDbPassword(e.target.value)}
                                    onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleLogin()}
                                    placeholder="Password"
                                    autoComplete="current-password"
                                    className="px-3 py-1.5 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    style={{ width: '130px' }}
                                    disabled={isConnecting}
                                />
                                <button
                                    onClick={handleLogin}
                                    disabled={isConnecting}
                                    className={`px-4 py-1.5 text-sm font-medium text-white rounded-md transition-colors ${
                                        isConnecting
                                            ? 'bg-gray-400 cursor-not-allowed'
                                            : 'bg-blue-600 hover:bg-blue-700'
                                    }`}
                                >
                                    {isConnecting ? 'Connecting...' : 'Login'}
                                </button>
                            </div>
                            {loginError && (
                                <p className="text-xs text-red-400">{loginError}</p>
                            )}
                            {iagonLabel && (
                                <p className="text-xs text-blue-300">{iagonLabel}</p>
                            )}
                        </div>
                    ) : (
                        /* WALLET STATUS (when connected) */
                        <>
                            {/* Status Display */}
                            <div className="text-right">
                                {app.username && (
                                    <p className="text-xs text-gray-400">
                                        {app.username}
                                    </p>
                                )}
                                <p className="text-sm font-medium">
                                    <b>Status:</b> {app.agent.instance?.state ?? "initializing..."}
                                </p>
                                {iagonLabel && (
                                    <p className={`text-xs ${iagonStatus === 'error' ? 'text-red-400' : iagonStatus === 'synced' ? 'text-green-400' : 'text-blue-300'}`}>
                                        {iagonLabel}
                                    </p>
                                )}
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
                                        className={`text-xs text-blue-500 transition-transform duration-300 ${isClicked ? "scale-110" : ""}`}
                                        title={`Unique ID: ${realPersonUniqueId}`}
                                    >
                                        Copy Unique ID
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>

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
