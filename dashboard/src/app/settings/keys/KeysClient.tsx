"use client";

/**
 * KeysClient — interactive client layer for /settings/keys.
 *
 * Split from the Server Component page to keep:
 *   - Key list + "create" form state (useState for the newly-created raw key)
 *   - Revoke confirmation without a full page reload
 *   - "Copy key" clipboard button
 *
 * The parent Server Component passes the initial key list; this component
 * calls Server Actions for create/revoke and uses router.refresh() to pull
 * the updated list without a full navigation.
 */

import { useState, useRef, useTransition, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createApiKey, revokeApiKey } from "./actions";
import type { ApiKeyRow } from "./actions";

interface Props {
  initialKeys: ApiKeyRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
      timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

// ── New-key banner (shown once) ────────────────────────────────────────────

function NewKeyBanner({
  rawKey,
  onDismiss,
}: {
  rawKey: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(rawKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div
      role="alert"
      className="rounded-xl border border-emerald-700/60 bg-emerald-950/40 p-5 mb-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-emerald-300 mb-1">
            🔑 Your new API key — copy it now
          </p>
          <p className="text-xs text-emerald-600 mb-3">
            This key will never be shown again. Store it somewhere safe.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm text-emerald-200 bg-gray-950/80 border border-emerald-900/60 rounded-lg px-4 py-2.5 break-all">
              {rawKey}
            </code>
            <button
              onClick={copy}
              className="shrink-0 px-3 py-2.5 text-xs font-medium rounded-lg bg-emerald-800/60 text-emerald-200 hover:bg-emerald-700/60 border border-emerald-700/50 transition-colors"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-emerald-700 hover:text-emerald-400 text-lg leading-none transition-colors mt-0.5"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ── Create form ────────────────────────────────────────────────────────────

function CreateKeyForm({
  onCreated,
}: {
  onCreated: (rawKey: string) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await createApiKey(formData);
      if (result.ok) {
        onCreated(result.rawKey);
        if (nameRef.current) nameRef.current.value = "";
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-start gap-3">
      <div className="flex-1">
        <input
          ref={nameRef}
          id="new-key-name"
          name="name"
          type="text"
          required
          maxLength={64}
          placeholder="Key name (e.g. CI pipeline, local dev)"
          className={[
            "w-full rounded-lg px-4 py-2.5 text-sm",
            "bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600",
            "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
            "transition-colors",
          ].join(" ")}
        />
        {error && (
          <p className="mt-1.5 text-xs text-red-400">{error}</p>
        )}
      </div>
      <button
        id="create-key-submit"
        type="submit"
        disabled={pending}
        className={[
          "shrink-0 px-4 py-2.5 rounded-lg text-sm font-semibold",
          "bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700",
          "focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-gray-900",
          "disabled:opacity-50 disabled:cursor-not-allowed transition-all",
        ].join(" ")}
      >
        {pending ? "Creating…" : "Create key"}
      </button>
    </form>
  );
}

// ── Key row ────────────────────────────────────────────────────────────────

function KeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKeyRow;
  onRevoke: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition]  = useTransition();

  function handleRevoke() {
    if (!confirming) { setConfirming(true); return; }
    startTransition(async () => {
      await revokeApiKey(apiKey.id);
      onRevoke(apiKey.id);
      setConfirming(false);
    });
  }

  return (
    <div className="flex items-center justify-between py-3.5 px-5 hover:bg-gray-800/20 transition-colors">
      <div className="flex items-center gap-4 min-w-0">
        {/* Prefix badge */}
        <code className="shrink-0 font-mono text-sm text-indigo-300 bg-indigo-950/40 border border-indigo-900/40 rounded px-2 py-0.5">
          {apiKey.prefix}…
        </code>
        {/* Name */}
        <span className="text-sm text-gray-200 truncate">{apiKey.name}</span>
      </div>
      <div className="flex items-center gap-6 shrink-0 ml-4">
        {/* Created at */}
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {fmtDate(apiKey.created_at)}
        </span>
        {/* Revoke */}
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-400">Revoke?</span>
            <button
              onClick={handleRevoke}
              disabled={pending}
              className="px-2.5 py-1 text-xs rounded bg-red-900/60 text-red-300 border border-red-800 hover:bg-red-800/60 disabled:opacity-50 transition-colors"
            >
              {pending ? "…" : "Yes, revoke"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-2.5 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={handleRevoke}
            className="text-xs text-gray-600 hover:text-red-400 transition-colors"
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function KeysClient({ initialKeys }: Props) {
  const router = useRouter();

  // Keys list — starts from SSR; updated optimistically after create/revoke.
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);

  // Newly created raw key — shown once, dismissed manually or on next create.
  const [newRawKey, setNewRawKey] = useState<string | null>(null);

  function handleCreated(rawKey: string) {
    setNewRawKey(rawKey);
    // Refresh SSR data to pick up the new row with its server-generated timestamps.
    router.refresh();
  }

  function handleRevoked(id: string) {
    // Optimistic removal — router.refresh() will sync server state.
    setKeys((prev) => prev.filter((k) => k.id !== id));
    router.refresh();
  }

  return (
    <div>
      {/* New-key one-time banner */}
      {newRawKey && (
        <NewKeyBanner
          rawKey={newRawKey}
          onDismiss={() => setNewRawKey(null)}
        />
      )}

      {/* Create form */}
      <div className="mb-6">
        <CreateKeyForm onCreated={handleCreated} />
      </div>

      {/* Key list */}
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        {/* List header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-gray-900/80">
          <div className="flex items-center gap-4">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-[120px]">
              Prefix
            </span>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              Name
            </span>
          </div>
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mr-20">
            Created
          </span>
        </div>

        {/* Rows */}
        {keys.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-gray-600">
            No active API keys. Create one above.
          </div>
        ) : (
          <div className="divide-y divide-gray-800/60">
            {keys.map((k) => (
              <KeyRow key={k.id} apiKey={k} onRevoke={handleRevoked} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
