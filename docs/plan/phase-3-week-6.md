# Phase 3, Week 6 — Dashboard runs list and run detail

**Window**: ~6 working days, Sunday off
**Effort budget**: ~25 to 30 hours
**Goal**: The dashboard becomes a usable trace viewer. A user can see all their runs, click into one, see all its spans on a timeline, click a span, and inspect its prompt/response/attributes.

This doc is the single source of truth for Week 6. Read `docs/plan/phase-3-overview.md` and the Week 5 retro at the bottom of `docs/plan/phase-3-week-5.md` first.

---

## Honest scoping

The original ROADMAP packed runs list + run detail + reactflow graph + WebSocket live updates + auth into Phase 4 (Weeks 7-8). We pulled the visible runs list + run detail forward into Week 6, leaving auth and live updates in Phase 4.

Within that, this plan further trims:

- **Reactflow graph is a stretch (Day 5 only if Days 1-4 went smoothly).** If we don't ship it this week, that's fine; Phase 6 polish can add it. Demo screenshot can come from the timeline view.
- **No filtering controls beyond existing project + time range.** No model filter, no status filter, no tags, no full-text search. All cut to Phase 4 or later.
- **No infinite scroll.** Plain pagination by time range with a "show more" button is enough.
- **Sort fixed to start_time DESC.** No sort controls.

Ship the things that prove the product story. Skip the things that compete for visual real estate but don't move the demo.

---

## In scope

1. **Runs list page** at `/` (replaces the existing flat-spans page from Phase 1 Week 2). Each row is one agent run, identified by `run_id`. Aggregates from `halley.observations` at read time.
2. **Read-time cost computation**: each run row shows real dollar cost computed from token counts × per-million prices in `halley.pricing_versions`. Phase 1 placeholder zeros are now replaced (Week 5 Day 1) so this shows real numbers.
3. **Run detail page** at `/runs/[id]`. Shows all spans for that run on a vertical timeline.
4. **Span inspector sidebar** that opens when a span is clicked. Shows the canonical fields (model, tokens, cost, status, duration), the input/output bodies (fetched from `observation_body` by hash), tool I/O, and the full attributes map.
5. **One README screenshot or 10-second GIF** of a Reasoning Agent run in the run detail view, captured in Day 6.

## Explicitly out of scope

- Auth (Phase 4).
- API keys management UI (Phase 4).
- WebSocket / live updates (Phase 4).
- Reactflow graph view (Day 5 stretch only; default-cut).
- Cmd+K palette, keyboard nav, full-text search (Phase 6 polish if at all).
- Filtering beyond project + time range (Phase 6 polish).
- Cassette-to-fixture promotion UI (Phase 5).
- `halley` CLI (Phase 5).
- Multi-project support (still single dev project).

---

## Working disciplines

Carry-over from Phase 2 + Phase 3 Week 5 disciplines.

Plus Week 6-specific:

- **D-10 (no Rust changes this week)**: The ingester does not change. No Docker rebuilds. All work is in `dashboard/`.
- **D-11 (server components first)**: Use Next.js Server Components for every page that doesn't need client state. The runs list and run detail are server-rendered. Only the span inspector sidebar (state: which span is selected) and any future reactflow canvas need `"use client"`.
- **D-12 (one query module)**: All ClickHouse queries go through `dashboard/src/lib/halley-query/` (already exists from Phase 1). Add functions, do not write inline ClickHouse client calls in pages. Future auth (Phase 4) plugs in here in one place.

---

## Day-by-day plan

### Day 1: Runs list query + page

**Container rebuild today: NO**.

Work:

1. Add to `dashboard/src/lib/halley-query/`:
   - `listRuns({ projectId, fromTime, toTime, limit })` returning an array of `RunSummary`.
   - The query: `GROUP BY run_id` over `halley.observations` filtered by project and time range. SELECT:
     - `run_id`, `MIN(start_time) AS started_at`, `MAX(end_time) AS ended_at`,
     - `MAX(run_name) AS run_name`, (any value works since run_name is duplicated per row of the same run)
     - `COUNT(*) AS span_count`,
     - `SUM(gen_ai_usage_input_tokens) AS total_input_tokens`,
     - `SUM(gen_ai_usage_output_tokens) AS total_output_tokens`,
     - `MAX(gen_ai_request_model) AS top_model`, (best-effort: pick any model used in the run)
     - `MAX(source_dialect) AS top_dialect`,
     - `MAX(if(is_run_root, 1, 0)) AS has_root`, (whether the run has an explicit agent root span)
     - `MAX(status) AS worst_status`. (since status enum is ok=1, error=2, timeout=3, MAX surfaces the worst)
   - `ORDER BY started_at DESC LIMIT {limit}`.

2. Cost computation. Add `computeRunCost(run, pricingVersions)` to the query module. Cost is read-time:
   - Fetch the latest `pricing_versions` row for each unique model in the runs list (one query, joined or pre-fetched).
   - For each run, dollar cost = `(total_input_tokens * input_cost_per_mtok / 1_000_000) + (total_output_tokens * output_cost_per_mtok / 1_000_000)`.
   - Display 4 decimal places for sub-dollar amounts, 2 for over-dollar. Round half-up.

3. Replace the existing `dashboard/src/app/page.tsx`. New page shows:
   - Title: "Runs"
   - Subtitle: count of runs returned, time window
   - Table columns: started_at | run_name | model | spans | tokens (in/out) | cost | status | dialect
   - Each row is a link to `/runs/[id]`.
   - If `has_root = 1`, show a small "agent" badge next to the run name.

4. Remove the spans-list view from the existing page (if it was the entire page). Or keep it accessible at `/spans` for debugging — your call. Document choice in DECISIONS.md as **D45**.

5. **Verification (host-side)**:
   - `cd dashboard && npm run build` clean.
   - `npm run dev`, visit http://localhost:3000/, see the runs list. Each Reasoning Agent run is one row showing 5 spans, real token counts, and a non-zero cost (cents-fractions, but visible).

**Acceptance Day 1**:
- `/` shows a runs list with one row per agent run.
- Each row's cost column shows non-zero dollars (rounded to 4 decimals).
- Clicking a row navigates to `/runs/[id]` (404 for now; Day 3).
- `npm run build` clean.

### Day 2: Cost rendering polish + Vercel-style outer-span aggregation

**Container rebuild today: NO**.

Work:

1. Vercel AI SDK quirk: outer `ai.generateText` spans have token counts in `attributes.ai.usage.inputTokens` (string, since attribute map is `Map(String, String)`), not in `gen_ai_usage_input_tokens`. The runs list `SUM()` would miss these.

   Solution: in the cost-computation function, when summing tokens for a run, prefer `gen_ai_usage_input_tokens` but fall back to `attributes['ai.usage.inputTokens']::UInt32` when the canonical column is 0 AND the row has Vercel attributes. Only do this on the outer `ai.generateText` span (rows where `attributes['ai.operationId']` exists). Inner `doGenerate` spans already have canonical values.

   Or simpler: do not fall back. Just acknowledge in the dashboard that Vercel outer spans show 0 tokens; the run total is the sum of inner spans. Document the limitation in **D46** and revisit in Phase 4 cost work.

   Pick the simpler path. The Reasoning Agent and OpenInference paths are correct; only Vercel runs show slightly-off tokens because of this. Phase 4 dashboard cost work is where it gets fixed properly.

2. Add a "All projects" / project filter dropdown using the existing `projects` table from Postgres. For now there's only one project (`dev-local`); the dropdown is mostly aesthetic. Read-time only; no auth.

3. Add a time-range filter: hardcoded options "Last hour", "Last 24h", "Last 7d", "All time". Defaults to "Last 7d".

4. Format numbers nicely: tokens with thousands separators ("1,438" not "1438"), cost with `$0.0001` precision for small amounts, model as a colored badge.

5. **Verification (host-side)**: page renders without errors, filters work (changing time range refilters runs).

**Acceptance Day 2**:
- Runs list looks polished: nice number formatting, badges for model and dialect.
- Project + time-range filters work.
- Vercel cost note logged in D46.

### Day 3: Run detail page (timeline view)

**Container rebuild today: NO**.

Work:

1. Add to query module:
   - `getRunDetail(runId)` returning `{ run: RunSummary, spans: SpanSummary[] }`.
   - `spans` is all observations for the run, ORDER BY start_time ASC.
   - `SpanSummary` includes: span_id (hex), parent_span_id (hex), start_time, end_time, gen_ai_system, gen_ai_operation, gen_ai_request_model, token counts, status, source_dialect, is_run_root, attributes (JSON for the inspector).

2. Body fetching is on-demand (Day 4, not now). Day 3 just renders the timeline.

3. New page `dashboard/src/app/runs/[id]/page.tsx` (Server Component):
   - Header: run name, dialect badge, total cost, total duration, status, started_at.
   - Timeline view: vertical list of spans, each shown as a horizontal bar starting at its `start_time` offset from the run's `started_at`, with width proportional to its duration. Bar colors per `gen_ai_operation` (chat / execute_tool / retrieve / invoke_agent / embeddings). Each bar is clickable.
   - Span name on each bar: `gen_ai_operation` + `gen_ai_request_model` (e.g., "chat • gpt-4o-mini").
   - Token counts shown to the right of each bar.
   - Indent child spans under their parent (computed from `parent_span_id`).

4. Click a bar → navigate to `/runs/[id]?span=<hex_span_id>`. Day 4 wires the inspector to that query param.

5. **Verification (host-side)**:
   - Click a run in the runs list → run detail page loads.
   - All spans for that run appear in the timeline.
   - Reasoning Agent run shows all 5 spans (1 classifier + 1 PAL + 3 self-consistency paths) in time order.

**Acceptance Day 3**:
- Run detail page renders timeline view.
- Bars are scaled by duration; child spans visually indented under parents.
- Clicking a bar updates the URL `?span=...` (no inspector yet).

### Day 4: Span inspector

**Container rebuild today: NO**.

Work:

1. Add to query module:
   - `getSpanDetail(traceIdHex, spanIdHex)` returning the full observation row plus the `body` strings fetched by hash from `halley.observation_body`.
   - Two SQL queries: one for the observation, one for the bodies (zero or more).

2. Span inspector component. Client Component because it reads `useSearchParams` and animates open/close. Layout: right-side drawer ~480px wide.

3. Sections in the inspector:
   - Header: span name, dialect badge, status badge.
   - Timing: start_time (UTC), end_time, duration in ms.
   - Identity: trace_id (truncated, click to copy), span_id, parent_span_id, run_id.
   - Model: gen_ai_system, gen_ai_request_model, gen_ai_response_model, gen_ai_response_finish_reason.
   - Usage: input_tokens, output_tokens, cost (computed read-time).
   - **Input body**: pretty-printed JSON of the input body, fetched by `input_body_hash`. If hash is null, "no input body recorded".
   - **Output body**: same for output.
   - **Tool**: tool_name, tool_input, tool_output, tool_side_effect.
   - **Attributes**: collapsible JSON tree of the full attributes map. This is where `traceloop.*`, `openinference.*`, `ai.*`, and other unknown keys are visible.

4. Body rendering: the body strings are canonical JSON (sorted keys, compact). Re-format for display with 2-space indent. Add a "copy" button.

5. **Verification (host-side)**:
   - Click a span in the timeline → drawer opens.
   - All sections populated from real data.
   - Reasoning Agent self-consistency span shows the question, the model's reasoning, the answer.
   - OpenInference span shows `llm.input_messages.*`, `llm.output_messages.*` in the attributes section.

**Acceptance Day 4**:
- Span inspector opens, shows all sections.
- Bodies rendered as pretty-printed JSON.
- Attributes section shows the full unknown-key map.

### Day 5: Reactflow graph (stretch)

**Container rebuild today: NO**.

Work (only if Days 1-4 went smoothly and there's time):

1. Add `reactflow` to dashboard deps.

2. New tab on the run detail page: "Timeline" (default, what Day 3 built) | "Graph".

3. Graph view: each span is a node, parent-child edges from `parent_span_id`. Layout via reactflow's auto-layout (`dagre` integration). Click a node → opens the same span inspector.

4. Node colors and labels match the timeline view's bar colors and labels for visual consistency.

If reactflow takes more than ~3 hours to integrate cleanly, **stop and skip**. Ship the rest of Week 6 without it. The graph view is a Phase 6 polish item if not done now.

**Acceptance Day 5 (if attempted)**:
- Graph tab renders without console errors.
- Clicking a node opens the inspector with the same data as the timeline.

If skipped, document in **D47**: "Reactflow graph deferred to Phase 6 polish. Timeline view is the primary run-detail visualization."

### Day 6 (short, ~2 hrs): Screenshot capture + retro

Work:

1. Run the Reasoning Agent example (or a fresh run with a more interesting question if budget allows — total cost still under $0.01).

2. Capture a screenshot of:
   - The runs list showing real runs across all three example apps.
   - The run detail page for a Reasoning Agent run with the inspector open on the PAL span.

3. Save screenshots under `docs/screenshots/` and add a "What it looks like" section to the README with embedded images.

4. Final hygiene: `cargo build / clippy / fmt / test` clean (sanity), `npm run build` clean for dashboard, `make smoke` against running stack.

5. Write `## Phase 3 retro` at the bottom of this file. Cover all of Week 5 + Week 6. ~150 words. Sections:
   - What shipped.
   - What slipped (e.g., reactflow if cut).
   - What surprised.
   - What's owed at start of Phase 4.

6. Stop. Do NOT commit. Reviewer chat will commit and draft Phase 4.

---

## Reviewer checklist

### Runs list (Days 1-2)
- [ ] `/` renders a list of runs (NOT a flat span table).
- [ ] Each row shows real-dollar cost (non-zero, computed from `pricing_versions`).
- [ ] Project + time-range filters work.
- [ ] One row per `run_id`.
- [ ] D45 documents the spans-page choice (kept at `/spans` or removed).
- [ ] D46 documents the Vercel outer-span token aggregation limitation.

### Run detail (Days 3-4)
- [ ] `/runs/[id]` renders a timeline view of all spans in the run.
- [ ] Bars scaled by duration; child spans visually indented under parents.
- [ ] Click a bar → inspector drawer opens with full span data.
- [ ] Inspector shows: timing, identity, model, usage, input body, output body, tool fields, attributes.
- [ ] Reasoning Agent run shows all 5 spans correctly.
- [ ] OpenInference span shows `llm.input_messages.*` in the attributes section.

### Reactflow graph (Day 5, stretch)
- [ ] If shipped: graph tab works, clicking a node opens the inspector.
- [ ] If skipped: D47 documents the deferral.

### Screenshot + README (Day 6)
- [ ] At least one screenshot under `docs/screenshots/`.
- [ ] README has a "What it looks like" section embedding the screenshot(s).

### Build hygiene
- [ ] `cargo build / clippy / fmt / test` clean (no Rust changes; sanity).
- [ ] `npm run build` clean for `dashboard/`.
- [ ] `make smoke` 20/20 passes.

### Non-goals respected
- [ ] No auth code.
- [ ] No WebSocket / live updates.
- [ ] No multi-project support beyond the existing dev-local seed.
- [ ] No CLI work.
- [ ] No fixture / replay code.

### Phase 3 wrap (Day 6)
- [ ] Phase 3 retro at the bottom of this file.
- [ ] All Phase 3 acceptance criteria from `phase-3-overview.md` met (three example apps land in dashboard, real cost numbers, run detail page, screenshot in README).

---

## Common pitfalls

1. **ClickHouse `Map(String, String)` access in TypeScript**: the JS client returns the map as a JS object. Reading `attributes['ai.operationId']` works directly but typing it requires `Record<string, string>`. Cost-computation fallback (D46 path) needs `parseInt` on string values.

2. **Read-time cost JOIN**: don't JOIN `pricing_versions` per row — pre-fetch the pricing rows once for the visible time window, build a `Map<model, prices>` in JS, look up per row. Faster and clearer.

3. **`is_run_root` is a `Bool` column in ClickHouse**: the JS client returns `true`/`false` directly. The MAX trick for "any span in the run is a root" works because `MAX(if(is_run_root, 1, 0))` returns 1/0; alternative is `bitOr(is_run_root) = 1`.

4. **Span ordering in run detail**: ORDER BY `start_time ASC` is correct. Don't try to topologically sort by `parent_span_id` — that's O(N²) and adds no value over time-order for a vertical timeline.

5. **Don't break the existing `/metrics` route**: that's served by the Rust ingester at port 4318, not the dashboard. Confusion between the two is easy when both are running.

6. **Body hashes are stored as raw bytes**: in the inspector's `getSpanDetail`, the body fetch query needs `WHERE hex(body_hash) = $1`. Pass the uppercase hex string from JS.

7. **Reactflow imports are heavy**: if you add it on Day 5 and `npm run build` slows down dramatically, that's the SSR cost of pulling reactflow into the bundle. Mark the graph component `"use client"` and use dynamic imports.

---

## When to stop

Phase 3 is done when every reviewer-checklist item passes. If finished early, do not start Phase 4. Use the time to take more screenshots of different runs, polish the styling of the run detail page, or write a 1-paragraph "Concepts" doc in `docs/quickstart/concepts.md` defining run vs span vs trace for users.

The Phase 3 retro is the final artifact of the phase. It feeds the Phase 4 plan I will draft after Week 6 ships.
