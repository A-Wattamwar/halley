-- fixtures
-- Metadata pointer to a fixture stored in the user's repo.
-- The actual cassette bodies live under halley/fixtures/<slug>/bodies/
-- in the user's git repo; this row holds the pointer and invariant
-- definitions. See ARCHITECTURE §4.2 and §3.7.

CREATE TABLE IF NOT EXISTS fixtures (
    id              UUID PRIMARY KEY,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    source_run_id   TEXT NOT NULL,
    repo_path       TEXT NOT NULL,
    invariants_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL CHECK (status IN ('proposing', 'ready', 'stale')),
    last_replay_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);
