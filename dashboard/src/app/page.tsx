/**
 * Halley Dashboard — Runs list (/).
 *
 * Server Component. Replaces the flat-spans table from Phase 1 (now at /spans).
 * Queries ClickHouse through halley-query/ (D-12). No "use client".
 *
 * Filter state lives in URL search params (?range=7d&project=dev-local).
 * Time-range buttons are plain <Link> elements — no client JS needed (D-11).
 *
 * Each row is one agent run (GROUP BY run_id). Shows:
 *   started_at | run_name | model | spans | tokens (in/out) | cost | status | dialect
 *
 * Clicking a row navigates to /runs/[id] (implemented Day 3).
 *
 * D46: Vercel outer-span token counts (ai.usage.*) are not summed here —
 * only canonical gen_ai_usage_* columns are used. See DECISIONS.md D46.
 *
 * force-dynamic: ClickHouse is queried fresh on every request.
 */

import Link from "next/link";
import { listRuns } from "@/lib/halley-query";
import type { RunSummary } from "@/lib/halley-query";
import { getSessionProjectId } from "@/lib/session";

export const dynamic = "force-dynamic";

// ── Time-range helpers ─────────────────────────────────────────────────────

type TimeRange = "1h" | "24h" | "7d" | "all";

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1h",  label: "Last hour" },
  { value: "24h", label: "Last 24h" },
  { value: "7d",  label: "Last 7d" },
  { value: "all", label: "All time" },
];

function resolveTimeRange(range: string | undefined): {
  fromTime?: string;
  toTime?: string;
  label: string;
} {
  const now = new Date();
  switch (range as TimeRange) {
    case "1h":
      return {
        fromTime: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        label: "last hour",
      };
    case "24h":
      return {
        fromTime: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        label: "last 24 hours",
      };
    case "all":
      return { label: "all time" };
    case "7d":
    default:
      return {
        fromTime: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        label: "last 7 days",
      };
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: { range?: string; project?: string };
}

export default async function RunsPage({ searchParams }: PageProps) {
  const range = (searchParams.range as TimeRange) || "7d";
  // project param is accepted for URL hygiene but only one project exists
  // until Phase 4 auth + multi-project support lands. See Week 6 plan §Day 2.
  const project = searchParams.project || "dev-local";

  const { fromTime, label } = resolveTimeRange(range);

  // Phase 4 Day 2: project-scoped queries. getSessionProjectId() respects
  // HALLEY_AUTH_REQUIRED=false (D-15) without a DB round-trip.
  const projectId = await getSessionProjectId();

  const runs = await listRuns({ fromTime, limit: 200, projectId });

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">

      {/* ── Header ── */}
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Runs</h1>
          <p className="text-gray-400 text-sm mt-1">
            {runs.length === 0
              ? "No runs in this window."
              : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${label}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/fixtures"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
            title="Regression test fixtures"
          >
            Fixtures →
          </Link>
          <Link
            href="/settings/keys"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
            title="API key management"
          >
            Settings →
          </Link>
          <Link
            href="/spans"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
            title="Debug view: flat spans table"
          >
            Debug: spans →
          </Link>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="mb-5 flex items-center gap-4 flex-wrap">
        {/* Project selector — aesthetic only; single project until Phase 4 auth */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Project</span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-900 border border-gray-700 text-sm text-gray-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
            {project === "dev-local" ? "dev-local" : project}
          </span>
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-gray-800" />

        {/* Time-range filter — URL-based, Server Component friendly */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Range</span>
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            {TIME_RANGE_OPTIONS.map(({ value, label: optLabel }) => {
              const isActive = range === value;
              return (
                <Link
                  key={value}
                  href={`/?range=${value}&project=${project}`}
                  className={[
                    "px-3 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-indigo-700 text-white"
                      : "bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200",
                  ].join(" ")}
                >
                  {optLabel}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      {runs.length === 0 ? (
        <EmptyState range={label} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-900 text-gray-400 uppercase text-xs tracking-wider">
              <tr>
                <th className="px-4 py-3 whitespace-nowrap">Started (UTC)</th>
                <th className="px-4 py-3">Run</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3 text-right">Spans</th>
                <th className="px-4 py-3 text-right">Tokens in</th>
                <th className="px-4 py-3 text-right">Tokens out</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Dialect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {runs.map((run) => (
                <RunRow key={run.run_id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

// ── Row component ──────────────────────────────────────────────────────────

function RunRow({ run }: { run: RunSummary }) {
  return (
    <tr className="bg-gray-950 hover:bg-gray-900 transition-colors group">
      {/* started_at */}
      <td className="px-4 py-3 text-gray-400 whitespace-nowrap font-mono text-xs">
        {formatTimestamp(run.started_at)}
      </td>

      {/* run_name + optional agent badge + link */}
      <td className="px-4 py-3 max-w-xs">
        <Link
          href={`/runs/${run.run_id}`}
          className="flex items-center gap-2 group/link"
        >
          <span className="text-gray-200 group-hover/link:text-white transition-colors truncate">
            {run.run_name || (
              <span className="text-gray-500 italic">unnamed</span>
            )}
          </span>
          {run.has_root && (
            <span className="inline-block shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-900 text-indigo-300 uppercase tracking-wide">
              agent
            </span>
          )}
        </Link>
        <div className="font-mono text-[10px] text-gray-600 mt-0.5 truncate">
          {run.run_id.toLowerCase().slice(0, 24)}…
        </div>
      </td>

      {/* model */}
      <td className="px-4 py-3">
        <ModelBadge model={run.top_model} />
      </td>

      {/* span count */}
      <td className="px-4 py-3 text-right text-gray-300 tabular-nums">
        {run.span_count.toLocaleString()}
      </td>

      {/* tokens in — D46: Vercel outer spans may show 0 here */}
      <td className="px-4 py-3 text-right text-gray-400 tabular-nums">
        {run.total_input_tokens === 0 ? (
          <span className="text-gray-600">—</span>
        ) : (
          run.total_input_tokens.toLocaleString()
        )}
      </td>

      {/* tokens out */}
      <td className="px-4 py-3 text-right text-gray-400 tabular-nums">
        {run.total_output_tokens === 0 ? (
          <span className="text-gray-600">—</span>
        ) : (
          run.total_output_tokens.toLocaleString()
        )}
      </td>

      {/* cost */}
      <td className="px-4 py-3 text-right tabular-nums">
        <span
          className={
            run.cost_dollars === 0
              ? "text-gray-600"
              : "text-emerald-400 font-medium"
          }
        >
          {run.cost_display}
        </span>
      </td>

      {/* status */}
      <td className="px-4 py-3">
        <StatusBadge status={run.worst_status} />
      </td>

      {/* dialect */}
      <td className="px-4 py-3">
        <DialectBadge dialect={run.top_dialect} />
      </td>
    </tr>
  );
}

// ── Helper components ──────────────────────────────────────────────────────

function EmptyState({ range }: { range: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-12 text-center">
      <p className="text-gray-400 text-sm">
        No runs found in the {range}.
      </p>
      <p className="text-gray-600 text-xs mt-2">
        Run an example app and reload — each trace becomes a row here.
      </p>
      <Link
        href="/spans"
        className="inline-block mt-4 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        Check the raw spans debug view →
      </Link>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ok:      "bg-green-900/60 text-green-300 border border-green-800",
    error:   "bg-red-900/60 text-red-300 border border-red-800",
    timeout: "bg-yellow-900/60 text-yellow-300 border border-yellow-800",
  };
  const cls = map[status] ?? "bg-gray-800 text-gray-400 border border-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || "—"}
    </span>
  );
}

function DialectBadge({ dialect }: { dialect: string }) {
  const map: Record<string, string> = {
    "otel-genai":    "bg-blue-900/50 text-blue-300",
    "openllmetry":   "bg-purple-900/50 text-purple-300",
    "openinference": "bg-orange-900/50 text-orange-300",
    "vercel-ai":     "bg-teal-900/50 text-teal-300",
    "halley":        "bg-indigo-900/50 text-indigo-300",
  };
  const cls = map[dialect] ?? "bg-gray-800/50 text-gray-400";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {dialect || "—"}
    </span>
  );
}

function ModelBadge({ model }: { model: string }) {
  // Shorten common model names for display only (raw value used for cost lookup)
  const short = model
    .replace("gpt-4o-mini-2024-07-18", "gpt-4o-mini")
    .replace("gpt-4o-2024-11-20", "gpt-4o");

  const isGpt4oMini = short.includes("gpt-4o-mini");
  const isGpt4o = !isGpt4oMini && short.includes("gpt-4o");

  const cls = isGpt4oMini
    ? "bg-gray-800 text-gray-300"
    : isGpt4o
      ? "bg-violet-900/60 text-violet-300"
      : "bg-gray-800 text-gray-400";

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${cls}`}>
      {short || "—"}
    </span>
  );
}

/** Format an ISO timestamp to "May 21, 14:32:07" for display. */
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month:    "short",
      day:      "numeric",
      hour:     "2-digit",
      minute:   "2-digit",
      second:   "2-digit",
      hour12:   false,
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}
