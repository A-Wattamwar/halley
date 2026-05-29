/**
 * jobs/invariant-infer.ts — `invariant.infer` BullMQ job processor.
 *
 * Input: { fixture_id: string, run_id: string }
 *   fixture_id — UUID of the fixtures row to update (targeted by id, not source_run_id,
 *                because source_run_id is not unique per the Day 2 review note).
 *   run_id     — 32-char uppercase hex run_id (used to load observations).
 *
 * Writes proposed invariants to fixtures.invariants_json (status stays 'proposing').
 *
 * ── Structural invariants ────────────────────────────────────────────────────
 *   - span_count:         exact number of spans in the run
 *   - operation_sequence: gen_ai_operation values ordered by start_time ASC
 *   - required_operations: deduplicated set of operation values
 *   - parent_index:       positional parent pointer per span (replay-stable —
 *                         no concrete span_ids stored; null = root).
 *
 * ── Schema invariants ────────────────────────────────────────────────────────
 *   - per_span: one entry per span (aligned to operation_sequence order).
 *     Each entry is null (no/non-JSON body) or { op, key_types, required_keys }.
 *     key_types maps every observed key-path → leaf JSON type.
 *     required_keys = all observed key-paths (from a single recording, all are "seen").
 *
 * ── Metric invariants ────────────────────────────────────────────────────────
 *   All ceilings = recorded value × METRIC_HEADROOM_FACTOR (default 1.20).
 *   - cost_max_usd:       total run cost + headroom (same formula as dashboard, D42)
 *   - latency_max_ms:     run wall-clock duration + headroom
 *   - span_count:         exact (same as structural)
 *   - input_tokens_max:   total input tokens + headroom
 *   - output_tokens_max:  total output tokens + headroom
 *
 * ── Semantic invariant ───────────────────────────────────────────────────────
 *   Proposed but DISABLED. No LLM call today. Runner is Phase 6.
 *
 * JSON shape in fixtures.invariants_json:
 *   {
 *     "structural": { span_count, operation_sequence, required_operations, parent_index },
 *     "schema":     { "per_span": [ { "op", "key_types", "required_keys" } | null, ... ] },
 *     "metric":     { cost_max_usd, latency_max_ms, span_count, input_tokens_max, output_tokens_max },
 *     "semantic":   { "enabled": false, "judge_model": null, "rubric": null }
 *   }
 *
 * Day 2 note: UPDATE targets by fixture id (not source_run_id) so concurrent
 * fixtures for the same run don't clobber each other.
 */

import type { Job } from "bullmq";
import { loadRunObservations } from "../query/observations.js";
import { loadBodies } from "../query/bodies.js";
import { fetchPricingMap, computeSpanCost } from "../query/pricing.js";
import { getPool } from "../connections.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** All metric ceilings = recorded value × METRIC_HEADROOM_FACTOR. */
const METRIC_HEADROOM_FACTOR = 1.2;

/** OTLP zero-byte parent sentinel (8 zero bytes as hex). */
const ROOT_PARENT_ID = "0000000000000000";

// ── Job types ─────────────────────────────────────────────────────────────────

export interface InvariantInferJobData {
  /** UUID of the fixtures row to update. Targeted by id (not source_run_id). */
  fixture_id: string;
  /** 32-char uppercase hex run_id used to load observations. */
  run_id: string;
}

// ── Structural ────────────────────────────────────────────────────────────────

export interface StructuralInvariants {
  span_count: number;
  operation_sequence: string[];
  required_operations: string[];
  /**
   * Positional parent pointer for each span (aligned to operation_sequence).
   * null  = root span.
   * number = 0-based index of parent span in the same ordered list.
   * Replay-stable: no concrete span_ids stored (span_ids differ each execution).
   */
  parent_index: Array<number | null>;
}

// ── Schema ────────────────────────────────────────────────────────────────────

type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

export interface SpanSchemaEntry {
  op: string;
  /** Map of observed key-path → leaf JSON type in the output body. */
  key_types: Record<string, JsonType>;
  /** All key-paths observed in the recording (from a single run = all required). */
  required_keys: string[];
}

export interface SchemaInvariants {
  /** One entry per span aligned to operation_sequence. null = no/non-JSON body. */
  per_span: Array<SpanSchemaEntry | null>;
}

// ── Metric ────────────────────────────────────────────────────────────────────

export interface MetricInvariants {
  /** Total run cost (USD) + headroom. Same pricing formula as the dashboard (D42). */
  cost_max_usd: number;
  /** Run wall-clock duration (ms) + headroom. */
  latency_max_ms: number;
  /** Exact span count (same as structural). */
  span_count: number;
  /** Total input tokens across the run + headroom. */
  input_tokens_max: number;
  /** Total output tokens across the run + headroom. */
  output_tokens_max: number;
}

// ── Semantic ──────────────────────────────────────────────────────────────────

export interface SemanticInvariant {
  /** Always false on Day 2 — runner is Phase 6. No LLM call. */
  enabled: false;
  judge_model: null;
  rubric: null;
}

// ── Root type ─────────────────────────────────────────────────────────────────

export interface InvariantsJson {
  structural: StructuralInvariants;
  schema:     SchemaInvariants;
  metric:     MetricInvariants;
  semantic:   SemanticInvariant;
}

// ── Schema inference helpers ──────────────────────────────────────────────────

/**
 * Walk an arbitrary JSON value and record every key-path → leaf type.
 * Arrays are noted at their path with type "array"; their first element
 * is descended with a "[]" suffix. Empty objects and null are also recorded.
 */
function collectKeyPaths(
  value: unknown,
  prefix: string,
  out: Record<string, JsonType>
): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = "null";
    return;
  }
  if (typeof value === "string")  { if (prefix) out[prefix] = "string";  return; }
  if (typeof value === "number")  { if (prefix) out[prefix] = "number";  return; }
  if (typeof value === "boolean") { if (prefix) out[prefix] = "boolean"; return; }

  if (Array.isArray(value)) {
    if (prefix) out[prefix] = "array";
    if (value.length > 0) {
      collectKeyPaths(value[0], prefix ? `${prefix}[]` : "[]", out);
    }
    return;
  }

  // Plain object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    if (prefix) out[prefix] = "object"; // empty object — treat as leaf
    return;
  }
  for (const key of keys) {
    collectKeyPaths(obj[key], prefix ? `${prefix}.${key}` : key, out);
  }
}

/**
 * Infer a SpanSchemaEntry from a body JSON string.
 * Returns null if body is empty, not valid JSON, or not an object/array at root.
 */
function inferSchema(op: string, bodyJson: string | null | undefined): SpanSchemaEntry | null {
  if (!bodyJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return null; // non-JSON body — record null per spec
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const keyTypes: Record<string, JsonType> = {};
  collectKeyPaths(parsed, "", keyTypes);

  return {
    op,
    key_types:     keyTypes,
    required_keys: Object.keys(keyTypes),
  };
}

// ── Job processor ─────────────────────────────────────────────────────────────

export async function processInvariantInfer(
  job: Job<InvariantInferJobData>
): Promise<void> {
  const { fixture_id, run_id } = job.data;
  console.log(`[invariant.infer] start  fixture_id=${fixture_id}  run_id=${run_id}`);

  // ── 1. Load observations ──────────────────────────────────────────────────
  const observations = await loadRunObservations(run_id);
  if (observations.length === 0) {
    throw new Error(`No observations found for run_id=${run_id}`);
  }

  // ── 2. Load output bodies for schema inference ────────────────────────────
  const outputHashes = observations.map((o) => o.output_body_hash);
  const bodyMap = await loadBodies(outputHashes);

  // ── 3. Load pricing for metric cost computation ───────────────────────────
  const pricingMap = await fetchPricingMap();

  // ── 4. Structural invariants ───────────────────────────────────────────────
  const operationSequence  = observations.map((o) => o.gen_ai_operation);
  const requiredOperations = [...new Set(operationSequence)].sort();

  const spanIndexMap = new Map<string, number>();
  observations.forEach((o, i) => spanIndexMap.set(o.span_id, i));

  const parentIndex: Array<number | null> = observations.map((o) => {
    const p = o.parent_span_id;
    if (p == null || p === ROOT_PARENT_ID) return null;
    const idx = spanIndexMap.get(p);
    return idx !== undefined ? idx : null;
  });

  const structural: StructuralInvariants = {
    span_count:          observations.length,
    operation_sequence:  operationSequence,
    required_operations: requiredOperations,
    parent_index:        parentIndex,
  };

  // ── 5. Schema invariants ───────────────────────────────────────────────────
  const perSpan: Array<SpanSchemaEntry | null> = observations.map((o) => {
    const body = o.output_body_hash ? bodyMap.get(o.output_body_hash) : undefined;
    return inferSchema(o.gen_ai_operation, body ?? null);
  });

  const schema: SchemaInvariants = { per_span: perSpan };

  // ── 6. Metric invariants ───────────────────────────────────────────────────
  const startTimes = observations.map((o) => o.start_time_ms);
  const endTimes   = observations.map((o) => o.end_time_ms);
  const minStart   = Math.min(...startTimes);
  const maxEnd     = Math.max(...endTimes);
  const wallClockMs = Math.max(0, maxEnd - minStart);

  const totalInputTokens  = observations.reduce((s, o) => s + o.input_tokens,  0);
  const totalOutputTokens = observations.reduce((s, o) => s + o.output_tokens, 0);

  const totalCost = observations.reduce(
    (s, o) => s + computeSpanCost(o.input_tokens, o.output_tokens, o.gen_ai_request_model, pricingMap),
    0
  );

  const metric: MetricInvariants = {
    cost_max_usd:       Math.round(totalCost * METRIC_HEADROOM_FACTOR * 1e8) / 1e8,
    latency_max_ms:     Math.round(wallClockMs * METRIC_HEADROOM_FACTOR),
    span_count:         observations.length,
    input_tokens_max:   Math.ceil(totalInputTokens  * METRIC_HEADROOM_FACTOR),
    output_tokens_max:  Math.ceil(totalOutputTokens * METRIC_HEADROOM_FACTOR),
  };

  // ── 7. Semantic invariant stub (proposed, disabled) ────────────────────────
  const semantic: SemanticInvariant = {
    enabled:     false,
    judge_model: null,
    rubric:      null,
  };

  const invariantsJson: InvariantsJson = { structural, schema, metric, semantic };

  console.log(
    `[invariant.infer] structural: span_count=${structural.span_count}, ` +
    `ops=[${structural.operation_sequence.join(",")}], ` +
    `parent_index=[${structural.parent_index.join(",")}]`
  );
  console.log(
    `[invariant.infer] metric: cost_max_usd=${metric.cost_max_usd}, ` +
    `latency_max_ms=${metric.latency_max_ms}, ` +
    `input_tokens_max=${metric.input_tokens_max}, ` +
    `output_tokens_max=${metric.output_tokens_max}`
  );

  // ── 8. Write to fixtures row (targeted by fixture id) ─────────────────────
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE fixtures
        SET invariants_json = $1::jsonb
      WHERE id = $2
      RETURNING id`,
    [JSON.stringify(invariantsJson), fixture_id]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `No fixtures row found for fixture_id=${fixture_id}. ` +
      `Ensure the row was inserted before enqueueing.`
    );
  }

  console.log(`[invariant.infer] wrote invariants_json fixture_id=${fixture_id}`);
}
