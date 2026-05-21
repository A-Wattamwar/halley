"use client";

/**
 * SpanGraphWrapper — SSR-safe dynamic loader for SpanGraph.
 *
 * ReactFlow accesses browser globals (ResizeObserver, window, etc.)
 * at module initialization time, which breaks SSR. Using next/dynamic
 * with ssr:false inside this Client Component ensures the SpanGraph
 * module never executes on the server.
 *
 * Pattern: Server Component (page.tsx) imports this wrapper (a Client Component).
 * The wrapper lazily loads the heavy ReactFlow component on the client.
 */

import dynamic from "next/dynamic";
import type { SpanSummary } from "@/lib/halley-query";

interface Props {
  spans:          SpanSummary[];
  runId:          string;
  selectedSpanId: string;
  view:           string;
}

const SpanGraphDynamic = dynamic(
  () => import("./SpanGraph").then((m) => m.SpanGraph),
  {
    ssr: false,
    loading: () => (
      <div
        style={{ height: 520 }}
        className="flex items-center justify-center bg-gray-950 rounded-xl border border-gray-800"
      >
        <span className="text-sm text-gray-500 animate-pulse">Loading graph…</span>
      </div>
    ),
  }
);

export function SpanGraphWrapper(props: Props) {
  return <SpanGraphDynamic {...props} />;
}
