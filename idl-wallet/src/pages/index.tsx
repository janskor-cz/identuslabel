import React, { useEffect, useState } from "react";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import '../app/index.css';
import { DBConnect } from "@/components/DBConnect";
import { useMountedApp } from "@/reducers/store";
import { QuickAction } from "@/components/QuickAction";
import { useRouter } from "next/router";
import { extractCredentialDisplayName as getCredentialDisplayName } from "@/utils/credentialNaming";

const ListenerKey = SDK.ListenerKey;

// Credential type styles for the card display
const typeStyles: Record<string, { gradient: string; border: string; icon: string; color: string }> = {
  enterprise: { gradient: 'from-cyan-500/20 to-blue-500/20', border: 'border-cyan-500/30', icon: '🏢', color: 'text-cyan-400' },
  employeerole: { gradient: 'from-cyan-500/20 to-blue-500/20', border: 'border-cyan-500/30', icon: '👤', color: 'text-cyan-400' },
  securityclearance: { gradient: 'from-red-500/20 to-rose-500/20', border: 'border-red-500/30', icon: '🛡️', color: 'text-red-400' },
  serviceconfiguration: { gradient: 'from-purple-500/20 to-indigo-500/20', border: 'border-purple-500/30', icon: '⚙️', color: 'text-purple-400' },
  cistraining: { gradient: 'from-emerald-500/20 to-green-500/20', border: 'border-emerald-500/30', icon: '📜', color: 'text-emerald-400' },
  default: { gradient: 'from-slate-500/20 to-gray-500/20', border: 'border-slate-500/30', icon: '🎫', color: 'text-slate-400' }
};

// Get credential type from schema
const getCredentialType = (credential: any): string => {
  try {
    const subjectStr = JSON.stringify(credential.credentialSubject || credential.claims || {}).toLowerCase();
    if (subjectStr.includes('clearancelevel') || subjectStr.includes('securitylevel')) return 'securityclearance';
    if (subjectStr.includes('employeeid') || subjectStr.includes('department')) return 'employeerole';
    if (subjectStr.includes('serviceendpoint') || subjectStr.includes('apikey')) return 'serviceconfiguration';
    if (subjectStr.includes('completiondate') || subjectStr.includes('training')) return 'cistraining';
    return 'default';
  } catch {
    return 'default';
  }
};

// Credential Card Component
const CredentialCard: React.FC<{ credential: any }> = ({ credential }) => {
  const credType = getCredentialType(credential);
  const style = typeStyles[credType] || typeStyles.default;
  const displayName = getCredentialDisplayName(credential);
  const issuer = credential.issuer?.toString?.()?.substring(0, 30) || 'Unknown Issuer';

  return (
    <div className={`p-4 rounded-2xl bg-gradient-to-br ${style.gradient} border ${style.border} backdrop-blur-sm`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{style.icon}</span>
          <div>
            <h4 className={`font-semibold ${style.color} capitalize`}>{displayName}</h4>
            <p className="text-xs text-slate-400 truncate max-w-[180px]">{issuer}...</p>
          </div>
        </div>
        <span className="px-2 py-1 text-xs rounded-full bg-emerald-500/20 text-emerald-400">
          active
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>ID: {credential.id?.substring(0, 20)}...</span>
      </div>
    </div>
  );
};

const Dashboard: React.FC = () => {
  const router = useRouter();
  const app = useMountedApp();
  const { db, mediatorDID, initAgent, startAgent } = app;
  const agent = app.agent.instance;

  const [state, setState] = useState<string>(agent && agent.state !== undefined ? agent.state : "loading");
  const [messages, setNewMessage] = useState<SDK.Domain.Message[]>([]);

  const handleMessages = async (newMessages: SDK.Domain.Message[]) => {
    setNewMessage([...newMessages, ...messages]);
  };

  useEffect(() => {
    setNewMessage([
      ...messages
        .filter(({ id }) => app.messages.find((appMessage) => appMessage.id === id) !== undefined)
        .map(({ id }) => app.messages.find((appMessage) => appMessage.id === id)!)
    ]);
  }, [app.messages]);

  useEffect(() => {
    if (!app.agent.instance && db.instance) {
      initAgent({ mediatorDID, pluto: db.instance, defaultSeed: app.defaultSeed });
    }
    if (app.agent && app.agent.instance) {
      setState(app.agent.instance.state);
    }
  }, [app.agent, db]);

  useEffect(() => {
    if (app.agent.instance && !app.agent.hasStarted && !app.agent.isStarting) {
      startAgent({ agent: app.agent.instance });
    }
  }, [app.agent.instance, app.agent.hasStarted, app.agent.isStarting]);

  useEffect(() => {
    if (agent) {
      agent.addListener(ListenerKey.MESSAGE, handleMessages);
    }
    return () => {
      if (agent) {
        agent.removeListener(ListenerKey.MESSAGE, handleMessages);
      }
    };
  }, [agent]);

  // Get recent credentials (max 4)
  const recentCredentials = app.credentials?.slice(0, 4) || [];

  return (
    <div>
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Welcome to IDL Wallet</h2>
          <p className="text-slate-400 text-sm">Manage your credentials and classified documents</p>
        </div>
        <div className="flex items-center gap-4">
          <button className="p-2 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 transition-colors text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </button>
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-purple-500 flex items-center justify-center font-bold">
            I
          </div>
        </div>
      </header>

      <DBConnect>
        {/* Quick Actions */}
      <section className="mb-8">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Quick Actions</h3>
        <div className="grid grid-cols-4 gap-4">
          <QuickAction icon="📤" label="My Documents" variant="primary" onClick={() => router.push('/my-documents')} />
          <QuickAction icon="🎫" label="Credentials" onClick={() => router.push('/credentials')} />
          <QuickAction icon="🔗" label="Connections" onClick={() => router.push('/connections')} />
          <QuickAction icon="📁" label="Documents" onClick={() => router.push('/documents')} />
        </div>
      </section>

      {/* Credentials Grid */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Your Credentials</h3>
          <button
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            onClick={() => router.push('/credentials')}
          >
            View All →
          </button>
        </div>
        {recentCredentials.length > 0 ? (
          <div className="grid grid-cols-2 gap-4">
            {recentCredentials.map((cred, i) => (
              <CredentialCard key={cred.id || i} credential={cred} />
            ))}
          </div>
        ) : (
          <div className="p-8 rounded-2xl bg-slate-800/30 border border-slate-700/50 text-center">
            <span className="text-4xl mb-4 block">🎫</span>
            <p className="text-slate-400">No credentials yet</p>
            <p className="text-slate-500 text-sm mt-2">Connect to an issuer to receive credentials</p>
          </div>
        )}
      </section>

      {/* Status Section */}
      <section className="mb-8">
        <div className="p-6 rounded-2xl bg-slate-800/30 border border-slate-700/50">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Agent Status</h3>
          <div className="grid grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-3xl font-bold text-white">{app.connections?.length || 0}</div>
              <div className="text-sm text-slate-400">Connections</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-white">{app.credentials?.length || 0}</div>
              <div className="text-sm text-slate-400">Credentials</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-white">{app.messages?.length || 0}</div>
              <div className="text-sm text-slate-400">Messages</div>
            </div>
          </div>
        </div>
      </section>

      {/* Classification Legend */}
      <section className="p-4 rounded-2xl bg-slate-800/20 border border-slate-700/30">
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Classification Levels</h4>
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
            <span className="text-sm text-slate-400">Unclassified</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-amber-500"></span>
            <span className="text-sm text-slate-400">Confidential</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500"></span>
            <span className="text-sm text-slate-400">Secret</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-700"></span>
            <span className="text-sm text-slate-400">Top Secret</span>
          </div>
        </div>
      </section>
      </DBConnect>
    </div>
  );
};

export default Dashboard;
