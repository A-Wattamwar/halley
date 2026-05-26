-- migrate:up
-- Auth.js v4 Postgres adapter tables (Phase 4 Day 1).
--
-- The `users` table already exists from Week 2 Day 1 (20260513000001_users.sql)
-- with: id UUID, email TEXT, password_hash TEXT, created_at TIMESTAMPTZ.
--
-- Auth.js pg-adapter additionally expects:
--   users.email_verified TIMESTAMPTZ
--   users.image TEXT
-- and three new tables: accounts, sessions, verification_tokens.
--
-- We do NOT drop or recreate users — we add the two missing columns.
-- CredentialsProvider (D-14): we never use OAuth, so accounts + verification_tokens
-- will be empty in practice but are required by the adapter at startup.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS image          TEXT;

-- accounts: OAuth provider accounts linked to a user.
-- Required by the adapter even though we only use CredentialsProvider (D-14).
CREATE TABLE IF NOT EXISTS accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                 TEXT NOT NULL,
    provider             TEXT NOT NULL,
    "providerAccountId"  TEXT NOT NULL,
    refresh_token        TEXT,
    access_token         TEXT,
    expires_at           BIGINT,
    token_type           TEXT,
    scope                TEXT,
    id_token             TEXT,
    session_state        TEXT,
    UNIQUE(provider, "providerAccountId")
);

-- sessions: server-side session records.
CREATE TABLE IF NOT EXISTS sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionToken" TEXT NOT NULL UNIQUE,
    "userId"       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires        TIMESTAMPTZ NOT NULL
);

-- verification_tokens: email verification / magic-link tokens.
CREATE TABLE IF NOT EXISTS verification_tokens (
    identifier TEXT NOT NULL,
    token      TEXT NOT NULL,
    expires    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (identifier, token)
);

-- migrate:down
DROP TABLE IF EXISTS verification_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE users DROP COLUMN IF EXISTS image;
