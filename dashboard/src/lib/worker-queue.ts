/**
 * lib/worker-queue.ts — BullMQ producer for the dashboard.
 *
 * The dashboard is a PRODUCER only — it enqueues jobs onto queues that the
 * halley-worker consumes. Currently two queues:
 *   - "invariant.infer"  (prefix "halley:worker")
 *   - "fixture.write"    (prefix "halley:worker")
 *
 * D-18: The dashboard MUST NOT read or write halley:spans, halley:writers,
 * or halley:live:* (ingester keys).
 *
 * Connection: parses REDIS_URL into RedisOptions (host/port/db/password) so
 * BullMQ receives the typed options it expects (not a Redis instance).
 */

import { Queue } from "bullmq";

const BULLMQ_PREFIX  = "halley:worker";
const INFER_QUEUE    = "invariant.infer";
const WRITE_QUEUE    = "fixture.write";

/**
 * Parse redis[s]://[user:password@]host[:port][/db] into BullMQ RedisOptions.
 * Handles the minimal subset of the Redis URL spec that we use in Halley.
 */
function parseRedisUrl(url: string): {
  host: string;
  port: number;
  db: number;
  password?: string;
  username?: string;
} {
  try {
    const parsed = new URL(url);
    return {
      host:     parsed.hostname || "localhost",
      port:     parsed.port ? parseInt(parsed.port, 10) : 6379,
      db:       parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
      password: parsed.password || undefined,
      username: parsed.username || undefined,
    };
  } catch {
    return { host: "localhost", port: 6379, db: 0 };
  }
}

// Separate Queue instances for each job type.
let _inferQueue: Queue | null = null;
let _writeQueue: Queue | null = null;

function makeQueue(name: string): Queue {
  const redisOpts = parseRedisUrl(
    process.env.REDIS_URL ?? "redis://localhost:6380/0"
  );
  return new Queue(name, {
    connection: {
      ...redisOpts,
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
      lazyConnect: true,
    },
    prefix: BULLMQ_PREFIX,
  });
}

function getInferQueue(): Queue {
  _inferQueue ??= makeQueue(INFER_QUEUE);
  return _inferQueue;
}

function getWriteQueue(): Queue {
  _writeQueue ??= makeQueue(WRITE_QUEUE);
  return _writeQueue;
}

// ── Job data types ────────────────────────────────────────────────────────

export interface InvariantInferJobData {
  fixture_id: string;
  run_id:     string;
}

export interface FixtureWriteJobData {
  fixture_id: string;
}

// ── Producers ─────────────────────────────────────────────────────────────

/**
 * Enqueue an invariant.infer job onto the halley-worker queue.
 */
export async function enqueueInvariantInfer(
  data: InvariantInferJobData
): Promise<string | undefined> {
  const job = await getInferQueue().add(INFER_QUEUE, data, {
    jobId: `infer-${data.fixture_id}-${Date.now()}`,
  });
  return job.id;
}

/**
 * Enqueue a fixture.write job onto the halley-worker queue.
 */
export async function enqueueFixtureWrite(
  data: FixtureWriteJobData
): Promise<string | undefined> {
  const job = await getWriteQueue().add(WRITE_QUEUE, data, {
    jobId: `write-${data.fixture_id}-${Date.now()}`,
  });
  return job.id;
}
