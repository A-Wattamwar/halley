# Phase 4 — Auth, Live Updates & Dashboard Hardening

**Timeline**: Weeks 7–8 (May 26 – June 8, 2026)
**Goal**: Dashboard usable for real debugging. Auth, project switching, API keys, live span streaming, and fixing the known bugs from Phase 3.

---

## Context

Phase 3 shipped a fully functional read-only dashboard (runs list, run detail with timeline + graph, span inspector with body fetching). Two bugs were discovered post-ship:

1. **Span inspector doesn't open** — Next.js 14 router cache serves stale RSC payloads when only `searchParams` change. The `?span=` param update never triggers a server re-render, so `spanDetail` stays null. Fix required in Phase 4.
2. **`parseDateTimeBestEffort64` needed for time filters** — fixed and committed (`35bdced`), but reveals that any future ClickHouse queries with ISO time params need the same wrapper.

Phase 4 scope per ROADMAP v0.5:
- Auth.js with email+password + Postgres adapter
- API keys page: create, rotate, revoke
- `halley-query` enforces project-scoped auth
- WebSocket `/api/ws/runs/:id` for live span updates via Redis Pub/Sub
- One Playwright E2E: emit span → see it in dashboard within 2 seconds

**Explicitly cut from v0.1** (per ROADMAP): full-text search, infinite scroll, column sorting, cmd+k palette, keyboard nav. Push to Phase 6 if time.

---

## What's owed from Phase 3

| Item | Status | Phase 4 action |
|------|--------|----------------|
| Span inspector router cache bug | Known bug | Fix in Week 7 Day 1 |
| Traceloop 0.55+ trace grouping (each span = separate trace) | Known limitation (D44) | Out of scope — adapter-level fix, not Phase 4 |
| Vercel outer-span token counts (D46) | Documented, deferred | Out of scope — Phase 4 cost work if time allows |
| `is_run_root` badge has no functional use beyond display | Minor | Leave as-is |

---

## Architecture changes

### New components

1. **Postgres `users` + `api_keys` + `sessions` tables** — Auth.js Postgres adapter. Migrations via dbmate (D24).
2. **Auth.js middleware** — protect all dashboard routes. Login page at `/login`.
3. **API keys table** — `api_keys(id, project_id, key_hash, prefix, name, created_at, revoked_at)`. Keys are SHA-256 hashed; only the prefix (`hlly_...8chars`) is stored in clear.
4. **WebSocket endpoint** — Next.js API route or standalone, subscribing to Redis Pub/Sub channel per `run_id`. Pushes new spans to the browser as they arrive.

### Modified components

1. **`halley-query/`** — every query function gains a `projectId` parameter. Server Components pass it from the session.
2. **Ingester** — validates API key on ingest (`Authorization: Bearer hlly_...`). Looks up `project_id` from Postgres (cached in Redis with 60s TTL). **This is the only Rust change in Phase 4.**
3. **`page.tsx` / `runs/[id]/page.tsx`** — wrapped in auth, session-aware.

### Unchanged

- ClickHouse schema (no new columns, no migrations)
- Canonical span shape
- Pricing pattern (D42)
- Adapter/normalizer code

---

## Week 7: Auth + API Keys (May 26–June 1)

### Day 1: Fix span inspector + Auth.js setup

**Inspector fix:**
- Add `router.refresh()` call in the span bar `<Link>` `onClick` handler, OR
- Switch to `useRouter().push()` with `{ scroll: false }` to force RSC re-fetch
- Verify: click bar → inspector slides in with data
- Do NOT create an API route (that was the wrong fix from the off-plan executor work)

**Auth.js:**
- `npm install next-auth @auth/pg-adapter pg`
- Postgres migration: `users`, `accounts`, `sessions`, `verification_tokens` (Auth.js schema)
- `auth.ts` config: CredentialsProvider with email+password, Postgres adapter
- `middleware.ts`: protect all routes except `/login` and `/api/health`
- `/login` page: email + password form, dark theme matching dashboard

**Acceptance:**
- `npm run build` clean
- `/login` renders, submitting redirects to `/`
- Unauthenticated requests to `/` redirect to `/login`
- Inspector opens when clicking a span bar

### Day 2: Seed user + session-aware queries

- Postgres migration: seed a dev user (`ayush@halley.dev` / hashed password)
- Add `getSession()` to all Server Component pages
- Pass `projectId` from session into `halley-query/` functions
- Add `project_id` filter to `listRuns()` and `getRunDetail()` ClickHouse queries
- Login → see runs → click run → see detail (end-to-end auth flow)

**Acceptance:**
- Full auth flow works: login → runs list → run detail → span inspector
- `npm run build` clean

### Day 3: API keys table + management page

- Postgres migration: `api_keys` table
- `/settings/keys` page: list keys (prefix + name + created_at), create new, revoke
- Key generation: `hlly_` + 32 random bytes (base62). Store SHA-256 hash only.
- Server Action for create/revoke (no API route needed)

**Acceptance:**
- Create key → shown once → copy → never shown again
- Revoke key → key disappears from list
- `npm run build` clean

### Day 4: Ingester API key validation

- **Rust change**: add `Authorization: Bearer hlly_...` header check on ingest endpoints
- Lookup flow: hash the key → query Postgres `api_keys` → get `project_id` → tag span with `project_id`
- Cache: Redis `SET hlly_key_hash:<hash> <project_id> EX 60`
- Fallback: if no auth header AND `HALLEY_AUTH_REQUIRED=false` (default in dev), accept with default project. This preserves backward compat for local dev.
- `docker compose build ingester` (one rebuild this week, D-1)

**Acceptance:**
- `make smoke` still passes (no auth required in dev mode)
- Sending a span with `Authorization: Bearer hlly_<valid>` → accepted, tagged with correct project
- Sending with invalid key → 401
- `cargo test` / `cargo clippy` clean

### Day 5: Polish + document

- Add D48 to DECISIONS.md: API key design (hash-only storage, prefix for identification, Redis cache TTL)
- Update `docs/quickstart/` README files with API key header examples
- Test full flow: create key in dashboard → use key in example app → see spans in dashboard
- Run `make smoke` with auth disabled (default) — must still pass

**Acceptance:**
- End-to-end: key created → used in curl/example app → spans appear in dashboard under correct project
- All docs updated
- `npm run build` + `cargo build` clean

---

## Week 8: Live Updates + E2E (June 2–8)

### Day 1: Redis Pub/Sub publisher (ingester side)

- After writing a span to ClickHouse, publish to Redis channel `halley:live:<hex_run_id>`
- Payload: minimal JSON (`{ span_id, gen_ai_operation, status, start_time, model }`)
- No schema change. This is a fire-and-forget PUBLISH.
- `docker compose build ingester` (second and final rebuild)

**Acceptance:**
- `redis-cli SUBSCRIBE halley:live:*` → send a span via smoke test → see the publish
- `cargo test` clean

### Day 2: WebSocket endpoint (dashboard side)

- Next.js API route or standalone server: `GET /api/ws/runs/:id` → upgrade to WebSocket
- Server subscribes to `halley:live:<run_id>` Redis channel
- On message → push to connected WebSocket clients
- Client component: `useWebSocket` hook that appends new spans to the timeline in real-time

**Acceptance:**
- Open run detail page → run example app → new spans appear without page refresh
- No full-page reload. Timeline grows live.

### Day 3: Live indicator UI + reconnection

- Pulsing green dot on run detail header when WebSocket is connected
- Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- "Live" / "Disconnected" badge
- Toast notification when new spans arrive while scrolled away

**Acceptance:**
- Kill and restart ingester → WebSocket reconnects → live updates resume
- Visual indicator clearly shows connected vs disconnected

### Day 4: Playwright E2E test

- Install Playwright + chromium in dashboard
- One E2E test: `test('span appears in dashboard within 2s')`:
  1. Login with seed user
  2. Navigate to runs list
  3. POST a span to ingester via HTTP
  4. Assert: new run appears in table within 2 seconds (WebSocket or poll)
  5. Click run → assert timeline has 1 span

**Acceptance:**
- `npx playwright test` passes
- Test runs in under 10 seconds

### Day 5: Retro + cleanup

- Run full hygiene: `cargo build/clippy/fmt/test`, `npm run build`, `make smoke`
- Write Phase 4 retro at bottom of `phase-4-week-8.md`
- Update ROADMAP.md revision log
- Screenshot: login page, API keys page, live updating timeline
- **Do not start Phase 5**

---

## Disciplines (carry over + new)

- **D-1 through D-9**: carry over from Phase 3
- **D-13**: Only TWO Docker rebuilds total in Phase 4 (Week 7 Day 4 + Week 8 Day 1). All other days are dashboard-only or doc-only.
- **D-14**: Auth.js CredentialsProvider only. No OAuth providers (GitHub, Google) until Phase 6 polish.
- **D-15**: API key validation in the ingester must have a dev-mode bypass (`HALLEY_AUTH_REQUIRED=false`) so `make smoke` and local dev work without keys.

---

## Locked contracts (unchanged)

All contracts from prior phases remain locked:
- Canonical schema (CanonicalSpan / ObservationRow shape)
- Hex-on-wire / bytes-in-DB (FixedString(16), FixedString(8), FixedString(32))
- Canonical JSON hashing rule (D22)
- Pricing-version migration pattern (D42)
- Adapter detection priority (D31)
- Run grouping split (D34)
- Migration tooling: dbmate (D24)
- Rust toolchain pinned at 1.85 (D28)

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Auth.js + Next.js 14 Server Components have rough edges | Use CredentialsProvider (simplest path). No edge runtime. |
| WebSocket in Next.js API routes is limited | If Next.js WS doesn't work, fall back to a standalone tiny Node WS server on port 4319 |
| Ingester Postgres connection adds latency to ingest | Redis cache (60s TTL) on key lookups. Hot path is Redis GET, not Postgres. |
| Playwright flaky in CI | Run with `--retries=1`. The 2-second assertion has generous timeout. |

---

## Reviewer checklist

Before approving each Day:
- [ ] No changes to locked contracts
- [ ] Docker rebuild only on Day 4 (Week 7) and Day 1 (Week 8)
- [ ] `npm run build` clean
- [ ] `cargo test` / `clippy` clean (on Rust-change days)
- [ ] No new dependencies not listed in this plan
- [ ] DECISIONS.md extended (not new entry) for minor corrections

---

## Phase 4 Retro

*Written Week 8 Day 5 (2026-05-28). Hygiene: all green.*

### What shipped

**Week 7 — Auth + API keys**
- Auth.js 4 CredentialsProvider with a Postgres adapter (bcrypt, seeded dev user). All dashboard pages guarded via middleware; `HALLEY_AUTH_REQUIRED=false` bypass for local dev (D-15).
- Project-scoped `halley-query` — every ClickHouse query now filters `WHERE project_id = …`, scoped to the session's project UUID (D-15 dev bypass returns a fixed UUID without hitting Postgres).
- API Keys page (`/settings/keys`): CRUD UI, `hlly_` prefixed tokens, SHA-256 hash-only storage in Postgres (plain text never persisted — D48).
- Ingester API key validation: single Postgres lookup on first use, then Redis 60 s TTL cache. Hot-path latency unchanged (D48, D-15).

**Week 8 — Live span streaming + E2E**
- SSE live span endpoint (`GET /api/runs/[id]/live`): dedicated ioredis subscriber per connection, relays Redis Pub/Sub `halley:live:<run_id>` to the browser. One-directional, App Router compatible, no WebSocket needed (D49).
- `useLiveSpans` hook: accumulates live spans, exposes `connState` (`connecting | open | disconnected`), exponential backoff reconnect (1 s → 2 s → 4 s, capped 30 s), generationRef guard prevents overlapping reconnects.
- `LiveSpansIsland`: pulsing green "Live" / grey "Disconnected" badge; `IntersectionObserver`-based toast ("N new spans") when scrolled out of the live section.
- SSE heartbeat: initial `": connected\n\n"` frame flushes response headers immediately so `EventSource.onopen` fires on idle runs; 25 s keepalive comment holds connections through idle proxies.
- Playwright E2E (`e2e/live-span.spec.ts`): posts a halley-raw span, polls `/?range=all` until the run row appears, clicks through to the run detail page, clicks a span bar, asserts the inspector opens with body content. Passes in **3.9 s** against the standalone Docker image.

### Notable bugs caught and fixed

**D50 — ClickHouse 24.8 analyzer alias shadowing (span inspector root cause)**
The new ClickHouse query analyzer (enabled by default in 24.8) propagates SELECT aliases into WHERE clauses. Both queries in `getSpanDetail` aliased computed expressions with the same name as the source column — e.g. `hex(span_id) AS span_id` — causing `WHERE hex(span_id) = '…'` to double-encode the value and match nothing. Fixed by using table-qualified column references (`observations.span_id`, `observation_body.body_hash`) in WHERE. This also affects the observation_body body-lookup sub-query. The fix is a two-line change; the root cause is not the Next.js router cache (which was the original hypothesis).

**Runs list "All time" applied a hidden 7-day floor.**
`listRuns` defaulted `fromTime` to 7 days ago when no time bound was passed; `resolveTimeRange("all")` passed no bound but the query applied the default. Fixed by making the time bound truly optional.

**SSE badge stuck on "Connecting…".**
`ReadableStream.start()` only enqueued bytes on Redis messages, so on idle runs the browser's `EventSource` never received bytes and `onopen` never fired. Fixed with an immediate `": connected\n\n"` frame on stream start.

### Debt carried forward (do not fix in Phase 5 without a plan entry)

- **D44 — Single-span Traceloop 0.55+ traces / no agent-root grouping.** Traceloop ≥ 0.55 emits one span per OTLP export (no parent-child grouping). The runs list shows N rows instead of 1 aggregated run. Fixing requires detecting the "single-span run" pattern and grouping by a semantic key.
- **D46 — Vercel outer-span token aggregation.** `ai.usage.*` attributes on Vercel AI SDK outer spans are not summed into the run totals; only `gen_ai_usage_*` canonical columns are aggregated. The dashboard understates token counts for Vercel AI traces.
- **Reasoning-agent example app answer parsing.** The `examples/reasoning-agent-python` app produces blank or wrong answers due to response-parsing logic that does not match the o1/o3 response format. This is an app-level bug; it does not affect ingestion or the dashboard. Flag for Phase 6 demo polish.

### Screenshots (to be captured manually by Ayush)

Directory: `docs/screenshots/` (exists — two screenshots already present from Phase 3).

Three expected additions for Phase 4:
- `docs/screenshots/login.png` — the `/login` page (email + password form, dark theme)
- `docs/screenshots/api-keys.png` — the `/settings/keys` page (key list, create/revoke UI)
- `docs/screenshots/live-timeline.png` — the `/runs/[id]` run detail page with the "Live" pulsing badge and the span inspector open
