"use client";

/**
 * CiPanel — client island for the "Run CI" replay check (D54, Day 3).
 *
 * Mirrors BisectPanel: a primary action + poll + result rendering. Differences:
 *   - Renders passed/total invariant counts and pass/fail.
 *   - status='needs_runner' is a first-class state (ci_runs has it): instead of
 *     a fake spinner, it shows the exact copy-paste `halley` command pulled
 *     from the job log.
 *   - When the host runner is NOT connected (runnerConnected=false), the primary
 *     button becomes "Copy command" — the command is always shown (D-23).
 *
 * The API endpoints enforce project scoping server-side.
 */

import { useState, useEffect, useCallback } from "react";

interface CiRun {
    id: string;
    status: "queued" | "running" | "done" | "failed" | "needs_runner";
    passed: number | null;
    total: number | null;
    log: string | null;
    created_at: string;
    completed_at: string | null;
}

interface CiPanelProps {
    fixtureId: string;
    fixturePath: string;
    fixtureSlug: string;
    runnerConnected: boolean;
}

/**
 * Pull the copy-paste command out of a needs_runner log. The worker writes:
 *   [ci.run] run this on a host with a Halley runner:
 *   [ci.run]   halley --config ... ci --only <slug>
 * We grab the line after the "run this on a host" marker. Falls back to a
 * sensible default built from the slug.
 */
function extractCommand(log: string | null, slug: string): string {
    const fallback = `halley ci --only ${slug}`;
    if (!log) return fallback;
    const lines = log.split("\n");
    const idx = lines.findIndex((l) => l.includes("run this on a host"));
    if (idx >= 0 && lines[idx + 1]) {
        // Strip the "[ci.run]   " prefix.
        return lines[idx + 1].replace(/^\[ci\.run\]\s*/, "").trim() || fallback;
    }
    return fallback;
}

export function CiPanel({
    fixtureId,
    fixturePath,
    fixtureSlug,
    runnerConnected,
}: CiPanelProps) {
    const [run, setRun] = useState<CiRun | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // ── Poll while running ──────────────────────────────────────────────────

    const fetchRun = useCallback(async () => {
        try {
            const res = await fetch(`/api/fixtures/${fixtureId}/ci`, {
                cache: "no-store",
            });
            if (!res.ok) return;
            const data = (await res.json()) as { run: CiRun | null };
            setRun(data.run);
        } catch {
            // ignore transient network errors during polling
        }
    }, [fixtureId]);

    useEffect(() => {
        fetchRun();
    }, [fetchRun]);

    useEffect(() => {
        if (!run) return;
        if (run.status === "queued" || run.status === "running") {
            const interval = setInterval(fetchRun, 2000);
            return () => clearInterval(interval);
        }
    }, [run, fetchRun]);

    // ── Trigger ─────────────────────────────────────────────────────────────

    async function handleTrigger() {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/fixtures/${fixtureId}/ci`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                const body = (await res.json()) as { error?: string };
                setError(body.error ?? `HTTP ${res.status}`);
                return;
            }
            await fetchRun();
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }

    // The command to show in copy-mode / needs_runner.
    const command =
        run?.status === "needs_runner"
            ? extractCommand(run.log, fixtureSlug)
            : `halley ci --only ${fixtureSlug}`;

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard may be unavailable; the command is still visible below
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    const isTerminal =
        !run ||
        run.status === "done" ||
        run.status === "failed" ||
        run.status === "needs_runner";

    function StatusBadge({ status }: { status: CiRun["status"] }) {
        const map: Record<CiRun["status"], string> = {
            queued: "bg-gray-700 text-gray-300",
            running: "bg-blue-900/60 text-blue-300 animate-pulse",
            done: "bg-green-900/50 text-green-300",
            failed: "bg-red-900/50 text-red-300",
            needs_runner: "bg-amber-900/50 text-amber-300 border border-amber-800",
        };
        const label = status === "needs_runner" ? "needs runner" : status;
        return (
            <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}
            >
                {label}
            </span>
        );
    }

    function CommandBlock() {
        return (
            <div className="p-3 rounded-lg bg-gray-950 border border-gray-800">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-xs text-gray-500">Run in your terminal:</p>
                    <button
                        onClick={handleCopy}
                        className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
                <pre className="text-xs text-indigo-300 font-mono whitespace-pre-wrap break-all">
                    {command}
                </pre>
            </div>
        );
    }

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h2 className="text-base font-semibold text-white">Run CI</h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                        Replay{" "}
                        <span className="font-mono text-gray-400">{fixturePath}</span> at $0
                        and check invariants
                    </p>
                </div>
                {runnerConnected ? (
                    <button
                        onClick={handleTrigger}
                        disabled={loading || !isTerminal}
                        className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                    >
                        {loading ? "Queuing…" : "Run CI"}
                    </button>
                ) : (
                    <button
                        onClick={handleCopy}
                        className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium transition-colors"
                    >
                        {copied ? "Copied" : "Copy command"}
                    </button>
                )}
            </div>

            {/* When no runner is connected, always show the command (D-23). */}
            {!runnerConnected && (
                <div className="mb-4">
                    <p className="mb-2 text-xs text-amber-400">
                        No runner detected — run this in your terminal, or start a host
                        runner to execute it here.
                    </p>
                    <CommandBlock />
                </div>
            )}

            {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-300">
                    {error}
                </div>
            )}

            {!run && !loading && runnerConnected && (
                <p className="text-sm text-gray-600 italic">
                    No CI runs yet. Click &quot;Run CI&quot; to start.
                </p>
            )}

            {run && (
                <div className="space-y-3">
                    {/* Status row */}
                    <div className="flex items-center gap-3 text-sm">
                        <StatusBadge status={run.status} />
                        <span className="text-gray-500 text-xs font-mono">
                            run {run.id.slice(0, 8)}
                        </span>
                        {run.status === "done" || run.status === "failed" ? (
                            <span className="text-gray-400 text-xs">
                                {run.passed ?? "?"}/{run.total ?? "?"} invariants passed
                            </span>
                        ) : null}
                        {run.completed_at && (
                            <span className="text-gray-600 text-xs ml-auto">
                                {new Date(run.completed_at).toLocaleTimeString()}
                            </span>
                        )}
                    </div>

                    {/* Pass/fail result */}
                    {run.status === "done" && (
                        <div className="p-3 rounded-lg bg-green-950/60 border border-green-800">
                            <p className="text-xs text-green-400 font-semibold">
                                All {run.total ?? 0} invariants passed — $0 (pure replay)
                            </p>
                        </div>
                    )}

                    {run.status === "failed" && (
                        <div className="p-3 rounded-lg bg-red-950/60 border border-red-800">
                            <p className="text-xs text-red-400 font-semibold">
                                {run.total != null && run.passed != null
                                    ? `${run.total - run.passed} of ${run.total} invariants failed`
                                    : "CI failed"}{" "}
                                — see log below
                            </p>
                        </div>
                    )}

                    {/* needs_runner: show the command prominently, not a spinner */}
                    {run.status === "needs_runner" && (
                        <div className="space-y-2">
                            <p className="text-xs text-amber-400">
                                No host runner available — this run needs a runner. Run it in
                                your terminal:
                            </p>
                            <CommandBlock />
                        </div>
                    )}

                    {/* Log */}
                    {run.log && (
                        <details className="mt-2">
                            <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400 select-none">
                                Show log
                            </summary>
                            <pre className="mt-2 p-3 rounded-lg bg-gray-950 border border-gray-800 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                                {run.log}
                            </pre>
                        </details>
                    )}
                </div>
            )}
        </div>
    );
}
