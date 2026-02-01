
import React, { useState } from "react";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import '../app/index.css';
import { Mnemonics } from "@/components/Mnemonics";
import { Box } from "@/app/Box";
import { useMountedApp } from "@/reducers/store";
import { BackupRestore } from "@/components/BackupRestore";
import { reduxActions } from "@/reducers/app";


export default function App() {
  const app = useMountedApp();
  const [mediatorDID, setMediatorDID] = useState<string>(app.mediatorDID.toString());

  function onChangeMediatorDID(e) {
    setMediatorDID(e.target.value)
    app.dispatch(reduxActions.updateMediator({
      mediator: e.target.value
    }))
  }

  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-1">Debug Console</h2>
        <p className="text-slate-400 text-sm">Developer tools and advanced settings</p>
      </header>

      <Box>
        <h1 className="mb-4 text-2xl font-bold text-white">
          Settings
        </h1>

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

      <br /> <br /> <br /> <br /> <br /> <br />
    </div>
  );
}
