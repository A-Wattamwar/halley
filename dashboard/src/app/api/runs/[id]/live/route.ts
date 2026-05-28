/**
 * GET /api/runs/[id]/live — SSE stream of live span events for a run.
 *
 * Subscribes to the Redis Pub/Sub channel `halley:live:<run_id>` and
 * relays each published JSON payload as an SSE frame to the connected browser.
 *
 * Implementation notes (see DECISIONS.md D49):
 * - SSE (not WebSocket): App Router route handlers cannot upgrade to WS.
 *   The channel is server→client only; SSE is the correct primitive.
 * - One dedicated ioredis connection per SSE connection. Acceptable for
 *   single-org v1; fan-out scaling is a known deferred tradeoff (D49).
 * - Does NOT query ClickHouse (D-12 is intact — this route relays Redis only).
 * - Auth is enforced at the middleware layer (middleware.ts matcher covers
 *   /api/runs/*, requires a valid JWT when HALLEY_AUTH_REQUIRED=true;
 *   EventSource sends the session cookie automatically). Set
 *   HALLEY_AUTH_REQUIRED=false to disable auth in local dev.
 * - Initial "connected" comment frame: immediately enqueued in start() so the
 *   browser's EventSource fires onopen even on idle runs that receive no spans.
 *   Without this, the stream header is only flushed when the first data frame
 *   arrives, leaving the badge stuck on "Connecting…" indefinitely.
 * - Keepalive: an SSE comment (": keepalive") is enqueued every 25 s to hold
 *   the connection open through intermediate proxies that close idle streams.
 */

import { NextRequest } from "next/server";
import Redis from "ioredis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const channel = `halley:live:${params.id.toLowerCase()}`;

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";

  // Dedicated subscriber connection — ioredis subscriber connections cannot
  // be used for other commands while subscribed, so we create one per SSE
  // connection. Cleaned up in the abort handler below.
  //
  // Use ioredis defaults (enableOfflineQueue: true, lazyConnect: false) so
  // that the SUBSCRIBE command is queued until the connection is established.
  // Setting enableOfflineQueue: false would reject commands issued before the
  // TCP handshake completes, causing the stream to close immediately on fast
  // Redis connections that haven't yet confirmed the socket.
  const subscriber = new Redis(redisUrl);

  const encoder = new TextEncoder();

  // Keepalive timer ref — set in start(), cleared in cleanup().
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.quit().catch(() => {});
  }

  const stream = new ReadableStream({
    start(controller) {
      // Immediately flush an SSE comment so the browser receives bytes and
      // EventSource.onopen fires — even for idle runs with no span traffic.
      // Without this initial frame the response headers are only sent when the
      // first data frame is enqueued, leaving the badge on "Connecting…".
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Periodic keep-alive comment every 25 s to hold the stream open
      // through proxies / load balancers that drop idle HTTP connections.
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Controller was already closed; stop the timer.
          cleanup();
        }
      }, 25_000);

      // Subscribe to the run's live channel.
      subscriber.subscribe(channel, (err) => {
        if (err) {
          cleanup();
          try { controller.close(); } catch {}
        }
      });

      // For each published message, enqueue an SSE frame.
      subscriber.on("message", (_chan: string, payload: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // Controller already closed.
        }
      });

      // Clean up when the client disconnects (navigation, tab close, etc.).
      // Uses both signal (Next.js request abort) and the stream cancel method.
      request.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      // Called when the ReadableStream consumer drops the stream.
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Disable nginx proxy buffering so chunks are flushed immediately.
      // Critical for Docker + reverse-proxy deployments (D49).
      "X-Accel-Buffering": "no",
    },
  });
}
