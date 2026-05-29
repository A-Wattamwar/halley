"use client";

/**
 * TurnIntoTestButton — client island for the "Turn this run into a test" action.
 *
 * D-11: the parent page remains a Server Component; only this button is a
 * client island. Clicking POSTs to /api/fixtures, which inserts the fixture row
 * and enqueues the invariant.infer job.
 *
 * Success state: a link to the run page (invariant editor is Day 3; no
 * separate page exists today). An inline confirmation message is shown instead.
 *
 * The button is idempotent — the server returns the existing fixture_id if a
 * fixture was already created for this run.
 */

import { useState } from "react";

interface Props {
  runId:   string;
  runName: string;
}

type State = "idle" | "loading" | "done" | "error";

export function TurnIntoTestButton({ runId, runName }: Props) {
  const [state, setState]         = useState<State>("idle");
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg]   = useState<string>("");

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
      setFixtureId(json.fixture_id);
      setState("done");
    } catch (err) {
      setErrorMsg((err as Error).message);
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-green-400">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Test created
        <span className="text-xs text-gray-500 font-mono">{fixtureId?.slice(0, 8)}…</span>
      </span>
    );
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
