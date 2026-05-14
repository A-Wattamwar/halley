-- migrate:up
-- halley.pricing_versions
-- Versioned pricing table. Cost is computed at READ TIME, not write time.
-- Each observation row stores a pricing_version_id; cost queries join
-- here to get the per-token rates. This lets us recompute historical
-- cost when a provider changes prices. See ARCHITECTURE §4.1 and §6.8.

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

-- migrate:down
DROP TABLE IF EXISTS halley.pricing_versions;
