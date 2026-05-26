-- migrate:up
-- Phase 4 Day 2: seed the dev user ayush@halley.dev.
--
-- Password: "halley-dev-2026" (bcrypt, cost factor 12).
-- User ID is fixed so foreign keys and session tokens are stable across
-- compose restarts without volume removal.
--
-- Also backfills projects.owner_id (nullable per D6) to link dev-local
-- to this user, satisfying the D6 note: "when auth lands we will either
-- backfill owners or flip to NOT NULL in a new migration."
-- We backfill here; the column stays nullable for future projects that
-- might be seeded before their owner is created.
--
-- ON CONFLICT DO NOTHING makes both statements idempotent.

INSERT INTO users (id, email, password_hash, created_at)
VALUES (
    'a2c7a9a8-2e1b-4d1a-9f0b-000000000002',
    'ayush@halley.dev',
    '$2b$12$sp7klVx7cIqozJjE6HBAROGhR7V2PpvDf5FEWg3RR5QGwe6gu0jxW',
    now()
)
ON CONFLICT (id) DO NOTHING;

-- Backfill owner on the dev-local project (created in 20260513000006_dev_seed.sql).
UPDATE projects
SET owner_id = 'a2c7a9a8-2e1b-4d1a-9f0b-000000000002'
WHERE id = 'a2c7a9a8-2e1b-4d1a-9f0b-000000000001'
  AND owner_id IS NULL;

-- migrate:down
UPDATE projects SET owner_id = NULL WHERE id = 'a2c7a9a8-2e1b-4d1a-9f0b-000000000001';
DELETE FROM users WHERE id = 'a2c7a9a8-2e1b-4d1a-9f0b-000000000002';
