-- migrate:up
-- api_keys
-- key_hash stores SHA-256 of the raw key; the raw key is shown once at
-- creation and never stored. Enforcement comes in Phase 4.

CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    key_hash        TEXT NOT NULL UNIQUE,
    label           TEXT,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS api_keys;
