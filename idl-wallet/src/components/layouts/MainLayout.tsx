import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { IDLLogo } from '../IDLLogo';
import { NavItem } from '../NavItem';
import { useMountedApp } from '@/reducers/store';

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
  const [dbPassword, setDbPassword] = useState("elribonazo");
  const [isConnecting, setIsConnecting] = useState(false);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  useEffect(() => {
    // Pick up path already stored (e.g. from a previous flush)
    const stored = localStorage.getItem('wallet-log-file-path');
    if (stored) setLogFilePath(stored);

    const handler = (e: Event) => setLogFilePath((e as CustomEvent).detail);
    window.addEventListener('wallet-log-path', handler);
    return () => window.removeEventListener('wallet-log-path', handler);
  }, []);

  const isDbConnected = app.db?.connected;
  const agentStatus: keyof typeof STATUS_CONFIG =
    app.agent?.hasStarted ? 'connected' : app.agent?.isStarting ? 'syncing' : 'disconnected';
  const sc = STATUS_CONFIG[agentStatus];

  const handleConnect = async () => {
    if (!dbPassword) return;
    setIsConnecting(true);
    try {
      await app.connectDatabase({ encryptionKey: Buffer.from(dbPassword) });
      setShowPasswordInput(false);
    } catch (error: any) {
      alert(`Failed to connect: ${error.message || error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const navItems = [
    { id: '/',              icon: '🏠', label: 'Dashboard' },
    { id: '/credentials',   icon: '🎫', label: 'Credentials' },
    { id: '/documents',     icon: '📁', label: 'Documents' },
    { id: '/connections',   icon: '🔗', label: 'Connections' },
    { id: '/did-management',icon: '🔑', label: 'DID Management' },
    { id: '/messages',      icon: '💬', label: 'Messages' },
  ];

  const bottomNavItems = [
    { id: '/key-management', icon: '🔐', label: 'Key Management' },
    { id: '/configuration',  icon: '⚙️',  label: 'Configuration' },
    { id: '/debug',          icon: '🐛', label: 'Debug Console' },
  ];

  const currentPath = router.pathname;
  const selfDID = app.agent?.selfDID?.toString();
  const shortDID = selfDID
    ? `${selfDID.substring(0, 20)}...${selfDID.substring(selfDID.length - 10)}`
    : 'Not connected';

  const sidebarW   = sidebarOpen ? 'w-64' : 'w-16';
  const mainML     = sidebarOpen ? 'ml-64' : 'ml-16';
  const footerLeft = sidebarOpen ? 'left-64' : 'left-16';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Ambient glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative flex min-h-screen">
        {/* ── Sidebar ── */}
        <aside className={`${sidebarW} border-r border-slate-800/50 bg-slate-900/50 backdrop-blur-xl flex flex-col fixed h-full transition-all duration-200 overflow-hidden`}>

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
                      type="password"
                      value={dbPassword}
                      onChange={(e) => setDbPassword(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                      placeholder="Database password"
                      className="w-full px-3 py-2 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                      disabled={isConnecting}
                      autoFocus
                    />
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
        <main className={`flex-1 ${mainML} p-8 pb-20 overflow-auto transition-all duration-200`}>
          {children}
        </main>
      </div>

      {/* ── Status avatar + connect form — fixed top-right ── */}
      <div className="fixed top-4 right-6 z-50 flex items-center gap-3">
        {/* Inline connect form when disconnected */}
        {!isDbConnected && (
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-700/60 rounded-xl px-3 py-2 backdrop-blur-sm shadow-lg">
            <input
              type="password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
              placeholder="Wallet password"
              className="w-40 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
              disabled={isConnecting}
            />
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="px-3 py-1 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
            >
              {isConnecting ? '...' : 'Connect'}
            </button>
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

      {/* ── Footer ── */}
      <footer className={`fixed bottom-0 ${footerLeft} right-0 px-6 py-3 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800/50 transition-all duration-200`}>
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
    </div>
  );
};

export default MainLayout;
