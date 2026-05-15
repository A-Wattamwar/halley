-- migrate:up
ALTER TABLE halley.observations
  ADD COLUMN IF NOT EXISTS is_run_root Bool DEFAULT false;

-- migrate:down
ALTER TABLE halley.observations DROP COLUMN IF EXISTS is_run_root;
