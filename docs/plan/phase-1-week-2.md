# Phase 1, Week 2 — Dashboard placeholder scope

**Window**: Mon May 18 through Sat May 24, 2026 (Sunday May 24 off)
**Effort budget**: ~25 to 30 hours across 6 working days
**Goal**: A Next.js 14 dashboard that reads from ClickHouse and renders a table of spans. `docker compose up` brings it up alongside the ingester. The ingester and dashboard together form the complete Phase 1 deliverable.

This doc is the single source of truth for Week 2. Execute exactly what it specifies.

---

## Context: what Week 1 shipped

Week 1 shipped more than the ROADMAP planned:
- Full ClickHouse and Postgres migrations.
- Rust ingester with real insert path, canonical JSON hashing, content-addressed body storage.
- Multi-stage Dockerfile, compose wiring, smoke test.
- `make smoke` passes 8/8 on a clean boot.

What is still missing from Phase 1:
- Dashboard placeholder (Next.js page that reads observations and renders a table).
- Migration tooling decision (D5 deferred from Week 1).
- Research tasks: read OTEL GenAI semconv, skim Langfuse v4 and Laminar source.

Week 2 delivers all three.

---

## In scope

1. Next.js 14 App Router dashboard scaffold.
2. One server-rendered page that queries ClickHouse and renders a table of observations.
3. Dashboard wired into `docker-compose.yml` with a healthcheck.
4. Migration tooling decision: pick one of the three candidates from D5 and implement it for ClickHouse and Postgres.
5. Research: read OTEL GenAI semconv end to end, skim Langfuse v4 and Laminar source. Write notes to `docs/research/`.
6. Update `ROADMAP.md` revision log with Week 1 and Week 2 status.

## Explicitly out of scope

- Auth (Phase 4).
- API keys UI (Phase 4).
- Reasoning graph / reactflow (Phase 4).
- WebSocket live updates (Phase 4).
- Run detail page (Phase 4).
- Any TypeScript SDK work (Phase 3).
- OTLP receiver (Phase 2).
- Redis Streams (Phase 2).
- Prometheus metrics (Phase 2).

---

## Repo layout after Week 2

```
halley/
├── dashboard/
│   ├── package.json
│   ├── package-lock.json
│   ├── next.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── postcss.config.mjs
│   ├── Dockerfile
│   ├── .dockerignore
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx          ← spans table
│       │   └── globals.css
│       └── lib/
│           └── clickhouse.ts     ← ClickHouse query helper
├── docs/
│   └── research/
│       ├── otel-genai-semconv.md
│       ├── langfuse-v4.md
│       └── laminar.md
├── infra/
│   ├── clickhouse/
│   │   └── migrations/           ← new files if migration tool changes approach
│   └── postgres/
│       └── migrations/           ← same
└── docs/plan/
    └── phase-1-week-2.md         ← this file
```

---

## Day-by-day plan

### Day 1 (Mon May 18, ~4-6 hrs): Migration tooling decision + Next.js scaffold

**Part A: Migration tooling (2 hrs)**

Decide between the three candidates from D5 and implement it.

Recommendation (for the exec chat to follow unless there's a reason not to):

Use **dbmate**. Reasons:
- Single binary, no runtime dep, works for both ClickHouse and Postgres.
- SQL-file based: migrations are plain `.sql` files, readable, diffable, reviewable in PRs.
- Supports ClickHouse via the `clickhouse` driver.
- Runs as a one-shot container in compose, not a daemon.
- Does not require embedding migration logic in the Rust binary (that's refinery's model, which is more complex for Week 2).

If the exec chat finds a concrete reason dbmate does not work for ClickHouse (driver gap, version incompatibility), fall back to a custom shell-script runner. Document the decision in DECISIONS.md as D24.

Implementation:
- Add a `dbmate` service to `docker-compose.yml` that runs migrations on startup and exits. Use `depends_on` with `condition: service_healthy` for ClickHouse and Postgres.
- Move existing migration SQL files from `infra/clickhouse/migrations/` and `infra/postgres/migrations/` into the dbmate directory structure (`db/migrations/` or keep in `infra/` — follow dbmate's convention).
- The existing `initdb.d` mounts can stay as a fallback for the first boot, but dbmate becomes the authoritative migration runner going forward.
- Verify: `docker compose down -v && docker compose up -d && make ready` still passes with migrations applied by dbmate.

**Part B: Next.js scaffold (2-3 hrs)**

Initialize the dashboard project.

```bash
cd dashboard
npx create-next-app@14 . --typescript --tailwind --app --no-src-dir --import-alias "@/*"
```

Wait — the plan uses `src/` layout. Use:
```bash
npx create-next-app@14 . --typescript --tailwind --app --src-dir --import-alias "@/*"
```

After scaffolding:
- Delete the default `page.tsx` content (keep the file).
- Delete `public/` placeholder images.
- Add `@clickhouse/client` to `package.json` (the official ClickHouse JS client).
- Create `src/lib/clickhouse.ts` with a `createClient()` helper that reads `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` from `process.env`.

**Acceptance Day 1**:
- `cd dashboard && npm run build` succeeds (empty app, no errors).
- Migration tooling decision documented in DECISIONS.md D24.

### Day 2 (Tue May 19, ~4-6 hrs): Spans table page

Build the one page that matters for Phase 1.

**`src/app/page.tsx`** — server component, no `"use client"`.

Queries:
```sql
SELECT
  hex(trace_id)                    AS trace_id,
  hex(span_id)                     AS span_id,
  gen_ai_system,
  gen_ai_operation,
  gen_ai_request_model,
  gen_ai_usage_input_tokens        AS input_tokens,
  gen_ai_usage_output_tokens       AS output_tokens,
  source_dialect,
  run_name,
  status,
  formatDateTime(start_time, '%Y-%m-%d %H:%M:%S') AS started_at
FROM halley.observations
ORDER BY start_time DESC
LIMIT 100
```

Render as an HTML table with Tailwind classes. No pagination, no filters, no sorting controls. Static render on every request (no caching for now — this is a dev tool, not a production app).

**`src/lib/clickhouse.ts`**:
```typescript
import { createClient } from "@clickhouse/client";

export function getClickHouseClient() {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    database: process.env.CLICKHOUSE_DATABASE ?? "halley",
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
  });
}
```

**`src/app/layout.tsx`**: minimal layout, title "Halley", dark background (`bg-gray-950 text-gray-100`), no nav yet.

**Acceptance Day 2**:
- `npm run dev` starts the dashboard.
- `curl http://localhost:3000` returns HTML containing a `<table>`.
- After posting a span via `curl -X POST localhost:4318/v1/spans/json -d @ingester/fixtures/hello-span.json`, refreshing the page shows the row.
- `npm run build` still clean.

### Day 3 (Wed May 20, ~4-6 hrs): Dashboard Dockerfile + compose wiring

**`dashboard/Dockerfile`** — multi-stage, same pattern as the ingester:
- Stage 1: `node:20-alpine` installs deps and builds (`npm ci && npm run build`).
- Stage 2: `node:20-alpine` runs the production server (`npm start`).
- Non-root user (`nextjs`, uid 1001).
- `EXPOSE 3000`.
- `CMD ["node", "server.js"]` or `npm start` — follow Next.js standalone output convention.

For Next.js standalone output, add to `next.config.ts`:
```typescript
const nextConfig = {
  output: "standalone",
};
```

This copies only the necessary files into `.next/standalone/`, making the Docker image smaller.

**`dashboard/.dockerignore`**: `node_modules/`, `.next/`, `.env*`.

**`docker-compose.yml`**: add dashboard service:
```yaml
dashboard:
  build:
    context: ./dashboard
  container_name: halley-dashboard
  restart: unless-stopped
  env_file: .env
  ports:
    - "3000:3000"
  depends_on:
    clickhouse:
      condition: service_healthy
    ingester:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000"]
    interval: 10s
    timeout: 5s
    retries: 10
    start_period: 30s
```

Note: `node:20-alpine` has busybox `wget` which supports `-qO-` (fetch to stdout). Use that instead of `curl` since curl is not in the alpine node image by default.

Add to `.env.example`:
```
# Dashboard
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Acceptance Day 3**:
- `docker compose down -v && docker compose up -d && make ready` brings all five services healthy (clickhouse, postgres, redis, ingester, dashboard).
- `curl http://localhost:3000` returns HTML.
- After posting a span, `curl http://localhost:3000` shows the span data in the HTML.

### Day 4 (Thu May 21, ~4-6 hrs): Research

No code. Read and take notes.

**Task 1: OpenTelemetry GenAI semantic conventions**

Read https://opentelemetry.io/docs/specs/semconv/gen-ai/ end to end, including:
- The main gen-ai spans page.
- The gen-ai agent spans page.
- The gen-ai events page.

Write `docs/research/otel-genai-semconv.md`. Required sections:
- Which attributes are stable vs experimental.
- The exact attribute names for: system, operation, request model, response model, input tokens, output tokens, finish reason.
- What `gen_ai.operation.name` values exist and which ones indicate an agent root span.
- What the event model looks like (prompt/completion as events vs attributes).
- One paragraph: what this means for the Phase 2 normalizer.

**Task 2: Langfuse v4**

Skim https://langfuse.com/docs/v4 and https://langfuse.com/changelog/2026-03-10-simplify-for-scale.

Write `docs/research/langfuse-v4.md`. Required sections:
- How they moved from trace+observations two-table to single observations table.
- How they handle OTLP ingestion (what endpoint, what header, what normalization).
- What their body/content storage looks like (do they store raw bodies? how?).
- One paragraph: what Halley does differently and why.

**Task 3: Laminar**

Skim https://docs.laminar.sh and https://laminar.sh/blog/2026-03-16-laminar-launch.

Write `docs/research/laminar.md`. Required sections:
- How their OTLP endpoint works.
- What their trace timeline / reader mode looks like (the UX they're proud of).
- Whether they have anything like cassette capture or fixture-based CI.
- One paragraph: what Halley does differently and why.

**Acceptance Day 4**: three research files exist under `docs/research/`, each with the required sections.

### Day 5 (Fri May 22, ~4-6 hrs): Polish and ROADMAP update

**Part A: Makefile additions**

Add two targets:
- `make dashboard-dev`: runs `npm run dev` in `dashboard/` for local development outside Docker.
- `make dashboard-build`: runs `npm run build` in `dashboard/`.

**Part B: ROADMAP.md revision log**

Add two entries to the revision log table:

| Date | Version | Change | Why |
|---|---|---|---|
| 2026-05-13 | 0.3 | Week 1 complete. Phase 1 ingester fully shipped (insert path, Dockerfile, smoke test). All Week 1 checklist items done. | Ran ahead of schedule; shipped insert path and Dockerfile in Week 1 instead of leaving for Week 2. |
| 2026-05-18 | 0.4 | Week 2 complete. Dashboard placeholder, migration tooling, research notes. Phase 1 deliverable met. | |

**Part C: Smoke test update**

Update `ingester/tests/smoke.sh` to also verify the dashboard is reachable:
- After the existing 8 assertions, add one more: `curl -fsS http://localhost:3000` returns 200.
- Update the assertion count in the summary line.

**Acceptance Day 5**:
- `make smoke` passes 9/9 (or 8/8 + the dashboard check, depending on how the script counts).
- ROADMAP.md revision log updated.

### Day 6 (Sat May 24, ~2 hrs): Commit, push, retro

Short day per the working agreement.

- `cargo fmt` and `cargo clippy` clean.
- `npm run build` clean.
- `docker compose down -v && docker compose up -d && make ready && make smoke` passes end to end.
- Write `## Week 2 retro` at the bottom of this file.
- Commit everything. Ayush pushes from GitHub Desktop.

---

## Environment variables added in Week 2

Add to `.env.example` (and `.env` locally):

```
# Dashboard
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

The ClickHouse variables already exist. The dashboard reads them from the same `.env` file via `env_file: .env` in compose.

---

## Common pitfalls to avoid

1. **`@clickhouse/client` vs `@clickhouse/client-web`**. Use `@clickhouse/client` (Node.js). The `-web` variant is for browser environments. Server Components run on Node.js.

2. **Next.js standalone output and server.js path**. With `output: "standalone"`, the production entry point is `.next/standalone/server.js`, not `node_modules/.bin/next`. The Dockerfile CMD must point at the right file. Check the Next.js docs for the exact path.

3. **ClickHouse `hex()` returns uppercase**. The smoke test and any hash comparisons must account for this. The spans table page just displays the hex strings; no comparison needed there.

4. **Dashboard `depends_on` ingester**. The dashboard does not strictly need the ingester to be healthy to start (it only reads from ClickHouse). But having it depend on the ingester ensures the full stack is up before the dashboard serves traffic. Keep the dependency.

5. **Do not add auth to the dashboard this week**. The page is unauthenticated. That is correct for Phase 1. Auth is Phase 4.

6. **Do not add `"use client"` to `page.tsx`**. The spans table is a Server Component. It fetches data on the server and renders HTML. No client-side JavaScript needed.

7. **Migration tooling: do not break the existing smoke test**. The smoke test truncates tables and inserts rows. If dbmate re-runs migrations on every `docker compose up`, it must not drop and recreate tables (that would break the truncate). Dbmate tracks applied migrations in a `schema_migrations` table and skips already-applied ones. Verify this behavior before committing.

8. **Research notes are for you, not for show**. Write them in plain language. One page each is enough. The goal is to have the information in your head before Phase 2 starts.

---

## Reviewer checklist (what I will run when this comes back)

### Repo hygiene
- [ ] `git status` clean on the branch.
- [ ] No `node_modules/` committed.
- [ ] No `.next/` committed.
- [ ] `dashboard/.dockerignore` excludes `node_modules/` and `.next/`.

### Migration tooling
- [ ] DECISIONS.md D24 documents the migration tool choice and why.
- [ ] `docker compose down -v && docker compose up -d` applies migrations correctly.
- [ ] A second `docker compose up` (no `-v`) does not re-run migrations or error.

### Dashboard
- [ ] `npm run build` in `dashboard/` exits 0.
- [ ] `docker compose ps` shows `halley-dashboard` as `healthy`.
- [ ] `curl http://localhost:3000` returns HTML with a `<table>` element.
- [ ] After posting `hello-span.json`, the table shows the row (trace_id, span_id, model, etc.).
- [ ] `next.config.ts` has `output: "standalone"`.

### Smoke test
- [ ] `make smoke` passes (9 assertions or 8+1 depending on implementation).
- [ ] `make smoke` is idempotent on second run.

### Research
- [ ] `docs/research/otel-genai-semconv.md` exists with required sections.
- [ ] `docs/research/langfuse-v4.md` exists with required sections.
- [ ] `docs/research/laminar.md` exists with required sections.

### Full stack
- [ ] `docker compose down -v && docker compose up -d && make ready && make smoke` passes on a clean boot.
- [ ] All five services healthy: clickhouse, postgres, redis, ingester, dashboard.

### Non-goals respected
- [ ] No auth code in the dashboard.
- [ ] No OTLP deps added to the ingester.
- [ ] No Redis Streams code.
- [ ] No SDK code under `sdk-ts/`.

---

## When to stop

Week 2 is done when every checkbox above passes. If it finishes early, do not start Phase 2. Use the time to deepen the research notes or clean up the dashboard's Tailwind styling. Write the Week 2 retro at the bottom of this file.
