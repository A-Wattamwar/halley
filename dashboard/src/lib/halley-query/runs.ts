/**
 * halley-query/runs.ts
 *
 * listRuns(): queries halley.observations GROUP BY run_id to produce one
 * RunSummary per agent run, ordered by started_at DESC.
 *
 * Schema notes (ARCHITECTURE §4.1):
 *   - trace_id / run_id are FixedString(16) — hex() in SQL, stored as raw bytes.
 *   - status is Enum8('ok'=1,'error'=2,'timeout'=3) — MAX surfaces worst.
 *   - is_run_root is Bool — MAX(if(is_run_root,1,0)) = 1 if any span is root.
 *   - attributes is Map(String,String).
 *
 * D-12: all ClickHouse queries live here, not in page files.
 * D-11: this module is Server-side only (no "use client").
 */

import { getClickHouseClient } from "@/lib/clickhouse";
import { computeRunCost, fetchPricingMap, formatCost } from "./pricing";

export interface RunSummary {
  /** Uppercase hex of the run_id (= trace_id) */
  run_id: string;
  started_at: string;
  ended_at: string;
  run_name: string;
  span_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  top_model: string;
  top_dialect: string;
  has_root: boolean;
  worst_status: string;
  /** Read-time cost in dollars (computed from pricing_versions) */
  cost_dollars: number;
  cost_display: string;
}

export interface ListRunsParams {
  /** ISO timestamp lower bound (inclusive). Defaults to 7 days ago. */
  fromTime?: string;
  /** ISO timestamp upper bound (inclusive). Defaults to now. */
  toTime?: string;
  limit?: number;
}

/**
 * Fetch a summarised list of runs (one row per run_id) from ClickHouse,
 * annotated with read-time cost from pricing_versions.
 *
 * Uses a single GROUP BY query over halley.observations — no join needed
 * because run-level attributes are denormalised per row (ARCHITECTURE §3.4).
 */
export async function listRuns(
  params: ListRunsParams = {}
): Promise<RunSummary[]> {
  const {
    fromTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    toTime = new Date().toISOString(),
    limit = 200,
  } = params;

  const client = getClickHouseClient();

  // Fetch pricing map once; passed into computeRunCost per-row.
  // We close this client after the observations query, then close that one.
  // Shared client is fine here — both queries happen sequentially.
  const pricingMap = await fetchPricingMap();

  interface RawRun {
    run_id: string;
    started_at: string;
    ended_at: string;
    run_name: string;
    span_count: string; // ClickHouse returns aggregates as strings in JSONEachRow
    total_input_tokens: string;
    total_output_tokens: string;
    top_model: string;
    top_dialect: string;
    has_root: string; // "0" or "1"
    worst_status: string;
  }

  try {
    const result = await client.query({
      query: `
        SELECT
          hex(run_id)                                       AS run_id,
          formatDateTime(MIN(start_time), '%Y-%m-%dT%H:%i:%SZ') AS started_at,
          formatDateTime(MAX(end_time),   '%Y-%m-%dT%H:%i:%SZ') AS ended_at,
          MAX(run_name)                                     AS run_name,
          COUNT(*)                                          AS span_count,
          SUM(gen_ai_usage_input_tokens)                    AS total_input_tokens,
          SUM(gen_ai_usage_output_tokens)                   AS total_output_tokens,
          MAX(gen_ai_request_model)                         AS top_model,
          MAX(source_dialect)                               AS top_dialect,
          MAX(if(is_run_root, 1, 0))                        AS has_root,
          MAX(status)                                       AS worst_status
        FROM halley.observations
        WHERE start_time >= {fromTime: String}
          AND start_time <= {toTime: String}
        GROUP BY run_id
        ORDER BY MIN(start_time) DESC
        LIMIT {limit: UInt32}
      `,
      query_params: { fromTime, toTime, limit },
      format: "JSONEachRow",
    });

    const rows = await result.json<RawRun>();

    return rows.map((row) => {
      const inputTokens = parseInt(row.total_input_tokens, 10) || 0;
      const outputTokens = parseInt(row.total_output_tokens, 10) || 0;
      const cost = computeRunCost(
        inputTokens,
        outputTokens,
        row.top_model,
        pricingMap
      );

      return {
        run_id: row.run_id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        run_name: row.run_name,
        span_count: parseInt(row.span_count, 10) || 0,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        top_model: row.top_model,
        top_dialect: row.top_dialect,
        has_root: row.has_root === "1",
        worst_status: row.worst_status,
        cost_dollars: cost,
        cost_display: formatCost(cost),
      };
    });
  } finally {
    await client.close();
  }
}
