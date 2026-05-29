/**
 * query/observations.ts — ClickHouse query module for the worker.
 *
 * D-12: all ClickHouse access goes through a query module, not inline strings.
 *
 * Mirrors the dashboard's halley-query pattern. Returns typed rows ordered by
 * start_time ASC so the invariant engine sees spans in execution order.
 */

import { getClickHouseClient } from "../connections.js";

export interface ObservationRow {
  /** Uppercase hex, 32 chars (16 bytes = run_id / trace_id). */
  run_id: string;
  /** Uppercase hex, 16 chars (8 bytes). */
  span_id: string;
  /** Uppercase hex, 16 chars. "0000000000000000" means root (no parent). */
  parent_span_id: string;
  /** Unix epoch milliseconds (as number — parsed from Int64 string). */
  start_time_ms: number;
  end_time_ms: number;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  gen_ai_system: string;
  status: string;
  source_dialect: string;
  is_run_root: boolean;
  run_name: string;
  input_tokens: number;
  output_tokens: number;
  attributes: Record<string, string>;
}

interface RawRow {
  run_id: string;
  span_id: string;
  parent_span_id: string;
  start_time_ms: string;
  end_time_ms: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  gen_ai_system: string;
  status: string;
  source_dialect: string;
  is_run_root: boolean | string | number;
  run_name: string;
  input_tokens: string;
  output_tokens: string;
  attributes: Record<string, string>;
}

/**
 * Load all observations for a run, ordered by start_time ASC.
 *
 * @param runId  32-char uppercase hex string.
 * @returns Array of ObservationRow, empty if the run_id doesn't exist.
 */
export async function loadRunObservations(
  runId: string
): Promise<ObservationRow[]> {
  const ch = getClickHouseClient();
  try {
    const result = await ch.query({
      query: `
        SELECT
          hex(observations.run_id)         AS run_id,
          hex(observations.span_id)        AS span_id,
          hex(observations.parent_span_id) AS parent_span_id,
          toUnixTimestamp64Milli(start_time) AS start_time_ms,
          toUnixTimestamp64Milli(end_time)   AS end_time_ms,
          gen_ai_operation,
          gen_ai_request_model,
          gen_ai_system,
          status,
          source_dialect,
          is_run_root,
          run_name,
          gen_ai_usage_input_tokens  AS input_tokens,
          gen_ai_usage_output_tokens AS output_tokens,
          attributes
        FROM halley.observations
        WHERE hex(observations.run_id) = {runId: String}
        ORDER BY start_time ASC
      `,
      query_params: { runId: runId.toUpperCase() },
      format: "JSONEachRow",
    });

    const rows = await result.json<RawRow>();
    return rows.map((r) => ({
      run_id:               r.run_id,
      span_id:              r.span_id,
      parent_span_id:       r.parent_span_id,
      start_time_ms:        parseInt(r.start_time_ms, 10) || 0,
      end_time_ms:          parseInt(r.end_time_ms,   10) || 0,
      gen_ai_operation:     r.gen_ai_operation,
      gen_ai_request_model: r.gen_ai_request_model,
      gen_ai_system:        r.gen_ai_system,
      status:               r.status,
      source_dialect:       r.source_dialect,
      is_run_root:
        r.is_run_root === true || r.is_run_root === "true" || r.is_run_root === 1,
      run_name:       r.run_name ?? "",
      input_tokens:   parseInt(r.input_tokens,  10) || 0,
      output_tokens:  parseInt(r.output_tokens, 10) || 0,
      attributes:     r.attributes ?? {},
    }));
  } finally {
    await ch.close();
  }
}
