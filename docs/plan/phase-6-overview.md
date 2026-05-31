# Phase 6 — Close the Loop, Then Launch

**Timeline**: Weeks 11–12 (July 22 – August 4, 2026)
**Goal**: Make the dashboard tell the truth about the whole hero loop — promote → edit → **run CI** → **bisect** — by executing the code-touching parts through a **local runner** (the worker on the host), with copy-paste terminal commands always visible as the honest fallback. Then ship the launch assets: hero GIF, docs site, landing page, a validated GitHub Action, and the Show HN / blog / video.

This doc is the single source of truth for Phase 6. Read `docs/plan/phase-5-overview.md` (retro + debt inventory) and `docs/DECISIONS.md` (D51–D53) first.

---

## The honest framing (what Phase 6 fixes)

Phase 5 shipped the hero loop end-to-end **from the terminal** (`~/halley-hero-demo/demo.sh`: ci → regression → bisect in 6.6 s, $0). The dashboard does the *promote and edit* half perfectly (turn run into test → invariant editor → write fixture → list). But the *execution* half — `halley ci` and `halley bisect` — only works from the CLI. The dashboard's "Run bisect" button is a fragile stub: it shells out to a host binary via hardcoded `/Users/a-wattamwar/...` paths from inside a Node container that has neither the Rust binary, the user's git repo, the agent's Python venv, nor `halley.config.json`. There is no "Run CI" button at all.

**Why this is architecture, not a bug:** `halley bisect` checks out old commits of *the user's agent code* and re-runs *the user's agent* (their Python, their venv, their deps) at each commit. No generic server container can contain an arbitrary user's agent + environment — this is exactly why `git bisect`, GitHub self-hosted runners, and Buildkite agents all execute **where the code lives**. The fix is the industry-standard **runner/agent pattern**: the dashboard enqueues and displays; a runner on the machine with the repo executes and streams results back.

**The unlock (verified in code):** the worker (`worker/src/index.ts` + `connections.ts`) already reads every connection from env vars (`POSTGRES_URL`, `REDIS_URL`, `CLICKHOUSE_URL`) and defaults to `localhost` ports (5433 / 6380 / 8123). So **launching the worker process on the host** instead of in Docker is genuinely near-zero-code — on the host it already has the CLI binary, the venv, the git repo, and `halley.config.json` in reach.

**But "near-zero-code" applies only to that one fact — where the worker runs.** Closing the loop is still real engineering: Day 2 adds per-fixture execution-context columns and rewires `bisect-run.ts` (removing every hardcoded path); Day 3 builds a new `ci.run` job, the runner-role split, a Redis heartbeat, the "Run CI" / runner-status / copy-command UI, and honest `needs_runner` states. Do not let the "the worker already runs on the host" insight make these days sound like freebies — they are the substance of Week 11.

### Product story after Phase 6

> **The dashboard drives the whole loop. A lightweight Halley runner on your machine executes the parts that need your code (CI + bisect). Prefer the terminal? Every action shows the exact `halley` command to copy.**

This is defensible, honest, and matches how every CI product works. We do **not** claim "our SaaS container runs your Python agent." v1 is: self-hosted Halley + runner on the machine with the agent repo, **or** the terminal, with commands shown in the UI.

---

## Core decision (to lock Day 1): D54 — runner architecture

**D54. The dashboard enqueues and displays; a host-side runner executes CI and bisect. Terminal commands are always shown, never hidden.**

- **The worker is the runner, split by job type (v1 model — locked):**
  - **Docker worker** handles the **code-only jobs** that need only Postgres/ClickHouse/Redis: `invariant.infer` and `fixture.write`. These work out of the box with `docker compose up` — promote and edit need zero host setup.
  - **Host worker** handles the **repo-touching jobs** that need the user's git repo, agent venv, CLI binary, and `halley.config.json`: `ci.run` (new, Day 3) and `bisect.run`. Run on the host (`npm run dev` in `worker/`, env pointed at `localhost:5433 / :6380 / :8123`).
  - **Routing:** jobs are split across two BullMQ queue groups so a Docker worker and a host worker can run simultaneously without stealing each other's jobs. The Docker worker subscribes to `invariant.infer` + `fixture.write`; the host worker subscribes to `ci.run` + `bisect.run` (and may also subscribe to all four if a user prefers a single host worker — documented as the simpler alternative). Implementation: separate `Worker` registrations keyed by queue name (already the pattern in `worker/src/index.ts`), launched via an env flag (e.g. `HALLEY_WORKER_ROLE=docker|host|all`).
  - **v1 simplest-path note:** one host worker subscribing to **all four** queues is acceptable for v1 if the split adds friction — but the dev docs must state clearly which model is in use. Default documented model is the role-split above.
- **Per-fixture execution context** (new DB columns, Day 2) tells the host worker *which git repo* and *which `halley.config.json`* a fixture belongs to. No hardcoded paths, no slug-guessing.
- **Reachability is explicit.** A host worker writes a Redis heartbeat (`halley:runner:heartbeat`, short TTL). The dashboard reads it: runner present → CI/bisect buttons execute and stream results; runner absent → buttons switch to **"Copy command"** showing the exact `halley` invocation. Never a silent failure, never a fake "running" state.
- **Honest degradation:** if a repo-touching job is enqueued with no host runner available, it resolves to status `needs_runner` with the copy-paste command in the log — surfaced in the UI, not a crash or a hang.

**Tradeoff:** users must run a runner locally for one-click dashboard CI/bisect. Mitigated by (1) the dev path being "just run the worker on the host," (2) always-visible terminal commands, (3) the existing GitHub Action covering the CI half in real PRs. Superseded only if a future sandboxed-execution design (e.g. ephemeral per-repo containers) proves safe and general.

This decision is recorded in `docs/DECISIONS.md` as **D54** on Week 11 Day 1.

---

## Starting state (verified 2026-05-29)

- **`worker/`** — BullMQ runtime, three jobs: `invariant.infer`, `fixture.write`, `bisect.run`. `bisect-run.ts` has hardcoded `/Users/a-wattamwar/...` fallbacks for `HALLEY_CLI_PATH`, `HALLEY_BISECT_REPO_PATH`, `HALLEY_SDK_PY_PATH`, and derives the fixture slug by guessing from `repo_path`. **This is the file Phase 6 Week 11 rewires.**
- **`cli/`** — `halley record | ci | diff | bisect` all working host-side. `bisect` takes `<fixture> --good <ref> --repo <path>`; `ci` takes `--only --junit --mode --allow-irreversible` and a top-level `--config`. Single-file `main.rs` + `config.rs`.
- **`fixtures` table** — `id, project_id, source_run_id, repo_path, invariants_json, status, last_replay_at, created_at`. `repo_path` is the relative path to the fixture JSON inside the *fixture-write target* repo — it does **not** record the git repo to bisect or the config path. **Needs additive columns.**
- **`bisect_jobs` table** — `id, fixture_id, base_commit, head_commit, status ∈ {queued,running,done,failed}, result_commit, log, created_at, completed_at`. May need a `needs_runner` status (additive CHECK change) — decide Day 2.
- **Dashboard** — `BisectPanel` (trigger + poll) on `/fixtures/[id]/edit`. **No CI trigger, no last-CI-status display, no runner-status indicator, no copy-command UI.**
- **GitHub Action** — `.github/workflows/halley-ci.yml` is well-built (builds CLI, sets up Python shim + agent venv, runs pure-mode `halley ci`, publishes JUnit, posts PR comment on failure). **YAML-only — never executed on a real GitHub runner.**
- **`sdk-py/halley_sdk/canonical.py`** — D22 canonical hashing, one of **three** copies (ingester Rust, CLI Rust bin, Python). Parity proven Week 10 but drift-prone. **P0 debt.**
- **`docs/PARTNER_PROMPT.md`** — already updated to "Phase 5 complete." (The earlier "still says Phase 4" note is stale; verified current.)

---

## Locked contracts (unchanged — do not touch without explicit approval)

All carry forward and remain locked:
- Canonical schema (CanonicalSpan / ObservationRow), hex-on-wire / bytes-in-DB.
- **D22 canonical JSON hashing** — recursive key-sort, compact, numbers as-is, NOT RFC 8785. The `halley-canonical` extraction (Day 1) must preserve this **byte-for-byte**; the Python↔Rust parity test is the acceptance gate.
- **Fixture format v1** (`fixture_format_version: 1`, `input_body_hash_v1`, ordinal cursor — D52/D53). `docs/fixture-format.md`.
- Pricing pattern (D42), adapter priority (D31), run grouping (D34), dbmate one-statement-per-file (D24), Rust 1.85 (D28), writer retry policy (D30).

Phase 6 adds DB **columns** (additive migrations only) and dashboard UI. It does not change any locked contract.

---

## Week 11 — Close the dashboard loop + prove CI (July 22–28)

The deliverable: **from the dashboard, with the worker running on the host, a user can promote a run, edit invariants, click "Run CI" (see pass/fail), and click "Run bisect" (see the offending commit) — against the real git repo the fixture belongs to — with zero hardcoded paths. And the GitHub Action is green on a real PR.**

### Day 1: P0 hygiene — `halley-canonical` crate + lock D54

**Main work — extract the shared canonical-hash crate (P0 debt):**
- Create `halley-canonical/` Rust crate (or `cli/`-local shared lib if a workspace is cleaner — decide Day 1, prefer a workspace crate both `ingester` and `cli` depend on).
- Move the D22 canonical-JSON + SHA-256 implementation into it. `ingester/src/domain/span.rs` and `cli/src/bin/canonical_hash.rs` both depend on it. **No behavior change.**
- Keep `sdk-py/halley_sdk/canonical.py` as the Python sibling (cross-language, can't share a Rust crate) — but add a CI parity test (Day 4) that fails loudly if Python and Rust diverge.
- **Acceptance:** `cargo build/clippy/fmt/test` clean across the workspace; the existing Week 10 parity proof (real body + adversarial Unicode) passes against the extracted crate, byte-identical. No fixture or hash output changes.

**Decision work:** write **D54** (runner architecture) to `docs/DECISIONS.md`.

### Day 2: Per-fixture execution context (additive schema) + kill hardcoded paths

- **Additive Postgres migration** (dbmate, one statement per file, D24): add to `fixtures`:
  - `target_repo_path TEXT` — absolute path to the git repo to bisect (the user's agent repo). Nullable for back-compat.
  - `config_path TEXT` — path to the `halley.config.json` for this fixture's agent. Nullable.
  - (`fixture_slug TEXT` if we want to stop deriving slug from `repo_path` — decide here.)
- **Rewire `worker/src/jobs/bisect-run.ts`:** read `target_repo_path` + `config_path` from the fixture row; pass `--repo <target_repo_path>` and `--config <config_path>` to the CLI; locate the binary via `HALLEY_CLI_PATH` only (no `/Users/...` fallback — if unset and not on `PATH`, fail with the copy-paste command, not a wrong guess). Remove **every** hardcoded absolute path in this file.
- **`halley.config.json` may carry `target_repo`/defaults** so `halley record` can populate `target_repo_path` at promote time. Wire the fixture-write/promote path to persist it.
- **Acceptance:** a fixture row carries its real git repo + config; `bisect-run.ts` contains zero `/Users/...` strings (grep clean); host-run worker bisects the correct repo.

### Day 3: Close the loop in the UI — Run CI, Run bisect, runner status, copy commands

**This is the heaviest UI+backend day of the phase — not a wiring afterthought.** New job type, new table, runner role-split, heartbeat, three UI surfaces.

- **`ci.run` worker job** (new, runs in the **host** worker per D54): runs `halley ci --only <slug> --config <config_path>` in `target_repo_path`, parses JUnit/exit code, writes results to a new `ci_runs` table (additive: `id, fixture_id, status, passed, total, junit_xml, log, created_at, completed_at`).
- **Runner role-split + routing:** wire the `HALLEY_WORKER_ROLE=docker|host|all` flag in `worker/src/index.ts` so a Docker worker (`invariant.infer` + `fixture.write`) and a host worker (`ci.run` + `bisect.run`) run side by side without stealing jobs. Default dev model = role-split; `all` documented as the single-worker alternative.
- **Runner heartbeat:** the host worker writes `halley:runner:heartbeat` to Redis with a short TTL on a timer; the dashboard reads it to determine runner presence.
- **"Run CI / replay check" action** on `/fixtures/[id]` (and/or `/fixtures/[id]/edit`): enqueues `ci.run` (pure mode, `--only <slug>`), displays pass/fail per invariant + last-run timestamp. Mirror the existing `BisectPanel` trigger+poll pattern.
- **Runner-status indicator + copy-command UI:** show "Runner: connected / not detected." When connected → buttons execute and stream. When not → buttons switch to **"Copy command"** showing the exact `halley ci --only <slug>` and `halley bisect <slug> --repo <path>` with a copy button and a one-line "run in your terminal, or start a runner to do it here" explainer (D54, D-23).
- **Honest job states:** `bisect.run` / `ci.run` resolve to `needs_runner` (with the command in the log) when no host runner is available — surfaced clearly, never a fake spinner.
- **Acceptance:** with the host worker running, clicking Run CI and Run bisect both execute against the real repo and show real results; with no host runner, both show the copy-paste command and a `needs_runner` state. Docker worker still handles promote/edit with zero host setup. `npm run build` clean.

### Day 4: Prove the GitHub Action on a real PR + Halley's own repo CI + parity test

- **Push and green `halley-ci.yml` on a real PR.** This is the validation step the YAML has never had. Fix whatever the real runner surfaces (paths, Python version, venv, fixture discovery). Capture the run URL for the README.
- **Halley repo CI** (`.github/workflows/ci.yml`, separate from `halley-ci.yml`): `cargo build/clippy/fmt/test` (ingester + cli + canonical crate), `npm run build` (dashboard + worker), `make smoke` if feasible in CI, and the **Python↔Rust D22 parity test** as a required check (guards the P0 extraction forever).
- **Acceptance:** a real PR shows the Halley CI green check and the Halley fixture-replay check green; the parity test runs in CI.

### Day 5: Playwright E2E (dashboard loop) + "Local dev + CI" doc + Week 11 checkpoint

- **Playwright E2E** that clicks the **dashboard** path (not just the CLI): log in → open a fixture → click "Run CI" → assert pass/fail renders. (Bisect E2E if the host-runner can be driven in the test env; otherwise assert the copy-command UI renders — honest either way.)
- **`docs/running-the-loop.md`** — the single doc that explains the runner model concretely:
  - **Which worker runs what:** Docker worker = `invariant.infer` + `fixture.write` (promote/edit, zero host setup); host worker = `ci.run` + `bisect.run` (repo-touching). State the default role-split and the single-host-worker (`HALLEY_WORKER_ROLE=all`) alternative.
  - Docker stack vs host worker startup; Redis 6380 (host) vs `redis:6379` (in-network); `HALLEY_CLI_PATH`, `HALLEY_SDK_PY_PATH`.
  - `halley record` on the host; per-fixture `target_repo_path` / `config_path`; dashboard-vs-terminal for every action.
  - This is the doc that makes the split legible to a new user.
- **Week 11 checkpoint** note at the bottom of this file.
- **Acceptance:** dashboard E2E passes; doc walks a fresh user through both paths; all hygiene green.

---

## Week 12 — Launch assets (July 29 – August 4)

The loop now works and tells the truth. Week 12 makes it *visible*.

### Day 1: README hero GIF + screenshots
- Record `~/halley-hero-demo/demo.sh` (ci → regression → bisect, 6.6 s, $0) as a ≤15 s GIF/MP4. Embed in README near the top.
- Add the Week 11 dashboard screenshots: Run CI result, bisect result, runner status. Update the existing `docs/screenshots/`.
- Tighten the README opening: the one-sentence pitch, the GIF, the "dashboard + runner + terminal" model, one-command install.

### Day 2: Docs site (Nextra or similar)
- Core pages: Quickstart (link the three existing `docs/quickstart/`), Concepts (cassettes / invariants / fixtures / two-tier capture), Self-hosting, CLI reference, CI integration, **Running the loop** (from Week 11 Day 5).
- Wire the locked `docs/fixture-format.md` in as the format reference.

### Day 3: Landing page + live demo
- Landing page (`halley.dev` or similar): hero animation (the GIF), the pitch, "try the demo" → the read-only hosted dashboard with real traces from the example apps.
- Live hosted read-only dashboard (Phase 3/4 dashboard, auth-gated or read-only project).

### Day 4: Video + blog post
- 3-minute YouTube demo centered on the prompt-change-breaks-CI loop (the hero demo, narrated).
- Blog post on `ayushwattamwar.com`: "How Halley turns production agent runs into deterministic regression tests" — the cassette / invariant / replay / bisect story, honest about the two-tier model.

### Day 5: Launch + retro
- Show HN, r/MachineLearning, r/LocalLLaMA, Twitter. Resume bullets (three tight ones).
- Phase 6 retro at the bottom of this file. Update ROADMAP to v0.8 / mark North-star items complete.

---

## Explicit deferrals (do NOT pull in without a plan entry)

Per the Phase 5 retro debt inventory, these stay scoped out of Phase 6 unless explicitly added:
- **P1 — TypeScript shim (`sdk-ts/`).** Documented proxy fallback only; no TS shim this phase.
- **P1 — In-process (non-HTTP) tool interception.** Documented limitation; the httpx-layer shim covers HTTP-visible calls only.
- **P2 — Semantic invariant runner** (LLM-as-judge). Stub stays off.
- **P2 — Fully containerized server-side bisect** (no host runner). D54 explicitly chooses the host runner; sandboxed per-repo execution is a future phase.
- **GitHub App for remote fixture push.** ROADMAP lists it for Phase 6; treat as **optional / stretch** — only if Week 12 has slack after launch assets. Local-path fixture writes remain the default.
- Deferred Phase 4 UI cuts (full-text search, infinite scroll, cmd+k) — "if time," not committed.

---

## Disciplines (carry over + new)

- **D-1 … D-21**: carry over.
- **D-22 (new): the runner is the worker on the host, split by job role.** Repo-touching jobs (`ci.run`, `bisect.run`) execute via the **host** worker (D54); code-only jobs (`invariant.infer`, `fixture.write`) run in the **Docker** worker. A single host worker covering all four is the documented v1 alternative. No hardcoded absolute paths anywhere in worker job code.
- **D-23 (new): terminal commands are first-class UX.** Every dashboard action that can run in the terminal shows the exact command with a copy button. This is required, not a hidden fallback.
- **D-2 / D-16**: CLI + canonical crate built/tested host-side with cargo. Never rebuild Docker to test Rust.
- **D-21**: Worker Docker rebuilt at most once per day it changes.
- OpenAI budget: gpt-4o-mini only; the hero GIF re-record (if needed) is pure-mode $0 — no live calls required.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| "Run worker on host" has hidden env-coupling that breaks vs Docker | Worker already reads all conns from env with localhost defaults (verified). Day 2 documents the exact host env (`POSTGRES_URL`, `REDIS_URL`, `CLICKHOUSE_URL`, `HALLEY_CLI_PATH`, `HALLEY_SDK_PY_PATH`). |
| GitHub Action fails on the real runner (untested YAML) | That's exactly why Day 4 pushes a real PR early in the week — time to fix path/venv/Python issues before launch. |
| `halley-canonical` extraction subtly changes a hash | Byte-for-byte parity test (real body + adversarial Unicode) is the acceptance gate; CI parity check guards it permanently. |
| Dashboard bisect still flaky for arbitrary repos | D54 is honest: connected runner → real execution; no runner → copy-paste command. Never a silent wrong-repo bisect. |
| Scope blowout in Week 12 launch polish | GitHub App + Phase 4 UI cuts are explicit stretch-only. Launch assets are the priority. |
| Live hosted demo exposes a write path | Read-only project / auth-gated; no fixture writes from the public demo. |

---

## Reviewer checklist (per Day)

- [ ] No changes to locked contracts (schema, D22, fixture format v1, pricing, adapter priority).
- [ ] `halley-canonical` extraction preserves D22 byte-for-byte (parity test green).
- [ ] No hardcoded `/Users/...` (or any absolute machine path) in worker/CLI/dashboard code — grep clean.
- [ ] Additive migrations only (new nullable columns / new tables); no destructive schema changes.
- [ ] `cargo build/clippy/fmt/test` clean on Rust days; `npm run build` clean on dashboard/worker days.
- [ ] Dashboard never shows a fake "running" state — `needs_runner` + copy command when no runner.
- [ ] Terminal command shown for every executable dashboard action (D-23).
- [ ] DECISIONS.md extended for minor corrections; D54 recorded Day 1.
- [ ] Deferrals respected — no TS shim / semantic runner / containerized bisect pulled in silently.

---

## Acceptance bar for Phase 6 (end of Week 12)

1. With the worker running on the host: dashboard **Run CI** and **Run bisect** both execute against the fixture's real git repo and show real results. No hardcoded paths.
2. With no runner: both actions show the exact copy-paste `halley` command. No silent failure.
3. The `halley-ci.yml` GitHub Action is **green on a real PR** (run URL captured).
4. Halley's own repo CI (cargo + npm + D22 parity) is green on a real PR.
5. `halley-canonical` crate exists; D22 lives in one Rust place; parity test guards Python.
6. README has the hero GIF; docs site, landing page, live demo, video, and blog post are live.
7. Show HN / posts published; three resume bullets written.
8. Phase 6 retro written; ROADMAP updated.

---

## Decision to record on Day 1

**D54. Dashboard enqueues + displays; a host-side runner (the worker on the host) executes CI and bisect; terminal commands are always shown.** See the "Core decision" section above for full rationale and tradeoff. This closes the dashboard half of the hero loop honestly, without claiming a generic server can run an arbitrary user's agent.
