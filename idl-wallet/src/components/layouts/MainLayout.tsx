import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { IDLLogo } from '../IDLLogo';
import { NavItem } from '../NavItem';
import { StatusIndicator } from '../StatusIndicator';
import { useMountedApp } from '@/reducers/store';

interface MainLayoutProps {
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const router = useRouter();
  const app = useMountedApp();

  // Database connection state
  const [dbPassword, setDbPassword] = useState("elribonazo");
  const [isConnecting, setIsConnecting] = useState(false);
  const [showPasswordInput, setShowPasswordInput] = useState(false);

  const isDbConnected = app.db?.connected;
  const agentStatus = app.agent?.hasStarted ? 'connected' : app.agent?.isStarting ? 'syncing' : 'disconnected';

  const handleConnect = async () => {
    if (!dbPassword) {
      alert('Please enter database password');
      return;
    }

    setIsConnecting(true);
    try {
      console.log('🔐 [MainLayout] Connecting to database...');
      await app.connectDatabase({
        encryptionKey: Buffer.from(dbPassword)
      });
      console.log('✅ [MainLayout] Database connected successfully');
      setShowPasswordInput(false);
    } catch (error: any) {
      console.error('❌ [MainLayout] Database connection failed:', error);
      alert(`Failed to connect: ${error.message || error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const navItems = [
    { id: '/', icon: '🏠', label: 'Dashboard' },
    { id: '/credentials', icon: '🎫', label: 'Credentials', badge: app.credentials?.length || undefined },
    { id: '/documents', icon: '📁', label: 'Documents' },
    { id: '/connections', icon: '🔗', label: 'Connections', badge: app.connections?.length || undefined },
    { id: '/did-management', icon: '🔑', label: 'DID Management' },
    { id: '/messages', icon: '💬', label: 'Messages', badge: app.messages?.length || undefined },
  ];

  const bottomNavItems = [
    { id: '/key-management', icon: '🔐', label: 'Key Management' },
    { id: '/configuration', icon: '⚙️', label: 'Configuration' },
    { id: '/debug', icon: '🐛', label: 'Debug Console' },
  ];

  const currentPath = router.pathname;

  // Get wallet name from state or default
  const walletName = app.wallet?.walletName || 'IDL Wallet';

  // Get DID for footer
  const selfDID = app.agent?.selfDID?.toString();
  const shortDID = selfDID ? `${selfDID.substring(0, 20)}...${selfDID.substring(selfDID.length - 10)}` : 'Not connected';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Ambient background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative flex min-h-screen">
        {/* Sidebar */}
        <aside className="w-72 border-r border-slate-800/50 bg-slate-900/50 backdrop-blur-xl p-6 flex flex-col fixed h-full">
          {/* Logo & Identity */}
          <div className="flex items-center gap-3 mb-8">
            <IDLLogo size={44} />
            <div>
              <h1 className="font-bold text-lg bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
                {walletName}
              </h1>
              <p className="text-xs text-slate-500">Identus Edge Agent</p>
            </div>
          </div>

          {/* Connection Status / Connect Button */}
          <div className="mb-6">
            {isDbConnected ? (
              <StatusIndicator status={agentStatus} />
            ) : showPasswordInput ? (
              /* Password input form */
              <div className="space-y-3">
                <input
                  type="password"
                  value={dbPassword}
                  onChange={(e) => setDbPassword(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && !isConnecting && handleConnect()}
                  placeholder="Database password"
                  className="w-full px-4 py-2 text-sm rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  disabled={isConnecting}
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleConnect}
                    disabled={isConnecting}
                    className={`flex-1 py-2 px-4 rounded-xl font-semibold text-sm transition-all ${
                      isConnecting
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white hover:shadow-lg hover:shadow-cyan-500/25'
                    }`}
                  >
                    {isConnecting ? '🔄 Connecting...' : '✓ Connect'}
                  </button>
                  <button
                    onClick={() => setShowPasswordInput(false)}
                    className="px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors"
                    disabled={isConnecting}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              /* Connect Agent button */
              <button
                onClick={() => setShowPasswordInput(true)}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 font-semibold text-white hover:shadow-lg hover:shadow-cyan-500/25 transition-all flex items-center justify-center gap-2"
              >
                <span>🔒</span> Connect Agent
              </button>
            )}
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-1 overflow-y-auto">
            {navItems.map(item => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                badge={item.badge}
                active={currentPath === item.id}
                onClick={() => router.push(item.id)}
              />
            ))}
          </nav>

          {/* Bottom Section */}
          <div className="pt-4 border-t border-slate-800/50 space-y-1">
            {bottomNavItems.map(item => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={currentPath === item.id}
                onClick={() => router.push(item.id)}
              />
            ))}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 ml-72 p-8 pb-20 overflow-auto">
          {children}
        </main>
      </div>

      {/* Footer bar */}
      <footer className="fixed bottom-0 left-72 right-0 px-6 py-3 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800/50">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-4">
            <span>Hyperledger Identus SDK v6.6.0</span>
            <span>·</span>
            <span className="font-mono">DID: {shortDID}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${agentStatus === 'connected' ? 'bg-emerald-400' : agentStatus === 'syncing' ? 'bg-amber-400 animate-pulse' : 'bg-slate-400'}`}></span>
              {agentStatus === 'connected' ? 'PRISM Node Connected' : agentStatus === 'syncing' ? 'Connecting...' : 'Disconnected'}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default MainLayout;
