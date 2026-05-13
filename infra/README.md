# Halley Infrastructure

Local dev and deployment infrastructure:

- `docker-compose.yml` — full local stack (ClickHouse, Redis, Postgres, ingester, dashboard, worker)
- `clickhouse/migrations/` — schema for `halley.spans` and `halley.runs`
- `postgres/migrations/` — schema for auth, projects, API keys, eval suites

Populated during Phase 1 (Weeks 1–2).
