-- migrate:up
-- Phase 4 Day 3: extend api_keys with the columns needed for the key
-- management UI (phase-4-overview.md Day 3).
--
-- The Week 2 skeleton (20260513000003_api_keys.sql) already has:
--   id, project_id, key_hash, label, last_used_at, created_at
--
-- We ADD the columns required by Day 3:
--   prefix     -- the first 12 chars of the raw key (hlly_ + 7 chars),
--                 stored in clear for display. Never enough to authenticate.
--   name       -- human-readable label (replaces the older "label" column;
--                 both coexist; UI uses "name", ingester auth uses "key_hash").
--   revoked_at -- NULL while active; set to now() on revoke. Revoked keys
--                 are rejected by the ingester even if hash matches.
--
-- All ADD COLUMN IF NOT EXISTS so the migration is idempotent on a volume
-- that already ran the Week 2 skeleton.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS prefix     TEXT,
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Index to make "list active keys for a project" fast (used by /settings/keys).
CREATE INDEX IF NOT EXISTS api_keys_project_active
  ON api_keys (project_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- migrate:down
DROP INDEX IF EXISTS api_keys_project_active;
ALTER TABLE api_keys
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS prefix;
