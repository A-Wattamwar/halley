/**
 * query/bodies.ts — load body content from halley.observation_body.
 *
 * D-12: all ClickHouse queries go through a query module.
 * D-50: WHERE clause uses table-qualified hex(observation_body.body_hash)
 *       to prevent alias-shadowing with ClickHouse 24.8's new query analyzer.
 *
 * Mirrors the body-fetch logic in dashboard/src/lib/halley-query/detail.ts
 * (query 2 of getSpanDetail). Key differences: the worker may need more than
 * 4 body slots (one per span in a multi-span run), so we build the IN clause
 * dynamically from the unique non-empty hashes.
 */

import { getClickHouseClient } from "../connections.js";

/**
 * Fetch body text for all given 64-char uppercase hex body hashes.
 *
 * Returns a Map<hash, body_text>. Missing hashes (expired / never captured)
 * are simply absent from the map.
 *
 * @param hashes - Array of 64-char uppercase hex strings (may contain "").
 *                 Empty strings are filtered out before the query.
 */
export async function loadBodies(
  hashes: string[]
): Promise<Map<string, string>> {
  // Deduplicate and remove blanks (spans with no body).
  const unique = [...new Set(hashes.filter((h) => h.length > 0))];
  if (unique.length === 0) return new Map();

  const ch = getClickHouseClient();
  try {
    // Build a fixed-length IN clause matching the dashboard's table-qualified
    // pattern (D50). ClickHouse named params must be compile-time identifiers,
    // so we expand them dynamically: {h0: String}, {h1: String}, ...
    const placeholders = unique.map((_, i) => `{h${i}: String}`).join(", ");
    const params = Object.fromEntries(
      unique.map((h, i) => [`h${i}`, h.toUpperCase()])
    );

    const result = await ch.query({
      query: `
        SELECT
          hex(observation_body.body_hash) AS body_hash,
          body
        FROM halley.observation_body
        WHERE hex(observation_body.body_hash) IN (${placeholders})
      `,
      query_params: params,
      format: "JSONEachRow",
    });

    const rows = await result.json<{ body_hash: string; body: string }>();
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.body_hash.toUpperCase(), row.body);
    }
    return map;
  } finally {
    await ch.close();
  }
}
