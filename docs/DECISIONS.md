# Halley — Decisions log

Append-only record of non-obvious technical choices. Each entry is dated,
labeled, and explains the tradeoff. When a decision is later reversed, a
new entry supersedes it; old entries are never edited or deleted.

Reviewer note (Ayush): entries here are the map for why the code looks
the way it does. If a decision is not logged, it was not deliberate.

---

## 2026-05-13 — Day 1 scaffolding

### D1. Pin Rust toolchain to 1.83
`rust-toolchain.toml` declares `channel = "1.83"` per Week 1 plan. 1.83 is
old enough to be widely present in CI images and Docker bases by mid-2026
and recent enough to support the axum 0.7 / tokio 1.x / tracing stacks we
need. Compatibility over shiny is explicit: we would rather catch MSRV
surprises now than chase the release train. Bump policy is in the
toolchain file header. If a dep we pick (likely the `clickhouse` crate)
declares a newer MSRV, we bump to that crate's MSRV and log it here.

### D2. ClickHouse crate: official `clickhouse` over community `clickhouse-rs`
Chosen because:
- Maintained by ClickHouse Inc., release cadence matches the server.
- Native `FixedString(N)` support via `[u8; N]` / `Vec<u8>` — essential
  for our `trace_id` / `span_id` / body-hash columns (ARCHITECTURE §4.1).
- `async` first-class, integrates with tokio.
The `clickhouse-rs` community crate was once the default but is now
under-maintained and has known gaps around `Decimal`, `LowCardinality`,
and `ReplacingMergeTree` DDL surface we rely on. The exact crate version
and its changelog note land here as part of Day 3 when Cargo.toml is
written.

### D3. Redis AOF (`appendonly yes`, `appendfsync everysec`) on from day 1
ARCHITECTURE §3.10 makes Redis a durable buffer for in-flight spans
(`halley:spans` stream, DLQ stream) and a job queue (BullMQ keys).
Both roles break silently if Redis restarts without persistence.
Week 1 does not use Redis on the hot path yet, but enabling AOF later
would require an operational migration on any installed base.
`everysec` is the standard durability/throughput compromise:
at most one second of writes are lost on a full host crash.
Fsync cost is amortized across writes and invisible at our write rates.
Config lives in `infra/redis/redis.conf`, mounted read-only into the
Redis container and loaded via `redis-server <path>` in
`docker-compose.yml`.

### D4. `Cargo.lock` for the ingester binary is committed
The root `.gitignore` ignores `Cargo.lock` globally (correct for a
workspace of libraries). The ingester is a binary crate, and Rust's
official guidance is to commit `Cargo.lock` for binaries so reproducible
builds include transitive dep versions. Day 1 leaves `Cargo.lock` absent
(no Cargo.toml yet); Day 3 will add a gitignore negation rule
`!ingester/Cargo.lock` when the lockfile first appears. Logging here so
the negation rule is not mistaken for an oversight.

### D5. ClickHouse init-dir is not a long-term migration tool
The official ClickHouse image runs `/docker-entrypoint-initdb.d/` scripts
**only on first boot** against an empty data volume. This satisfies Week 1's
acceptance ("a second `docker compose up` does not re-run migrations"),
but it is not a migration tool: schema changes after the first boot do
not auto-apply on restart. This is a known limitation for Week 1 only.

Migration-tool decision deferred to Week 2 or 3. Candidates to evaluate
then:
- **dbmate** — language-agnostic, single binary, ClickHouse support via
  driver. Ops-friendly. Mixes well with the Postgres side.
- **refinery** — Rust-native, embeddable in the ingester binary, compile-
  time migration checks. Tight fit if we want the ingester to self-migrate
  on startup.
- **custom Rust-side runner** — smallest dep tree, full control over
  ordering and idempotency semantics. Build cost not trivial.

Do not pick this week. Just know the init-dir path is a starter, not the
final answer.

### D6. Postgres `owner_id` nullable for the dev seed
The Day 2 Postgres migrations will land `projects.owner_id UUID REFERENCES
users(id)` as **nullable** so the Week 1 `infra/postgres/seeds/001_dev_project.sql`
row can exist without a corresponding users row. Auth comes in Phase 4;
until then a project without an owner is a valid dev-time state. When
auth lands we will either backfill owners or flip the column to NOT NULL
and seed a real user in the same migration. Noted in advance because it
affects Day 2's schema.

### D7. `.env` defaults in `.env.example` only, never in `docker-compose.yml`
Week 1 plan pitfall #9. docker-compose loads `.env` automatically when
`docker compose` is invoked from the repo root; values inside
`${VAR:-default}` expansions in the compose file are there so a missing
`.env` still boots with dev-safe defaults, but actual credentials never
live in tracked YAML. `.env` is gitignored (pre-existing root rule).

### D8. Commented-out ingester service in `docker-compose.yml`
The ingester service block is present but commented. Rationale: a YAML
file that references a nonexistent `./ingester/Dockerfile` would fail
`docker compose config` and block the Day 1 acceptance. Leaving a stub
makes Day 7's wire-up a diff, not a fresh write, and documents the
intended shape (ports, env_file, depends_on healthy, healthcheck) for
reviewers.

### D9. `Makefile` targets: `up`, `down`, `clean`, `logs`, `ps`, `ready`, `smoke`, `fmt`, `lint`
Plan requires `up`, `down`, `logs`, `smoke`, `clean`, `fmt`, `lint`.
Added `ps` and `ready` as small quality-of-life helpers (no new deps):
`ps` is a thin wrapper on `docker compose ps`; `ready` polls health
status and blocks until healthy or a 60-second timeout. `ready` is what
the Day 7 smoke test and CI will call before asserting anything.
`smoke` exists from Day 1 as a stub that exits 0 so the target is in
place before its implementation lands on Day 7.

---

## 2026-05-13 — Day 2 migrations

### D10. ClickHouse healthcheck: `clickhouse-client --query 'SELECT 1'` not `wget --spider`
The Alpine busybox `wget` does not support `--spider` (returns exit 1 even
when the server is up). The Week 1 plan spec says to use
`clickhouse-client --query 'SELECT 1'` for the healthcheck; the initial
compose file used `wget` by mistake. Fixed on Day 2. Lesson: always use
the plan's exact healthcheck command, not a "equivalent" one.

### D11. ClickHouse TTL requires `DateTime` / `Date`, not `DateTime64`
`TTL start_time + INTERVAL 30 DAY` fails with
`TTL expression result column should have DateTime or Date type`
when `start_time` is `DateTime64(9, 'UTC')`. Fix: wrap with
`toDateTime()`: `TTL toDateTime(start_time) + INTERVAL 30 DAY`.
Same fix applied to `observation_body.first_seen_at`. This is a
ClickHouse 24.x behaviour; the ARCHITECTURE doc's schema sketch did not
include the cast. The cast is lossless for TTL purposes: toDateTime()
truncates to second-level granularity, which is sufficient for a 30-day expiry.

### D12. ClickHouse SQL parser rejects inline `--` comments inside VALUES
`INSERT INTO ... VALUES (...), -- comment` causes a parse error:
`Cannot parse input: expected '(' before: '-- comment'`.
Comments inside a VALUES list are not valid SQL in ClickHouse's parser.
All seed-row comments moved to the block header above the INSERT.
This is a ClickHouse-specific restriction; standard Postgres and SQLite
accept inline comments in VALUES.

### D13. Postgres and ClickHouse initdb.d do not recurse into subdirectories
Both images use a flat glob (`/docker-entrypoint-initdb.d/*`) to find
init files. Mounting migrations and seeds as subdirectories
(`/docker-entrypoint-initdb.d/migrations/`) silently skips them.
Fix: mount each file individually at the top level with a numeric prefix
that controls execution order. Postgres migrations are 001-005; the dev
seed is mounted as 006 so it runs after all tables exist.
This is another argument for a real migration tool in Week 2/3 (see D5).

### D14. `CLICKHOUSE_SKIP_USER_SETUP=1` in docker-compose.yml
The official ClickHouse image refuses to start by default when
`CLICKHOUSE_PASSWORD` is empty for a non-`default` user. Our local dev
stack intentionally runs as `default` with an empty password because
(a) the container is only exposed on localhost in dev, and (b) the
ingester's `.env` wires up matching empty credentials for ClickHouse
client auth. Setting `CLICKHOUSE_SKIP_USER_SETUP=1` tells the image to
accept the empty-password default-user combo and proceed.

This is a dev-only convenience and must NOT carry into Phase 4 or any
deployment. Phase 4 work (auth, API keys) should:
- Generate a non-default ClickHouse user for the ingester.
- Set a real `CLICKHOUSE_PASSWORD` in the deploy env.
- Drop `CLICKHOUSE_SKIP_USER_SETUP` from compose.
- Apply TLS to the ClickHouse HTTP and native ports if exposed beyond
  localhost.

Flagged here so the Phase 4 work knows to look for it.

### D15. Day 7 ingester healthcheck will use curl, not busybox wget
When Day 7 uncomments the ingester service in docker-compose.yml, the
healthcheck must use `curl -fsS http://localhost:4318/healthz` rather
than `wget --spider`. Same Alpine busybox limitation as D10. If the
ingester's runtime base image is `debian:bookworm-slim` (per the plan),
both tools are available and curl is idiomatic; on any slim Alpine base
the choice would matter. Flagging now as a pre-commit for Day 7.

---

## 2026-05-13 — Day 3 ingester skeleton

### D16. `clickhouse` crate version: 0.13.3, not 0.15.0 or 0.14.x
Latest stable on crates.io is `0.15.0` (published 2026-04-06). Latest in the
0.14 series is `0.14.3` (2026-03-30). Both require `rust-version = "1.89.0"`
and `edition = "2024"`.

Our `rust-toolchain.toml` pins 1.83 per the Week 1 plan ("compatibility
over shiny"). The user's Day 1 sign-off explicitly authorised bumping
Rust's MSRV if a crate demands it — but only if the crate we pick does.
0.13.3 does not: it declares `rust-version = "1.73.0"` and `edition = "2021"`,
so it works on 1.83 without any toolchain change.

Picked: `clickhouse = "0.13.3"`, published 2025-05-29 by ClickHouse Inc.
Diff vs the plan's guidance `"0.13"`: patch-level bugfixes and a `watch`
feature we do not enable; `FixedString` handling via `[u8; N]` is unchanged
from 0.13.x; async API unchanged; default compression feature (`lz4`)
unchanged. Nothing in the changelog we need.

When we eventually need 0.14/0.15 features (none known yet), the Rust MSRV
bump is the whole cost. Logged here so future-me doesn't re-evaluate from
scratch. See Cargo.toml comment above the dependency.

### D17. Cargo.toml dep versions match the plan exactly; no patch pins
The plan lists major.minor version requirements (e.g. `axum = "0.7"`,
`tokio = { version = "1", ... }`). Cargo interprets these as SemVer
caret requirements; the lockfile locks to exact patch versions.
I did not pin patches in Cargo.toml. This is standard Rust practice:
Cargo.toml expresses compatibility, Cargo.lock expresses exact versions.
Cargo.lock is committed (see D4) so binary builds are reproducible.

### D18. `InvalidIdLength` et al: single catch-all validation error vs per-field
`errors.rs` defines `IngestError` with a small set of variants. Validation
failures land in `IngestError::InvalidField { field, reason }` — one
variant that carries the field name, not one variant per field. The 400
response is `{"error": "<reason>", "field": "<field>"}` per the Week 1
plan's response spec. Keeps `IntoResponse` small; Day 6 validation code
in `domain/span.rs` can add fields without touching errors.rs.

### D19. Tracing subscriber: JSON output controlled by `INGESTER_LOG_JSON`
When `INGESTER_LOG_JSON=true`, `tracing-subscriber` emits one JSON object
per log event (via the `json` feature). When false (the default test
flag), it falls back to human-readable `tracing-subscriber::fmt`. The
plan's default is `true`; `.env.example` sets it to `true`. `env-filter`
feature respects `RUST_LOG` and `INGESTER_LOG_LEVEL`. This dual mode is
useful for `cargo run` locally where JSON is painful to read.

### D20. `/readyz` pings ClickHouse with a bounded timeout
Per your Day 2 note, `/readyz` must actually probe ClickHouse, not just
return 200. Implementation: a 2-second timeout around
`client.query("SELECT 1").fetch_one::<u8>()`. On timeout or error we
return 503 with a JSON body naming `"clickhouse"` as the failing
dependency. A longer timeout would make the endpoint unresponsive when
ClickHouse is actually down; a shorter one would false-alarm under load.
Revisit in Week 3 once Redis becomes a hot-path dep (readyz will have to
probe it too).

### D21. Transitive dep MSRV pins in Cargo.lock (ICU / uuid / idna_adapter)
Fresh build on Rust 1.83 failed because several transitive deps bumped
their MSRV past what Cargo 1.83 accepts (one even requires
`edition = "2024"`, stabilized later). The chain:
`clickhouse` → `url` → `idna` → `idna_adapter` → `icu_normalizer` →
`icu_provider` → `icu_locale_core` + sibling `icu_*` data crates.

Pinned to the last versions that declare `rust-version <= 1.83` and
`edition = "2021"`:

| crate               | pinned | latest |
|---------------------|--------|--------|
| `uuid`              | 1.20.0 | 1.23.1 |
| `idna_adapter`      | 1.2.1  | 1.2.2  |
| `icu_collections`   | 2.0.0  | 2.2.0  |
| `icu_locale_core`   | 2.0.1  | 2.2.0  |
| `icu_normalizer`    | 2.0.1  | 2.2.0  |
| `icu_normalizer_data`| 2.0.0 | 2.2.0  |
| `icu_properties`    | 2.0.2  | 2.2.0  |
| `icu_properties_data`| 2.0.1 | 2.2.0  |
| `icu_provider`      | 2.0.0  | 2.2.0  |

These pins live in `ingester/Cargo.lock`, not `Cargo.toml`, because
Cargo.toml should express compatibility (SemVer caret) while the
lockfile pins exact versions for reproducible binary builds (see D4).

When we eventually bump Rust (e.g. a future `clickhouse` feature demands
it), `cargo update` will walk these forward. Until then, a `cargo update`
run against Rust 1.83 will pick versions that respect the MSRV and not
re-introduce the break.

This is dumb but common: the modern `url` / `idna` stack drags in the
full ICU crate family, which pushes MSRV whenever `icu4x` does. Logged
so it doesn't look like randomness.

---

## 2026-05-18 — Day 6 insert path

### D22. Canonical JSON for body hashing: recursive key-sort, NOT RFC 8785
Bodies are hashed after serializing to a canonical form defined as:
1. Recursively sort all object keys alphabetically (Unicode code-point order).
2. Compact output — no whitespace between tokens.
3. Leave numbers as `serde_json::Number` — no float normalization, no
   integer coercion, no exponent rewriting.

This is intentionally simpler than RFC 8785 (JCS). JCS additionally
normalizes floating-point numbers to IEEE 754 decimal representation,
which requires a non-trivial algorithm and a dependency we do not want
in Week 1. Our bodies are LLM request/response JSON; numbers in those
payloads are token counts, temperatures, and costs — all of which
round-trip through `serde_json::Number` without loss.

Acceptance bar: two bodies that differ only in key order must hash the
same. Verified by the `canonical_json_key_order` unit test in
`ingester/src/domain/span.rs`.

RFC 8785 is deferred to whenever we need cross-language hash
compatibility (e.g. the TypeScript SDK computing hashes that must match
the Rust ingester's). At that point the cost is adding one crate and
updating this entry. The rule is pinned in a code comment above
`canonicalize_json()` in `domain/span.rs` so it cannot be missed.

### D23. hello-span.json fixture timestamp corrected from 1747148400000000000 (May 13, 2025) to 1778655600000000000 (May 13, 2026)
The original value in the plan was a typo — the plan was authored on May 13, 2026 but the timestamp decoded to one year prior. TTL is 30 days so the stale timestamp caused ClickHouse to immediately expire the row after insert, making count() return 0.

---

## 2026-05-18 — Week 2 Day 1 migration tooling + dashboard scaffold

### D24. Migration tooling: dbmate over refinery / custom runner
Picked **dbmate** (`ghcr.io/amacneil/dbmate`) as the sole migration runner
for both ClickHouse and Postgres. Supersedes the Week 1 `initdb.d` volume
mounts (D5, D13), which have been removed from `docker-compose.yml`.

Reasons:
- Single binary, no runtime dep, language-agnostic.
- SQL-file based: migrations are plain `.sql`, readable, diffable, reviewable.
- Supports both ClickHouse (via native protocol, port 9000) and Postgres.
- Runs as a one-shot container in compose (`restart: "no"`), not a daemon.
- Tracks applied migrations in a `schema_migrations` table per database;
  skips already-applied migrations on subsequent boots (idempotent).
- Does not require embedding migration logic in the Rust binary (refinery's
  model), keeping the ingester's dep tree lean.

Known limitation — **one SQL statement per migration file for ClickHouse**:
dbmate's ClickHouse driver sends each `-- migrate:up` block as a single
SQL string. ClickHouse rejects multi-statement strings with "Multi-statements
are not allowed." DDL and DML must be in separate files. This is why
`pricing_versions` is split into `20260513000003_pricing_versions.sql`
(CREATE TABLE) and `20260513000004_pricing_seed.sql` (INSERT INTO).
Postgres does not have this limitation, but we follow the same convention
for consistency.

Migration file layout:
```
db/
├── clickhouse/migrations/   ← dbmate reads from here
│   ├── 20260513000001_observations.sql
│   ├── 20260513000002_observation_body.sql
│   ├── 20260513000003_pricing_versions.sql
│   └── 20260513000004_pricing_seed.sql
└── postgres/migrations/     ← dbmate reads from here
    ├── 20260513000001_users.sql
    ├── 20260513000002_projects.sql
    ├── 20260513000003_api_keys.sql
    ├── 20260513000004_fixtures.sql
    ├── 20260513000005_bisect_jobs.sql
    └── 20260513000006_dev_seed.sql
```

The original `infra/clickhouse/migrations/` and `infra/postgres/migrations/`
files remain in the repo as historical reference but are no longer mounted
into containers. The `infra/clickhouse/init/000_create_database.sh` is also
no longer mounted — the ClickHouse image creates the database named in
`CLICKHOUSE_DB` automatically on startup.

The ingester's `depends_on` now includes `migrate-clickhouse` and
`migrate-postgres` with `condition: service_completed_successfully`, so
the ingester only starts after migrations have been applied.

### D25. Dashboard healthcheck uses 127.0.0.1, not localhost
The compose healthcheck for the dashboard uses `wget -qO- http://127.0.0.1:3000`
rather than `http://localhost:3000`. Inside the `node:20-alpine` container,
`localhost` does not reliably resolve to `127.0.0.1` when the `HOSTNAME`
environment variable is set to `0.0.0.0` (which is needed to bind the
Next.js server to all interfaces). Using the literal loopback address
bypasses the hostname resolution issue. The server itself binds correctly
to `0.0.0.0:3000` and is reachable from the host at `localhost:3000`.

---

## 2026-05-15 — Phase 2 Day 1 (Week 3)

### D26. Redis stream entry encoding: bincode over postcard
Each entry published to `halley:spans` encodes a `(ObservationRow, Vec<BodyRow>)`
tuple — the already-normalized, already-hashed pair produced by the receiver
after the full pipeline: `OtlpSpan → CanonicalSpan → (ObservationRow, Vec<BodyRow>)`.
The writer deserializes this tuple, deduplicates body hashes within the batch,
and inserts to ClickHouse.

Encoding choice: **bincode** (v1.x, `bincode = "1"`).

Reasons:
- More widely used than postcard; more community familiarity.
- Slightly larger payloads than postcard but negligible at our scale (a single
  span entry is ~1-2 KB; Redis stream overhead dominates).
- `serde`-based, so the same `#[derive(Serialize, Deserialize)]` annotations
  already on `ObservationRow` and `BodyRow` work without changes.
- No `#[no_std]` requirement; postcard's main advantage is embedded targets,
  which we do not have.

Re-evaluate in Week 4 if Redis bandwidth becomes a load-test bottleneck.
At that point, postcard would save ~20-30% payload size. The switch would
be a one-line dep change plus a version bump in the stream key name to
avoid mixed-encoding entries during a rolling restart.

### D27. Normalizer adapter detection priority
**SUPERSEDED by D31** (Phase 2 Day 2). D31 contains the complete and current
adapter registration order including the OpenLLMetry adapter added on Day 4.
The original D27 text is preserved below for history.

The `Normalizer::normalize()` method tries adapters in this order:

1. **halley-raw**: detect by `source_dialect = "halley-raw"` attribute on the
   `OtlpSpan`. This is an explicit opt-in from the `/v1/spans/json` receiver
   and must be checked first to avoid misclassification.
2. **openllmetry**: detect by presence of any `traceloop.*` attribute key.
   OpenLLMetry is more specific than OTEL GenAI (it always adds `traceloop.*`
   keys on top of `gen_ai.*`), so it must be checked before the generic
   OTEL GenAI adapter to avoid the generic adapter claiming OpenLLMetry spans.
3. **otel-genai**: detect by presence of `gen_ai.system` or `gen_ai.provider.name`
   attribute. This is the fallback for any span that looks like a GenAI span
   but is not OpenLLMetry.
4. **fallback**: if no adapter matches, return a `NormalizeError::UnknownDialect`
   and emit a metrics event. The span is NOT dropped — the raw OTLP payload
   is preserved in the DLQ stream for later reprocessing (Week 4).

This priority is documented in a code comment above `Normalizer::normalize()`
in `normalizer/mod.rs`.

### D28. Rust toolchain bump: 1.83 → 1.85
Bumped `rust-toolchain.toml` and `Cargo.toml` `rust-version` from 1.83 to 1.85.

Reason: `tonic 0.14.x` (the current stable series, required for OTLP/gRPC on
Week 3 Day 5) uses `edition = "2024"`. Rust edition 2024 was stabilized in
Rust 1.85.0 (released 2025-02-20). Any crate using `edition = "2024"` implicitly
requires Rust ≥ 1.85 as its MSRV. The plan's reference to "tonic 0.13" was
stale — that version does not exist on crates.io; the series went 0.12 → 0.14.

`opentelemetry-proto` with the `gen-tonic` feature transitively requires tonic
0.14, so it also requires 1.85.

`prost 0.13.x` stays on `edition = "2021"` and is fine on 1.85.
`redis 0.27.x` stays on `edition = "2021"` and is fine on 1.85.
`proptest` and `metrics-exporter-prometheus` are fine on 1.85.

### D29. ICU pin re-evaluation after 1.85 bump
After bumping to 1.85, `cargo update` walked the ICU family forward to 2.2.0,
which requires Rust 1.86. The same D21 pattern repeats one version later.

Pinned back to the last 1.85-compatible versions:

| crate                | pinned | latest (requires 1.86) |
|----------------------|--------|------------------------|
| `idna_adapter`       | 1.2.1  | 1.2.2                  |
| `icu_collections`    | 2.0.0  | 2.2.0                  |
| `icu_locale_core`    | 2.0.1  | 2.2.0                  |
| `icu_normalizer`     | 2.0.1  | 2.2.0                  |
| `icu_normalizer_data`| 2.0.0  | 2.2.0                  |
| `icu_properties`     | 2.0.2  | 2.2.0                  |
| `icu_properties_data`| 2.0.1  | 2.2.0                  |
| `icu_provider`       | 2.0.0  | 2.2.0                  |
| `uuid`               | 1.23.1 | (no MSRV issue, walked forward fine) |

`uuid` walked forward to 1.23.1 cleanly — no pin needed.

The ICU 2.2.0 crates are a coordinated release; they all require each other at
2.2.0. Pinning `icu_normalizer` to 2.0.1 pulls the whole family back.
The root of the chain is `idna_adapter`, which must also be pinned to 1.2.1.

When we eventually bump to Rust 1.86 (no known trigger yet), `cargo update`
will walk all of these forward. Until then, `cargo update` on 1.85 will
respect the MSRV-aware resolver and not re-introduce the break.

### D30. Writer retry classification: transient vs permanent errors
The original writer used a fixed MAX_RETRIES (3) loop for all insert failures.
This was wrong: with 3 retries at 200/400/800ms backoff, the writer DLQ'd
every span within ~1.4 seconds. ClickHouse takes 5-15s to restart. Result:
every span posted during a ClickHouse outage ended up permanently in the DLQ,
defeating the entire purpose of the Redis Streams buffer.

**Correct mental model:**
- The Redis buffer exists to absorb infrastructure outages. The writer should
  hold spans in the PEL (Pending Entry List) until ClickHouse recovers.
- DLQ is for un-fixable data: bincode decode failures, schema errors. These
  will never succeed no matter how long we wait.

**Classification logic** (in `pipeline/writer.rs::is_transient_error()`):
- TRANSIENT: error string contains "network", "connect", "connection refused",
  "dns", "timeout", "broken pipe", "reset by peer", "eof", "os error", "tcp",
  "io error". These are infrastructure failures.
  → Retry forever with exponential backoff capped at 30s (200ms, 400ms, 800ms,
    1.6s, 3.2s, 6.4s, 12.8s, 25.6s, 30s, 30s, ...).
  → Do NOT XACK. Entries stay in the PEL so they survive a writer restart.
  → Do NOT increment a "retries remaining" counter.
- PERMANENT: anything else (schema mismatch, bad data, etc.).
  → MAX_RETRIES (3) attempts with short backoff, then DLQ + XACK.

**Shutdown interruptibility:**
The backoff sleep uses `tokio::select!` so a shutdown signal during a long
transient backoff does not hang the process. On shutdown during transient
retry, the batch is left in the PEL — the next writer instance will pick it
up via XAUTOCLAIM or on reconnect.

**Backoff formula:** `min(200ms * 2^attempt, 30_000ms)` where `attempt` is
only incremented for permanent errors. Transient retries always use the same
formula but with a counter that resets on each new batch.

---

## 2026-05-15 — Phase 2 Day 2 (Week 3)

### D31. Hand-rolled OtlpSpan intermediate type (not prost-generated)
The normalizer trait takes a hand-rolled `OtlpSpan` struct as input rather than
the prost-generated `opentelemetry_proto::tonic::trace::v1::Span`.

Reasons:
- Decouples the normalizer from the protobuf crate. All three receiver layers
  (HTTP JSON, OTLP HTTP protobuf, OTLP gRPC) produce the same `OtlpSpan` before
  handing off to the normalizer. The normalizer has no protobuf dependency.
- Property tests can generate arbitrary `OtlpSpan` values with proptest without
  constructing prost types (which require careful field initialization).
- The `AnyValue` enum mirrors OTLP's `oneof value` exactly where we need it
  (String, Bool, Int, Double, Bytes, Array, Kvlist) without the prost wrapper.

The `OtlpSpan` struct lives in `domain/otlp_span.rs`. The OTLP HTTP and gRPC
receivers (Days 3 and 5) will convert prost-generated types into `OtlpSpan`
at the receiver boundary, keeping the conversion logic isolated.

Adapter detection priority (also documented in `normalizer/mod.rs`):
1. **halley-raw**: `source_dialect = "halley-raw"` attribute. Explicit opt-in
   from `/v1/spans/json`; must be first to avoid misclassification.
2. **openllmetry** (Day 4): any `traceloop.*` attribute key. More specific than
   OTEL GenAI; must precede it.
3. **otel-genai**: `gen_ai.system` or `gen_ai.provider.name` attribute. Fallback
   for any GenAI span not claimed by a more specific adapter.
4. **fallback**: `NormalizeError::UnknownDialect`. Span is not dropped.

**Updated Day 4**: OpenLLMetry adapter (`normalizer/openllmetry.rs`) is now
registered in the `Normalizer::new()` adapter Vec between halley-raw and
otel-genai. A span carrying both `gen_ai.system` and any `traceloop.*` key
is detected as "openllmetry" (not "otel-genai") because openllmetry has
higher priority. Verified by `detection_priority_openllmetry_beats_otel_genai`
unit test in `normalizer/openllmetry.rs`.

---

## 2026-05-15 — Phase 2 Day 3 (Week 3)

### D32. OTLP fixture generation: test helper in tests/gen_otlp_fixture.rs
The files `ingester/fixtures/otlp-genai-trace.bin` and
`ingester/fixtures/otlp-openllmetry-trace.bin` are deterministic
protobuf-encoded `ExportTraceServiceRequest` payloads used by the smoke test.

**How they were generated:**
Run `cargo test --test gen_otlp_fixture -- --nocapture` from `ingester/`.
The file contains two test functions:
- `generate_otlp_genai_fixture()` → `fixtures/otlp-genai-trace.bin` (349 bytes)
- `generate_otlp_openllmetry_fixture()` → `fixtures/otlp-openllmetry-trace.bin` (463 bytes)

Both use fixed trace_id, span_id, and timestamps for determinism.
Re-run the test to regenerate if the OTLP protobuf schema changes.

---

## 2026-05-15 — Phase 2 Day 5 (Week 3)

### D33. tonic pinned to 0.12.x; 0.14.x bump deferred
`opentelemetry-proto 0.27` already pulls in `tonic v0.12.3` transitively
(confirmed via `cargo tree | grep tonic`). Adding `tonic = "0.12"` explicitly
to `Cargo.toml` uses the same version already in the dep tree — no second
tonic version, no MSRV concern.

The original Phase 2 plan referenced "tonic 0.13" (which does not exist on
crates.io; the series went 0.12 → 0.14). Bumping to 0.14.x would require
Rust 1.85+ (edition 2024) and would introduce a second tonic version alongside
the 0.12.3 already pulled by opentelemetry-proto. Deferred until a feature
demands it (e.g., tonic interceptors, TLS, or a new opentelemetry-proto release
that bumps its own tonic dep).

**No `build.rs` needed**: the `gen-tonic` feature on `opentelemetry-proto`
ships pre-generated tonic code for `TraceServiceServer` and `TraceServiceClient`.
The `TraceService` trait is at:
`opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceService`

**gRPC smoke client**: implemented as a `[[bin]]` target (`src/bin/smoke_grpc.rs`)
rather than a `[[test]]` target. Reasons:
- `[[test]]` targets run in the test harness and cannot easily be invoked from
  a shell script with a simple exit code.
- `[[bin]]` targets compile to a standalone binary that `cargo run --bin smoke-grpc`
  can invoke from `smoke.sh` with a clean exit code contract.
- The binary is not shipped in the Docker image (it is a dev-only tool).

**Shared ingest logic**: `pipeline/ingest.rs` contains `ingest_otlp_request()`
which is called by both `http/otlp.rs` and `grpc/otlp.rs`. This avoids
duplicating the ResourceSpans → ScopeSpans → Span iteration loop and ensures
both receivers produce identical canonical rows for equivalent payloads.

---

## 2026-05-15 — Phase 2 Week 4 Day 1

### D31 update — adapter Vec order extended with openinference and vercel-ai

**Supersedes the D31 "Updated Day 4" note.** The complete and current adapter
registration order as of Week 4 Day 1 is:

1. **halley-raw**: `source_dialect = "halley-raw"` attribute. Explicit opt-in
   from `/v1/spans/json`; must be first to avoid misclassification.
2. **openllmetry**: any `traceloop.*` attribute key. More specific than OTEL
   GenAI; must precede it.
3. **openinference** (Day 1): `openinference.span.kind` OR `llm.model_name`.
   Must come before otel-genai because OpenInference spans may also carry
   `gen_ai.*` attributes in mixed instrumentations. A span with both
   `traceloop.*` and `openinference.*` resolves to openllmetry (earlier in Vec).
4. **vercel-ai** (Day 2): `ai.operationId` OR any `ai.model.*` / `ai.usage.*`
   attribute. Must come before otel-genai for the same reason as openinference.
5. **otel-genai**: `gen_ai.system` or `gen_ai.provider.name`. Fallback for any
   GenAI span not claimed by a more specific adapter.
6. **fallback**: `NormalizeError::UnknownDialect`. Span is not dropped.

Detection priority is documented in a code comment above `Normalizer::new()`
in `normalizer/mod.rs`.

### D32 update — three OTLP fixtures

The file `ingester/fixtures/otlp-openinference-trace.bin` was added on Week 4
Day 1. The generation function is `generate_otlp_openinference_fixture()` in
`ingester/tests/gen_otlp_fixture.rs`.

Current fixture inventory:
- `otlp-genai-trace.bin` (349 bytes) — OTEL GenAI span
- `otlp-openllmetry-trace.bin` (463 bytes) — OpenLLMetry span
- `otlp-openinference-trace.bin` — OpenInference LLM span

A fourth fixture (`otlp-vercel-ai-trace.bin`) will be added on Day 2.

### D37. OpenInference `llm.system` vs `llm.provider` — live spec is the source of truth

The Week 4 plan (`phase-2-week-4.md`) originally listed `llm.provider or llm.system`
as the attribute for `gen_ai_system`. The live OpenInference spec
(github.com/Arize-ai/openinference/blob/main/spec/llm_spans.md, verified
2026-05-15) uses `llm.system` exclusively:

> "llm.system: The AI system/product (e.g., 'openai', 'anthropic')"

`llm.provider` does not appear in the live spec. The adapter uses `llm.system`
only. The plan doc has been corrected to remove the ambiguity.

### D38. OpenInference `llm.invocation_parameters` — preserve in attributes

`llm.invocation_parameters` is a JSON string of model parameters (temperature,
max_tokens, etc.) emitted by OpenInference instrumentations. It has no
corresponding canonical field in `CanonicalSpan`. Rather than silently dropping
it, the adapter explicitly re-inserts it into `CanonicalSpan.attributes` after
the unknown-key pass. This preserves the data for downstream consumers (dashboard,
fixture replay) without polluting the canonical schema.

### D39. OpenInference CHAIN → invoke_agent mapping

`openinference.span.kind = "CHAIN"` maps to `gen_ai_operation = "invoke_agent"`,
same as `"AGENT"`. Rationale: chains in OpenInference are orchestration roots
(LangChain chains, LangGraph graphs) — they have the same run-grouping semantics
as agent spans. When `is_run_root` is wired on Day 3, both `"AGENT"` and
`"CHAIN"` will set `is_run_root = true`. This is noted in a code comment in
`normalizer/openinference.rs` so Day 3 picks it up without re-reading this entry.

---

## 2026-05-15 — Phase 2 Week 4 Day 2

### D31 update — vercel-ai added to adapter Vec

**Supersedes the Day 1 D31 update.** Complete adapter registration order as of
Week 4 Day 2:

1. **halley-raw** — `source_dialect = "halley-raw"` attribute.
2. **openllmetry** — any `traceloop.*` attribute key.
3. **openinference** — `openinference.span.kind` OR `llm.model_name`.
4. **vercel-ai** — `ai.operationId` OR `ai.model.id` OR `ai.model.provider`.
   Must come before otel-genai: Vercel AI SDK v6 emits `gen_ai.*` attributes
   on inner `doGenerate`/`doStream` spans alongside `ai.*` attributes.
5. **otel-genai** — `gen_ai.system` or `gen_ai.provider.name`. Fallback.
6. **fallback** — `NormalizeError::UnknownDialect`.

### D32 update — four OTLP fixtures

`ingester/fixtures/otlp-vercel-ai-trace.bin` added on Week 4 Day 2.
Generation function: `generate_otlp_vercel_ai_fixture()` in
`ingester/tests/gen_otlp_fixture.rs`.

Current fixture inventory:
- `otlp-genai-trace.bin` — OTEL GenAI span
- `otlp-openllmetry-trace.bin` — OpenLLMetry span
- `otlp-openinference-trace.bin` — OpenInference LLM span
- `otlp-vercel-ai-trace.bin` — Vercel AI SDK generateText span

### D40. Vercel AI SDK token attribute precedence: ai.usage.* over gen_ai.usage.*

Vercel AI SDK v6 emits token counts in two namespaces on the same span:
- `ai.usage.promptTokens` / `ai.usage.completionTokens` — on all LLM spans
  (outer `ai.generateText`, `ai.streamText`, etc.)
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` — additionally
  on inner `doGenerate`/`doStream` spans (OTEL semconv alignment)

The adapter prefers `ai.usage.*` (Vercel-native, always present) and falls
back to `gen_ai.usage.*` (present only on inner spans). This ensures both
outer and inner span shapes produce correct token counts without special-casing
the span type. The fallback also means a pure `gen_ai.*`-only span (e.g. from
a future SDK version that drops `ai.*`) would still work if it somehow passed
detection — though in practice otel-genai would claim it first.

Source verified: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry (AI SDK v6,
checked 2026-05-15).

---

## 2026-05-15 — Phase 2 Week 4 Day 3

### D34. Write-time vs read-time run grouping

**Decision:** Run grouping is split across two tiers:

1. **Write-time (per-span):** `run_id = trace_id` always. `is_run_root = true` when the span explicitly declares itself an agent root via operation name or attribute (tiers 1 and 2 from the original design). This is a per-span decision with no cross-span state.

2. **Read-time (dashboard query):** Trace-level aggregation ("show all traces with multiple LLM spans") is a `GROUP BY` query, not a write-time flag.

**What was reconsidered:** The original ARCHITECTURE.md §3.4 described four tiers, including tier 3 ("trace with >1 LLM span → trace root is run root"). Tier 3 requires looking at sibling spans before deciding what the current span is — in a streaming pipeline this means holding a per-trace buffer with a timeout, then flushing. That is a significant operational complexity: buffer memory, timeout tuning, partial-trace handling on restart. The benefit is marginal: tier 3 traces are already queryable at read time with a simple aggregation. The cost is not worth it.

**The sharper rule:** `is_run_root` is set iff the span carries an explicit agent-root signal. Traces without such a signal are still queryable as "runs of one" or as "multi-LLM traces" at read time. The dashboard's run list query is fast either way.

**Schema:** `is_run_root Bool DEFAULT false` added to `halley.observations` via migration `20260520000001_observations_is_run_root.sql`. `DEFAULT false` ensures existing rows (pre-migration) get the correct value without a backfill.

**Per-adapter rules:**
- `halley-raw`: `gen_ai_operation == "invoke_agent"` OR `halley.run.kind == "agent"`
- `otel-genai`: `gen_ai.operation.name == "invoke_agent"` OR `halley.run.kind == "agent"`
- `openllmetry`: above OR `traceloop.span.kind == "agent"`
- `openinference`: `gen_ai_operation == "invoke_agent"` (covers AGENT and CHAIN via span kind mapping) OR `halley.run.kind == "agent"`
- `vercel-ai`: `ai.operationId` starts with `"ai.agent"` OR `halley.run.kind == "agent"`

---

## 2026-05-15 — Phase 2 Week 4 Day 4

### D35. Prometheus metrics: single-server model (mounted on axum, not a separate port)

The `/metrics` endpoint is mounted on the existing axum HTTP server at `:4318`
alongside the ingest endpoints, rather than on a separate port (e.g. `:9090`).

**Reasons:**
- Simpler deployment: one port to expose, one healthcheck, one TLS termination
  point if we add TLS later.
- No second `TcpListener` or tokio task. The `PrometheusHandle::render()` call
  is synchronous and cheap — it just serializes the in-memory metric state.
- Scrape traffic is negligible compared to ingest traffic; no isolation needed.
- The `TraceLayer` on the axum router logs `/metrics` requests like any other
  request, which is fine — scrape requests are low-frequency and the logs are
  useful for debugging.

**Tradeoff acknowledged:** In a multi-tenant or high-security deployment, you
might want metrics on a separate internal port so the scrape endpoint is not
reachable from the public ingest port. For Halley's self-hosted single-org
model this is not a concern. If it becomes one, the fix is a second
`TcpListener` + a second `Router` with only the `/metrics` route — a 10-line
change.

**Implementation:** `metrics-exporter-prometheus 0.16` with
`PrometheusBuilder::new().install_recorder()`. The returned `PrometheusHandle`
is stored in `AppState` and called in the `GET /metrics` handler.

---

## 2026-05-15 — Phase 2 Week 4 Day 5

### D36. Load test methodology and results

**Methodology:**
- Tool: k6 `constant-arrival-rate` executor, target 5,000 RPS for 5 minutes.
- Payload: `ingester/fixtures/otlp-genai-trace.bin` (349 bytes, one OTEL GenAI span), embedded as base64 in the k6 script.
- Transport: OTLP/HTTP protobuf (`Content-Type: application/x-protobuf`) to `/v1/traces`.
- Network: k6 container on `halley_default` Docker network, targeting `http://halley-ingester:4318/v1/traces`. macOS Docker Desktop does not support `--network=host`; the compose network is the correct approach.
- Single run, no tuning iterations (achieved > 1K RPS threshold).

**Hardware:** Apple M2, 8 GB RAM, Docker Desktop (all services co-located on the same host).

**Results:**
- Achieved sustained RPS: **4,792 spans/sec** (95.8% of 5K target)
- p50 latency: 1.69 ms
- p95 latency: 113.93 ms
- p99 latency: 185.15 ms
- Error rate: 0.00% (1,438,636 / 1,438,636 requests succeeded)
- Dropped iterations: 61,389 (k6 could not schedule them within the rate limit — VU pool exhausted at peak)
- Peak Redis stream lag: ~1.48M entries (writer lagged behind ingest rate during the test)
- Post-test drain: writer drained all 1.48M entries with 0 data loss (XPENDING = 0 after drain)
- ClickHouse rows: 1,438,636 otel-genai rows from the load test (exact match to k6 successful requests)

**Bottleneck:** The ingester receiver is not the bottleneck — a 5-second sanity check with 5 VUs achieved ~9K RPS. At 5K RPS sustained, the single ClickHouse writer task becomes the constraint. The writer batches 500 spans or 100ms, whichever comes first; at 5K ingest RPS, the writer can only drain ~4.8K spans/sec, causing the Redis stream to grow during the test. The Redis buffer absorbed the burst correctly and the writer drained everything after the test ended. p99 latency exceeded the 50ms target because the `XADD` call occasionally queues behind the writer's batch flush under sustained load.

**No tuning was performed.** The achieved rate (4,792 RPS) is above the 1K RPS threshold for iteration. The bottleneck is the single writer task; adding a second writer instance (consumer group supports it without code changes) would likely push throughput past 5K RPS.

---

## 2026-05-15 — Phase 3 Week 5 Day 1

### D41. No proprietary `@halley/sdk` shipped in Phase 3 (or any phase without user demand)

Halley's core pitch is "we ingest whatever your app already emits via OTLP."
Shipping a proprietary SDK contradicts that pitch in two ways:

1. It implies that Halley requires the SDK to work, which is false. Any
   OTLP-emitting stack (OpenLLMetry, OpenInference, Vercel AI SDK, raw
   `@opentelemetry/sdk-node`) works with Halley today without any Halley-specific
   package. A proprietary SDK creates a false dependency in users' minds.

2. It creates a maintenance burden with no validated user need. An SDK that
   wraps OTEL with "sensible defaults" is a thin layer that will drift from
   the underlying OTEL SDK as OTEL evolves. We would be maintaining a wrapper
   for a problem users have not yet told us they have.

The correct approach: ship 5-10 line quickstart snippets per language that show
users how to point their existing OTEL setup at Halley's OTLP endpoint. If real
users post-launch ask for a wrapper (e.g., "I don't want to configure OTEL
myself"), build one in Phase 6 with their specific requirements. Building
speculatively without users is worse than not building at all.

ROADMAP North-star item #3 updated from "`@halley/sdk` published to npm as
v0.1.0" to "Three example apps in three different stacks emit real OpenAI traces
into one Halley dashboard." See ROADMAP v0.5 revision log entry.

### D42. Pricing-version migration pattern: same UUID, later `effective_from`

When updating `pricing_versions` with real values (replacing Phase 1 placeholder
zeros), we reuse the existing `pricing_version_id`
(`00000000-0000-0000-0000-000000000001`) and insert new rows with a later
`effective_from` timestamp. `ReplacingMergeTree(effective_from)` deduplicates
rows with the same `ORDER BY` key `(pricing_version_id, model)`, keeping the
row with the highest `effective_from` value after background merge.

**Why reuse the same UUID instead of a new one:**
- All existing `observations` rows from Phase 1/2 already reference
  `pricing_version_id = 00000000-0000-0000-0000-000000000001`. Reusing the
  same UUID means those rows automatically pick up the real prices on the next
  read-time cost computation — no backfill needed.
- This is the desired behavior: retroactive repricing of dev observations proves
  that Phase 4's read-time cost computation works correctly. Dev observations
  are not production data; repricing them is a feature, not a bug.
- A new UUID would require either a backfill of `observations.pricing_version_id`
  (expensive, unnecessary) or leaving dev observations pointing at zero-cost
  rows forever (misleading for dashboard testing).

**Dedup timing caveat:** `ReplacingMergeTree` dedup is eventual — it happens
on background merge, not immediately after INSERT. After the migration runs,
`SELECT * FROM pricing_versions` may still show both the old zero rows and the
new real-value rows for a few minutes. Use
`SELECT * FROM pricing_versions FINAL ORDER BY effective_from DESC` for the
canonical view, or wait for merge. The `FINAL` modifier forces dedup at query
time. This is documented in the migration file header and in the Week 5 common
pitfalls section.

**One SQL statement per migration file (D24 constraint):** The pricing update
is a single `INSERT INTO` statement, so it fits in one file. No DDL change
needed — the table schema is unchanged.

### D43. gpt-4o-mini only for all example app runs; gpt-4o in pricing_versions only

All three example apps (`reasoning-agent-python`, `vercel-ai-app`,
`openai-direct-typescript`) use `gpt-4o-mini` exclusively. No code we run
calls `gpt-4o`. Budget: ~$0.005 per run, ~400 runs available on the $5 key.

`gpt-4o` is present in `pricing_versions` with real pricing because real users
of Halley may use it, and we want their cost data to be correct from day one.
Its presence in the pricing table does not imply we call it.

This supersedes the original D-7 guardrail in `docs/plan/phase-3-week-5.md`,
which reserved `gpt-4o` for the README demo capture. The README demo will also
use `gpt-4o-mini`. The quality difference is not visible in a trace viewer
screenshot.

---

## 2026-05-15 — Phase 3 Week 5 Day 2

### D44. Traceloop SDK 0.55+ migrated to OTEL GenAI semconv; openllmetry adapter is now legacy-only

**Discovery:** When running `traceloop-sdk 0.60.0` (the current pip-latest as of
2026-05-15) against Halley, spans landed as `source_dialect = "otel-genai"` rather
than `"openllmetry"`. Investigation confirmed this is intentional and permanent.

**What changed in the SDK:**

`traceloop-sdk 0.55.0` (released 2026-03-29) shipped PR #3844: "feat(open-ai):
instrumentation to support OTel GenAI Semantic Conventions 0.5.1." This PR
replaced the legacy `SpanAttributes` / `traceloop.*` namespace with upstream
`gen_ai.*` attributes from the OTEL GenAI Semantic Conventions 0.5.0 spec.
Specifically:
- `traceloop.span.kind`, `traceloop.entity.name`, `traceloop.entity.input`,
  `traceloop.entity.output` — no longer emitted on LLM spans.
- `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens` — now the primary attributes.
- `openai.response.service_tier`, `gen_ai.openai.api_base` — OpenAI-specific
  extras still present, but no `traceloop.*` keys.

Subsequent releases (0.56–0.60) migrated other providers (Gemini, Bedrock,
LangChain, LlamaIndex, Groq) to the same OTEL GenAI semconv standard.

**Impact on Halley's normalizer:**

Halley's `openllmetry` adapter detects spans by the presence of any `traceloop.*`
attribute key (D31). With 0.55+, no such keys are emitted. Spans correctly fall
through to the `otel-genai` adapter, which handles them perfectly — model ID,
token counts, operation name all normalize correctly.

**Decision:**

Accept this as correct behavior. The `openllmetry` adapter remains in the
normalizer for users on `traceloop-sdk < 0.55` (legacy `traceloop.*` namespace).
Modern versions (0.55+) flow through `otel-genai`. This is the right outcome:
Traceloop converging on the OTEL standard means their users' traffic is
indistinguishable from any other OTEL GenAI-compliant instrumentation, which is
exactly what Halley's "normalize, don't reject" design is built for.

**No ingester code change needed.** The existing adapter priority order handles
both old and new Traceloop traffic correctly.

**Implication for the three example apps (Week 5):**

The original plan had three distinct dialect paths: openllmetry (Day 2),
vercel-ai (Day 3), openllmetry (Day 4). With this finding, Day 4 is changed to
use OpenInference instrumentation instead, giving three genuinely distinct paths:
- Day 2 (Reasoning Agent): `otel-genai` (Traceloop 0.55+)
- Day 3 (Vercel AI app): `vercel-ai`
- Day 4 (Direct TypeScript): `openinference`

See `docs/research/openllmetry-2026-migration.md` for the full research note.

---

## 2026-05-21 — Phase 3 Week 6 Day 1

### D45. Flat spans table moved to `/spans`, not removed

The Week 6 Day 1 plan (Phase 3 Week 6) says: "Remove the spans-list view from
the existing page (if it was the entire page). Or keep it accessible at `/spans`
for debugging — your call."

**Choice: move to `/spans`, not removed.**

Rationale:

- During Days 2-4 of Week 6 (run detail, span inspector), the `/spans` flat
  table is a fast sanity check: after running an example app, `GET /spans`
  confirms that new observations landed in ClickHouse before debugging whether
  the runs-list query groups them correctly. Removing it would force a ClickHouse
  CLI query for that same check.
- The route adds no maintenance burden: it is unchanged from Phase 1 except for
  a breadcrumb link back to `/` and a "Debug view" badge. No new ClickHouse
  queries, no new components.
- Once Phase 4 ships auth and the dashboard becomes multi-user, `/spans` can be
  gated or removed without breaking anything at `/`.

The page at `dashboard/src/app/spans/page.tsx` is a verbatim copy of the
original `page.tsx` with three additions: a "← Runs" breadcrumb, a "Debug view"
badge, and the route file move. The original `page.tsx` is now the runs list.

---

## 2026-05-21 — Phase 3 Week 6 Day 2

### D46. Vercel AI SDK outer-span token aggregation: acknowledged limitation, not fixed

**Context:** Vercel AI SDK emits two span shapes for a single LLM call:
- Outer span (`ai.generateText`, `ai.streamText`): token counts in
  `attributes['ai.usage.inputTokens']` and `attributes['ai.usage.completionTokens']`
  as strings in the `Map(String, String)` attributes column. The canonical
  `gen_ai_usage_input_tokens` / `gen_ai_usage_output_tokens` columns are 0.
- Inner span (`doGenerate`, `doStream`): token counts in both `ai.usage.*`
  attributes AND the canonical `gen_ai_usage_*` columns.

**Impact on the runs list:** `SUM(gen_ai_usage_input_tokens)` in `listRuns()`
misses the outer span's tokens. For a simple `generateText` call, the run total
is correct because the inner `doGenerate` span already carries the canonical
columns. For runs using `streamText` without inner spans, the total would be
under-counted.

**Decision: acknowledge the limitation, do not fix it in Phase 3.**

The fix would require a SQL expression like:
```sql
SUM(
  CASE
    WHEN source_dialect = 'vercel-ai'
      AND gen_ai_usage_input_tokens = 0
      AND attributes['ai.usage.inputTokens'] != ''
    THEN toUInt64(attributes['ai.usage.inputTokens'])
    ELSE gen_ai_usage_input_tokens
  END
) AS total_input_tokens
```
This adds complexity to the core `listRuns()` query and has edge cases
(null string coercion, mixed-span runs). The Vercel AI SDK adapter already
prefers `ai.usage.*` at write time (D40), so canonical columns are populated
on inner spans. The dashboard token total is correct for the common case.

The proper fix belongs in Phase 4 cost work, where the query can be tested
against a broader set of real Vercel runs. Until then, a tooltip or note in
the UI is not added (it would appear for all rows, not just Vercel ones, and
would be confusing).

**The runs list shows a footnote comment in code** (not in UI) pointing here.

---

## 2026-05-21 — Week 6 Day 5

### D47. Reactflow graph shipped (not deferred); SSR isolation via dynamic(ssr:false) wrapper

The Day 5 stretch goal was conditionally scheduled — attempt only if Days 1-4
went cleanly (they did). The reactflow graph was implemented within the 3-hour
budget.

**Implementation approach:**

- `reactflow` + `@dagrejs/dagre` added to `dashboard/` deps.
- `SpanGraph.tsx` — Client Component (`"use client"`). Imports `reactflow` and
  the dagre layout engine. Custom node type (`spanNode`) renders each span with
  operation-color-coded backgrounds that match the Day 3 timeline palette.
  `NODE_TYPES` constant defined at module scope (not inside the component) to
  prevent ReactFlow re-registering node types on every render.
- `SpanGraphWrapper.tsx` — thin Client Component that imports `SpanGraph` via
  `next/dynamic({ ssr: false })`. This is the SSR isolation layer: ReactFlow
  accesses `ResizeObserver`, `window.devicePixelRatio`, and other browser
  globals at module init time. If Next.js attempted to evaluate the ReactFlow
  module during server rendering it would throw. The `ssr: false` wrapper
  ensures the heavy ReactFlow bundle never executes on the server.
- `page.tsx` (Server Component) imports `SpanGraphWrapper` and renders it
  conditionally when `?view=graph`. Tab bar uses `<Link>` so tab switches are
  soft navigations (RSC re-render, no full reload).

**Bundle cost:** The ReactFlow bundle is lazily loaded only when a user navigates
to the Graph tab. The shared server-side bundle grew by only ~0.5 kB
(the `SpanGraphWrapper` wrapper). The actual ~200 kB ReactFlow chunk loads
client-side on demand.

**Node click → inspector:** clicking a node pushes `?view=graph&span=<hex>` via
`useRouter`. The existing `SpanInspector` (Days 4) handles the `?span=` param
regardless of which `?view=` is active — no changes to the inspector were needed.

---

## 2026-05-26 — Phase 4 Day 5

### D48. API key design: hash-only storage, prefix identification, Redis TTL

**Design choices for Ingester API Key Validation:**

1.  **Prefix Identification (`hlly_`)**: All generated keys start with `hlly_`. This makes it immediately obvious to developers what the token is for, allows Secret Scanning tools (like GitHub Advanced Security) to easily detect accidentally committed keys, and allows the ingester to quickly reject obviously malformed headers before hashing.
2.  **Hash-Only Storage (SHA-256)**: The raw API key is never stored in Postgres. Instead, we compute the SHA-256 hash of the token and store `key_hash` in `api_keys`. When the user creates the key, they see the raw token exactly once. This ensures that a compromised database does not leak usable API keys. SHA-256 is sufficient (no bcrypt needed) because the token is a high-entropy 32-byte base62 string generated by a CSPRNG, making dictionary attacks impossible.
3.  **Redis Cache with 60s TTL**: Querying Postgres on every single telemetry span/trace would bottleneck the ingester under load. Instead, the ingester checks Redis for `hlly_key_hash:<hash>`. On a cache miss, it queries Postgres and sets the Redis key with an `EX 60` (60 seconds) TTL.
    *   *Tradeoff*: If a key is revoked in the dashboard, it may remain valid in the ingester for up to 60 seconds until the Redis TTL expires. This is an acceptable tradeoff for the massive performance gain of avoiding database lookups on the hot path.
4.  **Dev-Mode Bypass (`HALLEY_AUTH_REQUIRED=false`)**: By default in local development, the ingester bypasses auth and assigns all spans to the `DEV_PROJECT_ID`. This preserves the zero-config "it just works" experience for local testing, while allowing production deployments to enforce strict auth by flipping the env var to `true`.

---

## 2026-05-28 — Phase 4 Week 8 Day 2

### D49. SSE over WebSocket for live span updates

**Decision:** The live span update channel (`GET /api/runs/[id]/live`) is implemented as Server-Sent Events (SSE) over a `ReadableStream`, not WebSockets.

**Constraints that ruled out WebSockets:**

Next.js 14 App Router route handlers (`app/api/*/route.ts`) are standard Web Fetch API handlers that return `Response` objects. The Node.js `http.Server` upgrade event required for WebSocket handshakes is not surfaced through the App Router's request pipeline — there is no documented, supported way to upgrade an App Router route to a WebSocket connection. The Phase 4 plan's risk register acknowledged this ("WebSocket in Next.js API routes is limited") and listed a standalone Node WS server on port 4319 as a fallback. That standalone server would require its own Dockerfile layer, inter-process coordination, and CORS configuration, adding meaningful operational complexity for a communication channel that is server→client only.

**Why SSE is the correct fit:**

The live span channel is unidirectional: the server pushes new span events to the browser; the browser never sends data back over this channel. SSE (the `EventSource` browser API backed by `text/event-stream` responses) is purpose-built for exactly this pattern. A `ReadableStream` returned from a Next.js route handler with `Content-Type: text/event-stream` works natively in the App Router and is in-process — no extra server, no port, no proxy configuration.

Required response headers:
- `Content-Type: text/event-stream` — identifies the SSE protocol.
- `Cache-Control: no-cache, no-transform` — prevents any intermediary from buffering the stream.
- `Connection: keep-alive` — keeps the underlying TCP connection open.
- `X-Accel-Buffering: no` — disables nginx proxy buffering (critical for Docker + reverse proxy deployments).

`EventSource` provides built-in auto-reconnect with a configurable retry interval, which is sufficient for Day 2. Exponential backoff and a visual reconnection indicator are Day 3 work.

**Implementation:** Each SSE connection creates a dedicated `ioredis` connection that subscribes to `halley:live:<run_id>`. On each Redis message, the handler enqueues an SSE frame (`data: <raw json>\n\n`) into the `ReadableStream`. On `request.signal` abort (browser disconnect or navigation away), the handler unsubscribes and calls `quit()` on the ioredis connection before closing the controller. No connections are leaked.

**Known v1 scaling tradeoff — one Redis subscriber per SSE connection:**

This is a deliberate limitation, not an oversight. Each open SSE connection holds one dedicated Redis subscriber connection. For Halley's self-hosted, single-organisation v1 use case — where the typical concurrent viewer count is 1–5 people watching the same run — this is entirely acceptable. Redis supports thousands of subscriber connections and the overhead per connection is negligible at this scale.

The known ceiling: if many users simultaneously watch the same run (fan-out scenario), each holds their own subscriber on the same channel, causing the Redis server to emit N copies of every published message (one per subscriber). The fix is a shared in-process subscriber per channel with a registry of active `ReadableStreamDefaultController` instances — one Redis message fan-fanned to N controllers in memory. This is straightforward to build but adds state-management complexity that is not justified for v1 single-org self-hosted deployments. When Halley supports multi-org SaaS with concurrent viewers, this is the correct upgrade path and the change is contained to the SSE route handler.

---

## 2026-05-28 — Phase 4 Week 8 Day 4

### D50. Table-qualify WHERE-clause columns (ClickHouse 24.8 analyzer alias shadowing)

ClickHouse 24.8 enables the new query analyzer by default, which propagates
SELECT-list aliases into the WHERE clause. A query that names a computed alias
the same as the underlying column — e.g.
`SELECT hex(span_id) AS span_id ... WHERE hex(span_id) = {spanId:String}` —
now resolves the `span_id` inside WHERE to the *alias* (the already-hex string),
yielding `hex(<hex_string>)`, which can never match the raw-bytes column. The
symptom is silent: the query returns zero rows with no error.

**This was the real root cause of the span-inspector "won't open" bug** —
`getSpanDetail()` returned null because its WHERE never matched. It was NOT the
Next.js router cache that the Day 3 work assumed; that is why reseeding with
fresh, valid data did not fix it. The Day 3 `SpanBarLink` push/refresh +
`Suspense key` changes were treating a symptom; they are harmless and left in
place.

**Rule:** in `dashboard/src/lib/halley-query/`, any WHERE/HAVING predicate that
references a column which also appears aliased in the SELECT must use the
table-qualified name (`hex(observations.span_id)`,
`hex(observation_body.body_hash)`). Table-qualified references bypass alias
resolution and bind to the raw column. Fixed in `halley-query/detail.ts`
(two WHERE clauses). Applies to every future query module under `halley-query/`.

### D51. Replay interception: thin per-language in-process shim, not an HTTP proxy.

**D51. Replay interception via a thin per-language in-process shim, not an HTTP proxy.** The Rust `halley` CLI orchestrates replay but delegates interception to a small per-language shim that patches the client/transport layer (Python `httpx`/`requests` first, TS `fetch`/`undici` second — the `vcr-llm` approach). The shim canonicalizes + hashes each provider/tool request (D22), matches the cassette (hit → recorded response, $0; miss → live call recorded as a new version), and shares one cassette format + hash across languages.

**Rationale (researched against the May-2026 state of the art):** the tools shipping this pattern (`vcr-llm`, `pytest-agentcontract`, `agentsnap`, `llm-test-harness`) all intercept in-process, because (1) LLM calls all POST to one URL so URL-based proxy matching fails, (2) a proxy loses SSE streaming frame boundaries — breaking bit-fidelity, and (3) a proxy can't see in-process tool calls — which would gut Halley's "same tools, same order" structural invariant. Interception is not Halley's differentiator (portable in-repo fixtures + `bisect` + tool-effect-safe replay are), so the mechanism is chosen to protect those.

**Tradeoff:** a shim is per-language. Mitigated by shipping Python first (the flagship demo is Python), reusing `sdk-ts/` for TS, and documenting an HTTP-proxy fallback for languages without a shim. Superseded only if a future single-binary interception approach proves equal on streaming + in-process tools.

---

## 2026-05-29 — Phase 5 Week 9 Day 4

### D52. Fixture format v1 and replay-matching spec: LOCKED CONTRACT

**Fixture format v1** (`fixture_format_version: 1`) is the on-disk representation of a Halley regression fixture. Once a fixture file is committed to a user's repo it is immutable from Halley's perspective — the replay shim (Week 10) and the CI runner (Phase 6) read it verbatim. Changing field names or semantics without incrementing `fixture_format_version` is a breaking change.

**On-disk layout:**

```
halley/fixtures/
  <slug>.json              # fixture index — the "cassette manifest"
  <slug>/
    bodies/
      sha256-<hash>.json   # one file per unique body (input or output); content-addressed
```

**`<slug>.json` top-level fields (v1):**

| Field | Type | Description |
|---|---|---|
| `fixture_format_version` | `1` | Literal integer 1. Presence = v1 contract; absence = unknown/pre-contract. |
| `fixture_id` | UUID string | Postgres fixtures.id. Used to match the on-disk file back to the DB row. |
| `source_run_id` | 32-char hex | The trace/run that was recorded. |
| `run_name` | string | Human-readable name from the recording session. |
| `started_at_ms` | integer | Unix epoch ms of the first span's start. |
| `dialect` | string | OTLP dialect of the source run (`otel-genai`, `openllmetry`, `vercel-ai`, `halley-raw`, …). |
| `top_model` | string | First non-empty `gen_ai_request_model` in the run. |
| `written_at` | ISO 8601 UTC | When the fixture writer job ran. |
| `observations` | array | Ordered span list (execution order, index 0 = first span). |
| `invariants` | object | Full `invariants_json` as last edited by the user (structural/schema/metric/semantic). |
| `replay_matching` | object | Replay-matching spec (see below). |

**`observations[i]` fields (v1):**

| Field | Type | Description |
|---|---|---|
| `index` | integer | 0-based position in execution order. |
| `span_id` | 16-char hex | Canonical span ID (upper-case). Changes on every replay — not used as a match key. |
| `parent_span_id` | 16-char hex | Parent span ID; `"0000000000000000"` = root. |
| `operation` | string | `gen_ai_operation` (e.g. `chat`, `execute_tool`). |
| `model` | string | `gen_ai_request_model`. |
| `system` | string | `gen_ai_system` (e.g. `openai`). |
| `status` | string | `ok`, `error`, `timeout`. |
| `started_at_ms` | integer | Unix epoch ms. |
| `ended_at_ms` | integer | Unix epoch ms. |
| `duration_ms` | integer | `ended_at_ms - started_at_ms`. |
| `input_tokens` | integer | Prompt/input token count. |
| `output_tokens` | integer | Completion/output token count. |
| `match_key` | 64-char hex | D22 canonical-JSON SHA-256 of the recorded input body. Used by the replay shim to identify which observation to serve. Empty string if no input body was captured. |
| `input_body_ref` | string \| null | Relative path to the input body file (`halley/fixtures/<slug>/bodies/sha256-<hash>.json`), or null. |
| `output_body_ref` | string \| null | Relative path to the output body file, or null. |

**`replay_matching` object (v1):**

```json
{
  "strategy": "input_body_hash_v1",
  "description": "..."
}
```

Strategy `input_body_hash_v1`: the replay shim (Week 10) intercepts each outgoing LLM call, computes `hex(SHA-256(canonical_json(request_body)))` using the same D22 algorithm that produced the recorded `match_key`, and looks up the matching `observations[i]`. On hit: serve `output_body_ref`. On miss: live call, record new version.

**Body files** (`sha256-<hash>.json`): contain the parsed JSON of the recorded input or output body. Content-addressed by the stored ClickHouse `body_hash` (SHA-256 of the D22 canonical JSON), deduplicated — if two spans share the same body, they reference the same file. The hash is **not recomputed** by the writer; it is reused from `halley.observation_body.body_hash` as stored by the ingester. This is correct because the ingester already applies D22 canonicalization before hashing.

**Rationale:** portable, in-repo, vendor-independent fixtures that travel with the codebase are Halley's core differentiator versus hosted platforms (Braintrust, Langfuse, Patronus). The fixture is a plain JSON file a developer can read, diff, and commit — no proprietary format, no API dependency, no account required to run regression tests. `fixture_format_version` enables non-breaking additions (new top-level keys at v1 are ignored by older tooling) and explicit migration when breaking changes are needed.

---

## 2026-05-29 — Phase 5 Week 9 Day 4 (review)

### D53. Bit-fidelity replay comes from a dual-mode capture shim, not from OTLP. Refines D51 and D52.

**Context — the gap caught in the Day 4 fixture-format review.** The fixture
format (D52) defines `match_key` as the D22 SHA-256 of the recorded *input body*,
and the replay shim (D51) was assumed to match a live provider call against it.
But the bodies stored in `halley.observation_body` for every OTLP dialect are a
**gen_ai-semantic reconstruction**, not the raw provider payload. For
`otel-genai` (the flagship reasoning-agent), `input_body` is assembled from
`gen_ai.*.message` span events as `[{role, content}, …]`
(`ingester/src/normalizer/otel_genai.rs`); it omits `model`, `temperature`,
`tools`, `seed`, and the full response object (`id`, `usage`, `finish_reason`).
Standard OTLP gen_ai instrumentation never emits the full raw payloads — the
bytes are gone before telemetry is created. Therefore:

1. `hash(canonical(live raw request))` cannot equal a `match_key` computed over a
   gen_ai-semantic body — they are different JSON. Pure OTLP cassettes are not
   byte-replayable.
2. **"Bit-fidelity cassette" is physically impossible from OTLP alone.** Raw bytes
   must be captured at the source.

**Decision.** The per-language shim from D51 is **dual-mode** and is the
bit-fidelity capture point:

- **Record mode (runs in production and under `halley record`):** wraps the
  provider client, passes the call through untouched, and captures the **full raw
  request and response JSON**, emitting them to Halley as a `halley-raw` span
  (the dialect already accepts arbitrary bodies). `observation_body` then holds
  byte-faithful payloads.
- **Replay mode (CI):** intercepts each call, canonicalizes with the **same code
  path**, matches `match_key`, serves the recorded response.

Because one shim canonicalizes in both modes, record/replay representation parity
is guaranteed by construction, and a production run through the shim *is* a
directly replayable cassette (no separate record pass). Both product claims hold
literally: **bit-fidelity cassette = true**, **production traffic IS your test
suite = true** — for runs captured through the shim.

**Two-tier capture model (the honest framing):**
- **Tier 1 — any OTLP instrumentation, zero Halley code:** observability, run
  grouping, cost, invariant *inference*. Broad compatibility; bodies are
  gen_ai-semantic, not byte-faithful.
- **Tier 2 — add the Halley recorder (one-line client wrap):** everything in
  Tier 1 **plus** bit-fidelity cassettes that replay at $0 in CI. This is the
  hero loop.

This is consistent with ARCHITECTURE §3.1 ("Halley SDK, optional") — the SDK is
elevated from optional convenience to the bit-fidelity capture path, but OTLP
remains the zero-friction observability tier. It matches how every working replay
tool operates (instrument the client; see the D51 research on vcr-llm, nock,
Braintrust's SDK wrapper).

**Consequent refinements:**
- **`match_key` matching is ordinal, not pure lookup.** When multiple calls in a
  run share an input hash (loops, retries), the shim consumes recorded
  observations of that `match_key` in `index` order via a per-key cursor. The
  D52 `replay_matching` description must say so; "look up the matching
  observation" alone is ambiguous and was a v1 hole.
- **The D52 fixture format is provisional, not locked, until Week 10 validates it
  against the real shim.** The `LOCKED CONTRACT` banner in
  `docs/fixture-format.md` is downgraded to "v1 — provisional pending Week 10
  replay validation." The on-disk *shape* is stable; `match_key` semantics and
  the body source (shim-raw vs OTLP-semantic) are confirmed in Week 10.
- **`match_key` and body-file hashes must be the same case (lowercase).** The Day
  4 artifact emitted `match_key` upper-case while body filenames were lower-case;
  a case mismatch breaks string-equality matching. Fix before the format is
  considered final.

**Impact on Week 10:** the shim now ships record mode (production capture) in
addition to replay mode. Plan updated in `docs/plan/phase-5-overview.md`.

---

## 2026-05-31 — Phase 6 Week 11 Day 1

### D54. Dashboard enqueues + displays; a host-side runner (the worker on the host) executes CI and bisect; terminal commands are always shown.

**Context.** Phase 5 shipped the hero loop end-to-end *from the terminal*
(`~/halley-hero-demo/demo.sh`: ci → regression → bisect, 6.6 s, $0). The dashboard
does the *promote and edit* half perfectly, but the *execution* half — `halley ci`
and `halley bisect` — only works from the CLI. The dashboard's "Run bisect" button
is a fragile stub: it shells out to a host binary via hardcoded `/Users/...` paths
from inside a Node container that has neither the Rust binary, the user's git repo,
the agent's Python venv, nor `halley.config.json`.

**Why this is architecture, not a bug.** `halley bisect` checks out old commits of
*the user's agent code* and re-runs *the user's agent* (their Python, venv, deps) at
each commit. No generic server container can contain an arbitrary user's agent +
environment — this is exactly why `git bisect`, GitHub self-hosted runners, and
Buildkite agents all execute **where the code lives**. The fix is the
industry-standard **runner/agent pattern**: the dashboard enqueues and displays;
a runner on the machine with the repo executes and streams results back.

**Decision.**

- **The worker is the runner, split by job type (v1 model — locked):**
  - **Docker worker** handles the **code-only jobs** that need only
    Postgres/ClickHouse/Redis: `invariant.infer` and `fixture.write`. These work out
    of the box with `docker compose up` — promote and edit need zero host setup.
  - **Host worker** handles the **repo-touching jobs** that need the user's git repo,
    agent venv, CLI binary, and `halley.config.json`: `ci.run` (new, Day 3) and
    `bisect.run`. Run on the host (`npm run dev` in `worker/`, env pointed at
    `localhost:5433 / :6380 / :8123`).
  - **Routing:** jobs are split across two BullMQ queue groups so a Docker worker and
    a host worker can run simultaneously without stealing each other's jobs. The
    Docker worker subscribes to `invariant.infer` + `fixture.write`; the host worker
    subscribes to `ci.run` + `bisect.run`. Implemented via separate `Worker`
    registrations keyed by queue name (already the pattern in `worker/src/index.ts`),
    launched via an env flag `HALLEY_WORKER_ROLE=docker|host|all`.
  - **v1 simplest-path alternative (documented):** one host worker subscribing to
    **all four** queues (`HALLEY_WORKER_ROLE=all`) is acceptable for v1 if the split
    adds friction — but the dev docs must state clearly which model is in use. The
    default documented model is the role-split above.
- **Per-fixture execution context** (new DB columns, Day 2) tells the host worker
  *which git repo* and *which `halley.config.json`* a fixture belongs to. No hardcoded
  paths, no slug-guessing.
- **Reachability is explicit.** A host worker writes a Redis heartbeat
  (`halley:runner:heartbeat`, short TTL) on a timer. The dashboard reads it: runner
  present → CI/bisect buttons execute and stream results; runner absent → buttons
  switch to **"Copy command"** showing the exact `halley` invocation. Never a silent
  failure, never a fake "running" state.
- **Honest degradation:** if a repo-touching job is enqueued with no host runner
  available, it resolves to status `needs_runner` with the copy-paste command in the
  log — surfaced in the UI, not a crash or a hang.
- **Terminal commands are first-class UX (never hidden).** Every dashboard action that
  can run in the terminal shows the exact `halley` command with a copy button. This is
  required, not a fallback (see discipline D-23).

**Product story after Phase 6.** *The dashboard drives the whole loop. A lightweight
Halley runner on your machine executes the parts that need your code (CI + bisect).
Prefer the terminal? Every action shows the exact `halley` command to copy.* We do
**not** claim "our SaaS container runs your Python agent." v1 is: self-hosted Halley +
runner on the machine with the agent repo, **or** the terminal, with commands shown in
the UI.

**Tradeoff.** Users must run a runner locally for one-click dashboard CI/bisect.
Mitigated by (1) the dev path being "just run the worker on the host" — the worker
already reads every connection from env vars with `localhost` defaults, so launching it
on the host is near-zero-code; (2) always-visible terminal commands; (3) the existing
GitHub Action covering the CI half in real PRs. Superseded only if a future
sandboxed-execution design (e.g. ephemeral per-repo containers) proves safe and general.

---

## 2026-05-31 — Phase 6 Week 12 Day 1

### D55. Ingester Docker build uses a repo-root context (scoped by `.dockerignore`), not `./ingester`, so the `halley-canonical` path dependency resolves.

**Context.** Week 11 Day 1 extracted the D22 canonical-JSON + SHA-256 algorithm
into a standalone `halley-canonical/` crate (a sibling of `ingester/` and `cli/`,
wired via a `path` dependency `halley-canonical = { path = "../halley-canonical" }`
in `ingester/Cargo.toml` — see D22, and the Week 11 checkpoint). The change was
built and tested **host-side** with cargo (per D-2/D-16), where `../halley-canonical`
resolves against the real filesystem. The ingester Docker image was **never rebuilt**
in Week 11: D-8 (no Docker rebuild on adapter-only days) and D-21 (worker Docker
rebuild at most once per day it changes) meant nothing forced an ingester image
rebuild, so the break stayed **latent** until the Week 12 Day 1 `docker compose up`.

**The break.** The ingester `build.context` was `./ingester`. A Docker build context
is the root of what the daemon can see, so `COPY` (and the cargo build inside) could
not reach `../halley-canonical` — it lives *outside* `./ingester`. The build failed at
dependency resolution:
```
failed to get `halley-canonical` as a dependency of package `halley-ingester`
  failed to read `/halley-canonical/Cargo.toml`
```
Host cargo worked precisely because it *can* see the sibling crate; Docker could not.
This broke `docker compose up` for **every fresh clone** — the exact one-command
install the README now leads with.

**Decision.** Build the ingester from the **repo-root context** so both crates are
visible, preserving the on-disk sibling layout inside the image:

- `docker-compose.yml`: ingester `build.context: .` + `dockerfile: ingester/Dockerfile`
  (was `context: ./ingester`).
- `ingester/Dockerfile`: all `COPY` paths are now root-relative. Copy
  `halley-canonical/` (Cargo.toml + Cargo.lock + src) alongside `ingester/` under
  `/build`, then build from the `/build/ingester` subdir so `../halley-canonical`
  resolves byte-for-byte as it does on the host. The stub-main dependency-cache layer
  (added pre-D15 era for fast rebuilds) is preserved; only its working directory moved
  to `/build/ingester`. The runtime stage copies the binary from
  `/build/ingester/target/release/halley-ingester`.
- New root `.dockerignore`: ignore everything (`*`), then re-include only `ingester/`
  and `halley-canonical/`, and drop `**/target` + `.DS_Store`. This keeps the larger
  root context from ballooning (the whole repo — `dashboard/node_modules`, `.next`,
  `.git`, demo `.mov`/`.gif`, etc. — would otherwise be sent to the daemon).

**Scope.** Only the **ingester** image is affected. `cli/` is host-only (D-16) and is
never built in Docker. `dashboard/` and `worker/` keep their own subdir contexts
(`./dashboard`, `./worker`) — they have no path dependency on `halley-canonical` and
are unchanged. The ingester runtime stage and its `curl` healthcheck (D15) are
unchanged. This is a build-infrastructure fix: **no locked contract changes** (canonical
schema, D22 algorithm, fixture format v1, D54 all untouched; D22's byte-for-byte output
is identical — the crate is copied, not modified).

**Verification.** `docker compose build ingester` succeeds with the root context, and
`docker compose up -d` brings all six services up healthy (including the rebuilt
ingester). Proven end-to-end from a clean state (Week 12 Day 1):
`docker compose down -v && docker compose up -d && make ready && make smoke` — the
freshly built ingester image comes up healthy and the smoke suite passes 20/20.

**Lesson / guard.** A host-side path-dependency extraction (D22 → `halley-canonical`)
silently invalidates any Docker image whose context excludes the new sibling crate.
Because D-8/D-21 suppress routine ingester rebuilds, such a break can hide until the
next clean boot. The permanent guard is Halley's own CI (`.github/workflows/ci.yml`),
which builds the ingester crate per-commit; a `docker compose build ingester` step in
CI would catch the *image* form of this specific regression directly (candidate
follow-up, not added this turn to keep Day 1 asset-scoped).
