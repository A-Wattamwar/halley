-- halley.observations
-- One row per span / observation. Wide, denormalized, run attributes
-- materialized per row. See ARCHITECTURE §4.1 for the full rationale.
--
-- ID columns use FixedString(16) / FixedString(8) to match OTLP wire
-- sizes (16-byte trace id, 8-byte span id). The ingester decodes the
-- incoming hex strings to raw bytes before inserting. Do NOT use UUID
-- here — UUID is 16 bytes but ClickHouse stores it differently and the
-- hex() function would return a different encoding. See DECISIONS.md D2
-- and the pitfalls section of docs/plan/phase-1-week-1.md.

CREATE TABLE IF NOT EXISTS halley.observations
(
    -- Identity
    trace_id            FixedString(16),
    span_id             FixedString(8),
    parent_span_id      Nullable(FixedString(8)),
    run_id              FixedString(16),
    project_id          UUID,

    -- Timing
    start_time          DateTime64(9, 'UTC'),
    end_time            DateTime64(9, 'UTC'),
    duration_ms         UInt32 MATERIALIZED dateDiff('millisecond', start_time, end_time),

    -- Normalization
    source_dialect      LowCardinality(String),   -- "halley-raw", "otel-genai", "openllmetry", …
    dialect_version     LowCardinality(String),

    -- Canonical GenAI fields
    gen_ai_system                   LowCardinality(String),
    gen_ai_operation                LowCardinality(String),   -- "chat", "embeddings", "execute_tool", …
    gen_ai_request_model            LowCardinality(String),
    gen_ai_response_model           LowCardinality(String),
    gen_ai_usage_input_tokens       UInt32,
    gen_ai_usage_output_tokens      UInt32,
    gen_ai_response_finish_reason   LowCardinality(String),

    -- Cassette body references (SHA-256 of canonical JSON body, 32 raw bytes)
    -- Stored in halley.observation_body keyed by body_hash.
    input_body_hash     Nullable(FixedString(32)),
    output_body_hash    Nullable(FixedString(32)),
    tool_input_hash     Nullable(FixedString(32)),
    tool_output_hash    Nullable(FixedString(32)),
    tool_name           LowCardinality(String),
    tool_side_effect    LowCardinality(String),   -- "pure" | "idempotent" | "irreversible" | "unknown"

    -- Run-level attributes materialized per row (single-table query pattern)
    run_name            LowCardinality(String),
    run_tags            Array(String),
    run_env             LowCardinality(String),

    -- Pricing and status
    pricing_version_id  UUID,
    status              Enum8('ok' = 1, 'error' = 2, 'timeout' = 3),
    error_message       String,

    -- Free-form attributes: unknown keys from any dialect land here verbatim
    attributes          Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, run_id, start_time, span_id)
TTL toDateTime(start_time) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
