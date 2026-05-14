-- migrate:up
-- bisect_jobs
-- Tracks a binary-search job that finds the commit that broke a fixture.
-- See ARCHITECTURE §3.8 (halley bisect) and §5.5.

CREATE TABLE IF NOT EXISTS bisect_jobs (
    id              UUID PRIMARY KEY,
    fixture_id      UUID REFERENCES fixtures(id) ON DELETE CASCADE,
    base_commit     TEXT,
    head_commit     TEXT,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    result_commit   TEXT,
    log             TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

-- migrate:down
DROP TABLE IF EXISTS bisect_jobs;
