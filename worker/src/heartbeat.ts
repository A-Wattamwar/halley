/**
 * heartbeat.ts — host-runner liveness heartbeat (Phase 6 Week 11 Day 3, D54).
 *
 * The HOST worker (HALLEY_WORKER_ROLE ∈ {host, all}) periodically writes a
 * short-TTL key to Redis so the dashboard can tell whether a runner is present
 * and, if so, execute Run CI / Run bisect — otherwise it shows the copy-paste
 * command (never a fake spinner).
 *
 *   key   = "halley:runner:heartbeat"
 *   value = JSON { host, pid, role, ts }
 *   write = SET key value EX 30, refreshed every 10 s
 *
 * D-18 note: this key is under the halley:runner:* namespace — a worker↔dashboard
 * coordination key. It is NOT halley:spans / halley:writers / halley:live:*
 * (the ingester pipeline keys), so it does not violate the BullMQ isolation rule.
 */

import { hostname } from "os";
import { getRedis } from "./connections.js";

export const RUNNER_HEARTBEAT_KEY = "halley:runner:heartbeat";
const TTL_SECONDS = 30;
const REFRESH_MS = 10_000;

export interface HeartbeatInfo {
    host: string;
    pid: number;
    role: string;
    ts: number;
}

let _timer: ReturnType<typeof setInterval> | null = null;

async function writeOnce(role: string): Promise<void> {
    const info: HeartbeatInfo = {
        host: hostname(),
        pid: process.pid,
        role,
        ts: Date.now(),
    };
    try {
        await getRedis().set(
            RUNNER_HEARTBEAT_KEY,
            JSON.stringify(info),
            "EX",
            TTL_SECONDS
        );
    } catch (err) {
        console.error("[heartbeat] write failed:", (err as Error).message);
    }
}

/**
 * Start the heartbeat timer. Writes immediately, then every REFRESH_MS.
 * Idempotent — a second call is a no-op while one is running.
 */
export function startHeartbeat(role: string): void {
    if (_timer) return;
    void writeOnce(role);
    _timer = setInterval(() => void writeOnce(role), REFRESH_MS);
    console.log(
        `[heartbeat] started — key=${RUNNER_HEARTBEAT_KEY} ttl=${TTL_SECONDS}s refresh=${REFRESH_MS}ms role=${role}`
    );
}

/**
 * Stop the timer and best-effort delete the key so the dashboard flips to
 * "not detected" promptly on graceful shutdown (rather than waiting for TTL).
 */
export async function stopHeartbeat(): Promise<void> {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    try {
        await getRedis().del(RUNNER_HEARTBEAT_KEY);
    } catch {
        // ignore — TTL will expire it anyway
    }
}
