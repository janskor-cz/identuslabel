import React from "react";
import '../app/index.css';
import { SecurityClearanceKeyManager } from "@/components/SecurityClearanceKeyManager";

export default function KeyManagementPage() {
  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-1">Key Management</h2>
        <p className="text-slate-400 text-sm">Generate and manage security clearance encryption keys</p>
      </header>

      <SecurityClearanceKeyManager />

      <br /> <br /> <br /> <br /> <br /> <br />
    </div>
  );
}
