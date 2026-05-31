/**
 * lib/runner-status.ts — read the host runner's Redis heartbeat (D54).
 *
 * The host worker (HALLEY_WORKER_ROLE ∈ {host, all}) writes a short-TTL key
 * `halley:runner:heartbeat` (see worker/src/heartbeat.ts). The dashboard reads
 * it to decide whether Run CI / Run bisect can execute (runner connected) or
 * should show the copy-paste command instead (runner not detected). Never a
 * fake spinner.
 *
 * Redis access mirrors the existing dashboard pattern (a fresh ioredis client,
 * as in /api/runs/[id]/live). D-18: this key is under halley:runner:* — a
 * worker↔dashboard coordination key, NOT halley:spans / halley:writers /
 * halley:live:* (the ingester pipeline keys).
 */

import Redis from "ioredis";

export const RUNNER_HEARTBEAT_KEY = "halley:runner:heartbeat";

export interface RunnerInfo {
    host: string;
    pid: number;
    role: string;
    ts: number;
}

export interface RunnerStatus {
    connected: boolean;
    info?: RunnerInfo;
}

/**
 * Returns the current runner status by GETting the heartbeat key. The key's TTL
 * (~30 s, refreshed every ~10 s by the host worker) means a present key implies
 * a live runner. A short connect timeout keeps the dashboard responsive when
 * Redis is unreachable — we degrade to "not connected" rather than hang.
 */
export async function getRunnerStatus(): Promise<RunnerStatus> {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380/0";
    const redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
        // Do not spam reconnects from a short-lived request-scoped client.
        retryStrategy: () => null,
    });

    try {
        await redis.connect();
        const raw = await redis.get(RUNNER_HEARTBEAT_KEY);
        if (!raw) return { connected: false };
        try {
            const info = JSON.parse(raw) as RunnerInfo;
            return { connected: true, info };
        } catch {
            // Key present but unparseable — still implies a runner wrote it.
            return { connected: true };
        }
    } catch {
        // Redis unreachable → treat as no runner (honest, not a crash).
        return { connected: false };
    } finally {
        redis.disconnect();
    }
}
