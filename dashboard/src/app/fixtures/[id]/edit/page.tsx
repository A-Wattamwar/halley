/**
 * /fixtures/[id]/edit — Invariant editor page.
 *
 * Server Component shell (D-11). Loads the fixture from Postgres,
 * PROJECT-SCOPED to the current session — returns notFound() if the fixture
 * doesn't exist or belongs to a different project (mirrors getRunDetail scoping).
 *
 * The editor itself is delegated to InvariantEditor (client island) which owns
 * all interactive state. Save is a POST to /api/fixtures/[id] which writes the
 * edited invariants_json back to Postgres (status stays 'proposing' until Day 4).
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import pg from "pg";
import { getSessionProjectId } from "@/lib/session";
import { InvariantEditor } from "./InvariantEditor";
import type { InvariantsJson } from "./InvariantEditor";

export const dynamic = "force-dynamic";

// ── Postgres loader ───────────────────────────────────────────────────────

interface FixtureRow {
  id:               string;
  project_id:       string;
  source_run_id:    string;
  repo_path:        string;
  status:           string;
  invariants_json:  unknown;
  created_at:       string;
}

function getPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ??
      `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
    max: 3,
  });
}

async function loadFixture(
  id: string,
  projectId: string
): Promise<FixtureRow | null> {
  const pool = getPool();
  try {
    const result = await pool.query<FixtureRow>(
      `SELECT id, project_id, source_run_id, repo_path, status,
              invariants_json, created_at
       FROM fixtures
       WHERE id = $1 AND project_id = $2::uuid
       LIMIT 1`,
      [id, projectId]
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    proposing: "bg-amber-900/50 text-amber-300 border border-amber-800",
    ready:     "bg-green-900/50 text-green-300 border border-green-800",
  };
  const cls = map[status] ?? "bg-gray-800 text-gray-400 border border-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

interface PageProps {
  params: { id: string };
}

export default async function FixtureEditPage({ params }: PageProps) {
  const fixtureId = params.id;
  const projectId = await getSessionProjectId();
  if (!projectId) notFound();

  const fixture = await loadFixture(fixtureId, projectId);
  if (!fixture) notFound();

  // invariants_json may still be '{}' while the worker is running — render
  // a skeleton in that case so the user knows to wait.
  const invariants = fixture.invariants_json as InvariantsJson | null;
  const isEmpty =
    !invariants ||
    (typeof invariants === "object" &&
      Object.keys(invariants as object).length === 0);

  const runHex = fixture.source_run_id.toLowerCase();

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto">

        {/* Breadcrumb */}
        <Link
          href={`/runs/${runHex}`}
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors mb-6"
        >
          ← Back to run
        </Link>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white">Edit Fixture</h1>
            <StatusChip status={fixture.status} />
          </div>
          <p className="mt-2 text-sm text-gray-500 font-mono">
            {fixture.repo_path}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
            <span>
              <span className="mr-1">fixture</span>
              <span className="font-mono text-gray-500">{fixture.id}</span>
            </span>
            <span>
              <span className="mr-1">run</span>
              <span className="font-mono text-gray-500">{runHex}</span>
            </span>
            <span>created {fmtDate(fixture.created_at)}</span>
          </div>
        </div>

        {isEmpty ? (
          /* Worker hasn't finished yet */
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-10 text-center">
            <div className="text-4xl mb-3">⏳</div>
            <p className="text-gray-300 font-medium">
              Invariants are being inferred…
            </p>
            <p className="mt-1 text-sm text-gray-500">
              The worker is analysing the run. Reload this page in a few
              seconds.
            </p>
            <Link
              href={`/fixtures/${fixtureId}/edit`}
              className="mt-4 inline-block px-4 py-2 rounded-lg bg-gray-800 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              Reload
            </Link>
          </div>
        ) : (
          <InvariantEditor
            fixtureId={fixture.id}
            initialInvariants={invariants!}
          />
        )}
      </div>
    </main>
  );
}
