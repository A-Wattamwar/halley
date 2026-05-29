/**
 * POST /api/fixtures/[id] — save edited invariants_json back to Postgres.
 *
 * Request body: { invariants_json: object }
 *
 * Project-scoped: the fixture must belong to the session project, else 404.
 * Status remains 'proposing' — it becomes 'ready' when written to the repo
 * in Day 4 (fixture writer).
 *
 * Returns: { ok: true }
 */

import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import { getSessionProjectId } from "@/lib/session";

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
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const fixtureId = params.id;

  const projectId = await getSessionProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { invariants_json?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { invariants_json } = body;
  if (!invariants_json || typeof invariants_json !== "object") {
    return NextResponse.json(
      { error: "invariants_json must be a JSON object" },
      { status: 400 }
    );
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `UPDATE fixtures
          SET invariants_json = $1::jsonb
        WHERE id         = $2
          AND project_id = $3::uuid`,
      [JSON.stringify(invariants_json), fixtureId, projectId]
    );

    if (result.rowCount === 0) {
      // No row matched — fixture doesn't exist or belongs to another project.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } finally {
    await pool.end();
  }
}
