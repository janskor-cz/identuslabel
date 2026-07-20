import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { IDLLogo } from '../IDLLogo';
import { NavItem } from '../NavItem';
import { useMountedApp, useAppSelector, store } from '@/reducers/store';
import { reduxActions } from '@/reducers/app';
import { selectIsEnterpriseConfigured } from '@/reducers/enterpriseAgent';
import { generateCredentialHash, decryptBackup } from '@/utils/walletCrypto';
import { clearAllConfigurations } from '@/utils/configurationStorage';

interface MainLayoutProps {
  children: React.ReactNode;
}

const STATUS_CONFIG = {
  connected:    { bg: 'bg-green-500',  ring: 'ring-green-400/60',  letter: 'C' },
  syncing:      { bg: 'bg-orange-500', ring: 'ring-orange-400/60', letter: 'S' },
  disconnected: { bg: 'bg-red-500',    ring: 'ring-red-400/60',    letter: 'D' },
} as const;

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const router = useRouter();
  const app = useMountedApp();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const usernameRef = useRef('');
  const passwordRef = useRef('');
  const iagonStatus = app.iagonBackup?.status ?? 'idle';

  useEffect(() => {
    // Pick up path already stored (e.g. from a previous flush)
    const stored = localStorage.getItem('wallet-log-file-path');
    if (stored) setLogFilePath(stored);

    const handler = (e: Event) => setLogFilePath((e as CustomEvent).detail);
    window.addEventListener('wallet-log-path', handler);
    return () => window.removeEventListener('wallet-log-path', handler);
  }, []);

  const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
  const isDbConnected = app.db?.connected;
  const agentStatus: keyof typeof STATUS_CONFIG =
    app.agent?.hasStarted ? 'connected' : app.agent?.isStarting ? 'syncing' : 'disconnected';
  const sc = STATUS_CONFIG[agentStatus];

  // Startup sync — runs once after agent boots
  useEffect(() => {
    if (!app.agent.hasStarted) return;
    if (!passwordRef.current || !usernameRef.current) return;
    if (iagonStatus === 'downloading' || iagonStatus === 'restoring' || iagonStatus === 'uploading') return;
    const u = usernameRef.current;
    const p = passwordRef.current;
    app.syncWalletBackup({ username: u, password: p })
      .catch((err: any) => console.error('[MainLayout] syncWalletBackup failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.agent.hasStarted]);

  // Restore effect — fires when agent is initialized (instance set) but NOT yet started.
  // Restore MUST happen before agent.start() because agent.start() writes mediator data to
  // Pluto, making the store non-empty and causing backup.restore() to throw.
  // AutoStartAgent blocks startAgent while iagonStatus is 'checking'/'downloading'/'restoring',
  // so the restore completes first, then startAgent is unblocked when status becomes 'synced'.
  useEffect(() => {
    if (!app.agent.instance) return;   // wait until agent is initialized
    if (app.agent.hasStarted) return;  // already started — too late to restore
    if (iagonStatus !== 'checking') return;
    const storedUsername = usernameRef.current;
    const storedPassword = passwordRef.current;
    if (!storedUsername || !storedPassword) return;
    app.restoreFromIagon({ username: storedUsername, password: storedPassword })
      .catch((err: any) => console.error('[MainLayout] restoreFromIagon failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.agent.instance, app.agent.hasStarted, iagonStatus]);

  const handleConnect = async () => {
    if (!username.trim()) { setLoginError('Please enter a username'); return; }
    if (!dbPassword) { setLoginError('Please enter a password'); return; }
    setLoginError('');
    setIsConnecting(true);
    try {
      const trimmedUser = username.trim();
      usernameRef.current = trimmedUser;
      passwordRef.current = dbPassword;

      // Clear any stale enterprise configuration from a previous session.
      // Config will be re-derived from actual credentials after the agent starts.
      clearAllConfigurations();

      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const credHash = await generateCredentialHash(trimmedUser, dbPassword);
      const checkRes = await fetch(`${basePath}/api/wallet/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credHash }),
      });
      const checkData = await checkRes.json();

      if (checkData.exists) {
        // Pre-load the correct seed BEFORE initAgent runs.
        // The JWE backup is encrypted with keys derived from the original seed.
        // If initAgent uses a wrong/random seed the subsequent backup.restore(jwe) will fail.
        // The outer backup envelope is password-encrypted (not seed-encrypted), so we can
        // decrypt it here to extract the seed without needing the agent at all.
        try {
          const dlRes = await fetch(`${basePath}/api/wallet/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credHash }),
          });
          if (dlRes.ok) {
            const { data: encryptedBase64 } = await dlRes.json();
            const payload = await decryptBackup(encryptedBase64, dbPassword, trimmedUser);
            app.dispatch(reduxActions.setDefaultSeed({
              value: new Uint8Array(payload.seedValue),
              size: payload.seedValue.length,
            }));
            console.log('🌱 [MainLayout] Seed pre-loaded from backup — initAgent will use correct keys');
          }
        } catch (seedErr: any) {
          console.warn('⚠️ [MainLayout] Could not pre-load seed from backup:', seedErr.message);
        }
      } else {
        // New username with no Iagon backup — generate a fresh per-user mnemonic.
        // No passphrase: the mnemonic itself is the only secret that needs protecting.
        // This becomes durable the same way the restore-branch's seed already is:
        // via backupToIagon, which bundles defaultSeed.value into the encrypted backup.
        const apollo = new SDK.Apollo();
        const mnemonics = apollo.createRandomMnemonics();
        const freshSeed = apollo.createSeed(mnemonics);
        app.dispatch(reduxActions.setDefaultSeed(freshSeed));
        console.log('🌱 [MainLayout] No backup found — generated a fresh per-user seed');
      }

      // Connect the DB (initAgent will fire once db.instance is available)
      await app.connectDatabase({
        encryptionKey: Buffer.from(dbPassword),
        username: trimmedUser,
      });
      setShowPasswordInput(false);

      if (checkData.exists) {
        // Check if the DB already has data (returning user) using the live Redux store.
        const liveState = store.getState().app;
        const dbHasData =
          (liveState.credentials?.length ?? 0) > 0 ||
          (liveState.connections?.length ?? 0) > 0;

        if (!dbHasData) {
          // Empty DB + Iagon backup found → trigger restore after agent starts
          console.log('📦 [MainLayout] Empty DB + backup found — will restore after agent starts');
          app.dispatch(reduxActions.setIagonBackupStatus({ status: 'checking' }));
        } else {
          // DB already has data — returning user, no restore needed
          // syncWalletBackup will run at agent start (status stays 'idle')
          console.log('ℹ️ [MainLayout] Existing wallet — skipping restore, will sync at agent start');
        }
      }
    } catch (error: any) {
      setLoginError(`Failed to connect: ${error.message || error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const navItems = [
    { id: '/',               icon: '🏠', label: 'Dashboard' },
    { id: '/credentials',    icon: '🎫', label: 'Credentials' },
    ...(isEnterpriseConfigured ? [{ id: '/documents', icon: '📁', label: 'Documents' }] : []),
    { id: '/connections',    icon: '🔗', label: 'Connections' },
    { id: '/messages',       icon: '💬', label: 'Messages' },
  ];

  const bottomNavItems = [
    { id: '/key-management', icon: '🔐', label: 'Key Management' },
    { id: '/configuration',  icon: '⚙️',  label: 'Configuration' },
  ];

  const currentPath = router.pathname;
  const selfDID = app.agent?.selfDID?.toString();
  const shortDID = selfDID
    ? `${selfDID.substring(0, 20)}...${selfDID.substring(selfDID.length - 10)}`
    : 'Not connected';

  useEffect(() => { setMoreOpen(false); }, [currentPath]);

  const sidebarW   = sidebarOpen ? 'w-64' : 'w-16';
  const mainML     = sidebarOpen ? 'md:ml-64' : 'md:ml-16';
  const footerLeft = sidebarOpen ? 'left-64' : 'left-16';

  const primaryTabs = [
    { id: '/',            icon: '🏠', label: 'Home' },
    { id: '/credentials', icon: '🎫', label: 'Credentials' },
    { id: '/connections', icon: '🔗', label: 'Connections' },
    { id: '/messages',    icon: '💬', label: 'Messages' },
  ];

  const moreItems = [
    ...(isEnterpriseConfigured ? [{ id: '/documents', icon: '📁', label: 'Documents' }] : []),
    { id: '/key-management', icon: '🔐', label: 'Key Management' },
    { id: '/configuration',  icon: '⚙️',  label: 'Configuration' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Ambient glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative flex min-h-screen">
        {/* ── Sidebar (desktop only) ── */}
        <aside className={`${sidebarW} border-r border-slate-800/50 bg-slate-900/50 backdrop-blur-xl hidden md:flex flex-col fixed h-full transition-all duration-200 overflow-hidden`}>

          {/* Logo */}
          <div className={`flex items-center ${sidebarOpen ? 'gap-3 px-6' : 'justify-center px-0'} py-6 mb-2`}>
            <IDLLogo size={36} />
            {sidebarOpen && (
              <div>
                <h1 className="font-bold text-base bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent whitespace-nowrap">
                  IDL Wallet
                </h1>
                <p className="text-xs text-slate-500">Identus Edge Agent</p>
              </div>
            )}
          </div>

          {/* Connect button — only in expanded mode */}
          {sidebarOpen && (
            <div className="px-4 mb-4">
              {!isDbConnected ? (
                showPasswordInput ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                      placeholder="Username"
                      className="w-full px-3 py-2 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                      disabled={isConnecting}
                      autoFocus
                    />
                    <input
                      type="password"
                      value={dbPassword}
                      onChange={(e) => setDbPassword(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                      placeholder="Password"
                      className="w-full px-3 py-2 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                      disabled={isConnecting}
                    />
                    {loginError && <p className="text-xs text-red-400">{loginError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleConnect}
                        disabled={isConnecting}
                        className={`flex-1 py-2 px-3 rounded-xl font-semibold text-sm transition-all ${
                          isConnecting ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                            : 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:opacity-90'}`}
                      >
                        {isConnecting ? '🔄' : '✓ Connect'}
                      </button>
                      <button
                        onClick={() => setShowPasswordInput(false)}
                        className="px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors"
                        disabled={isConnecting}
                      >✕</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowPasswordInput(true)}
                    className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 font-semibold text-white text-sm hover:opacity-90 transition-all flex items-center justify-center gap-2"
                  >
                    <span>🔒</span> Connect Agent
                  </button>
                )
              ) : null}
            </div>
          )}

          {/* Nav */}
          <nav className={`flex-1 space-y-1 overflow-y-auto ${sidebarOpen ? 'px-4' : 'px-2'}`}>
            {navItems.map(item => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                collapsed={!sidebarOpen}
                active={currentPath === item.id}
                onClick={() => router.push(item.id)}
              />
            ))}
          </nav>

          {/* Bottom nav + toggle */}
          <div className={`pt-4 border-t border-slate-800/50 space-y-1 ${sidebarOpen ? 'px-4' : 'px-2'}`}>
            {bottomNavItems.map(item => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                collapsed={!sidebarOpen}
                active={currentPath === item.id}
                onClick={() => router.push(item.id)}
              />
            ))}

            {/* Toggle button */}
            <button
              onClick={() => setSidebarOpen(o => !o)}
              className="w-full flex items-center justify-center py-2 mt-2 rounded-xl text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors border border-transparent"
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {sidebarOpen
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                }
              </svg>
            </button>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className={`flex-1 ${mainML} pt-16 pb-24 px-4 md:p-8 md:pb-20 overflow-auto transition-all duration-200`}>
          {children}
        </main>
      </div>

      {/* ── Status avatar + connect form — fixed top-right (desktop only) ── */}
      <div className="fixed top-4 right-6 z-50 hidden md:flex items-center gap-3">
        {/* Inline connect form when disconnected */}
        {!isDbConnected && (
          <div className="flex flex-col gap-1 bg-slate-900/90 border border-slate-700/60 rounded-xl px-3 py-2 backdrop-blur-sm shadow-lg">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                placeholder="Username"
                className="w-32 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none border-b border-slate-700 pb-0.5"
                disabled={isConnecting}
              />
              <input
                type="password"
                value={dbPassword}
                onChange={(e) => setDbPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                placeholder="Password"
                className="w-32 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none border-b border-slate-700 pb-0.5"
                disabled={isConnecting}
              />
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="px-3 py-1 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
              >
                {isConnecting ? '...' : 'Login'}
              </button>
            </div>
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
          </div>
        )}

        {/* Status circle */}
        <div
          className={`w-10 h-10 rounded-full ${sc.bg} ring-2 ${sc.ring} flex items-center justify-center font-bold text-white text-sm shadow-lg`}
          title={agentStatus}
        >
          {sc.letter}
        </div>
      </div>

      {/* ── Footer (desktop only) ── */}
      <footer className={`fixed bottom-0 ${footerLeft} right-0 px-6 py-3 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800/50 transition-all duration-200 hidden md:block`}>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-4">
            <span>Hyperledger Identus SDK v6.6.0</span>
            <span>·</span>
            <span className="font-mono">DID: {shortDID}</span>
            {logFilePath && (
              <>
                <span>·</span>
                <span className="font-mono" title={logFilePath}>Log: {logFilePath}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(logFilePath)}
                  title="Copy log path"
                  className="hover:text-cyan-400 transition-colors"
                >
                  📋
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${
              agentStatus === 'connected' ? 'bg-emerald-400' :
              agentStatus === 'syncing'   ? 'bg-amber-400 animate-pulse' :
              'bg-slate-400'}`}
            ></span>
            <span>{agentStatus === 'connected' ? 'PRISM Node Connected' : agentStatus === 'syncing' ? 'Connecting...' : 'Disconnected'}</span>
          </div>
        </div>
      </footer>

      {/* ══════════════════════════ Mobile-only chrome ══════════════════════════ */}

      {/* ── Mobile top bar ── */}
      <div
        className="fixed top-0 inset-x-0 z-50 md:hidden bg-slate-900/90 backdrop-blur-xl border-b border-slate-800/50"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">
            <IDLLogo size={26} />
            <span className="font-bold text-sm bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
              IDL Wallet
            </span>
          </div>
          {isDbConnected ? (
            <div
              className={`w-9 h-9 rounded-full ${sc.bg} ring-2 ${sc.ring} flex items-center justify-center font-bold text-white text-xs shadow-lg`}
              title={agentStatus}
            >
              {sc.letter}
            </div>
          ) : (
            <button
              onClick={() => setShowPasswordInput(o => !o)}
              className="flex items-center gap-1.5 px-3.5 min-h-11 rounded-full bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-sm font-semibold shadow-lg"
            >
              <span className={`w-2 h-2 rounded-full ${sc.bg}`} />
              🔒 Login
            </button>
          )}
        </div>

        {/* Mobile connect dropdown */}
        {!isDbConnected && showPasswordInput && (
          <div className="px-4 pb-4 space-y-2 border-t border-slate-800/50 pt-3">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
              placeholder="Username"
              className="w-full px-3 py-2.5 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              disabled={isConnecting}
              autoFocus
            />
            <input
              type="password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
              placeholder="Password"
              className="w-full px-3 py-2.5 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              disabled={isConnecting}
            />
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className={`w-full py-2.5 rounded-xl font-semibold text-sm min-h-11 transition-all ${
                isConnecting ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:opacity-90'}`}
            >
              {isConnecting ? '🔄 Connecting…' : '🔒 Connect Agent'}
            </button>
          </div>
        )}
      </div>

      {/* ── Mobile bottom tab bar ── */}
      <nav
        className="fixed bottom-0 inset-x-0 z-50 md:hidden flex border-t border-slate-800/50 bg-slate-900/90 backdrop-blur-xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {primaryTabs.map(tab => {
          const active = currentPath === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => router.push(tab.id)}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 py-2"
            >
              <span className={`text-lg ${active ? 'opacity-100' : 'opacity-55'}`}>{tab.icon}</span>
              <span className={`text-[10px] font-medium ${active ? 'text-white font-semibold' : 'text-slate-400'}`}>
                {tab.label}
              </span>
              {active && <span className="w-1 h-1 rounded-full bg-cyan-400 -mt-0.5" />}
            </button>
          );
        })}
        <button
          onClick={() => setMoreOpen(true)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 py-2"
        >
          <span className={`text-lg ${moreOpen || moreItems.some(m => m.id === currentPath) ? 'opacity-100' : 'opacity-55'}`}>⋯</span>
          <span className={`text-[10px] font-medium ${moreItems.some(m => m.id === currentPath) ? 'text-white font-semibold' : 'text-slate-400'}`}>
            More
          </span>
        </button>
      </nav>

      {/* ── Mobile "More" sheet ── */}
      {moreOpen && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div className="absolute inset-0 bg-black/55" onClick={() => setMoreOpen(false)} />
          <div
            className="absolute left-0 right-0 bottom-0 bg-[#131c31] rounded-t-3xl shadow-2xl max-h-[80vh] overflow-y-auto"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="w-9 h-1 rounded-full bg-white/20 mx-auto mt-2.5 mb-1" />
            <nav className="px-2 py-2">
              {moreItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => router.push(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 min-h-11 rounded-xl ${
                    currentPath === item.id ? 'bg-white/10' : ''}`}
                >
                  <span className="text-xl">{item.icon}</span>
                  <span className={`text-sm ${currentPath === item.id ? 'text-white font-semibold' : 'text-slate-300'}`}>
                    {item.label}
                  </span>
                </button>
              ))}
            </nav>
            <div className="px-5 py-4 border-t border-white/10 text-xs text-slate-500 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  agentStatus === 'connected' ? 'bg-emerald-400' :
                  agentStatus === 'syncing'   ? 'bg-amber-400 animate-pulse' :
                  'bg-slate-400'}`}
                ></span>
                <span>{agentStatus === 'connected' ? 'PRISM Node Connected' : agentStatus === 'syncing' ? 'Connecting...' : 'Disconnected'}</span>
              </div>
              <div>Hyperledger Identus SDK v6.6.0</div>
              <div className="font-mono break-all">DID: {shortDID}</div>
              {logFilePath && (
                <div className="flex items-center gap-2">
                  <span className="font-mono break-all">Log: {logFilePath}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(logFilePath)}
                    title="Copy log path"
                    className="hover:text-cyan-400 transition-colors shrink-0"
                  >
                    📋
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MainLayout;
