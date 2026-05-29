"use client";

/**
 * LiveSpansIsland — client island that opens the SSE stream for a run and
 * appends new spans as rows below the server-rendered timeline.
 *
 * Rendered alongside the existing Server-Component timeline (D-11 intact).
 * Does NOT replace or reconcile with server rows — new arrivals are appended
 * as simple list rows. Full Gantt bar placement is out of scope for Day 2.
 *
 * Day 3 additions:
 * - Connection-state badge: pulsing green "Live" dot when open; grey/red
 *   "Disconnected" badge otherwise.
 * - Toast: when new spans arrive while the live section is scrolled out of the
 *   viewport, a dismissible "N new spans" toast appears at the bottom-right.
 *   Uses IntersectionObserver — no extra library needed.
 */

import { useEffect, useRef, useState } from "react";
import { useLiveSpans, type LiveSpan, type ConnState } from "./useLiveSpans";

// ── Operation color palette — mirrors the server component's OP_COLORS ─────

const OP_COLORS: Record<string, { dot: string; text: string }> = {
  chat:         { dot: "bg-blue-400",    text: "text-blue-300" },
  execute_tool: { dot: "bg-amber-400",   text: "text-amber-300" },
  retrieve:     { dot: "bg-cyan-400",    text: "text-cyan-300" },
  invoke_agent: { dot: "bg-violet-400",  text: "text-violet-300" },
  embeddings:   { dot: "bg-emerald-400", text: "text-emerald-300" },
};
const OP_DEFAULT = { dot: "bg-gray-500", text: "text-gray-400" };

function shortModel(model: string): string {
  return (model ?? "")
    .replace("gpt-4o-mini-2024-07-18", "gpt-4o-mini")
    .replace("gpt-4o-2024-11-20", "gpt-4o");
}

// ── Connection badge ─────────────────────────────────────────────────────────

function ConnectionBadge({ state }: { state: ConnState }) {
  if (state === "open") {
    return (
      <span className="inline-flex items-center gap-1.5">
        {/* Pulsing green dot */}
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <span className="text-xs font-medium text-green-400">Live</span>
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-yellow-500 opacity-60 animate-pulse" />
        <span className="text-xs font-medium text-yellow-500">Connecting…</span>
      </span>
    );
  }
  // disconnected
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full bg-gray-600" />
      <span className="text-xs font-medium text-gray-500">Disconnected</span>
    </span>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  runId: string;
  /** span_ids already rendered by the server component, in hex upper-case */
  initialSpanIds: string[];
}

// ── Main component ────────────────────────────────────────────────────────────

export function LiveSpansIsland({ runId, initialSpanIds }: Props) {
  const { spans: liveSpans, connState } = useLiveSpans(runId);

  // Filter out spans that were already present at server render time.
  const newSpans = liveSpans.filter(
    (s) => !initialSpanIds.includes(s.span_id.toUpperCase())
  );

  // ── Toast for spans arriving while section is out of viewport ─────────────

  const sectionRef = useRef<HTMLDivElement | null>(null);
  const isVisibleRef = useRef(true); // whether the live section is in the viewport
  const [toastCount, setToastCount] = useState(0);
  const [toastDismissed, setToastDismissed] = useState(false);

  // Track span count from previous render to detect new arrivals.
  const prevNewSpanCountRef = useRef(newSpans.length);

  // IntersectionObserver — set up once the section mounts.
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisibleRef.current = entry.isIntersecting;
        // If the section scrolls back into view, dismiss the toast.
        if (entry.isIntersecting) {
          setToastCount(0);
          setToastDismissed(false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Accumulate toast count whenever new spans arrive while section is hidden.
  useEffect(() => {
    const delta = newSpans.length - prevNewSpanCountRef.current;
    prevNewSpanCountRef.current = newSpans.length;

    if (delta > 0 && !isVisibleRef.current) {
      setToastDismissed(false);
      setToastCount((c) => c + delta);
    }
  }, [newSpans.length]);

  // The new-spans panel (header + rows) is visible when there's content or
  // the connection is in a non-open state. The badge itself is ALWAYS shown.
  const showPanel = newSpans.length > 0 || connState !== "open";

  return (
    <>
      {/* ── Persistent connection badge — always visible once mounted ── */}
      <div className="mt-3 flex items-center justify-end px-1">
        <ConnectionBadge state={connState} />
      </div>

      {/* ── Live section — only when there's content or connecting/disconnected ── */}
      <div ref={sectionRef} className={showPanel ? "mt-2" : "mt-2 hidden"}>
        {showPanel && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
                Live
              </h2>
              {newSpans.length > 0 && (
                <span className="text-xs text-gray-500">
                  {newSpans.length} new span{newSpans.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {newSpans.length > 0 && (
              <div className="divide-y divide-gray-800/40">
                {newSpans.map((span) => (
                  <LiveSpanRow key={span.span_id} span={span} />
                ))}
              </div>
            )}

            {newSpans.length === 0 && connState !== "open" && (
              <div className="px-5 py-4 text-xs text-gray-600">
                Waiting for live spans…
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Toast — new spans while section is out of viewport ── */}
      {toastCount > 0 && !toastDismissed && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl shadow-xl text-sm text-gray-200 animate-in slide-in-from-bottom-2 fade-in duration-200">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          {toastCount} new span{toastCount === 1 ? "" : "s"}
          <button
            onClick={() => setToastDismissed(true)}
            className="ml-1 text-gray-500 hover:text-gray-300 transition-colors text-base leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────

function LiveSpanRow({ span }: { span: LiveSpan }) {
  const colors = OP_COLORS[span.gen_ai_operation] ?? OP_DEFAULT;
  const model = shortModel(span.model);
  const opLabel = span.gen_ai_operation || "span";

  return (
    <div className="flex items-center px-4 py-2 hover:bg-gray-800/20 transition-colors gap-3">
      {/* Operation dot */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`} />

      {/* Operation + model */}
      <span className={`text-xs ${colors.text}`}>{opLabel}</span>
      {model && (
        <span className="text-[10px] text-gray-600">· {model}</span>
      )}

      {/* Status badge */}
      <StatusPill status={span.status} />

      {/* Span ID (truncated) */}
      <span className="ml-auto text-[10px] font-mono text-gray-700 truncate">
        {span.span_id.slice(0, 12)}…
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ok:      "bg-green-900/50 text-green-400",
    error:   "bg-red-900/50 text-red-400",
    timeout: "bg-yellow-900/50 text-yellow-400",
  };
  const cls = map[status] ?? "bg-gray-800 text-gray-500";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${cls}`}>
      {status || "—"}
    </span>
  );
}
