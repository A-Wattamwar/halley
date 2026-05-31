/**
 * bisect-run.ts — BullMQ job: binary-search commits to find the first that
 * breaks a fixture.
 *
 * Job payload: { bisect_job_id: string }
 *
 * RUNNER MODEL (D54, Phase 6 Week 11): this is a *repo-touching* job. It runs
 * the `halley bisect` CLI, which checks out old commits of the USER'S agent
 * repo and re-runs the agent at each commit. That can only happen on a host
 * that has the repo, the agent venv, the CLI binary, and the agent's
 * halley.config.json — i.e. the HOST worker, not the Docker worker. The
 * dashboard enqueues; the host runner executes.
 *
 * EXECUTION CONTEXT COMES FROM THE FIXTURE ROW (Day 2), not from env guesses:
 *   - fixtures.target_repo_path -> the git repo to bisect (passed as --repo)
 *   - fixtures.config_path      -> the agent's halley.config.json (top-level --config)
 *   - fixtures.repo_path        -> relative path to the fixture JSON inside the
 *                                  fixture-WRITE target; we derive the slug from
 *                                  its basename. This is NOT the bisect repo.
 *
 * Shared runner discipline (resolveHalleyCli, exec-context load, precondition
 * ladder, copy-paste command) lives in runner-common.ts (Day 3) and is shared
 * with ci-run.ts.
 *
 * HONEST DEGRADATION (D54): if target_repo_path is NULL, the CLI binary is not
 * resolvable, or required env (HALLEY_SDK_PY_PATH) is missing, the job does NOT
 * fall back to a hardcoded /Users/... guess. It records a `needs_runner:` log
 * line containing the EXACT command to run by hand, and marks the row failed.
 *
 * Status note: bisect_jobs.status CHECK is (queued,running,done,failed) — it
 * shipped Week 10 without 'needs_runner'. Rather than expand that CHECK, "needs
 * runner" stays encoded as status='failed' with a "needs_runner:" log prefix
 * (the UI detects the prefix). ci_runs (Day 3) is a new table and DOES have a
 * first-class 'needs_runner' status; the two diverge here intentionally.
 *
 * D-18: queue name "bisect.run", prefix "halley:worker"
 * (isolated from ingester streams).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Job } from "bullmq";
import { getPool } from "../connections.js";
import {
  buildRunnerCommand,
  checkRunnerPreconditions,
  deriveSlug,
  loadFixtureExecContext,
} from "./runner-common.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface BisectRunJobData {
  bisect_job_id: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/** Append a line to the log column of a bisect_jobs row. */
async function appendLog(
  pool: ReturnType<typeof getPool>,
  id: string,
  line: string
): Promise<void> {
  await pool.query(
    `UPDATE bisect_jobs
        SET log = COALESCE(log, '') || $2 || E'\n'
      WHERE id = $1`,
    [id, line]
  );
}

/** Update status (and optionally result_commit + completed_at). */
async function setStatus(
  pool: ReturnType<typeof getPool>,
  id: string,
  status: "running" | "done" | "failed",
  resultCommit?: string
): Promise<void> {
  if (resultCommit) {
    await pool.query(
      `UPDATE bisect_jobs
          SET status        = $2,
              result_commit = $3,
              completed_at  = now()
        WHERE id = $1`,
      [id, status, resultCommit]
    );
  } else {
    await pool.query(
      `UPDATE bisect_jobs
          SET status       = $2,
              completed_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE completed_at END
        WHERE id = $1`,
      [id, status]
    );
  }
}

/**
 * Record an honest needs_runner outcome on a bisect_jobs row: status='failed'
 * (bisect_jobs has no 'needs_runner' status — Day-2 convention) with a
 * "needs_runner:" log prefix and the exact copy-paste command (D54, D-23).
 * Returns the Error for the caller to `throw` so BullMQ marks the job failed.
 */
async function failNeedsRunner(
  pool: ReturnType<typeof getPool>,
  id: string,
  reason: string,
  command: string
): Promise<Error> {
  const msg = `needs_runner: ${reason}`;
  await appendLog(pool, id, `[bisect.run] ${msg}`);
  await appendLog(pool, id, `[bisect.run] run this on a host with a Halley runner:`);
  await appendLog(pool, id, `[bisect.run]   ${command}`);
  await setStatus(pool, id, "failed");
  console.error(`[bisect.run] ${msg} | cmd: ${command}`);
  return new Error(msg);
}

// ── Job processor ──────────────────────────────────────────────────────────

export async function processBisectRun(
  job: Job<BisectRunJobData>
): Promise<void> {
  const { bisect_job_id } = job.data;
  const pool = getPool();

  console.log(`[bisect.run] start  bisect_job_id=${bisect_job_id}`);

  // 1. Load bisect_job row.
  const res = await pool.query<{
    fixture_id: string;
    base_commit: string | null;
    head_commit: string | null;
  }>(
    `SELECT fixture_id, base_commit, head_commit
       FROM bisect_jobs
      WHERE id = $1`,
    [bisect_job_id]
  );
  if (!res.rows[0]) {
    throw new Error(`bisect_job not found: ${bisect_job_id}`);
  }
  const { fixture_id, base_commit } = res.rows[0];

  // 2. Load the fixture's execution context (Day 2 columns; shared loader).
  const fx = await loadFixtureExecContext(pool, fixture_id);
  if (!fx) {
    throw new Error(`fixture not found: ${fixture_id}`);
  }
  const { repo_path, target_repo_path, config_path } = fx;
  const slug = deriveSlug(repo_path);

  await setStatus(pool, bisect_job_id, "running");
  await appendLog(
    pool,
    bisect_job_id,
    `[bisect.run] fixture='${slug}' target_repo_path=${target_repo_path ?? "(null)"} config_path=${config_path ?? "(null)"}`
  );

  const command = buildRunnerCommand("bisect", {
    slug,
    configPath: config_path,
    targetRepoPath: target_repo_path,
    goodRef: base_commit,
  });

  // 3. Preconditions — degrade honestly to needs_runner instead of guessing.
  const pre = await checkRunnerPreconditions(slug, target_repo_path);
  if (!pre.ok) {
    throw await failNeedsRunner(pool, bisect_job_id, pre.reason, command);
  }
  const { targetRepoPath: repoDir, cliPath, sdkPyPath } = pre.env;

  await appendLog(pool, bisect_job_id, `[bisect.run] using CLI: ${cliPath}`);

  // 4. Build the halley command.
  //    Top-level --config MUST precede the subcommand (cli/src/main.rs).
  //    bisect <slug> [--good <ref>] --repo <target_repo_path>
  const args: string[] = [];
  if (config_path) {
    args.push("--config", config_path);
  }
  args.push("bisect", slug);
  if (base_commit) {
    args.push("--good", base_commit);
  }
  args.push("--repo", repoDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HALLEY_SDK_PY_PATH: sdkPyPath,
  };

  await appendLog(pool, bisect_job_id, `[bisect.run] cmd: ${cliPath} ${args.join(" ")}`);

  let stdout = "";
  let stderr = "";
  let exitOk = false;

  try {
    const result = await execFileAsync(cliPath, args, {
      cwd: repoDir,
      env,
      timeout: 300_000, // 5 min max
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitOk = true;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    await appendLog(pool, bisect_job_id, `[bisect.run] CLI error: ${e.message}`);
  }

  const fullLog = [stderr, stdout].filter(Boolean).join("\n");
  await appendLog(pool, bisect_job_id, fullLog);

  // 5. Parse result.
  // The CLI prints a line like:
  //   BISECT_RESULT: <hash> <subject>
  const resultLine = stdout
    .split("\n")
    .find((l) => l.startsWith("BISECT_RESULT:"));

  if (exitOk && resultLine) {
    const resultCommit = resultLine
      .replace("BISECT_RESULT:", "")
      .trim()
      .split(" ")[0];
    await setStatus(pool, bisect_job_id, "done", resultCommit);
    console.log(`[bisect.run] done  result_commit=${resultCommit}`);
  } else {
    await setStatus(pool, bisect_job_id, "failed");
    console.error(`[bisect.run] failed  bisect_job_id=${bisect_job_id}`);
    throw new Error("halley bisect did not return a BISECT_RESULT");
  }
}
