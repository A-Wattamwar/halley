/**
 * runner-common.ts — shared helpers for the HOST-worker "runner" jobs
 * (bisect.run, ci.run). Extracted Phase 6 Week 11 Day 3 to keep the two jobs
 * DRY and their runner discipline identical (D54).
 *
 * What lives here (table-agnostic, no DB writes except the read-only
 * exec-context SELECT):
 *   - resolveHalleyCli()        — locate the CLI from env/PATH, no host guesses
 *   - loadFixtureExecContext()  — read repo_path / target_repo_path / config_path
 *   - deriveSlug()              — fixture slug from repo_path basename
 *   - checkRunnerPreconditions()— pure precondition ladder → ok | needs_runner
 *   - buildRunnerCommand()      — the exact copy-paste `halley` command
 *
 * What does NOT live here: each job owns its own status/log writes, because the
 * two backing tables differ — bisect_jobs has no 'needs_runner' status (it uses
 * the Day-2 'failed' + "needs_runner:" log-prefix convention), while ci_runs
 * has a first-class 'needs_runner' status. Keeping the writes in the job
 * preserves bisect.run's exact Day-2 behavior.
 *
 * D54: repo-touching jobs run on the host worker; if the execution context or
 * tooling is missing we degrade honestly (needs_runner) with the command to run
 * by hand — never a hardcoded /Users/... fallback.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { basename } from "path";
import type { getPool } from "../connections.js";

const execFileAsync = promisify(execFile);

// ── Fixture execution context ───────────────────────────────────────────────

export interface FixtureExecContext {
    repo_path: string;
    target_repo_path: string | null;
    config_path: string | null;
}

type Pool = ReturnType<typeof getPool>;

/**
 * Load the per-fixture execution context (Day 2 columns). Returns null if the
 * fixture row does not exist.
 */
export async function loadFixtureExecContext(
    pool: Pool,
    fixtureId: string
): Promise<FixtureExecContext | null> {
    const res = await pool.query<FixtureExecContext>(
        `SELECT repo_path, target_repo_path, config_path
       FROM fixtures
      WHERE id = $1`,
        [fixtureId]
    );
    return res.rows[0] ?? null;
}

/**
 * Fixture slug = basename of repo_path without the .json extension
 * (e.g. "halley/fixtures/reasoning-agent-math.json" -> "reasoning-agent-math").
 * repo_path points at the fixture JSON inside the fixture-WRITE target; it is
 * NOT the repo to bisect/run.
 */
export function deriveSlug(repoPath: string): string {
    return basename(repoPath, ".json");
}

// ── CLI resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the halley CLI binary from env ONLY (D54 — no hardcoded host paths).
 *
 * Order:
 *   1. HALLEY_CLI_PATH if set and the file exists.
 *   2. `halley` on PATH (resolved via `which`/`where`), for users who installed it.
 * Returns null if neither resolves — the caller degrades to needs_runner.
 */
export async function resolveHalleyCli(): Promise<string | null> {
    const fromEnv = process.env.HALLEY_CLI_PATH;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    if (fromEnv && !existsSync(fromEnv)) {
        // Explicitly set but wrong — surface it; do not silently fall through.
        return null;
    }
    // Not set: try PATH. No /Users/... fallback (D54).
    try {
        const finder = process.platform === "win32" ? "where" : "which";
        const { stdout } = await execFileAsync(finder, ["halley"]);
        const resolved = stdout
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
            ?.trim();
        if (resolved && existsSync(resolved)) return resolved;
    } catch {
        // `which halley` failed — not on PATH.
    }
    return null;
}

// ── Precondition ladder ───────────────────────────────────────────────────────

/**
 * Resolved runner environment — every field guaranteed non-null. Returned by
 * checkRunnerPreconditions when ok=true so callers get narrowed types.
 */
export interface ResolvedRunnerEnv {
    targetRepoPath: string;
    cliPath: string;
    sdkPyPath: string;
}

export type PreconditionResult =
    | { ok: true; env: ResolvedRunnerEnv }
    | { ok: false; reason: string };

/**
 * The honest-degradation precondition ladder shared by all repo-touching jobs
 * (D54). Checks, in order:
 *   1. target_repo_path is set and exists on this host.
 *   2. the halley CLI resolves (env/PATH, no host guess).
 *   3. HALLEY_SDK_PY_PATH is set and exists (the replay shim the CLI needs to
 *      re-run the agent).
 *
 * Returns { ok: true, env } with all paths non-null, or { ok: false, reason }
 * describing the missing piece. The caller writes the needs_runner outcome to
 * its own table.
 */
export async function checkRunnerPreconditions(
    slug: string,
    targetRepoPath: string | null
): Promise<PreconditionResult> {
    // 1. target_repo_path must be set and exist (the repo to operate on).
    if (!targetRepoPath) {
        return {
            ok: false,
            reason:
                `fixture '${slug}' has no target_repo_path — the git repo is unknown. ` +
                `Set fixtures.target_repo_path (the agent repo), or run from a host runner.`,
        };
    }
    if (!existsSync(targetRepoPath)) {
        return {
            ok: false,
            reason:
                `target_repo_path '${targetRepoPath}' does not exist on this host. ` +
                `A host runner with the agent repo is required.`,
        };
    }

    // 2. CLI binary must resolve from env/PATH (no /Users/... fallback).
    const cliPath = await resolveHalleyCli();
    if (!cliPath) {
        return {
            ok: false,
            reason:
                `halley CLI not found. Set HALLEY_CLI_PATH to the built binary ` +
                `(cli/target/release/halley) or install 'halley' on PATH, then run on a host runner.`,
        };
    }

    // 3. The CLI needs the Python shim (sdk-py). For a user agent repo outside the
    //    Halley tree, the CLI cannot auto-discover it, so HALLEY_SDK_PY_PATH must
    //    be set. Require it from env only (no /Users/... fallback).
    const sdkPyPath = process.env.HALLEY_SDK_PY_PATH;
    if (!sdkPyPath || !existsSync(sdkPyPath)) {
        return {
            ok: false,
            reason:
                `HALLEY_SDK_PY_PATH not set or missing — the replay shim (sdk-py) is required ` +
                `to re-run the agent. Set HALLEY_SDK_PY_PATH on the host runner.`,
        };
    }

    return { ok: true, env: { targetRepoPath, cliPath, sdkPyPath } };
}

// ── Copy-paste command builders ───────────────────────────────────────────────

/**
 * Build the human-facing copy-paste `halley` command for a repo-touching job.
 * Uses the fixture's own execution context where known, with <placeholders>
 * for anything NULL so the message is always actionable (D54, D-23).
 *
 * Top-level --config MUST precede the subcommand (cli/src/main.rs).
 */
export function buildRunnerCommand(
    kind: "bisect" | "ci",
    opts: {
        slug: string;
        configPath: string | null;
        targetRepoPath: string | null;
        goodRef?: string | null;
    }
): string {
    const parts = ["halley"];
    if (opts.configPath) parts.push("--config", opts.configPath);

    if (kind === "bisect") {
        parts.push("bisect", opts.slug);
        if (opts.goodRef) parts.push("--good", opts.goodRef);
        parts.push("--repo", opts.targetRepoPath ?? "<target_repo_path>");
    } else {
        // ci runs in target_repo_path (cwd), so --only <slug> is the key arg.
        parts.push("ci", "--only", opts.slug);
    }
    return parts.join(" ");
}
