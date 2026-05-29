/**
 * POST /api/fixtures/[id]/bisect — create a bisect_job and enqueue bisect.run.
 *
 * Body (optional): { base_commit?: string, head_commit?: string }
 *
 * Project-scoped: fixture must belong to the session project.
 *
 * Returns: { ok: true, bisect_job_id: string }
 *
 * GET /api/fixtures/[id]/bisect — poll the latest bisect_job for this fixture.
 *
 * Returns: { job: BisectJob | null }
 */

import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import crypto from "crypto";
import { getSessionProjectId } from "@/lib/session";
import { enqueueBisectRun } from "@/lib/worker-queue";

export const dynamic = "force-dynamic";

function getPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ??
      `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
    max: 3,
  });
}

// ── POST: trigger bisect ──────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const fixtureId = params.id;

  const projectId = await getSessionProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { base_commit?: string; head_commit?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body — that's fine
  }

  const pool = getPool();
  try {
    // Verify fixture belongs to this project.
    const fxRes = await pool.query<{ id: string; repo_path: string }>(
      `SELECT id, repo_path FROM fixtures
        WHERE id = $1 AND project_id = $2::uuid
        LIMIT 1`,
      [fixtureId, projectId]
    );
    if (!fxRes.rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Insert bisect_job row.
    const bisectJobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bisect_jobs
         (id, fixture_id, base_commit, head_commit, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [bisectJobId, fixtureId, body.base_commit ?? null, body.head_commit ?? null]
    );

    // Enqueue worker job.
    let jobId: string | undefined;
    try {
      jobId = await enqueueBisectRun({ bisect_job_id: bisectJobId });
    } catch (err) {
      console.error("[/api/fixtures/[id]/bisect POST] enqueue error:", err);
      // Don't fail the request — the job row is still in DB as 'queued';
      // the user can retry by triggering again.
    }

    return NextResponse.json({ ok: true, bisect_job_id: bisectJobId, queue_job_id: jobId });
  } finally {
    await pool.end();
  }
}

// ── GET: poll latest bisect_job ───────────────────────────────────────────

export interface BisectJobRow {
  id: string;
  fixture_id: string;
  base_commit: string | null;
  head_commit: string | null;
  status: "queued" | "running" | "done" | "failed";
  result_commit: string | null;
  log: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const fixtureId = params.id;

  const projectId = await getSessionProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const pool = getPool();
  try {
    // Verify project scope.
    const fxRes = await pool.query<{ id: string }>(
      `SELECT id FROM fixtures WHERE id = $1 AND project_id = $2::uuid LIMIT 1`,
      [fixtureId, projectId]
    );
    if (!fxRes.rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get the most recent bisect_job for this fixture.
    const bjRes = await pool.query<BisectJobRow>(
      `SELECT id, fixture_id, base_commit, head_commit, status, result_commit,
              log, created_at, completed_at
         FROM bisect_jobs
        WHERE fixture_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [fixtureId]
    );

    return NextResponse.json({ job: bjRes.rows[0] ?? null });
  } finally {
    await pool.end();
  }
}
