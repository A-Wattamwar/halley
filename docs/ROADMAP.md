# Halley — Roadmap

Version: 0.1 (May 13, 2026)
Owner: Ayush Wattamwar

This document is the living plan. When we change direction mid-build, we update this file first, then the code. It is the truth base for "what are we doing this week."

---

## Timeline

- **Start:** May 13, 2026
- **End:** August 31, 2026
- **Total:** ~16 weeks, planned as **12 working weeks + 4 weeks of buffer** for interviews, schoolwork prep, or scope recovery.
- **Target effort:** 25–30 hrs/week. ~300–360 hours total.

---

## North-star success criteria (August 31, 2026)

By the end of summer, Halley must have:

1. A public GitHub repo with clean commit history and a polished README.
2. `docker compose up` stands up the full stack in under 60 seconds.
3. The TypeScript SDK published to npm as `@halley/sdk` v0.1.0.
4. End-to-end ingestion at 5,000+ spans/sec on a single laptop-class VM, verified with a load test.
5. A live demo URL where anyone can view a read-only dashboard with real agent traces (from Ayush's own instrumented RAG tutor and reasoning agent).
6. A 3-minute demo video on YouTube.
7. A technical blog post on `ayushwattamwar.com` explaining the replay/fork mechanic.
8. A Show HN launch post and `r/MachineLearning` launch.
9. Three updated resume bullets that stand alone as interview-worthy.

Any one of those missing means we didn't finish. All of them shipped, even if imperfectly, means we did.

---

## Phase plan

### Phase 1 — Foundations (Weeks 1–2, May 13 – May 26)

**Goal:** End-to-end skeleton running locally. No features. Just plumbing.

- [ ] Repo scaffolding: monorepo with `sdk-ts/`, `ingester/` (Rust), `dashboard/` (Next.js), `worker/` (Node), `infra/` (Docker Compose + migrations), `examples/`.
- [ ] `docker compose up` starts ClickHouse, Redis, Postgres, placeholder ingester, placeholder dashboard — all with healthchecks green.
- [ ] ClickHouse initial migration (the `spans` and `runs` tables).
- [ ] Postgres initial migration (users, projects, api_keys).
- [ ] Hello-world Rust ingester: accepts HTTP POST of a JSON span → writes to ClickHouse. No OTLP yet.
- [ ] Hello-world Next.js dashboard: reads from ClickHouse, renders a table of spans.
- [ ] Read the OpenTelemetry GenAI semantic conventions spec end-to-end. Take 1 page of notes.
- [ ] Skim the Langfuse and Helicone source code. 1 page of notes on each.

**Deliverable:** A Rust service that accepts a span and a Next.js page that displays it. Docker Compose brings up the whole thing in one command.

### Phase 2 — Rust Ingester, Real (Weeks 3–4, May 27 – June 9)

**Goal:** Production-quality Rust ingester speaking OTLP.

- [ ] OTLP/gRPC receiver on port 4317 using `tonic` + `opentelemetry-proto`.
- [ ] OTLP/HTTP receiver on port 4318 using `axum`, supporting both protobuf and JSON payload encoding.
- [ ] GenAI semantic-convention validation: reject malformed spans with structured error.
- [ ] Span enrichment: compute `cost_usd` from a per-model pricing table (OpenAI + Anthropic + Gemini at minimum).
- [ ] Run-grouping logic: assign a `run_id` to every span based on the agent-run heuristics in ARCHITECTURE.md §3.2.
- [ ] Redis Streams publisher.
- [ ] Writer task (same binary): consumer-group reader, 500-span/100-ms batch inserts to ClickHouse.
- [ ] Prometheus metrics on `/metrics`.
- [ ] Structured logging via `tracing` crate.
- [ ] Integration tests: spin up ClickHouse + Redis in test containers, fire 10k OTLP spans, verify all land in ClickHouse.
- [ ] Load test with `k6` or `ghz`: sustain 5,000 spans/sec for 10 minutes on a single node.

**Deliverable:** Ingester that passes 10-minute sustained load test. README benchmark numbers published.

### Phase 3 — SDK + First Customer (Weeks 5–6, June 10 – June 23)

**Goal:** A 3-line TypeScript integration that lights up the dashboard with real traces.

- [ ] `@halley/sdk` package built on `@opentelemetry/sdk-node`.
- [ ] Auto-instrumentation wrappers for `openai`, `@anthropic-ai/sdk`, `@langchain/*`.
- [ ] Helper API: `halley.run(name, fn)`, `halley.step(name, fn)`, `halley.feedback(runId, score, comment)`.
- [ ] Offline queueing: in-memory ring buffer with disk spillover.
- [ ] Unit tests >= 80% coverage.
- [ ] Integration example: instrument Ayush's LLM Reasoning Agent end-to-end, push real traces, see them in the dashboard.
- [ ] Integration example: instrument a minimal LangChain agent from scratch, push real traces.
- [ ] Publish `@halley/sdk` to npm as v0.1.0.

**Deliverable:** `npm install @halley/sdk` works. A 3-line integration captures traces from a real OpenAI call. Two example apps under `examples/`.

### Phase 4 — Dashboard Core (Weeks 7–8, June 24 – July 7)

**Goal:** Dashboard usable for real debugging.

- [ ] Next.js 14 App Router project, Tailwind, shadcn/ui components.
- [ ] Auth.js with email/password + Postgres adapter. Login and project switching.
- [ ] API keys page: create, rotate, revoke.
- [ ] Runs list: server-rendered table, infinite scroll, column sort, filter by project, model, status, cost, time range.
- [ ] Run detail: timeline view at top, reasoning graph canvas below (use `reactflow` for the DAG rendering).
- [ ] Span inspector panel: prompt, completion, tool I/O, token counts, cost, timing. Syntax-highlighted JSON.
- [ ] WebSocket endpoint `/api/ws/runs/:id` subscribed to Redis Pub/Sub, pushing live span updates.
- [ ] Full-text search over prompt/completion content using ClickHouse's `hasToken` / tokenized columns.
- [ ] Keyboard shortcuts: `cmd+k` command palette, arrow keys to navigate spans.
- [ ] Playwright E2E test for: create project → emit span via SDK → see it in the dashboard within 2 seconds.

**Deliverable:** A deployable dashboard where a real developer would want to debug their agent.

### Phase 5 — Differentiators (Weeks 9–10, July 8 – July 21)

**Goal:** The features that make Halley *Halley.*

**Replay & fork:**
- [ ] Worker service (Node.js + BullMQ) running in its own container.
- [ ] "Fork from this step" button in the dashboard's span inspector.
- [ ] Override form: new prompt / new model / injected tool response.
- [ ] Replay worker loads historical spans, reconstructs state, re-executes the agent from the fork point.
- [ ] New run shown side-by-side with the original for comparison.

**Outcome-level evaluation:**
- [ ] Eval suite editor in the dashboard: name, dataset upload (JSON/CSV), scoring method (exact-match, embedding-sim, LLM-as-judge, custom JS).
- [ ] Eval run executor in worker: pulls dataset, calls the target agent endpoint, scores outputs, writes results.
- [ ] Eval results view: pass/fail matrix, per-item drill-down, trend line over time.
- [ ] Regression alert: compare aggregate score to rolling 5-run average; alert if below a configurable threshold.

**Cost analytics:**
- [ ] Cost dashboard: line chart of dollars/day, grouped by model or project or tag.
- [ ] Top-runs-by-cost leaderboard.
- [ ] Budget alerts: email + webhook when daily spend exceeds threshold.

**Deliverable:** Eval run on Ayush's own Reasoning Agent published as a blog post draft. Replay/fork demo recorded.

### Phase 6 — Polish & Launch (Weeks 11–12, July 22 – August 4)

**Goal:** Something Ayush can show any interviewer with pride.

- [ ] README polish: architecture diagram, 30-second demo GIF, one-command install.
- [ ] Documentation site — lightweight, probably Nextra. Core pages: Quickstart, SDK reference, Self-hosting, Concepts (runs vs spans vs traces).
- [ ] GitHub Actions CI: lint, type-check, test, multi-arch Docker builds on every PR.
- [ ] Playwright E2E suite covering the five critical flows.
- [ ] Landing page: `halley.dev` (or whatever domain we grab) with a hero animation and a "try the demo" button.
- [ ] Live hosted demo with real traces from Ayush's instrumented apps.
- [ ] 3-minute YouTube demo video.
- [ ] Blog post on `ayushwattamwar.com` about the replay/fork engineering.
- [ ] Launch on Show HN, `r/MachineLearning`, `r/LocalLLaMA`, Twitter. Collect feedback.
- [ ] Update resume with three tight bullets.

**Deliverable:** Halley is live, public, and visible.

### Buffer phase (Weeks 13–16, August 5 – August 31)

**Goal:** Absorb whatever spilled from earlier phases. If nothing spilled, take on one stretch goal.

**Stretch goals, pick one:**
- Kubernetes Helm chart for self-hosters.
- Vertex AI / AWS Bedrock instrumentation.
- Anthropic prompt-caching and extended thinking instrumentation.
- Python SDK stub.
- Basic multi-tenant workspace support.

Also in this window: interview prep, resume rewrite, LinkedIn refresh, outreach.

---

## What could go wrong (and how we prevent it)

1. **Rust learning curve eats week 2.** Mitigation: ship the hello-world Rust ingester in week 1 even if it's ugly, so we hit real Rust problems early. Do not attempt "idiomatic" Rust on day 1.
2. **OTEL compliance becomes a rabbit hole.** Mitigation: target the GenAI conventions specifically, and only validate the fields we use. Full OTEL conformance is explicitly not a goal.
3. **Replay/fork is harder than we think.** Mitigation: cut it from Phase 5 to Phase 6 (after launch) if Week 9 ends and it's not working. The launch ships without replay; replay becomes a "coming soon" feature we blog about separately.
4. **Dashboard grows into a design project.** Mitigation: shadcn/ui components, no custom design system. Functional over beautiful for v1.
5. **Ayush burns out.** Mitigation: Sundays off. Seriously.

---

## Weekly rhythm

- **Mon–Fri:** 4–6 hrs/day focused building. No meetings on Tuesday and Thursday mornings (deep work blocks).
- **Saturday:** 2 hrs to update docs, clean commits, push everything.
- **Sunday:** off.

End of every Friday, update this file's revision log with what shipped, what slipped, and why.

---

## Revision log

| Date | Change | Why |
|---|---|---|
| 2026-05-13 | Initial version | Project kickoff |
