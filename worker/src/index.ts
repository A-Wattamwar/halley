/**
 * Halley Worker — entry point.
 *
 * Sets up BullMQ workers for each registered job type, verifies all three
 * backing connections on startup, and registers SIGINT/SIGTERM handlers for
 * graceful shutdown.
 *
 * RUNNER ROLE-SPLIT (D54, Phase 6 Week 11 Day 3):
 *   HALLEY_WORKER_ROLE controls which job queues this process consumes:
 *     - "docker" → code-only jobs that need only PG/CH/Redis:
 *                  invariant.infer + fixture.write (run fine in the Docker worker)
 *     - "host"   → repo-touching jobs that need the agent repo/venv/CLI/config:
 *                  bisect.run + ci.run (must run on the HOST worker)
 *     - "all"    → all four queues (single-worker dev convenience; DEFAULT for
 *                  back-compat)
 *   The host role also writes a Redis heartbeat (halley:runner:heartbeat) so the
 *   dashboard knows a runner is present. A Docker worker and a host worker can
 *   run side by side without stealing each other's jobs (separate queues).
 *
 * D-18: BullMQ queue/prefix = "halley:worker" — does NOT touch
 * halley:spans / halley:writers / halley:live:* (ingester keys). The
 * halley:runner:* heartbeat key is a worker↔dashboard coordination key (allowed).
 */

import { Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { verifyConnections, getRedis, getPool } from "./connections.js";
import { processInvariantInfer } from "./jobs/invariant-infer.js";
import type { InvariantInferJobData } from "./jobs/invariant-infer.js";
import { processFixtureWrite } from "./jobs/fixture-write.js";
import type { FixtureWriteJobData } from "./jobs/fixture-write.js";
import { processBisectRun } from "./jobs/bisect-run.js";
import type { BisectRunJobData } from "./jobs/bisect-run.js";
import { processCiRun } from "./jobs/ci-run.js";
import type { CiRunJobData } from "./jobs/ci-run.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";

const INFER_QUEUE = "invariant.infer";
const WRITE_QUEUE = "fixture.write";
const BISECT_QUEUE = "bisect.run";
const CI_QUEUE = "ci.run";

// ── Runner role (D54) ───────────────────────────────────────────────────────

type WorkerRole = "docker" | "host" | "all";

function resolveRole(): WorkerRole {
  const raw = (process.env.HALLEY_WORKER_ROLE ?? "all").toLowerCase();
  if (raw === "docker" || raw === "host" || raw === "all") return raw;
  console.warn(`[halley-worker] unknown HALLEY_WORKER_ROLE="${raw}" — defaulting to "all"`);
  return "all";
}

const ROLE = resolveRole();
const runsCodeOnly = ROLE === "docker" || ROLE === "all"; // invariant.infer + fixture.write
const runsRepoJobs = ROLE === "host" || ROLE === "all"; // bisect.run + ci.run

// Shared BullMQ options — reuse the Redis singleton.
// maxRetriesPerRequest: null is required by BullMQ (set in getRedis()).
// D-18: prefix "halley:worker" isolates BullMQ from ingester key namespace.
//
// Type note: BullMQ bundles its OWN nested copy of ioredis, so our top-level
// `Redis` instance is structurally identical but nominally a different type
// than BullMQ's `ConnectionOptions`. Passing a live Redis instance is fully
// supported at runtime (BullMQ reuses it); the cast only satisfies the type
// checker across the duplicated ioredis declarations. We deliberately pass the
// shared singleton (not RedisOptions) so BullMQ does NOT open its own extra
// connections — preserving the existing single-connection behavior.
const workerOpts = {
  connection: getRedis() as unknown as ConnectionOptions,
  prefix: "halley:worker",
};

async function main() {
  console.log(`[halley-worker] starting up… role=${ROLE}`);

  await verifyConnections();
  console.log("[halley-worker] all connections OK");

  // ── Register job processors (conditionally, by role) ───────────────────────

  const workers: Worker[] = [];
  const activeQueues: string[] = [];

  if (runsCodeOnly) {
    const inferWorker = new Worker<InvariantInferJobData>(
      INFER_QUEUE,
      async (job) => { await processInvariantInfer(job); },
      { ...workerOpts, concurrency: 2 }
    );
    inferWorker.on("completed", (job) =>
      console.log(`[${INFER_QUEUE}] completed  job_id=${job.id}`)
    );
    inferWorker.on("failed", (job, err) =>
      console.error(`[${INFER_QUEUE}] failed     job_id=${job?.id}  error=${err.message}`)
    );

    const writeWorker = new Worker<FixtureWriteJobData>(
      WRITE_QUEUE,
      async (job) => { await processFixtureWrite(job); },
      { ...workerOpts, concurrency: 1 }
    );
    writeWorker.on("completed", (job) =>
      console.log(`[${WRITE_QUEUE}] completed  job_id=${job.id}`)
    );
    writeWorker.on("failed", (job, err) =>
      console.error(`[${WRITE_QUEUE}] failed     job_id=${job?.id}  error=${err.message}`)
    );

    workers.push(inferWorker, writeWorker);
    activeQueues.push(INFER_QUEUE, WRITE_QUEUE);
  }

  if (runsRepoJobs) {
    const bisectWorker = new Worker<BisectRunJobData>(
      BISECT_QUEUE,
      async (job) => { await processBisectRun(job); },
      { ...workerOpts, concurrency: 1 }
    );
    bisectWorker.on("completed", (job) =>
      console.log(`[${BISECT_QUEUE}] completed  job_id=${job.id}`)
    );
    bisectWorker.on("failed", (job, err) =>
      console.error(`[${BISECT_QUEUE}] failed     job_id=${job?.id}  error=${err.message}`)
    );

    const ciWorker = new Worker<CiRunJobData>(
      CI_QUEUE,
      async (job) => { await processCiRun(job); },
      { ...workerOpts, concurrency: 1 }
    );
    ciWorker.on("completed", (job) =>
      console.log(`[${CI_QUEUE}] completed  job_id=${job.id}`)
    );
    ciWorker.on("failed", (job, err) =>
      console.error(`[${CI_QUEUE}] failed     job_id=${job?.id}  error=${err.message}`)
    );

    workers.push(bisectWorker, ciWorker);
    activeQueues.push(BISECT_QUEUE, CI_QUEUE);

    // Host runner heartbeat so the dashboard knows we're present (D54).
    startHeartbeat(ROLE);
  }

  console.log(
    `[halley-worker] role=${ROLE} listening on queues: ${activeQueues.map((q) => `"${q}"`).join(", ")}`
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string) {
    console.log(`[halley-worker] ${signal} received — draining workers…`);
    if (runsRepoJobs) {
      await stopHeartbeat();
    }
    await Promise.all(workers.map((w) => w.close()));
    getRedis().disconnect();
    await getPool().end();
    console.log("[halley-worker] shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[halley-worker] fatal startup error:", err);
  process.exit(1);
});
