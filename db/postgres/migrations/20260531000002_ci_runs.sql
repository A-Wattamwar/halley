-- migrate:up
-- Phase 6 Week 11 Day 3: ci_runs — results of a dashboard-triggered `halley ci`
-- replay check, executed by the HOST worker's new ci.run job (D54).
--
-- Mirrors bisect_jobs but for the CI/replay half of the hero loop. Unlike
-- bisect_jobs (which shipped Week 10 without it and keeps the Day-2 log-prefix
-- convention), ci_runs is a NEW table, so 'needs_runner' is a first-class
-- status in its CHECK from the start — the dashboard renders it directly
-- instead of a fake spinner when no host runner is available.
--
--   passed / total  -- invariant pass counts, parsed from the CLI's JUnit XML
--                      (<testsuites tests=total failures=...>). NULL until done.
--   junit_xml       -- raw JUnit XML the CLI wrote (NULL until done).
--   log             -- human-readable log incl. the copy-paste command on
--                      needs_runner.
--
-- D24: one statement per migration file. A single CREATE TABLE is one
-- statement. IF NOT EXISTS keeps it idempotent on a volume that already ran it.
CREATE TABLE IF NOT EXISTS ci_runs (
    id           UUID PRIMARY KEY,
    fixture_id   UUID REFERENCES fixtures(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'needs_runner')),
    passed       INTEGER,
    total        INTEGER,
    junit_xml    TEXT,
    log          TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

-- migrate:down
DROP TABLE IF EXISTS ci_runs;
