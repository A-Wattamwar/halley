# Phase 3 Overview — Real traces and the dashboard becoming usable

**Window**: Weeks 5 and 6 (~12 working days, Sundays off)
**Goal**: Three real-world example apps emit real OpenAI traces into Halley, and the dashboard becomes a usable trace viewer (runs list + run detail). End of Phase 3 is the first point at which Halley is *demoable* to a real developer.

---

## What changed from the original ROADMAP

The original Phase 3 (Weeks 5-6) was: build `@halley/sdk`, publish to npm, wire two example apps to it, ~80% test coverage on the SDK.

This phase reshapes that:

- **No `@halley/sdk` is shipped.** Instead, the docs include 5- to 10-line OpenTelemetry SDK setup snippets per language. Halley's pitch is "we ingest whatever your app already emits"; shipping a proprietary SDK contradicts that. If real users ask for a wrapper post-launch, build one in Phase 6 with their feedback.
- **Three example apps** instead of two. Adds the existing Reasoning Agent (Python) which dogfoods OpenLLMetry's Python instrumentation against real traffic.
- **Dashboard runs list + run detail moved into Week 6.** The original Phase 4 had this in Weeks 7-8 along with auth and live updates. Pulling it forward gets the demo-able view in front of users two weeks earlier; auth and live updates remain in Phase 4.

This is a net-positive trade. We drop one deliverable that wasn't core (the SDK) and add visual progress that matters for the launch.

ROADMAP §North-star item #3 changes from "@halley/sdk v0.1.0 on npm" to "Three example apps in three different stacks emit real OpenAI traces into one dashboard." Update the ROADMAP revision log on Week 5 Day 1.

---

## What Phase 3 ships

By end of Week 6:

1. **Three working example apps** under `examples/`, each emitting real OpenAI traces into Halley:
   - `examples/reasoning-agent-python/` — Ayush's existing Reasoning Agent, instrumented with OpenLLMetry's Python package. Uses the openllmetry adapter path.
   - `examples/vercel-ai-app/` — minimal Next.js app using the Vercel AI SDK. Uses the vercel-ai adapter path.
   - `examples/openai-direct-typescript/` — minimal Node.js app using `openai` package + raw `@opentelemetry/sdk-node` + OpenLLMetry's auto-instrumentation. Uses the otel-genai or openllmetry adapter path.

2. **Quickstart documentation** under `docs/quickstart/`:
   - `quickstart-python.md` — copy-paste OTEL setup for Python (5-10 lines).
   - `quickstart-typescript.md` — same for Node.js.
   - `quickstart-vercel.md` — same for Vercel AI SDK.
   - Each links to the corresponding example app.

3. **Dashboard runs list and run detail**:
   - Runs list: paginated table grouped by `run_id`, showing run name, total duration, total cost (read-time from `pricing_versions`), span count, status, started_at. Filter by project (Phase 1 dev project for now) and time range.
   - Run detail: click a run, see all its spans in a timeline view + reasoning graph rendered with `reactflow`. Span inspector sidebar shows prompt, response, tool I/O, token counts, duration, cost.
   - No auth (Phase 4). No live updates (Phase 4). Single dev project (Phase 1 seed).

4. **OpenAI cost data populated** in `halley.pricing_versions` for the models the example apps use (`gpt-4o-mini`, `gpt-4o`). The Phase 1 placeholder zeros are replaced with current actual prices so the dashboard's cost column shows real numbers.

5. **One end-to-end demo screenshot or short GIF** in the README showing a Reasoning Agent run in the dashboard. Proof artifact for the README and eventual launch.

## What Phase 3 explicitly does NOT ship

- `@halley/sdk` npm package. Not in this phase, not in any phase unless real users ask post-launch.
- Auth (Phase 4).
- WebSocket live updates (Phase 4).
- API keys management UI (Phase 4).
- Cassette-to-fixture promotion UI (Phase 5).
- `halley` CLI (Phase 5).
- Bisect (Phase 5).
- Tool-effect-safe replay (Phase 5).

---

## Working disciplines (carry-over from Phase 2 Week 4)

These saved real credits and shipped quality. They continue here.

- **D-1 (rebuild discipline)**: Docker rebuilds happen at most once per day, only when the day's code changes the running container. Adapter-only or example-app-only days do NOT rebuild the ingester.
- **D-2 (host-side checks)**: `cargo test`, `cargo clippy`, `cargo fmt` run against the host toolchain. Don't rebuild Docker to verify a Rust test.
- **D-3 (no daily clean-boot)**: One mid-week clean-boot at most, only when schema or migration changes require it.
- **D-4 (focused re-reads)**: Day-N prompts re-read only the Day-N section of the plan, plus the specific reference docs needed.
- **D-5 (one verification path)**: Trust host-side checks; don't run the same verification through three layers.
- **D-6 (explicit cuts)**: Items cut in this plan stay cut. Do NOT add them mid-phase.

Phase 3-specific discipline:
- **D-7 (OpenAI key budget)**: Ayush's OpenAI key has $5. Each test run of the example apps costs $0.001-0.05 depending on prompt length. Budget allows ~50-200 test runs across all three example apps over the phase. Use the smallest viable model (`gpt-4o-mini`) for development. Use `gpt-4o` only for the final demo capture.

---

## Week split

### Week 5: example apps
- Day 1: ROADMAP update, OpenAI pricing seed migration, OpenLLMetry-Python research and the Reasoning Agent integration plan.
- Day 2: Reasoning Agent example wired in. First real-traffic run through Halley.
- Day 3: Vercel AI SDK example app from scratch.
- Day 4: Direct TypeScript + OpenLLMetry example app.
- Day 5: Quickstart docs for all three.
- Day 6 (short): Polish, retro, commit.

Detailed plan: `docs/plan/phase-3-week-5.md`.

### Week 6: dashboard runs list + run detail
- Day 1: Runs list query + table component.
- Day 2: Read-time cost computation from `pricing_versions`. Real cost numbers in the runs list.
- Day 3: Run detail page skeleton + timeline view.
- Day 4: Reasoning graph with reactflow.
- Day 5: Span inspector sidebar + screenshot/GIF capture for README.
- Day 6 (short): Polish, retro, commit.

Detailed plan: `docs/plan/phase-3-week-6.md` (drafted after Week 5 retro lands).

---

## Acceptance bar for Phase 3 (end of Week 6)

The exec is done with Phase 3 when:

1. `docker compose down -v && docker compose up -d && make ready` brings all services healthy. `make smoke` still passes (all assertions from Phase 2 plus any added).
2. The Reasoning Agent example runs end-to-end against real OpenAI, emits OTLP, lands in the dashboard with `source_dialect = "openllmetry"`. Uses ~$0.01 of API credit per execution.
3. The Vercel AI app runs end-to-end against real OpenAI, lands with `source_dialect = "vercel-ai"`.
4. The direct TypeScript app runs end-to-end against real OpenAI, lands with `source_dialect = "openllmetry"` or `"otel-genai"` depending on instrumentation choice.
5. `pricing_versions` has real OpenAI pricing for `gpt-4o-mini` and `gpt-4o`, and the dashboard's cost column shows non-zero dollar amounts.
6. The dashboard's `/` route shows a runs list (not a flat span table). Click a run → run detail page loads with timeline + graph + span inspector.
7. Three quickstart docs under `docs/quickstart/` walk a new user through setup in their language.
8. README has a screenshot or 10-second GIF of a real Reasoning Agent run in the run detail view.
9. `cargo build / clippy / fmt / test` clean. `npm run build` clean for the dashboard.
10. Phase 3 retro at the bottom of `docs/plan/phase-3-week-6.md`.
