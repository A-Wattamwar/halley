"use client";

/**
 * /login — Sign-in page (Phase 4 Day 1).
 *
 * D-14: CredentialsProvider only — email + password form.
 * Dark theme consistent with the rest of the dashboard (gray-950 bg, gray-900 cards).
 *
 * On submit → calls signIn("credentials", { redirect: true, callbackUrl: "/" }).
 * On error  → displays inline error message without a full-page reload.
 */

import { useState, FormEvent } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

// ── Inner form (needs useSearchParams, must be inside Suspense) ───────────

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl  = searchParams.get("callbackUrl") ?? "/";

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email:    email.trim().toLowerCase(),
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password.");
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-lg px-4 py-3 text-sm bg-red-950/60 border border-red-800 text-red-300"
        >
          {error}
        </div>
      )}

      {/* Email */}
      <div className="space-y-1.5">
        <label
          htmlFor="login-email"
          className="block text-xs font-medium text-gray-400 uppercase tracking-wider"
        >
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={[
            "w-full rounded-lg px-4 py-2.5 text-sm",
            "bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600",
            "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
            "transition-colors",
          ].join(" ")}
        />
      </div>

      {/* Password */}
      <div className="space-y-1.5">
        <label
          htmlFor="login-password"
          className="block text-xs font-medium text-gray-400 uppercase tracking-wider"
        >
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className={[
            "w-full rounded-lg px-4 py-2.5 text-sm",
            "bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600",
            "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
            "transition-colors",
          ].join(" ")}
        />
      </div>

      {/* Submit */}
      <button
        id="login-submit"
        type="submit"
        disabled={loading}
        className={[
          "w-full rounded-lg px-4 py-2.5 text-sm font-semibold",
          "bg-indigo-600 text-white",
          "hover:bg-indigo-500 active:bg-indigo-700",
          "focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-gray-900",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "transition-all duration-150",
        ].join(" ")}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin h-4 w-4 text-white/70"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12" cy="12" r="10"
                stroke="currentColor" strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
            Signing in…
          </span>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">

        {/* Logo / wordmark */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
            {/* Halley comet icon */}
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-indigo-400" fill="none">
              <circle cx="8" cy="8" r="3" fill="currentColor" />
              <path
                d="M10.5 10.5 Q16 10 20 6"
                stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" opacity="0.7"
              />
              <path
                d="M10.5 10.5 Q14 14 12 20"
                stroke="currentColor" strokeWidth="1"
                strokeLinecap="round" opacity="0.4"
              />
              <path
                d="M10.5 10.5 Q17 15 21 18"
                stroke="currentColor" strokeWidth="0.75"
                strokeLinecap="round" opacity="0.3"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Halley</h1>
          <p className="mt-1 text-sm text-gray-500">Agent observability dashboard</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          <h2 className="text-base font-semibold text-gray-100 mb-6">Sign in to your account</h2>
          <Suspense fallback={<div className="h-48 animate-pulse bg-gray-800/40 rounded-lg" />}>
            <LoginForm />
          </Suspense>
        </div>

        {/* Footer note */}
        <p className="mt-6 text-center text-xs text-gray-700">
          Self-hosted · Single organization
        </p>
      </div>
    </main>
  );
}
