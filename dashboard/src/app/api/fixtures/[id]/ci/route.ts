/**
 * POST /api/fixtures/[id]/ci — create a ci_run and enqueue ci.run.
 *
 * Returns: { ok: true, ci_run_id: string }
 *
 * GET /api/fixtures/[id]/ci — poll the latest ci_run for this fixture.
 *
 * Returns: { run: CiRun | null }
 *
 * Project-scoped: fixture must belong to the session project (mirrors the
 * bisect route). The ci.run job is consumed by the HOST worker only (D54); with
 * no host runner the job resolves to status 'needs_runner' with the copy-paste
 * command in the log — surfaced by CiPanel, never a fake spinner.
 */

import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import crypto from "crypto";
import { getSessionProjectId } from "@/lib/session";
import { enqueueCiRun } from "@/lib/worker-queue";

export const dynamic = "force-dynamic";

function getPool(): pg.Pool {
    return new pg.Pool({
        connectionString:
            process.env.POSTGRES_URL ??
            `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
        max: 3,
    });
}

// ── POST: trigger CI ──────────────────────────────────────────────────────

export async function POST(
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
        // Verify fixture belongs to this project.
        const fxRes = await pool.query<{ id: string }>(
            `SELECT id FROM fixtures
        WHERE id = $1 AND project_id = $2::uuid
        LIMIT 1`,
            [fixtureId, projectId]
        );
        if (!fxRes.rows[0]) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        // Insert ci_runs row.
        const ciRunId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO ci_runs (id, fixture_id, status)
       VALUES ($1, $2, 'queued')`,
            [ciRunId, fixtureId]
        );

        // Enqueue worker job.
        let jobId: string | undefined;
        try {
            jobId = await enqueueCiRun({ ci_run_id: ciRunId });
        } catch (err) {
            console.error("[/api/fixtures/[id]/ci POST] enqueue error:", err);
            // Don't fail the request — the row is in DB as 'queued'; user can retry.
        }

        return NextResponse.json({ ok: true, ci_run_id: ciRunId, queue_job_id: jobId });
    } finally {
        await pool.end();
    }
}

// ── GET: poll latest ci_run ───────────────────────────────────────────────

export interface CiRunRow {
    id: string;
    fixture_id: string;
    status: "queued" | "running" | "done" | "failed" | "needs_runner";
    passed: number | null;
    total: number | null;
    junit_xml: string | null;
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

        // Most recent ci_run for this fixture.
        const ciRes = await pool.query<CiRunRow>(
            `SELECT id, fixture_id, status, passed, total, junit_xml,
              log, created_at, completed_at
         FROM ci_runs
        WHERE fixture_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
            [fixtureId]
        );

        return NextResponse.json({ run: ciRes.rows[0] ?? null });
    } finally {
        await pool.end();
    }
}
