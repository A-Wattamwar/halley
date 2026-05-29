/**
 * POST /api/fixtures/[id]/save — enqueue a fixture.write job.
 *
 * Distinct from PATCH /api/fixtures/[id] (which updates invariants_json).
 * This endpoint instructs the worker to write the fixture files to the
 * target repo and flip status → 'ready'.
 *
 * Project-scoped: fixture must belong to the session project (returns 404
 * on mismatch, identical to the edit endpoint pattern).
 *
 * Returns: { ok: true, job_id: string | undefined }
 */

import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import { getSessionProjectId } from "@/lib/session";
import { enqueueFixtureWrite } from "@/lib/worker-queue";

export const dynamic = "force-dynamic";

function getPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ??
      `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
    max: 3,
  });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const fixtureId = params.id;

  const projectId = await getSessionProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Verify the fixture exists and belongs to this project.
  const pool = getPool();
  try {
    const res = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM fixtures
        WHERE id = $1 AND project_id = $2::uuid
        LIMIT 1`,
      [fixtureId, projectId]
    );

    if (!res.rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } finally {
    await pool.end();
  }

  let jobId: string | undefined;
  try {
    jobId = await enqueueFixtureWrite({ fixture_id: fixtureId });
  } catch (err) {
    console.error("[/api/fixtures/[id]/save] failed to enqueue:", err);
    return NextResponse.json(
      { error: "Failed to enqueue fixture.write job" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, job_id: jobId });
}
