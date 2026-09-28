"use client";

import { useState, useEffect } from "react";

export default function Dashboard() {
  const [sheetId, setSheetId] = useState("");
  const [isSaved, setIsSaved] = useState(false);
  const [stats, setStats] = useState({
    totalScanned: 0,
    botsFiltered: 0,
    contactsExtracted: 0,
  });

  const handleConnectGmail = () => {
    window.location.href = "/api/auth/google";
  };

  const handleSaveSheet = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
  };

  return (
    <main className="p-6 md:p-12 max-w-6xl mx-auto space-y-12 bg-white text-black font-mono">
      {/* HEADER SECTION */}
      <header className="border-4 border-black p-6 bg-white">
        <h1 className="text-3xl md:text-5xl font-bold tracking-tighter">
          GMAIL CONTACT EXTRACTOR
        </h1>
        <p className="mt-2 text-sm font-semibold tracking-wide">
          SYSTEM STATUS: ONLINE / AUTOMATED CRON ACTIVE
        </p>
      </header>

      {/* METRICS COUNTERS SECTION */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="border-4 border-black p-6 bg-white">
          <div className="text-xs font-bold tracking-widest">
            TOTAL EMAILS SCANNED
          </div>
          <div className="text-5xl font-black mt-4">{stats.totalScanned}</div>
        </div>

        <div className="border-4 border-black p-6 bg-white">
          <div className="text-xs font-bold tracking-widest">
            BOTS / NON-HUMAN FILTERED
          </div>
          <div className="text-5xl font-black mt-4">{stats.botsFiltered}</div>
        </div>

        <div className="border-4 border-black p-6 bg-white">
          <div className="text-xs font-bold tracking-widest">
            CONTACTS EXTRACTED TO SHEET
          </div>
          <div className="text-5xl font-black mt-4">
            {stats.contactsExtracted}
          </div>
        </div>
      </section>

      {/* ACTION PANELS */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* GOOGLE ACCOUNT CONNECTION */}
        <div className="border-4 border-black p-6 bg-white space-y-6">
          <h2 className="text-xl font-bold border-b-4 border-black pb-2">
            1. AUTHORIZATION
          </h2>
          <p className="text-xs leading-relaxed font-semibold">
            CONNECT THE GMAIL ACCOUNT YOU WANT TO SCAN FOR CONTACT INFORMATION.
          </p>
          <button
            onClick={handleConnectGmail}
            className="w-full bg-black text-white font-bold py-4 px-6 border-2 border-black hover:bg-white hover:text-black transition-none cursor-pointer uppercase tracking-wider"
          >
            CONNECT GMAIL ACCOUNT
          </button>
        </div>

        {/* TARGET SHEET CONFIGURATION */}
        <div className="border-4 border-black p-6 bg-white space-y-6">
          <h2 className="text-xl font-bold border-b-4 border-black pb-2">
            2. TARGET SPREADSHEET
          </h2>
          <form onSubmit={handleSaveSheet} className="space-y-4">
            <label className="block text-xs font-bold tracking-widest">
              GOOGLE SHEET ID OR URL:
            </label>
            <input
              type="text"
              value={sheetId}
              onChange={(e) => setSheetId(e.target.value)}
              placeholder="PASTE GOOGLE SHEET ID HERE..."
              className="w-full border-2 border-black p-3 text-xs bg-white text-black font-mono focus:outline-none uppercase"
              required
            />
            <button
              type="submit"
              className="w-full bg-black text-white font-bold py-4 px-6 border-2 border-black hover:bg-white hover:text-black transition-none cursor-pointer uppercase tracking-wider"
            >
              {isSaved ? "SETTINGS SAVED!" : "SAVE SPREADSHEET CONFIG"}
            </button>
          </form>
        </div>
      </section>

      {/* SYSTEM LOG TERMINAL */}
      <section className="border-4 border-black p-6 bg-white">
        <h2 className="text-xl font-bold border-b-4 border-black pb-4 mb-4">
          SYSTEM ACTIVITY LOG
        </h2>
        <div className="border-2 border-black p-4 bg-white font-mono text-xs space-y-2 h-48 overflow-y-auto">
          <div>[SYSTEM] INITIALIZING BRUTALIST ENGINE...</div>
          <div>[CRON] UPSTASH LISTENER ACTIVE (EVERY 10 MINUTES).</div>
          <div>[READY] AWAITING USER GMAIL AUTHORIZATION.</div>
        </div>
      </section>
    </main>
  );
}
