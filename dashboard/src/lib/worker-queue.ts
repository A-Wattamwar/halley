/**
 * lib/worker-queue.ts — BullMQ producer for the dashboard.
 *
 * The dashboard is a PRODUCER only — it enqueues jobs onto the same queue
 * and prefix that the halley-worker consumes.
 *
 * D-18: queue name "invariant.infer", prefix "halley:worker" — exactly what
 * the worker listens on. The dashboard MUST NOT read or write halley:spans,
 * halley:writers, or halley:live:* (ingester keys).
 *
 * Connection: parses REDIS_URL into RedisOptions (host/port/db/password) so
 * BullMQ receives the typed options it expects (not a Redis instance).
 */

import { Queue } from "bullmq";

const QUEUE_NAME    = "invariant.infer";
const BULLMQ_PREFIX = "halley:worker";

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

let _queue: Queue | null = null;

function getQueue(): Queue {
  if (!_queue) {
    const redisOpts = parseRedisUrl(
      process.env.REDIS_URL ?? "redis://localhost:6380/0"
    );
    _queue = new Queue(QUEUE_NAME, {
      connection: {
        ...redisOpts,
        maxRetriesPerRequest: null, // required by BullMQ
        enableReadyCheck: false,
        lazyConnect: true,
      },
      prefix: BULLMQ_PREFIX,
    });
  }
  return _queue;
}

export interface InvariantInferJobData {
  fixture_id: string;
  run_id:     string;
}

/**
 * Enqueue an invariant.infer job onto the halley-worker queue.
 *
 * @param data - { fixture_id, run_id }
 */
export async function enqueueInvariantInfer(
  data: InvariantInferJobData
): Promise<string | undefined> {
  const queue = getQueue();
  const job = await queue.add(QUEUE_NAME, data, {
    jobId: `infer-${data.fixture_id}-${Date.now()}`,
  });
  return job.id;
}
