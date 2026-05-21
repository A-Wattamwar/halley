/**
 * halley-query/pricing.ts
 *
 * Fetches the latest pricing row per model from halley.pricing_versions
 * and exposes a pure read-time cost computation function.
 *
 * Cost formula (D42 pattern):
 *   (input_tokens  * input_cost_per_mtok  / 1_000_000)
 * + (output_tokens * output_cost_per_mtok / 1_000_000)
 *
 * pricing_versions uses ReplacingMergeTree(effective_from), so we always
 * query with FINAL to get the deduplicated view.
 *
 * D-12: no inline ClickHouse client calls in page files — all queries here.
 */

import { getClickHouseClient } from "@/lib/clickhouse";

export interface PricingRow {
  model: string;
  input_cost_per_mtok: number;
  output_cost_per_mtok: number;
}

/**
 * Fetches the latest effective pricing row for every model in the table.
 * Returns a Map<model, PricingRow> for O(1) per-run lookup.
 *
 * Uses FINAL to force ReplacingMergeTree dedup at query time (D42).
 */
export async function fetchPricingMap(): Promise<Map<string, PricingRow>> {
  const client = getClickHouseClient();
  try {
    const result = await client.query({
      query: `
        SELECT
          model,
          toFloat64(input_cost_per_mtok)  AS input_cost_per_mtok,
          toFloat64(output_cost_per_mtok) AS output_cost_per_mtok
        FROM halley.pricing_versions FINAL
        ORDER BY model, effective_from DESC
      `,
      format: "JSONEachRow",
    });

    const rows = await result.json<PricingRow>();
    const map = new Map<string, PricingRow>();
    // Rows arrive ordered by (model, effective_from DESC); first row per model wins.
    for (const row of rows) {
      if (!map.has(row.model)) {
        map.set(row.model, row);
      }
    }
    return map;
  } finally {
    await client.close();
  }
}

/**
 * Computes the read-time dollar cost for a run.
 *
 * Looks up pricing by model. If no pricing row exists for the model,
 * cost is 0 (prevents crashes on unknown/new models).
 *
 * Display convention (per Week 6 plan):
 *   - < $1.00  → 4 decimal places  ($0.0001)
 *   - ≥ $1.00  → 2 decimal places  ($1.23)
 */
export function computeRunCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricingMap: Map<string, PricingRow>
): number {
  const pricing = pricingMap.get(model);
  if (!pricing) return 0;

  return (
    (inputTokens * pricing.input_cost_per_mtok) / 1_000_000 +
    (outputTokens * pricing.output_cost_per_mtok) / 1_000_000
  );
}

/**
 * Format a dollar cost for display.
 * < $1.00  → "$0.0001" (4 decimals)
 * ≥ $1.00  → "$1.23"   (2 decimals)
 */
export function formatCost(dollars: number): string {
  if (dollars === 0) return "$0.0000";
  if (dollars < 1) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}
