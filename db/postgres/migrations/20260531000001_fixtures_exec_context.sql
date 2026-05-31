-- migrate:up
-- Phase 6 Week 11 Day 2: per-fixture execution context (D54).
--
-- The host-side runner (the worker on the host) executes ci.run / bisect.run
-- against the user's *agent* git repo. Until now bisect-run.ts guessed that
-- repo from env vars with hardcoded /Users/... fallbacks. These two NULLABLE
-- columns let each fixture row carry its own execution context so the worker
-- never guesses:
--
--   target_repo_path -- absolute path to the git repo to BISECT (where the
--                       agent's code lives, e.g. the user's app repo or the
--                       hero-demo repo). This is DISTINCT from the existing
--                       `repo_path`, which is the RELATIVE path to the fixture
--                       JSON inside the fixture-WRITE target dir
--                       (e.g. "halley/fixtures/reasoning-agent-math.json").
--                       They are often different directories — do not conflate.
--   config_path      -- path to the halley.config.json for this fixture's agent
--                       (e.g. "examples/replay-target/halley.config.json" or an
--                       absolute path). Passed to the CLI as the top-level
--                       `--config`.
--
-- Both NULLABLE for back-compat: existing fixture rows keep working, and a NULL
-- target_repo_path is the honest `needs_runner` signal the worker degrades to
-- (D54) instead of guessing a path.
--
-- D24: one SQL statement per migration file. A single ALTER TABLE with two
-- ADD COLUMN clauses is ONE statement (Postgres-supported; mirrors the
-- 20260526000003_api_keys_phase4.sql pattern). IF NOT EXISTS keeps it
-- idempotent on a volume that already ran it.
ALTER TABLE fixtures
  ADD COLUMN IF NOT EXISTS target_repo_path TEXT,
  ADD COLUMN IF NOT EXISTS config_path      TEXT;

-- migrate:down
ALTER TABLE fixtures
  DROP COLUMN IF EXISTS config_path,
  DROP COLUMN IF EXISTS target_repo_path;
