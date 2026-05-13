-- halley.pricing_versions
-- Versioned pricing table. Cost is computed at READ TIME, not write time.
-- Each observation row stores a pricing_version_id; cost queries join
-- here to get the per-token rates. This lets us recompute historical
-- cost when a provider changes prices. See ARCHITECTURE §4.1 and §6.8.
--
-- ============================================================
-- IMPORTANT: Prices below are PLACEHOLDER ZEROS as of migration
-- authoring. Real prices must be loaded before any cost query is
-- trusted. See docs/DECISIONS.md for the rationale and the process
-- for updating these rows.
-- ============================================================
--
-- TODO: verify and replace all cost values before any cost query is trusted.
-- Models seeded: gpt-4o, gpt-4o-mini, claude-opus-4-5, claude-sonnet-4-5,
--   claude-haiku-4-5, gemini-2-5-pro, gemini-2-5-flash
-- pricing_version_id 00000000-0000-0000-0000-000000000001 is the
-- "Week 1 dev" version referenced by ingester/fixtures/hello-span.json.

CREATE TABLE IF NOT EXISTS halley.pricing_versions
(
    pricing_version_id          UUID,
    model                       LowCardinality(String),
    provider                    LowCardinality(String),
    input_cost_per_mtok         Decimal(12, 6),
    output_cost_per_mtok        Decimal(12, 6),
    cached_input_cost_per_mtok  Decimal(12, 6),
    effective_from              DateTime64(6, 'UTC')
)
ENGINE = ReplacingMergeTree(effective_from)
ORDER BY (pricing_version_id, model)
SETTINGS index_granularity = 8192;

-- Seed rows. All cost columns are 0.000000 placeholders.
-- Comments are outside the VALUES block to avoid ClickHouse parser issues.
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
    ('00000000-0000-0000-0000-000000000001', 'gemini-2-5-flash', 'google',    0.000000, 0.000000, 0.000000, '2026-05-01 00:00:00');
