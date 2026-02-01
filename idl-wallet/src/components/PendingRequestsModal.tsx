/**
 * PendingRequestsModal Component
 *
 * Modal that displays pending connection requests.
 * Opens when user clicks the notification badge in the Connections tab header.
 *
 * Features:
 * - Close button (X) in header
 * - Backdrop click closes modal
 * - Uses existing ConnectionRequest component for each request
 * - Shows loading, error, and empty states
 */

import React from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { ConnectionRequest } from '@/components/ConnectionRequest';
import { ConnectionRequestItem } from '@/utils/connectionRequestQueue';

interface PendingRequestsModalProps {
  visible: boolean;
  onClose: () => void;
  requests: ConnectionRequestItem[];
  onRequestHandled: (requestId: string, action: 'accepted' | 'rejected', verificationResult?: any) => Promise<void>;
  queueLoading: boolean;
  queueError: string | null;
  refreshConnections: () => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
}

export const PendingRequestsModal: React.FC<PendingRequestsModalProps> = ({
  visible,
  onClose,
  requests,
  onRequestHandled,
  queueLoading,
  queueError,
  refreshConnections,
  deleteMessage
}) => {
  if (!visible) return null;

  /**
   * Calculate age indicator for request
   */
  const getAgeIndicator = (timestamp: number): string => {
    const ageHours = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60));
    if (ageHours < 1) return 'New';
    if (ageHours < 24) return `${ageHours}h ago`;
    const ageDays = Math.floor(ageHours / 24);
    return `${ageDays}d ago`;
  };

  /**
   * Handle backdrop click to close modal
   */
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">🤝</span>
            <div>
              <h2 className="text-xl font-bold text-white">Pending Connection Requests</h2>
              <p className="text-slate-400 text-sm mt-1">
                {requests.length} request{requests.length !== 1 ? 's' : ''} awaiting your response
              </p>
            </div>
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Error State */}
          {queueError && (
            <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-4 mb-4">
              <div className="flex items-center space-x-2">
                <span className="text-red-400">Error loading connection requests: {queueError}</span>
              </div>
            </div>
          )}

          {/* Loading State */}
          {queueLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center space-x-2 text-slate-400">
                <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Loading connection requests...</span>
              </div>
            </div>
          ) : requests.length === 0 ? (
            /* Empty State */
            <div className="text-center py-12">
              <div className="text-slate-500 mb-4">
                <span className="text-6xl">🤝</span>
              </div>
              <h3 className="text-lg font-medium text-white mb-2">
                No Pending Requests
              </h3>
              <p className="text-slate-400 mb-2">
                You don't have any pending connection requests.
              </p>
              <p className="text-xs text-slate-500">
                Connection requests with credential presentations will appear here.
              </p>
            </div>
          ) : (
            /* Request List */
            <div className="space-y-4">
              {requests.map((requestItem, i) => {
                // Reconstruct the SDK.Domain.Message from stored data
                const reconstructedMessage = {
                  ...requestItem.message,
                  from: requestItem.message.from ? {
                    toString: () => requestItem.message.from
                  } : null,
                  to: requestItem.message.to ? {
                    toString: () => requestItem.message.to
                  } : null
                } as unknown as SDK.Domain.Message;

                return (
                  <div key={`pending-request-${requestItem.id}-${i}`} className="relative">
                    {/* Request Age Indicator */}
                    <div className="absolute top-2 right-2 z-10">
                      <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs px-2 py-1 rounded-full">
                        {getAgeIndicator(requestItem.timestamp)}
                      </span>
                    </div>

                    <ConnectionRequest
                      message={reconstructedMessage}
                      attachedCredential={requestItem.attachedCredential}
                      onRequestHandled={async () => {
                        try {
                          // Mark as handled in persistent queue
                          await onRequestHandled(requestItem.id, 'accepted');

                          // Also delete from message database if exists
                          if (deleteMessage) {
                            await deleteMessage(requestItem.message.id);
                          }

                          // Force refresh connections to update the UI
                          if (refreshConnections) {
                            await refreshConnections();
                          }
                        } catch (error) {
                          console.error('Failed to handle persistent request:', error);
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-white font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
