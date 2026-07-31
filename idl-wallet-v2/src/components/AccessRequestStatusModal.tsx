import React from 'react';
import { PendingAccessRequest } from '@/utils/CAPortalContext';

interface Props {
  request: PendingAccessRequest;
  onClose: () => void;
}

export function AccessRequestStatusModal({ request, onClose }: Props) {
  const failed = !!request.error;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={`bg-slate-900 border rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl ${failed ? 'border-red-500/30' : 'border-cyan-500/30'}`}>
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <h3 className="text-white font-bold text-lg">{failed ? '⚠️ Access Denied' : '🔓 Requesting Access'}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-700/50 -mt-1"
            title={failed ? 'Close' : 'Close — you can still approve the request'}
          >
            ✕
          </button>
        </div>

        {/* Target */}
        <div className="flex flex-col items-center py-4">
          <div className={`w-16 h-16 rounded-2xl border flex items-center justify-center text-3xl mb-3 ${failed ? 'bg-red-500/20 border-red-500/30' : 'bg-cyan-500/20 border-cyan-500/30'}`}>
            {failed ? '⛔' : request.icon}
          </div>
          <p className="text-white font-semibold text-base">{request.label}</p>
        </div>

        {failed ? (
          <>
            <div className="space-y-3 mt-4">
              <Step done label="Request sent to CA" />
              <Step failed label={request.error!.message} />
            </div>
            <button
              onClick={onClose}
              className="mt-5 w-full py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-colors text-sm font-medium"
            >
              Close
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

function Step({ done, pending, idle, failed, label }: {
  done?: boolean; pending?: boolean; idle?: boolean; failed?: boolean; label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center">
        {done    && <span className="text-emerald-400 text-sm">✅</span>}
        {pending && <Spinner />}
        {idle    && <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />}
        {failed  && <span className="text-red-400 text-sm">✕</span>}
      </div>
      <span className={`text-sm ${done ? 'text-emerald-400' : pending ? 'text-cyan-300' : failed ? 'text-red-300' : 'text-slate-500'}`}>
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
