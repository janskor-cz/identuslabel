import React, { createContext, useContext, useState, useCallback } from 'react';

export interface PendingAccessRequest {
  target: string;
  label: string;
  icon: string;
}

interface CAPortalContextValue {
  openCAPortal: (url: string) => void;
  closeCAPortal: () => void;
  minimizeCAPortal: () => void;
  restoreCAPortal: () => void;
  caPortalUrl: string | null;
  isMinimized: boolean;
  pendingDocumentDID: string | null;
  setPendingDocumentDID: (did: string | null) => void;
  pendingAccessRequest: PendingAccessRequest | null;
  setPendingAccessRequest: (req: PendingAccessRequest | null) => void;
}

const CAPortalContext = createContext<CAPortalContextValue>({
  openCAPortal: () => {},
  closeCAPortal: () => {},
  minimizeCAPortal: () => {},
  restoreCAPortal: () => {},
  caPortalUrl: null,
  isMinimized: false,
  pendingDocumentDID: null,
  setPendingDocumentDID: () => {},
  pendingAccessRequest: null,
  setPendingAccessRequest: () => {},
});

export function CAPortalProvider({ children }: { children: React.ReactNode }) {
  const [caPortalUrl, setCaPortalUrl] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [pendingDocumentDID, setPendingDocumentDID] = useState<string | null>(null);
  const [pendingAccessRequest, setPendingAccessRequest] = useState<PendingAccessRequest | null>(null);

  // Clears the pending status modal as a side-effect of opening the portal
  const openCAPortal = useCallback((url: string) => {
    setCaPortalUrl(url);
    setIsMinimized(false);
    setPendingAccessRequest(null);
  }, []);

  const closeCAPortal = useCallback(() => {
    setCaPortalUrl(null);
    setIsMinimized(false);
  }, []);

  const minimizeCAPortal = useCallback(() => setIsMinimized(true), []);
  const restoreCAPortal = useCallback(() => setIsMinimized(false), []);

  return (
    <CAPortalContext.Provider value={{
      openCAPortal,
      closeCAPortal,
      minimizeCAPortal,
      restoreCAPortal,
      caPortalUrl,
      isMinimized,
      pendingDocumentDID,
      setPendingDocumentDID,
      pendingAccessRequest,
      setPendingAccessRequest,
    }}>
      {children}
    </CAPortalContext.Provider>
  );
}

export function useCAPortal() {
  return useContext(CAPortalContext);
}
