"use client";

/**
 * BisectPanel — client island for bisect trigger + live status + result.
 *
 * Renders a "Run bisect" button. On click, POSTs to /api/fixtures/[id]/bisect
 * to create a bisect_job and enqueue the bisect.run worker job. Then polls
 * GET /api/fixtures/[id]/bisect every 2 s until status ∈ {done, failed}.
 *
 * Project-scoped: the API endpoints enforce project scoping server-side.
 */

import { useState, useEffect, useCallback } from "react";

interface BisectJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  base_commit: string | null;
  head_commit: string | null;
  result_commit: string | null;
  log: string | null;
  created_at: string;
  completed_at: string | null;
}

interface BisectPanelProps {
  fixtureId: string;
  fixturePath: string;
}

export function BisectPanel({ fixtureId, fixturePath }: BisectPanelProps) {
  const [job, setJob]         = useState<BisectJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // ── Poll while running ──────────────────────────────────────────────────

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/fixtures/${fixtureId}/bisect`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json() as { job: BisectJob | null };
      setJob(data.job);
    } catch {
      // ignore transient network errors during polling
    }
  }, [fixtureId]);

  useEffect(() => {
    // Load existing job on mount.
    fetchJob();
  }, [fetchJob]);

  useEffect(() => {
    if (!job) return;
    if (job.status === "done" || job.status === "failed") return;

    // Poll every 2 s while queued or running.
    const interval = setInterval(fetchJob, 2000);
    return () => clearInterval(interval);
  }, [job, fetchJob]);

  // ── Trigger ─────────────────────────────────────────────────────────────

  async function handleTrigger() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fixtures/${fixtureId}/bisect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Start polling.
      await fetchJob();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  const isTerminal = !job || job.status === "done" || job.status === "failed";

  function StatusBadge({ status }: { status: BisectJob["status"] }) {
    const map: Record<BisectJob["status"], string> = {
      queued:  "bg-gray-700 text-gray-300",
      running: "bg-blue-900/60 text-blue-300 animate-pulse",
      done:    "bg-green-900/50 text-green-300",
      failed:  "bg-red-900/50 text-red-300",
    };
    return (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}>
        {status}
      </span>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Bisect</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Find the first commit that breaks{" "}
            <span className="font-mono text-gray-400">{fixturePath}</span>
          </p>
        </div>
        <button
          onClick={handleTrigger}
          disabled={loading || !isTerminal}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {loading ? "Queuing…" : "Run bisect"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-300">
          {error}
        </div>
      )}

      {!job && !loading && (
        <p className="text-sm text-gray-600 italic">
          No bisect jobs yet. Click "Run bisect" to start.
        </p>
      )}

      {job && (
        <div className="space-y-3">
          {/* Status row */}
          <div className="flex items-center gap-3 text-sm">
            <StatusBadge status={job.status} />
            <span className="text-gray-500 text-xs font-mono">
              job {job.id.slice(0, 8)}
            </span>
            {job.completed_at && (
              <span className="text-gray-600 text-xs ml-auto">
                completed {new Date(job.completed_at).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Result */}
          {job.status === "done" && job.result_commit && (
            <div className="p-3 rounded-lg bg-green-950/60 border border-green-800">
              <p className="text-xs text-green-400 font-semibold mb-1">
                First failing commit
              </p>
              <p className="font-mono text-sm text-white break-all">
                {job.result_commit}
              </p>
            </div>
          )}

          {job.status === "failed" && (
            <div className="p-3 rounded-lg bg-red-950/60 border border-red-800">
              <p className="text-xs text-red-400 font-semibold">
                Bisect failed — see log below
              </p>
            </div>
          )}

          {/* Log */}
          {job.log && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400 select-none">
                Show log
              </summary>
              <pre className="mt-2 p-3 rounded-lg bg-gray-950 border border-gray-800 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                {job.log}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
