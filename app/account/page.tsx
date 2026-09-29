"use client";

import { useEffect, useState } from "react";

type Summary = {
  user: {
    email: string;
    createdAt: string;
  };
  gmail: string | null;
  usage: {
    totalRuns: number;
    completedRuns: number;
    emailsScanned: number;
    botsFiltered: number;
    contactsExtracted: number;
  };
  spreadsheets: Array<{
    spreadsheet_id: string;
    title: string;
    spreadsheet_url: string | null;
    first_linked_at: string;
    last_used_at: string;
  }>;
};

export default function AccountPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const response = await fetch("/api/account/summary", { cache: "no-store" });
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Unable to load account.");
      }

      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load account.");
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-[var(--background)] px-5 py-8">
        <div className="mx-auto max-w-5xl">
          <a href="/" className="text-[12px] text-[var(--muted)]">← Back</a>
          <div className="mt-6 text-[12px] text-[var(--muted)]">
            {error || "Loading account..."}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] pb-5">
          <div>
            <h1 className="text-[14px] font-medium">Account</h1>
            <p className="mt-1 text-[12px] text-[var(--muted)]">{data.user.email}</p>
          </div>

          <div className="flex items-center gap-3">
            <a href="/" className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]">
              Dashboard
            </a>
            <button
              onClick={signOut}
              className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
            >
              Sign out
            </button>
          </div>
        </header>

        <section className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Metric label="Uses" value={data.usage.totalRuns} />
          <Metric label="Completed" value={data.usage.completedRuns} />
          <Metric label="Emails scanned" value={data.usage.emailsScanned} />
          <Metric label="Filtered" value={data.usage.botsFiltered} />
          <Metric label="Contacts" value={data.usage.contactsExtracted} />
        </section>

        <section className="mt-5 rounded-lg border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-[14px] font-medium">Connected accounts</h2>
          </div>
          <div className="px-5 py-4 text-[12px]">
            <span className="text-[var(--muted)]">Gmail</span>
            <span className="ml-3 font-medium">
              {data.gmail || "Not connected"}
            </span>
          </div>
        </section>

        <section className="mt-5 rounded-lg border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-[14px] font-medium">Linked Google Sheets</h2>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Spreadsheet titles are read from Google when you link them.
            </p>
          </div>

          {data.spreadsheets.length === 0 ? (
            <div className="px-5 py-5 text-[12px] text-[var(--muted)]">
              No spreadsheets linked yet.
            </div>
          ) : (
            <div>
              {data.spreadsheets.map((sheet) => (
                <div
                  key={sheet.spreadsheet_id}
                  className="flex flex-col gap-2 border-b border-[#f0f0ec] px-5 py-4 last:border-b-0 md:flex-row md:items-center md:justify-between"
                >
                  <div>
                    <div className="text-[12px] font-medium">{sheet.title}</div>
                    <div className="mt-1 text-[12px] text-[var(--muted)]">
                      Last used {new Date(sheet.last_used_at).toLocaleString()}
                    </div>
                  </div>

                  {sheet.spreadsheet_url && (
                    <a
                      href={sheet.spreadsheet_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
                    >
                      Open sheet
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-5 rounded-lg border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-[14px] font-medium">Recent runs</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="px-5 py-3 font-normal">Started</th>
                  <th className="px-5 py-3 font-normal">Status</th>
                  <th className="px-5 py-3 font-normal">Scanned</th>
                  <th className="px-5 py-3 font-normal">Contacts</th>
                </tr>
              </thead>
              <tbody>
                {(data as any).runs?.map((run: any, index: number) => (
                  <tr key={index} className="border-b border-[#f0f0ec] last:border-b-0">
                    <td className="px-5 py-3">{new Date(run.started_at).toLocaleString()}</td>
                    <td className="px-5 py-3">{run.status}</td>
                    <td className="px-5 py-3">{run.emails_scanned}</td>
                    <td className="px-5 py-3">{run.contacts_extracted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4">
      <div className="text-[12px] text-[var(--muted)]">{label}</div>
      <div className="mt-2 text-[14px] font-medium">{value}</div>
    </div>
  );
}
