# Phase 2, Week 4 — More adapters, run grouping, metrics, load test

**Window**: ~6 working days, Sunday off
**Effort budget**: ~25 to 30 hours
**Goal**: Round out the normalizer (OpenInference + Vercel AI SDK), add write-time run grouping, expose Prometheus metrics, run a sustained load test, and publish a compatibility matrix.

This doc is the single source of truth for Week 4. Read `docs/plan/phase-2-overview.md` and the Week 3 retro at the bottom of `docs/plan/phase-2-week-3.md` first.

---

## Working disciplines (read this first, follow exactly)

These are not new rules; they are how Week 4 will be cheaper to execute than Week 3 was, with no quality loss.

### D-1. Build the Docker image ONCE per day.

Week 3 sometimes rebuilt the image two or three times per Day after small fixes. Each rebuild is 5-10 minutes on Rust + ICU deps.

Rule: **all code changes for the day land first**, **then ONE `docker compose build ingester`**, **then smoke**. If you discover a bug after the rebuild, fix it and rebuild again — but treat that as a flag that you didn't think the change through, not a normal cycle.

When to skip the Docker rebuild entirely: any Day that only changes adapter logic, fixtures, docs, or DECISIONS.md AND already has a recent image. The exception: Days 3, 4, and 5 require a rebuild because schema, metrics, or live load testing depends on the running container.

### D-2. Run `cargo test` against the host toolchain, not via Docker.

Unit tests and property tests do not touch ClickHouse or Redis. They run in milliseconds against the host Rust 1.85 toolchain. Do not rebuild the image to verify a test passes.

`cargo test`, `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --check` are all host-side operations. Use them after each code change. Only when the host tests are green AND the day's code is fully written do you rebuild the Docker image.

### D-3. No daily `down -v && up` clean-boot.

Week 3 verified clean-boot every day. That replays migrations and rebuilds container state, which is a cost without a benefit during normal Day-to-Day work.

Rule: **`make smoke` against the already-running stack** during Days 1-5. Clean-boot is verified ONCE on Day 6 as part of the polish step. If smoke fails mid-week, fix the bug and re-run smoke — no need for a clean boot.

Exception: Day 3's schema migration must be tested with a `down -v && up` cycle to verify migration idempotency. That is the only mid-week clean-boot.

### D-4. Don't re-read all 7 docs every Day.

Day 1's prompt has the exec read everything. After that, **Day-N prompts only ask the exec to read the Day-N section of this file** plus any specific reference (e.g., a research note). The exec already has the architectural context.

### D-5. Trust the host-side checks; don't over-verify in Docker.

If `cargo test` passes on the host, `cargo clippy` is clean, `cargo fmt --check` is clean, and `make smoke` passes against the running stack, the Day is done. Do not run the same span through three different verification paths. Do not run the load test as part of Day 1-4 acceptance.

### D-6. Cuts from the original plan (explicit out-of-scope).

To keep Week 4 in budget, the following are explicitly cut. Do NOT add them.

- DLQ visibility warning (the periodic `XLEN halley:spans:dlq > 0` log). The DLQ stream still exists; we just don't poll it. Phase 5 dashboard work surfaces it.
- gRPC load testing with `ghz`. HTTP load test with `k6` is enough.
- Load test tuning iterations. Single 5-minute run, publish numbers as-achieved, document the bottleneck if there is one. Only iterate if achieved < 1K spans/sec (way below target).
- Testcontainers Rust integration tests. Phase 6 if at all.

These cuts save ~30-40% of the Week's credit cost. None of them affect the Phase 2 acceptance criteria in `phase-2-overview.md`.

---

## In scope

1. **OpenInference adapter** (Arize / Phoenix-flavored OTLP).
2. **Vercel AI SDK adapter** (Vercel's native OTEL export).
3. **Run grouping (write-time)**: schema migration to add `is_run_root Bool` to `halley.observations`. Adapters set it when `gen_ai.operation.name = "invoke_agent"` (tier 1) or `halley.run.kind = "agent"` (tier 2). `run_id = trace_id` always.
4. **Prometheus metrics on `/metrics`**: ingest rate by dialect, writer batch size, Redis stream lag, ClickHouse insert errors, body dedup ratio. `metrics` + `metrics-exporter-prometheus`.
5. **HTTP load test**: single 5-min run via `k6`, publish achieved rate and p99 latency in README.
6. **Compatibility matrix in README**: four supported dialects + halley-raw with detection criteria and source-file links.
7. **Phase 2 retro** at the bottom of this file.

## Explicitly out of scope (in addition to D-6 cuts)

- TypeScript SDK (Phase 3).
- Dashboard auth / run detail / reasoning graph (Phase 4).
- Cassette-to-fixture promotion UI (Phase 5).
- `halley` CLI binary (Phase 5).
- Bisect (Phase 5).
- Tool-effect-safe replay (Phase 5).
- Helm chart (Phase 6).
- Read-time cost recompute (Phase 4).

---

## Day-by-day plan

### Day 1: OpenInference adapter

**Why first**: most attribute-shape-different from OTEL GenAI. Get it out of the way; Day 2's Vercel adapter is then a smaller variant.

**Container rebuild today: NO** (adapter-only change; smoke passes against existing image).

Work:

1. New module `normalizer/openinference.rs`. Detection: any attribute starting with `openinference.` OR specific OpenInference `llm.*` keys (`llm.model_name`, `llm.token_count.prompt`, `llm.invocation_parameters`).

   Common OpenInference attributes (verify against the live OpenInference repo if uncertain — it's the source of truth, not memory):
   - `openinference.span.kind`: "LLM", "TOOL", "RETRIEVER", "AGENT", "CHAIN", "RERANKER", "EMBEDDING".
   - `llm.model_name` -> `gen_ai_request_model` and `gen_ai_response_model`.
   - `llm.system` -> `gen_ai_system`. (Note: the live OpenInference spec uses `llm.system`, NOT `llm.provider`. Corrected from original plan text after verifying against github.com/Arize-ai/openinference/blob/main/spec/llm_spans.md on 2026-05-15.)
   - `llm.token_count.prompt` -> `gen_ai_usage_input_tokens`.
   - `llm.token_count.completion` -> `gen_ai_usage_output_tokens`.
   - `input.value` / `input.mime_type` -> `input_body` (parse as JSON if mime is application/json, else wrap as `{"text": ...}`).
   - `output.value` / `output.mime_type` -> `output_body` (same rule).
   - `tool.name` -> `tool_name`.
   - `tool.parameters` -> `tool_input`.

2. Map `openinference.span.kind` to `gen_ai_operation` when `gen_ai.operation.name` is absent:
   `LLM -> chat`, `TOOL -> execute_tool`, `RETRIEVER -> retrieve`, `AGENT -> invoke_agent`. Others empty.

3. `source_dialect = "openinference"`.

4. Update `normalizer/mod.rs` adapter Vec order:
   `halley-raw, openllmetry, openinference, otel-genai`. Extend D31 (do not add D34).

5. Property tests: `prop_openinference_round_trip`, `prop_openinference_unknown_keys_preserved`.

6. Generate `ingester/fixtures/otlp-openinference-trace.bin` via a third function in `tests/gen_otlp_fixture.rs`. Update D32 to mention three fixtures.

7. One detection-priority unit test: span with both `traceloop.entity.name` AND `openinference.span.kind` resolves to `openllmetry` (because openllmetry is earlier in the Vec).

**Verification (host-side, no Docker rebuild)**:
- `cargo build` clean.
- `cargo clippy --all-targets -- -D warnings` clean.
- `cargo fmt --check` clean.
- `cargo test` (all unit + property tests pass).

Smoke against existing running stack only if you want a sanity check. Not required.

**Acceptance Day 1**: tests + clippy + fmt clean.

### Day 2: Vercel AI SDK adapter

**Container rebuild today: NO** (same reason as Day 1).

Work:

1. New module `normalizer/vercel_ai.rs`. Detection: presence of `ai.operationId` OR any `ai.*` namespace attribute that is Vercel-flavored (`ai.model.id`, `ai.model.provider`, `ai.usage.promptTokens`, `ai.usage.completionTokens`).

2. Map per Vercel AI SDK telemetry conventions:
   - `ai.model.id` -> `gen_ai_request_model`.
   - `ai.model.provider` -> `gen_ai_system`.
   - `ai.usage.promptTokens` -> `gen_ai_usage_input_tokens`.
   - `ai.usage.completionTokens` -> `gen_ai_usage_output_tokens`.
   - `ai.operationId` -> influence `gen_ai_operation`. `ai.generateText` -> `chat`, `ai.streamText` -> `chat`, `ai.embed` -> `embeddings`, `ai.toolCall` -> `execute_tool`.
   - `ai.prompt` and similar -> `input_body`.
   - `ai.response.text` / `ai.response.object` -> `output_body`.
   - `source_dialect = "vercel-ai"`.

3. Update `normalizer/mod.rs` order:
   `halley-raw, openllmetry, openinference, vercel-ai, otel-genai`. Extend D31.

4. Property tests, same shape as the others.

5. Fixture: `ingester/fixtures/otlp-vercel-ai-trace.bin`. Update D32.

**Verification (host-side, no Docker rebuild)**: same as Day 1.

**Acceptance Day 2**: all four dialects (halley-raw + openllmetry + openinference + vercel-ai + otel-genai fallback) registered with property tests passing.

### Day 3: Run grouping (`is_run_root` flag)

**Container rebuild today: YES** (schema migration + adapter logic touching the live pipeline).

**One mid-week clean-boot today** to verify the migration applies.

Work:

1. New ClickHouse migration `db/clickhouse/migrations/20260520000001_observations_is_run_root.sql`:
   ```sql
   -- migrate:up
   ALTER TABLE halley.observations
     ADD COLUMN IF NOT EXISTS is_run_root Bool DEFAULT false;

   -- migrate:down
   ALTER TABLE halley.observations DROP COLUMN IF EXISTS is_run_root;
   ```
   Single statement, dbmate-compatible (D24).

2. Update `domain/canonical.rs`:
   - `CanonicalSpan` gains `pub is_run_root: bool`.
   - `into_rows()` writes it into `ObservationRow.is_run_root`.

3. Update `domain/span.rs`: `ObservationRow` gains `pub is_run_root: bool`.

4. Update each of the five adapters to set `is_run_root`:
   - `halley_raw`: `(raw.gen_ai_operation == "invoke_agent" || raw.attributes.get("halley.run.kind") == Some("agent"))`.
   - `otel_genai`: `(gen_ai.operation.name == "invoke_agent" || halley.run.kind == "agent")`.
   - `openllmetry`: same plus `traceloop.span.kind == "agent"`.
   - `openinference`: same plus `openinference.span.kind == "AGENT"`.
   - `vercel_ai`: `(ai.operationId starts with "ai.agent" || halley.run.kind == "agent")`.

5. One property test: `prop_is_run_root_when_invoke_agent`. Generate spans with random `gen_ai.operation.name`; assert `is_run_root` iff the operation matches the per-adapter agent-root rule.

6. **Mid-week clean-boot** (the only one this week, per D-3 exception):
   ```
   docker compose down -v
   docker compose build ingester
   docker compose up -d
   make ready
   make smoke
   ```
   Verify: smoke passes, migration applied (column visible in ClickHouse). Then run a one-off:
   ```
   curl -X POST http://localhost:4318/v1/spans/json \
     -H 'Content-Type: application/json' \
     --data '{"...gen_ai_operation": "invoke_agent" ...}'
   ```
   And confirm `SELECT is_run_root FROM halley.observations WHERE gen_ai_operation = 'invoke_agent'` returns `1`.

7. Document in DECISIONS.md as **D34**: write-time vs read-time run grouping. The plan's two-line rule (set on tier 1 + tier 2 attributes; trace-level aggregation is read-time) goes here.

8. Update ARCHITECTURE.md §3.4: replace the four-tier list with the implemented two-tier write-time + read-time aggregation. Keep one paragraph below explaining what was reconsidered and why.

**Verification**: clean-boot smoke passes; column exists; agent-root spans have `is_run_root = 1`.

**Acceptance Day 3**: D34 logged, ARCHITECTURE.md updated, migration verified.

### Day 4: Prometheus metrics

**Container rebuild today: YES** (new crates in the dep tree).

Work:

1. Add to `Cargo.toml`:
   ```
   metrics = "0.24"
   metrics-exporter-prometheus = "0.16"
   ```
   Pin patch versions; verify they build on Rust 1.85 (high probability they do).

2. Mount the metrics exporter on the existing axum HTTP server at `/metrics`. Document the choice (single-server vs separate port) in DECISIONS.md as **D35**.

3. Emit metrics in the right places. Keep label cardinality low — dialect and status only, no model or project_id.
   - `halley_ingest_requests_total{dialect, status}` — counter, in `pipeline::ingest::ingest_otlp_request` AND `http::spans::post_span`.
   - `halley_ingest_latency_seconds{path}` — histogram, observed in HTTP and gRPC handlers (path = "http" or "grpc").
   - `halley_normalizer_unknown_attributes_total{dialect}` — counter, incremented in adapters when an unknown key lands in `attributes`.
   - `halley_writer_batch_size` — histogram, observed in `pipeline::writer` after each successful batch insert.
   - `halley_writer_flush_latency_seconds` — histogram, time from XREADGROUP return to XACK.
   - `halley_redis_stream_lag` — gauge, polled every 1s in a small task. `XLEN halley:spans` works.
   - `halley_clickhouse_insert_errors_total{kind}` — counter, kind = "transient" or "permanent" (from D30 classification).
   - `halley_body_dedup_ratio` — gauge, set per batch in the writer.

4. Single smoke assertion (NEW): `curl localhost:4318/metrics | grep -q halley_ingest_requests_total`. Add to `smoke.sh`. Wire check, not coverage.

5. Cuts from D-6:
   - DO NOT add the DLQ visibility warning. Skip entirely.
   - DO NOT add a `halley_dlq_size` gauge. Phase 5 surfaces DLQ.

**Verification (post-Docker-rebuild)**:
- Smoke passes (now N+1 assertions; whatever the running count is).
- `curl localhost:4318/metrics` returns Prometheus text format.

**Acceptance Day 4**: metrics endpoint live, all listed metrics emitted, smoke includes the wire-check assertion.

### Day 5: Load test (HTTP only, single run, no tuning)

**Container rebuild today: NO** (load test is an external client; ingester unchanged).

Work:

1. New directory `loadtest/` at the repo root.

2. Write `loadtest/k6-otlp-http.js`. Use k6's `constant-arrival-rate` executor targeting **5,000 RPS for 5 minutes** (NOT 10 minutes; the 10-min target was overly cautious and costs 2x). Payload: the existing `ingester/fixtures/otlp-genai-trace.bin` posted as `application/x-protobuf` to `/v1/traces`.

3. Add `make load-test` target to the Makefile that runs k6 in a container. macOS Docker network gotcha: use `--network halley_default` and target `http://halley-ingester:4318/v1/traces`.

4. Run the load test ONCE. Capture:
   - Achieved RPS.
   - p50, p95, p99 latency.
   - Error rate.
   - Redis stream lag at peak (`docker exec halley-redis redis-cli XLEN halley:spans`).
   - `docker stats` peak CPU/mem for ingester, ClickHouse, Redis.

5. Publish results in README under a "Performance" section. Honest numbers. If achieved < 5K RPS, document the bottleneck (likely ClickHouse insert latency or Publisher mutex).

6. Iterate ONLY if achieved < 1K RPS (a tenth of target). Otherwise publish and move on.

7. Document in DECISIONS.md as **D36**: load test methodology, achieved numbers, hardware spec, single tuning decision (if any was made).

**Cuts from D-6**:
- No gRPC load test.
- No 10-minute extended run.
- No k6 vs ghz comparison.

**Acceptance Day 5**: README has a Performance section with one number for achieved RPS, three numbers for latency percentiles, and the command to reproduce.

### Day 6 (short, ~2 hrs): Compatibility matrix + retro

**Container rebuild today: ONE** (the final clean-boot for Phase 2 acceptance, per `phase-2-overview.md`).

Work:

1. Add a "Supported instrumentation" table to README.md:

   | Dialect | Detection | Status | Adapter |
   |---|---|---|---|
   | halley-raw | `source_dialect` field | ✅ Stable | [halley_raw.rs](ingester/src/normalizer/halley_raw.rs) |
   | OpenLLMetry / Traceloop | `traceloop.*` attrs | ✅ Supported | [openllmetry.rs](ingester/src/normalizer/openllmetry.rs) |
   | OpenInference / Phoenix | `openinference.*` / `llm.*` | ✅ Supported | [openinference.rs](ingester/src/normalizer/openinference.rs) |
   | Vercel AI SDK | `ai.*` attrs | ✅ Supported | [vercel_ai.rs](ingester/src/normalizer/vercel_ai.rs) |
   | OTEL GenAI semconv | `gen_ai.*` (fallback) | ✅ Supported | [otel_genai.rs](ingester/src/normalizer/otel_genai.rs) |

2. Update README's architecture diagram to show the four normalizer paths.

3. Final hygiene: `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

4. **One Phase 2 clean-boot**:
   ```
   docker compose down -v
   docker compose build ingester
   docker compose up -d
   make ready
   make smoke
   ```
   Confirms Phase 2 acceptance criteria from `phase-2-overview.md` are met.

5. Write `## Phase 2 retro` at the bottom of this file. Cover all of Week 3 + Week 4 from a phase perspective: what shipped, what slipped, what surprised, what's still owed at start of Phase 3. ~150 words is plenty.

6. Stop. Do not commit. Do not start Phase 3.

---

## Reviewer checklist

### Adapters (Days 1-2)
- [ ] All four normalizer adapters implemented and registered: halley-raw, openllmetry (existing), openinference, vercel-ai, otel-genai.
- [ ] Adapter Vec order documented in code comment AND in D31.
- [ ] One detection-priority unit test per added adapter (openinference, vercel-ai).
- [ ] All `traceloop.*`, `openinference.*`, `ai.*` unknown keys preserved in `CanonicalSpan.attributes`.
- [ ] Three new OTLP fixtures (.bin) under `ingester/fixtures/`, generation function in `tests/gen_otlp_fixture.rs` (D32 updated).

### Run grouping (Day 3)
- [ ] `is_run_root Bool` column added via dbmate migration.
- [ ] Migration is idempotent on second `up`.
- [ ] All five adapters set `is_run_root` per the rules.
- [ ] ARCHITECTURE.md §3.4 updated.
- [ ] D34 documents the write-time-vs-read-time decision.

### Metrics (Day 4)
- [ ] `/metrics` route returns Prometheus text format.
- [ ] All metrics listed in the plan are emitted.
- [ ] Smoke includes one wire-check assertion.
- [ ] D35 documents the integration approach.
- [ ] No DLQ-visibility code (cut per D-6).
- [ ] No `halley_dlq_size` metric (cut).

### Load test (Day 5)
- [ ] `loadtest/k6-otlp-http.js` exists.
- [ ] `make load-test` runs.
- [ ] Achieved RPS, p50/p95/p99 latency, hardware spec published in README.
- [ ] D36 documents methodology and any tuning decision.
- [ ] No gRPC load test (cut per D-6).
- [ ] No 10-minute run (5 min only).

### Compatibility matrix (Day 6)
- [ ] README has a "Supported instrumentation" table linking to adapter sources.
- [ ] Architecture diagram updated.

### Build hygiene (every day, host-side)
- [ ] `cargo build` clean.
- [ ] `cargo clippy --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --check` clean.
- [ ] `cargo test` (all unit + property tests pass).
- [ ] `make smoke` passes.

### Phase 2 wrap (Day 6)
- [ ] Phase 2 retro at the bottom of this file.
- [ ] One clean-boot smoke passes.
- [ ] All Phase 2 acceptance criteria from `phase-2-overview.md` met.

### Non-goals respected
- [ ] No SDK code under `sdk-ts/`.
- [ ] No CLI under `cli/`.
- [ ] No replay / fork code.
- [ ] No bisect.
- [ ] No tool-effect-safety (Phase 5).
- [ ] No dashboard auth.
- [ ] No DLQ visibility / log warning.
- [ ] No gRPC load test.

---

## Common pitfalls

1. **OpenInference attribute value shapes.** `input.value` is often a JSON string. Adapter must `serde_json::from_str` it when `input.mime_type == "application/json"`, otherwise wrap as `{"text": ...}`.

2. **Vercel AI SDK attribute churn.** Vercel renames attributes between versions. Treat the adapter as best-effort; preserve unknowns in attributes; test against the actual fixture you generate.

3. **`is_run_root` default.** `Bool DEFAULT false` so existing rows get false. Forward change only — no backfill.

4. **Metrics cardinality.** Dialect and status are low-cardinality and fine. Do NOT add `model` or `project_id` as labels.

5. **k6 macOS networking.** `--network=host` does not work on Docker Desktop for Mac. Use `--network halley_default` and target the in-network hostname.

6. **5K RPS may saturate ClickHouse insert before the ingester.** The writer's batch insert is the likely bottleneck. Report achieved sustained rate honestly.

7. **Don't introduce new schema versions.** Week 4 adds exactly one column. Phase 4 may add more.

---

## When to stop

Phase 2 is done when every reviewer-checklist item passes. If finished early, do not start Phase 3. Use the time to expand the load test (longer duration, gRPC) ONLY if Day 5's run was problem-free.

The Phase 2 retro feeds the Phase 3 plan.

---

## Phase 2 retro

### What shipped

Phase 2 delivered everything in scope across both weeks. Week 3 shipped the Redis Streams pipeline, three normalizer adapters (halley-raw, otel-genai, openllmetry), OTLP/HTTP and OTLP/gRPC receivers, and property-based tests for all adapters. Week 4 added the OpenInference and Vercel AI SDK adapters, write-time run grouping (`is_run_root` Bool column via dbmate migration), Prometheus metrics on `/metrics` (8 metrics, all emitting real data), a k6 HTTP load test, and the compatibility matrix in README. The smoke test grew from 9 to 20 assertions. All five adapters have property tests. The load test achieved 4,792 spans/sec sustained over 5 minutes with 0% error rate and 0 data loss.

### What slipped

Nothing from the Week 4 scope slipped. One discipline note: Day 4 hit a module-shadowing bug (`mod metrics` in `main.rs` shadowed the external `metrics` crate, causing `use metrics::gauge` to fail with a confusing error). The fix was renaming the module to `telemetry` — a 10-minute detour, not a scope slip. The load test p99 (185ms) exceeded the 50ms informational threshold; this is documented honestly in README and D36 as a known bottleneck in the single writer task, not a regression.

### What surprised

The D-1 through D-5 working disciplines paid off measurably. Week 4 had zero Docker rebuild cycles wasted on incremental fixes — every rebuild was intentional (Days 3 and 4 only). The `is_run_root` column order constraint (ALTER TABLE ADD COLUMN appends to the end; Row derive serializes in declaration order) was a non-obvious correctness requirement that would have silently misaligned columns without the pre-flight check. The load test revealed that the ingester receiver is not the bottleneck — the single writer task caps throughput at ~4.8K spans/sec, and the Redis buffer absorbed the burst correctly.

### What's owed at start of Phase 3

Nothing from Phase 2 is owed. Phase 3 starts clean: TypeScript SDK, three example apps, and the first real traces flowing into the dashboard. The normalizer is ready for any OTLP-emitting app.
