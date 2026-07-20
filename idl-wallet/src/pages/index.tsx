import React, { useEffect, useState } from "react";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import '../app/index.css';
import { DBConnect } from "@/components/DBConnect";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { useRouter } from "next/router";
import { getCredentialSubject } from "@/utils/credentialTypeDetector";
import { selectIsEnterpriseConfigured } from '@/reducers/enterpriseAgent';

const ListenerKey = SDK.ListenerKey;

const NAV_CARDS = [
  {
    icon: '🎫',
    label: 'Credentials',
    path: '/credentials',
    description: 'View and manage your verifiable credentials, security clearances and enterprise IDs.',
    gradient: 'from-cyan-500/20 to-blue-500/20',
    border: 'border-cyan-500/30',
    iconBg: 'bg-cyan-500/20',
    color: 'text-cyan-400',
  },
  {
    icon: '📁',
    label: 'Documents',
    path: '/documents',
    description: 'Browse classified documents available at your current clearance level.',
    gradient: 'from-indigo-500/20 to-slate-500/20',
    border: 'border-indigo-500/30',
    iconBg: 'bg-indigo-500/20',
    color: 'text-indigo-400',
  },
  {
    icon: '🔗',
    label: 'Connections',
    path: '/connections',
    description: 'Manage DIDComm connections with issuers, verifiers and enterprise agents.',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    border: 'border-emerald-500/30',
    iconBg: 'bg-emerald-500/20',
    color: 'text-emerald-400',
  },
  {
    icon: '💬',
    label: 'Messages',
    path: '/messages',
    description: 'Review incoming credential offers, presentation requests and protocol messages.',
    gradient: 'from-amber-500/20 to-orange-500/20',
    border: 'border-amber-500/30',
    iconBg: 'bg-amber-500/20',
    color: 'text-amber-400',
  },
];

const Dashboard: React.FC = () => {
  const router = useRouter();
  const app = useMountedApp();
  const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
  const { db } = app;
  const agent = app.agent.instance;
  const [messages, setNewMessage] = useState<SDK.Domain.Message[]>([]);

  useEffect(() => {
    setNewMessage([
      ...messages
        .filter(({ id }) => app.messages.find((m) => m.id === id) !== undefined)
        .map(({ id }) => app.messages.find((m) => m.id === id)!)
    ]);
  }, [app.messages]);

  // initAgent and startAgent are handled globally by AutoStartAgent (mounted in _app.tsx)

  useEffect(() => {
    if (agent) {
      agent.addListener(ListenerKey.MESSAGE, (newMsgs: SDK.Domain.Message[]) =>
        setNewMessage(prev => [...newMsgs, ...prev])
      );
    }
    return () => { if (agent) agent.removeListener(ListenerKey.MESSAGE, () => {}); };
  }, [agent]);

  // Extract first name from RealPersonIdentity VC
  const userName = (() => {
    if (!app.credentials?.length) return 'New User';
    for (const cred of app.credentials) {
      try {
        const subject = getCredentialSubject(cred);
        if (subject?.firstName) return subject.firstName;
      } catch { /* skip */ }
    }
    return 'New User';
  })();

  const isConnected = !!app.db?.connected;

  return (
    <div>
      {/* Greeting */}
      <header className="mb-8">
        {isConnected ? (
          <>
            <h2 className="text-2xl font-bold text-white mb-1">
              Welcome, <span className="bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">{userName}</span>
            </h2>
            <p className="text-slate-400 text-sm">Select a section below to get started</p>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-white mb-1">IDL Wallet</h2>
            <p className="text-slate-400 text-sm">Connect your wallet using the field in the top-right corner</p>
          </>
        )}
      </header>

      <DBConnect>
        {/* Navigation Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {NAV_CARDS.filter(card => card.path !== '/documents' || isEnterpriseConfigured).map(card => (
            <button
              key={card.path}
              onClick={() => router.push(card.path)}
              className={`text-left p-8 rounded-2xl bg-gradient-to-br ${card.gradient} border ${card.border} backdrop-blur-sm hover:scale-[1.02] hover:shadow-xl transition-all duration-200 group`}
            >
              <div className={`w-16 h-16 rounded-2xl ${card.iconBg} flex items-center justify-center text-4xl mb-6`}>
                {card.icon}
              </div>
              <h3 className={`font-bold text-xl ${card.color} mb-2`}>{card.label}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{card.description}</p>
            </button>
          ))}
        </div>
      </DBConnect>
    </div>
  );
};

export default Dashboard;
