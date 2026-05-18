-- migrate:up
-- Replace Phase 1 placeholder zero pricing with real OpenAI values.
--
-- Pattern (see DECISIONS.md D42):
--   Reuse pricing_version_id 00000000-0000-0000-0000-000000000001 with a
--   later effective_from timestamp. ReplacingMergeTree(effective_from) keeps
--   the row with the highest effective_from per (pricing_version_id, model).
--   After background merge, the placeholder zeros are superseded.
--
--   All existing observations rows reference this UUID, so they automatically
--   pick up real prices on the next read-time cost computation — no backfill.
--
-- Dedup timing: use `SELECT ... FINAL` for the canonical view immediately
-- after migration; background merge may take a few minutes.
--
-- Prices verified against https://openai.com/api/pricing on 2026-05-15:
--   gpt-4o-mini: $0.150 input / $0.600 output / $0.075 cached input per 1M tokens
--   gpt-4o:      $2.500 input / $10.000 output / $1.250 cached input per 1M tokens
--
-- NOTE: dbmate's ClickHouse driver sends each migration as a single statement.
-- DDL and DML must be in separate files (DECISIONS.md D24).

INSERT INTO halley.pricing_versions
    (pricing_version_id, model, provider,
     input_cost_per_mtok, output_cost_per_mtok, cached_input_cost_per_mtok,
     effective_from)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'gpt-4o-mini', 'openai', 0.150000, 0.600000, 0.075000, '2026-05-15 00:00:00'),
    ('00000000-0000-0000-0000-000000000001', 'gpt-4o',      'openai', 2.500000, 10.000000, 1.250000, '2026-05-15 00:00:00')

-- migrate:down
-- No-op: cannot safely un-replace ReplacingMergeTree rows without a full
-- table mutation. The placeholder zeros from the original seed remain in
-- storage until merge; they are not queryable once superseded.
-- To restore zeros, re-insert the Phase 1 seed rows with a later timestamp.
