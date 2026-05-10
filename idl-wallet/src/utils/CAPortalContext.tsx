import React, { createContext, useContext, useState, useCallback } from 'react';

interface CAPortalContextValue {
  openCAPortal: (url: string) => void;
  closeCAPortal: () => void;
  minimizeCAPortal: () => void;
  restoreCAPortal: () => void;
  caPortalUrl: string | null;
  isMinimized: boolean;
  pendingDocumentDID: string | null;
  setPendingDocumentDID: (did: string | null) => void;
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
});

export function CAPortalProvider({ children }: { children: React.ReactNode }) {
  const [caPortalUrl, setCaPortalUrl] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [pendingDocumentDID, setPendingDocumentDID] = useState<string | null>(null);

  const openCAPortal = useCallback((url: string) => {
    setCaPortalUrl(url);
    setIsMinimized(false);
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
    }}>
      {children}
    </CAPortalContext.Provider>
  );
}

export function useCAPortal() {
  return useContext(CAPortalContext);
}
