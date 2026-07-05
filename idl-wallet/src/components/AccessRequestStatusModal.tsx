import React from 'react';
import { PendingAccessRequest } from '@/utils/CAPortalContext';

interface Props {
  request: PendingAccessRequest;
  onClose: () => void;
}

export function AccessRequestStatusModal({ request, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-cyan-500/30 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <h3 className="text-white font-bold text-lg">🔓 Requesting Access</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-700/50 -mt-1"
            title="Close — you can still approve the request"
          >
            ✕
          </button>
        </div>

        {/* Target */}
        <div className="flex flex-col items-center py-4">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-3xl mb-3">
            {request.icon}
          </div>
          <p className="text-white font-semibold text-base">{request.label}</p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mt-4">
          <Step done label="Request sent to CA" />
          <Step pending label="Waiting for VC proof request…" />
          <Step idle label="Identity verified — opening access" />
        </div>

        <p className="text-xs text-slate-500 text-center mt-5">
          A proof request will appear — approve it to continue.
          You can close this window; the access link will arrive in chat.
        </p>
      </div>
    </div>
  );
}

function Step({ done, pending, idle, label }: {
  done?: boolean; pending?: boolean; idle?: boolean; label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center">
        {done    && <span className="text-emerald-400 text-sm">✅</span>}
        {pending && <Spinner />}
        {idle    && <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />}
      </div>
      <span className={`text-sm ${done ? 'text-emerald-400' : pending ? 'text-cyan-300' : 'text-slate-500'}`}>
        {label}
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <div
      className="w-4 h-4 rounded-full border-2 border-slate-600 border-t-cyan-400 animate-spin"
    />
  );
}
