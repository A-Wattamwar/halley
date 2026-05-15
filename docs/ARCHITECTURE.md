# Halley — Architecture

Version: 0.2 (May 13, 2026)
Owner: Ayush Wattamwar

This document describes Halley's system design: what each component does, how data flows through it, the storage model, and why each technical choice was made. It is the engineering truth base of the project. If anything major changes during the build, we update this file first and the code second.

> For a worked concrete example of the problem Halley solves and what the loop looks like in practice, read [`SCENARIO.md`](SCENARIO.md) first.

---

## 1. Problem statement

Teams shipping LLM agents to production hit three walls repeatedly.

1. **Test runs cost real money.** Every CI invocation that calls live LLM APIs is a line item. Iteration speed collides with the bill.
2. **Customer-reported bugs are unreproducible.** The agent run is gone. Even if captured, the model behind it has moved.
3. **Regressions are silent.** A prompt edit, a framework upgrade, or a provider model bump degrades behavior in ways no error log catches. Teams lose revenue before they notice.

Existing LLM observability tools (Langfuse, Laminar, LangSmith, Phoenix, Helicone, Braintrust) record traces and ship dashboards. None of them close the loop from "this production run happened" back into "our CI will catch this next time." That closed loop is Halley's reason to exist.

### 1.1 The hero capability

Halley converts any production agent run into a **cassette**: a bit-fidelity recording of every LLM call, tool call, and intermediate payload. From a cassette Halley infers a set of **invariants** (structural, schema, metric, optional semantic) and promotes the combination into a **fixture** stored in the user's repository under `halley/fixtures/`. Running `halley ci` replays the fixture library against the current code at zero LLM cost when cassettes match, and in hybrid mode (tool responses cached, only drifted LLM calls go live) when prompts or models change. When a fixture fails, Halley bisects across recent commits and names the change that broke it.

### 1.2 Non-goals

- Not an LLM gateway. Halley does not proxy live calls.
- Not a prompt-management tool. No prompt versioning UI, no prompt A/B runner.
- Not a training pipeline. No fine-tuning, no SFT data prep.
- Not multi-tenant SaaS in v1. Self-hosted, single organization per deployment.
- Not a browser-agent session recorder. Laminar owns that; we do not compete.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Customer AI application                          │
│   (OpenAI SDK / Anthropic SDK / LangChain / Vercel AI SDK / custom)      │
│   Instrumented via OpenLLMetry, OpenInference, OTEL GenAI, or @halley/sdk │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  OTLP/gRPC  :4317
                             │  OTLP/HTTP  :4318  (protobuf or JSON)
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   Halley Ingester  (Rust, axum + tonic)                   │
│  • Accepts OTLP over gRPC and HTTP                                        │
│  • Normalizes per-source attributes into Halley's canonical schema         │
│  • Captures cassette payload (raw request/response bodies)                │
│  • Groups spans into agent runs via four-tier heuristic                   │
│  • Publishes to Redis Streams                                             │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  XADD halley:spans *
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            Redis Streams (buffer)                          │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │  XREADGROUP halley:writers
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       Halley Writer  (same Rust binary)                    │
│  • Batches 500 rows or every 100 ms                                       │
│  • Writes observations (thin columns) to ClickHouse                       │
│  • Writes cassette payloads (raw bodies) to ClickHouse contents table      │
│  • ACKs on success, dead-letters to Redis DLQ stream on failure           │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │
        ┌────────────────────┴───────────────────┐
        ▼                                        ▼
┌────────────────────────────┐     ┌────────────────────────────────────────┐
│  ClickHouse                │     │  Postgres                              │
│  • halley.observations     │     │  • users, projects, api_keys           │
│  • halley.observation_body │     │  • fixture_metadata (pointer to repo)   │
│  • halley.pricing_versions │     │  • bisect_jobs                         │
└────────────────────────────┘     └────────────────────────────────────────┘
        │                                        │
        └────────────────────┬───────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   Halley Dashboard  (Next.js 14, App Router)              │
│  • Runs list, run detail with reasoning graph                             │
│  • "Turn this run into a test" flow                                       │
│  • Invariant editor (accept / edit / reject inferred invariants)          │
│  • Live run streaming via Redis Pub/Sub                                   │
│  • Bisect UI shows the failing fixture and the commit responsible         │
└──────────────────────────────────────────────────────────────────────────┘
        │
        │ Promotes to
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│           halley/fixtures/ in the user's Git repository                    │
│  fixtures/<slug>.json        (cassette index, invariants, metadata)       │
│  fixtures/<slug>/bodies/     (content-addressed LLM/tool payload blobs)   │
└──────────────────────────────────────────────────────────────────────────┘
        │
        │ Consumed by
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              halley CLI + GitHub Action (Rust binary)                      │
│  halley ci            replay entire fixture library                        │
│  halley record        promote a local run to a fixture                    │
│  halley bisect <id>   binary-search commits for the invariant break       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Data flow in one sentence

Your agent emits OTLP spans, Halley's Rust ingester normalizes and captures them with bit-fidelity bodies, the writer persists to ClickHouse and publishes live to the dashboard, the dashboard promotes selected runs to fixtures in your repo, and `halley ci` replays those fixtures to catch regressions.

---

## 3. Components

### 3.1 Halley SDK (TypeScript, optional)

A thin wrapper over OpenTelemetry's JS SDK with sensible defaults for AI apps.

**Responsibilities**
- Initialize an OTEL tracer pointed at the Halley ingester endpoint.
- Delegate auto-instrumentation to existing OpenLLMetry and OpenInference packages rather than duplicating their work.
- Expose helpers: `halley.run(name, fn)`, `halley.step(name, fn)`, `halley.feedback(runId, score, comment)`, `halley.markToolEffect(name, 'pure' | 'idempotent' | 'irreversible')`.
- Batch and flush via OTEL BatchSpanProcessor with exponential-backoff retries.
- Offline queueing: in-memory ring buffer with disk spillover on Node.js.

**Non-responsibilities**
- No custom wire protocol. SDK speaks OTLP.
- No metrics signal in v1. Spans only.
- The SDK is optional. Any OTLP-emitting stack works with Halley without it.

### 3.2 Ingester (Rust)

Single Rust binary with two logical workloads: an OTLP receiver and a ClickHouse writer. Packaged as one process for simple deployment; tokio's task model keeps the separation logical.

**Responsibilities**
- Terminate OTLP/gRPC on :4317 via `tonic`, OTLP/HTTP on :4318 via `axum` (both protobuf and JSON payloads).
- Decode using the `opentelemetry-proto` crate.
- **Normalize**, do not reject. Incoming spans come in several dialects; we canonicalize them into Halley's schema. See §3.3 on the normalizer.
- Capture cassette payloads: raw request and response bodies for LLM and tool calls, stored verbatim and content-addressed (SHA-256), deduplicated in `halley.observation_body`. This is the key enabler of bit-fidelity replay.
- Compute derived fields: latency, span kind (llm / tool / retrieval / agent-control), a pricing-version id for later cost calculation.
- Group spans into agent runs via the write-time `is_run_root` flag described in §3.4.
- Publish to Redis Stream `halley:spans`.

**Non-responsibilities**
- No business logic (cost alerts, invariant inference). Those live in worker and dashboard.
- No long-term storage. Ingester is stateless aside from in-flight buffers.

### 3.3 Normalizer

Source-specific adapters map incoming attribute shapes to the canonical schema. Each adapter is a small Rust module with property-based tests proving round-trip correctness (canonical -> dialect -> canonical is the identity on supported attributes).

**Supported sources at v1**
- OpenTelemetry GenAI semantic conventions (primary target)
- OpenLLMetry / Traceloop conventions (`traceloop.*` attributes)
- OpenInference / Arize conventions (`openinference.*` attributes)
- Vercel AI SDK telemetry
- Raw OpenAI and Anthropic SDK OTEL auto-instrumentation

**Design rules**
- Unknown attributes are preserved in the canonical `attributes` map, never dropped.
- Conflicting attributes across dialects resolve via a documented priority list.
- Every mapping has a published version string, stored per-row, so schema evolution is queryable.
- Failing to parse a dialect is a metrics event, not a dropped span. The raw OTLP payload is also preserved for replay.

### 3.4 Run grouping

Every span gets `run_id = trace_id`. Additionally, each span carries an `is_run_root` boolean flag that identifies it as the root of an agent run.

**Write-time (per-span, no batch lookups required):**

- `run_id = trace_id` always.
- `is_run_root = true` when any of the following match:
  - `gen_ai.operation.name = "invoke_agent"` (tier 1 — explicit agent root per OTEL GenAI semconv)
  - `halley.run.kind = "agent"` attribute (tier 2 — explicit override via `@halley/sdk` or manual instrumentation)
  - Dialect-specific equivalents: `traceloop.span.kind = "agent"` (OpenLLMetry), `openinference.span.kind` in `{"AGENT", "CHAIN"}` (OpenInference), `ai.operationId` starting with `"ai.agent"` (Vercel AI SDK)
- `is_run_root = false` for all other spans.

**Read-time (dashboard queries):**

- "Show agent runs" = `SELECT DISTINCT run_id FROM observations WHERE is_run_root = true`
- "Show all traces with multiple LLM spans" = aggregation over the trace (no write-time cost)

**What was reconsidered:** The original design described four tiers running at ingest, including tier 3 ("trace with >1 LLM span → trace root is run root") and tier 4 ("everything else → run of one"). Both tiers 3 and 4 produce `run_id = trace_id` — the only difference is whether the trace is an agent run, which is a derived flag, not an identifier choice. Streaming pipelines are bad at "look back at sibling spans before deciding what this span is" — doing tier 3 at write time would require holding a per-trace buffer with timeouts. The sharper design is: set `is_run_root` on the spans that explicitly declare themselves as agent roots (tiers 1 and 2), and leave trace-level aggregation to read time. See DECISIONS.md D34.

### 3.5 Writer (Rust, same binary)

- Reads `halley:spans` via consumer group `halley:writers`.
- Batches 500 spans or 100 ms, whichever first.
- Two-table insert: thin `halley.observations` row, body blobs into `halley.observation_body` keyed by SHA-256.
- On success: `XACK`. On retryable failure: three attempts with backoff. On persistent failure: forward to Redis DLQ stream `halley:spans:dlq` so container restarts do not lose data.

### 3.6 Cassette capture

Cassette = ordered list of observations for a run + deduplicated body blobs + replay metadata.

**What makes capture "bit-fidelity"**
- We store the raw LLM request body (model, messages, tools, temperature, seed, system prompt, every input byte) and the raw LLM response body.
- We store the raw tool input and output JSON, not a reconstructed summary.
- Every body is content-addressed; the same payload occurring 10,000 times across runs stores once.
- Non-deterministic sources of variance (timestamps, request ids, streaming chunk boundaries) are recorded explicitly so replay can mask or reproduce them.

**Cassette matching rules during replay**
- Match key is derived from the *inputs* to each LLM call: normalized model id, messages, tool list, params excluding seed, tool-response prefix for the current step.
- If match found: serve recorded response, zero cost, deterministic.
- If miss (prompt changed, new tool): hybrid mode, call the real provider, record the fresh response as a new cassette version alongside the old one for diffing.

### 3.7 Invariant inference and fixture promotion

When the user clicks "Turn this run into a test" on a run:

1. A worker job loads all observations for the run.
2. It proposes invariants:
   - **Structural**: the sequence and multiset of tools called, bounds on retry counts, presence of a final answer span.
   - **Schema**: JSON shape of each LLM output and each tool payload (required keys, types).
   - **Metric**: total cost upper bound (cassette cost + 20% headroom by default, configurable), total latency upper bound, span count bounds.
   - **Semantic** (optional, off by default): LLM-as-judge rubric for "output-equivalent to reference," runs against a user-configured judge model. Flagged explicitly in the fixture because it reintroduces non-determinism.
3. The user accepts, tightens, loosens, or removes each proposed invariant in the dashboard.
4. On save, Halley writes the fixture to `halley/fixtures/<slug>.json` and body blobs to `halley/fixtures/<slug>/bodies/` in the user's repo via a configured local path or a GitHub App. The commit is left unpushed for the user to review.

Fixtures are portable JSON. No Halley server required to replay them.

### 3.8 Replay and CI (`halley` CLI)

A single Rust binary shipped alongside the ingester.

**Subcommands**
- `halley ci`: discover fixtures under `halley/fixtures/`, replay each against the current code, report pass/fail per invariant, exit non-zero if any fail.
- `halley record <run_id>`: fetch a production run from the backend and write a fixture locally.
- `halley bisect <fixture_id>`: given a currently-failing fixture, binary-search recent commits to find where the invariant first broke. Uses the git history of both code and fixture bodies.
- `halley diff <fixture_id>`: show what changed between the last passing run and the current failure: prompt text diff, model id diff, tool contract diff, output diff.

**Replay modes**
- **Pure** (default): all cassette keys match, no live calls, cost $0.
- **Hybrid**: some keys miss (prompt changed), cached tool responses served from cassette, only drifted LLM calls go live. Latency and cost bounded and reported.
- **Fresh**: re-record from scratch (explicit flag, CI never does this without opt-in).

**GitHub Action**
Published alongside the CLI: runs `halley ci` on PR, posts a check with pass/fail per fixture, links each failure to the diff and suggested bisect.

### 3.9 Worker (Node.js, BullMQ)

Handles long-running jobs so the dashboard stays responsive.

**Jobs**
- `invariant.infer`: produce proposed invariants for a run
- `bisect.run`: binary-search code commits for a regression
- `fixture.validate`: when a fixture is pushed to the backend repo, revalidate it against current ingester code

### 3.10 Redis

Three roles, co-located on one instance because they are naturally adjacent.

| Role | Key or pattern | Purpose |
|---|---|---|
| Stream buffer | `halley:spans`, `halley:spans:dlq` | Smooth ingest spikes, scale writers |
| Pub/Sub | `halley:run:<run_id>` | Live span updates to dashboard WebSockets |
| Job queue | `halley:jobs:*` | BullMQ for worker jobs |

Redis config must enable AOF (`appendonly yes`, `appendfsync everysec`) so in-flight spans survive a crash.

### 3.11 ClickHouse

Primary store for telemetry. Chosen for columnar compression on high-repetition columns (model names, project ids), fast aggregations, and industry-standard fit for this workload. `clickhouse` crate (official) over `clickhouse-rs` (community, stale).

### 3.12 Postgres

Everything transactional and small: auth, projects, API keys, invariant definitions that stay on the server, fixture metadata (pointers, not bodies), bisect job records.

### 3.13 Dashboard (Next.js 14, App Router)

**Views**
1. **Runs list**: server-rendered table, paginated by time, filterable by project, model, status.
2. **Run detail**: timeline on top, reasoning graph below (`reactflow`), span inspector panel with prompt, completion, tool I/O.
3. **Live runs**: WebSocket-streamed updates via Redis Pub/Sub.
4. **Turn into test**: invariant editor flow.
5. **Fixtures**: list of registered fixtures, last-replay status, link into the repo.
6. **Bisect**: UI for a running or completed bisect job.
7. **Costs**: spend by model, project, day; pricing-version aware so historical costs recompute correctly.
8. **Settings**: API keys, per-project config.

**Rendering**
Server Components for data-heavy static views with direct ClickHouse queries routed through a single `dashboard/src/lib/halley-query/` module that enforces project-scoped auth. Client Components only where interactivity demands it.

---

## 4. Data model

### 4.1 ClickHouse schema (sketch)

We adopt the single-wide-table pattern (as Langfuse v4 moved to in March 2026), with large bodies split into a sibling content-addressed table.

```sql
-- One row per observation. Wide, denormalized, run attributes materialized per row.
CREATE TABLE halley.observations (
  -- Identity (OTLP native sizes: 16-byte trace, 8-byte span)
  trace_id           FixedString(16),
  span_id            FixedString(8),
  parent_span_id     Nullable(FixedString(8)),
  run_id             FixedString(16),
  project_id         UUID,

  -- Timing
  start_time         DateTime64(9, 'UTC'),
  end_time           DateTime64(9, 'UTC'),
  duration_ms        UInt32 MATERIALIZED dateDiff('millisecond', start_time, end_time),

  -- Normalization
  source_dialect     LowCardinality(String),     -- "otel-genai", "openllmetry", "openinference", "vercel-ai", "halley"
  dialect_version    LowCardinality(String),

  -- Canonical GenAI fields
  gen_ai_system        LowCardinality(String),
  gen_ai_operation     LowCardinality(String),   -- "chat", "embeddings", "execute_tool", "invoke_agent", "retrieve"
  gen_ai_request_model   LowCardinality(String),
  gen_ai_response_model  LowCardinality(String),
  gen_ai_usage_input_tokens   UInt32,
  gen_ai_usage_output_tokens  UInt32,
  gen_ai_response_finish_reason LowCardinality(String),

  -- Cassette references (SHA-256 of the raw body, stored in observation_body)
  input_body_hash    Nullable(FixedString(32)),
  output_body_hash   Nullable(FixedString(32)),
  tool_input_hash    Nullable(FixedString(32)),
  tool_output_hash   Nullable(FixedString(32)),
  tool_name          LowCardinality(String),
  tool_side_effect   LowCardinality(String),     -- "pure" | "idempotent" | "irreversible" | "unknown"

  -- Run-level attributes materialized per row (single-table query pattern)
  run_name           LowCardinality(String),
  run_tags           Array(String),
  run_env            LowCardinality(String),

  -- Pricing and status
  pricing_version_id UUID,                       -- cost is read-time, not write-time
  status             Enum8('ok' = 1, 'error' = 2, 'timeout' = 3),
  error_message      String,

  -- Free-form attributes (unknown keys from any dialect land here verbatim)
  attributes         Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, run_id, start_time, span_id)
TTL start_time + INTERVAL 30 DAY;

-- Content-addressed body store. One row per unique payload, refcounted by observations.
-- ZSTD compression; Append-only.
CREATE TABLE halley.observation_body (
  body_hash        FixedString(32),
  body             String CODEC(ZSTD(3)),
  content_type     LowCardinality(String),       -- "application/json", "text/plain"
  byte_size        UInt32,
  first_seen_at    DateTime64(6, 'UTC'),
  project_id       UUID
)
ENGINE = ReplacingMergeTree(first_seen_at)
ORDER BY (project_id, body_hash)
TTL first_seen_at + INTERVAL 30 DAY;

-- Versioned pricing table. Cost is computed at read time, not written once.
CREATE TABLE halley.pricing_versions (
  pricing_version_id   UUID,
  model                LowCardinality(String),
  provider             LowCardinality(String),
  input_cost_per_mtok  Decimal(12, 6),
  output_cost_per_mtok Decimal(12, 6),
  cached_input_cost_per_mtok Decimal(12, 6),
  effective_from       DateTime64(6, 'UTC')
)
ENGINE = ReplacingMergeTree(effective_from)
ORDER BY (pricing_version_id, model);
```

**Why this shape**
- Single denormalized observation table matches the industry's 2026 convergence point (Langfuse v4 moved here in March 2026). A single trace can have thousands of observations; queries rarely care about a separate "trace" row.
- Separate body table keeps hot-path scans narrow. Aggregations (cost by model, runs by tag) never pull message bodies.
- Content-addressing gives massive dedup. Identical system prompts across 10K runs store once.
- `pricing_version_id` per row lets us recompute historical cost when a provider cuts prices.
- `FixedString(16)` / `FixedString(8)` match OTLP wire sizes; previously used `UUID` was wrong.

### 4.2 Fixture format (on disk, in the user's repo)

```
halley/
├─ fixtures/
│  ├─ refund-agent-happy-path.json
│  ├─ refund-agent-happy-path/
│  │  └─ bodies/
│  │     ├─ sha256-ab12...json
│  │     └─ sha256-cd34...json
│  └─ refund-agent-missing-order-id.json
└─ halley.config.json
```

Each `<slug>.json` contains: run metadata, ordered list of observations with `body_hash` references, the full set of invariants, and a replay-matching spec. Bodies are content-addressed JSON or text files. The format is stable, versioned, and documented in the CLI repo.

### 4.3 Postgres schema (sketch)

Entities (full SQL in `infra/postgres/migrations/`):
- `users` (id, email, password_hash, created_at)
- `projects` (id, name, slug, owner_id)
- `api_keys` (id, project_id, hash, last_used_at)
- `fixtures` (id, project_id, source_run_id, repo_path, invariants_json, status, last_replay_at)
- `bisect_jobs` (id, fixture_id, base_commit, head_commit, status, result_commit, log)

---

## 5. Critical flows

### 5.1 Ingest (hot path)

```
Agent emits OTEL span
  -> OTLP/gRPC to ingester:4317
     -> tonic handler decodes
        -> Normalizer maps dialect -> canonical
           -> Capture bodies, derive hashes
              -> XADD halley:spans
                 -> 200 OK to exporter

Writer (async)
  XREADGROUP halley:writers COUNT 500 BLOCK 100
    -> Dedupe body hashes not already in observation_body
       -> Batch insert into observations and observation_body
          -> XACK

Targets
  P99 ingest latency (exporter call -> 200 OK) < 50 ms single node
  Sustain 5,000 spans/sec on 4-core 8GB VM for 10 min
```

### 5.2 Live dashboard

```
Span ingested -> ClickHouse (durable)
              +-> Redis Pub/Sub halley:run:<run_id>
Dashboard run-detail page:
  Server Component loads historical spans from ClickHouse
  Client Component opens WebSocket to /api/ws/runs/:id
    API route subscribes to halley:run:<run_id>
      Forwards each new span
        UI appends to reasoning graph
```

### 5.3 Turn a run into a regression test

```
User clicks "Turn this run into a test" on a run
  -> Dashboard POST /api/fixtures with run_id
     -> Insert postgres.fixtures (status=proposing)
     -> Enqueue invariant.infer job
Worker
  -> Load observations + bodies for run
  -> Propose structural, schema, metric invariants
  -> Write proposal back to postgres
  -> Notify dashboard
User edits invariants in the dashboard
  -> POST /api/fixtures/:id/save
     -> Write halley/fixtures/<slug>.json and /bodies/ to user's repo
        (via configured local path or GitHub App)
     -> status=ready
```

### 5.4 CI replay

```
halley ci
  -> Walk halley/fixtures/
  -> For each fixture:
       Load cassette index and bodies
       Run the user's agent entry point (configured in halley.config.json)
         On each LLM call: hash the inputs
           Match in cassette? serve recorded response
           Miss?           hybrid mode, call provider, record new version
         On each tool call: hash inputs
           Match in cassette? serve recorded response
           Miss?           call user's tool
       Evaluate invariants against the run
  -> Exit 0 if all pass, non-zero otherwise
  -> Emit JUnit XML for CI integration
```

### 5.5 Bisect

```
User: halley bisect refund-agent-happy-path
  -> CLI resolves the base commit (last known-good replay)
  -> Binary search between base and HEAD:
       checkout candidate commit
       run halley ci --only refund-agent-happy-path
       bucket pass/fail
  -> Output: "broken at commit abc1234 — 'refund_agent.py:43 prompt change: added \"be concise\"'"
  -> Post result to postgres.bisect_jobs and surface in dashboard
```

### 5.6 Replay and fork (interactive)

Retained as a feature, scoped smaller than v0.1 of this doc.

A *fork* calls the user's registered replay endpoint with a reconstructed message history up to a chosen fork point, plus user-supplied overrides (new prompt, new model, injected tool response). Spans from the forked run flow back to Halley and render alongside the original.

Tool calls marked `tool_side_effect = "irreversible"` (email, payment, DB mutation) block replay by default. The UI requires the user to either accept the recorded response or substitute one before the fork executes. This is novel: no competitor tracks tool-effect safety at replay time today.

---

## 6. Key design decisions

### 6.1 Fixtures live in the user's repo, not Halley's server
Following the VCR tradition (vcrpy, Docker cagent). Fixtures are versioned with code, reviewable in PRs, runnable offline, portable across Halley deployments. Halley's backend holds a pointer for the dashboard UI, nothing more. This makes `halley ci` fully local.

### 6.2 Bit-fidelity capture over reconstructed summaries
Cheaper storage makes "store everything" a defensible default. Content-addressing deduplicates the 90% of payloads that repeat across runs. Without raw bytes, replay is guesswork.

### 6.3 Normalize, do not reject
Real-world OTLP traffic comes in several dialects (OpenLLMetry, OpenInference, OTEL GenAI, Vercel AI SDK, raw SDKs). The v0.1 plan to "reject malformed spans" would silently drop real customer traffic. Every adapter has property-based tests proving round-trip correctness.

### 6.4 ClickHouse over Postgres / TimescaleDB / Druid
Columnar compression wins on repetitive attribute data. Single-node operability is better than Druid. Langfuse v4 runs on ClickHouse; Laminar runs on ClickHouse; this is settled for the workload.

### 6.5 Redis Streams over Kafka
Kafka is overkill for v1 scale, adds a broker to operate. Streams give durable ordered delivery with consumer groups on a box we already run for Pub/Sub and BullMQ.

### 6.6 Rust ingester, Node.js worker
Ingester is hot path, protobuf-heavy, latency-sensitive; Rust is the correct answer. Worker jobs call external LLM APIs and orchestrate bisect with shell-outs; Node's async and ecosystem (BullMQ) is more ergonomic there.

### 6.7 Single-wide observation table over trace+observations two-table
Langfuse v4's March 2026 pivot documents why: agentic workloads put the interesting data deep in the tree, not on the root trace row. Queries are faster, joins disappear, and materializing run-level attributes onto each row is cheap in ClickHouse.

### 6.8 Cost computed at read time
Pricing changes (often). Writing dollar cost at ingest locks historical rows to stale prices. Store tokens, model, and a `pricing_version_id`; compute dollars at query time from a versioned pricing table. Retroactive "what would this have cost on Claude" becomes a free side effect.

### 6.9 Halley SDK is optional
The hero flow (OTLP in, regression test out) works with any OTLP-emitting instrumentation. The SDK is a convenience wrapper, not a requirement.

### 6.10 Next.js 14 App Router over SPA
Traces are read-heavy, server-rendered content is faster for list and detail views. Dashboard auth is enforced in one place (`halley-query` module), not smeared across components.

### 6.11 Tool-effect-aware replay
No competitor tracks which tool calls have irreversible side effects. Halley does, via `tool_side_effect` metadata, and refuses to replay them without override. This is small but novel and matters for any agent that touches payments, email, or customer data.

---

## 7. Operations

### 7.1 Local development
`docker compose up` brings up ClickHouse, Redis, Postgres, ingester, worker, and dashboard. Ayush's own LLM projects (RAG tutor, reasoning agent) wire in as example customers.

### 7.2 Observability of Halley itself
Ingester exposes Prometheus metrics on `/metrics`:
- `halley_ingest_requests_total{status, dialect}`
- `halley_ingest_latency_seconds{method}`
- `halley_normalizer_unknown_attributes_total{dialect}`
- `halley_writer_batch_size`
- `halley_writer_flush_latency_seconds`
- `halley_body_dedup_ratio`
- `halley_redis_stream_lag`
- `halley_clickhouse_insert_errors_total`

Structured JSON logs via `tracing`. Correlation ids from OTLP request to Redis entry to ClickHouse row.

### 7.3 Deployment (post-launch)
Docker Compose for self-hosters. Helm chart is a stretch for Phase 6.

---

## 8. Security and privacy

- API keys stored as SHA-256 hashes in Postgres; shown once at creation.
- OTLP ingress requires an API key in `Authorization: Bearer` header or gRPC metadata.
- Dashboard auth via Auth.js, email+password with optional OAuth, Postgres adapter.
- Single-org per deployment in v1. Multi-tenant is post-v1.
- **Content redaction for cassettes**: configurable per project. Regex-based PII scrubber runs before body hashing when enabled. Redacted bodies are still deterministic (scrubbed-before-hash means the same scrubbed body hashes the same every time), so replay still works.
- Content fields may contain PII. Per-project `sample_content_pct` controls what fraction of bodies are stored at all; metadata-only storage is supported.

---

## 9. What is explicitly NOT in v1 scope

- Browser-agent session replay (Laminar owns this)
- Full OTEL conformance certification
- Kubernetes Helm chart (stretch, Phase 6)
- Hosted SaaS tier
- Multi-team / workspace RBAC
- Mobile-responsive beyond "usable on iPad"
- Logs and metrics signals (spans only)
- SAML / SSO
- Prompt-management features
- Auto-generated evals from annotated failures (Latitude GEPA territory)

---

## 10. Revision log

| Date | Version | Change | Why |
|---|---|---|---|
| 2026-05-13 | 0.1 | Initial | Project kickoff |
| 2026-05-13 | 0.2 | Hero thesis pivot to "production runs become regression tests." Schema pivoted to single-wide-table + content-addressed bodies. Normalizer replaces reject-on-malformed. Tool-effect-safe replay. Fixtures live in user's repo. Competitive positioning named (Langfuse v4, Laminar, LangSmith, Phoenix, Helicone, Braintrust). | Research on May 13 showed the original differentiators were already shipped by competitors. Repositioned around a loop no one closes today. |
