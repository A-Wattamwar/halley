# Phase 5 — The Hero Loop

**Timeline**: Weeks 9–10 (July 8 – July 21, 2026)
**Goal**: Close the loop. A production run becomes a fixture in the user's repo, `halley ci` replays it at zero cost, a prompt change breaks it, and `halley bisect` names the commit that did it. This is the thing that makes Halley *Halley* — everything before this was supporting infrastructure.

---

## Core decision (locked 2026-05-28): replay interception → D51

**How does replay intercept the user's LLM and tool calls?**

The CLI is a Rust binary (ROADMAP deliverable #4, ARCHITECTURE §3.8), but the user's agent is Python or TypeScript. Decision, after researching the May-2026 state of the art (`vcr-llm`, `pytest-agentcontract`, `agentsnap`, `llm-test-harness`):

> **A thin per-language record/replay shim that patches the client/transport layer in-process** (e.g. `httpx`/`requests` in Python, `fetch`/`undici` in TS — the `vcr-llm` approach), **orchestrated by the Rust `halley` CLI**. The CLI sets the mode (record / replay / hybrid) and cassette path via env; the shim intercepts each provider and tool call, canonicalizes + hashes the request (**D22 hashing rule** — same as body capture), and matches against the cassette: **hit → serve the recorded response (cost $0); miss → call live, record a new cassette version.** One cassette format + one hash algorithm shared across languages so cassettes replay cross-language.

**Why a shim and not a standalone HTTP proxy** (the research flipped this):
- LLM requests all POST to the same URL, so URL-based proxy matching fails; you need turn-sequence + input-hash matching, which the in-process shim does naturally.
- A naive proxy **loses SSE streaming frame boundaries** — breaking Halley's bit-fidelity claim. The shim records provider-aware.
- A proxy **cannot see in-process tool calls** — which would gut Halley's "same tools, same order" *structural invariant*. The shim intercepts tools in-process.
- Interception is **not** Halley's differentiator (portable in-repo fixtures + `bisect` + tool-effect-safe replay are). So pick the mechanism that protects those, not the one that's simplest to build.

**Division of labor:** the Rust CLI owns everything language-agnostic — `ci`/`record`/`diff`/`bisect`, fixture format, cassette index, invariant evaluation, JUnit/exit codes, bisect orchestration. The shim is small (`vcr-llm` is "zero deps") and only does record/replay interception.

**Build order (de-risks Week 10 for a solo founder):**
- **Python shim first** — the flagship demo (`examples/reasoning-agent-python`) is Python, so the hero demo needs only one language working end-to-end.
- **TS shim** reuses the `sdk-ts/` scaffold — late Week 10 if time allows, else Phase 6.
- HTTP proxy documented as a fallback for languages without a shim.

This is **D51** (recorded below).

---

## Context

**What's owed from Phase 4** (debt register, `phase-4-overview.md` retro):

| Item | Status | Phase 5 action |
|------|--------|----------------|
| D44 — Traceloop 0.55+ single-span runs (no agent-root grouping) | Known limitation | Out of scope. Fixtures work per-run regardless; revisit in Phase 6. |
| D46 — Vercel outer-span token aggregation undercount | Documented | Out of scope. Does not affect replay correctness. |
| reasoning-agent answer parsing | App-level bug | Out of scope until Phase 6 demo polish. |
| **Live badge invisible when SSE is open + idle** | New (Phase 4 UX gap) | **Week 9 Day 1 warm-up** — small, see below. |

**Starting state (verified 2026-05-28):**
- `worker/` — scaffold only (`README.md`, no code). Needs the BullMQ runtime built from scratch.
- `cli/` — **does not exist.** Created in Week 10.
- `sdk-ts/` — scaffold only. Becomes the home of the TS replay shim (D51), but TS is second priority; Python shim ships first.
- Postgres `fixtures` (`id, project_id, source_run_id, repo_path, invariants_json JSONB, status ∈ {proposing,ready,stale}, last_replay_at, created_at`) and `bisect_jobs` (`id, fixture_id, base_commit, head_commit, status ∈ {queued,running,done,failed}, result_commit, log, created_at, completed_at`) — **already exist from Phase 1.** No new tables expected; columns may need additive widening only.
- ClickHouse `observation_body` (content-addressed, SHA-256, deduped) — **live since Phase 2.** Cassette bodies are already captured. Phase 5 reads them, it does not change capture.

**Phase 5 scope per ROADMAP v0.6 (§ Phase 5):**
- Worker `invariant.infer`: structural, schema, metric invariants auto-proposed.
- Invariant editor in dashboard: accept / edit / reject each proposal.
- Fixture writer: `halley/fixtures/<slug>.json` + `/bodies/` to a configured **local repo path** (GitHub App is Phase 6).
- `halley` CLI: `ci`, `record`, `diff`, `bisect`.
- Replay modes: pure / hybrid / fresh. Cassette matching documented.
- Tool-effect-safe replay (refuse irreversible tool calls without override).
- Published GitHub Action wrapping `halley ci`.
- The hero demo end-to-end.

**Explicitly cut / reduced (per ROADMAP):**
- Interactive replay / fork — reduced scope: a single "re-run with overrides" path, not a full fork UI.
- GitHub App fixture writes — Phase 6 (local path only in Phase 5).
- Semantic invariant runner (LLM-as-judge) — off by default, proposal-only; the runner itself is Phase 6.
- Cassette side-by-side diff viewer — Phase 6.
- Full replay *SDK* (rich client wrappers, framework integrations) — out of scope; v1 ships a minimal record/replay *shim* per language (Python first), not a full SDK.

---

## Architecture changes

### New components
1. **Worker runtime (`worker/`, Node.js + BullMQ).** New `docker-compose` service. Consumes jobs from Redis (BullMQ queue, separate from the `halley:spans` stream). Jobs: `invariant.infer`, `bisect.run`. Reads ClickHouse (observations + bodies) and writes Postgres (`fixtures.invariants_json`, `bisect_jobs`).
2. **`halley` CLI (`cli/`, Rust, clap).** Host-side binary built with cargo (D-2 — no Docker). Subcommands `ci`, `record`, `diff`, `bisect`. Owns the cassette format, matcher orchestration, invariant evaluation, JUnit/exit codes, and bisect. Drives the language shim via env (mode + cassette path).
3. **Per-language replay shim (`sdk-ts/` for TS; a small Python package for Python).** Patches the client/transport layer in-process to record/replay provider + tool calls by canonical-request hash (D22). The interception mechanism (see D51 above). Python first; TS second.
4. **Fixture writer.** Serializes a fixture to `halley/fixtures/<slug>.json` + content-addressed `bodies/` in the user's repo via a configured local path. Leaves the commit unpushed (ARCHITECTURE §5.3).
5. **`halley.config.json`.** User-repo config: agent entry point/command, provider base-URL env var to override, tool HTTP endpoints, replay defaults.

### Modified components
1. **Dashboard.** New "Turn this run into a test" action on run detail; invariant editor flow; Fixtures list page; Bisect job UI. All Server Components first (D-11); client islands only for the editor interactions.
2. **API routes (dashboard).** `POST /api/fixtures` (create + enqueue infer), `POST /api/fixtures/:id/save` (write to repo), bisect trigger. Server Actions where possible.
3. **Ingester.** **No changes expected.** Cassette capture already exists. If a replay-metadata gap surfaces (e.g. recording non-deterministic variance sources), flag it — do not silently change the hot path.

### Unchanged (locked)
- ClickHouse schema, canonical span shape, hex-on-wire/bytes-in-DB, canonical JSON hashing (D22), pricing pattern (D42), adapter priority (D31), run-grouping split (D34), dbmate (D24), Rust 1.85 (D28).

---

## Week 9 — Invariant inference + fixture promotion (July 8–14)

Backend-and-dashboard week. The deliverable is: **click a run → get proposed invariants → edit them → a fixture file lands in a local repo.** No CLI yet.

### Day 1: Worker scaffold + invariant.infer (structural) + Live-badge warm-up

**Warm-up (small, do first):** Fix the Phase 4 Live-badge visibility gap. In `dashboard/src/app/runs/[id]/LiveSpansIsland.tsx`, the badge is hidden when `connState === "open"` and `newSpans.length === 0`, so on an idle/historical run the green "Live" pill never shows. Make the connection badge **always render** (a compact persistent pill), keeping the new-spans rows list conditional. Pure UI, contained to one client component.
- Acceptance: open any run detail page → green "Live" pill is visible and steady once connected, with no new spans required.

**Main work:**
- Build the `worker/` BullMQ runtime: queue connection to Redis, a typed job dispatcher, graceful shutdown, health log. New `docker-compose` service `worker`.
- Implement `invariant.infer` job — **structural invariants only** this day: expected span count / span-type sequence, required operations present (e.g. "exactly one `chat`, one `execute_tool`"), parent-child shape.
- Job input: `run_id`. Loads observations from ClickHouse. Output: proposed structural invariants written to `fixtures.invariants_json` (status stays `proposing`).

**Acceptance:**
- `docker compose up worker` healthy.
- Manually enqueue `invariant.infer` for a seeded run → `fixtures` row gets structural invariants in `invariants_json`.
- `npm run build` clean. Live badge visible.

### Day 2: Schema + metric invariants + "Turn this run into a test"

- Extend `invariant.infer`: **schema invariants** (output JSON shape / required keys / types from the recorded output bodies) and **metric invariants** (cost upper bound = cassette cost + 20% headroom, latency upper bound, token bounds — defaults from ARCHITECTURE §3.7, all configurable).
- Dashboard: "Turn this run into a test" button on `/runs/[id]`. `POST /api/fixtures` → insert `fixtures` row (`status=proposing`) → enqueue `invariant.infer`.
- Semantic invariant: **proposed but off by default**, clearly flagged (no runner yet).

**Acceptance:**
- Click the button on a real seeded run → fixture row created → worker fills structural + schema + metric proposals.
- `npm run build` clean.

### Day 3: Invariant editor UI

- `/runs/[id]` (or a dedicated `/fixtures/[id]/edit`) editor: list each proposed invariant grouped by type; accept / tighten / loosen / remove; for metric invariants, editable numeric bounds.
- Client island for edits; save is a Server Action `POST /api/fixtures/:id` updating `invariants_json` (still `proposing` until written to repo).

**Acceptance:**
- Edit a metric bound, remove a structural invariant, save → reload shows the edited set.
- `npm run build` clean.

### Day 4: Fixture writer + fixture format v1 (NEW locked contract)

- Implement the fixture writer (in the worker or a dashboard server action — decide Day 4; worker keeps the dashboard thin). `POST /api/fixtures/:id/save`:
  - Resolve the run's observations + dedup body blobs.
  - Write `halley/fixtures/<slug>.json` (run metadata, ordered observations with `body_hash` refs, full invariant set, replay-matching spec, **`fixture_format_version`**) + `halley/fixtures/<slug>/bodies/sha256-*.json` to the configured local repo path.
  - Set `fixtures.status=ready`, `repo_path`. Leave the git commit unpushed.
- For dev, the "user repo" is a sample repo under `examples/` (e.g. `examples/replay-target/`). No external repo needed.
- **Document the fixture format** in `docs/` and mark it a **locked contract** — once published, the on-disk shape and matching spec are stable and versioned.

**Acceptance:**
- Save a fixture → JSON + bodies appear on disk in the sample repo, content-addressed, parseable.
- Fixture format doc written; `fixture_format_version: 1` present.

### Day 5: Fixtures list page + week hygiene

- `/fixtures` page: list registered fixtures (name, source run, status, last replay), link into the repo path.
- Full hygiene: `npm run build`, worker tests, `make smoke` (ingest unaffected).
- End-to-end check: run example app → run appears → turn into test → edit → save → fixture on disk → shows on `/fixtures`.
- **Do not start the CLI.** Brief Week 9 checkpoint note.

**Acceptance:**
- Full promotion flow works end-to-end. All green.

---

## Week 10 — CLI, replay, bisect, GitHub Action, hero demo (July 15–21)

The heavy, risky week. Rust CLI built host-side (D-2, cargo) + the Python replay shim. This is where the shim-replay design (D51) earns its keep.

### Day 1: `cli/` scaffold + `halley record` + `halley.config.json`

- Create `cli/` (Rust, clap, host-side). Subcommand stubs for `ci`, `record`, `diff`, `bisect`.
- `halley record <run_id>`: authenticate to the backend (reuse `hlly_` key), pull the run's observations + bodies, write a local fixture using the **Week 9 Day 4 fixture format** (CLI and worker share one format).
- Define + parse `halley.config.json` (agent run command, replay-mode env var the shim reads, tool config incl. `irreversible` flags, replay defaults).

**Acceptance:**
- `halley record <run_id>` writes a valid fixture identical in shape to the dashboard-written one.
- `cargo build/clippy/fmt/test` clean.

### Day 2: Python replay shim + replay engine (pure mode) + `halley ci` + JUnit XML

- Build the **Python replay shim**: patch the client/transport layer in-process, canonicalize+hash each provider/tool request (D22), match against the cassette, serve recorded responses on hit. Provider-aware so SSE bodies are recorded faithfully.
- `halley ci`: walk `halley/fixtures/`, for each fixture launch the configured agent command with the shim active (mode + cassette path via env), **pure mode** (all hits, $0), evaluate invariants against the resulting run, aggregate pass/fail.
- Exit code (0 / non-zero) + **JUnit XML** output for CI.

**Acceptance:**
- `halley ci` against the unchanged Python example → all cassette hits, $0, all invariants pass, exit 0, JUnit XML emitted.
- `cargo` clean; shim unit-tested.

### Day 3: Hybrid mode + tool-effect-safe replay + `halley diff`

- **Hybrid mode**: on a cassette miss (prompt/model changed) the shim calls the real provider live, records the fresh response as a new cassette version alongside the old (for diffing). Cached tool responses still served from cassette. Report live-call count + cost (gpt-4o-mini, D-7).
- **Tool-effect-safe replay**: tools marked `irreversible` in `halley.config.json` refuse to execute on a miss without an explicit `--allow-irreversible` override or a configured substitute. This is a correctness/safety guard, not optional.
- `halley diff <fixture_id>`: prompt-text / model-id / tool-contract / output deltas between the recorded baseline and the current run.

**Acceptance:**
- Change a prompt → `halley ci` runs hybrid, makes exactly the drifted live call(s), reports cost.
- An irreversible tool on a miss is refused without the override.
- `halley diff` shows a readable delta.

### Day 4: `halley bisect` + bisect.run worker + bisect UI

- `halley bisect <fixture_id>`: resolve last-known-good commit, binary-search to HEAD; per candidate, checkout + `halley ci --only <fixture>`; **run each candidate up to 3× to absorb flaky invariants** (ROADMAP risk #5); report first failing commit + one-line diff summary.
- `bisect.run` worker job mirrors this server-side and writes progress to `bisect_jobs` (`status`, `result_commit`, `log`).
- Dashboard bisect UI: trigger + live progress + result commit.

**Acceptance:**
- A real regression commit → `halley bisect` names the correct commit; dashboard shows the job + result.
- `cargo` clean.

### Day 5: GitHub Action + the hero demo + Phase 5 retro

- Publish a GitHub Action wrapping `halley ci`: posts a PR check, pass/fail per fixture, links failures to the diff and a suggested bisect.
- **Hero demo, end-to-end:** a real prompt change in a commit breaks ≥1 fixture → `halley ci` (CI) fails → `halley bisect` names the commit → target: full flow demonstrable under ~40 s.
- Full hygiene across worker, CLI, dashboard, ingester smoke.
- Phase 5 retro at the bottom of this doc. Update ROADMAP revision log. **Do not start Phase 6.**

**Acceptance:**
- The hero demo works on camera-quality reproducibility.
- All green. Retro written.

---

## Disciplines (carry over + new)

- **D-1 … D-15**: carry over.
- **D-16**: The `halley` CLI is Rust, built and tested **host-side** with cargo. Never rebuild Docker to test the CLI.
- **D-17**: Replay interception is via a thin **per-language in-process shim** that patches the client/transport layer (Python first, TS second), driven by the Rust CLI. Shared cassette format + D22 hash across languages. HTTP proxy is a documented fallback only. See D51.
- **D-18**: The worker is a new Node.js + BullMQ `docker-compose` service. BullMQ uses its own Redis keys; it does **not** touch `halley:spans` / `halley:writers` / `halley:live:*`.
- **D-19**: Fixtures in dev are written to a **sample repo under `examples/`** (local path). No external/GitHub writes until Phase 6.
- **D-20**: OpenAI budget unchanged — gpt-4o-mini only (D-7). Hybrid-replay live calls are bounded and cost-reported; keep cumulative dev spend well under the $1 escalation line.
- **D-21**: Worker Docker rebuilds at most once per day it changes (extends D-1 to the new service).

---

## New locked contracts introduced this phase

Once shipped, these are locked (changing them breaks users' committed fixtures):
- **Fixture on-disk format** (`<slug>.json` shape + `bodies/` content-addressing + `fixture_format_version`). Week 9 Day 4.
- **Cassette matching / replay spec** (canonical request hashing + hit/miss/version semantics). Week 10 Day 2.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Replay can't intercept the user's calls cleanly | Per-language in-process shim patches the client/transport layer (D-17, D51) — sees in-process tool calls and records SSE faithfully, unlike a proxy. Python shim first (flagship demo); proxy fallback documented for unsupported languages. |
| Invariant inference produces noisy proposals | Structural/schema/metric are deterministic and tight; semantic is off by default; the user reviews every proposal before save (ROADMAP risk #3). |
| Cassette matching brittle when prompts change | Hybrid is the default for PR replays; pure only when nothing drifted; cost of hybrid bounded and reported (ROADMAP risk #4). |
| Bisect on non-monotonic / flaky regressions | Run each candidate commit 3× before judging; surface a "widen bounds" prompt on flaky invariants (ROADMAP risk #5). |
| Worker/ClickHouse read load during infer | Infer is off the hot path, on-demand, one run at a time. No impact on ingest. |
| Scope blowout in Week 10 | Interactive fork is reduced to one override path; GitHub App and semantic runner are explicitly Phase 6. |

---

## Reviewer checklist (per Day)

- [ ] No changes to locked contracts (schema, hashing D22, pricing D42, etc.).
- [ ] Fixture format / replay spec, once shipped, not silently changed.
- [ ] CLI verified host-side (cargo); Docker not rebuilt for CLI work (D-16).
- [ ] Worker Docker rebuilt only on days it changes (D-21).
- [ ] `npm run build` clean on dashboard days; `cargo build/clippy/fmt/test` clean on CLI/worker-Rust days.
- [ ] No new dependencies beyond what the day requires.
- [ ] OpenAI spend reported on any hybrid/live-call day; gpt-4o-mini only (D-20).
- [ ] DECISIONS.md extended (not new-entry-spammed) for minor corrections; substantive tradeoffs get a numbered entry.

---

## Decision to record on Day 1 (locked 2026-05-28)

**D51. Replay interception via a thin per-language in-process shim, not an HTTP proxy.** The Rust `halley` CLI orchestrates replay but delegates interception to a small per-language shim that patches the client/transport layer (Python `httpx`/`requests` first, TS `fetch`/`undici` second — the `vcr-llm` approach). The shim canonicalizes + hashes each provider/tool request (D22), matches the cassette (hit → recorded response, $0; miss → live call recorded as a new version), and shares one cassette format + hash across languages.

**Rationale (researched against the May-2026 state of the art):** the tools shipping this pattern (`vcr-llm`, `pytest-agentcontract`, `agentsnap`, `llm-test-harness`) all intercept in-process, because (1) LLM calls all POST to one URL so URL-based proxy matching fails, (2) a proxy loses SSE streaming frame boundaries — breaking bit-fidelity, and (3) a proxy can't see in-process tool calls — which would gut Halley's "same tools, same order" structural invariant. Interception is not Halley's differentiator (portable in-repo fixtures + `bisect` + tool-effect-safe replay are), so the mechanism is chosen to protect those.

**Tradeoff:** a shim is per-language. Mitigated by shipping Python first (the flagship demo is Python), reusing `sdk-ts/` for TS, and documenting an HTTP-proxy fallback for languages without a shim. Superseded only if a future single-binary interception approach proves equal on streaming + in-process tools.
