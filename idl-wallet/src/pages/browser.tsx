import React, { useMemo, useState, useEffect } from "react";
import '../app/index.css';
import { DBConnect } from "@/components/DBConnect";
import { useMountedApp, useAppSelector } from "@/reducers/store";
import { getCredentialSubject } from "@/utils/credentialTypeDetector";
import { useCAPortal } from "@/utils/CAPortalContext";
import {
  selectEnterpriseCredentials,
  selectIsEnterpriseConfigured,
} from "@/reducers/enterpriseAgent";
import { DIDCommService, loadDIDCommServices } from "@/components/Chat";

interface ServiceEntry {
  serviceUrl: string;
  serviceName: string;
  serviceIcon: string;
  credentialType?: string;
}

function extractServices(
  localCredentials: any[],
  enterpriseCredentials: any[]
): ServiceEntry[] {
  const services: ServiceEntry[] = [];
  const seen = new Set<string>();

  const process = (cred: any) => {
    // Enterprise credentials store fields in `claims` (flat object from agent API).
    // Local SDK credentials need getCredentialSubject() for format normalization.
    const sub =
      (cred.claims && typeof cred.claims === 'object' && !Array.isArray(cred.claims))
        ? cred.claims
        : getCredentialSubject(cred);
    if (!sub) return;

    let serviceUrl: string | null = sub.serviceUrl || null;
    let serviceName: string = sub.serviceName || '';
    let serviceIcon: string = sub.serviceIcon || '🔗';

    // Shims for credentials issued before standardization
    if (!serviceUrl) {
      if (sub.portalUrl) {
        serviceUrl = sub.portalUrl;
        serviceName = serviceName || 'Employee Portal';
        serviceIcon = '🏢';
      } else if (sub.email && sub.employeeId) {
        serviceUrl = `https://identuslabel.cz/company-admin/employee-portal-login.html?email=${encodeURIComponent(sub.email)}`;
        serviceName = serviceName || 'Employee Portal';
        serviceIcon = '🏢';
      }
    }

    if (!serviceUrl || seen.has(serviceUrl)) return;
    seen.add(serviceUrl);
    services.push({ serviceUrl, serviceName: serviceName || serviceUrl, serviceIcon });
  };

  [...localCredentials, ...enterpriseCredentials].forEach(process);
  return services;
}

const Browser: React.FC = () => {
  const app = useMountedApp();
  const { openCAPortal } = useCAPortal();
  const enterpriseCredentials = useAppSelector(selectEnterpriseCredentials);
  const isEnterpriseConfigured = useAppSelector(selectIsEnterpriseConfigured);
  const [didcommServices, setDidcommServices] = useState<DIDCommService[]>([]);

  const services = useMemo(
    () => extractServices(app.credentials, isEnterpriseConfigured ? enterpriseCredentials : []),
    [app.credentials, enterpriseCredentials, isEnterpriseConfigured]
  );

  // Reload DIDComm access services from localStorage on mount and every 30s
  useEffect(() => {
    const load = () => setDidcommServices(loadDIDCommServices());
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const activeDidcommServices = didcommServices.filter(s => Date.now() < s.expiresAt);
  const hasAny = services.length > 0 || activeDidcommServices.length > 0;

  return (
    <DBConnect>
      <div className="min-h-screen bg-[#0a0f1e] text-white">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Browser</h1>
            <p className="text-slate-400 text-sm">
              Services from your credentials and DIDComm access grants.
            </p>
          </div>

          {!hasAny ? (
            <div className="flex flex-col items-center justify-center py-24 text-slate-500">
              <span className="text-5xl mb-4">🌐</span>
              <p className="text-lg font-medium mb-1">No services found</p>
              <p className="text-sm text-center max-w-xs">
                Accept credentials with a{' '}
                <code className="text-purple-400">serviceUrl</code> field, or use
                {' '}🔓 Request Access in a DIDComm chat to get temporary access links here.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* DIDComm Access Grants — time-limited */}
              {activeDidcommServices.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-3">
                    🔗 DIDComm Access Grants
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {activeDidcommServices.map((svc) => {
                      const minsLeft = Math.max(0, Math.round((svc.expiresAt - Date.now()) / 60000));
                      return (
                        <div
                          key={svc.id}
                          className="relative rounded-xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-purple-500/10 p-5 flex flex-col gap-3"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg bg-cyan-500/20 flex items-center justify-center text-2xl flex-shrink-0">
                              {svc.icon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-white font-semibold truncate">{svc.label}</p>
                              {svc.userName && (
                                <p className="text-slate-400 text-xs">For {svc.userName}</p>
                              )}
                              <p className="text-cyan-500 text-xs">⏰ ~{minsLeft} min left</p>
                            </div>
                          </div>
                          <button
                            onClick={() => openCAPortal(svc.accessUrl)}
                            className="w-full py-2 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-purple-600
                                       hover:from-cyan-500 hover:to-purple-500 text-white text-sm font-semibold
                                       transition-all"
                          >
                            🔓 Launch in Wallet
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Credential-sourced services — permanent */}
              {services.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-purple-400 uppercase tracking-wider mb-3">
                    🪪 Credential Services
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {services.map((svc) => (
                      <div
                        key={svc.serviceUrl}
                        className="relative rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 to-violet-500/10 p-5 flex flex-col gap-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center text-2xl flex-shrink-0">
                            {svc.serviceIcon}
                          </div>
                          <div className="min-w-0">
                            <p className="text-white font-semibold truncate">{svc.serviceName}</p>
                            <p className="text-slate-500 text-xs truncate">{svc.serviceUrl}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => openCAPortal(svc.serviceUrl)}
                          className="w-full py-2 px-4 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors"
                        >
                          Launch
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </DBConnect>
  );
};

export default Browser;
