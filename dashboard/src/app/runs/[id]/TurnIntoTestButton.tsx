"use client";

/**
 * TurnIntoTestButton — client island for the "Turn this run into a test" action.
 *
 * D-11: the parent page remains a Server Component; only this button is a
 * client island. Clicking POSTs to /api/fixtures, which inserts the fixture row
 * and enqueues the invariant.infer job.
 *
 * On success, redirects to /fixtures/[id]/edit so the user can immediately
 * review and edit the inferred invariants (Day 3 editor).
 *
 * The button is idempotent — the server returns the existing fixture_id if a
 * fixture was already created for this run.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  runId:   string;
  runName: string;
}

type State = "idle" | "loading" | "error";

export function TurnIntoTestButton({ runId, runName }: Props) {
  const router = useRouter();
  const [state, setState]       = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  async function handleClick() {
    setState("loading");
    try {
      const res = await fetch("/api/fixtures", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ run_id: runId, run_name: runName }),
      });
      const json = await res.json() as { fixture_id?: string; warning?: string; error?: string };
      if (!res.ok || !json.fixture_id) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Redirect to editor — Day 3.
      router.push(`/fixtures/${json.fixture_id}/edit`);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setState("error");
    }
  }

  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-red-400">
        Failed: {errorMsg}
        <button
          onClick={() => setState("idle")}
          className="underline text-gray-400 hover:text-gray-200"
        >
          retry
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === "loading"}
      className="
        inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium
        bg-violet-700 hover:bg-violet-600 disabled:bg-violet-900 disabled:cursor-not-allowed
        text-white transition-colors
      "
    >
      {state === "loading" ? (
        <>
          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.364-6.364l-2.121 2.121M8.757 15.243l-2.121 2.121m0-12.728l2.121 2.121m8.486 8.486l2.121 2.121" />
          </svg>
          Creating…
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Turn into test
        </>
      )}
    </button>
  );
}
