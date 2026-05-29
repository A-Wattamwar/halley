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

This is **D51** (recorded in DECISIONS.md).

### Refinement — the shim is DUAL-MODE; bit-fidelity comes from it, not OTLP (D53, 2026-05-29)

The Day-4 fixture-format review surfaced that OTLP-captured bodies are
gen_ai-*semantic* (e.g. `otel-genai` stores `[{role,content}]` reconstructed from
span events), **not** the raw provider payload — so a pure-OTLP cassette is not
byte-replayable, and "bit-fidelity" is physically impossible from OTLP alone (the
raw bytes never reach telemetry). Resolution (D53): the same per-language shim
runs in **two modes**:
- **Record mode (production + `halley record`):** wraps the client, captures the
  **full raw request/response JSON**, emits them to Halley as `halley-raw` spans.
  `observation_body` then holds byte-faithful payloads.
- **Replay mode (CI):** intercepts, canonicalizes with the same code, matches,
  serves.

One code path canonicalizes both times → record/replay parity by construction,
and a production run through the shim *is* a directly replayable cassette.
**Both claims hold: bit-fidelity = true, production-traffic-is-your-test-suite =
true** — for shim-captured runs. **Two-tier model:** Tier 1 (any OTLP, zero code)
= observability + invariant inference; Tier 2 (one-line Halley recorder) =
bit-fidelity cassettes + $0 CI replay (the hero loop). `match_key` matching is
**ordinal** (per-key cursor in `index` order) to handle repeated identical calls.
See D53 for full rationale.

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
- ClickHouse `observation_body` (content-addressed, SHA-256, deduped) — **live since Phase 2.** OTLP runs store gen_ai-*semantic* bodies (not byte-faithful). **Bit-fidelity bodies come from the dual-mode shim's record mode** emitting `halley-raw` spans with the full raw request/response (D53). The Week 9 fixture writer reads whatever is in `observation_body`; bit-fidelity replay requires Tier-2 (shim) capture.

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

## Week 9 checkpoint (2026-05-29)

**Shipped Days 1–5:**
- **Worker runtime** (D-18): BullMQ on `halley:worker` prefix; two job types: `invariant.infer` and `fixture.write`.
- **Invariant inference**: structural (span count, operation sequence, replay-stable `parent_index`), schema (per-span key-path/type from output bodies), metric (cost/latency/token bounds × 1.2 headroom), semantic stub (Phase 6).
- **Invariant editor** (`/fixtures/[id]/edit`): project-scoped Server Component shell + client island; per-section reject/restore, structural exact-vs-subsequence toggle, schema required↔optional one-click loosen, direct numeric metric editing.
- **Fixture writer**: worker `fixture.write` job writes `halley/fixtures/<slug>.json` + content-addressed body files to `examples/replay-target/` (mounted via Docker volume). Status flips to `ready`. `POST /api/fixtures/:id/save` enqueues from the dashboard.
- **Dev Redis split fixed**: Docker Redis remapped to host port 6380 (mirrors Postgres 5433 fix); all services override `REDIS_URL` to in-network name; browser button → worker chain verified end-to-end.
- **`/fixtures` list page**: project-scoped; links to `/runs/[id]` and `/fixtures/[id]/edit`; nav entry from runs list.
- **Fixture format v1** (`fixture_format_version: 1`): documented in `docs/fixture-format.md`.
- **D52** (fixture format) and **D53** (two-tier capture model, ordinal match_key cursor) recorded in `docs/DECISIONS.md`.

**Not started (Week 10):** `cli/`, `halley record`, the Python/TS replay shim, bisect, GitHub App, hero demo.

**Fixture format status:** PROVISIONAL (not locked). D53 identified that `match_key` matching requires an ordinal cursor (not bare lookup) and that bit-fidelity replay requires Tier-2 (shim) capture, not OTLP alone. Format will be locked after Week 10 validates it against the real shim.

---

## Week 10 — CLI, replay, bisect, GitHub Action, hero demo (July 15–21)

The heavy, risky week. Rust CLI built host-side (D-2, cargo) + the Python replay shim. This is where the shim-replay design (D51) earns its keep.

### Day 1: `cli/` scaffold + `halley record` + `halley.config.json`

- Create `cli/` (Rust, clap, host-side). Subcommand stubs for `ci`, `record`, `diff`, `bisect`.
- Define + parse `halley.config.json` (agent run command, replay-mode env var the shim reads, tool config incl. `irreversible` flags, replay defaults).
- **Python shim — RECORD mode (D53, the bit-fidelity foundation):** patch the provider client/transport in-process; pass each call through untouched while capturing the **full raw request + response JSON** (the bytes, not gen_ai-semantic). `halley record` runs the configured agent command with the shim in record mode and writes a **bit-fidelity** local fixture in the Week 9 Day 4 v1 format (reusing D22 canonical hashing for `match_key` and body content-addressing). This produces the **real canonical fixture** that replaces the synthetic `multi-span-distinct.json` placeholder.
- (Backend-pull `halley record <run_id>` — promoting an already-ingested run — is Tier-1 fidelity unless that run was shim-captured; keep it as a thin variant, but the live shim-capture path is the primary one.)

**Acceptance:**
- `halley record` runs the Python reasoning-agent through the shim and writes a valid v1 fixture with raw (bit-fidelity) bodies; `match_key`s are stable and lowercase.
- `cargo build/clippy/fmt/test` clean; shim record path unit-tested.

### Day 2: Python shim REPLAY mode + replay engine (pure) + `halley ci` + JUnit XML

- Add **REPLAY mode** to the same shim: intercept each call, canonicalize+hash with the **same code path used in record mode** (parity by construction, D53), match the cassette by `match_key` with **ordinal per-key consumption** (repeated identical calls advance a cursor in `index` order), serve recorded responses on hit.
- `halley ci`: walk `halley/fixtures/`, for each fixture launch the configured agent command with the shim active (mode + cassette path via env), **pure mode** (all hits, $0), evaluate invariants against the resulting run, aggregate pass/fail.
- Exit code (0 / non-zero) + **JUnit XML** output for CI.

**Acceptance:**
- `halley ci` against the unchanged Python example → all cassette hits, $0, all invariants pass, exit 0, JUnit XML emitted.
- A run with two identical tool calls replays correctly via ordinal matching (the `multi-span-distinct` case).
- `cargo` clean; shim replay path unit-tested.

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
- **Fixture on-disk format** (`<slug>.json` shape + `bodies/` content-addressing + `fixture_format_version`). Written Week 9 Day 4, but **provisional until Week 10 validates it against the real shim** (D53). The on-disk *shape* is stable; `match_key` semantics (ordinal consumption) and the body source (shim-raw vs OTLP-semantic) are confirmed in Week 10. The `LOCKED` banner in `docs/fixture-format.md` stays downgraded to "v1 — provisional" until then.
- **Cassette matching / replay spec** (canonical request hashing + ordinal per-key consumption + hit/miss/version semantics). Week 10 Day 2.

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

---

## Week 9 checkpoint (Days 1–5)

Shipped Days 1–5: worker runtime on Docker, `invariant.infer` job (structural invariants Day 1; schema+metric Day 2), `/fixtures/[id]/edit` invariant editor with project-scoping (Day 3), `fixture.write` worker job writing to `examples/replay-target/` (Day 4), `/fixtures` list page + nav (Day 5). Redis port remap (`6380:6379`) mirrors the Postgres pattern (`5433`) so `npm run dev` and the Docker worker can both talk Redis without collision. Fixture format v1 written but marked **provisional** pending Week 10 replay validation (D53).

---

## Phase 5 Retrospective (Week 10 Day 5, 2026-05-29)

### What shipped (Days 1–10)

**Week 9 — The dashboard foundation:**
- Worker: Docker BullMQ service; structural → schema → metric → semantic-stub invariant inference
- Dashboard: "Turn this run into a test" button; `/fixtures/[id]/edit` invariant editor; `fixture.write` job; `/fixtures` list page; Redis split fixed (port remap)
- Fixture format v1 on-disk: `<slug>.json` + content-addressed `bodies/` files

**Week 10 — The CLI + replay engine:**
- **Day 1**: Rust CLI scaffold (`halley record`, `ci`, `diff`, `bisect` stubs), `halley.config.json` schema, Python shim RECORD mode via `sitecustomize.py` injection. Real bit-fidelity fixture recorded ($0.000054, 5 spans).
- **Day 2**: D22 canonical-hash parity proved rigorously (Python = Rust, byte-identical on real body + adversarial Unicode). Pure-mode replay ($0, ordinal cursor, loud miss exit 78). `halley ci` + JUnit XML. Zero live calls confirmed.
- **Day 3**: Hybrid mode (live on miss, records new cassette version). Schema inference on the record path (structural+schema+metric in every fixture). Tool-effect-safe replay (irreversible guard, exit 79). `halley diff` human-readable delta.
- **Day 4**: `cost_max_usd` bug fixed (hybrid mode now evaluates actual live spend). `halley bisect` CLI (binary search, 3× per candidate, repo restore). Demo repo (`~/halley-demo-repo/`, synthetic fixture). `bisect.run` BullMQ job + `BisectPanel` client island.
- **Day 5**: Hero demo on REAL shim-recorded fixture (`reasoning-agent-math`, 5 spans, authentic OpenAI bodies from Day 1). `halley ci` green → regression commit → `halley ci` red (pure miss at call #0) → `halley bisect` names `c2af6be2` in 3 steps — **6.6 seconds, $0**. GitHub Action (`.github/workflows/halley-ci.yml` + composite action). Fixture format v1 locked. Phase 5 retro written.

### The D53 mid-phase pivot

After Week 9 Day 4, reviewer decision D53 introduced the **dual-mode shim** concept: instead of a single OTLP-based capture path (Tier 1 — gen_ai-semantic bodies only), Halley now has a **Tier 2** bit-fidelity capture path via the Python httpx shim. This changed the fixture format framing (from "locked" to "provisional until Week 10 validates replay") and added significant Week 10 scope (RECORD mode, REPLAY mode, hybrid, tool-effect-safe).

The pivot was the right call: the hero demo now replays byte-identical provider responses, which is the only claim that earns trust with a sophisticated audience.

### Technical debt inventory (carry to Phase 6)

| # | Debt item | Priority |
|---|-----------|----------|
| 1 | **D22 triplication** (`ingester/src/domain/span.rs`, `cli/src/bin/canonical_hash.rs`, `sdk-py/halley_sdk/canonical.py`). Extract into a shared `halley-canonical` Rust crate. Risk: if anyone fixes a bug in the ingester's impl, the CLI copy silently diverges despite parity tests. | P0 — first Phase 6 hygiene item |
| 2 | **In-process tool interception not covered** (v1 shim intercepts at the httpx layer — only sees HTTP-visible tool calls, not in-process Python functions). Document user impact clearly. | P1 |
| 3 | **TypeScript shim deferred** (`sdk-ts/`). Users with TS agents have no shim; documented proxy fallback only. | P1 |
| 4 | **`bisect.run` worker job invokes the CLI as a subprocess** (HALLEY_CLI_PATH). The worker container doesn't ship the Rust binary; v1 requires host access. Full server-side bisect (TypeScript implementation or binary bundling) is Phase 6. | P2 |
| 5 | **Semantic invariants disabled** (v1 ships structural/schema/metric only; LLM-judge rubric is a stub). | P2 |
| 6 | **GitHub App / fixture push** deferred to Phase 6. Current fixture write is filesystem-only. | P3 |

### Hero demo location

- **Demo repo**: `~/halley-hero-demo/` (own `.git`, outside halley repo)
- **Real fixture**: `reasoning-agent-math.json` — 5 observations, authentic shim-recorded bodies (Day 1 live capture, $0.000054)
- **Reproducible script**: `~/halley-hero-demo/demo.sh` — full ci→bisect loop in ~7 seconds, $0
- **Regression**: commit `c2af6be2` "feat: use natural language problem formulation" changes the question → different classify-question prompt → different D22 match_key → pure-mode MISS at call #0 → deterministic, no LLM variance
