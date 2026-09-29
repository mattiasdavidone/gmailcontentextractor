"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to sign in.");
      }

      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Access your Gmail Contact Extractor account."
      footer={
        <>
          New here?{" "}
          <a className="font-medium text-[var(--text)]" href="/signup">
            Create an account
          </a>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />

        {error && (
          <div className="rounded-md border border-[#e5b8b8] bg-[#fff7f7] px-3 py-2 text-[12px] text-[var(--danger)]">
            {error}
          </div>
        )}

        <button
          disabled={loading}
          className="w-full rounded-md bg-[var(--text)] px-4 py-2 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}

function Field(props: {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-[var(--muted)]">
        {props.label}
      </span>
      <input
        type={props.type}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete={props.autoComplete}
        className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[12px] outline-none focus:border-[var(--border-strong)]"
        required
      />
    </label>
  );
}

function AuthShell(props: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-16">
      <div className="mx-auto max-w-sm">
        <h1 className="text-[14px] font-medium">Gmail Contact Extractor</h1>
        <p className="mt-1 text-[12px] text-[var(--muted)]">{props.subtitle}</p>

        <div className="mt-6 rounded-lg border border-[var(--border)] bg-white p-5">
          <h2 className="text-[14px] font-medium">{props.title}</h2>
          <div className="mt-5">{props.children}</div>
        </div>

        <div className="mt-4 text-[12px] text-[var(--muted)]">
          {props.footer}
        </div>
      </div>
    </main>
  );
}
