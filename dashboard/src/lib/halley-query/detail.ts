/**
 * halley-query/detail.ts
 *
 * getRunDetail(runId) — fetches all spans for a single run (one observations
 * query + the shared pricing query), computes per-span cost, and derives a
 * RunSummary from the spans in JS to avoid a second GROUP BY round-trip.
 *
 * D-12: all ClickHouse queries live here, not in page files.
 * D-11: server-side only (no "use client").
 *
 * Schema notes (ARCHITECTURE §4.1):
 *   - run_id / trace_id are FixedString(16) — hex() → 32-char uppercase string.
 *   - span_id / parent_span_id are FixedString(8) — hex() → 16-char uppercase string.
 *   - parent_span_id of a root span is all zero bytes → "0000000000000000".
 *   - is_run_root is Bool — JSON true/false in JSONEachRow.
 *   - attributes is Map(String,String) — JSON object in JSONEachRow.
 *   - start_time / end_time are DateTime64(9,'UTC').
 *   - toUnixTimestamp64Milli() gives ms-precision Int64 (returned as string).
 */

import { getClickHouseClient } from "@/lib/clickhouse";
import { fetchPricingMap, computeRunCost, formatCost } from "./pricing";
import type { RunSummary } from "./runs";

/** 8 zero bytes expressed as hex — the OTLP sentinel for "no parent span". */
export const ROOT_PARENT_ID = "0000000000000000";

export interface SpanSummary {
  /** Uppercase hex, 16 chars (8 bytes). */
  span_id: string;
  /** Uppercase hex, 16 chars. ROOT_PARENT_ID means this span has no parent. */
  parent_span_id: string;
  /** Unix epoch milliseconds — used for timeline bar math. */
  start_time_ms: number;
  end_time_ms: number;
  /** Second-precision ISO string for human display. */
  start_time_iso: string;
  duration_ms: number;
  gen_ai_system: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  input_tokens: number;
  output_tokens: number;
  status: string;
  source_dialect: string;
  is_run_root: boolean;
  cost_dollars: number;
  cost_display: string;
  /** Full attributes map — passed to the Day 4 span inspector. */
  attributes: Record<string, string>;
  /** Denormalized; same value on every row for a given run. */
  run_name: string;
}

export interface RunDetail {
  run: RunSummary;
  spans: SpanSummary[];
}

/** ClickHouse JSONEachRow shape before JS type coercion. */
interface RawRow {
  span_id: string;
  parent_span_id: string;
  /** Int64 from ClickHouse → string in JSONEachRow to avoid JS precision loss. */
  start_time_ms: string;
  end_time_ms: string;
  start_time_iso: string;
  gen_ai_system: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  input_tokens: string;
  output_tokens: string;
  status: string;
  source_dialect: string;
  /** Bool arrives as JSON true/false; guard strings for safety. */
  is_run_root: boolean | string | number;
  run_name: string;
  attributes: Record<string, string>;
}

/**
 * Fetch all spans for a run, compute per-span cost, and derive RunSummary.
 *
 * Returns null when no spans are found (unknown run_id → 404 in the page).
 *
 * @param runId - 32-char uppercase hex string as returned by listRuns().
 */
export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  // Fetch pricing first (its own client, closes itself — pricing.ts).
  const pricingMap = await fetchPricingMap();

  const client = getClickHouseClient();
  try {
    const result = await client.query({
      query: `
        SELECT
          hex(span_id)                                        AS span_id,
          hex(parent_span_id)                                 AS parent_span_id,
          toUnixTimestamp64Milli(start_time)                  AS start_time_ms,
          toUnixTimestamp64Milli(end_time)                    AS end_time_ms,
          formatDateTime(start_time, '%Y-%m-%dT%H:%i:%SZ')   AS start_time_iso,
          gen_ai_system,
          gen_ai_operation,
          gen_ai_request_model,
          gen_ai_usage_input_tokens                           AS input_tokens,
          gen_ai_usage_output_tokens                          AS output_tokens,
          status,
          source_dialect,
          is_run_root,
          run_name,
          attributes
        FROM halley.observations
        WHERE hex(run_id) = {runId: String}
        ORDER BY start_time ASC
      `,
      query_params: { runId: runId.toUpperCase() },
      format: "JSONEachRow",
    });

    const rows = await result.json<RawRow>();
    if (rows.length === 0) return null;

    const spans: SpanSummary[] = rows.map((row) => {
      const startMs     = parseInt(row.start_time_ms, 10) || 0;
      const endMs       = parseInt(row.end_time_ms,   10) || 0;
      const durationMs  = Math.max(0, endMs - startMs);
      const inputTokens  = parseInt(row.input_tokens,  10) || 0;
      const outputTokens = parseInt(row.output_tokens, 10) || 0;
      const cost = computeRunCost(inputTokens, outputTokens, row.gen_ai_request_model, pricingMap);

      // Bool from ClickHouse JSONEachRow: JSON true/false, but guard strings too.
      const isRunRoot =
        row.is_run_root === true ||
        row.is_run_root === "true" ||
        row.is_run_root === 1;

      return {
        span_id:              row.span_id,
        parent_span_id:       row.parent_span_id,
        start_time_ms:        startMs,
        end_time_ms:          endMs,
        start_time_iso:       row.start_time_iso,
        duration_ms:          durationMs,
        gen_ai_system:        row.gen_ai_system,
        gen_ai_operation:     row.gen_ai_operation,
        gen_ai_request_model: row.gen_ai_request_model,
        input_tokens:         inputTokens,
        output_tokens:        outputTokens,
        status:               row.status,
        source_dialect:       row.source_dialect,
        is_run_root:          isRunRoot,
        cost_dollars:         cost,
        cost_display:         formatCost(cost),
        attributes:           row.attributes ?? {},
        run_name:             row.run_name ?? "",
      };
    });

    // Derive RunSummary from spans — avoids a second GROUP BY query.
    const runStartMs  = Math.min(...spans.map((s) => s.start_time_ms));
    const runEndMs    = Math.max(...spans.map((s) => s.end_time_ms));
    const totalInput  = spans.reduce((a, s) => a + s.input_tokens,  0);
    const totalOutput = spans.reduce((a, s) => a + s.output_tokens, 0);
    const totalCost   = spans.reduce((a, s) => a + s.cost_dollars,  0);

    const STATUS_RANK: Record<string, number> = { ok: 1, error: 2, timeout: 3 };
    const worstStatus = spans.reduce(
      (worst, s) =>
        (STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[worst] ?? 0) ? s.status : worst,
      "ok"
    );

    const run: RunSummary = {
      run_id:              runId.toUpperCase(),
      started_at:          new Date(runStartMs).toISOString(),
      ended_at:            new Date(runEndMs).toISOString(),
      run_name:            spans.find((s) => s.run_name)?.run_name ?? "",
      span_count:          spans.length,
      total_input_tokens:  totalInput,
      total_output_tokens: totalOutput,
      top_model:           spans[0]?.gen_ai_request_model ?? "",
      top_dialect:         spans[0]?.source_dialect ?? "",
      has_root:            spans.some((s) => s.is_run_root),
      worst_status:        worstStatus,
      cost_dollars:        totalCost,
      cost_display:        formatCost(totalCost),
    };

    return { run, spans };
  } finally {
    await client.close();
  }
}

// ── getSpanDetail ──────────────────────────────────────────────────────────

/**
 * SpanDetail — full data for one observation, including fetched body content.
 * Returned by getSpanDetail(); consumed by the Day 4 span inspector.
 *
 * Schema ref (ARCHITECTURE §4.1 + migrations):
 *   - body hashes: Nullable(FixedString(32)) → 64-char uppercase hex or "".
 *   - parent_span_id: Nullable(FixedString(8)) → ifNull → "" for root spans.
 *   - observation_body.body_hash: FixedString(32) raw bytes (pitfall #6).
 *     Body fetch query uses WHERE hex(body_hash) = $1 with uppercase hex.
 */
export interface SpanDetail {
  span_id: string;        // uppercase hex, 16 chars
  trace_id: string;       // uppercase hex, 32 chars
  parent_span_id: string; // uppercase hex, 16 chars, or "" for root
  run_id: string;         // uppercase hex, 32 chars

  start_time_iso: string;
  end_time_iso: string;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;

  source_dialect: string;
  gen_ai_system: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  gen_ai_response_model: string;
  gen_ai_response_finish_reason: string;
  input_tokens: number;
  output_tokens: number;

  tool_name: string;
  tool_side_effect: string;

  status: string;
  error_message: string;
  is_run_root: boolean;
  run_name: string;

  cost_dollars: number;
  cost_display: string;

  /** Empty string when the column is NULL in the DB. */
  input_body_hash: string;
  output_body_hash: string;
  tool_input_hash: string;
  tool_output_hash: string;

  /** null = hash absent OR body not found in observation_body (may have expired). */
  input_body: string | null;
  output_body: string | null;
  tool_input_body: string | null;
  tool_output_body: string | null;

  attributes: Record<string, string>;
}

/** JSONEachRow shape for the single-row observation query in getSpanDetail. */
interface RawObsRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string;
  run_id: string;
  start_time_iso: string;
  end_time_iso: string;
  start_time_ms: string;
  end_time_ms: string;
  source_dialect: string;
  gen_ai_system: string;
  gen_ai_operation: string;
  gen_ai_request_model: string;
  gen_ai_response_model: string;
  gen_ai_response_finish_reason: string;
  input_tokens: string;
  output_tokens: string;
  tool_name: string;
  tool_side_effect: string;
  status: string;
  error_message: string;
  is_run_root: boolean | string | number;
  run_name: string;
  input_body_hash: string;
  output_body_hash: string;
  tool_input_hash: string;
  tool_output_hash: string;
  attributes: Record<string, string>;
}

/**
 * Fetch the full observation row for one span, then fetch its body content
 * from halley.observation_body using the stored hashes.
 *
 * Two DB round-trips:
 *   1. SELECT from halley.observations WHERE run_id + span_id
 *   2. SELECT from halley.observation_body WHERE body_hash IN (up to 4 hashes)
 *
 * Returns null when the span_id + run_id combination doesn't exist.
 *
 * Pitfall (#6 in plan): body_hash is raw bytes (FixedString(32)).
 * Use WHERE hex(body_hash) = {h} with uppercase hex from JS.
 *
 * @param runId  - 32-char uppercase hex (page URL params.id)
 * @param spanId - 16-char uppercase hex (URL ?span= query param)
 */
export async function getSpanDetail(
  runId: string,
  spanId: string
): Promise<SpanDetail | null> {
  const pricingMap = await fetchPricingMap();
  const client = getClickHouseClient();

  try {
    // ── Query 1: fetch the observation row ──────────────────────────────────
    const obsResult = await client.query({
      query: `
        SELECT
          hex(span_id)                                        AS span_id,
          hex(trace_id)                                       AS trace_id,
          ifNull(hex(parent_span_id), '')                     AS parent_span_id,
          hex(run_id)                                         AS run_id,
          formatDateTime(start_time, '%Y-%m-%dT%H:%i:%SZ')   AS start_time_iso,
          formatDateTime(end_time,   '%Y-%m-%dT%H:%i:%SZ')   AS end_time_iso,
          toUnixTimestamp64Milli(start_time)                  AS start_time_ms,
          toUnixTimestamp64Milli(end_time)                    AS end_time_ms,
          source_dialect,
          gen_ai_system,
          gen_ai_operation,
          gen_ai_request_model,
          gen_ai_response_model,
          gen_ai_response_finish_reason,
          gen_ai_usage_input_tokens                           AS input_tokens,
          gen_ai_usage_output_tokens                          AS output_tokens,
          tool_name,
          tool_side_effect,
          status,
          error_message,
          is_run_root,
          run_name,
          ifNull(hex(input_body_hash),  '')                   AS input_body_hash,
          ifNull(hex(output_body_hash), '')                   AS output_body_hash,
          ifNull(hex(tool_input_hash),  '')                   AS tool_input_hash,
          ifNull(hex(tool_output_hash), '')                   AS tool_output_hash,
          attributes
        FROM halley.observations
        WHERE hex(run_id)  = {runId:  String}
          AND hex(span_id) = {spanId: String}
        LIMIT 1
      `,
      query_params: {
        runId:  runId.toUpperCase(),
        spanId: spanId.toUpperCase(),
      },
      format: "JSONEachRow",
    });

    const obsRows = await obsResult.json<RawObsRow>();
    if (obsRows.length === 0) return null;
    const row = obsRows[0];

    const startMs      = parseInt(row.start_time_ms, 10) || 0;
    const endMs        = parseInt(row.end_time_ms,   10) || 0;
    const inputTokens  = parseInt(row.input_tokens,  10) || 0;
    const outputTokens = parseInt(row.output_tokens, 10) || 0;
    const cost = computeRunCost(inputTokens, outputTokens, row.gen_ai_request_model, pricingMap);
    const isRunRoot =
      row.is_run_root === true ||
      row.is_run_root === "true" ||
      row.is_run_root === 1;

    // ── Query 2: fetch body content for all non-empty hashes ────────────────
    // Fixed 4-param IN clause; empty strings never match a real 64-char hash.
    const hashes = [
      row.input_body_hash,
      row.output_body_hash,
      row.tool_input_hash,
      row.tool_output_hash,
    ].filter((h) => h.length > 0);

    const bodyMap = new Map<string, string>();

    if (hashes.length > 0) {
      const bodyResult = await client.query({
        query: `
          SELECT hex(body_hash) AS body_hash, body
          FROM halley.observation_body
          WHERE hex(body_hash) IN ({h0: String}, {h1: String}, {h2: String}, {h3: String})
        `,
        // Slots beyond hashes.length get '' — never matches a real hash.
        query_params: {
          h0: hashes[0] ?? "",
          h1: hashes[1] ?? "",
          h2: hashes[2] ?? "",
          h3: hashes[3] ?? "",
        },
        format: "JSONEachRow",
      });

      const bodyRows = await bodyResult.json<{ body_hash: string; body: string }>();
      for (const br of bodyRows) {
        bodyMap.set(br.body_hash, br.body);
      }
    }

    return {
      span_id:                       row.span_id,
      trace_id:                      row.trace_id,
      parent_span_id:                row.parent_span_id,
      run_id:                        row.run_id,
      start_time_iso:                row.start_time_iso,
      end_time_iso:                  row.end_time_iso,
      start_time_ms:                 startMs,
      end_time_ms:                   endMs,
      duration_ms:                   Math.max(0, endMs - startMs),
      source_dialect:                row.source_dialect,
      gen_ai_system:                 row.gen_ai_system,
      gen_ai_operation:              row.gen_ai_operation,
      gen_ai_request_model:          row.gen_ai_request_model,
      gen_ai_response_model:         row.gen_ai_response_model,
      gen_ai_response_finish_reason: row.gen_ai_response_finish_reason,
      input_tokens:                  inputTokens,
      output_tokens:                 outputTokens,
      tool_name:                     row.tool_name,
      tool_side_effect:              row.tool_side_effect,
      status:                        row.status,
      error_message:                 row.error_message,
      is_run_root:                   isRunRoot,
      run_name:                      row.run_name,
      cost_dollars:                  cost,
      cost_display:                  formatCost(cost),
      input_body_hash:               row.input_body_hash,
      output_body_hash:              row.output_body_hash,
      tool_input_hash:               row.tool_input_hash,
      tool_output_hash:              row.tool_output_hash,
      input_body:      row.input_body_hash    ? (bodyMap.get(row.input_body_hash)    ?? null) : null,
      output_body:     row.output_body_hash   ? (bodyMap.get(row.output_body_hash)   ?? null) : null,
      tool_input_body: row.tool_input_hash    ? (bodyMap.get(row.tool_input_hash)    ?? null) : null,
      tool_output_body:row.tool_output_hash   ? (bodyMap.get(row.tool_output_hash)   ?? null) : null,
      attributes:                    row.attributes ?? {},
    };
  } finally {
    await client.close();
  }
}
