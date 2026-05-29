/**
 * Halley Worker — entry point.
 *
 * Sets up BullMQ workers for each registered job type, verifies all three
 * backing connections on startup, and registers SIGINT/SIGTERM handlers for
 * graceful shutdown.
 *
 * D-18: BullMQ queue/prefix = "halley:worker" — does NOT touch
 * halley:spans / halley:writers / halley:live:* (ingester keys).
 */

import { Worker } from "bullmq";
import { verifyConnections, getRedis, getPool } from "./connections.js";
import { processInvariantInfer } from "./jobs/invariant-infer.js";
import type { InvariantInferJobData } from "./jobs/invariant-infer.js";
import { processFixtureWrite } from "./jobs/fixture-write.js";
import type { FixtureWriteJobData } from "./jobs/fixture-write.js";

const INFER_QUEUE = "invariant.infer";
const WRITE_QUEUE = "fixture.write";

// Shared BullMQ options — reuse the Redis singleton.
// maxRetriesPerRequest: null is required by BullMQ (set in getRedis()).
// D-18: prefix "halley:worker" isolates BullMQ from ingester key namespace.
const workerOpts = {
  connection: getRedis(),
  prefix: "halley:worker",
};

async function main() {
  console.log("[halley-worker] starting up…");

  await verifyConnections();
  console.log("[halley-worker] all connections OK");

  // ── Register job processors ────────────────────────────────────────────────

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

  console.log(
    `[halley-worker] listening on queues "${INFER_QUEUE}", "${WRITE_QUEUE}"`
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string) {
    console.log(`[halley-worker] ${signal} received — draining workers…`);
    await Promise.all([inferWorker.close(), writeWorker.close()]);
    getRedis().disconnect();
    await getPool().end();
    console.log("[halley-worker] shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[halley-worker] fatal startup error:", err);
  process.exit(1);
});
