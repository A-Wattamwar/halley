# Phase 5 — The Hero Loop

**Timeline**: Weeks 9–10 (July 8 – July 21, 2026)
**Goal**: Close the loop. A production run becomes a fixture in the user's repo, `halley ci` replays it at zero cost, a prompt change breaks it, and `halley bisect` names the commit that did it. This is the thing that makes Halley *Halley* — everything before this was supporting infrastructure.

---

## The one decision to confirm before Day 1

**How does replay intercept the user's LLM and tool calls?**

The CLI is a Rust binary (ROADMAP deliverable #4, ARCHITECTURE §3.8), but the user's agent is TypeScript or Python. A Rust binary cannot monkey-patch a Python `openai` client. The clean, language-agnostic mechanism:

> **`halley ci` starts a local record/replay HTTP proxy and points the user's agent at it** (e.g. exports `OPENAI_BASE_URL=http://127.0.0.1:<port>`, configured in `halley.config.json`). On each provider call the proxy hashes the canonical request (D22 hashing rule — same as body capture), looks it up in the cassette: **hit → serve the recorded response (cost $0); miss → forward to the real provider, record the fresh response as a new cassette version.** Tool calls are intercepted the same way for tools the user routes through a configured HTTP endpoint; tools called in-process are matched by the SDK shim (Phase 6) or treated as live (with the tool-effect-safe guard).

This is the load-bearing design choice for the whole phase. It means:
- The CLI stays Rust and language-agnostic. No per-language replay SDK in v1.
- Cassette matching reuses the canonical-JSON hashing we already trust (D22).
- "Pure" vs "hybrid" mode is just "did every request hit the cassette."

**If you disagree** (e.g. you'd rather ship a TS replay SDK that patches `fetch`), say so now — it reshapes Week 10 Days 2–3. My recommendation is the proxy: it's the only approach that works across Python, TS, and Vercel with one Rust binary, and it mirrors how `vcr`/`polly.js`/`nock` cassette tools work in practice. This becomes **D51** (proposed below) once you confirm.

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
- `sdk-ts/` — scaffold only. Stays out of scope (replay is proxy-based, not SDK-based, in v1).
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
- TS/Python replay SDK — not needed given the proxy approach.

---

## Architecture changes

### New components
1. **Worker runtime (`worker/`, Node.js + BullMQ).** New `docker-compose` service. Consumes jobs from Redis (BullMQ queue, separate from the `halley:spans` stream). Jobs: `invariant.infer`, `bisect.run`. Reads ClickHouse (observations + bodies) and writes Postgres (`fixtures.invariants_json`, `bisect_jobs`).
2. **`halley` CLI (`cli/`, Rust, clap).** Host-side binary built with cargo (D-2 — no Docker). Subcommands `ci`, `record`, `diff`, `bisect`. Owns the replay proxy and cassette matcher.
3. **Replay proxy (inside the CLI).** Local HTTP server that records/serves provider responses by canonical-request hash. The interception mechanism (see "the one decision" above).
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

The heavy, risky week. Rust CLI built host-side (D-2, cargo). This is where the proxy-replay design earns its keep.

### Day 1: `cli/` scaffold + `halley record` + `halley.config.json`

- Create `cli/` (Rust, clap, host-side). Subcommand stubs for `ci`, `record`, `diff`, `bisect`.
- `halley record <run_id>`: authenticate to the backend (reuse `hlly_` key), pull the run's observations + bodies, write a local fixture using the **Week 9 Day 4 fixture format** (CLI and worker share one format).
- Define + parse `halley.config.json` (agent run command, provider base-URL env var, tool endpoints, replay defaults).

**Acceptance:**
- `halley record <run_id>` writes a valid fixture identical in shape to the dashboard-written one.
- `cargo build/clippy/fmt/test` clean.

### Day 2: Replay engine (pure mode) + `halley ci` + JUnit XML

- Build the record/replay proxy: start local HTTP server, canonicalize+hash each request (D22), match against the cassette, serve recorded responses on hit.
- `halley ci`: walk `halley/fixtures/`, for each fixture launch the configured agent command with the provider base URL pointed at the proxy, **pure mode** (all hits, $0), evaluate invariants against the resulting run, aggregate pass/fail.
- Exit code (0 / non-zero) + **JUnit XML** output for CI.

**Acceptance:**
- `halley ci` against an unchanged agent → all cassette hits, $0, all invariants pass, exit 0, JUnit XML emitted.
- `cargo` clean.

### Day 3: Hybrid mode + tool-effect-safe replay + `halley diff`

- **Hybrid mode**: on a cassette miss (prompt/model changed) call the real provider live, record the fresh response as a new cassette version alongside the old (for diffing). Cached tool responses still served from cassette. Report live-call count + cost (gpt-4o-mini, D-7).
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
- **D-17**: Replay interception is via the **local HTTP proxy** (provider base-URL override). No per-language replay SDK in Phase 5. (Pending D51 confirmation.)
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
| Replay can't intercept the user's calls cleanly | The proxy + base-URL override is the v1 mechanism (D-17). If a provider/SDK ignores the base URL, document it and require the config to set it explicitly. |
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

## Proposed decision to record on Day 1 (confirm first)

**D51. Replay interception via local HTTP proxy, not a per-language SDK.** `halley ci` starts a local record/replay proxy and points the user's agent at it via a provider base-URL override configured in `halley.config.json`. Requests are matched by canonical-JSON hash (D22). Hit → recorded response ($0); miss → live call, recorded as a new cassette version. Rationale: keeps the CLI a single language-agnostic Rust binary across Python/TS/Vercel, reuses the hashing we already trust, and mirrors proven cassette tooling (`vcr`, `nock`, `polly.js`). Tradeoff: in-process tool calls that don't go over HTTP aren't intercepted in v1 (covered by the tool-effect-safe guard + Phase 6 SDK shim).
