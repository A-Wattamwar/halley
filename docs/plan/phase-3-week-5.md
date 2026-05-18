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

**D-7 (OpenAI key budget)**: $5 total. **All runs use `gpt-4o-mini` only** (~$0.005 per run). Budget allows ~400 runs across all three example apps over the phase — more than enough. `gpt-4o` is present in `pricing_versions` for real-user cost data correctness but is never called from any code we run. Budget guardrail: **20 runs per example app during development**, **3 final-quality runs at end of Day 6** for the screenshot. All use `gpt-4o-mini`.

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

### Day 4: Direct TypeScript + OpenInference auto-instrumentation

**Container rebuild today: NO**.

**Context (updated from original plan):** The original Day 4 called for
`@traceloop/node-server-sdk` (OpenLLMetry Node). Day 2 research showed that
`traceloop-sdk 0.55+` emits pure OTEL GenAI semconv — no `traceloop.*` keys —
so it routes through the `otel-genai` adapter, same as Day 2. To demonstrate
three genuinely distinct dialect paths, Day 4 uses OpenInference
auto-instrumentation instead, which emits `openinference.*` attributes and
routes through the `openinference` adapter. See DECISIONS.md D44.

Work:

1. New directory `examples/openai-direct-typescript/`. Minimal Node.js app:
   ```bash
   npm init -y
   npm install openai \
     @arizeai/openinference-instrumentation-openai \
     @opentelemetry/sdk-node \
     @opentelemetry/exporter-trace-otlp-http
   ```

2. Single TypeScript file (`src/index.ts`) ~40-50 lines:
   - Initialize OTEL `NodeSDK` with `OTLPTraceExporter` pointing at
     `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).
   - Register `OpenAIInstrumentation` from `@arizeai/openinference-instrumentation-openai`.
   - Make 3-5 OpenAI chat completion calls with different prompts.
   - Print "done" and exit.

3. Use `tsx` or `ts-node` for execution. Document run command in the README.

4. Run the example. Verify in ClickHouse:
   - 3-5 rows with `source_dialect = "openinference"`.
   - `gen_ai_request_model = "gpt-4o-mini"`.
   - Token counts non-zero.

**Verification**: example runs, traces land with `source_dialect = "openinference"`.

**Acceptance Day 4**: Direct TypeScript example traces visible with correct dialect.

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
- [ ] One example run lands traces with `source_dialect = "openinference"` (OpenInference instrumentation for OpenAI).

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

---

## Week 5 retro

### What shipped

All six reviewer checklist sections pass.

**Day 1 — ROADMAP + pricing migration + research**
- ROADMAP updated to v0.5. North-star item #3 changed from `@halley/sdk` to three example apps.
- D41 (no SDK), D42 (pricing migration pattern), D43 (gpt-4o-mini only) added to DECISIONS.md.
- ClickHouse migration `20260515000001_openai_pricing_real_values.sql` applied. Real OpenAI pricing for `gpt-4o-mini` ($0.150/$0.600/$0.075) and `gpt-4o` ($2.500/$10.000/$1.250) now in `pricing_versions`.
- Two research notes written: `openllmetry-python-setup.md`, `vercel-ai-telemetry-setup.md`.

**Day 2 — Reasoning Agent (Python)**
- `examples/reasoning-agent-python/` created. All 6 source files from the original CSE 476 project copied verbatim; only `api.py` replaced with an OpenAI SDK adapter (same function signature).
- `Traceloop.init(app_name="reasoning-agent", disable_batch=True)` added to `agent.py`.
- One real run: question "Solve: 47 * 23 + 19", answer 1100 (correct). 5 spans landed.
- **Pivot**: spans landed as `source_dialect = "otel-genai"`, not `"openllmetry"`. Investigated and documented (see below).

**Day 3 — Vercel AI SDK (Next.js)**
- `examples/vercel-ai-app/` created. Next.js 14.2.35, `instrumentation.ts`, server action with `experimental_telemetry: { isEnabled: true }`.
- `npm run build` clean. One real run: "What is the capital of France?" → "Paris." 2 spans landed as `source_dialect = "vercel-ai"`. ✓

**Day 4 — Direct TypeScript + OpenInference**
- `examples/openai-direct-typescript/` created. `@arizeai/openinference-instrumentation-openai@4.1.1` + `openai@6.38.0`.
- **ESM hoisting issue** encountered and resolved (see below).
- One real run: 4 questions, 4 correct answers. 4 spans landed as `source_dialect = "openinference"`. ✓

**Day 5 — Quickstart docs**
- `docs/quickstart/quickstart-python.md` (101 lines)
- `docs/quickstart/quickstart-typescript.md` (115 lines)
- `docs/quickstart/quickstart-vercel.md` (139 lines)
- README "Getting started" updated with "What instrumentation are you using?" subsection.

**Day 6 — Hygiene**
- `cargo build / clippy / fmt / test` all clean. Ingester unchanged all week (D-8 respected).
- `make smoke` 20/20 passed.

---

### What slipped

Nothing slipped from the original scope. The Day 4 plan was deliberately changed (not slipped) from Traceloop Node to OpenInference to get three genuinely distinct dialect paths.

---

### What surprised

**1. Traceloop SDK 0.55+ migrated to pure OTEL GenAI semconv (Day 2)**

The biggest finding of the week. `traceloop-sdk 0.60.0` (pip-latest) no longer emits `traceloop.*` attributes. PR #3844 (merged 2026-03-29) replaced the entire legacy `SpanAttributes` namespace with upstream `gen_ai.*` attributes from OTEL GenAI Semantic Conventions 0.5.0.

Impact: the Reasoning Agent traces landed as `source_dialect = "otel-genai"` instead of `"openllmetry"`. This is correct behavior — the otel-genai adapter handled the traffic perfectly. The `openllmetry` adapter is now a legacy compatibility layer for users on `traceloop-sdk < 0.55`.

This also invalidated the original Day 4 plan (Traceloop Node would have produced the same `otel-genai` dialect as Day 2). Pivoted to OpenInference to get three distinct paths.

Documented in: DECISIONS.md D44, `docs/research/openllmetry-2026-migration.md`.

**2. ESM import hoisting breaks OpenInference instrumentation (Day 4)**

TypeScript `import` statements are hoisted to the top of the compiled output. This means `import OpenAI from "openai"` executes before `sdk.start()` runs, so the OpenInference instrumentation patch never applies — zero spans emitted.

Fix: use `require("openai")` after `sdk.start()`. This is the standard OTEL auto-instrumentation pattern for Node.js CJS environments, but it's not obvious when writing TypeScript.

Two failed runs before the fix (spans not exported at all, not even as wrong dialect). Documented in the example README and the TypeScript quickstart.

**3. OpenInference captures the resolved model snapshot name**

`gen_ai_request_model` for OpenInference spans is `"gpt-4o-mini-2024-07-18"` (the resolved snapshot) rather than `"gpt-4o-mini"` (the alias). This is correct — OpenInference captures what OpenAI actually used. Documented in the TypeScript quickstart verification section.

**4. Total OpenAI cost was essentially zero**

Across all three example apps and multiple debug runs: 375 input tokens + 29 output tokens total. At gpt-4o-mini rates: **~$0.000074** (less than one-tenth of a cent). The $5 budget is essentially untouched. The D-7 guardrail of 20 runs per example was never close to being hit.

---

### Three dialect paths confirmed

| Example | Instrumentation | `source_dialect` | Spans |
|---|---|---|---|
| `reasoning-agent-python/` | Traceloop 0.60 (OTEL GenAI semconv) | `otel-genai` | 5 |
| `vercel-ai-app/` | Vercel AI SDK native telemetry | `vercel-ai` | 2 |
| `openai-direct-typescript/` | OpenInference auto-instrumentation | `openinference` | 4 |
