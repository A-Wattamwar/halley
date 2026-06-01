/**
 * E2E: the DASHBOARD CI loop (not the CLI).
 *
 * This drives the /fixtures/[id]/edit page's runner-aware "Run CI" surface
 * (D54, D-23). The page is a Server Component that reads the runner heartbeat
 * (lib/runner-status.ts → Redis key "halley:runner:heartbeat") at render time,
 * so the connected vs not-detected state is fully determined by whether that
 * key is present. We control it deterministically from the test (writing the
 * key is exactly what a host worker's heartbeat does).
 *
 * MODE IMPLEMENTED: BOTH, but the load-bearing assertion is the HONEST
 * not-detected / copy-command path (mode b) — it needs no live worker and is
 * always green. A second test asserts the connected pill + "Run CI" button
 * render when a heartbeat is present (mode a, runner-status→UI wiring) WITHOUT
 * depending on a real worker consuming the job (which would be a timing race).
 * A terminal done/failed CI result requires a host worker; that path is proven
 * separately (Day 3 worker integration) and via the GitHub Action (halley-ci.yml).
 *
 * Setup/teardown mirror live-span.spec.ts's "seed deterministically, drive the
 * UI" approach: we seed a dedicated fixtures row via SQL and remove it after.
 *
 * Requires HALLEY_AUTH_REQUIRED=false (default in .env.local) — no login.
 */

import { test, expect } from "@playwright/test";
import pg from "pg";
import Redis from "ioredis";

const PROJECT_ID = "a2c7a9a8-2e1b-4d1a-9f0b-000000000001";
const POSTGRES_URL =
    process.env.POSTGRES_URL ?? "postgres://halley:halley@localhost:5433/halley";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380/0";
const HEARTBEAT_KEY = "halley:runner:heartbeat";

// A deterministic fixture row for this spec. repo_path basename → slug.
const FIXTURE_ID = "e2e0c1a0-0000-4000-8000-0000000000c1";
const FIXTURE_SLUG = "e2e-dashboard-ci";
const FIXTURE_REPO_PATH = `halley/fixtures/${FIXTURE_SLUG}.json`;
const EXPECTED_COMMAND = `halley ci --only ${FIXTURE_SLUG}`;

function pool() {
    return new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
}

test.beforeAll(async () => {
    // Seed a fixtures row with non-empty invariants_json (so the editor renders,
    // not the "inferring…" skeleton) and a repo_path that yields a known slug.
    const p = pool();
    try {
        await p.query(
            `INSERT INTO fixtures
         (id, project_id, source_run_id, repo_path, invariants_json, status,
          target_repo_path, config_path)
       VALUES ($1, $2::uuid, $3, $4, '{}'::jsonb, 'ready', NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         repo_path = EXCLUDED.repo_path,
         invariants_json = EXCLUDED.invariants_json,
         status = EXCLUDED.status,
         target_repo_path = EXCLUDED.target_repo_path,
         config_path = EXCLUDED.config_path`,
            [
                FIXTURE_ID,
                PROJECT_ID,
                "e2e-ci-source-run",
                FIXTURE_REPO_PATH,
            ]
        );
    } finally {
        await p.end();
    }
});

test.afterAll(async () => {
    // Remove the seeded fixture (cascades to any ci_runs rows we created) and
    // clear any heartbeat key we set so we don't leak state to other suites.
    const p = pool();
    try {
        await p.query(`DELETE FROM fixtures WHERE id = $1`, [FIXTURE_ID]);
    } finally {
        await p.end();
    }
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
        await redis.connect();
        await redis.del(HEARTBEAT_KEY);
    } catch {
        // ignore
    } finally {
        redis.disconnect();
    }
});

test.describe("dashboard CI loop", () => {
    test("no runner → pill 'not detected' + copy-command shown (D-23)", async ({ page }) => {
        // Ensure NO heartbeat key — the honest default (no host runner present).
        const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
        try {
            await redis.connect();
            await redis.del(HEARTBEAT_KEY);
        } finally {
            redis.disconnect();
        }

        await page.goto(`/fixtures/${FIXTURE_ID}/edit`);

        // Runner status pill reflects no runner.
        await expect(page.getByText("Runner: not detected")).toBeVisible({ timeout: 10_000 });

        // The "Run CI" panel header is present…
        await expect(
            page.getByRole("heading", { name: "Run CI" })
        ).toBeVisible();

        // …and because no runner is connected, the exact copy-paste command is
        // shown (D-23: terminal commands always available), not a fake spinner.
        await expect(page.getByText(EXPECTED_COMMAND).first()).toBeVisible();

        // The primary affordance is "Copy command", not an executing "Run CI" button.
        await expect(
            page.getByRole("button", { name: "Copy command" }).first()
        ).toBeVisible();
    });

    test("runner heartbeat present → pill 'connected' + Run CI button", async ({ page }) => {
        // Write a heartbeat key exactly as a host worker would (lib/heartbeat.ts
        // shape: { host, pid, role, ts }) with a short TTL.
        const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
        try {
            await redis.connect();
            await redis.set(
                HEARTBEAT_KEY,
                JSON.stringify({ host: "e2e-test", pid: 1, role: "host", ts: Date.now() }),
                "EX",
                30
            );
        } finally {
            redis.disconnect();
        }

        await page.goto(`/fixtures/${FIXTURE_ID}/edit`);

        // Pill reflects the present heartbeat.
        await expect(page.getByText("Runner: connected")).toBeVisible({ timeout: 10_000 });

        // With a runner connected, the executable "Run CI" button renders.
        await expect(
            page.getByRole("button", { name: "Run CI" })
        ).toBeVisible();
    });
});
