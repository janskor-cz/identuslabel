import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import React from "react";
import { DBConnect } from "./DBConnect";

export const BackupRestore: React.FC = () => {
  const app = useMountedApp();
  const agent = app.agent.instance;
  const [restoreInput, setRestoreInput] = React.useState("");
  const [status, setStatus] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleBackup = async () => {
    setStatus(null);
    try {
      const jwe = await agent?.backup.createJWE();
      if (typeof jwe !== "string") throw new Error("Backup returned no data");

      // Download as a file
      const blob = new Blob([jwe], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `idl-wallet-backup-${ts}.jwe`;
      a.click();
      URL.revokeObjectURL(url);

      setStatus({ type: 'success', msg: "Backup downloaded. Store this file somewhere safe — it contains all your keys and credentials." });
    } catch (e: any) {
      setStatus({ type: 'error', msg: `Backup failed: ${e.message}` });
    }
  };

  const handleRestoreFromText = async () => {
    if (!restoreInput.trim()) return;
    setStatus(null);
    try {
      await agent?.backup.restore(restoreInput.trim());
      setStatus({ type: 'success', msg: "Restored. Reload the wallet to see your data." });
    } catch (e: any) {
      setStatus({ type: 'error', msg: `Restore failed: ${e.message}` });
    }
  };

  const handleRestoreFromFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      const text = await file.text();
      await agent?.backup.restore(text.trim());
      setStatus({ type: 'success', msg: "Restored from file. Reload the wallet to see your data." });
    } catch (e: any) {
      setStatus({ type: 'error', msg: `Restore failed: ${e.message}` });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Box>
      <h2 className="text-2xl font-bold text-white mb-1">Backup & Restore</h2>
      <p className="text-slate-400 text-sm mb-6">
        Backup exports all credentials, DIDs, connections and private keys as an encrypted JWE file.
        Store it somewhere safe — restoring from it fully recovers your wallet.
      </p>

      <DBConnect>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Backup */}
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-emerald-400 mb-2">Create Backup</h3>
            <p className="text-sm text-slate-400 mb-4">
              Downloads a <code className="text-slate-300">.jwe</code> file containing your complete wallet state.
              Do this after receiving any important credential.
            </p>
            <button
              onClick={handleBackup}
              disabled={!agent}
              className="w-full py-2.5 px-4 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white rounded-xl font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Download Backup (.jwe)
            </button>
          </div>

          {/* Restore */}
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-cyan-400 mb-2">Restore from Backup</h3>
            <p className="text-sm text-slate-400 mb-4">
              Upload a previously created <code className="text-slate-300">.jwe</code> backup file, or paste its contents below.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jwe,.json,application/json"
              onChange={handleRestoreFromFile}
              disabled={!agent}
              className="w-full mb-3 text-sm text-slate-400 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:bg-cyan-500/20 file:text-cyan-300 hover:file:bg-cyan-500/30 disabled:opacity-40"
            />
            <textarea
              className="w-full h-24 px-3 py-2 text-xs font-mono bg-slate-900/50 border border-slate-700/50 text-slate-300 rounded-xl resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50 mb-3"
              placeholder="Or paste JWE text here…"
              value={restoreInput}
              onChange={e => setRestoreInput(e.target.value)}
              disabled={!agent}
            />
            <button
              onClick={handleRestoreFromText}
              disabled={!agent || !restoreInput.trim()}
              className="w-full py-2.5 px-4 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Restore from Text
            </button>
          </div>
        </div>

        {status && (
          <div className={`mt-4 p-4 rounded-xl text-sm ${
            status.type === 'success'
              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
              : 'bg-red-500/20 border border-red-500/30 text-red-300'
          }`}>
            {status.msg}
          </div>
        )}
      </DBConnect>
    </Box>
  );
};
