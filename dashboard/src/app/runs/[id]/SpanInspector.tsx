"use client";

/**
 * SpanInspector — right-side drawer that shows full detail for a selected span.
 *
 * Client Component because it:
 *   1. Reads useSearchParams() to derive open/closed animation state.
 *   2. Uses useState for copy-button feedback (navigator.clipboard).
 *   3. Drives CSS transform transitions for the slide-in/out animation.
 *
 * Data flow (D-11, Server Components first):
 *   - The parent Server Component (/runs/[id]/page.tsx) fetches SpanDetail
 *     when searchParams.span is present and passes it as a prop.
 *   - This component only handles UI state and browser APIs.
 *
 * Closing: navigate to /runs/[id] (removes ?span=) → Server Component
 *   re-renders with spanDetail=null → isOpen becomes false → slides out.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { SpanDetail } from "@/lib/halley-query";

interface Props {
  runId:      string;
  spanDetail: SpanDetail | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZone: "UTC",
    }) + " UTC";
  } catch { return iso; }
}

function fmtMs(ms: number): string {
  if (ms < 1)      return "<1ms";
  if (ms < 1_000)  return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
}

function truncHex(hex: string, chars = 24): string {
  return hex.length > chars ? hex.slice(0, chars) + "…" : hex;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2 mt-5 first:mt-0">
      {title}
    </h3>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="text-[11px] text-gray-500 w-28 shrink-0 pt-px">{label}</span>
      <span className="text-[11px] text-gray-300 break-all">{value}</span>
    </div>
  );
}

function IdentityRow({
  label,
  value,
  copiedField,
  onCopy,
}: {
  label:       string;
  value:       string;
  copiedField: string | null;
  onCopy:      (field: string, text: string) => void;
}) {
  if (!value) return null;
  const isCopied = copiedField === label;
  return (
    <div className="flex items-center justify-between py-0.5 group/id">
      <span className="text-[11px] text-gray-500 w-28 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        <code className="text-[11px] text-gray-300 font-mono truncate">
          {truncHex(value)}
        </code>
        <button
          onClick={() => onCopy(label, value)}
          className="shrink-0 text-[10px] text-gray-600 hover:text-gray-300 transition-colors opacity-0 group-hover/id:opacity-100"
          title={isCopied ? "Copied!" : `Copy ${label}`}
        >
          {isCopied ? "✓" : "⎘"}
        </button>
      </div>
    </div>
  );
}

function BodyBlock({
  title,
  body,
  hash,
  fieldKey,
  copiedField,
  onCopy,
}: {
  title:       string;
  body:        string | null;
  hash:        string;
  fieldKey:    string;
  copiedField: string | null;
  onCopy:      (field: string, text: string) => void;
}) {
  const pretty = body ? prettyJson(body) : null;
  const isCopied = copiedField === fieldKey;

  return (
    <div>
      <SectionHeader title={title} />
      {pretty ? (
        <div className="relative group/body">
          <pre className="text-[11px] text-gray-300 bg-gray-950/80 border border-gray-800 rounded-lg p-3 overflow-auto max-h-52 font-mono leading-relaxed whitespace-pre-wrap break-all">
            {pretty}
          </pre>
          <button
            onClick={() => onCopy(fieldKey, pretty)}
            className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors opacity-0 group-hover/body:opacity-100"
          >
            {isCopied ? "Copied!" : "Copy"}
          </button>
        </div>
      ) : hash ? (
        <p className="text-[11px] text-gray-600 italic">
          Body stored but not in cache (may have expired after 30-day TTL).
        </p>
      ) : (
        <p className="text-[11px] text-gray-600 italic">No body recorded.</p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function SpanInspector({ runId, spanDetail }: Props) {
  const searchParams  = useSearchParams();
  const selectedSpanId = searchParams.get("span")?.toUpperCase() ?? null;

  // Animate open when selectedSpanId + spanDetail are both present.
  const shouldBeOpen = !!selectedSpanId && !!spanDetail;
  const [isOpen, setIsOpen] = useState(false);

  // Keep last-seen detail so the drawer can animate out with content still visible.
  const [displayDetail, setDisplayDetail] = useState<SpanDetail | null>(spanDetail);

  useEffect(() => {
    if (spanDetail) {
      setDisplayDetail(spanDetail); // update content immediately
      // Tiny delay lets the DOM render the initial closed state before transitioning in.
      const t = setTimeout(() => setIsOpen(true), 16);
      return () => clearTimeout(t);
    } else {
      setIsOpen(false);
      // Keep displayDetail for slide-out animation; clear after transition finishes.
      const t = setTimeout(() => setDisplayDetail(null), 350);
      return () => clearTimeout(t);
    }
  }, [spanDetail]);

  // Copy-button state: tracks which field was last copied.
  const [copiedField, setCopiedField] = useState<string | null>(null);

  function copyToClipboard(field: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2_000);
    }).catch(() => {});
  }

  const d = displayDetail;

  // ── Status / dialect badge colors ──────────────────────────────────────
  const statusCls: Record<string, string> = {
    ok:      "bg-green-900/60 text-green-300 border border-green-800",
    error:   "bg-red-900/60 text-red-300 border border-red-800",
    timeout: "bg-yellow-900/60 text-yellow-300 border border-yellow-800",
  };
  const dialectCls: Record<string, string> = {
    "otel-genai":    "bg-blue-900/50 text-blue-300",
    "openllmetry":   "bg-purple-900/50 text-purple-300",
    "openinference": "bg-orange-900/50 text-orange-300",
    "vercel-ai":     "bg-teal-900/50 text-teal-300",
    "halley":        "bg-indigo-900/50 text-indigo-300",
  };

  return (
    <>
      {/* Backdrop — click to close */}
      <Link
        href={`/runs/${runId}`}
        aria-label="Close span inspector"
        className={[
          "fixed inset-0 z-40 transition-opacity duration-300",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        style={{ background: "rgba(0,0,0,0.25)" }}
      />

      {/* Drawer panel */}
      <div
        className={[
          "fixed top-0 right-0 h-full z-50",
          "w-[480px] max-w-full",
          "bg-gray-900 border-l border-gray-800 shadow-2xl",
          "flex flex-col",
          "transform transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {d ? (
          <>
            {/* ── Drawer header ── */}
            <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">
                    {d.gen_ai_operation || "span"}
                    {d.gen_ai_request_model
                      ? ` · ${d.gen_ai_request_model
                          .replace("gpt-4o-mini-2024-07-18", "gpt-4o-mini")
                          .replace("gpt-4o-2024-11-20", "gpt-4o")}`
                      : ""}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  {d.source_dialect && (
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${dialectCls[d.source_dialect] ?? "bg-gray-800/50 text-gray-400"}`}>
                      {d.source_dialect}
                    </span>
                  )}
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusCls[d.status] ?? "bg-gray-800 text-gray-400 border border-gray-700"}`}>
                    {d.status || "—"}
                  </span>
                  {d.is_run_root && (
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-900 text-indigo-300 uppercase tracking-wide">
                      run root
                    </span>
                  )}
                </div>
              </div>
              {/* Close button */}
              <Link
                href={`/runs/${runId}`}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors text-lg leading-none"
                aria-label="Close"
              >
                ×
              </Link>
            </div>

            {/* ── Scrollable body ── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-1">

              {/* Error message */}
              {d.error_message && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-red-950/40 border border-red-900/50 text-xs text-red-300">
                  {d.error_message}
                </div>
              )}

              {/* Timing */}
              <SectionHeader title="Timing" />
              <MetaRow label="Started"  value={fmtTs(d.start_time_iso)} />
              <MetaRow label="Ended"    value={fmtTs(d.end_time_iso)} />
              <MetaRow label="Duration" value={fmtMs(d.duration_ms)} />

              {/* Identity */}
              <SectionHeader title="Identity" />
              <IdentityRow label="Span ID"   value={d.span_id}        copiedField={copiedField} onCopy={copyToClipboard} />
              <IdentityRow label="Trace ID"  value={d.trace_id}       copiedField={copiedField} onCopy={copyToClipboard} />
              {d.parent_span_id && (
                <IdentityRow label="Parent"  value={d.parent_span_id} copiedField={copiedField} onCopy={copyToClipboard} />
              )}
              <IdentityRow label="Run ID"    value={d.run_id}         copiedField={copiedField} onCopy={copyToClipboard} />

              {/* Model */}
              {(d.gen_ai_system || d.gen_ai_request_model) && (
                <>
                  <SectionHeader title="Model" />
                  <MetaRow label="System"        value={d.gen_ai_system} />
                  <MetaRow label="Request model" value={d.gen_ai_request_model} />
                  <MetaRow label="Response model" value={d.gen_ai_response_model} />
                  <MetaRow label="Finish reason" value={d.gen_ai_response_finish_reason} />
                </>
              )}

              {/* Usage */}
              {(d.input_tokens > 0 || d.output_tokens > 0 || d.cost_dollars > 0) && (
                <>
                  <SectionHeader title="Usage" />
                  <MetaRow label="Input tokens"  value={d.input_tokens.toLocaleString()} />
                  <MetaRow label="Output tokens" value={d.output_tokens.toLocaleString()} />
                  <MetaRow label="Cost"          value={d.cost_display} />
                </>
              )}

              {/* Bodies */}
              <BodyBlock
                title="Input body"
                body={d.input_body}
                hash={d.input_body_hash}
                fieldKey="input_body"
                copiedField={copiedField}
                onCopy={copyToClipboard}
              />
              <BodyBlock
                title="Output body"
                body={d.output_body}
                hash={d.output_body_hash}
                fieldKey="output_body"
                copiedField={copiedField}
                onCopy={copyToClipboard}
              />

              {/* Tool section */}
              {d.tool_name && (
                <>
                  <SectionHeader title="Tool" />
                  <MetaRow label="Name"        value={d.tool_name} />
                  <MetaRow label="Side effect" value={d.tool_side_effect} />
                  {(d.tool_input_hash || d.tool_output_hash) && (
                    <div className="mt-2 space-y-3">
                      <BodyBlock
                        title="Tool input"
                        body={d.tool_input_body}
                        hash={d.tool_input_hash}
                        fieldKey="tool_input_body"
                        copiedField={copiedField}
                        onCopy={copyToClipboard}
                      />
                      <BodyBlock
                        title="Tool output"
                        body={d.tool_output_body}
                        hash={d.tool_output_hash}
                        fieldKey="tool_output_body"
                        copiedField={copiedField}
                        onCopy={copyToClipboard}
                      />
                    </div>
                  )}
                </>
              )}

              {/* Attributes — collapsible */}
              {Object.keys(d.attributes).length > 0 && (
                <div className="mt-4">
                  <details>
                    <summary className="cursor-pointer text-[10px] font-semibold text-gray-500 uppercase tracking-widest hover:text-gray-300 transition-colors list-none flex items-center gap-1.5">
                      <span className="text-gray-700">▶</span>
                      Attributes ({Object.keys(d.attributes).length})
                    </summary>
                    <div className="mt-2 relative group/attr">
                      <pre className="text-[10px] text-gray-400 bg-gray-950/80 border border-gray-800 rounded-lg p-3 overflow-auto max-h-64 font-mono leading-relaxed whitespace-pre-wrap break-all">
                        {JSON.stringify(d.attributes, null, 2)}
                      </pre>
                      <button
                        onClick={() =>
                          copyToClipboard("attributes", JSON.stringify(d.attributes, null, 2))
                        }
                        className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors opacity-0 group-hover/attr:opacity-100"
                      >
                        {copiedField === "attributes" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </details>
                </div>
              )}

              {/* Bottom padding */}
              <div className="h-6" />
            </div>

            {/* ── Footer ── */}
            <div className="shrink-0 px-5 py-3 border-t border-gray-800 bg-gray-900/80 flex items-center justify-between">
              <span className="text-[10px] text-gray-600 font-mono truncate">
                {d.span_id.toLowerCase()}
              </span>
              <Link
                href={`/runs/${runId}`}
                className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                Close ×
              </Link>
            </div>
          </>
        ) : (
          /* Empty state while animating out */
          <div className="flex-1 flex items-center justify-center">
            <span className="text-sm text-gray-600">Loading span…</span>
          </div>
        )}
      </div>
    </>
  );
}
