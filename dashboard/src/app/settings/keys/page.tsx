/**
 * /settings/keys — API key management page (Phase 4 Day 3).
 *
 * Server Component: fetches the active key list via listApiKeys() (Postgres,
 * no ClickHouse, D-12 not applicable). Renders KeysClient for interactivity.
 *
 * Dark theme matching the rest of the dashboard.
 * No "use client" — list fetch happens on the server.
 */

import Link from "next/link";
import { listApiKeys } from "./actions";
import { KeysClient } from "./KeysClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "API Keys · Halley",
  description: "Manage API keys for the Halley ingester.",
};

export default async function ApiKeysPage() {
  const keys = await listApiKeys();

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-3xl mx-auto">

        {/* ── Breadcrumb ── */}
        <nav className="flex items-center gap-2 text-sm text-gray-500 mb-8">
          <Link
            href="/"
            className="hover:text-gray-300 transition-colors"
          >
            Runs
          </Link>
          <span className="text-gray-700">/</span>
          <span className="text-gray-400">Settings</span>
          <span className="text-gray-700">/</span>
          <span className="text-gray-200">API Keys</span>
        </nav>

        {/* ── Header ── */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">API Keys</h1>
          <p className="mt-2 text-sm text-gray-400 max-w-lg">
            API keys authenticate spans sent to the Halley ingester. Each key
            belongs to this project. Store keys securely — they are shown only
            once at creation.
          </p>
        </div>

        {/* ── Key format info ── */}
        <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900/40 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="text-indigo-400 text-lg leading-none mt-0.5">ℹ</span>
            <div className="text-xs text-gray-400 space-y-1">
              <p>
                Keys are prefixed with <code className="text-indigo-300 font-mono">hlly_</code> followed
                by 32 random bytes encoded as base62 (~48 chars total).
              </p>
              <p>
                Only the prefix and name are stored. The full key is hashed
                with SHA-256 for ingester validation.
              </p>
            </div>
          </div>
        </div>

        {/* ── Interactive key list + create form (Client Component) ── */}
        <KeysClient initialKeys={keys} />

        {/* ── Usage example ── */}
        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-900/40 p-5">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Usage</h2>
          <p className="text-xs text-gray-500 mb-3">
            Include your key in the <code className="text-gray-300">Authorization</code> header
            when sending spans to the ingester:
          </p>
          <pre className="text-xs font-mono bg-gray-950 rounded-lg p-4 overflow-x-auto text-gray-300 border border-gray-800">
{`curl -X POST http://localhost:4318/v1/spans/json \\
  -H "Authorization: Bearer hlly_<your-key>" \\
  -H "Content-Type: application/json" \\
  -d @span.json`}
          </pre>
          <p className="mt-3 text-xs text-gray-600">
            Auth is enforced when{" "}
            <code className="text-gray-500">HALLEY_AUTH_REQUIRED=true</code> is set
            on the ingester. Set to <code className="text-gray-500">false</code> for
            local development (D-15).
          </p>
        </div>

      </div>
    </main>
  );
}
