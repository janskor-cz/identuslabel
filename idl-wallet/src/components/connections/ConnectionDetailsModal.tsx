/**
 * ConnectionDetailsModal — replaces the inline "▼ details" expand panel that used to render
 * directly under each list row (raw DID/connection-ID fields). Just relocated into a modal since
 * the card grid has no row to expand underneath. The "which VCs came from this connection" view
 * that used to be embedded here now lives in its own dedicated modal
 * (ConnectionCredentialsModal, opened via ConnectionCard's 📜 button) instead of being buried in
 * this raw-DID-fields view.
 */
import React from 'react';
import { copyToClipboardWithLog } from '@/utils/clipboard';

export interface ConnectionDetailsField {
  label: string;
  value: string;
}

interface ConnectionDetailsModalProps {
  displayName: string;
  fields: ConnectionDetailsField[];
  onClose: () => void;
}

export function ConnectionDetailsModal({ displayName, fields, onClose }: ConnectionDetailsModalProps) {
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const copy = async (text: string, label: string) => {
    try {
      await copyToClipboardWithLog(text, label);
    } catch (error) {
      console.error(`Failed to copy ${label}:`, error);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">Connection Details</h2>
            <p className="text-slate-400 text-sm mt-1 truncate">{displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white hover:bg-slate-800/50 rounded-lg p-2 transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3">
          {fields.map(({ label, value }) => (
            <div key={label} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-semibold text-slate-300">{label}</label>
                <button onClick={() => copy(value, label)} className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">
                  📋 Copy
                </button>
              </div>
              <p className="text-xs font-mono text-slate-400 break-all bg-slate-900/50 p-2 border border-slate-700/50 rounded">
                {value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
