/**
 * ci-run.ts — BullMQ job: run a fixture's replay check (`halley ci`) at $0 and
 * record pass/fail + invariant counts.
 *
 * Job payload: { ci_run_id: string }
 *
 * RUNNER MODEL (D54, Phase 6 Week 11 Day 3): like bisect.run this is a
 * *repo-touching* job — it re-runs the user's agent in replay mode against the
 * recorded cassette, which needs the agent repo, venv, CLI, and config. It runs
 * on the HOST worker. The dashboard enqueues; the host runner executes.
 *
 * EXECUTION CONTEXT comes from the fixture row (Day 2 columns), via the shared
 * runner-common helpers. No hardcoded /Users/... paths anywhere.
 *
 * HONEST DEGRADATION (D54): if target_repo_path is NULL, the dir is missing, the
 * CLI is unresolvable, or HALLEY_SDK_PY_PATH is unset, the row is set to the
 * first-class status 'needs_runner' (ci_runs has it in its CHECK) with the exact
 * copy-paste command in the log — never a fake spinner, never a guess.
 *
 * Pure mode only: `halley ci` replays recorded cassettes; no live API calls,
 * $0 (D-20). Exit 0 = all invariants passed; non-zero = some failed. passed /
 * total are parsed from the CLI's JUnit XML (<testsuites tests=.. failures=..>).
 *
 * D-18: queue name "ci.run", prefix "halley:worker" (isolated from ingester).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Job } from "bullmq";
import { getPool } from "../connections.js";
import {
    buildRunnerCommand,
    checkRunnerPreconditions,
    deriveSlug,
    loadFixtureExecContext,
} from "./runner-common.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface CiRunJobData {
    ci_run_id: string;
}

type CiStatus = "running" | "done" | "failed" | "needs_runner";

// ── Helpers ────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/** Append a line to the log column of a ci_runs row. */
async function appendLog(
    pool: ReturnType<typeof getPool>,
    id: string,
    line: string
): Promise<void> {
    await pool.query(
        `UPDATE ci_runs
        SET log = COALESCE(log, '') || $2 || E'\n'
      WHERE id = $1`,
        [id, line]
    );
}

/** Set just the status (used for the running transition). */
async function setStatus(
    pool: ReturnType<typeof getPool>,
    id: string,
    status: CiStatus
): Promise<void> {
    await pool.query(
        `UPDATE ci_runs
        SET status       = $2,
            completed_at = CASE WHEN $2 IN ('done','failed','needs_runner') THEN now() ELSE completed_at END
      WHERE id = $1`,
        [id, status]
    );
}

/** Set the terminal result with counts + JUnit XML. */
async function setResult(
    pool: ReturnType<typeof getPool>,
    id: string,
    status: "done" | "failed",
    passed: number | null,
    total: number | null,
    junitXml: string | null
): Promise<void> {
    await pool.query(
        `UPDATE ci_runs
        SET status       = $2,
            passed       = $3,
            total        = $4,
            junit_xml    = $5,
            completed_at = now()
      WHERE id = $1`,
        [id, status, passed, total, junitXml]
    );
}

/**
 * Record an honest needs_runner outcome on a ci_runs row using the first-class
 * 'needs_runner' status (ci_runs has it in its CHECK) plus the exact copy-paste
 * command in the log (D54, D-23). Returns the Error for the caller to `throw`.
 */
async function failNeedsRunner(
    pool: ReturnType<typeof getPool>,
    id: string,
    reason: string,
    command: string
): Promise<Error> {
    await appendLog(pool, id, `[ci.run] needs_runner: ${reason}`);
    await appendLog(pool, id, `[ci.run] run this on a host with a Halley runner:`);
    await appendLog(pool, id, `[ci.run]   ${command}`);
    await setStatus(pool, id, "needs_runner");
    console.error(`[ci.run] needs_runner: ${reason} | cmd: ${command}`);
    return new Error(`needs_runner: ${reason}`);
}

/**
 * Parse passed/total from JUnit XML produced by `halley ci`. The CLI writes:
 *   <testsuites tests="N" failures="M" errors="0">
 * so total = N and passed = N - M. Returns null counts if unparseable.
 */
function parseJUnitCounts(xml: string): { passed: number | null; total: number | null } {
    const testsMatch = xml.match(/<testsuites[^>]*\btests="(\d+)"/);
    const failMatch = xml.match(/<testsuites[^>]*\bfailures="(\d+)"/);
    if (!testsMatch) return { passed: null, total: null };
    const total = parseInt(testsMatch[1], 10);
    const failures = failMatch ? parseInt(failMatch[1], 10) : 0;
    return { passed: total - failures, total };
}

// ── Job processor ──────────────────────────────────────────────────────────

export async function processCiRun(job: Job<CiRunJobData>): Promise<void> {
    const { ci_run_id } = job.data;
    const pool = getPool();

    console.log(`[ci.run] start  ci_run_id=${ci_run_id}`);

    // 1. Load ci_runs row → fixture_id.
    const res = await pool.query<{ fixture_id: string }>(
        `SELECT fixture_id FROM ci_runs WHERE id = $1`,
        [ci_run_id]
    );
    if (!res.rows[0]) {
        throw new Error(`ci_run not found: ${ci_run_id}`);
    }
    const { fixture_id } = res.rows[0];

    // 2. Load the fixture's execution context (shared loader).
    const fx = await loadFixtureExecContext(pool, fixture_id);
    if (!fx) {
        throw new Error(`fixture not found: ${fixture_id}`);
    }
    const { repo_path, target_repo_path, config_path } = fx;
    const slug = deriveSlug(repo_path);

    await setStatus(pool, ci_run_id, "running");
    await appendLog(
        pool,
        ci_run_id,
        `[ci.run] fixture='${slug}' target_repo_path=${target_repo_path ?? "(null)"} config_path=${config_path ?? "(null)"}`
    );

    const command = buildRunnerCommand("ci", {
        slug,
        configPath: config_path,
        targetRepoPath: target_repo_path,
    });

    // 3. Preconditions — degrade honestly to needs_runner instead of guessing.
    const pre = await checkRunnerPreconditions(slug, target_repo_path);
    if (!pre.ok) {
        throw await failNeedsRunner(pool, ci_run_id, pre.reason, command);
    }
    const { targetRepoPath: repoDir, cliPath, sdkPyPath } = pre.env;

    await appendLog(pool, ci_run_id, `[ci.run] using CLI: ${cliPath}`);

    // 4. Build the halley ci command.
    //    Top-level --config MUST precede the subcommand (cli/src/main.rs).
    //    ci --only <slug> --junit <abs tmp path>  (pure mode is the default).
    //    JUnit goes to an absolute temp path so we can read it back regardless of
    //    the CLI's cwd; cleaned up in finally.
    const junitDir = mkdtempSync(join(tmpdir(), "halley-ci-"));
    const junitPath = join(junitDir, `${slug}.xml`);

    const args: string[] = [];
    if (config_path) {
        args.push("--config", config_path);
    }
    args.push("ci", "--only", slug, "--junit", junitPath);

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HALLEY_SDK_PY_PATH: sdkPyPath,
    };

    await appendLog(pool, ci_run_id, `[ci.run] cmd: ${cliPath} ${args.join(" ")}`);

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
        exitOk = true; // exit 0 = all invariants passed
    } catch (err: unknown) {
        // Non-zero exit (e.g. invariant failure) lands here — NOT a needs_runner
        // condition; it's a real CI result we record as 'failed'.
        const e = err as { stdout?: string; stderr?: string; message: string };
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
        await appendLog(pool, ci_run_id, `[ci.run] CLI exit non-zero: ${e.message}`);
    }

    const fullLog = [stderr, stdout].filter(Boolean).join("\n");
    await appendLog(pool, ci_run_id, fullLog);

    // 5. Parse JUnit for counts.
    let junitXml: string | null = null;
    let passed: number | null = null;
    let total: number | null = null;
    try {
        if (existsSync(junitPath)) {
            junitXml = readFileSync(junitPath, "utf8");
            const counts = parseJUnitCounts(junitXml);
            passed = counts.passed;
            total = counts.total;
        }
    } catch (e) {
        await appendLog(pool, ci_run_id, `[ci.run] could not read JUnit XML: ${String(e)}`);
    } finally {
        rmSync(junitDir, { recursive: true, force: true });
    }

    // 6. Terminal result. exit 0 = done (all passed); non-zero = failed.
    const status: "done" | "failed" = exitOk ? "done" : "failed";
    await setResult(pool, ci_run_id, status, passed, total, junitXml);
    console.log(
        `[ci.run] ${status}  ci_run_id=${ci_run_id} passed=${passed ?? "?"}/${total ?? "?"}`
    );
}
