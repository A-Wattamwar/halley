/**
 * /fixtures — Fixtures list page.
 *
 * Server Component (D-11). Lists all fixtures belonging to the session project.
 * Project-scoped to getSessionProjectId() — mirrors the runs-list scoping.
 * Each row links to /fixtures/[id]/edit. Empty state when no fixtures.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import pg from "pg";
import { getSessionProjectId } from "@/lib/session";

export const dynamic = "force-dynamic";

// ── Postgres loader ────────────────────────────────────────────────────────

interface FixtureListRow {
  id:             string;
  source_run_id:  string;
  repo_path:      string;
  status:         string;
  last_replay_at: string | null;
  created_at:     string;
}

function getPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.POSTGRES_URL ??
      `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
    max: 3,
  });
}

async function listFixtures(projectId: string): Promise<FixtureListRow[]> {
  const pool = getPool();
  try {
    const result = await pool.query<FixtureListRow>(
      `SELECT id, source_run_id, repo_path, status, last_replay_at, created_at
         FROM fixtures
        WHERE project_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 200`,
      [projectId]
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function slugFromPath(repoPath: string): string {
  // halley/fixtures/my-agent.json → my-agent
  // halley/fixtures/my-agent    → my-agent
  const base = repoPath.split("/").pop() ?? repoPath;
  return base.endsWith(".json") ? base.slice(0, -5) : base;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day:   "numeric",
      hour:  "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    proposing: "bg-amber-900/50 text-amber-300 border border-amber-800",
    ready:     "bg-green-900/50 text-green-300 border border-green-800",
    stale:     "bg-red-900/50  text-red-300   border border-red-800",
  };
  const cls = map[status] ?? "bg-gray-800 text-gray-400 border border-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function FixturesPage() {
  const projectId = await getSessionProjectId();
  if (!projectId) notFound();

  const fixtures = await listFixtures(projectId);

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Fixtures</h1>
            <p className="mt-1 text-sm text-gray-400">
              {fixtures.length === 0
                ? "No fixtures yet."
                : `${fixtures.length} fixture${fixtures.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
            >
              ← Runs
            </Link>
            <Link
              href="/settings/keys"
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
            >
              Settings →
            </Link>
          </div>
        </div>

        {/* Table or empty state */}
        {fixtures.length === 0 ? (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-12 text-center">
            <div className="text-4xl mb-4">🧪</div>
            <p className="text-gray-300 font-medium text-lg">No fixtures yet</p>
            <p className="mt-2 text-sm text-gray-500 max-w-sm mx-auto">
              Open a run and click{" "}
              <span className="text-violet-400 font-medium">Turn into test</span>{" "}
              to create your first fixture.
            </p>
            <Link
              href="/"
              className="mt-5 inline-block px-5 py-2.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-white text-sm font-medium transition-colors"
            >
              Go to Runs
            </Link>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            {/* Column header */}
            <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1.5fr] gap-4 px-5 py-3 border-b border-gray-800 bg-gray-900/80">
              {["Fixture", "Source run", "Status", "Last replay", "Created"].map((h) => (
                <div key={h} className="text-[10px] font-medium text-gray-600 uppercase tracking-wider">
                  {h}
                </div>
              ))}
            </div>

            {/* Rows */}
            <div className="divide-y divide-gray-800/50">
              {fixtures.map((f) => {
                const slug   = slugFromPath(f.repo_path);
                const runHex = f.source_run_id.toLowerCase();

                return (
                  <Link
                    key={f.id}
                    href={`/fixtures/${f.id}/edit`}
                    className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1.5fr] gap-4 px-5 py-3.5
                               hover:bg-gray-800/30 transition-colors items-center"
                  >
                    {/* Fixture name */}
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-gray-200 truncate block" title={slug}>
                        {slug}
                      </span>
                      <span className="text-[10px] text-gray-600 font-mono truncate block" title={f.repo_path}>
                        {f.repo_path}
                      </span>
                    </div>

                    {/* Source run — plain <a> inside the row Link, no onClick needed */}
                    <div className="min-w-0">
                      <a
                        href={`/runs/${runHex}`}
                        className="text-xs font-mono text-blue-400 hover:text-blue-300 transition-colors truncate block"
                        title={f.source_run_id}
                      >
                        {runHex.slice(0, 16)}…
                      </a>
                    </div>

                    {/* Status */}
                    <div>
                      <StatusBadge status={f.status} />
                    </div>

                    {/* Last replay */}
                    <div className="text-xs text-gray-500">
                      {fmtDate(f.last_replay_at)}
                    </div>

                    {/* Created */}
                    <div className="text-xs text-gray-500">
                      {fmtDate(f.created_at)}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
