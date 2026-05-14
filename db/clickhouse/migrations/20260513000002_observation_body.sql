-- migrate:up
-- halley.observation_body
-- Content-addressed body store. One row per unique payload.
-- Bodies are deduplicated by SHA-256 hash; the same payload appearing
-- across 10,000 runs stores exactly once. See ARCHITECTURE §4.1.
--
-- body_hash is FixedString(32): 32 raw bytes of the SHA-256 digest.
-- The ingester inserts raw bytes; hex() in queries re-encodes for display.
--
-- ReplacingMergeTree on first_seen_at: if the same hash is inserted
-- twice (e.g. after a writer restart), the row with the earlier
-- first_seen_at wins on background merge. Dedup is eventual — do not
-- assert exact row counts immediately after insert in tests; use FINAL
-- or accept that duplicates collapse on merge. See pitfalls in
-- docs/plan/phase-1-week-1.md.

CREATE TABLE IF NOT EXISTS halley.observation_body
(
    body_hash       FixedString(32),
    body            String CODEC(ZSTD(3)),
    content_type    LowCardinality(String),   -- "application/json", "text/plain"
    byte_size       UInt32,
    first_seen_at   DateTime64(6, 'UTC'),
    project_id      UUID
)
ENGINE = ReplacingMergeTree(first_seen_at)
ORDER BY (project_id, body_hash)
TTL toDateTime(first_seen_at) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- migrate:down
DROP TABLE IF EXISTS halley.observation_body;
