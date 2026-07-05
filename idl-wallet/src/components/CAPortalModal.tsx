import React, { useRef, useState, useCallback, useEffect } from 'react';
import { ensureSecurityClearanceKeys } from '@/utils/ensureSecurityKeys';
import { XIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/solid';

interface CAPortalModalProps {
  url: string;
  isMinimized: boolean;
  hasPendingRequests?: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onOpenDocument: (documentDID: string) => void;
}

export function CAPortalModal({ url, isMinimized, hasPendingRequests = false, onClose, onMinimize, onRestore, onOpenDocument }: CAPortalModalProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Track visited URL stack to know when back/forward are possible
  const [historyStack, setHistoryStack] = useState<string[]>([url]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyStack.length - 1;

  const handleLoad = useCallback(() => {
    try {
      const currentHref = iframeRef.current?.contentWindow?.location?.href;
      if (!currentHref) return;

      setHistoryStack(prev => {
        const expectedForward = prev[historyIndex + 1];
        // If navigating forward to a known entry, just advance the index
        if (expectedForward === currentHref) {
          setHistoryIndex(i => i + 1);
          return prev;
        }
        // New navigation — truncate forward history and append
        const newStack = prev.slice(0, historyIndex + 1);
        if (newStack[newStack.length - 1] !== currentHref) {
          setHistoryIndex(newStack.length);
          return [...newStack, currentHref];
        }
        return prev;
      });

      // Tell the dashboard iframe the wallet is ready (only on dashboard pages, not login/other pages)
      if (currentHref.includes('/dashboard')) {
        iframeRef.current?.contentWindow?.postMessage({
          type: 'WALLET_READY',
          walletId: 'idl',
          timestamp: Date.now()
        }, 'https://identuslabel.cz');
      }
    } catch {
      // Cross-origin guard (shouldn't happen on same domain)
    }
  }, [historyIndex]);

  // Listen for postMessages from the iframe (e.g. document open requests, key generation requests)
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== 'https://identuslabel.cz' && event.origin !== 'http://localhost:3010') return;
      if (event.data?.type === 'OPEN_DOCUMENT' && event.data?.documentDID) {
        onMinimize();
        onOpenDocument(event.data.documentDID);
      }
      if (event.data?.type === 'REQUEST_WALLET_KEYS') {
        console.log('[Wallet] REQUEST_WALLET_KEYS received from', event.origin);
        const keys = await ensureSecurityClearanceKeys();
        console.log('[Wallet] ensureSecurityClearanceKeys result:', keys ? 'ok' : 'null');
        const payload = {
          type: 'WALLET_KEYS',
          ed25519PublicKey: keys?.ed25519PublicKey ?? null,
          x25519PublicKey: keys?.x25519PublicKey ?? null,
        };
        console.log('[Wallet] Posting WALLET_KEYS to iframe:', !!payload.ed25519PublicKey, !!payload.x25519PublicKey);
        iframeRef.current?.contentWindow?.postMessage(payload, 'https://identuslabel.cz');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onMinimize, onOpenDocument]);

  const goBack = () => {
    iframeRef.current?.contentWindow?.history.back();
    setHistoryIndex(i => Math.max(0, i - 1));
  };

  const goForward = () => {
    iframeRef.current?.contentWindow?.history.forward();
    setHistoryIndex(i => Math.min(historyStack.length - 1, i + 1));
  };

  return (
    <>
      {/* Full-screen portal — hidden (not unmounted) when minimized to preserve session */}
      <div
        className="fixed inset-0 z-[10000] flex flex-col bg-slate-900"
        style={{ display: isMinimized ? 'none' : 'flex' }}
      >
        {/* Header bar */}
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 border-b border-slate-700 flex-shrink-0">
          {/* Back / Forward */}
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Back"
          >
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Forward"
          >
            <ChevronRightIcon className="w-5 h-5" />
          </button>

          {/* Title */}
          <span className="text-cyan-400 text-sm font-semibold flex-1">🔐 Portal</span>

          {/* Minimize */}
          <button
            onClick={onMinimize}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            aria-label="Minimize Portal"
            title="Minimize"
          >
            <span className="text-lg leading-none font-bold select-none">—</span>
          </button>

          {/* Close */}
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            aria-label="Close Portal"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Iframe fills remaining height — hidden (not unmounted) when a modal is active */}
        <iframe
          ref={iframeRef}
          src={url}
          className="flex-1 w-full border-0"
          style={{ visibility: hasPendingRequests ? 'hidden' : 'visible' }}
          title="Portal"
          onLoad={handleLoad}
        />
      </div>

      {/* Floating restore badge — shown only when minimized */}
      {isMinimized && (
        <div
          onClick={onRestore}
          className="fixed bottom-4 right-4 z-[10000] flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-full shadow-lg cursor-pointer transition-colors select-none"
          title="Restore Portal"
        >
          <span className="text-base">🔐</span>
          <span className="text-sm text-white font-medium">Portal</span>
        </div>
      )}
    </>
  );
}
