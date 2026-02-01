import React, { useState } from 'react';

const IDLLogo = ({ size = 40 }) => (
  <svg viewBox="0 0 200 220" width={size} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#dc2626"/>
        <stop offset="50%" stopColor="#f59e0b"/>
        <stop offset="100%" stopColor="#22c55e"/>
      </linearGradient>
      <linearGradient id="keyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00d4ff"/>
        <stop offset="100%" stopColor="#7c3aed"/>
      </linearGradient>
    </defs>
    <path d="M100 10 L180 40 L180 110 Q180 180 100 220 Q20 180 20 110 L20 40 Z" 
          fill="none" stroke="url(#shieldGrad)" strokeWidth="12"/>
    <text x="100" y="65" textAnchor="middle" fill="#22c55e" fontSize="36" fontWeight="bold" fontFamily="Arial">I</text>
    <text x="100" y="110" textAnchor="middle" fill="#f59e0b" fontSize="36" fontWeight="bold" fontFamily="Arial">D</text>
    <text x="100" y="155" textAnchor="middle" fill="#dc2626" fontSize="36" fontWeight="bold" fontFamily="Arial">L</text>
    <circle cx="100" cy="185" r="12" fill="url(#keyGrad)"/>
  </svg>
);

const StatusIndicator = ({ status }) => {
  const colors = {
    connected: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/50', dot: 'bg-emerald-400', text: 'text-emerald-400' },
    disconnected: { bg: 'bg-slate-500/20', border: 'border-slate-500/50', dot: 'bg-slate-400', text: 'text-slate-400' },
    syncing: { bg: 'bg-amber-500/20', border: 'border-amber-500/50', dot: 'bg-amber-400', text: 'text-amber-400' }
  };
  const c = colors[status] || colors.disconnected;
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${c.bg} border ${c.border}`}>
      <span className={`w-2 h-2 rounded-full ${c.dot} ${status === 'syncing' ? 'animate-pulse' : ''}`}></span>
      <span className={`text-xs font-medium ${c.text} uppercase tracking-wider`}>{status}</span>
    </div>
  );
};

const NavItem = ({ icon, label, active, badge, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group
      ${active 
        ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/30' 
        : 'hover:bg-white/5 border border-transparent'}`}
  >
    <span className={`text-xl ${active ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-300'}`}>
      {icon}
    </span>
    <span className={`flex-1 text-left text-sm font-medium ${active ? 'text-white' : 'text-slate-300'}`}>
      {label}
    </span>
    {badge && (
      <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
        {badge}
      </span>
    )}
  </button>
);

const CredentialCard = ({ type, status, issuer, expiresAt }) => {
  const typeStyles = {
    enterprise: { gradient: 'from-cyan-500/20 to-blue-500/20', border: 'border-cyan-500/30', icon: '🏢', color: 'text-cyan-400' },
    public: { gradient: 'from-emerald-500/20 to-green-500/20', border: 'border-emerald-500/30', icon: '🌍', color: 'text-emerald-400' },
    internal: { gradient: 'from-amber-500/20 to-orange-500/20', border: 'border-amber-500/30', icon: '🔒', color: 'text-amber-400' },
    confidential: { gradient: 'from-red-500/20 to-rose-500/20', border: 'border-red-500/30', icon: '🛡️', color: 'text-red-400' }
  };
  const style = typeStyles[type] || typeStyles.enterprise;
  
  return (
    <div className={`p-4 rounded-2xl bg-gradient-to-br ${style.gradient} border ${style.border} backdrop-blur-sm`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{style.icon}</span>
          <div>
            <h4 className={`font-semibold ${style.color} capitalize`}>{type}</h4>
            <p className="text-xs text-slate-400">{issuer}</p>
          </div>
        </div>
        <span className={`px-2 py-1 text-xs rounded-full ${status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-400'}`}>
          {status}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Expires: {expiresAt}</span>
        <button className="text-cyan-400 hover:text-cyan-300 transition-colors">View →</button>
      </div>
    </div>
  );
};

const QuickAction = ({ icon, label, onClick, variant = 'default' }) => {
  const variants = {
    default: 'bg-slate-800/50 hover:bg-slate-700/50 border-slate-700/50 text-slate-300',
    primary: 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 hover:from-cyan-500/30 hover:to-purple-500/30 border-cyan-500/30 text-cyan-400'
  };
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all duration-200 ${variants[variant]}`}
    >
      <span className="text-2xl">{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
};

const DocumentRow = ({ name, classification, date, size }) => {
  const classColors = {
    public: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    internal: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    confidential: 'bg-red-500/20 text-red-400 border-red-500/30'
  };
  return (
    <div className="flex items-center gap-4 p-3 rounded-xl hover:bg-white/5 transition-colors group">
      <div className="w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center text-slate-400">
        📄
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-white truncate">{name}</h4>
        <p className="text-xs text-slate-500">{date} • {size}</p>
      </div>
      <span className={`px-2 py-1 text-xs rounded-full border uppercase font-medium ${classColors[classification]}`}>
        {classification}
      </span>
      <button className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white transition-all">
        ⋮
      </button>
    </div>
  );
};

export default function AliceWalletRedesign() {
  const [activeNav, setActiveNav] = useState('dashboard');
  const [isConnected, setIsConnected] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);

  const navItems = [
    { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
    { id: 'credentials', icon: '🎫', label: 'Credentials', badge: '4' },
    { id: 'documents', icon: '📁', label: 'Documents', badge: '12' },
    { id: 'connections', icon: '🔗', label: 'Connections', badge: '3' },
    { id: 'dids', icon: '🔑', label: 'DID Management' },
    { id: 'messages', icon: '💬', label: 'Messages', badge: '2' },
  ];

  const credentials = [
    { type: 'enterprise', status: 'active', issuer: 'Acme Corporation', expiresAt: 'Dec 2025' },
    { type: 'public', status: 'active', issuer: 'Classification Authority', expiresAt: 'Mar 2026' },
    { type: 'internal', status: 'active', issuer: 'Classification Authority', expiresAt: 'Mar 2026' },
    { type: 'confidential', status: 'pending', issuer: 'Classification Authority', expiresAt: 'Pending' },
  ];

  const recentDocs = [
    { name: 'Q4 Financial Report.pdf', classification: 'confidential', date: 'Jan 2, 2026', size: '2.4 MB' },
    { name: 'Team Guidelines v2.pdf', classification: 'internal', date: 'Dec 28, 2025', size: '156 KB' },
    { name: 'Public Press Release.pdf', classification: 'public', date: 'Dec 20, 2025', size: '89 KB' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Ambient background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative flex min-h-screen">
        {/* Sidebar */}
        <aside className="w-72 border-r border-slate-800/50 bg-slate-900/50 backdrop-blur-xl p-6 flex flex-col">
          {/* Logo & Identity */}
          <div className="flex items-center gap-3 mb-8">
            <IDLLogo size={44} />
            <div>
              <h1 className="font-bold text-lg bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
                Alice Wallet
              </h1>
              <p className="text-xs text-slate-500">Identus Edge Agent</p>
            </div>
          </div>

          {/* Connection Status */}
          <div className="mb-6">
            {isConnected ? (
              <StatusIndicator status="connected" />
            ) : (
              <button 
                onClick={() => setIsConnected(true)}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-semibold text-sm hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                <span>🔒</span> Connect Agent
              </button>
            )}
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-1">
            {navItems.map(item => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                badge={item.badge}
                active={activeNav === item.id}
                onClick={() => setActiveNav(item.id)}
              />
            ))}
          </nav>

          {/* Bottom Section */}
          <div className="pt-4 border-t border-slate-800/50 space-y-1">
            <NavItem icon="⚙️" label="Configuration" onClick={() => setActiveNav('config')} />
            <NavItem icon="🐛" label="Debug Console" onClick={() => setActiveNav('debug')} />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8 overflow-auto">
          {/* Header */}
          <header className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Welcome back, Alice</h2>
              <p className="text-slate-400 text-sm">Manage your credentials and classified documents</p>
            </div>
            <div className="flex items-center gap-4">
              <button className="p-2 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 transition-colors text-slate-400 hover:text-white">
                🔔
              </button>
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-purple-500 flex items-center justify-center font-bold">
                A
              </div>
            </div>
          </header>

          {/* Quick Actions */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Quick Actions</h3>
            <div className="grid grid-cols-4 gap-4">
              <QuickAction icon="📤" label="Upload Document" variant="primary" />
              <QuickAction icon="🎫" label="Request Credential" />
              <QuickAction icon="🔗" label="New Connection" />
              <QuickAction icon="✅" label="Verify Document" />
            </div>
          </section>

          {/* Credentials Grid */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Your Credentials</h3>
              <button className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">View All →</button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {credentials.map((cred, i) => (
                <CredentialCard key={i} {...cred} />
              ))}
            </div>
          </section>

          {/* Recent Documents */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Recent Documents</h3>
              <button className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">View All →</button>
            </div>
            <div className="bg-slate-800/30 rounded-2xl border border-slate-700/50 overflow-hidden">
              <div className="divide-y divide-slate-700/30">
                {recentDocs.map((doc, i) => (
                  <DocumentRow key={i} {...doc} />
                ))}
              </div>
            </div>
          </section>

          {/* Classification Legend */}
          <section className="mt-8 p-4 rounded-2xl bg-slate-800/20 border border-slate-700/30">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Classification Levels</h4>
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
                <span className="text-sm text-slate-400">Public</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-amber-500"></span>
                <span className="text-sm text-slate-400">Internal</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-red-500"></span>
                <span className="text-sm text-slate-400">Confidential</span>
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* Footer bar */}
      <footer className="fixed bottom-0 left-0 right-0 px-6 py-3 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800/50">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-4">
            <span>Hyperledger Identus SDK v6.6.0</span>
            <span>•</span>
            <span>DID: did:prism:abc123...xyz789</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              PRISM Node Connected
            </span>
            <span>•</span>
            <span>Last sync: Just now</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
