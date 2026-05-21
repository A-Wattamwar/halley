/**
 * /spans — flat spans debug table (moved from / on Day 1 of Week 6).
 *
 * Kept at this route for debugging ingestion during Week 6 development.
 * See DECISIONS.md D45 for the rationale.
 *
 * Server Component: queries ClickHouse directly, renders a static HTML table.
 * No "use client", no client-side JavaScript needed.
 *
 * Fetches the 100 most recent observations ordered by start_time DESC.
 * No pagination, filters, or sorting controls — Phase 4 scope.
 *
 * force-dynamic: disable Next.js static pre-rendering so every request
 * hits ClickHouse fresh.
 */
import { getClickHouseClient } from "@/lib/clickhouse";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface SpanRow {
  trace_id: string;
  span_id: string;
  gen_ai_system: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  input_tokens: number;
  output_tokens: number;
  source_dialect: string;
  run_name: string;
  status: string;
  started_at: string;
}

async function getSpans(): Promise<SpanRow[]> {
  const client = getClickHouseClient();
  try {
    const result = await client.query({
      query: `
        SELECT
          hex(trace_id)                                        AS trace_id,
          hex(span_id)                                         AS span_id,
          gen_ai_system,
          gen_ai_operation,
          gen_ai_request_model,
          gen_ai_usage_input_tokens                            AS input_tokens,
          gen_ai_usage_output_tokens                           AS output_tokens,
          source_dialect,
          run_name,
          status,
          formatDateTime(start_time, '%Y-%m-%d %H:%M:%S')     AS started_at
        FROM halley.observations
        ORDER BY start_time DESC
        LIMIT 100
      `,
      format: "JSONEachRow",
    });
    return await result.json<SpanRow>();
  } finally {
    await client.close();
  }
}

export default async function SpansPage() {
  const spans = await getSpans();

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="mb-6 flex items-center gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link
              href="/"
              className="text-gray-400 hover:text-gray-200 text-sm transition-colors"
            >
              ← Runs
            </Link>
            <span className="text-gray-700">/</span>
            <h1 className="text-2xl font-bold text-white">Spans</h1>
            <span className="text-xs bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded font-medium">
              Debug view
            </span>
          </div>
          <p className="text-gray-400 text-sm">
            {spans.length === 0
              ? "No spans yet. Post a span to the ingester to see it here."
              : `${spans.length} most recent observation${spans.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      {spans.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-gray-500">
          No observations found. Send a span to{" "}
          <code className="text-gray-300">POST /v1/spans/json</code> to get
          started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-900 text-gray-400 uppercase text-xs tracking-wider">
              <tr>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Trace ID</th>
                <th className="px-4 py-3">Span ID</th>
                <th className="px-4 py-3">System</th>
                <th className="px-4 py-3">Operation</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3 text-right">In</th>
                <th className="px-4 py-3 text-right">Out</th>
                <th className="px-4 py-3">Run</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Dialect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {spans.map((span, i) => (
                <tr
                  key={`${span.trace_id}-${span.span_id}-${i}`}
                  className="bg-gray-950 hover:bg-gray-900 transition-colors"
                >
                  <td className="px-4 py-3 text-gray-300 whitespace-nowrap font-mono text-xs">
                    {span.started_at}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400 whitespace-nowrap">
                    {span.trace_id.slice(0, 16)}&hellip;
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400 whitespace-nowrap">
                    {span.span_id.slice(0, 12)}&hellip;
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {span.gen_ai_system || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {span.gen_ai_operation || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                    {span.gen_ai_request_model || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300 tabular-nums">
                    {span.input_tokens}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300 tabular-nums">
                    {span.output_tokens}
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {span.run_name || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={span.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {span.source_dialect}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    ok: "bg-green-900 text-green-300",
    error: "bg-red-900 text-red-300",
    timeout: "bg-yellow-900 text-yellow-300",
  };
  const cls = colours[status] ?? "bg-gray-800 text-gray-400";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
