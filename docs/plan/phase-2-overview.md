# Phase 2 Overview — OTLP and the Normalizer

**Window**: Weeks 3 and 4 (May 27 - June 9 calendar; we are running ahead)
**Goal**: Production-quality ingester speaking OTLP across multiple dialects, with a Redis Streams pipeline, run grouping, Prometheus metrics, and a sustained 5K spans/sec load test.

This is the most technically dense phase. The end of Phase 2 is the first point at which Halley can claim "any OTLP-emitting LLM app works without code changes."

---

## What Phase 2 ships

By end of Week 4:

1. **OTLP receivers** on :4317 (gRPC) and :4318 (HTTP, both protobuf and JSON).
2. **Normalizer** with adapters for: OTEL GenAI (canonical baseline), OpenLLMetry, OpenInference, Vercel AI SDK, plus the existing `halley-raw` JSON dialect.
3. **Property-based tests** for each adapter proving round-trip correctness on supported attributes.
4. **Run grouping** at write time: every span gets a `run_id = trace_id` plus an `is_run_root` flag set by tiers 1-2 (`invoke_agent` operation, `halley.run.kind = "agent"` attribute). Tier 3 is a read-time aggregation in the dashboard.
5. **Redis Streams pipeline**: ingester publishes to `halley:spans`, a separate writer task consumes via consumer group, batches 500 spans or 100ms, inserts to ClickHouse, ACKs on success, dead-letters to `halley:spans:dlq` on persistent failure.
6. **Prometheus metrics** on `/metrics` exposing ingest rate, normalizer dialect distribution, writer batch sizes, Redis stream lag, ClickHouse insert errors.
7. **Sustained load test**: 5,000 spans/sec for 10 minutes on a single laptop-class VM, verified with `k6` (HTTP) and `ghz` (gRPC).
8. **Compatibility matrix** in the README documenting which dialects are supported.

## What Phase 2 explicitly does NOT ship

- TypeScript SDK (Phase 3).
- Dashboard auth or run detail views (Phase 4).
- Cassette-to-fixture promotion UI (Phase 5).
- `halley` CLI (Phase 5).
- Bisect (Phase 5).
- Tool-effect-safe replay (Phase 5).
- Helm chart (Phase 6 stretch).
- Cost recomputation at read time from `pricing_versions` (Phase 4 dashboard work; the schema and `pricing_version_id` per row are already there from Phase 1).

---

## Architectural change: data-flow pivot

Phase 1's ingester is direct-insert:

```
HTTP POST /v1/spans/json
    -> validate, hash, ClickHouse insert
       -> 202
```

Phase 2's ingester is stream-based:

```
HTTP/gRPC OTLP or POST /v1/spans/json
    -> normalize per dialect
       -> hash bodies (content-addressed)
          -> XADD halley:spans
             -> 202

Writer task (same binary, different tokio task)
    -> XREADGROUP halley:writers COUNT 500 BLOCK 100
       -> dedup body hashes against batch
          -> batch insert to ClickHouse
             -> XACK on success
             -> XADD halley:spans:dlq on persistent failure
```

This is the architecture in `docs/ARCHITECTURE.md` §3.2-3.5. Phase 1 deferred it because direct insert was simpler. Phase 2 lands it.

The write-side semantics from the customer's perspective do not change: POST a span, get 202, see it in the dashboard. What changes internally:

- Backpressure handling (Redis absorbs spikes the writer can't keep up with).
- Horizontal scalability of the writer (consumer group lets us add writers later without code changes).
- Crash safety (Redis AOF + DLQ stream means in-flight spans survive a writer restart).
- Bit-fidelity body dedup happens once per batch, not once per row.

---

## Two design calls baked into the plan

### Call 1: Run grouping is mostly a read-time concern

Original ARCHITECTURE.md design described four tiers running at ingest:
1. `gen_ai.operation.name = "invoke_agent"` → run root.
2. `halley.run.kind = "agent"` attribute → run root.
3. Trace with >1 LLM span → trace root is run root.
4. Else → `run_id = trace_id`, run of one.

Tiers 3 and 4 both produce `run_id = trace_id`. The actual difference is "is this trace an agent run" — that's a derived flag, not an identifier choice. Sharper design:

- **At ingest** (per-span, no batch lookups required):
  - `run_id = trace_id` always.
  - `is_run_root` (new boolean column) = true if the span has `invoke_agent` op (tier 1) or `halley.run.kind = "agent"` attribute (tier 2). False otherwise.
- **At read time** (dashboard query):
  - "Show agent runs" = `SELECT DISTINCT run_id FROM observations WHERE is_run_root = true`.
  - "Show all traces with multiple LLM spans" = aggregation over the trace.

Why this matters: streaming pipelines are bad at "look back at sibling spans before deciding what this span is." Doing it at write time would require holding a buffer per trace, with timeouts. We avoid that whole class of complexity. The dashboard's run list query is fast either way.

This requires one schema change: add `is_run_root Bool DEFAULT false` to `halley.observations`. dbmate migration handles it cleanly.

### Call 2: Keep `/v1/spans/json` as the `halley-raw` dialect

The Phase 1 endpoint stays. It becomes the "halley-raw" adapter in the normalizer. Reasons:
- Smoke test depends on it.
- Useful for examples, debugging, and the eventual TypeScript SDK that wants a Halley-shaped endpoint without OTLP dependencies.
- The shape is already canonical, so the adapter is a near-identity.

---

## Toolchain considerations

Phase 2 adds tonic, prost, opentelemetry-proto, redis, proptest, and metrics-exporter-prometheus. Each has its own MSRV. We are pinned at Rust 1.83 (D1, D21).

**Prediction**: tonic 0.13+ requires Rust 1.83 minimum, prost is older and fine, opentelemetry-proto follows tonic. Redis crate is fine. proptest is fine. metrics-exporter-prometheus is fine.

**If a crate demands Rust 1.84+**: bump the toolchain. Update D1 with the bump rationale. Re-evaluate the D21 ICU pins (most can probably walk forward).

The exec chat will research exact versions on Day 1 of Week 3.

---

## Week split

### Week 3: Pipeline, OTLP, and the first two adapters
- Day 1: Refactor to Redis Streams + writer task.
- Day 2: Normalizer architecture + OTEL GenAI adapter (canonical baseline) + halley-raw adapter.
- Day 3: OTLP/HTTP receiver on :4318.
- Day 4: OpenLLMetry adapter + property tests for both adapters so far.
- Day 5: OTLP/gRPC receiver on :4317.
- Day 6 (short): Polish, retro, commit.

Detailed plan: `docs/plan/phase-2-week-3.md`.

### Week 4: More adapters, run grouping, metrics, load test
- Day 1: OpenInference adapter.
- Day 2: Vercel AI SDK adapter.
- Day 3: Run grouping (tier 1-2 detection, schema migration for `is_run_root`).
- Day 4: Prometheus metrics on `/metrics`. DLQ stream. Optional: testcontainers integration tests.
- Day 5: Load test — 5K spans/sec for 10 min on HTTP and gRPC.
- Day 6 (short): Compatibility matrix in README, polish, retro, commit.

Detailed plan: `docs/plan/phase-2-week-4.md` (drafted after Week 3 retro lands).

---

## Acceptance bar for Phase 2 (end of Week 4)

The exec chat is done with Phase 2 when:

1. `docker compose down -v && docker compose up -d && make ready` brings all services healthy including the writer task as a healthy ingester process.
2. `make smoke` still passes (existing 9 assertions).
3. Posting an OTLP/HTTP request with an OpenLLMetry-shaped span lands a canonical row in ClickHouse with the correct `gen_ai_*` fields.
4. Posting the same logical span via OTLP/gRPC produces an identical canonical row.
5. Posting a span with `gen_ai.operation.name = "invoke_agent"` results in `is_run_root = true`.
6. `curl http://localhost:4318/metrics` returns Prometheus-format metrics with at least: ingest rate by dialect, writer batch size histogram, Redis stream lag.
7. The compatibility matrix in README lists the four supported dialects with a status badge each.
8. `cargo build` clean, `cargo clippy --all-targets -- -D warnings` clean, `cargo test` clean (unit + property tests).
9. Load test results: ingester sustained 5K spans/sec for 10 min on HTTP, with <50ms p99 latency. Numbers published in README.
10. Retro at the bottom of `docs/plan/phase-2-week-4.md`.
