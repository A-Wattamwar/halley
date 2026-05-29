/**
 * jobs/invariant-infer.ts — `invariant.infer` BullMQ job processor.
 *
 * Input: { run_id: string }  (32-char uppercase hex run_id)
 *
 * Loads the run's observations from ClickHouse, proposes STRUCTURAL invariants,
 * and writes them to the corresponding fixtures row in Postgres
 * (fixtures.invariants_json). The status column stays 'proposing'.
 *
 * Structural invariants proposed today (Day 1):
 *   - span_count:         exact number of spans in the run
 *   - operation_sequence: ordered list of gen_ai_operation values (start_time ASC)
 *   - required_operations: deduplicated set of operation values present
 *   - parent_index:       positional parent pointer per span, aligned to
 *                         operation_sequence order. Value = index of parent span
 *                         in the same ordered list, or null for roots.
 *                         Encodes tree SHAPE without storing concrete span_ids,
 *                         so it survives replay (new span_ids each execution).
 *
 * Root detection covers all three encodings:
 *   - halley-raw: parent_span_id is null in ClickHouse → null in JSON
 *   - OTLP: parent_span_id is zero-bytes → "0000000000000000" hex
 *   - Orphaned span: parent_span_id not present in the current run → treat as root
 *
 * JSON shape:
 *   {
 *     "structural": {
 *       "span_count": <number>,
 *       "operation_sequence": [<string>, ...],
 *       "required_operations": [<string>, ...],
 *       "parent_index": [null, 0, 1, ...]  // null = root; N = index of parent span
 *     },
 *     "schema":  null,
 *     "metric":  null,
 *     "semantic": null
 *   }
 *
 * Day 2 fills schema + metric without reshaping this top-level structure.
 * Day 2 note: the UPDATE WHERE source_run_id targets all fixtures for a run;
 * "Turn into test" (Day 2) should target by fixture id to be precise.
 */

import type { Job } from "bullmq";
import { loadRunObservations } from "../query/observations.js";
import { getPool } from "../connections.js";

export const ROOT_PARENT_ID = "0000000000000000";

export interface InvariantInferJobData {
  run_id: string;
}

export interface StructuralInvariants {
  span_count: number;
  operation_sequence: string[];
  required_operations: string[];
  /**
   * Positional parent pointer for each span (aligned to operation_sequence order).
   * null  → root span (no parent within this run)
   * number → 0-based index of the parent span in operation_sequence / parent_index
   *
   * Does NOT store concrete span_ids — replay produces fresh ids each run,
   * so only the tree shape (position) is stable across executions.
   */
  parent_index: Array<number | null>;
}

export interface InvariantsJson {
  structural: StructuralInvariants;
  schema: null;
  metric: null;
  semantic: null;
}

export async function processInvariantInfer(
  job: Job<InvariantInferJobData>
): Promise<void> {
  const { run_id } = job.data;
  console.log(`[invariant.infer] start  run_id=${run_id}`);

  // ── 1. Load observations ────────────────────────────────────────────────────
  const observations = await loadRunObservations(run_id);
  if (observations.length === 0) {
    throw new Error(`No observations found for run_id=${run_id}`);
  }

  // ── 2. Propose structural invariants ────────────────────────────────────────
  const operationSequence = observations.map((o) => o.gen_ai_operation);
  const requiredOperations = [...new Set(operationSequence)].sort();

  // Build span_id → ordered-index map for parent resolution.
  const spanIndexMap = new Map<string, number>();
  observations.forEach((o, i) => spanIndexMap.set(o.span_id, i));

  // Resolve parent_index positionally.
  // A span is root when its parent_span_id is:
  //   - null or undefined (halley-raw stores NULL in ClickHouse)
  //   - ROOT_PARENT_ID "0000000000000000" (OTLP zero-byte sentinel)
  //   - a span_id not present in this run (orphaned — treat as root-like)
  const parentIndex: Array<number | null> = observations.map((o) => {
    const p = o.parent_span_id;
    if (p == null || p === ROOT_PARENT_ID) return null;
    const idx = spanIndexMap.get(p);
    return idx !== undefined ? idx : null; // orphaned → null
  });

  const structural: StructuralInvariants = {
    span_count:         observations.length,
    operation_sequence: operationSequence,
    required_operations: requiredOperations,
    parent_index:       parentIndex,
  };

  const invariantsJson: InvariantsJson = {
    structural,
    schema:   null,
    metric:   null,
    semantic: null,
  };

  console.log(
    `[invariant.infer] proposed structural invariants: span_count=${structural.span_count}, ` +
    `ops=[${structural.operation_sequence.join(",")}], ` +
    `parent_index=[${structural.parent_index.join(",")}]`
  );

  // ── 3. Upsert into fixtures table ───────────────────────────────────────────
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE fixtures
        SET invariants_json = $1::jsonb
      WHERE source_run_id = $2
      RETURNING id`,
    [JSON.stringify(invariantsJson), run_id]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `No fixtures row found for source_run_id=${run_id}. ` +
      `Use the enqueue-infer script to create one first.`
    );
  }

  const fixtureId = result.rows[0].id;
  console.log(`[invariant.infer] wrote invariants_json fixture_id=${fixtureId}`);
}
