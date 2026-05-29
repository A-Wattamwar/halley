/**
 * Halley Worker — entry point.
 *
 * Sets up BullMQ workers for each registered job type, verifies all three
 * backing connections on startup, and registers SIGINT/SIGTERM handlers for
 * graceful shutdown.
 *
 * D-18: BullMQ queue/prefix = "halley:worker:" — does NOT touch
 * halley:spans / halley:writers / halley:live:* (ingester keys).
 */

import { Worker } from "bullmq";
import { verifyConnections, getRedis, getPool } from "./connections.js";
import { processInvariantInfer } from "./jobs/invariant-infer.js";
import type { InvariantInferJobData } from "./jobs/invariant-infer.js";

const QUEUE_NAME = "invariant.infer";

// BullMQ connection options — reuse the shared Redis singleton.
// lazyConnect: false is already set in getRedis(); BullMQ requires
// maxRetriesPerRequest: null (already set in getRedis()).
const connectionOpts = { connection: getRedis() };

async function main() {
  console.log("[halley-worker] starting up…");

  await verifyConnections();
  console.log("[halley-worker] all connections OK");

  // ── Register job processors ────────────────────────────────────────────────

  const inferWorker = new Worker<InvariantInferJobData>(
    QUEUE_NAME,
    async (job) => {
      await processInvariantInfer(job);
    },
    {
      ...connectionOpts,
      concurrency: 2,
      // D-18: custom prefix keeps BullMQ off the ingester's key namespace.
      prefix: "halley:worker",
    }
  );

  inferWorker.on("completed", (job) => {
    console.log(`[${QUEUE_NAME}] completed  job_id=${job.id}`);
  });
  inferWorker.on("failed", (job, err) => {
    console.error(`[${QUEUE_NAME}] failed     job_id=${job?.id}  error=${err.message}`);
  });

  console.log(`[halley-worker] listening on queue "${QUEUE_NAME}"`);

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string) {
    console.log(`[halley-worker] ${signal} received — draining workers…`);
    await inferWorker.close();
    const redis = getRedis();
    redis.disconnect();
    const pool = getPool();
    await pool.end();
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
