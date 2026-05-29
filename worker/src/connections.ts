/**
 * connections.ts — connection factories and singletons for the worker.
 *
 * - getClickHouseClient(): returns a FRESH client on every call (not a
 *   singleton). Each query module closes it in a finally block; a shared
 *   singleton would be closed by the first job and unavailable to the second.
 * - getRedis(): singleton — BullMQ requires one stable connection per process.
 * - getPool(): singleton pg.Pool — cheap to share across concurrent jobs.
 *
 * D-18: BullMQ uses the prefix "halley:worker:" — it MUST NOT touch
 * halley:spans, halley:writers, or halley:live:* (those belong to the
 * ingester pipeline).
 */

import { createClient as createClickHouseClient } from "@clickhouse/client";
import { Redis } from "ioredis";
import pg from "pg";

// ── ClickHouse ────────────────────────────────────────────────────────────────

export function getClickHouseClient() {
  return createClickHouseClient({
    url:      process.env.CLICKHOUSE_URL      ?? "http://localhost:8123",
    database: process.env.CLICKHOUSE_DATABASE ?? "halley",
    username: process.env.CLICKHOUSE_USER     ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
  });
}

// ── Redis (shared singleton — BullMQ + health checks) ────────────────────────

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0", {
      // Prevent ioredis from hanging the process after graceful shutdown.
      enableReadyCheck: true,
      maxRetriesPerRequest: null, // Required by BullMQ.
      lazyConnect: false,
    });
    _redis.on("error", (err) => {
      console.error("[redis] connection error:", err.message);
    });
  }
  return _redis;
}

// ── Postgres ──────────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString:
        process.env.POSTGRES_URL ??
        `postgres://${process.env.POSTGRES_USER ?? "halley"}:${process.env.POSTGRES_PASSWORD ?? "halley"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "halley"}`,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    _pool.on("error", (err) => {
      console.error("[postgres] pool error:", err.message);
    });
  }
  return _pool;
}

// ── Startup health check ──────────────────────────────────────────────────────

export async function verifyConnections(): Promise<void> {
  // ClickHouse
  const ch = getClickHouseClient();
  try {
    const r = await ch.query({ query: "SELECT 1", format: "JSONEachRow" });
    await r.json();
    console.log("[startup] ClickHouse  ✓");
  } catch (err) {
    console.error("[startup] ClickHouse  ✗", (err as Error).message);
    throw err;
  } finally {
    await ch.close();
  }

  // Redis
  const redis = getRedis();
  try {
    await redis.ping();
    console.log("[startup] Redis       ✓");
  } catch (err) {
    console.error("[startup] Redis       ✗", (err as Error).message);
    throw err;
  }

  // Postgres
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("[startup] Postgres    ✓");
  } catch (err) {
    console.error("[startup] Postgres   ✗", (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
}
