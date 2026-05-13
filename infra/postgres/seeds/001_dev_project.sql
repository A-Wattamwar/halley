-- Dev seed: a local development project.
-- This row is referenced by ingester/fixtures/hello-span.json
-- (project_id = a2c7a9a8-2e1b-4d1a-9f0b-000000000001).
--
-- owner_id is NULL because the users table is empty in Week 1 and
-- owner_id is nullable per 002_projects.sql. See docs/DECISIONS.md D6.
--
-- ON CONFLICT DO NOTHING makes this idempotent: running it twice
-- (e.g. after a compose restart without volume removal) is safe.

INSERT INTO projects (id, name, slug, owner_id, created_at)
VALUES (
    'a2c7a9a8-2e1b-4d1a-9f0b-000000000001',
    'dev-local',
    'dev-local',
    NULL,
    now()
)
ON CONFLICT (id) DO NOTHING;
