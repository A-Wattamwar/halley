# Halley — Roadmap

Version: 0.5 (May 15, 2026)
Owner: Ayush Wattamwar

Living plan. When direction changes mid-build, we update this file first, then the code. Truth base for "what are we doing this week."

---

## Timeline

- **Start**: May 13, 2026
- **End**: August 31, 2026
- **Total**: 16 weeks = 12 working weeks + 4 buffer weeks for interviews, schoolwork, or scope recovery.
- **Target effort**: 25 to 30 hrs/week. ~300 to 360 hours total.
- **Cadence**: Sundays off. Saturdays for docs, commits, and weekly updates to this file.

---

## Product frame

Halley's hero capability: **your production traffic is your test suite**. We record production agent runs as bit-fidelity cassettes, infer invariants, let the user save any run as a fixture in their repo, and run the fixture library as zero-cost deterministic CI that catches prompt and model regressions before they ship.

Everything else (OTLP ingest, reasoning graph, cost analytics, interactive replay) is supporting infrastructure for that loop.

---

## North-star success criteria (August 31, 2026)

By end of summer, Halley must have:

1. Public GitHub repo with clean commit history and polished README.
2. `docker compose up` stands up the full stack in under 60 seconds.
3. Three example apps in three different stacks (Python OpenLLMetry, Vercel AI SDK, direct TypeScript) emit real OpenAI traces into one Halley dashboard.
4. `halley` CLI published as a standalone Rust binary and a GitHub Action.
5. End-to-end ingestion at 5,000+ spans/sec on a single laptop-class VM, verified with a load test.
6. Normalizer passes property-based tests proving round-trip correctness for four dialects: OTEL GenAI, OpenLLMetry, OpenInference, Vercel AI SDK.
7. **The hero demo**: one prompt change breaks three real fixtures in CI, `halley bisect` points at the prompt line that did it, full flow under 40 seconds on camera.
8. Live hosted demo with read-only dashboard and real traces from Ayush's instrumented apps.
9. 3-minute YouTube demo video centered on the prompt-change-breaks-CI loop.
10. Technical blog post on `ayushwattamwar.com` about cassette-based replay and invariant inference.
11. Show HN launch and `r/MachineLearning` post.
12. Three resume bullets that stand alone as interview-worthy.

All shipped, even if imperfect = we did. Any one missing = we did not.

---

## Phase plan

### Phase 1: Foundations (Weeks 1-2, May 13 - May 26)

**Goal**: End-to-end skeleton running locally. No features beyond ingest.

- [ ] Monorepo scaffold: `sdk-ts/`, `ingester/` (Rust), `cli/` (Rust), `dashboard/` (Next.js), `worker/` (Node), `infra/`, `examples/`.
- [ ] `docker compose up` starts ClickHouse, Redis (with AOF on), Postgres, ingester, dashboard; all healthchecks green.
- [ ] ClickHouse migration: `halley.observations` and `halley.observation_body` tables per ARCHITECTURE §4.1.
- [ ] ClickHouse migration: `halley.pricing_versions` with seed rows for OpenAI, Anthropic, Gemini current pricing.
- [ ] Postgres migration: `users`, `projects`, `api_keys`, `fixtures`, `bisect_jobs`.
- [ ] Rust ingester skeleton: axum bootstrap, `/v1/spans/json` HTTP endpoint (not OTLP yet), writes to ClickHouse.
- [ ] Dashboard placeholder: Next.js page reads observations from ClickHouse, renders a table.
- [ ] Read OpenTelemetry GenAI semantic conventions end to end. 1 page of notes.
- [ ] Skim Langfuse v4 and Laminar source. 1 page of notes each: how they capture bodies, how they handle live updates, how they normalize dialects.

**Deliverable**: JSON span in, ClickHouse row out, browser table shows it, all via `docker compose up`.

### Phase 2: OTLP and the normalizer (Weeks 3-4, May 27 - June 9)

**Goal**: Production-quality ingester speaking OTLP with honest dialect coverage.

- [ ] OTLP/gRPC receiver on :4317 using `tonic` + `opentelemetry-proto`.
- [ ] OTLP/HTTP receiver on :4318 using `axum`, protobuf and JSON.
- [ ] Normalizer: adapters for OTEL GenAI, OpenLLMetry, OpenInference, Vercel AI SDK. Canonical mapping documented.
- [ ] **Property-based tests** for each adapter: canonical -> dialect -> canonical is the identity on supported attributes. Unknown attributes preserved in `attributes` map.
- [ ] Cassette capture: raw request and response bodies stored content-addressed in `observation_body`, hashes in `observations`.
- [ ] Run-grouping: the four-tier heuristic in ARCHITECTURE §3.4.
- [ ] Redis Streams publisher + DLQ stream.
- [ ] Writer task: consumer group, 500-span/100-ms batches, dedup body hashes before insert.
- [ ] Prometheus metrics per ARCHITECTURE §7.2.
- [ ] Integration tests with `testcontainers`: fire 10K OTLP spans across all four dialects, verify canonical rows land correctly.
- [ ] Load test with `k6` or `ghz`: sustain 5K spans/sec for 10 minutes.

**Deliverable**: ingester passes sustained load test, published compatibility matrix (four dialects), `halley_body_dedup_ratio` metric visible.

### Phase 3: Real traces and the dashboard becoming usable (Weeks 5-6, June 10 - June 23)

**Goal**: Three example apps, three different instrumentation libraries, one dashboard.

- [ ] Example 1: Ayush's Reasoning Agent (Python) instrumented with OpenLLMetry. Lands with `source_dialect = "openllmetry"`.
- [ ] Example 2: Vercel AI SDK app (Next.js) emitting traces via its native OTEL export. Lands with `source_dialect = "vercel-ai"`.
- [ ] Example 3: Direct TypeScript app (Node.js + OpenAI SDK + OpenLLMetry). Lands with `source_dialect = "openllmetry"`.
- [ ] All three land in the same dashboard with correct canonical schema; published screenshot proves it.
- [ ] Quickstart docs for Python, TypeScript, and Vercel AI SDK under `docs/quickstart/`.
- [ ] Real OpenAI pricing in `pricing_versions` for `gpt-4o-mini` and `gpt-4o`.
- [ ] Dashboard runs list + run detail (pulled forward from Phase 4): paginated runs table, timeline view, reasoning graph via `reactflow`, span inspector sidebar.

**Deliverable**: Three example apps under `examples/` prove polyglot ingest. Dashboard is demoable to a real developer.

### Phase 4: Dashboard core (Weeks 7-8, June 24 - July 7)

**Goal**: Dashboard usable for real debugging. Auth, live updates, API keys.

- [ ] Auth.js with email+password + Postgres adapter. Login, project switching.
- [ ] API keys page: create, rotate, revoke.
- [ ] Single `halley-query` module enforces project-scoped auth; all server components route through it.
- [ ] WebSocket endpoint `/api/ws/runs/:id` subscribed to Redis Pub/Sub; live updates.
- [ ] One Playwright E2E: emit span via SDK -> see it in dashboard within 2 seconds.

**Explicitly cut from v0.1**: full-text search over content, infinite scroll, column sorting, cmd+k palette, keyboard nav. Push to Phase 6 polish if time allows.

**Deliverable**: a dashboard a real developer would use to debug an agent, with auth and live updates.

### Phase 5: The hero loop (Weeks 9-10, July 8 - July 21)

**Goal**: Production run to fixture to CI to bisect. The thing that makes Halley Halley.

**Turn into test (UI + worker)**
- [ ] "Turn this run into a test" button on any run detail.
- [ ] Worker `invariant.infer` job: structural, schema, metric invariants auto-proposed.
- [ ] Invariant editor in dashboard: accept / edit / reject each proposal.
- [ ] Fixture writer: write `halley/fixtures/<slug>.json` + `/bodies/` to user's repo via configured local path. GitHub App integration is Phase 6.
- [ ] Fixture format documented, versioned, stable.

**halley CLI + replay engine**
- [ ] `halley ci`: discover fixtures, run replay, evaluate invariants, exit code + JUnit XML output.
- [ ] `halley record <run_id>`: pull a run from the backend and write a local fixture.
- [ ] `halley diff <fixture_id>`: show prompt / model / tool / output deltas vs. the recorded baseline.
- [ ] Replay modes: pure (all cassette hits), hybrid (prompt changed, LLM call live, tools cached), fresh (explicit re-record).
- [ ] Cassette matching algorithm documented.
- [ ] Published GitHub Action wraps `halley ci`.

**Bisect**
- [ ] `halley bisect <fixture_id>`: binary search recent commits, report the first failing commit and a one-line diff summary.
- [ ] `bisect.run` worker job surfaces progress in the dashboard.

**Tool-effect-safe replay**
- [ ] `halley.markToolEffect(name, 'pure' | 'idempotent' | 'irreversible')` in SDK.
- [ ] Replay refuses to re-execute `irreversible` tool calls without an explicit override or substitute.
- [ ] UI flow for overriding or substituting before a fork runs.

**Interactive replay / fork (reduced scope from v0.1)**
- [ ] "Fork from this step" button.
- [ ] Worker calls the user's registered replay endpoint with reconstructed history + overrides; spans flow back and render alongside the original.

**Deliverable**: the hero demo works end to end. Prompt tweak in a real commit breaks fixtures, CI fails, bisect names the commit, a 40-second video shows it.

### Phase 6: Polish and launch (Weeks 11-12, July 22 - August 4)

- [ ] README polish: architecture diagram, hero GIF (the CI failure and bisect), one-command install.
- [ ] Docs site (Nextra or similar). Core pages: Quickstart, Concepts (cassettes, invariants, fixtures), Self-hosting, SDK reference, CLI reference, CI integration guide.
- [ ] GitHub Actions CI for the Halley repo: lint, type-check, test, multi-arch Docker builds, Rust clippy/fmt/test.
- [ ] GitHub App integration for fixture writes (alternative to the local-path config).
- [ ] Playwright E2E covering three critical flows: ingest -> dashboard, turn into test, replay+bisect in CI.
- [ ] Landing page (`halley.dev` or similar), hero animation, "try the demo" button.
- [ ] Live hosted demo.
- [ ] 3-minute YouTube demo video centered on the hero loop.
- [ ] Blog post on `ayushwattamwar.com`: "How Halley turns production agent runs into deterministic regression tests."
- [ ] Launch: Show HN, `r/MachineLearning`, `r/LocalLLaMA`, Twitter. Collect feedback.
- [ ] Resume update: three tight bullets.

**Deliverable**: Halley is live, public, visible. The loop is the story.

### Buffer phase (Weeks 13-16, August 5 - August 31)

Absorb whatever spilled. If nothing spilled, pick one stretch:

- Kubernetes Helm chart.
- Python `halley` SDK wrapping OpenTelemetry Python SDK + optional OpenLLMetry.
- More dialects (Anthropic prompt caching, extended thinking, Google ADK).
- Cassette diffing viewer (side-by-side recorded vs. live response).
- Semantic invariant runner (LLM-as-judge) with cost reporting.

Also: interview prep, resume rewrite, LinkedIn refresh, outreach.

---

## What could go wrong (and how we prevent it)

1. **Rust learning curve eats Week 2.** Mitigation: ship the hello-world ingester in Week 1 even if ugly. Hit real Rust problems early. No chasing idiomatic purity on day 1.
2. **Normalizer becomes a rabbit hole.** Mitigation: scope to four dialects, property tests prove correctness, unknown attributes preserved not normalized. Do not target full OTEL conformance.
3. **Invariant inference produces noisy proposals.** Mitigation: structural + schema + metric invariants are deterministic and tight. Semantic invariant is off by default. User reviews every proposal before save.
4. **Cassette matching is brittle when prompts change frequently.** Mitigation: hybrid mode is the default for PR replays. Pure mode only when no inputs drifted. Cost impact of hybrid replay is bounded and reported.
5. **Bisect is harder than it looks (non-monotonic regressions, flaky invariants).** Mitigation: bisect runs each candidate commit three times; a flaky invariant triggers a "widen semantic bounds" prompt in the UI before bisect proceeds.
6. **A competitor (Langfuse, Laminar) ships this first.** Possible. Mitigation: ship the loop fast, open source, make the fixture format portable so fixtures outlive any one platform.
7. **Halley SDK compatibility churn.** Mitigation: SDK is optional. OTLP is the contract. Any OTEL-instrumented stack works.
8. **Ayush burns out.** Mitigation: Sundays off. Seriously. Non-negotiable.

---

## Weekly rhythm

- **Mon-Fri**: 4-6 hrs/day building. Deep-work blocks Tue/Thu mornings, no meetings.
- **Saturday**: 2 hrs doc updates, commit cleanup, push. Update this file's revision log.
- **Sunday**: off.

---

## Revision log

| Date | Version | Change | Why |
|---|---|---|---|
| 2026-05-13 | 0.1 | Initial plan | Project kickoff |
| 2026-05-13 | 0.2 | Pivoted hero thesis to "production runs become regression tests." Phase 2 now centers the normalizer with property tests. Phase 5 rebuilt around cassette capture, invariant inference, halley CLI, replay modes, bisect, tool-effect-safe fork. Dashboard scope in Phase 4 tightened. Added `halley` CLI and GitHub Action as first-class deliverables. | May 13 research showed original differentiators (OTLP-native ingest, agent replay) were already shipped by Langfuse v4 and Laminar. Repositioned around the production-to-regression loop no one closes today. |
| 2026-05-18 | 0.3 | Week 1 complete. Phase 1 ingester fully shipped (insert path, Dockerfile, smoke test). All Week 1 checklist items done. | Ran ahead of schedule; shipped insert path and Dockerfile in Week 1 instead of leaving for Week 2. |
| 2026-05-15 | 0.5 | Phase 3 reshape — SDK dropped in favor of OTEL-direct quickstart docs and three working example apps. Dashboard runs list + run detail pulled forward from Phase 4 into Phase 3 Week 6. Phase 4 scope reduced to auth + live updates only. North-star item #3 updated from `@halley/sdk` to three example apps. Decision rationale in DECISIONS.md D41. | Halley's pitch is "ingest whatever your app already emits." A proprietary SDK contradicts that. Pulling the dashboard forward gets a demoable product two weeks earlier. |
| 2026-05-28 | 0.6 | Phase 4 complete (Weeks 7–8). Shipped: Auth.js CredentialsProvider + Postgres adapter, project-scoped halley-query, API keys page + ingester validation with Redis 60 s cache (D48), SSE live span streaming with exponential backoff reconnect + toast (D49), SSE heartbeat (immediate `": connected"` frame + 25 s keepalive), Playwright E2E (3.9 s, standalone Docker). Bug fixes: ClickHouse 24.8 analyzer alias shadowing in getSpanDetail (D50), runs-list "All time" hidden 7-day floor. | Auth + live updates were the two remaining gaps before a complete portfolio demo. All Phase 4 acceptance criteria met. |
