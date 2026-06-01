# Halley

**Your production traffic is your test suite.**

Halley records your production agent runs as bit-fidelity cassettes, turns any run into a permanent regression test with one click, and replays your whole fixture library in CI at **zero LLM cost** — then bisects to the exact commit that broke it.

![Halley hero demo: halley ci passes on the last-good commit, a prompt regression turns it red, and halley bisect binary-searches the commits to name the one that broke the fixture — all in pure replay mode at $0, no live API calls](docs/demo/hero-ci-bisect.gif)

> `halley ci` (green) → prompt regression → `halley ci` (red) → `halley bisect` names the commit. ~15 s, $0, zero live calls.

Self-hosted. OpenTelemetry-native. Built for the era where your model keeps changing under you.

> **Status:** Pre-alpha, active development through August 2026. Progress in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Two tiers of capture (read this first)

Halley is honest about what it captures, because it changes what you get.

- **Tier 1 — observability, zero Halley code.** Point any OTLP-emitting instrumentation (OpenLLMetry, OpenInference, OTEL GenAI semconv, Vercel AI SDK) at the ingester. You get the full dashboard — runs, spans, timing, token counts, cost — plus automatic invariant inference. Bodies are reconstructed from `gen_ai.*` span events, so they're great for observability and inferring invariants, but they are **not** byte-faithful and cannot drive bit-exact replay on their own.

- **Tier 2 — bit-fidelity replay, one-line client wrap.** Add the Halley recorder shim and Halley captures the **full raw request/response JSON**. Now `hash(live request) == recorded match_key` by construction, so `halley ci` replays the exact recorded responses at **$0** and `halley bisect` can binary-search commits deterministically. This is the hero loop in the GIF above.

Both tiers write the **same** fixture format. Tier 1 gives you observability and invariant inference at zero instrumentation cost; Tier 2 adds the deterministic $0 CI replay. Details: [`docs/fixture-format.md`](docs/fixture-format.md) (capture tiers, D53).

---

## Install (one command)

```bash
git clone https://github.com/A-Wattamwar/halley
cd halley
docker compose up
# dashboard   → http://localhost:3000
# OTLP/HTTP   → http://localhost:4318
# OTLP/gRPC   → http://localhost:4317
```

`docker compose up` brings up the ingester, dashboard, databases, and the code-only worker (promote a run → fixture, edit invariants) with zero extra setup. Point any OTLP-instrumented app at the ingester and real traces start flowing.

---

## Dashboard + runner + terminal

The dashboard drives the whole loop: promote a run, edit invariants, **Run CI**, **Run bisect**.

The two actions that re-run *your* code — `halley ci` and `halley bisect` — execute on a lightweight **runner on your machine** (the worker, run on the host), not in a generic server container. Replaying your agent needs your repo, your venv, and your keys — the same reason `git bisect`, GitHub self-hosted runners, and Buildkite agents all execute where the code lives. The dashboard enqueues and displays; the runner executes and streams results back.

Prefer the terminal? Every dashboard action shows the exact `halley` command to copy — the runner is never a hidden requirement. When no runner is connected, the buttons switch to **Copy command** and jobs resolve to an honest `needs_runner` state, never a fake spinner.

Full model — which worker runs what, host vs. in-network ports, starting a host runner: [`docs/running-the-loop.md`](docs/running-the-loop.md).

---

## Proof: CI on every PR

Halley ships a GitHub Action ([`.github/workflows/halley-ci.yml`](.github/workflows/halley-ci.yml)) that replays the fixture library in **pure mode ($0, no live calls)** on every pull request, publishes JUnit results as a PR check, and on failure posts a comment with the `halley diff` and `halley bisect` commands to investigate. A second workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds and tests the codebase and permanently guards the D22 canonical-hash contract with a Python↔Rust parity check.

<!-- [AYUSH] Green-CI proof link. The phase-6-week-11 PR (#1) is merged to main, so both
     workflows have run — but I could not verify the conclusion from here (no `gh`, and the
     repo is currently PRIVATE so the run/badge is not publicly reachable). Before launch:
     1) confirm the latest run is green, 2) make the repo public (or the run viewable),
     3) paste the run URL below and/or add a status badge. Do NOT claim "green" until verified. -->
> ▶︎ **Latest CI run:** _link pending — see the note in the README source (verify green + make the run public before launch)._

---

## The problem Halley solves

Every team shipping LLM agents hits the same three walls, usually within a month of going to production.

1. **You cannot test cheaply.** Teams report large fractions of their monthly LLM spend are dev and CI traffic hitting live APIs. Every iteration taxes the bill.
2. **You cannot reproduce bugs.** A customer says "your agent hallucinated on Tuesday." Tuesday is gone. Even if the run was captured, the model behind it has shifted since.
3. **You cannot tell when you got worse.** LLMs fail silently. A one-word prompt tweak or a provider's quiet model upgrade degrades behavior in ways no stack trace catches. Teams lose real money before anyone notices.

Existing observability tools (Langfuse, Laminar, LangSmith, Phoenix, Helicone) show the traces. None of them close the loop from "production run happened" back into "regression test our CI will catch next time."

Halley closes that loop.

---

## What Halley does

Halley is an OpenTelemetry-native observability backend with one hero capability wrapped around it.

### Record
Every production agent run becomes a **cassette**: the exact sequence of LLM calls, tool inputs, tool outputs, timing, and intermediate state. With the Tier-2 recorder shim, this is bit-fidelity capture of raw request and response bodies, not best-effort reconstruction.

### Promote
One click on any run in the dashboard turns it into a permanent fixture in your repo's test library. Halley automatically infers invariants from the run:

- **Structural**: which tools got called, in what order, how many times.
- **Schema**: the shape of each LLM output and tool payload.
- **Metric**: latency and cost bounds.
- **Semantic** *(planned, not yet shipped)*: optional LLM-as-judge for "is the new output equivalent to the recorded one." The runner is a stub and ships off by default — see the deferrals in [`docs/ROADMAP.md`](docs/ROADMAP.md).

You edit, tighten, or remove any inferred invariant before it lands in the repo.

### Replay in CI
`halley ci` replays your entire fixture library against the current code. Zero live LLM calls when the cassette matches. When a prompt changes, Halley runs in hybrid mode: tool responses stay cached, only the drifted LLM call goes live. A full failing run shows exactly which invariant broke on which fixture.

### Bisect
When a regression fires, `halley bisect` binary-searches recent commits and points at the change that broke the invariant — prompt diff, model version bump, framework upgrade, new tool version. The error message names the commit.

### Audit
Every fixture is a reproducible record of what the agent did and why. For regulated industries that need to reproduce an agent decision on demand, the cassette is the audit trail.

---

## Who this is for

**Teams shipping LLM agents to production** who are tired of rediscovering the same customer bug, deploying prompt changes based on three hand-picked examples, paying for the same test inputs repeatedly, and not knowing whether today's model still handles yesterday's edge cases.

**Regulated industries** (finance, healthcare, legal) that need agent decisions to be reproducible on demand and currently cannot guarantee that.

**Open-source maintainers of agent frameworks** who want CI that proves their changes do not regress real user workflows.

---

## How Halley compares

Halley is compatible with any OTLP-emitting instrumentation, including OpenLLMetry, OpenInference, OpenTelemetry GenAI semantic conventions, Vercel AI SDK, Pydantic AI, and raw provider SDK auto-instrumentation. If your app already exports OTLP, you are most of the way to Tier 1.

| If you want... | Use... |
|---|---|
| Browser-agent replay and session recording | [Laminar](https://laminar.sh) |
| LangChain-native interactive debugging | LangSmith |
| A proxy that handles routing and cost tracking | Helicone |
| The broadest open-source LLM data platform | [Langfuse](https://langfuse.com) |
| OpenInference-first eval tooling | Arize Phoenix |
| Managed eval-first CI/CD gating | Braintrust, Latitude |
| **Self-hosted backend that turns production runs into deterministic regression tests and catches prompt and model regressions in CI for free** | **Halley** |

Halley is not a Langfuse or Laminar replacement. It is the regression-testing loop those platforms do not ship. Use Halley because you want cheap, deterministic CI against real production scenarios, not because you want another dashboard.

---

## Architecture at a glance

```
Your AI app (OpenLLMetry / OpenInference / Vercel AI SDK / OTEL GenAI / halley-raw)
        │
        │  OTLP/gRPC :4317   OTLP/HTTP :4318   POST /v1/spans/json
        └──────────────────────────┬──────────────────────────────
                                   ▼
                        ┌─────────────────────┐
                        │   Rust Ingester      │
                        │                     │
                        │  ┌───────────────┐  │
                        │  │  Normalizer   │  │
                        │  │               │  │
                        │  │ halley-raw    │  │
                        │  │ openllmetry   │  │
                        │  │ openinference │  │
                        │  │ vercel-ai     │  │
                        │  │ otel-genai    │  │
                        │  └──────┬────────┘  │
                        └─────────┼───────────┘
                                  │ CanonicalSpan
                                  ▼
                        Redis Streams (halley:spans)
                                  │
                                  ▼
                        ┌─────────────────────┐
                        │   Writer Task        │
                        │  (same binary)       │
                        └─────────┬───────────┘
                                  │
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
             ClickHouse                      Postgres
         (observations,                  (auth, projects,
          bodies, pricing)                API keys, jobs)
                    │                            │
                    └─────────────┬──────────────┘
                                  ▼
                        Next.js Dashboard
                                  │
                                  ▼
                    halley/fixtures/ in your repo
                                  │
                                  ▼
                    halley ci (replay + bisect)
```

Full system design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quickstarts

Pick the quickstart that matches your stack. Each is under 150 lines: prerequisites, install, setup snippet, verification SQL, and a link to a fully working example app under `examples/`.

| Stack | Quickstart | `source_dialect` |
|---|---|---|
| Python + OpenAI (Traceloop / OpenLLMetry) | [quickstart-python.md](docs/quickstart/quickstart-python.md) | `otel-genai` |
| Node.js + OpenAI (OpenInference) | [quickstart-typescript.md](docs/quickstart/quickstart-typescript.md) | `openinference` |
| Next.js + Vercel AI SDK | [quickstart-vercel.md](docs/quickstart/quickstart-vercel.md) | `vercel-ai` |

Once you have fixtures, [`docs/running-the-loop.md`](docs/running-the-loop.md) walks the full record → promote → CI → bisect loop across the dashboard, runner, and terminal.

---

## Supported instrumentation

Halley normalizes spans from five dialects into a single canonical schema. No code changes required — point your existing OTLP exporter at the ingester.

| Dialect | Detection | Status | Adapter |
|---|---|---|---|
| halley-raw | `source_dialect = "halley-raw"` field | ✅ Stable | [halley_raw.rs](ingester/src/normalizer/halley_raw.rs) |
| OpenLLMetry / Traceloop (legacy) | any `traceloop.*` attribute | ✅ Supported | [openllmetry.rs](ingester/src/normalizer/openllmetry.rs) |
| OpenInference / Phoenix | `openinference.span.kind` or `llm.model_name` | ✅ Supported | [openinference.rs](ingester/src/normalizer/openinference.rs) |
| Vercel AI SDK | `ai.operationId` or `ai.model.*` | ✅ Supported | [vercel_ai.rs](ingester/src/normalizer/vercel_ai.rs) |
| OTEL GenAI semconv | `gen_ai.system` or `gen_ai.provider.name` (fallback) | ✅ Supported | [otel_genai.rs](ingester/src/normalizer/otel_genai.rs) |

Detection runs in priority order: halley-raw → OpenLLMetry → OpenInference → Vercel AI → OTEL GenAI. Unknown attributes from any dialect are preserved verbatim in the `attributes` map and never dropped.

> **Note on OpenLLMetry / Traceloop:** `traceloop-sdk >= 0.55.0` (released 2026-03-29) migrated to pure OTEL GenAI semconv and no longer emits `traceloop.*` attributes. Traffic from modern Traceloop versions routes through the `otel-genai` adapter. The `openllmetry` adapter handles users on `traceloop-sdk < 0.55` (legacy `traceloop.*` namespace). See [`docs/research/openllmetry-2026-migration.md`](docs/research/openllmetry-2026-migration.md).

---

## Tech stack

| Layer | Choice |
|---|---|
| Ingester | Rust (`tokio`, `axum`, `tonic`, `prost`) |
| Queue and buffer | Redis Streams |
| Hot storage | ClickHouse (spans and contents) |
| Warm storage | Postgres (auth, projects, API keys, invariant definitions) |
| Fixture format | Portable JSON and content blobs under `halley/fixtures/` in your repo |
| CI harness | `halley` CLI (Rust) plus GitHub Action |
| Dashboard | Next.js 14 (App Router, Server Components) + Tailwind + shadcn/ui |
| Recorder shim | Python (`sdk-py/`), wraps the provider client for Tier-2 bit-fidelity capture; TypeScript shim planned |
| Protocol | OTLP (gRPC and HTTP) aligned with OpenTelemetry GenAI semantic conventions |
| Worker | Node.js, BullMQ jobs for invariant inference, fixture write, CI replay, and bisect |
| Orchestration | Docker Compose (local); Kubernetes Helm planned post-launch |

---

## What it looks like

**The hero loop in the dashboard** — promote a run, edit invariants, then run CI and bisect against the real repo, with a runner-status pill and copy-paste terminal commands for every action.

![Fixture edit page header showing the green "Runner: connected" pill next to the fixture title](docs/screenshots/run-ci-connected.png)
*Runner: connected — a host runner is live, so Run CI and Run bisect execute and stream results in the dashboard.*

![Run CI result showing 19 of 19 invariants passed for a pure-mode fixture replay](docs/screenshots/run-ci-result.png)
*A Run CI result — 19/19 invariants passed, $0 pure-mode replay.*

![Bisect result naming the offending commit that broke the fixture](docs/screenshots/bisect-result.png)
*A bisect result — the offending commit, named.*

![Runner not detected — the action shows the exact halley command to copy and run in a terminal](docs/screenshots/runner-not-detected.png)
*Runner: not detected — the exact `halley` command to copy (D-23). Never a fake spinner.*

**Runs list** — every agent run in one view with dialect, token counts, cost, and status at a glance.

![Halley runs list — five gpt-4o-mini runs ingested via the otel-genai dialect, each showing spans, token counts, cost, and an ok status](docs/screenshots/runs-list.png)

**Run detail with span inspector** — click any span bar to open the inspector, showing timing, identity fields (click to copy), model, usage, and the full input/output bodies as pretty-printed JSON.

![Halley run detail page with the span inspector open on a gpt-4o-mini chat span, showing identity, model, usage, and the input/output bodies](docs/screenshots/run-detail-inspector.png)

The graph view (Timeline | Graph tab) shows the same spans as a dagre-laid-out ReactFlow graph, with parent→child edges and the same operation-color palette.

**API keys** — create, rotate, and revoke project-scoped ingest keys. Keys are prefixed `hlly_`, stored only as SHA-256 hashes, and shown in full exactly once at creation.

![Halley API keys settings page showing the create-key form, an empty key list, and the ingester usage example](docs/screenshots/api-keys.png)

---

## Performance

Single-node HTTP ingest load test (Phase 2, Week 4).

| Metric | Result |
|---|---|
| **Achieved sustained RPS** | **4,792 spans/sec** |
| p50 latency | 1.69 ms |
| p95 latency | 113.93 ms |
| p99 latency | 185.15 ms |
| Error rate | 0.00% |
| Test duration | 5 minutes |
| Total spans ingested | 1,438,636 |
| ClickHouse rows written | 1,438,636 (0 data loss) |

**Hardware:** Apple M2, 8 GB RAM, Docker Desktop (all services co-located).

**Bottleneck:** The ingester receiver is not the bottleneck — the 5-second sanity check achieved ~9K RPS with 5 VUs. At 5K RPS sustained, the ClickHouse writer becomes the constraint: batch inserts at 100ms intervals with a single writer task limit throughput to ~4.8K spans/sec. The Redis stream absorbed the burst (peak lag ~1.48M entries) and the writer drained all entries with 0 data loss after the test ended. p99 latency exceeded the 50ms target because the Redis `XADD` call occasionally queues behind the writer's batch flush.

**Reproduce:**
```bash
docker compose up -d && make ready
make load-test
```

---

## Documentation

- [`docs/SCENARIO.md`](docs/SCENARIO.md): a concrete real-world story of what Halley does and why it matters. Read this first.
- [`docs/running-the-loop.md`](docs/running-the-loop.md): the dashboard + runner + terminal model for record → promote → CI → bisect.
- [`docs/fixture-format.md`](docs/fixture-format.md): the locked on-disk fixture v1 contract and the two capture tiers.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system design, data model, component responsibilities.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): build plan, phase deliverables, and what is deferred.

---

## License

MIT. See [`LICENSE`](LICENSE).

---

## Author

Built by [Ayush Wattamwar](https://ayushwattamwar.com), CS at Arizona State University.

Named after Edmond Halley, who turned a noisy archive of past observations into a reliable prediction of the future. Which is what this tool does for agents.
