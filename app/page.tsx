"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type RunState = "ready" | "running" | "cancelled" | "complete" | "error";

type Stats = {
  totalScanned: number;
  botsFiltered: number;
  contactsExtracted: number;
};

type Activity = {
  id: number;
  time: string;
  message: string;
  tone?: "normal" | "success" | "warning" | "error";
};

type StatusResponse = {
  connected: boolean;
  email: string | null;
  sheetId: string | null;
};

const EMPTY_STATS: Stats = {
  totalScanned: 0,
  botsFiltered: 0,
  contactsExtracted: 0,
};

export default function Dashboard() {
  const [runState, setRunState] = useState<RunState>("ready");
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [sheetId, setSheetId] = useState("");
  const [sheetSaved, setSheetSaved] = useState(false);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([
    {
      id: 1,
      time: getTime(),
      message: "Ready.",
    },
  ]);

  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });

      if (!response.ok) {
        setConnected(false);
        return;
      }

      const data = (await response.json()) as StatusResponse;

      setConnected(data.connected);
      setEmail(data.email);

      if (data.sheetId) {
        setSheetId(data.sheetId);
        setSheetSaved(true);
      }
    } catch {
      setConnected(false);
    }
  }

  async function connectGmail() {
    window.location.href = "/api/auth/google";
  }

  async function saveSheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    if (!sheetId.trim()) {
      setErrorMessage("Enter a Google Sheet ID or URL.");
      return;
    }

    try {
      const response = await fetch("/api/settings/sheet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sheetId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to save the spreadsheet.");
      }

      setSheetId(data.sheetId);
      setSheetSaved(true);
      addActivity("Spreadsheet destination saved.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to save the spreadsheet.";

      setErrorMessage(message);
      addActivity(message, "error");
    }
  }

  async function beginRun() {
    if (runState === "running") return;

    setErrorMessage(null);

    if (!connected) {
      const message = "Connect Gmail before starting a run.";
      setErrorMessage(message);
      addActivity(message, "warning");
      return;
    }

    if (!sheetId.trim() || !sheetSaved) {
      const message = "Save a Google Sheet before starting a run.";
      setErrorMessage(message);
      addActivity(message, "warning");
      return;
    }

    runningRef.current = true;
    abortRef.current = new AbortController();
    setRunState("running");
    setStats(EMPTY_STATS);
    addActivity("Run started.", "success");

    await processNext(abortRef.current.signal);
  }

  async function processNext(signal: AbortSignal) {
    if (!runningRef.current || signal.aborted) return;

    try {
      const response = await fetch("/api/run/next", {
        method: "POST",
        cache: "no-store",
        signal,
      });

      const raw = await response.text();
      let data: any = {};

      if (raw.trim()) {
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(
            `The run endpoint returned an invalid response (HTTP ${response.status}).`
          );
        }
      }

      if (!response.ok) {
        throw new Error(
          data.error ||
            `The extraction step failed (HTTP ${response.status}).`
        );
      }

      if (!raw.trim()) {
        throw new Error(
          `The run endpoint returned an empty response (HTTP ${response.status}).`
        );
      }

      if (!runningRef.current || signal.aborted) return;

      if (data.done) {
        runningRef.current = false;
        abortRef.current = null;
        setRunState("complete");
        addActivity("Run complete.", "success");
        return;
      }

      setStats((current) => ({
        totalScanned: current.totalScanned + (data.scanned || 0),
        botsFiltered: current.botsFiltered + (data.botsFiltered || 0),
        contactsExtracted:
          current.contactsExtracted + (data.contactsExtracted || 0),
      }));

      if (data.activity) {
        addActivity(
          data.activity,
          data.botsFiltered ? "warning" : data.contactsExtracted ? "success" : "normal"
        );
      }

      await processNext(signal);
    } catch (error) {
      if (signal.aborted || !runningRef.current) return;

      runningRef.current = false;
      abortRef.current = null;
      setRunState("error");

      const message =
        error instanceof Error ? error.message : "The extraction failed.";

      setErrorMessage(message);
      addActivity(message, "error");
    }
  }

  function cancelRun() {
    if (!runningRef.current) return;

    runningRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;

    setRunState("cancelled");
    addActivity("Run cancelled. The current email may finish before stopping.", "warning");
  }

  async function restartRun() {
    runningRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;

    setStats(EMPTY_STATS);
    setErrorMessage(null);
    setActivity([
      {
        id: Date.now(),
        time: getTime(),
        message: "Fresh run initialized.",
        tone: "success",
      },
    ]);

    await beginRun();
  }

  function clearActivity() {
    setActivity([]);
  }

  function addActivity(
    message: string,
    tone: Activity["tone"] = "normal"
  ) {
    setActivity((current) => [
      ...current,
      {
        id: Date.now() + Math.random(),
        time: getTime(),
        message,
        tone,
      },
    ]);
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-5 py-8 md:px-8">
        <header className="mb-6 flex flex-col gap-3 border-b border-[var(--border)] pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-[14px] font-medium">Gmail Contact Extractor</h1>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Scan Gmail and send extracted contacts to Google Sheets.
            </p>
          </div>

          <StatusBadge state={runState} />
        </header>

        <section className="mb-5 rounded-lg border border-[var(--border)] bg-white">
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-[14px] font-medium">Run controls</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">
                Begin a fresh scan, stop the current run, or restart from the remaining inbox.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={beginRun}
                disabled={runState === "running"}
                className="rounded-md border border-[var(--text)] bg-[var(--text)] px-4 py-2 text-[12px] font-medium text-white transition hover:opacity-90"
              >
                Begin
              </button>

              <button
                onClick={cancelRun}
                disabled={runState !== "running"}
                className="rounded-md border border-[var(--border)] bg-white px-4 py-2 text-[12px] font-medium transition hover:bg-[var(--surface-muted)]"
              >
                Cancel
              </button>

              <button
                onClick={restartRun}
                disabled={runState === "running"}
                className="rounded-md border border-[var(--border)] bg-white px-4 py-2 text-[12px] font-medium transition hover:bg-[var(--surface-muted)]"
              >
                Restart
              </button>
            </div>
          </div>

          <div className="grid gap-3 border-t border-[var(--border)] px-5 py-4 md:grid-cols-2">
            <InfoRow label="State" value={getStateLabel(runState)} />
            <InfoRow
              label="Gmail"
              value={email || (connected ? "Connected" : "Not connected")}
            />
          </div>
        </section>

        <section className="mb-5 grid gap-5 md:grid-cols-2">
          <div className="rounded-lg border border-[var(--border)] bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[14px] font-medium">Gmail connection</h2>
                <p className="mt-1 text-[12px] text-[var(--muted)]">
                  Use the Gmail account you want to scan.
                </p>
              </div>

              <StatusDot active={connected} />
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
              <span className="text-[12px] text-[var(--muted)]">
                {connected ? "Connected" : "Not connected"}
              </span>

              <button
                onClick={connectGmail}
                className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] font-medium transition hover:bg-[var(--surface-muted)]"
              >
                {connected ? "Reconnect" : "Connect Gmail"}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-white p-5">
            <div>
              <h2 className="text-[14px] font-medium">Google Sheet</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">
                Save the destination once. It stays linked to the connected Gmail account.
              </p>
            </div>

            <form onSubmit={saveSheet} className="mt-5">
              <input
                value={sheetId}
                onChange={(event) => {
                  setSheetId(event.target.value);
                  setSheetSaved(false);
                }}
                placeholder="Paste spreadsheet ID or URL"
                className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] text-[var(--text)] outline-none transition focus:border-[var(--border-strong)]"
              />

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[12px] text-[var(--muted)]">
                  {sheetSaved ? "Saved" : "Not saved"}
                </span>

                <button
                  type="submit"
                  className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] font-medium transition hover:bg-[var(--surface-muted)]"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </section>

        {errorMessage && (
          <div className="mb-5 rounded-lg border border-[#e5b8b8] bg-[#fff7f7] px-4 py-3 text-[12px] text-[var(--danger)]">
            {errorMessage}
          </div>
        )}

        <section className="mb-5 grid grid-cols-3 gap-3">
          <Metric label="Emails scanned" value={stats.totalScanned} />
          <Metric label="Filtered" value={stats.botsFiltered} />
          <Metric label="Contacts" value={stats.contactsExtracted} />
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-white">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-[14px] font-medium">Activity</h2>

            <button
              onClick={clearActivity}
              className="text-[12px] text-[var(--muted)] transition hover:text-[var(--text)]"
            >
              Clear
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {activity.length === 0 ? (
              <div className="px-5 py-5 text-[12px] text-[var(--muted)]">
                No activity.
              </div>
            ) : (
              activity.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-[52px_1fr] gap-4 border-b border-[#f0f0ec] px-5 py-3 last:border-b-0"
                >
                  <span className="text-[12px] text-[var(--faint)]">
                    {entry.time}
                  </span>

                  <span className={getToneClass(entry.tone)}>
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <footer className="pt-5 text-[12px] text-[var(--faint)]">
          Gmail Contact Extractor
        </footer>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white px-4 py-4">
      <div className="text-[12px] text-[var(--muted)]">{label}</div>
      <div className="mt-2 text-[14px] font-medium">{value}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md bg-[var(--surface-muted)] px-3 py-2">
      <span className="text-[12px] text-[var(--muted)]">{label}</span>
      <span className="truncate text-[12px] font-medium">{value}</span>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={[
        "mt-1.5 h-2 w-2 rounded-full",
        active ? "bg-[var(--success)]" : "bg-[var(--border-strong)]",
      ].join(" ")}
    />
  );
}

function StatusBadge({ state }: { state: RunState }) {
  const classes: Record<RunState, string> = {
    ready: "bg-[var(--surface-muted)] text-[var(--muted)]",
    running: "bg-[#fff3d9] text-[var(--warning)]",
    cancelled: "bg-[var(--surface-muted)] text-[var(--muted)]",
    complete: "bg-[#e9f5ec] text-[var(--success)]",
    error: "bg-[#fff0f0] text-[var(--danger)]",
  };

  return (
    <div
      className={[
        "inline-flex items-center gap-2 self-start rounded-full px-3 py-1 text-[12px] font-medium md:self-auto",
        classes[state],
      ].join(" ")}
    >
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          state === "running"
            ? "bg-[var(--warning)]"
            : state === "complete"
            ? "bg-[var(--success)]"
            : state === "error"
            ? "bg-[var(--danger)]"
            : "bg-[var(--faint)]",
        ].join(" ")}
      />
      {getStateLabel(state)}
    </div>
  );
}

function getStateLabel(state: RunState) {
  switch (state) {
    case "running":
      return "Running";
    case "cancelled":
      return "Cancelled";
    case "complete":
      return "Complete";
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

function getToneClass(tone: Activity["tone"]) {
  switch (tone) {
    case "success":
      return "text-[var(--success)]";
    case "warning":
      return "text-[var(--warning)]";
    case "error":
      return "text-[var(--danger)]";
    default:
      return "text-[var(--muted)]";
  }
}

function getTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
