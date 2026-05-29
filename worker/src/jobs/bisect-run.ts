/**
 * bisect-run.ts — BullMQ job: binary-search commits to find the first that
 * breaks a fixture.
 *
 * Job payload: { bisect_job_id: string }
 *
 * This job delegates to the `halley bisect` CLI subprocess on the host.
 * The CLI requires access to the target git repo on disk — for v1 dev the
 * worker uses the repo path stored in the bisect_jobs row (typically the
 * demo repo path set by the UI or API).
 *
 * V1 LIMITATION: the `halley` CLI binary must be accessible at HALLEY_CLI_PATH
 * (or on PATH). The worker container does not ship the Rust binary; in dev the
 * host binary is invoked via an absolute path.  If HALLEY_CLI_PATH is unset or
 * the binary is not found, the job marks itself failed with a descriptive log
 * rather than silently hanging.
 *
 * D-18: queue name "bisect.run", prefix "halley:worker"
 * (isolated from ingester streams).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Job } from "bullmq";
import { getPool } from "../connections.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface BisectRunJobData {
  bisect_job_id: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/** Locate the halley CLI binary. */
function halleyCli(): string | null {
  if (process.env.HALLEY_CLI_PATH) return process.env.HALLEY_CLI_PATH;
  // Common dev location: next to this project.
  const fallbacks = [
    "/Users/a-wattamwar/development/halley/cli/target/release/halley",
    "/usr/local/bin/halley",
  ];
  const fs = require("fs") as typeof import("fs");
  return fallbacks.find((p) => fs.existsSync(p)) ?? null;
}

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
          SET status       = $2,
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

  // 2. Load fixture to get the slug and repo path.
  const fxRes = await pool.query<{
    repo_path: string;
  }>(
    `SELECT repo_path FROM fixtures WHERE id = $1`,
    [fixture_id]
  );
  if (!fxRes.rows[0]) {
    throw new Error(`fixture not found: ${fixture_id}`);
  }
  const repoPath = fxRes.rows[0].repo_path;

  // Derive the demo repo dir from the repo_path.
  // repo_path is relative to HALLEY_FIXTURE_REPO_PATH, or an absolute path.
  // For v1, we look for HALLEY_BISECT_REPO_PATH env or derive from repo_path.
  const bisectRepoDir =
    process.env.HALLEY_BISECT_REPO_PATH ||
    process.env.HALLEY_FIXTURE_REPO_PATH ||
    "/Users/a-wattamwar/halley-demo-repo";

  // Determine fixture slug from repo_path.
  // repo_path is like "halley/fixtures/demo-classifier.json".
  const path = require("path") as typeof import("path");
  const slug = path.basename(repoPath, ".json");

  await setStatus(pool, bisect_job_id, "running");
  await appendLog(pool, bisect_job_id, `[bisect.run] starting bisect for fixture '${slug}' in ${bisectRepoDir}`);

  // 3. Locate halley CLI.
  const cliPath = halleyCli();
  if (!cliPath) {
    const msg =
      `[bisect.run] HALLEY_CLI_PATH not set and halley binary not found. ` +
      `Set HALLEY_CLI_PATH=/path/to/halley in worker env. ` +
      `Bisect executed via CLI on the host (v1 limitation).`;
    await appendLog(pool, bisect_job_id, msg);
    await setStatus(pool, bisect_job_id, "failed");
    console.error(`[bisect.run] ${msg}`);
    throw new Error(msg);
  }

  await appendLog(pool, bisect_job_id, `[bisect.run] using CLI: ${cliPath}`);

  // 4. Build halley bisect command.
  const args = ["bisect", slug];
  if (base_commit) {
    args.push("--good", base_commit);
  }
  args.push("--repo", bisectRepoDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HALLEY_SDK_PY_PATH:
      process.env.HALLEY_SDK_PY_PATH ||
      "/Users/a-wattamwar/development/halley/sdk-py",
  };

  await appendLog(pool, bisect_job_id, `[bisect.run] cmd: ${cliPath} ${args.join(" ")}`);

  let stdout = "";
  let stderr = "";
  let exitOk = false;

  try {
    const result = await execFileAsync(cliPath, args, {
      cwd: bisectRepoDir,
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
    const resultCommit = resultLine.replace("BISECT_RESULT:", "").trim().split(" ")[0];
    await setStatus(pool, bisect_job_id, "done", resultCommit);
    console.log(`[bisect.run] done  result_commit=${resultCommit}`);
  } else {
    await setStatus(pool, bisect_job_id, "failed");
    console.error(`[bisect.run] failed  bisect_job_id=${bisect_job_id}`);
    throw new Error("halley bisect did not return a BISECT_RESULT");
  }
}
