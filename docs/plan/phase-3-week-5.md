# Phase 3, Week 5 — Example apps and quickstart docs

**Window**: ~6 working days, Sunday off
**Effort budget**: ~25 to 30 hours
**Goal**: Three example apps emitting real OpenAI traces into Halley, plus quickstart docs in three languages.

This doc is the single source of truth for Week 5. Read `docs/plan/phase-3-overview.md` first for the architectural reasoning.

---

## In scope

1. ROADMAP §North-star item #3 update (SDK → three example apps).
2. OpenAI pricing seed migration replacing the Phase 1 placeholder zeros.
3. Reasoning Agent (Python) example wired into Halley via OpenLLMetry's Python instrumentation.
4. Vercel AI SDK example (Next.js) emitting traces.
5. Direct TypeScript example (Node.js + OpenAI SDK + OpenLLMetry).
6. Three quickstart docs (Python, TypeScript, Vercel).
7. Verify all three example apps land traces in the dashboard with the correct `source_dialect`.

## Explicitly out of scope

- `@halley/sdk` npm package. Not in this phase.
- Auth (Phase 4).
- WebSocket live updates (Phase 4).
- Dashboard runs list + run detail (Week 6, not Week 5).
- Cassette-to-fixture promotion (Phase 5).
- Replay / fork / bisect (Phase 5).
- Anthropic, Google, or local model examples. OpenAI only this week.

---

## Working disciplines (mandatory)

Carry-over from Phase 2 Week 4 disciplines. Plus Phase 3-specific:

**D-7 (OpenAI key budget)**: $5 total. Use `gpt-4o-mini` for all development runs (~$0.001-0.005 per run). Reserve `gpt-4o` ($0.01-0.05 per run) for the README demo capture only. Budget guardrail: **20 runs per example app during development**, **3 final-quality runs at end of Day 6** for the screenshot.

**D-8 (no Docker rebuild this week)**: The ingester does not change in Week 5. Example apps live under `examples/` and are external clients. No `docker compose build ingester` calls all week.

**D-9 (use existing dashboard for verification)**: The current spans table page from Phase 1 Day 2 is enough to verify a trace landed. Don't wait for Week 6's runs list to test ingestion. `curl http://localhost:3000` after each example run shows the new spans.

---

## Day-by-day plan

### Day 1: ROADMAP update + OpenAI pricing migration + research

**Container rebuild today: NO**.

Work:

1. **ROADMAP §North-star update**:
   - Item #3: "`@halley/sdk` published to npm as v0.1.0 (optional convenience wrapper)" → "Three example apps in three different stacks (Python OpenLLMetry, Vercel AI SDK, direct TypeScript) emit real OpenAI traces into one Halley dashboard."
   - Add a revision log entry (v0.5, 2026-05-26 or whatever the actual date): "Phase 3 reshape — SDK dropped in favor of OTEL-direct quickstart docs and three working example apps. Decision rationale in DECISIONS.md D41."

2. **DECISIONS.md D41**: "Why we don't ship a proprietary SDK." Two paragraphs:
   - Halley's pitch is "we ingest whatever your app emits via OTLP." A proprietary SDK contradicts that pitch and creates a maintenance burden.
   - If real users post-launch ask for a wrapper, build one in Phase 6 with their requirements. Building speculatively without users is worse than not building at all.

3. **OpenAI pricing data**:
   - Look up current OpenAI per-token pricing for the models we'll use. As of mid-2026, current public pricing (verify against the OpenAI pricing page at execution time):
     - `gpt-4o-mini`: $0.150 / 1M input tokens, $0.600 / 1M output tokens, $0.075 / 1M cached input tokens.
     - `gpt-4o`: $2.500 / 1M input tokens, $10.000 / 1M output tokens, $1.250 / 1M cached input tokens.
   - **Verify these against https://openai.com/api/pricing before writing the migration.** Pricing changes; the plan's numbers may be stale.
   - New ClickHouse migration `db/clickhouse/migrations/20260526000001_openai_pricing_real_values.sql`. Single statement (D24). Use `INSERT INTO ... ON CONFLICT` semantics — wait, ClickHouse doesn't have ON CONFLICT. Pattern: insert new rows with a new `pricing_version_id` (a fresh UUID), so historical observations keep pointing at the placeholder version while new ones can opt into the real version. OR: keep the same UUID and let ReplacingMergeTree dedup handle it on background merge.
   - Pick the second pattern for simplicity. Use the same `pricing_version_id` as the placeholder seed (`00000000-0000-0000-0000-000000000001`), insert rows with a later `effective_from` timestamp, and let ReplacingMergeTree's `effective_from`-based dedup keep the latest. The seeds we INSERT are the real values; the placeholder zeros become superseded.
   - Document the pattern in the migration file's header comment AND in DECISIONS.md as **D42**.

4. **Research**:
   - Read OpenLLMetry Python's setup docs: https://github.com/traceloop/openllmetry/tree/main/packages/traceloop-sdk
   - Read Vercel AI SDK's telemetry docs: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry
   - Confirm the exact env var or constructor argument that points the OTLP exporter at `http://localhost:4318/v1/traces`.
   - Take 5 lines of notes per integration. Write to `docs/research/openllmetry-python-setup.md` and `docs/research/vercel-ai-telemetry-setup.md`. Brief; for your own reference and Days 2-4.

**Verification**:
- Migration applies cleanly via dbmate. The placeholder zero rows still exist (ReplacingMergeTree keeps them until merge); the new rows with later `effective_from` win on read.
- ROADMAP and DECISIONS.md updates pushed.

**Acceptance Day 1**:
- ROADMAP v0.5 entry written.
- D41 + D42 in DECISIONS.md.
- Real OpenAI pricing loaded into ClickHouse.
- Two short research notes for Days 2-4 reference.

### Day 2: Reasoning Agent (Python) example

**Container rebuild today: NO**.

Work:

1. New directory `examples/reasoning-agent-python/`. Either:
   - **Copy the Reasoning Agent source** into this directory (preserves the example as a self-contained demo), OR
   - **Add a thin wrapper** under `examples/reasoning-agent-python/` that imports the Reasoning Agent from a relative path (assumes Ayush has the project locally).

   Pick the first option. The example must be runnable by anyone cloning Halley. Document the source attribution in the example's README ("Adapted from Ayush Wattamwar's Inference-Time Reasoning Agent coursework, Fall 2025").

2. Add OpenLLMetry instrumentation:
   ```python
   from traceloop.sdk import Traceloop
   Traceloop.init(
       app_name="reasoning-agent",
       api_endpoint="http://localhost:4318",
       disable_batch=False,  # production: True; for demo: False to flush eagerly
   )
   ```
   Confirm the exact syntax against the live OpenLLMetry docs read on Day 1.

3. Add a `Makefile` or `run.sh` for the example: install deps, run a sample question, exit cleanly. Use `gpt-4o-mini` so each run costs ~$0.005.

4. Add `examples/reasoning-agent-python/.env.example` with `OPENAI_API_KEY=` and `HALLEY_OTLP_ENDPOINT=http://localhost:4318`.

5. Run the agent against the running Halley stack with one sample question (e.g., "Solve: 47 * 23 + 19"). Verify in ClickHouse:
   - Multiple rows with `source_dialect = "openllmetry"`.
   - At least one row per LLM call the agent made (Self-Consistency runs ~5 paths, so expect ~5-10 spans).
   - `gen_ai_request_model = "gpt-4o-mini"`.
   - Token counts non-zero.

**Verification**:
- One example run lands traces correctly.
- Total OpenAI cost so far: ~$0.005-0.02.

**Acceptance Day 2**: Reasoning Agent traces visible in ClickHouse with correct `source_dialect`.

### Day 3: Vercel AI SDK example (Next.js)

**Container rebuild today: NO**.

Work:

1. New directory `examples/vercel-ai-app/`. Initialize a minimal Next.js 14 app:
   ```bash
   cd examples
   npx create-next-app@14 vercel-ai-app --typescript --tailwind --app --src-dir
   ```

2. Install Vercel AI SDK and OTEL deps:
   ```bash
   npm install ai @ai-sdk/openai @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
   ```

3. Add an `instrumentation.ts` file at the project root (Next.js 14 picks this up automatically):
   ```typescript
   export async function register() {
     if (process.env.NEXT_RUNTIME === "nodejs") {
       const { NodeSDK } = await import("@opentelemetry/sdk-node");
       const { OTLPTraceExporter } = await import(
         "@opentelemetry/exporter-trace-otlp-http"
       );
       const sdk = new NodeSDK({
         traceExporter: new OTLPTraceExporter({
           url: process.env.HALLEY_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
         }),
       });
       sdk.start();
     }
   }
   ```

4. One page (`app/page.tsx`) with a button that triggers a server action calling `generateText({ model: openai("gpt-4o-mini"), prompt: "..." })` with `experimental_telemetry: { isEnabled: true }`. Server action emits Vercel AI SDK telemetry → ingester via the otel exporter.

5. README under `examples/vercel-ai-app/README.md`: ~30 lines explaining setup, env vars, run command.

6. Run one example. Verify in ClickHouse:
   - Rows with `source_dialect = "vercel-ai"`.
   - `ai.operationId = "ai.generateText"` preserved (or normalized).
   - Real token counts.

**Verification**: example runs, traces land with correct dialect.

**Acceptance Day 3**: Vercel AI app emits traces visible in ClickHouse.

### Day 4: Direct TypeScript + OpenLLMetry example

**Container rebuild today: NO**.

Work:

1. New directory `examples/openai-direct-typescript/`. Minimal Node.js app:
   ```bash
   cd examples/openai-direct-typescript
   npm init -y
   npm install openai @traceloop/node-server-sdk
   ```

2. Single TypeScript file (`src/index.ts`) ~30-50 lines:
   - Initialize Traceloop SDK (OpenLLMetry Node) with `apiEndpoint: "http://localhost:4318"`.
   - Make 3-5 OpenAI chat completion calls with different prompts.
   - Print "done" and exit.

3. Use `tsx` or `ts-node` for execution. Document run command in the README.

4. Run the example. Verify in ClickHouse:
   - 3-5 rows with `source_dialect = "openllmetry"` (Traceloop's instrumentation emits `traceloop.*` attributes which our adapter detects).
   - Real model id, tokens.

**Verification**: example runs, traces land.

**Acceptance Day 4**: Direct TypeScript example traces visible.

### Day 5: Quickstart docs

**Container rebuild today: NO**.

Work:

1. **`docs/quickstart/quickstart-python.md`** (~100 lines max):
   - Prerequisites: Python 3.10+, an OpenAI API key, Halley running locally.
   - Install: `pip install traceloop-sdk openai`.
   - 5-line setup snippet.
   - "Verify it worked": curl the dashboard, see your trace.
   - Link to `examples/reasoning-agent-python/` for a fuller example.

2. **`docs/quickstart/quickstart-typescript.md`**:
   - Prerequisites: Node 20+, an OpenAI API key, Halley running locally.
   - Install: `npm install openai @traceloop/node-server-sdk`.
   - 10-line setup snippet.
   - Verification + link to `examples/openai-direct-typescript/`.

3. **`docs/quickstart/quickstart-vercel.md`**:
   - Prerequisites: Next.js 14+, Vercel AI SDK, OpenAI key.
   - Install: `npm install ai @ai-sdk/openai @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/auto-instrumentations-node`.
   - `instrumentation.ts` snippet.
   - `experimental_telemetry: { isEnabled: true }` reminder.
   - Verification + link to `examples/vercel-ai-app/`.

4. **README.md update**: under "Getting started," add a section "What instrumentation are you using?" linking to each quickstart.

**Verification**: each quickstart's snippet, when copy-pasted into a fresh app, produces traces in the local Halley dashboard. Walk through one of them yourself end-to-end.

**Acceptance Day 5**: three quickstart docs exist and have been validated against fresh apps.

### Day 6 (short, ~2 hrs): Retro + commit

Work:

1. Final hygiene: `cargo build`, `cargo clippy`, `cargo test`, `cargo fmt --check`. The ingester didn't change this week so this is a sanity check.

2. `make smoke` against the running stack. Must still pass.

3. Write `## Week 5 retro` at the bottom of this file. Cover: what shipped, what slipped (anything from Day 1-5 that didn't land cleanly), what surprised (e.g., OpenLLMetry Python had a different API than expected, Vercel AI SDK env-var quirks, OpenAI pricing changed).

4. Stop. Do NOT commit. The reviewer chat will commit and draft Week 6.

---

## Reviewer checklist

### Setup
- [ ] ROADMAP v0.5 revision log entry.
- [ ] D41 (no SDK) and D42 (pricing-version migration pattern) in DECISIONS.md.
- [ ] OpenAI pricing migration applied; ClickHouse `pricing_versions` shows real numbers for `gpt-4o-mini` and `gpt-4o`.

### Reasoning Agent example
- [ ] `examples/reasoning-agent-python/` exists with self-contained source.
- [ ] One example run lands traces with `source_dialect = "openllmetry"` in ClickHouse.
- [ ] Cost so far on the OpenAI key < $1 (~20% of budget).

### Vercel AI app
- [ ] `examples/vercel-ai-app/` exists, builds with `npm run build`.
- [ ] One example run lands traces with `source_dialect = "vercel-ai"`.

### Direct TypeScript example
- [ ] `examples/openai-direct-typescript/` exists, runs with `npm run start` or `npx tsx src/index.ts`.
- [ ] One example run lands traces with `source_dialect = "openllmetry"` (Traceloop emits this dialect).

### Quickstart docs
- [ ] Three quickstart files under `docs/quickstart/`.
- [ ] Each is < 150 lines.
- [ ] Each has been validated against a fresh app (not just the example app already in the repo).

### Build hygiene
- [ ] `cargo build / clippy / fmt / test` clean.
- [ ] `make smoke` against running stack passes.
- [ ] No Docker rebuilds this week (D-8).

### Non-goals respected
- [ ] No `@halley/sdk` package created.
- [ ] No auth in the dashboard.
- [ ] No live updates / WebSocket.
- [ ] No runs list / run detail (those are Week 6).
- [ ] No CLI / replay / bisect.

### Phase 3 wrap discipline
- [ ] Total OpenAI spend < $2 by end of Week 5 (~40% of budget; Week 6 will use less).
- [ ] Week 5 retro at the bottom of this file.

---

## Common pitfalls

1. **OpenLLMetry Python `Traceloop.init` syntax may have changed.** Verify against the live docs. The plan's snippet may be stale.

2. **Vercel AI SDK telemetry is opt-in per call.** Without `experimental_telemetry: { isEnabled: true }`, no spans are emitted. This is the most common "where are my traces" mistake.

3. **OTEL Node SDK requires `instrumentation.ts` before Next.js 14.4** but newer versions need `register` exported from there. Match your Next.js version's docs.

4. **Don't burn the OpenAI key on retries.** If a run fails to land traces, debug the OTLP export side-channel (curl to `:4318/v1/traces` with a hand-crafted request) before re-running the LLM call.

5. **`source_dialect` for OpenLLMetry-Python and OpenLLMetry-Node is the same**: `"openllmetry"`. Both emit `traceloop.*` attributes our adapter detects. Verify in ClickHouse with `SELECT DISTINCT source_dialect FROM halley.observations` after each example run.

6. **Pricing migration pattern**: ReplacingMergeTree dedup is eventual on background merge. After the migration, the placeholder zeros may still appear in `SELECT * FROM pricing_versions` for a few minutes. Use `SELECT * FROM pricing_versions FINAL ORDER BY effective_from DESC` if you need the canonical view immediately, or wait for merge.

7. **Next.js standalone output** in the example app: the Vercel example doesn't need to ship as a Docker container, but `next.config.js` should NOT set `output: "standalone"` if you want a simple `npm run dev` workflow.

---

## When to stop

Week 5 is done when every reviewer-checklist item passes. If finished early, do not start Week 6. Use the time to expand the quickstart docs with troubleshooting sections, or take real screenshots of the example apps' traces in the dashboard for the README. Write the Week 5 retro at the bottom of this file.
