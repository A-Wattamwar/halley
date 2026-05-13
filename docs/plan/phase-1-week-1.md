# Phase 1, Week 1 — Foundations scope

**Window**: Wed May 13 through Tue May 19, 2026 (Sunday May 17 off)
**Effort budget**: ~22 to 26 hours across 6 working days
**Goal**: `docker compose up` brings the full stack healthy, and a Rust ingester accepts a JSON span over HTTP and writes it to ClickHouse end to end. Nothing else.

This doc is the single source of truth for Week 1. An engineer (or another agent) can execute this without further clarification. The reviewer checklist at the bottom is what will be run when the work is handed back for review.

---

## In scope

1. Monorepo scaffolding.
2. `docker-compose.yml` with ClickHouse, Redis, Postgres, and the Rust ingester, all with healthchecks.
3. ClickHouse migrations for `halley.observations`, `halley.observation_body`, `halley.pricing_versions` (with seed rows).
4. Postgres migrations for `users`, `projects`, `api_keys`, `fixtures`, `bisect_jobs`.
5. Rust ingester with:
   - `GET /healthz`, `GET /readyz`
   - `POST /v1/spans/json` accepts a simplified canonical JSON span, SHA-256-hashes input and output bodies, inserts rows into `halley.observation_body` and `halley.observations`.
   - Structured JSON logging via `tracing`.
   - Env-driven config.
6. A shell-based end-to-end smoke test (`make smoke`).
7. Dockerfile for the ingester, multi-stage.
8. A `DECISIONS.md` file with Week 1 notes.

## Explicitly out of scope for Week 1

- OTLP (gRPC and HTTP/protobuf). That is Week 3 and 4.
- The normalizer. That is Week 3 and 4.
- Redis Streams and consumer-group writer. That is Week 3 and 4. Redis runs in Week 1 only so healthchecks are real.
- Dashboard (Next.js). That is Week 2.
- `@halley/sdk`. That is Phase 3.
- `halley` CLI, fixtures, replay, bisect. That is Phase 5.
- Auth, API keys in code paths. The DB schema exists; enforcement comes later.
- Prometheus metrics. Week 2.
- Integration tests in Rust. Week 2. Week 1's bar is a shell smoke test.

If the exec chat is tempted to build any of the above, the answer is no. Week 1 is plumbing only.

---

## Repo layout after Week 1

```
halley/
├── .env.example
├── .gitignore                    (updated)
├── Makefile
├── docker-compose.yml
├── rust-toolchain.toml
├── README.md                     (unchanged from v0.2)
├── LICENSE                       (unchanged)
├── docs/
│   ├── ARCHITECTURE.md           (unchanged from v0.2)
│   ├── ROADMAP.md                (unchanged from v0.2)
│   ├── SCENARIO.md               (unchanged)
│   ├── DECISIONS.md              (new, append-only log)
│   └── plan/
│       └── phase-1-week-1.md     (this file)
├── infra/
│   ├── clickhouse/
│   │   ├── init/
│   │   │   └── 000_create_database.sh
│   │   └── migrations/
│   │       ├── 001_observations.sql
│   │       ├── 002_observation_body.sql
│   │       └── 003_pricing_versions.sql
│   ├── postgres/
│   │   └── migrations/
│   │       ├── 001_users.sql
│   │       ├── 002_projects.sql
│   │       ├── 003_api_keys.sql
│   │       ├── 004_fixtures.sql
│   │       └── 005_bisect_jobs.sql
│   └── redis/
│       └── redis.conf
├── ingester/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── fixtures/
│   │   └── hello-span.json
│   ├── tests/
│   │   └── smoke.sh
│   └── src/
│       ├── main.rs
│       ├── config.rs
│       ├── errors.rs
│       ├── domain/
│       │   ├── mod.rs
│       │   └── span.rs
│       ├── http/
│       │   ├── mod.rs
│       │   ├── health.rs
│       │   └── spans.rs
│       └── storage/
│           ├── mod.rs
│           └── clickhouse.rs
├── dashboard/ (untouched, placeholder README)
├── sdk-ts/    (untouched)
├── worker/    (untouched)
└── examples/  (untouched)
```

No code in `dashboard/`, `sdk-ts/`, `worker/`, `examples/` in Week 1. The placeholder READMEs there stay.

---

## Canonical JSON span format (Week 1 input)

`POST /v1/spans/json` accepts this shape. This is the "raw" dialect; the normalizer that maps OTEL GenAI, OpenLLMetry, OpenInference, and Vercel AI SDK into this is Week 3 and 4 work.

```json
{
  "trace_id": "0123456789abcdef0123456789abcdef",
  "span_id": "0123456789abcdef",
  "parent_span_id": null,
  "run_id": null,
  "project_id": "a2c7a9a8-2e1b-4d1a-9f0b-000000000001",
  "start_time_unix_nano": 1747148400000000000,
  "end_time_unix_nano":   1747148401500000000,

  "source_dialect": "halley-raw",
  "dialect_version": "1",

  "gen_ai_system": "openai",
  "gen_ai_operation": "chat",
  "gen_ai_request_model": "gpt-4o-mini",
  "gen_ai_response_model": "gpt-4o-mini-2024-07-18",
  "gen_ai_usage_input_tokens": 12,
  "gen_ai_usage_output_tokens": 30,
  "gen_ai_response_finish_reason": "stop",

  "input_body": { "messages": [{"role":"user","content":"hello"}] },
  "output_body": { "content": "hi there" },
  "tool_name": "",
  "tool_input": null,
  "tool_output": null,
  "tool_side_effect": "unknown",

  "run_name": "hello-world",
  "run_tags": [],
  "run_env": "local",

  "pricing_version_id": "00000000-0000-0000-0000-000000000001",
  "status": "ok",
  "error_message": "",
  "attributes": { "example.key": "example.value" }
}
```

**Rules the ingester enforces on insert**
- `trace_id` must be 32 hex chars (decoded to `FixedString(16)`).
- `span_id` must be 16 hex chars (decoded to `FixedString(8)`).
- `parent_span_id`, if present, must be 16 hex chars.
- If `run_id` is null, set `run_id = trace_id`. (Tier 4 of ARCHITECTURE §3.4. The smarter tiers come later.)
- `input_body` and `output_body` are optional. If present, serialize to canonical JSON (sorted keys, no whitespace), compute SHA-256 over the UTF-8 bytes, and upsert a row into `halley.observation_body`, then store the 32-byte hash in the observation row. Same rule for `tool_input` and `tool_output`.
- Reject any span with malformed ids with a 400 and a structured error. Week 1 is strict on IDs because they are cheap to validate; dialect leniency comes later.

**Response**
- 202 Accepted on success with a JSON body: `{"accepted": 1}`.
- 400 on validation failure with `{"error": "...", "field": "..."}`.
- 500 on storage failure (ClickHouse unreachable) with `{"error": "..."}`.

---

## Day-by-day plan

### Day 1 (Wed May 13, ~4-6 hrs): Scaffolding

1. `rust-toolchain.toml`: pin to `channel = "1.83"` (stable as of May 2026). Keep it simple.
2. `.gitignore`: add `target/`, `.env`, `node_modules/` (for later), `*.log`, `.DS_Store`.
3. `.env.example`: all config the ingester reads (see below).
4. `Makefile` targets: `up`, `down`, `logs`, `smoke`, `clean`, `fmt`, `lint`.
5. `docker-compose.yml` skeleton with four services using official images. No custom Dockerfile yet. Ingester service left commented with a TODO pointing to Day 3.
6. `infra/redis/redis.conf` with `appendonly yes`, `appendfsync everysec`.
7. `docs/DECISIONS.md` initial file. First entry: why we pinned Rust 1.83, why we chose the `clickhouse` crate over `clickhouse-rs`, why Redis AOF is on from day 1 even though Redis is not in the Week 1 hot path.

**Acceptance**: `docker compose up` brings ClickHouse, Redis, and Postgres healthy. Ingester is not yet built. No migrations applied yet.

**`.env.example` fields**

```
# Ingester
INGESTER_HTTP_ADDR=0.0.0.0:4318
INGESTER_LOG_LEVEL=info
INGESTER_LOG_JSON=true

# ClickHouse
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_DATABASE=halley
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=

# Postgres
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=halley
POSTGRES_USER=halley
POSTGRES_PASSWORD=halley

# Redis
REDIS_URL=redis://redis:6379/0
```

### Day 2 (Thu May 14, ~4-6 hrs): Migrations

Write the ClickHouse and Postgres migrations and wire them into `docker-compose.yml` so they run at first boot and are idempotent across restarts.

**ClickHouse migrations live in `infra/clickhouse/migrations/`.** Mount the directory into the ClickHouse container at `/docker-entrypoint-initdb.d/`. ClickHouse executes `.sql` and `.sh` files there in sorted order on first startup. For restart idempotency, every migration uses `CREATE TABLE IF NOT EXISTS` or `CREATE DATABASE IF NOT EXISTS`.

Files:
- `000_create_database.sh`: wraps `clickhouse-client --query 'CREATE DATABASE IF NOT EXISTS halley'`.
- `001_observations.sql`: `halley.observations` per ARCHITECTURE §4.1. MergeTree, `PARTITION BY toYYYYMMDD(start_time)`, `ORDER BY (project_id, run_id, start_time, span_id)`, `TTL start_time + INTERVAL 30 DAY`. Use `FixedString(16)`/`FixedString(8)` for ids.
- `002_observation_body.sql`: `halley.observation_body` per ARCHITECTURE §4.1. ReplacingMergeTree on `first_seen_at`, ordered by `(project_id, body_hash)`, `body_hash` is `FixedString(32)`, body codec `ZSTD(3)`.
- `003_pricing_versions.sql`: `halley.pricing_versions` per ARCHITECTURE §4.1. **Seed at least these rows** (pricing as of May 2026; they will go stale and that is fine because the schema is designed for swapping):
  - `pricing_version_id = 00000000-0000-0000-0000-000000000001`, effective 2026-05-01
  - rows for: `gpt-4o`, `gpt-4o-mini`, `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gemini-2-5-pro`, `gemini-2-5-flash`
  - If the exec chat does not know exact prices, use placeholder values and mark them `-- TODO: verify prices as of deploy date`. Do not invent numbers with false precision.

**Postgres migrations live in `infra/postgres/migrations/`.** Mount at `/docker-entrypoint-initdb.d/` in the Postgres container. Each file uses `CREATE TABLE IF NOT EXISTS`.

Files:
- `001_users.sql`: `id UUID PRIMARY KEY`, `email TEXT UNIQUE NOT NULL`, `password_hash TEXT NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`.
- `002_projects.sql`: `id UUID PRIMARY KEY`, `name TEXT NOT NULL`, `slug TEXT UNIQUE NOT NULL`, `owner_id UUID REFERENCES users(id)`, `created_at TIMESTAMPTZ DEFAULT now()`.
- `003_api_keys.sql`: `id UUID PRIMARY KEY`, `project_id UUID REFERENCES projects(id) ON DELETE CASCADE`, `key_hash TEXT NOT NULL UNIQUE`, `label TEXT`, `last_used_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT now()`.
- `004_fixtures.sql`: `id UUID PRIMARY KEY`, `project_id UUID REFERENCES projects(id) ON DELETE CASCADE`, `source_run_id TEXT NOT NULL`, `repo_path TEXT NOT NULL`, `invariants_json JSONB NOT NULL DEFAULT '{}'::jsonb`, `status TEXT NOT NULL CHECK (status IN ('proposing','ready','stale'))`, `last_replay_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT now()`.
- `005_bisect_jobs.sql`: `id UUID PRIMARY KEY`, `fixture_id UUID REFERENCES fixtures(id) ON DELETE CASCADE`, `base_commit TEXT`, `head_commit TEXT`, `status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed'))`, `result_commit TEXT`, `log TEXT`, `created_at TIMESTAMPTZ DEFAULT now()`, `completed_at TIMESTAMPTZ`.

**docker-compose healthchecks** (mandatory, do not skip):
- ClickHouse: `clickhouse-client --query 'SELECT 1'`, interval 5s, retries 10.
- Postgres: `pg_isready -U halley -d halley`, interval 5s, retries 10.
- Redis: `redis-cli ping`, interval 5s, retries 10.

Service `depends_on` with `condition: service_healthy` so the ingester waits on the others later.

**Acceptance Day 2**: `docker compose down -v && docker compose up` runs all migrations successfully. `clickhouse-client --query 'SHOW TABLES FROM halley'` lists three tables. `psql -U halley -d halley -c '\dt'` lists five tables. A second `docker compose up` after `down` (no `-v`) starts without re-running migrations and without erroring.

### Day 3 (Fri May 15, ~4-6 hrs): Rust ingester skeleton

Focus: get `GET /healthz` and `GET /readyz` serving, env-driven config, tracing logs flowing, no storage yet. Keep it boring.

**Cargo.toml dependencies** (pinned, no surprises):
```toml
[dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }
axum = "0.7"
tower = "0.5"
tower-http = { version = "0.6", features = ["trace"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
clickhouse = "0.13"
sha2 = "0.10"
hex = "0.4"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

Versions are guidance; if a newer stable is available on Cargo, bump it and note it in `DECISIONS.md`. Do not downgrade.

**Module layout**
- `main.rs`: bootstrap. Load config, init tracing (JSON logs if `INGESTER_LOG_JSON=true`), build router, spawn `tokio::signal::ctrl_c()` for graceful shutdown, `axum::serve(...).await`.
- `config.rs`: `Config` struct loaded from env, impls a `from_env()` function that returns `Result<Config, ConfigError>`.
- `errors.rs`: `IngestError` enum with `thiserror`, `impl IntoResponse for IngestError` that maps variants to HTTP status + JSON body.
- `http/mod.rs`: routes wiring.
- `http/health.rs`: `/healthz` returns 200 "ok". `/readyz` pings ClickHouse and returns 200 if it responds, 503 otherwise.
- `http/spans.rs`: stub for Day 4. Returns 501 until implemented.
- `domain/span.rs`: stub, see Day 4.
- `storage/clickhouse.rs`: client wrapper, just a ping function on Day 3.

**Acceptance Day 3**: `cargo run` (outside docker) against a running compose stack returns 200 on `/healthz` and 200 on `/readyz`. Logs are JSON, include `trace_id` and `span_id` per request via `tower_http::trace::TraceLayer`.

### Day 4 (Sat May 16, ~2 hrs): Admin, polish, decisions log

Short day by the working agreement.
- Write `DECISIONS.md` entries covering: canonical JSON format choice, hex-string IDs on the wire, SHA-256 for body hashing (why not BLAKE3 yet), pricing seed approach, hand-rolled migrations (no `dbmate` yet).
- Clean up any quick-and-dirty decisions from the week.
- No new code paths. No Monday setup.

### Day 5 (Sun May 17): OFF

No commits. No "quick fixes." Sundays are non-negotiable per ROADMAP §Weekly rhythm.

### Day 6 (Mon May 18, ~4-6 hrs): The insert path

Implement `POST /v1/spans/json` end to end.

1. `domain/span.rs`: `RawSpan` struct matching the canonical JSON above. Derive `Deserialize`. Implement `TryInto<ObservationRow>` which:
   - Validates hex lengths, decodes to fixed-size byte arrays.
   - Defaults `run_id = trace_id` when absent.
   - Serializes each body to canonical JSON (sorted keys, no whitespace), hashes with SHA-256, returns the hash and the canonical bytes.
   - Returns a tuple `(ObservationRow, Vec<BodyRow>)`.

2. `storage/clickhouse.rs`:
   - `ClickHouseStore` holds a `clickhouse::Client`.
   - `insert_observation(row)`: single-row insert into `halley.observations`. For Week 1 a single-row insert is fine; Week 3 introduces batching through Redis Streams.
   - `insert_body(row)`: upsert into `halley.observation_body`. ReplacingMergeTree handles dedup on background merge; the insert itself is unconditional.
   - Both use the official `clickhouse` crate's `Row` derive.

3. `http/spans.rs`: handler `post_span(State<AppState>, Json<RawSpan>) -> Result<(StatusCode, Json<Accepted>), IngestError>`. On success: insert bodies first, then observation, return 202.

4. Tracing: wrap the handler in a span. Log a single structured event per insert with `trace_id`, `span_id`, `body_hash_count`, `duration_ms`. No content in logs.

**Acceptance Day 6**: `curl -X POST localhost:4318/v1/spans/json -d @ingester/fixtures/hello-span.json -H 'Content-Type: application/json'` returns 202. `clickhouse-client --query "SELECT count() FROM halley.observations"` returns 1. `SELECT count() FROM halley.observation_body` returns at most 2 (input + output hashes; could be fewer if a body was absent).

### Day 7 (Tue May 19, ~4-6 hrs): Dockerfile, compose wiring, smoke test, ship

1. `ingester/Dockerfile`: multi-stage. Stage 1 `rust:1.83-slim` builds in release mode. Stage 2 `debian:bookworm-slim` runs the binary. `WORKDIR /app`, non-root user, `CMD ["/app/halley-ingester"]`.
2. `ingester/.dockerignore`: `target/`, `.git/`, `fixtures/`, `tests/`.
3. Uncomment the ingester service in `docker-compose.yml`, set `build: ./ingester`, `env_file: .env`, `ports: [ "4318:4318" ]`, `depends_on` ClickHouse/Postgres/Redis healthy.
4. `ingester/tests/smoke.sh`: shell script that
   - Waits for `/healthz` to return 200 (up to 30s).
   - Posts `hello-span.json`, asserts 202.
   - Queries ClickHouse via HTTP (`curl http://localhost:8123/?query=...`) to verify exactly one observation row and the expected body rows.
   - Posts the same span again, asserts the observation count is 2 but observation_body count is unchanged after a small delay (dedup on merge). Note: if the delay is not enough for a merge, the script accepts "<= previous count" and logs a note. Week 1 does not need to prove merge timing; just prove correctness on first insert.
5. `make smoke` runs the script.
6. Polish `README.md`'s "Getting started" section if and only if the one-command path really works. If it does not, leave the README as-is and note the gap in `DECISIONS.md`.

**Acceptance Day 7**: `make up && make smoke` passes cleanly. `make down` cleans up. `git status` shows only intentional files.

---

## `hello-span.json` fixture (exact contents)

```json
{
  "trace_id": "00000000000000000000000000000001",
  "span_id": "0000000000000001",
  "parent_span_id": null,
  "run_id": null,
  "project_id": "a2c7a9a8-2e1b-4d1a-9f0b-000000000001",
  "start_time_unix_nano": 1747148400000000000,
  "end_time_unix_nano": 1747148401500000000,
  "source_dialect": "halley-raw",
  "dialect_version": "1",
  "gen_ai_system": "openai",
  "gen_ai_operation": "chat",
  "gen_ai_request_model": "gpt-4o-mini",
  "gen_ai_response_model": "gpt-4o-mini-2024-07-18",
  "gen_ai_usage_input_tokens": 12,
  "gen_ai_usage_output_tokens": 30,
  "gen_ai_response_finish_reason": "stop",
  "input_body": { "messages": [{"role":"user","content":"hello"}] },
  "output_body": { "content": "hi there" },
  "tool_name": "",
  "tool_input": null,
  "tool_output": null,
  "tool_side_effect": "unknown",
  "run_name": "hello-world",
  "run_tags": [],
  "run_env": "local",
  "pricing_version_id": "00000000-0000-0000-0000-000000000001",
  "status": "ok",
  "error_message": "",
  "attributes": { "example.key": "example.value" }
}
```

Before `project_id` references a real row, insert a seed project in Postgres as part of the migrations or a separate `infra/postgres/seeds/001_dev_project.sql`. For Week 1, Postgres-side FK enforcement is not touched by the ingester (we do not write to Postgres this week), so the seed is only for consistency and Week 2's dashboard reads. If time is short, skip the seed.

---

## Common pitfalls to avoid

1. **`UUID` vs `FixedString` for ids.** ARCHITECTURE §4.1 says `FixedString(16)` for trace_id and `FixedString(8)` for span_id. OTLP defines these sizes on the wire. Do not use ClickHouse `UUID`.
2. **Hex encoding on the wire, bytes in the DB.** The ingester decodes hex strings to byte arrays before inserting. Do not store hex strings.
3. **Canonical JSON for body hashing.** Sort object keys, no whitespace. Two bodies that differ only in key order must hash the same. `serde_json::to_string` with default settings does not sort keys. Use `serde_json::to_value` then a canonical serializer, or a small helper. Document the choice in `DECISIONS.md`.
4. **`ReplacingMergeTree` dedup is eventual.** Do not assert exact row counts in `observation_body` in tests immediately after insert. Use `FINAL` in the test query, or accept that duplicate inserts collapse on background merge.
5. **ClickHouse `IF NOT EXISTS` on migrations.** Idempotency is a hard requirement. A restart must not fail.
6. **Do not write to Postgres from the ingester yet.** Week 1 is ClickHouse-only for inserts. Postgres migrations exist so Week 2's dashboard and Phase 3+ features can build on them.
7. **Do not add OTLP dependencies in `Cargo.toml` this week.** `tonic`, `prost`, `opentelemetry-proto` are Week 3. Keep the dep tree lean.
8. **Graceful shutdown.** The tokio `signal::ctrl_c` handler matters. `docker compose down` must not leak connections or require `kill -9`.
9. **Do not embed secrets in docker-compose.** Use `.env` file loaded by compose. Default dev creds in `.env.example` only.
10. **Do not start Week 2 work.** No dashboard files. No SDK files. No `@halley/sdk` scaffolding. No normalizer modules. If the exec chat gets to Day 7 with time left, they polish, not expand.

---

## Reviewer checklist (what I will run when this comes back)

When the work is handed back, I will run this list top to bottom. Every item passes or the week is not done.

### Repo hygiene
- [ ] `git status` clean on the branch. No untracked build artifacts.
- [ ] `target/`, `.env`, `node_modules/`, `*.log`, `.DS_Store` in `.gitignore`.
- [ ] No secrets committed (I will grep for common patterns).
- [ ] `DECISIONS.md` has entries for at least: Rust version, ClickHouse crate choice, hex-on-wire / bytes-in-DB, canonical JSON hashing choice, Redis AOF, migration tooling approach.

### Boot
- [ ] `docker compose down -v && docker compose up -d` brings all four services to healthy within 60 seconds on a clean machine.
- [ ] `docker compose ps` shows `healthy` for clickhouse, redis, postgres, ingester.
- [ ] A second `docker compose up` (after `down` without `-v`) succeeds and does not re-run migrations with errors.

### Migrations
- [ ] ClickHouse: `SHOW TABLES FROM halley` returns `observations`, `observation_body`, `pricing_versions`.
- [ ] `DESCRIBE halley.observations` shows `trace_id FixedString(16)` and `span_id FixedString(8)` (not `UUID`).
- [ ] `SELECT count() FROM halley.pricing_versions` returns >= 5.
- [ ] Postgres: `\dt` lists `users`, `projects`, `api_keys`, `fixtures`, `bisect_jobs`.
- [ ] `\d fixtures` shows the CHECK constraint on status.

### Redis
- [ ] `redis-cli CONFIG GET appendonly` returns `yes`.
- [ ] `redis-cli CONFIG GET appendfsync` returns `everysec`.

### Ingester
- [ ] `curl localhost:4318/healthz` returns 200 with body `ok`.
- [ ] `curl localhost:4318/readyz` returns 200 when ClickHouse is up, 503 when it is down (verify by stopping ClickHouse).
- [ ] Logs are valid JSON (one object per line). Each HTTP request produces at least one log line with `http.method`, `http.target`, `http.status`.
- [ ] `curl -X POST localhost:4318/v1/spans/json -d @ingester/fixtures/hello-span.json -H 'Content-Type: application/json'` returns 202 with `{"accepted":1}`.
- [ ] After that call, `SELECT count() FROM halley.observations` returns 1.
- [ ] `SELECT hex(input_body_hash), hex(output_body_hash) FROM halley.observations` returns two 64-char hex strings, and those hashes each resolve to a matching row in `observation_body`.
- [ ] Invalid trace_id (e.g. 31 chars) returns 400 with a structured error naming the field.

### Smoke
- [ ] `make smoke` exits 0.
- [ ] Re-running `make smoke` is idempotent; observation count climbs, body count does not.

### Non-goals respected
- [ ] No OTLP, no `tonic`, no `prost`, no `opentelemetry-proto` in `Cargo.toml`.
- [ ] No dashboard code under `dashboard/`.
- [ ] No SDK code under `sdk-ts/`.
- [ ] No CLI code under a `cli/` folder. (It is a Phase 5 deliverable.)
- [ ] No normalizer modules in `ingester/src/`.

---

## When to stop

The week is done when every checkbox above passes. If it finishes early, do not start Week 2. Use the time to polish `DECISIONS.md`, clean commits, and write a short retrospective at the bottom of this file under a `## Week 1 retro` heading. That retro is what I read first on review.
