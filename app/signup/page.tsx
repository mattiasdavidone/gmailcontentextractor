"use client";

import { FormEvent, useState } from "react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to create account.");
      }

      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create account.");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-16">
      <div className="mx-auto max-w-sm">
        <h1 className="text-[14px] font-medium">Gmail Contact Extractor</h1>
        <p className="mt-1 text-[12px] text-[var(--muted)]">
          Create your own account to keep Gmail connections, usage, and linked Sheets separate.
        </p>

        <div className="mt-6 rounded-lg border border-[var(--border)] bg-white p-5">
          <h2 className="text-[14px] font-medium">Create account</h2>

          <form onSubmit={submit} className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--muted)]">
                Email
              </span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] outline-none focus:border-[var(--border-strong)]"
                required
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--muted)]">
                Password
              </span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] outline-none focus:border-[var(--border-strong)]"
                required
                minLength={8}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--muted)]">
                Confirm password
              </span>
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] outline-none focus:border-[var(--border-strong)]"
                required
                minLength={8}
              />
            </label>

            {error && (
              <div className="rounded-md border border-[#e5b8b8] bg-[#fff7f7] px-3 py-2 text-[12px] text-[var(--danger)]">
                {error}
              </div>
            )}

            <button
              disabled={loading}
              className="w-full rounded-md bg-[var(--text)] px-4 py-2 text-[12px] font-medium text-white disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        </div>

        <div className="mt-4 text-[12px] text-[var(--muted)]">
          Already have an account?{" "}
          <a className="font-medium text-[var(--text)]" href="/login">
            Sign in
          </a>
        </div>
      </div>
    </main>
  );
}
