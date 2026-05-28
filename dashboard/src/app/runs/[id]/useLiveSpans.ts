"use client";

/**
 * useLiveSpans — subscribes to the SSE endpoint for a run and accumulates
 * live span events, deduplicating by span_id.
 *
 * Exposes connection state ("connecting" | "open" | "disconnected") driven
 * by EventSource onopen / onerror events.
 *
 * Reconnection: native EventSource auto-reconnects at a fixed interval.
 * This hook overrides that with manual exponential backoff (1s → 2s → 4s …
 * capped at 30s). On error the EventSource is closed and a timer schedules
 * a new one; on successful open the delay resets to 1 s. Overlapping
 * reconnects are guarded by a generation counter; stale timers targeting a
 * previous generation are ignored. All timers are cleared on unmount.
 */

import { useEffect, useRef, useState, useCallback } from "react";

export interface LiveSpan {
  span_id: string;
  gen_ai_operation: string;
  status: string;
  /** Unix nanoseconds (number may lose precision; kept as string from JSON) */
  start_time: number;
  model: string;
}

export type ConnState = "connecting" | "open" | "disconnected";

export interface UseLiveSpansResult {
  spans: LiveSpan[];
  connState: ConnState;
}

const BACKOFF_INIT_MS  = 1_000;
const BACKOFF_MAX_MS   = 30_000;

export function useLiveSpans(runId: string): UseLiveSpansResult {
  const [spans, setSpans]         = useState<LiveSpan[]>([]);
  const [connState, setConnState] = useState<ConnState>("connecting");

  // Internal refs that are not part of React state — mutated freely.
  const esRef         = useRef<EventSource | null>(null);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayRef      = useRef<number>(BACKOFF_INIT_MS);
  const generationRef = useRef<number>(0); // incremented on each connect attempt

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const closeEs = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  };

  const connect = useCallback((gen: number) => {
    // Guard: if a newer generation has been started, bail.
    if (gen !== generationRef.current) return;

    const url = `/api/runs/${runId.toLowerCase()}/live`;
    setConnState("connecting");

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (gen !== generationRef.current) { es.close(); return; }
      setConnState("open");
      // Reset backoff on successful connection.
      delayRef.current = BACKOFF_INIT_MS;
    };

    es.onmessage = (event: MessageEvent) => {
      if (gen !== generationRef.current) return;
      try {
        const payload = JSON.parse(event.data as string) as LiveSpan;
        setSpans((prev) => {
          // Dedup by span_id — the server may re-publish on writer retry.
          if (prev.some((s) => s.span_id === payload.span_id)) return prev;
          return [...prev, payload];
        });
      } catch {
        // Malformed frame — ignore.
      }
    };

    es.onerror = () => {
      if (gen !== generationRef.current) return;
      // Close immediately — we manage reconnect manually with backoff.
      es.close();
      esRef.current = null;
      setConnState("disconnected");

      const delay = delayRef.current;
      // Increase delay exponentially, capped at BACKOFF_MAX_MS.
      delayRef.current = Math.min(delay * 2, BACKOFF_MAX_MS);

      const nextGen = gen + 1;
      generationRef.current = nextGen;

      timerRef.current = setTimeout(() => {
        connect(nextGen);
      }, delay);
    };
  }, [runId]);

  useEffect(() => {
    generationRef.current += 1;
    delayRef.current = BACKOFF_INIT_MS;
    clearTimer();
    closeEs();

    const gen = generationRef.current;
    connect(gen);

    return () => {
      // On unmount: invalidate current generation and clean up.
      generationRef.current += 1;
      clearTimer();
      closeEs();
    };
  }, [runId, connect]);

  return { spans, connState };
}
