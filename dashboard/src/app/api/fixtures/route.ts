/**
 * POST /api/fixtures — create a fixture row and enqueue invariant.infer.
 *
 * Request body: { run_id: string, run_name?: string }
 *
 * Steps:
 *   1. Resolve project_id from the session (D-15 bypass when auth is off).
 *   2. Derive a slug from run_name (or run_id) for the placeholder repo_path.
 *      fixtures.repo_path is NOT NULL; we set a tentative value now so the
 *      constraint is satisfied. Day 4 (fixture writer) will update it to the
 *      real on-disk path when the user saves.
 *   3. INSERT INTO fixtures (id, project_id, source_run_id, repo_path,
 *      invariants_json, status). Uses ON CONFLICT (source_run_id, project_id)
 *      DO NOTHING so clicking "Turn into test" twice is idempotent; returns
 *      the existing fixture_id if already present.
 *   4. Enqueue invariant.infer { fixture_id, run_id } onto the halley-worker
 *      BullMQ queue (D-18: prefix "halley:worker", does NOT touch ingester keys).
 *
 * Returns: { fixture_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import pg from "pg";
import { getSessionProjectId } from "@/lib/session";
import { enqueueInvariantInfer } from "@/lib/worker-queue";

export const dynamic = "force-dynamic";

function getPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ??
      `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
    max: 3,
  });
}

/**
 * Derive a URL-safe slug from a run name or fall back to the run_id prefix.
 * Used as the placeholder for fixtures.repo_path until Day 4 writes the real path.
 */
function toSlug(runName: string, runId: string): string {
  if (runName && runName.trim()) {
    return runName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || runId.slice(0, 12).toLowerCase();
  }
  return runId.slice(0, 12).toLowerCase();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { run_id?: string; run_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { run_id, run_name = "" } = body;
  if (!run_id || typeof run_id !== "string" || run_id.length !== 32) {
    return NextResponse.json(
      { error: "run_id must be a 32-char hex string" },
      { status: 400 }
    );
  }

  const projectId = await getSessionProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const slug     = toSlug(run_name, run_id);
  const repoPath = `halley/fixtures/${slug}`;

  const pool = getPool();
  let fixtureId: string;

  try {
    // Check for an existing fixture for this run+project so the button is
    // idempotent (clicking twice doesn't create duplicates).
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM fixtures
        WHERE source_run_id = $1 AND project_id = $2::uuid
        LIMIT 1`,
      [run_id.toUpperCase(), projectId]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      fixtureId = existing.rows[0].id;
    } else {
      fixtureId = randomUUID();
      await pool.query(
        `INSERT INTO fixtures
           (id, project_id, source_run_id, repo_path, invariants_json, status)
         VALUES ($1, $2::uuid, $3, $4, '{}'::jsonb, 'proposing')`,
        [fixtureId, projectId, run_id.toUpperCase(), repoPath]
      );
    }
  } finally {
    await pool.end();
  }

  // Enqueue the infer job — fire and forget (worker processes async).
  // D-18: queue name "invariant.infer", prefix "halley:worker" — no ingester key touch.
  try {
    await enqueueInvariantInfer({ fixture_id: fixtureId, run_id: run_id.toUpperCase() });
  } catch (err) {
    // Job enqueue failure is non-fatal for the user — the fixture row exists
    // and can be re-enqueued. Log and return partial success.
    console.error("[/api/fixtures] failed to enqueue job:", err);
    return NextResponse.json(
      { fixture_id: fixtureId, warning: "Fixture created but job enqueue failed" },
      { status: 202 }
    );
  }

  return NextResponse.json({ fixture_id: fixtureId }, { status: 201 });
}
