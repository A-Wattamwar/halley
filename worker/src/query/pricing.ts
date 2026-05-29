/**
 * query/pricing.ts — fetch pricing data and compute run cost.
 *
 * Mirrors dashboard/src/lib/halley-query/pricing.ts exactly (D42 pattern).
 * Kept as a separate worker-side module so the worker never imports from the
 * Next.js dashboard package tree.
 *
 * Cost formula (D42):
 *   (input_tokens  * input_cost_per_mtok  / 1_000_000)
 * + (output_tokens * output_cost_per_mtok / 1_000_000)
 *
 * D-12: all ClickHouse queries go through a query module.
 */

import { getClickHouseClient } from "../connections.js";

export interface PricingRow {
  model: string;
  input_cost_per_mtok: number;
  output_cost_per_mtok: number;
}

/**
 * Fetches the latest effective pricing row for every model.
 * Uses FINAL to force ReplacingMergeTree dedup (D42).
 * Returns a Map<model, PricingRow> for O(1) per-span lookup.
 */
export async function fetchPricingMap(): Promise<Map<string, PricingRow>> {
  const ch = getClickHouseClient();
  try {
    const result = await ch.query({
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
    await ch.close();
  }
}

/**
 * Compute dollar cost for one span using the same formula as the dashboard (D42).
 * Returns 0 when no pricing row exists for the model.
 */
export function computeSpanCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricingMap: Map<string, PricingRow>
): number {
  const p = pricingMap.get(model);
  if (!p) return 0;
  return (
    (inputTokens  * p.input_cost_per_mtok)  / 1_000_000 +
    (outputTokens * p.output_cost_per_mtok) / 1_000_000
  );
}
