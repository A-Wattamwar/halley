# Phase 2, Week 3 — Pipeline, OTLP, and the first two adapters

**Window**: ~6 working days, Sunday off
**Effort budget**: ~25 to 30 hours
**Goal**: Refactor the ingester from direct-insert to a Redis Streams pipeline, add OTLP/HTTP and OTLP/gRPC receivers, and ship two normalizer adapters (OTEL GenAI and OpenLLMetry) with property-based tests.

This doc is the single source of truth for Week 3. Read `docs/plan/phase-2-overview.md` first for the architectural reasoning behind the order.

---

## In scope

1. **Redis Streams pipeline.** Ingester publishes spans to `halley:spans`. A separate tokio task consumes via consumer group `halley:writers`, batches, and inserts to ClickHouse.
2. **Normalizer architecture.** Adapter trait, dialect detection, canonical schema, attribute preservation for unknown keys.
3. **`halley-raw` adapter.** Wraps the existing `RawSpan` shape. Acts as the canonical reference.
4. **OTEL GenAI adapter.** Maps OTEL GenAI semconv spans (current spec, attribute-based content) to canonical.
5. **OpenLLMetry adapter.** Maps `traceloop.*` and OpenLLMetry-flavored `gen_ai.*` to canonical.
6. **OTLP/HTTP receiver** on :4318 (protobuf and JSON).
7. **OTLP/gRPC receiver** on :4317.
8. **Property-based tests** for each adapter: round-trip identity on supported attributes, unknown attributes preserved.

## Explicitly out of scope

- OpenInference adapter (Week 4 Day 1).
- Vercel AI SDK adapter (Week 4 Day 2).
- Run grouping `is_run_root` flag (Week 4 Day 3).
- Prometheus metrics (Week 4 Day 4).
- DLQ stream wire-up (Week 4 Day 4).
- Load test (Week 4 Day 5).
- Compatibility matrix (Week 4 Day 6).
- Dashboard changes.
- TypeScript SDK.
- Testcontainers integration tests (Week 4 Day 4 if time, otherwise Phase 6).

---

## Architectural shape after Week 3

```
HTTP /v1/spans/json          (halley-raw dialect, JSON)
HTTP :4318/v1/traces         (OTLP HTTP, protobuf or JSON)
gRPC :4317                   (OTLP gRPC)
        │
        ▼
┌─────────────────────────┐
│ Receiver layer          │  decodes wire format → tonic_proto::Span or Halley RawSpan
└──────────┬──────────────┘
           ▼
┌─────────────────────────┐
│ Normalizer              │  detects dialect, picks adapter, produces CanonicalSpan
└──────────┬──────────────┘
           ▼
┌─────────────────────────┐
│ Body hashing            │  canonicalize JSON, SHA-256, produce ObservationRow + BodyRows
└──────────┬──────────────┘
           ▼
   XADD halley:spans  (Redis stream)
           │
           │  (tokio task in same binary, separate handle)
           ▼
   XREADGROUP halley:writers COUNT 500 BLOCK 100
           │
           ▼
   batch dedup + insert to ClickHouse
           │
           ▼
   XACK halley:spans
```

Two tokio tasks in one process: receiver(s) + writer. Same binary, same `cargo run`, same Dockerfile.

Module layout for `ingester/src/`:

```
src/
├── main.rs                  bootstrap: config, tracing, redis, ch, axum, tonic, writer
├── config.rs                + REDIS_URL, gRPC bind addr
├── errors.rs                IngestError (unchanged shape, new variants)
├── domain/
│   ├── mod.rs
│   ├── span.rs              RawSpan, ObservationRow, BodyRow, SpanStatus (existing)
│   └── canonical.rs         (new) CanonicalSpan = the normalizer's output type
├── normalizer/
│   ├── mod.rs               (new) Normalizer entry, dialect detection
│   ├── halley_raw.rs        (new) adapter for halley-raw RawSpan
│   ├── otel_genai.rs        (new) adapter for OTEL GenAI spec spans
│   └── openllmetry.rs       (new) adapter for OpenLLMetry-flavored spans
├── http/
│   ├── mod.rs
│   ├── health.rs
│   ├── spans.rs             /v1/spans/json (uses halley-raw normalizer now)
│   └── otlp.rs              (new) /v1/traces (OTLP HTTP, protobuf + JSON)
├── grpc/
│   └── otlp.rs              (new) tonic service for OTLP gRPC :4317
├── pipeline/
│   ├── mod.rs               (new)
│   ├── publisher.rs         (new) Redis Streams publisher (XADD)
│   └── writer.rs            (new) Redis Streams consumer + ClickHouse batch inserter
└── storage/
    └── clickhouse.rs        existing; insert_bodies/insert_observation become batch-friendly
```

---

## Day-by-day plan

### Day 1: Redis Streams pipeline (refactor only, no new receivers)

**Why first**: changing the data path while OTLP receivers are also being added is double the variables.

Work:

1. Add `redis = { version = "0.27", features = ["tokio-comp", "streams"] }` to `Cargo.toml`. If 0.27 demands Rust 1.84+, pick the latest version that supports 1.83. Document in DECISIONS.md.

2. Add `REDIS_URL` to `Config` (already in `.env.example` from Week 1).

3. New module `pipeline/publisher.rs`:
   ```rust
   pub struct Publisher {
       client: redis::Client,
   }
   impl Publisher {
       pub async fn new(url: &str) -> Result<Self, ...> { ... }
       pub async fn publish(&self, obs: &ObservationRow, bodies: &[BodyRow]) -> Result<(), ...>;
   }
   ```
   Publishes one stream entry per span. Encoding: bincode or postcard for the `(ObservationRow, Vec<BodyRow>)` tuple. Document the choice in DECISIONS.md.

4. New module `pipeline/writer.rs`:
   ```rust
   pub struct Writer {
       redis: redis::Client,
       ch: ClickHouseStore,
   }
   pub async fn run(&self, shutdown: tokio::sync::watch::Receiver<bool>) -> ...;
   ```
   Loop: `XREADGROUP halley:writers COUNT 500 BLOCK 100 STREAMS halley:spans >`. Decode each entry. Dedup body hashes within the batch (same hash appearing twice in one batch only inserts once). Insert bodies and observations as separate batch inserts. `XACK` on success.

5. `main.rs`: spawn the writer task alongside axum. Use `tokio::sync::watch` for graceful shutdown signaling. The writer must drain in-flight messages before exiting.

6. `http/spans.rs`: stop calling `state.ch.insert_*` directly. Now calls `state.publisher.publish(...)`.

7. Smoke test must still pass (the test asserts what's in ClickHouse, which now arrives via the Redis path). Note: the writer's batch flushes every 100ms or 500 entries, so the smoke test's `sleep 1` after POST is still sufficient.

**Acceptance Day 1**:
- `make smoke` passes 9/9.
- Stop ClickHouse mid-test → spans accumulate in Redis stream → restart ClickHouse → writer drains the stream.
- `redis-cli XLEN halley:spans` shows 0 after the writer drains.
- A graceful shutdown (`docker compose stop ingester`) does not lose any in-flight spans.

### Day 2: Normalizer architecture + halley-raw adapter + OTEL GenAI adapter

**Why this order**: the architecture has to land before either adapter; halley-raw is near-identity and proves the architecture; OTEL GenAI is the canonical baseline that all other adapters reference.

Work:

1. New `domain/canonical.rs`:
   ```rust
   pub struct CanonicalSpan {
       // identity
       pub trace_id: [u8; 16],
       pub span_id: [u8; 8],
       pub parent_span_id: Option<[u8; 8]>,
       // time
       pub start_time_unix_nano: u64,
       pub end_time_unix_nano: u64,
       // dialect provenance
       pub source_dialect: String,
       pub dialect_version: String,
       // gen_ai fields
       pub gen_ai_system: String,
       pub gen_ai_operation: String,
       pub gen_ai_request_model: String,
       pub gen_ai_response_model: String,
       pub gen_ai_usage_input_tokens: u32,
       pub gen_ai_usage_output_tokens: u32,
       pub gen_ai_response_finish_reason: String,
       // bodies (still serde_json::Value at this layer; hashing happens later)
       pub input_body: Option<serde_json::Value>,
       pub output_body: Option<serde_json::Value>,
       pub tool_input: Option<serde_json::Value>,
       pub tool_output: Option<serde_json::Value>,
       pub tool_name: String,
       pub tool_side_effect: String,
       // run / project
       pub project_id: Uuid,
       pub run_name: String,
       pub run_tags: Vec<String>,
       pub run_env: String,
       pub pricing_version_id: Uuid,
       // status
       pub status: SpanStatus,
       pub error_message: String,
       // unknown keys preserved verbatim
       pub attributes: BTreeMap<String, String>,
   }
   ```

2. New `normalizer/mod.rs`:
   ```rust
   pub trait Adapter: Send + Sync {
       fn dialect_id(&self) -> &'static str;
       fn detect(&self, span: &OtlpSpan) -> bool;
       fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError>;
   }

   pub struct Normalizer {
       adapters: Vec<Box<dyn Adapter>>,
   }
   impl Normalizer {
       pub fn new() -> Self { /* register halley_raw, otel_genai, openllmetry, ... */ }
       pub fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError>;
   }
   ```
   `OtlpSpan` is a generic input type that holds OTLP attribute key-value map plus the raw span fields. For Day 2 this can be `opentelemetry_proto::tonic::trace::v1::Span` once we add the OTLP receiver in Day 3, or a hand-rolled struct in the meantime. Pick one: hand-rolled `OtlpSpan` struct that the receiver layers will populate. Document choice in DECISIONS.md.

3. `normalizer/halley_raw.rs`: detect by `source_dialect = "halley-raw"`, normalize is near-identity.

4. `normalizer/otel_genai.rs`: detect by presence of `gen_ai.system` attribute. Map per the spec:
   | Canonical field | OTEL GenAI attribute |
   |---|---|
   | gen_ai_system | `gen_ai.system` |
   | gen_ai_operation | `gen_ai.operation.name` |
   | gen_ai_request_model | `gen_ai.request.model` |
   | gen_ai_response_model | `gen_ai.response.model` |
   | gen_ai_usage_input_tokens | `gen_ai.usage.input_tokens` |
   | gen_ai_usage_output_tokens | `gen_ai.usage.output_tokens` |
   | gen_ai_response_finish_reason | `gen_ai.response.finish_reasons[0]` |

   Content (input_body, output_body): per the spec, content lives in span events (`gen_ai.user.message`, `gen_ai.system.message`, `gen_ai.assistant.message`, `gen_ai.choice`). For Week 3, support content via attributes too (older instrumentations) as a fallback. Document precedence: events first, then attributes.

5. `http/spans.rs`: route through `Normalizer` instead of calling `ObservationRow::try_from(RawSpan)` directly. The handler becomes "decode JSON to RawSpan → wrap as OtlpSpan → normalize → hash → publish".

6. Property tests (proptest) under `ingester/tests/` or `ingester/src/normalizer/{adapter}.rs`:
   - `prop_halley_raw_round_trip`: arbitrary `RawSpan` → through halley_raw normalizer → resulting `CanonicalSpan` carries the same gen_ai fields.
   - `prop_otel_genai_unknown_attrs_preserved`: arbitrary OTLP attributes including unknown keys → unknown keys end up in `CanonicalSpan.attributes`.

**Acceptance Day 2**:
- All existing tests still pass.
- `cargo test` includes the new property tests; all pass.
- `make smoke` passes 9/9.
- Posting hello-span.json still works (now via halley_raw adapter).

### Day 3: OTLP/HTTP receiver on :4318

Work:

1. Add to `Cargo.toml`:
   ```toml
   prost = "0.13"
   opentelemetry-proto = { version = "0.27", features = ["gen-tonic", "trace"] }
   ```
   Pin the exact compatible versions. If MSRV demands a Rust bump, document in DECISIONS.md.

2. New module `http/otlp.rs`:
   - Route: `POST /v1/traces`.
   - Content-Type negotiation: `application/x-protobuf` → decode with prost; `application/json` → decode with serde_json (OTLP JSON encoding).
   - Iterate `ResourceSpans → ScopeSpans → Span`, normalize each, hash, publish.
   - Response shape: OTLP requires a `ExportTraceServiceResponse` with optional partial success info. For Week 3, return `{}` (success) on full acceptance; OTLP clients accept this.

3. Wire route in `http/mod.rs`. Same TraceLayer, same AppState.

4. Smoke test: add one assertion that a protobuf-encoded OTLP request works. Use a pre-built fixture file `ingester/fixtures/otlp-genai-trace.bin` containing a single OTEL GenAI span. To keep it deterministic, generate the fixture once via a small Rust test helper and check it into the repo.

**Acceptance Day 3**:
- `curl -X POST -H 'Content-Type: application/x-protobuf' --data-binary @otlp-genai-trace.bin http://localhost:4318/v1/traces` returns 200 with `{}`.
- The corresponding ClickHouse row appears with `source_dialect = "otel-genai"`.
- `cargo test` passes.

### Day 4: OpenLLMetry adapter + property tests

Work:

1. `normalizer/openllmetry.rs`. OpenLLMetry uses `gen_ai.*` attributes (sometimes) plus its own `traceloop.*` namespace. Detection: presence of `traceloop.*` attribute, or specific OpenLLMetry-flavored span names. From the Day 4 research notes, OpenLLMetry instrumentations emit `gen_ai.system` plus `traceloop.entity.name`, `traceloop.workflow.name`, etc.
   - Map `traceloop.entity.name` → `run_name` if `run_name` is empty.
   - Map `traceloop.span.kind` → influence `gen_ai_operation` if not set.
   - Preserve all `traceloop.*` keys in `CanonicalSpan.attributes`.

2. Property tests for the OpenLLMetry adapter, same shape as OTEL GenAI's.

3. Update detection priority in `normalizer/mod.rs`: try halley-raw → openllmetry (more specific) → otel-genai (fallback). Document the priority in a code comment and DECISIONS.md.

4. Update the smoke test to include one OpenLLMetry-shaped span in the assertions.

**Acceptance Day 4**:
- `cargo test` passes including new property tests.
- `make smoke` passes (all assertions, including OpenLLMetry).
- A span with both `gen_ai.system` and `traceloop.entity.name` lands as `source_dialect = "openllmetry"`.

### Day 5: OTLP/gRPC receiver on :4317

Work:

1. Add to `Cargo.toml`:
   ```toml
   tonic = "0.13"
   ```
   And the gRPC feature on `opentelemetry-proto`. Pin compatible versions.

2. `build.rs` is not needed if we use `opentelemetry-proto`'s pre-generated tonic code (`gen-tonic` feature). Confirm and document.

3. New module `grpc/otlp.rs`:
   - Implements `TraceServiceServer` from opentelemetry-proto.
   - `export()` method: same body as the HTTP handler — iterate spans, normalize, hash, publish.

4. `main.rs`: spawn the tonic server as a third tokio task (alongside axum and the writer). Use a separate `bind` address from config (`INGESTER_GRPC_ADDR=0.0.0.0:4317`).

5. `docker-compose.yml`: expose port 4317.

6. Add to `.env.example`: `INGESTER_GRPC_ADDR=0.0.0.0:4317`.

7. Smoke test: one assertion that gRPC ingest works. Use `grpcurl` if available in the smoke test environment, or a tiny Rust test client. Keep it minimal — the property tests cover correctness; the smoke test just confirms the wire works.

**Acceptance Day 5**:
- gRPC ingester accepts a known-good OTLP payload over :4317.
- The resulting ClickHouse row matches what the HTTP receiver produces for an equivalent payload (same canonical fields).
- `make smoke` passes.

### Day 6 (short, ~2 hrs): Polish, retro, commit

- `cargo fmt`, `cargo clippy --all-targets -- -D warnings` clean.
- `make smoke` passes from a clean boot.
- Compose stack still healthy: 5 services + 2 migration containers (ingester is one process exposing two ports).
- Write `## Week 3 retro` at the bottom of this file.
- Stop. Do not start Week 4.

---

## Specific risks and how to handle them

1. **Tonic / prost MSRV.** May force a Rust toolchain bump beyond 1.83. If so: bump rust-toolchain.toml, update D1 with the rationale, run `cargo update` to walk the D21 ICU pins forward (most should now be on the same MSRV as our new floor), document the deltas. Time impact: ~1-2 hrs on Day 1.

2. **OTLP attribute encoding.** OTLP attribute values are `AnyValue` (a oneof of String, Bool, Int, Double, Array, Kvlist, Bytes). The normalizer needs a small helper to extract typed values. Pre-write this helper before adapter code.

3. **Body content in OTLP GenAI.** Per the spec (and the Day 4 research), content can live in span events OR attributes (depending on instrumentation version). Adapter must handle both. Add a unit test for each path.

4. **Redis Streams encoding.** The choice between bincode and postcard matters less than committing to one. Pick bincode (more widely used, slightly larger payloads). Re-evaluate in Week 4 if Redis bandwidth is a load-test bottleneck.

5. **Writer batching with mixed body hashes.** The current Phase 1 insert path inserts bodies one at a time. Phase 2 batches up to 500. The dedup logic (insert each unique hash exactly once per batch) is straightforward but worth a unit test.

6. **Smoke test growth.** It is at 9 assertions. Resist the urge to grow it to 30 — the property tests cover correctness; the smoke test is a wire check. Add only one assertion per Day (Day 3 OTLP HTTP, Day 4 OpenLLMetry, Day 5 OTLP gRPC). Final count: 12.

---

## Common pitfalls to avoid

1. **Do not change the canonical schema.** `CanonicalSpan` matches `RawSpan` 1:1 by design. Phase 4 may add fields; Phase 2 does not.

2. **Do not break the smoke test as you go.** Run it after every Day's work. If it fails, fix it before moving on.

3. **Do not add optional features to crates speculatively.** `redis` has many features; we only need `tokio-comp` and `streams`. `opentelemetry-proto` has many; we need `gen-tonic` and `trace`. Keep the dep tree small.

4. **Do not run the writer task on the same tokio thread as the receiver.** Use `tokio::spawn`. The receiver returning 202 quickly is the customer-facing latency; if the writer blocks the same task, latency spikes during ClickHouse hiccups.

5. **Do not store raw OTLP protobuf bytes in ClickHouse.** Bodies are content (LLM messages), not the wire format. The adapter extracts content from OTLP events/attributes into `serde_json::Value` and the existing canonical-JSON hashing takes over.

6. **Do not implement run grouping (`is_run_root`) in Week 3.** That's Week 4 Day 3. Adding columns mid-pipeline-refactor adds variables.

7. **Do not skip property tests.** They're the acceptance criterion the ROADMAP commits to. Every adapter gets at least: round-trip identity on supported attrs + unknown-attrs preserved.

---

## Reviewer checklist

### Architecture
- [ ] `pipeline/publisher.rs` and `pipeline/writer.rs` exist; the HTTP handler does not call ClickHouse directly.
- [ ] Stop ClickHouse, post 100 spans, restart ClickHouse, see all 100 land in observations after writer drains.
- [ ] Graceful shutdown does not lose in-flight spans.
- [ ] Two new tokio tasks (writer, gRPC server) running alongside axum.

### OTLP receivers
- [ ] `POST :4318/v1/traces` accepts both `application/x-protobuf` and `application/json` payloads.
- [ ] gRPC :4317 accepts `TraceServiceServer.Export` calls.
- [ ] Same logical span via HTTP and gRPC produces identical canonical rows.

### Normalizer
- [ ] `Adapter` trait with at least three implementations: halley-raw, otel-genai, openllmetry.
- [ ] Detection priority documented in code and DECISIONS.md.
- [ ] Unknown attributes preserved in `CanonicalSpan.attributes`.

### Property tests
- [ ] `cargo test` includes property tests for each adapter.
- [ ] Round-trip identity test for each adapter passes.
- [ ] Unknown-attrs-preserved test for each adapter passes.

### Smoke test
- [ ] `make smoke` passes (12 assertions: 9 existing + OTLP HTTP + OpenLLMetry + OTLP gRPC).
- [ ] `make smoke` is idempotent.

### Build hygiene
- [ ] `cargo build` clean.
- [ ] `cargo clippy --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --check` clean.
- [ ] No new dependencies added beyond: redis, prost, opentelemetry-proto, tonic, proptest.

### DECISIONS.md
- [ ] D26: Redis stream entry encoding (bincode vs postcard, rationale).
- [ ] D27: Normalizer adapter detection priority.
- [ ] D28: tonic/prost/opentelemetry-proto versions and any MSRV implications.
- [ ] D29 (if applicable): Rust toolchain bump rationale.

### Non-goals respected
- [ ] No `is_run_root` column added (Week 4).
- [ ] No `/metrics` endpoint (Week 4).
- [ ] No DLQ stream consumer (Week 4 — DLQ stream may exist as a target but no consumer yet).
- [ ] No load test (Week 4).
- [ ] No OpenInference or Vercel AI SDK adapters (Week 4).
- [ ] No dashboard changes.

---

## When to stop

Week 3 is done when every checkbox above passes. If it finishes early, do not start Week 4. Use the time to deepen the property tests, polish docstrings, or re-run the smoke test under load (`for i in $(seq 1 1000); do curl ...; done`) to find races. Write the Week 3 retro at the bottom of this file.
