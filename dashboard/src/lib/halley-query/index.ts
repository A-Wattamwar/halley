/**
 * halley-query — single entry point for all ClickHouse query functions.
 *
 * Consumers import from "@/lib/halley-query", never from the sub-modules
 * directly. This gives us one place to add auth checks (Phase 4).
 *
 * D-12: all ClickHouse queries go through this module. No inline client
 * calls in page files.
 */

export { listRuns } from "./runs";
export type { RunSummary, ListRunsParams } from "./runs";

export { fetchPricingMap, computeRunCost, formatCost } from "./pricing";
export type { PricingRow } from "./pricing";

export { getRunDetail, getSpanDetail, ROOT_PARENT_ID } from "./detail";
export type { SpanSummary, RunDetail, SpanDetail } from "./detail";
