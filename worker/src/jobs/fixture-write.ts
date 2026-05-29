/**
 * fixture-write.ts — BullMQ job: write a saved fixture to the target repo.
 *
 * Job payload: { fixture_id: string }
 *
 * Steps:
 *  1. Load fixture row from Postgres (invariants_json, source_run_id, repo_path).
 *  2. Load ordered observations for the run from ClickHouse.
 *  3. Load all input + output bodies from observation_body (content-addressed,
 *     deduplicated by the stored SHA-256 hash — D22 reused, not re-computed).
 *  4. Write body files: <repo>/halley/fixtures/<slug>/bodies/sha256-<hash>.json
 *     — skip if the file already exists (idempotent on re-write).
 *  5. Write the fixture index: <repo>/halley/fixtures/<slug>.json
 *     — fixture format v1 (LOCKED CONTRACT — see docs/fixture-format.md + D52).
 *  6. Update fixtures: status='ready', repo_path=<actual path>.
 *
 * D-12: ClickHouse only through query modules.
 * D-18: queue name "fixture.write", prefix "halley:worker" (isolated from ingester).
 * D-50: table-qualified WHERE in ClickHouse queries.
 * D-21: worker rebuilt today (new job registered).
 */

import fs   from "fs";
import path from "path";
import type { Job } from "bullmq";

import { getPool }               from "../connections.js";
import { loadRunObservations }   from "../query/observations.js";
import { loadBodies }            from "../query/bodies.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface FixtureWriteJobData {
  fixture_id: string;
}

// Matches the on-disk fixture format v1 (LOCKED — see docs/fixture-format.md).
// Changing these field names is a breaking change for users who have committed
// fixture files. fixture_format_version enables future migration tooling.

interface ObservationEntry {
  /** 0-based position in the ordered span list (execution order). */
  index:             number;
  span_id:           string;
  parent_span_id:    string;
  operation:         string;
  model:             string;
  system:            string;
  status:            string;
  started_at_ms:     number;
  ended_at_ms:       number;
  duration_ms:       number;
  input_tokens:      number;
  output_tokens:     number;
  /**
   * D22: canonical-JSON SHA-256 of the input body (request).
   * This is the v1 replay match_key — the matcher (Week 10) compares the
   * incoming request's canonical hash against this value to identify the
   * recorded span whose response should be served.
   */
  match_key:         string;
  /** Relative path to the input body file, or null when no body was captured. */
  input_body_ref:    string | null;
  /** Relative path to the output body file, or null when no body was captured. */
  output_body_ref:   string | null;
}

interface FixtureV1 {
  fixture_format_version: 1;
  fixture_id:    string;
  source_run_id: string;
  run_name:      string;
  started_at_ms: number;
  dialect:       string;
  top_model:     string;
  written_at:    string; // ISO 8601 UTC
  observations:  ObservationEntry[];
  invariants:    unknown; // Full invariants_json as edited by user
  replay_matching: {
    /**
     * v1 matching strategy: compare the D22 canonical-JSON SHA-256 hash of
     * the incoming request body against each observation's match_key.
     * The matcher is implemented in Week 10 (cli/replay shim).
     * match_key = input_body_hash = hex(SHA-256(canonical_json(request_body)))
     */
    strategy:    "input_body_hash_v1";
    description: string;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const REPO_PATH =
  process.env.HALLEY_FIXTURE_REPO_PATH ??
  path.resolve(process.cwd(), "../../examples/replay-target");

function bodyRef(hash: string, slugDir: string): string {
  return path.join(slugDir, "bodies", `sha256-${hash.toLowerCase()}.json`);
}

function relRef(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Job processor ──────────────────────────────────────────────────────────

export async function processFixtureWrite(
  job: Job<FixtureWriteJobData>
): Promise<void> {
  const { fixture_id } = job.data;
  console.log(`[fixture.write] start  fixture_id=${fixture_id}`);

  // 1. Load fixture row from Postgres ─────────────────────────────────────
  const pool = getPool();
  let sourceRunId: string;
  let invariantsJson: unknown;
  let slugFromPath: string;

  {
    const res = await pool.query<{
      source_run_id:   string;
      invariants_json: unknown;
      repo_path:       string;
    }>(
      `SELECT source_run_id, invariants_json, repo_path
         FROM fixtures
        WHERE id = $1`,
      [fixture_id]
    );
    if (!res.rows[0]) {
      throw new Error(`fixture not found: ${fixture_id}`);
    }
    sourceRunId   = res.rows[0].source_run_id;
    invariantsJson = res.rows[0].invariants_json;
    // slug = last path segment of the placeholder repo_path set in Day 2
    // e.g. "halley/fixtures/test-run-day3" → "test-run-day3"
    slugFromPath = path.basename(res.rows[0].repo_path);
  }

  // 2. Load observations ────────────────────────────────────────────────────
  const observations = await loadRunObservations(sourceRunId);
  if (observations.length === 0) {
    throw new Error(
      `no observations found for run_id=${sourceRunId} — cannot write fixture`
    );
  }

  const runName   = observations[0].run_name   ?? "";
  const dialect   = observations[0].source_dialect ?? "";
  const topModel  = observations
    .map((o) => o.gen_ai_request_model)
    .find((m) => m.length > 0) ?? "";
  const startedAt = observations[0].start_time_ms;

  // 3. Load all bodies (input + output) ─────────────────────────────────────
  const allHashes = [
    ...observations.map((o) => o.input_body_hash),
    ...observations.map((o) => o.output_body_hash),
  ].filter((h) => h.length > 0);

  const bodyMap = await loadBodies(allHashes);
  console.log(
    `[fixture.write] loaded ${bodyMap.size} bodies for ${allHashes.length} hashes`
  );

  // 4. Write body files ─────────────────────────────────────────────────────
  const slug    = slugFromPath;
  const slugDir = path.join(REPO_PATH, "halley", "fixtures", slug);
  const bodiesDir = path.join(slugDir, "bodies");
  ensureDir(bodiesDir);

  let bodiesWritten = 0;
  let bodiesSkipped = 0;

  for (const [hash, bodyText] of bodyMap.entries()) {
    const filePath = bodyRef(hash, slugDir);
    if (fs.existsSync(filePath)) {
      bodiesSkipped++;
      continue; // idempotent — body already written
    }
    // Validate JSON before writing so we never write malformed files.
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Body text is not JSON (edge case: tool text outputs). Store as-is
      // wrapped in a JSON string to stay within the .json file convention.
      parsed = { raw_text: bodyText };
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify(parsed, null, 2),
      { encoding: "utf8" }
    );
    bodiesWritten++;
  }

  console.log(
    `[fixture.write] bodies: written=${bodiesWritten} skipped=${bodiesSkipped}`
  );

  // 5. Build fixture index ───────────────────────────────────────────────────
  const observationEntries: ObservationEntry[] = observations.map((o, i) => {
    const inputRef  = o.input_body_hash  ? relRef(bodyRef(o.input_body_hash,  slugDir), REPO_PATH) : null;
    const outputRef = o.output_body_hash ? relRef(bodyRef(o.output_body_hash, slugDir), REPO_PATH) : null;

    return {
      index:          i,
      span_id:        o.span_id,
      parent_span_id: o.parent_span_id,
      operation:      o.gen_ai_operation,
      model:          o.gen_ai_request_model,
      system:         o.gen_ai_system,
      status:         o.status,
      started_at_ms:  o.start_time_ms,
      ended_at_ms:    o.end_time_ms,
      duration_ms:    o.end_time_ms - o.start_time_ms,
      input_tokens:   o.input_tokens,
      output_tokens:  o.output_tokens,
      match_key:      o.input_body_hash.toLowerCase(),  // D22 canonical-JSON SHA-256 (lowercase hex)
      input_body_ref:  inputRef,
      output_body_ref: outputRef,
    };
  });

  const fixture: FixtureV1 = {
    fixture_format_version: 1,
    fixture_id,
    source_run_id:  sourceRunId,
    run_name:       runName,
    started_at_ms:  startedAt,
    dialect,
    top_model:      topModel,
    written_at:     new Date().toISOString(),
    observations:   observationEntries,
    invariants:     invariantsJson,
    replay_matching: {
      strategy:    "input_body_hash_v1",
      description:
        "Match incoming replay requests by comparing the D22 canonical-JSON " +
        "SHA-256 of the request body against each observation's match_key. " +
        "The matcher (Week 10 cli/shim) looks up the matching observation and " +
        "serves its recorded output_body_ref. match_key = " +
        "hex(SHA-256(canonical_json(input_body))).",
    },
  };

  const fixtureFilePath = path.join(REPO_PATH, "halley", "fixtures", `${slug}.json`);
  ensureDir(path.join(REPO_PATH, "halley", "fixtures"));
  fs.writeFileSync(fixtureFilePath, JSON.stringify(fixture, null, 2), {
    encoding: "utf8",
  });

  console.log(`[fixture.write] wrote ${fixtureFilePath}`);

  // 6. Update Postgres: status → 'ready', repo_path → actual relative path ──
  const actualRepoPath = relRef(fixtureFilePath, REPO_PATH);
  await pool.query(
    `UPDATE fixtures
        SET status    = 'ready',
            repo_path = $2
      WHERE id = $1`,
    [fixture_id, actualRepoPath]
  );

  console.log(
    `[fixture.write] done  fixture_id=${fixture_id}  repo_path=${actualRepoPath}`
  );
}
