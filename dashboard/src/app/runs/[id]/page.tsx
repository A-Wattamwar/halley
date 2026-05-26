/**
 * /runs/[id] — Run detail page with timeline view.
 *
 * Server Component. Fetches all spans for a run via getRunDetail(),
 * renders a Gantt-style timeline: each span is a horizontal bar whose
 * left offset and width are proportional to its position in the run's
 * total duration. Child spans are indented under parents via parent_span_id.
 *
 * Clicking a bar navigates to /runs/[id]?span=<hex_span_id>.
 * Day 4 wires the span inspector sidebar to that query param.
 *
 * D-10: No Rust changes. D-11: Server Component. D-12: queries via halley-query/.
 * force-dynamic: every request hits ClickHouse fresh.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRunDetail, getSpanDetail, ROOT_PARENT_ID } from "@/lib/halley-query";
import type { SpanSummary, SpanDetail } from "@/lib/halley-query";
import { SpanInspector } from "./SpanInspector";
import { SpanGraphWrapper } from "./SpanGraphWrapper";
import { SpanBarLink } from "./SpanBarLink";
import { getSessionProjectId } from "@/lib/session";

export const dynamic = "force-dynamic";

// ── Operation color palette ────────────────────────────────────────────────

const OP_COLORS: Record<
  string,
  { bar: string; text: string; dot: string; selected: string }
> = {
  chat: {
    bar:      "bg-blue-600",
    text:     "text-blue-50",
    dot:      "bg-blue-400",
    selected: "ring-2 ring-blue-300 ring-offset-1 ring-offset-gray-900",
  },
  execute_tool: {
    bar:      "bg-amber-500",
    text:     "text-amber-50",
    dot:      "bg-amber-400",
    selected: "ring-2 ring-amber-300 ring-offset-1 ring-offset-gray-900",
  },
  retrieve: {
    bar:      "bg-cyan-600",
    text:     "text-cyan-50",
    dot:      "bg-cyan-400",
    selected: "ring-2 ring-cyan-300 ring-offset-1 ring-offset-gray-900",
  },
  invoke_agent: {
    bar:      "bg-violet-600",
    text:     "text-violet-50",
    dot:      "bg-violet-400",
    selected: "ring-2 ring-violet-300 ring-offset-1 ring-offset-gray-900",
  },
  embeddings: {
    bar:      "bg-emerald-600",
    text:     "text-emerald-50",
    dot:      "bg-emerald-400",
    selected: "ring-2 ring-emerald-300 ring-offset-1 ring-offset-gray-900",
  },
};
const OP_DEFAULT = {
  bar:      "bg-gray-600",
  text:     "text-gray-50",
  dot:      "bg-gray-500",
  selected: "ring-2 ring-gray-400 ring-offset-1 ring-offset-gray-900",
};

// ── Depth map ──────────────────────────────────────────────────────────────

/**
 * Computes the visual nesting depth of each span.
 * Root spans (no parent in this run) get depth 0; each child level adds 1.
 */
function buildDepthMap(spans: SpanSummary[]): Map<string, number> {
  const spanMap = new Map(spans.map((s) => [s.span_id, s]));
  const cache   = new Map<string, number>();

  function depth(spanId: string): number {
    if (cache.has(spanId)) return cache.get(spanId)!;
    const span = spanMap.get(spanId);
    if (!span) return 0;

    const parentId = span.parent_span_id;
    const isRoot =
      !parentId ||
      parentId === ROOT_PARENT_ID ||
      !spanMap.has(parentId);

    const d = isRoot ? 0 : depth(parentId) + 1;
    cache.set(spanId, d);
    return d;
  }

  for (const span of spans) {
    depth(span.span_id);
  }
  return cache;
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1)      return "<1ms";
  if (ms < 1_000)  return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

function shortModel(model: string): string {
  return model
    .replace("gpt-4o-mini-2024-07-18", "gpt-4o-mini")
    .replace("gpt-4o-2024-11-20", "gpt-4o");
}

// ── Page ───────────────────────────────────────────────────────────────────

interface PageProps {
  params:       { id: string };
  searchParams: { span?: string; view?: string };
}

export default async function RunDetailPage({ params, searchParams }: PageProps) {
  const runId = params.id.toUpperCase();

  // Phase 4 Day 3: single scoped call — returns null if the run doesn't exist
  // OR doesn't belong to the session's project. Both cases → 404.
  // This closes the Day 2 data-leak: the old double-fetch (unscoped first,
  // scoped second) let unauthenticated callers confirm a run_id existed.
  const projectId = await getSessionProjectId();
  const scopedDetail = await getRunDetail(runId, projectId);
  if (!scopedDetail) notFound();

  const { run: scopedRun, spans: scopedSpans } = scopedDetail;

  // Fetch full span detail when ?span= is present (two extra ClickHouse queries).
  // null when no span is selected or the span_id doesn't exist.
  const selectedSpanHex = searchParams.span?.toUpperCase() ?? null;
  let spanDetail: SpanDetail | null = null;
  if (selectedSpanHex) {
    spanDetail = await getSpanDetail(runId, selectedSpanHex, projectId);
  }

  // Tab: "timeline" (default) | "graph"
  const view     = (searchParams.view === "graph") ? "graph" : "timeline";
  const spanQs   = selectedSpanHex ? `&span=${selectedSpanHex}` : "";

  // Timeline math
  const runStartMs    = scopedRun.started_at ? new Date(scopedRun.started_at).getTime() : 0;
  const runEndMs      = scopedRun.ended_at   ? new Date(scopedRun.ended_at).getTime()   : runStartMs;
  const totalDuration = Math.max(1, runEndMs - runStartMs); // avoid /0

  const depthMap        = buildDepthMap(scopedSpans);
  const selectedSpanId  = (searchParams.span ?? "").toUpperCase();

  // Run header stats
  const runDuration = formatDuration(totalDuration);

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-6xl mx-auto">

        {/* ── Breadcrumb ── */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors mb-6"
        >
          ← Runs
        </Link>

        {/* ── Run header ── */}
        <div className="mb-8">
          <div className="flex items-start gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white">
              {scopedRun.run_name || <span className="italic text-gray-500">Unnamed run</span>}
            </h1>
            {scopedRun.has_root && (
              <span className="mt-1 inline-block px-2 py-0.5 rounded text-xs font-semibold bg-indigo-900 text-indigo-300 uppercase tracking-wide">
                agent
              </span>
            )}
          </div>

          {/* Metadata strip */}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-400">
            <span>
              <span className="text-gray-600 mr-1.5">Started</span>
              {formatTimestamp(scopedRun.started_at)}
            </span>
            <span>
              <span className="text-gray-600 mr-1.5">Duration</span>
              <span className="text-gray-200">{runDuration}</span>
            </span>
            <span>
              <span className="text-gray-600 mr-1.5">Spans</span>
              <span className="text-gray-200">{scopedRun.span_count}</span>
            </span>
            <span>
              <span className="text-gray-600 mr-1.5">Tokens</span>
              <span className="text-gray-200">
                {scopedRun.total_input_tokens.toLocaleString()} in
                {" / "}
                {scopedRun.total_output_tokens.toLocaleString()} out
              </span>
            </span>
            <span>
              <span className="text-gray-600 mr-1.5">Cost</span>
              <span className={scopedRun.cost_dollars > 0 ? "text-emerald-400 font-medium" : "text-gray-600"}>
                {scopedRun.cost_display}
              </span>
            </span>
          </div>

          {/* Status + dialect badges */}
          <div className="mt-3 flex items-center gap-2">
            <StatusBadge status={scopedRun.worst_status} />
            <DialectBadge dialect={scopedRun.top_dialect} />
            {scopedRun.top_model && (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-mono bg-gray-800 text-gray-300">
                {shortModel(scopedRun.top_model)}
              </span>
            )}
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="flex gap-1 mb-4 p-1 bg-gray-900 rounded-lg w-fit border border-gray-800">
          {(["timeline", "graph"] as const).map((tab) => (
            <Link
              key={tab}
              href={`/runs/${runId}?view=${tab}${spanQs}`}
              className={[
                "px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize",
                view === tab
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50",
              ].join(" ")}
            >
              {tab}
            </Link>
          ))}
        </div>

        {/* ── Graph view (stretch / Day 5) ── */}
        {view === "graph" && (
          <SpanGraphWrapper
            spans={scopedSpans}
            runId={runId}
            selectedSpanId={selectedSpanHex ?? ""}
            view={view}
          />
        )}

        {/* ── Timeline card ── */}
        {view === "timeline" && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {/* Card header */}
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
                Timeline
              </h2>
              <span className="text-xs text-gray-500">
                {scopedSpans.length} span{scopedSpans.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="text-xs text-gray-600 font-mono">
              {runDuration} total
            </span>
          </div>

          {/* Column header */}
          <div className="flex items-center px-4 py-2 border-b border-gray-800/60 bg-gray-900/80">
            <div className="flex-none w-[220px] text-[10px] text-gray-600 uppercase tracking-wider">
              Span
            </div>
            <div className="flex-1 text-[10px] text-gray-600 uppercase tracking-wider px-2">
              Timeline · {runDuration}
            </div>
            <div className="flex-none w-[160px] text-[10px] text-gray-600 uppercase tracking-wider text-right">
              Tokens
            </div>
          </div>

          {/* Span rows */}
          <div className="divide-y divide-gray-800/40">
            {scopedSpans.map((span) => {
              const d = depthMap.get(span.span_id) ?? 0;

              const leftPct = ((span.start_time_ms - runStartMs) / totalDuration) * 100;
              const rawWidth = (span.duration_ms / totalDuration) * 100;
              // Clamp left to [0,99] and ensure min visible width
              const clampedLeft  = Math.max(0, Math.min(99, leftPct));
              const clampedWidth = Math.max(rawWidth, 0.5);

              const isSelected = selectedSpanId === span.span_id;
              const colors     = OP_COLORS[span.gen_ai_operation] ?? OP_DEFAULT;

              const opLabel   = span.gen_ai_operation || "span";
              const modelLabel = shortModel(span.gen_ai_request_model);
              const barLabel  = modelLabel
                ? `${opLabel} · ${modelLabel}`
                : opLabel;

              return (
                <div
                  key={span.span_id}
                  className="flex items-center py-2 hover:bg-gray-800/20 transition-colors"
                >
                  {/* Label — indented by depth */}
                  <div
                    className="flex-none w-[220px] flex items-center gap-1.5 overflow-hidden pr-3 min-w-0"
                    style={{ paddingLeft: `${d * 16 + 12}px` }}
                  >
                    {d > 0 && (
                      <span className="text-gray-700 shrink-0 text-xs">└</span>
                    )}
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`}
                    />
                    <span className="text-xs text-gray-300 truncate" title={barLabel}>
                      {opLabel}
                    </span>
                    {modelLabel && (
                      <span className="text-[10px] text-gray-600 truncate shrink-0">
                        · {modelLabel}
                      </span>
                    )}
                  </div>

                  {/* Bar area — SpanBarLink calls router.refresh() so the RSC
                      re-fetches spanDetail when ?span= changes (inspector fix). */}
                  <div className="flex-1 relative h-7 min-w-0 px-2">
                    <SpanBarLink
                      href={`/runs/${runId}?span=${span.span_id}`}
                      title={`${barLabel} · ${formatDuration(span.duration_ms)}`}
                      className={[
                        "absolute top-0.5 h-6 rounded flex items-center px-2 overflow-hidden",
                        "transition-all hover:brightness-110 active:brightness-90",
                        colors.bar,
                        isSelected ? colors.selected : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        left:     `${clampedLeft}%`,
                        width:    `${clampedWidth}%`,
                        minWidth: "6px",
                      }}
                    >
                      <span className={`text-[10px] font-medium truncate whitespace-nowrap ${colors.text}`}>
                        {formatDuration(span.duration_ms)}
                      </span>
                    </SpanBarLink>
                  </div>

                  {/* Token counts */}
                  <div className="flex-none w-[160px] flex items-center justify-end gap-3 pr-4 text-[11px] tabular-nums">
                    {span.input_tokens > 0 || span.output_tokens > 0 ? (
                      <>
                        <span className="text-gray-500" title="input tokens">
                          ↑{span.input_tokens.toLocaleString()}
                        </span>
                        <span className="text-gray-500" title="output tokens">
                          ↓{span.output_tokens.toLocaleString()}
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-gray-800/60 bg-gray-900/50 flex items-center justify-between">
            <span className="text-[11px] text-gray-600">
              Click a span bar to open the inspector →
            </span>
            <span className="text-[11px] text-gray-600">
              {scopedRun.started_at ? formatTimestamp(scopedRun.started_at) : ""}
            </span>
          </div>
        </div>
        )} {/* end timeline */}

    </div>

    {/* Span inspector drawer — Client Component, Suspense required for useSearchParams */}
    <Suspense fallback={null}>
      <SpanInspector runId={runId} spanDetail={spanDetail} />
    </Suspense>
  </main>
  );
}

// ── Badge helpers ──────────────────────────────────────────────────────────

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
