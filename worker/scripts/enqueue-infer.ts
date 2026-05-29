/**
 * scripts/enqueue-infer.ts — dev helper to enqueue an invariant.infer job.
 *
 * Usage — run INSIDE the worker Docker container so it connects to the
 * correct Redis (docker-compose service name "redis") and Postgres:
 *
 *   docker exec halley-worker node --import tsx/esm scripts/enqueue-infer.ts <32-char-hex>
 *
 * Running on the host works only if REDIS_URL points to the Docker Redis
 * (localhost:6379 may resolve to a native Redis before the Docker-mapped port).
 *   RUN_ID=<32-char-hex> npm run enqueue-infer   # host-side, see note above
 *
 * The script:
 *   1. Ensures a fixtures row exists for the run_id (inserts with
 *      status='proposing' if absent).
 *   2. Enqueues an invariant.infer job for the run.
 *
 * Exits once the job is queued (does not wait for completion).
 *
 * D-18: uses the same "halley:worker" prefix as the main worker.
 */

import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { getRedis, getPool } from "../src/connections.js";

const DEV_PROJECT_ID = "a2c7a9a8-2e1b-4d1a-9f0b-000000000001";
const QUEUE_NAME     = "invariant.infer";

async function main() {
  const runId = (process.argv[2] ?? process.env.RUN_ID ?? "").trim().toUpperCase();
  if (!runId || runId.length !== 32) {
    console.error("Usage: RUN_ID=<32-char-hex> npm run enqueue-infer");
    console.error("       node --import tsx/esm scripts/enqueue-infer.ts <32-char-hex>");
    process.exit(1);
  }

  console.log(`[enqueue-infer] run_id=${runId}`);

  // ── Ensure fixtures row exists ─────────────────────────────────────────────
  const pool = getPool();
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM fixtures WHERE source_run_id = $1",
    [runId]
  );

  let fixtureId: string;
  if (existing.rowCount && existing.rowCount > 0) {
    fixtureId = existing.rows[0].id;
    console.log(`[enqueue-infer] fixtures row already exists id=${fixtureId}`);
  } else {
    fixtureId = randomUUID();
    await pool.query(
      `INSERT INTO fixtures (id, project_id, source_run_id, repo_path, invariants_json, status)
       VALUES ($1, $2::uuid, $3, '', '{}'::jsonb, 'proposing')`,
      [fixtureId, DEV_PROJECT_ID, runId]
    );
    console.log(`[enqueue-infer] inserted fixtures row id=${fixtureId}`);
  }

  // ── Enqueue the job ────────────────────────────────────────────────────────
  const redis = getRedis();
  const queue = new Queue(QUEUE_NAME, {
    connection: redis,
    prefix: "halley:worker",
  });

  const job = await queue.add(
    QUEUE_NAME,
    { run_id: runId },
    { jobId: `infer-${runId}-${Date.now()}` }
  );

  console.log(`[enqueue-infer] enqueued job_id=${job.id}  fixture_id=${fixtureId}`);

  await queue.close();
  redis.disconnect();
  await pool.end();
  console.log("[enqueue-infer] done");
}

main().catch((err) => {
  console.error("[enqueue-infer] error:", err);
  process.exit(1);
});
