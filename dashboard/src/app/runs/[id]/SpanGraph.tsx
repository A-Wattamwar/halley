"use client";

/**
 * SpanGraph — ReactFlow Gantt graph of a run's spans.
 *
 * Renders each span as a node; parent→child edges from parent_span_id.
 * Layout computed server-free via dagre (client-side only).
 * Node colors and operation labels match the timeline bar palette.
 *
 * Clicking a node navigates to ?view=graph&span=<hex> to open the inspector.
 *
 * "use client" because:
 *   - ReactFlow accesses browser APIs (ResizeObserver, etc.) at init time.
 *   - useRouter for node-click navigation.
 *   - useMemo / useCallback for stable nodeTypes and handlers.
 *
 * Imported via SpanGraphWrapper's next/dynamic({ssr:false}) so the bundle
 * never loads during SSR.
 */

import { useMemo, useCallback } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeTypes,
} from "reactflow";
import "reactflow/dist/style.css";
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { useRouter } from "next/navigation";
import type { SpanSummary } from "@/lib/halley-query";

// ── Constants ──────────────────────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 72;
const ROOT_PARENT = "0000000000000000"; // 8 zero bytes → 16 hex chars

// Hex color values (must match timeline OP_COLORS Tailwind classes)
const OP_BG: Record<string, string> = {
  chat:         "#2563eb", // blue-600
  execute_tool: "#f59e0b", // amber-500
  retrieve:     "#0891b2", // cyan-600
  invoke_agent: "#7c3aed", // violet-600
  embeddings:   "#059669", // emerald-600
};
const OP_BG_DEFAULT = "#4b5563"; // gray-600

// ── Helpers ────────────────────────────────────────────────────────────────

function shortModel(m: string) {
  return m
    .replace("gpt-4o-mini-2024-07-18", "gpt-4o-mini")
    .replace("gpt-4o-2024-11-20", "gpt-4o");
}

function fmtMs(ms: number) {
  if (ms < 1)      return "<1ms";
  if (ms < 1_000)  return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

// ── Dagre layout ───────────────────────────────────────────────────────────

function buildGraph(spans: SpanSummary[]): {
  nodes: Node[];
  edges: Edge[];
} {
  const spanIds = new Set(spans.map((s) => s.span_id));

  const g = new graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 56, nodesep: 36, marginx: 24, marginy: 24 });

  for (const span of spans) {
    g.setNode(span.span_id, { width: NODE_W, height: NODE_H });
  }

  const edges: Edge[] = [];
  for (const span of spans) {
    const pid = span.parent_span_id;
    if (pid && pid !== ROOT_PARENT && spanIds.has(pid)) {
      g.setEdge(pid, span.span_id);
      edges.push({
        id:     `e-${pid}-${span.span_id}`,
        source: pid,
        target: span.span_id,
        type:   "smoothstep",
        style:  { stroke: "#374151", strokeWidth: 1.5 },
      });
    }
  }

  dagreLayout(g);

  const nodes: Node[] = spans.map((span) => {
    const pos = g.node(span.span_id);
    return {
      id:       span.span_id,
      type:     "spanNode",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data:     { span },
      // ReactFlow uses `selected` for the ring highlight
      selected: false,
    };
  });

  return { nodes, edges };
}

// ── Custom span node ───────────────────────────────────────────────────────

// nodeTypes must be defined OUTSIDE the component (or memoized) so ReactFlow
// doesn't re-register them on every render, which would cause flickering.
interface SpanNodeData {
  span: SpanSummary;
}

function SpanNode({
  data,
  selected,
}: {
  data: SpanNodeData;
  selected?: boolean;
}) {
  const { span } = data;
  const bg = OP_BG[span.gen_ai_operation] ?? OP_BG_DEFAULT;
  const short = shortModel(span.gen_ai_request_model);

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "#6b7280", border: "none", width: 8, height: 8 }}
      />
      <div
        style={{
          background:   bg,
          border:       selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.12)",
          borderRadius: "8px",
          padding:      "8px 12px",
          width:        NODE_W,
          minHeight:    NODE_H,
          boxShadow:    selected
            ? "0 0 0 3px rgba(255,255,255,0.25), 0 4px 16px rgba(0,0,0,0.4)"
            : "0 2px 8px rgba(0,0,0,0.3)",
          cursor:       "pointer",
          userSelect:   "none",
          transition:   "box-shadow 150ms ease, border-color 150ms ease",
        }}
      >
        <div
          style={{
            fontSize:     "12px",
            fontWeight:   600,
            color:        "#ffffff",
            overflow:     "hidden",
            textOverflow: "ellipsis",
            whiteSpace:   "nowrap",
          }}
        >
          {span.gen_ai_operation || "span"}
        </div>
        {short && (
          <div
            style={{
              fontSize:     "10px",
              color:        "rgba(255,255,255,0.70)",
              overflow:     "hidden",
              textOverflow: "ellipsis",
              whiteSpace:   "nowrap",
              marginTop:    "2px",
            }}
          >
            {short}
          </div>
        )}
        <div
          style={{
            fontSize:  "10px",
            color:     "rgba(255,255,255,0.55)",
            marginTop: "6px",
          }}
        >
          {fmtMs(span.duration_ms)}
          {(span.input_tokens > 0 || span.output_tokens > 0) && (
            <span style={{ marginLeft: "8px" }}>
              ↑{span.input_tokens.toLocaleString()} ↓{span.output_tokens.toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "#6b7280", border: "none", width: 8, height: 8 }}
      />
    </>
  );
}

// Stable reference — defined at module scope so ReactFlow doesn't re-register.
const NODE_TYPES: NodeTypes = { spanNode: SpanNode };

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  spans:          SpanSummary[];
  runId:          string;
  selectedSpanId: string;
  view:           string;
}

export function SpanGraph({ spans, runId, selectedSpanId, view }: Props) {
  const router = useRouter();

  const { nodes: baseNodes, edges } = useMemo(
    () => buildGraph(spans),
    [spans]
  );

  // Inject `selected` flag without mutating the memoized base nodes.
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => ({
        ...n,
        selected: n.id === selectedSpanId,
      })),
    [baseNodes, selectedSpanId]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      router.push(`/runs/${runId}?view=${view}&span=${node.id}`);
    },
    [router, runId, view]
  );

  return (
    <div style={{ height: 520, background: "#030712", borderRadius: "12px", overflow: "hidden" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={() => {/* read-only — nodesDraggable=false */}}
        onEdgesChange={() => {/* read-only */}}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnScroll={false}
        zoomOnScroll={true}
        style={{ background: "#030712" }}
      >
        <Background color="#1f2937" gap={24} size={1} />
        <Controls
          style={{
            background: "#111827",
            border: "1px solid #374151",
            borderRadius: "8px",
          }}
        />
        <MiniMap
          nodeColor={(n) => OP_BG[n.data?.span?.gen_ai_operation] ?? OP_BG_DEFAULT}
          style={{
            background: "#111827",
            border: "1px solid #374151",
            borderRadius: "8px",
          }}
          maskColor="rgba(3,9,18,0.7)"
        />
      </ReactFlow>
    </div>
  );
}
