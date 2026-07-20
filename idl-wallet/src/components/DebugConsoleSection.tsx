import React, { useState } from "react";
import { Mnemonics } from "@/components/Mnemonics";
import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { BackupRestore } from "@/components/BackupRestore";
import { reduxActions } from "@/reducers/app";

/**
 * Debug Console — developer tools and advanced settings.
 * Rendered collapsed inside the Configuration page (was previously its own top-level
 * page/nav item); expand to access mediator override, mnemonics and backup/restore.
 */
export const DebugConsoleSection: React.FC = () => {
  const app = useMountedApp();
  const [expanded, setExpanded] = useState(false);
  const [mediatorDID, setMediatorDID] = useState<string>(app.mediatorDID.toString());

  function onChangeMediatorDID(e: React.ChangeEvent<HTMLInputElement>) {
    setMediatorDID(e.target.value);
    app.dispatch(reduxActions.updateMediator({
      mediator: e.target.value
    }));
  }

  return (
    <div className="mt-5">
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center justify-between text-left p-6 bg-slate-800/30 border border-slate-700/50 rounded-2xl backdrop-blur-sm hover:bg-slate-800/40 transition-all duration-300"
      >
        <div>
          <h2 className="text-xl font-bold text-white">🐛 Debug Console</h2>
          <p className="text-slate-400 text-sm mt-0.5">Developer tools and advanced settings</p>
        </div>
        <span className={`text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {expanded && (
        <>
          <Box>
            <label htmlFor="mediatordid" className="text-slate-300 text-sm font-medium">MediatorDID</label>
            <input
              id="mediatordid"
              value={mediatorDID}
              onChange={onChangeMediatorDID}
              className="block p-3 w-full text-sm bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 mt-2"
            />
          </Box>

          <Mnemonics />
          <BackupRestore />
        </>
      )}
    </div>
  );
};

export default DebugConsoleSection;
