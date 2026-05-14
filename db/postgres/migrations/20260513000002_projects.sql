-- migrate:up
-- projects
-- owner_id is nullable for Week 1. The dev seed row has no corresponding
-- user, and auth is not enforced until Phase 4. When auth lands we will
-- either backfill owners or flip this to NOT NULL in a new migration.
-- See docs/DECISIONS.md D6.

CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    owner_id    UUID REFERENCES users(id),   -- nullable: see D6 in DECISIONS.md
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS projects;
