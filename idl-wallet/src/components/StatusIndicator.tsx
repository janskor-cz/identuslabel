import React from 'react';

type Status = 'connected' | 'disconnected' | 'syncing';

interface StatusIndicatorProps {
  status: Status;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status }) => {
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

export default StatusIndicator;
