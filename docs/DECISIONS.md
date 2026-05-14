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
