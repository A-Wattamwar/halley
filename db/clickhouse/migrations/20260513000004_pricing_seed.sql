-- migrate:up
-- Seed rows for halley.pricing_versions.
-- All cost columns are 0.000000 placeholders.
-- TODO: verify and replace all cost values before any cost query is trusted.
--
-- pricing_version_id 00000000-0000-0000-0000-000000000001 is the
-- "Week 1 dev" version referenced by ingester/fixtures/hello-span.json.
--
-- NOTE: dbmate's ClickHouse driver sends each migration as a single
-- statement. DDL and DML must be in separate files. See DECISIONS.md D24.

INSERT INTO halley.pricing_versions
    (pricing_version_id, model, provider,
     input_cost_per_mtok, output_cost_per_mtok, cached_input_cost_per_mtok,
     effective_from)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'gpt-4o',           'openai',    0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'gpt-4o-mini',      'openai',    0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'claude-opus-4-5',  'anthropic', 0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'claude-sonnet-4-5','anthropic', 0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'claude-haiku-4-5', 'anthropic', 0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'gemini-2-5-pro',   'google',    0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'gemini-2-5-flash', 'google',    0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00')

-- migrate:down
-- No-op: ReplacingMergeTree dedup means re-inserting is safe.
-- Deleting seed rows is not critical for rollback.
