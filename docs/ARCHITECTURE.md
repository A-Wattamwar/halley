# Halley — Architecture

Version: 0.1 (May 13, 2026)
Owner: Ayush Wattamwar

This document describes Halley's system design: what each component does, how data flows through it, the storage model, and why each technical choice was made. It is the engineering truth-base of the project. If we change anything major during the build, we update this file first and the code second.

---

## 1. Problem statement

Modern LLM applications are **agents**: they plan, retrieve context, call tools, handle errors, retry, and often loop. Existing observability tools model traces as flat parent-child lists of LLM calls, which forces developers to reconstruct the reasoning of an agent run by reading JSON. Halley models the agent run itself as the primary object. Every view in the product — search, debug, evaluate, bill — is centered on agent runs, not on individual LLM calls.

### 1.1 Non-goals

- Not an LLM gateway. We don't proxy LLM calls; we observe them after the fact.
- Not a prompt-management tool. We don't version prompts for you.
- Not a training-data pipeline. We don't help fine-tune models.
- Not multi-tenant SaaS in v1. Self-hosted, single-workspace only.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Customer AI application                          │
│    (OpenAI SDK / Anthropic SDK / LangChain / custom agent framework)     │
│                                                                           │
│    Instrumented via OpenTelemetry (OpenLLMetry, @halley/sdk, or manual)  │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  OTLP/gRPC on :4317
                             │  OTLP/HTTP on :4318 (JSON or protobuf)
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   Halley Ingester  (Rust, axum + tonic)                   │
│  • Accepts OTLP over gRPC and HTTP                                        │
│  • Validates + normalizes GenAI semantic-convention attributes             │
│  • Groups spans into agent runs using trace_id + run heuristics           │
│  • Enriches spans (cost per 1K tokens, latency rollups)                   │
│  • Writes to Redis Streams for buffering                                  │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  XADD halley:spans *
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            Redis Streams (buffer)                          │
│  • Durable ordered queue, consumer groups, backpressure, replay           │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  XREADGROUP halley:writers
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Halley Writer  (Rust, part of ingester binary)       │
│  • Reads batches of 500 spans or every 100ms                              │
│  • Batch-inserts into ClickHouse                                          │
│  • Acks Redis Streams on successful write                                 │
│  • Dead-letters malformed rows to local disk                              │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ClickHouse  (traces, spans, runs)     │   Postgres  (auth, projects,     │
│  columnar, compressed, query-optimized │   eval suites, api keys, configs)│
└────────────────────────────┬───────────┴──────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   Halley Dashboard  (Next.js 14, App Router)              │
│  • Server Components read ClickHouse + Postgres directly                  │
│  • WebSocket subscribes to Redis Pub/Sub for live run updates             │
│  • Replay/fork jobs run in BullMQ (Redis) → worker container              │
│  • Auth via Auth.js with Postgres adapter                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Data flow in one sentence

Your agent emits OpenTelemetry spans → Halley's Rust ingester validates and normalizes them into a GenAI-aware schema → Redis Streams buffers → the writer batches them into ClickHouse → the dashboard reads from ClickHouse and streams live updates from Redis Pub/Sub.

---

## 3. Components

### 3.1 Halley SDK (TypeScript)

A thin wrapper over OpenTelemetry's JS SDK that ships with sensible defaults for AI apps.

**Responsibilities:**
- Initialize an OTEL tracer pointed at the Halley ingester endpoint.
- Auto-instrument `openai`, `@anthropic-ai/sdk`, `@langchain/*`, and the Vercel AI SDK using the existing OpenLLMetry instrumentation packages, so users don't hand-write instrumentation.
- Expose helper functions: `halley.run(name, fn)`, `halley.step(name, fn)`, `halley.feedback(runId, score, comment)`.
- Batch and flush spans using OTEL BatchSpanProcessor with exponential-backoff retries.
- Offline queueing: hold up to 10,000 spans in memory, spill to local disk on overflow (Node.js only).

**Non-responsibilities:**
- No custom wire protocol. The SDK speaks OTLP. All transport logic lives in the official OTEL SDK.
- No metric collection in v1. Spans only.

### 3.2 Ingester (Rust)

A single Rust binary with two threads-of-work: an OTLP receiver and a ClickHouse writer. Packaged as one process to keep deploys simple; could split later.

**Responsibilities:**
- Terminate OTLP/gRPC on port 4317 (`tonic`) and OTLP/HTTP on port 4318 (`axum`).
- Decode protobuf messages using `opentelemetry-proto` crate.
- Validate that spans match the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/): `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc. Reject malformed spans with a structured error.
- Compute derived fields: dollar cost (from a per-model pricing table), duration in ms, whether the span is a tool call, LLM call, retrieval, or agent-control span.
- Group spans into agent runs. Logic: a span is the root of an agent run if it has `gen_ai.operation.name = "invoke_agent"` or if it has no parent and a `halley.run.kind = "agent"` attribute. All descendant spans inherit the run ID.
- Publish each processed span onto a Redis Stream `halley:spans`.

**Non-responsibilities:**
- No business logic (cost alerts, eval scoring). That lives in the dashboard/worker.
- No long-term storage. Ingester is stateless aside from in-flight buffers.

### 3.3 Writer (Rust, same binary)

**Responsibilities:**
- Read from `halley:spans` via a Redis consumer group (`halley:writers`), so multiple writer instances can scale horizontally.
- Batch spans: flush on either 500 spans or 100ms, whichever hits first.
- Insert into ClickHouse using the native TCP protocol via `clickhouse-rs`.
- On success, acknowledge (`XACK`) the messages so Redis can trim the stream.
- On persistent failure (ClickHouse down, malformed row): dead-letter to a local file `/var/halley/dlq/<date>.jsonl` and continue.

### 3.4 Redis

Used in three roles. We accept the operational cost of running one Redis because these three responsibilities are naturally co-located and it simplifies ops.

| Role | Key / pattern | Purpose |
|---|---|---|
| Stream buffer | `halley:spans` | Smooth out ingest spikes; enable consumer-group scaling of writers |
| Pub/sub | `halley:run:<run_id>` | Push live span updates to WebSocket-connected dashboard clients |
| Job queue | `halley:jobs:replay`, `halley:jobs:eval` | BullMQ-backed background work: replay/fork, evaluation runs |

### 3.5 ClickHouse

The primary data store. Holds the high-cardinality, high-volume, append-only telemetry.

**Why ClickHouse over Postgres/TimescaleDB:**
- Columnar storage gives massive compression on repetitive fields (model names, project IDs).
- Aggregations over billions of spans (cost by model over 30 days) run in tens of milliseconds.
- Designed for exactly this workload — Cloudflare, Uber, eBay, and Sentry use it for observability.
- Native tiered storage and TTL policies let us expire old traces cheaply.

**Trade-off accepted:** ClickHouse is not good at UPDATE-heavy workloads. We work around this by making every table append-only and using `ReplacingMergeTree` where we need mutation semantics (e.g., post-hoc feedback scores on a run).

### 3.6 Postgres

Holds everything that is *not* telemetry and *is* update-heavy: users, projects, API keys, evaluation suite definitions, eval run metadata, replay job records. Small data, transactional, benefits from SQL constraints. Single-digit GB forever.

### 3.7 Dashboard (Next.js 14)

The user-facing product.

**Key views:**
1. **Runs list** — infinite-scroll table of agent runs. Columns: run ID, started at, duration, total cost, step count, status, tags. Filters: project, model, status, cost range, time range, free-text on prompts.
2. **Run detail** — the reasoning graph. Timeline view on top, graph view below. Click any node → see the full prompt, response, tool call input, tool call output, token counts, cost. Keyboard nav between steps.
3. **Live runs** — WebSocket-streamed, updates in real time as spans arrive. Useful during development.
4. **Evaluations** — create an eval suite, run it against any project, see pass/fail matrix and score trends over time.
5. **Costs** — dollars grouped by model, project, tag, day. Alerts.
6. **Settings** — API keys, team members (stub for v1), per-project config.

**Rendering strategy:**
- Server Components for data-heavy static views (runs list, cost charts). Direct ClickHouse queries in server components.
- Client Components only where needed (the graph canvas, keyboard shortcuts, WebSocket subscriptions, forms).

### 3.8 Worker (Node.js)

A separate process that consumes BullMQ jobs for long-running operations so the dashboard stays responsive.

**Jobs:**
- **Replay/fork**: load a past run from ClickHouse, replay it from step N with user-provided overrides (new prompt, new model, injected tool response), emit new spans back into the ingester pipeline.
- **Eval run**: execute an evaluation suite against a project over a given time range, score each run, write results to Postgres.

---

## 4. Data model

The core concept: a **Run** is a tree of **Spans**. A span is a single observable step (an LLM call, a tool call, a retrieval, an agent-level control step). A run groups related spans into one logical agent execution.

### 4.1 ClickHouse schema (sketch)

```sql
-- One row per span. Append-only. Partitioned by day.
CREATE TABLE halley.spans (
  span_id            UUID,
  trace_id           UUID,
  parent_span_id     Nullable(UUID),
  run_id             UUID,                      -- derived, groups spans into agent run
  project_id         UUID,

  -- Timing
  start_time         DateTime64(6, 'UTC'),
  end_time           DateTime64(6, 'UTC'),
  duration_ms        UInt32 MATERIALIZED dateDiff('millisecond', start_time, end_time),

  -- GenAI semantic convention fields
  gen_ai_system      LowCardinality(String),    -- "openai", "anthropic", "cohere"
  gen_ai_operation   LowCardinality(String),    -- "chat", "embeddings", "execute_tool", "invoke_agent"
  gen_ai_request_model   LowCardinality(String),
  gen_ai_response_model  LowCardinality(String),
  gen_ai_usage_input_tokens   UInt32,
  gen_ai_usage_output_tokens  UInt32,
  gen_ai_response_finish_reason  LowCardinality(String),

  -- Content (can be large, stored separately from hot-path columns)
  input_messages     String CODEC(ZSTD(3)),     -- JSON array
  output_messages    String CODEC(ZSTD(3)),     -- JSON array
  tool_name          LowCardinality(String),
  tool_input         String CODEC(ZSTD(3)),
  tool_output        String CODEC(ZSTD(3)),

  -- Derived
  cost_usd           Decimal(12, 6),
  status             Enum8('ok' = 1, 'error' = 2, 'timeout' = 3),
  error_message      String,

  -- Arbitrary user attributes
  attributes         Map(String, String),
  tags               Array(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, run_id, start_time, span_id)
TTL start_time + INTERVAL 30 DAY;

-- Rollup table: one row per run, updated as spans arrive.
CREATE TABLE halley.runs (
  run_id             UUID,
  project_id         UUID,
  started_at         DateTime64(6, 'UTC'),
  ended_at           DateTime64(6, 'UTC'),
  status             Enum8(...),
  span_count         UInt32,
  total_cost_usd     Decimal(12, 6),
  total_input_tokens UInt64,
  total_output_tokens UInt64,
  root_span_name     String,
  tags               Array(String),
  user_feedback_score Nullable(Int8),          -- filled in later → needs ReplacingMergeTree
  user_feedback_comment String
)
ENGINE = ReplacingMergeTree(ended_at)
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (project_id, run_id);
```

### 4.2 Postgres schema (sketch)

Full SQL lives in `infra/postgres/migrations/`. Entities:

- `users` — id, email, password hash, created_at
- `projects` — id, name, slug, owner_id, created_at
- `api_keys` — id, project_id, hash, last_used_at
- `eval_suites` — id, project_id, name, definition_json
- `eval_runs` — id, suite_id, started_at, status, scores_summary_json
- `replay_jobs` — id, source_run_id, overrides_json, status, new_run_id

---

## 5. Critical flows

### 5.1 Ingest flow (hot path)

```
Customer app
  └─ OTEL span exported
     └─ OTLP/gRPC to ingester:4317
        └─ tonic handler decodes protobuf
           └─ Validate → normalize → enrich (cost)
              └─ XADD halley:spans
                 └─ ACK to exporter (200 OK)

Writer (async)
  └─ XREADGROUP halley:writers COUNT 500 BLOCK 100
     └─ Batch insert into clickhouse.halley.spans
        └─ On success: XACK
        └─ On failure: retry 3× with backoff, then DLQ

Target: P99 ingest latency (customer call → 200 OK) < 50 ms on a single node.
Target: Sustain 10,000 spans/sec on a 4-core, 8 GB VM.
```

### 5.2 Live dashboard flow

```
Customer span → ingester → Redis Stream → ClickHouse (durable)
              ↘ Redis Pub/Sub channel halley:run:<run_id>
                      ↓
Dashboard: user opens run detail page
  └─ Next.js Server Component loads historical spans from ClickHouse
  └─ Client Component subscribes via WebSocket to /api/ws/runs/:id
     └─ API route subscribes to halley:run:<run_id>
        └─ Forwards each new span to client
           └─ UI inserts into reasoning graph in real time
```

### 5.3 Replay/fork flow

```
User clicks "Fork from this step" on a span
  └─ Dashboard POSTs to /api/replay with {source_run_id, fork_span_id, overrides}
     └─ Insert row in postgres.replay_jobs
     └─ Enqueue BullMQ job

Worker picks up job
  └─ Load source run's spans up to fork_span_id from ClickHouse
  └─ Reconstruct execution state
  └─ Apply user overrides (new prompt, new model, injected tool response)
  └─ Execute remaining agent logic, emitting new spans to ingester
  └─ Update postgres.replay_jobs.status = "done"
  └─ Dashboard polls or WebSocket-notifies → shows new run side-by-side with original
```

### 5.4 Evaluation flow

```
User defines eval suite in dashboard
  └─ Stored in postgres.eval_suites
  └─ Definition: dataset of (input, expected_output_or_rubric) pairs + scoring config

User triggers eval run
  └─ Worker job spawned
  └─ For each (input, expected) pair:
      - Execute the target agent (user-provided endpoint) with the input
      - Capture the produced run_id
      - Score: exact-match OR embedding-similarity OR LLM-as-judge OR custom JS
  └─ Aggregate scores, write to postgres.eval_runs.scores_summary_json
  └─ Regression detection: compare aggregate score to last N runs; alert if below threshold
```

---

## 6. Key design decisions (why X over Y)

### 6.1 OpenTelemetry over custom wire protocol
Every serious competitor is OTEL-native now. Using OTLP means any app already instrumented with OpenLLMetry, LangChain callbacks, or OpenAI SDK auto-instrumentation becomes a Halley user by changing one env var. The alternative — a custom SDK and custom protocol — would cost us users and force us to re-write instrumentation we'd get for free.

### 6.2 ClickHouse over TimescaleDB / Postgres / Druid
TimescaleDB: Postgres-backed, fine for 10M rows, chokes at 10B. Columnar compression is weaker.
Druid: Operationally heavier, harder to run on a single node. Better at real-time aggregations but worse at raw trace lookup.
ClickHouse: Industry default for observability-scale data. Good single-node operability. Excellent SQL surface.

### 6.3 Redis Streams over Kafka
Kafka: Overkill for our scale in v1, ops-heavy, adds a ZooKeeper/KRaft dependency.
Redis Streams: Already running Redis for pub/sub and job queue; Streams gives us durable ordered delivery with consumer groups. Good enough for 10k-100k spans/sec on a single Redis node. If we outgrow it, migrating to Kafka is a well-worn path.

### 6.4 Rust for ingester, Node.js for worker
Ingester is the hot path — network I/O, protobuf decoding, batching. Rust gives us predictable tail latency and the best story for "I wrote a real systems service." Worker jobs are bursty and call external HTTP (LLM APIs), where Node's async model is ergonomic and Rust's advantages don't matter.

### 6.5 Next.js 14 with Server Components over SPA
Traces are read-heavy and server-rendered content is faster for the trace list and detail views. Client Components only where interactivity demands it (graph canvas, live updates).

### 6.6 Auth.js with Postgres adapter over Clerk/Supabase Auth
Self-hosted product, self-hosted auth. No external vendor to stand up. Auth.js + Postgres is boring and correct.

### 6.7 Single binary for ingester + writer
Simplifies local dev and first-time deploy. Tokio's task model makes the separation purely logical, not process-level. Splitting later (when horizontal writer scaling becomes necessary) is a day of work, not a week.

---

## 7. Operations

### 7.1 Local development
`docker compose up` in the repo root starts ClickHouse, Redis, Postgres, the ingester, the worker, and the Next.js dashboard with hot-reload. The RAG tutor and LLM reasoning agent (Ayush's own projects) will be wired in as example customers.

### 7.2 Observability of Halley itself
The ingester exposes Prometheus metrics on `/metrics`:
- `halley_ingest_requests_total{status}`
- `halley_ingest_latency_seconds{method}`
- `halley_writer_batch_size`
- `halley_writer_flush_latency_seconds`
- `halley_redis_stream_lag`
- `halley_clickhouse_insert_errors_total`

Structured JSON logs via `tracing` crate. Correlation IDs propagate from OTLP request → Redis Stream entry → ClickHouse row for end-to-end debugging.

### 7.3 Deployment (post-launch)
Docker Compose for self-hosters. Helm chart for Kubernetes users is a stretch goal for Phase 6.

---

## 8. Security model (v1 scope)

- API keys are stored as SHA-256 hashes in Postgres; keys are only shown to users once at creation.
- Incoming OTLP requests must carry a valid API key in an `Authorization: Bearer` header (or gRPC metadata).
- Dashboard auth via Auth.js with email/password and optional OAuth providers.
- No multi-tenant isolation in v1 — single organization per deployment. Multi-tenancy is a post-v1 concern.
- Content fields (prompts, completions, tool I/O) may contain PII. We store them as-is in v1 but expose a per-project `sample_content_pct` setting so teams can opt out of content storage and keep metadata only.

---

## 9. What is explicitly NOT in the v1 scope

These are cut for the 12-week build. Some become stretch goals.

- Full OpenTelemetry conformance certification (we'll target the spec but not exhaustively test every edge case)
- Kubernetes Helm chart (stretch, Phase 6)
- Hosted SaaS tier (post-launch)
- Multi-team / workspace RBAC (post-launch)
- Mobile-responsive dashboard beyond "usable on iPad"
- Log signal (we do spans only, not logs or metrics as first-class signals)
- SAML / SSO
- Prompt-management features (we're observability, not prompt tooling)

---

## 10. Revision log

| Date | Change | Why |
|---|---|---|
| 2026-05-13 | Initial version | Project kickoff |
