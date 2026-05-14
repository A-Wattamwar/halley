-- migrate:up
-- users
-- Core identity table. Auth enforcement comes in Phase 4; the schema
-- is created now so Week 2 dashboard and Phase 3+ features can build on it.

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS users;
