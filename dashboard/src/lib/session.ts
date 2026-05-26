/**
 * lib/session.ts — server-side session utilities (Phase 4 Day 2).
 *
 * Centralises the getServerSession() call so every Server Component page
 * gets the same behaviour:
 *   - HALLEY_AUTH_REQUIRED=false (D-15): returns the dev-local project ID
 *     unconditionally — no Postgres round-trip, no redirect.
 *   - Auth enabled: returns the project_id from the JWT session if present,
 *     or null (middleware already redirected unauthenticated users to /login,
 *     so null here means the session doesn't carry a projectId yet — Day 2 seed
 *     fixes that by seeding a user and linking them to the dev project).
 *
 * The DEV_PROJECT_ID matches the seed in 20260513000006_dev_seed.sql.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

/** UUID of the dev-local project (seeded in 20260513000006_dev_seed.sql). */
export const DEV_PROJECT_ID = "a2c7a9a8-2e1b-4d1a-9f0b-000000000001";

const AUTH_REQUIRED = process.env.HALLEY_AUTH_REQUIRED !== "false";

/**
 * Returns the project UUID to scope ClickHouse queries.
 *
 * - Dev bypass (HALLEY_AUTH_REQUIRED=false): always DEV_PROJECT_ID.
 * - Authenticated: project_id from the JWT session's user (set in the
 *   auth.js callbacks when the session carries a linked project).
 *   Falls back to DEV_PROJECT_ID when the session has no project yet
 *   (e.g., first login before Day 3 project-linking is wired up).
 *
 * Returns undefined (no filter) only when auth is on AND there is no
 * session — middleware prevents this state from reaching a page.
 */
export async function getSessionProjectId(): Promise<string | undefined> {
  if (!AUTH_REQUIRED) {
    // D-15: dev bypass — skip DB round-trip, use fixed dev project.
    return DEV_PROJECT_ID;
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    // Should not reach here (middleware redirects to /login), but be safe.
    return undefined;
  }

  // The session carries user.id; look up their project via Postgres would
  // add latency. For Day 2, we scope all authenticated users to the single
  // dev-local project. Day 3 (API keys) will wire per-project scoping.
  // TODO(Day 3): join users → projects to get the real project_id.
  return DEV_PROJECT_ID;
}

/**
 * Thin wrapper: returns the full server session (for pages that need
 * the user's email or other fields, not just projectId).
 */
export async function getSession() {
  if (!AUTH_REQUIRED) return null; // no session object in dev bypass mode
  return getServerSession(authOptions);
}
