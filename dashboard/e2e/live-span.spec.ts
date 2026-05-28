/**
 * E2E: core live-span path.
 *
 * 1. POST a span to the ingester (/v1/spans/json halley-raw endpoint) with a
 *    unique run_id/span_id so assertions are deterministic.
 * 2. Open /?range=1h and poll until the new run row appears (≤ 5 s).
 * 3. Click the run → assert the timeline shows 1 span and the inspector
 *    opens with the span's data when a span bar is clicked.
 *
 * Requires HALLEY_AUTH_REQUIRED=false (the default in .env / Docker stack).
 * No login is performed.
 */

import { test, expect } from "@playwright/test";

const INGESTER_URL = process.env.INGESTER_URL ?? "http://localhost:4318";
const PROJECT_ID   = "a2c7a9a8-2e1b-4d1a-9f0b-000000000001";

test("span appears in dashboard and inspector opens", async ({ page, request }) => {
  // ── Unique IDs so this test run is deterministic and collision-free ──────
  const ts      = Date.now();
  // trace_id = 32-char hex; run_name encodes the timestamp for easy lookup.
  const traceId = `e2e${ts.toString(16).padStart(29, "0")}`.slice(0, 32);
  const spanId  = ts.toString(16).padStart(16, "0");
  const runName = `e2e-${ts}`;

  // Nanosecond timestamps (current time ± 1 500 ms).
  // float64 precision loss at this magnitude is < 1 ms — fine for filtering.
  const startNs = ts * 1_000_000;
  const endNs   = (ts + 1_500) * 1_000_000;

  // ── 1. POST span to the halley-raw endpoint ──────────────────────────────
  const ingestResp = await request.post(`${INGESTER_URL}/v1/spans/json`, {
    data: {
      trace_id:                       traceId,
      span_id:                        spanId,
      parent_span_id:                 null,
      run_id:                         null,
      project_id:                     PROJECT_ID,
      start_time_unix_nano:           startNs,
      end_time_unix_nano:             endNs,
      source_dialect:                 "halley-raw",
      dialect_version:                "1",
      gen_ai_system:                  "openai",
      gen_ai_operation:               "chat",
      gen_ai_request_model:           "gpt-4o-mini",
      gen_ai_response_model:          "gpt-4o-mini-2024-07-18",
      gen_ai_usage_input_tokens:      5,
      gen_ai_usage_output_tokens:     10,
      gen_ai_response_finish_reason:  "stop",
      input_body:  { messages: [{ role: "user", content: "e2e-playwright-test" }] },
      output_body: { content: "e2e-playwright-response" },
      tool_name:         "",
      tool_input:        null,
      tool_output:       null,
      tool_side_effect:  "unknown",
      run_name:          runName,
      run_tags:          [],
      run_env:           "local",
      pricing_version_id: "00000000-0000-0000-0000-000000000001",
      status:            "ok",
      error_message:     "",
      attributes:        {},
    },
  });
  expect(ingestResp.ok()).toBeTruthy();

  // ── 2. Poll /?range=all until the run row appears ────────────────────────
  // The page is force-dynamic (SSR); each goto fetches fresh ClickHouse data.
  // We use ?range=all to eliminate timestamp-precision sensitivity on the ns
  // start_time field.  The ingester→Redis→writer pipeline completes in ~200 ms,
  // but Docker SSR responses can take ~800 ms each, so we budget 12 s total.
  await page.waitForTimeout(1_500); // let the writer batch flush to ClickHouse
  await expect(async () => {
    await page.goto("/?range=all");
    await expect(page.getByText(runName)).toBeVisible({ timeout: 0 });
  }).toPass({ intervals: [500, 500, 500, 500, 500, 500, 500, 500], timeout: 12_000 });

  // ── 3. Click the run row → run detail page ───────────────────────────────
  await page.getByText(runName).click();
  await expect(page).toHaveURL(/\/runs\//);

  // ── 4. Assert the timeline shows the span ────────────────────────────────
  // The span row label includes the gen_ai_operation value ("chat").
  await expect(page.getByText("chat").first()).toBeVisible({ timeout: 5_000 });

  // ── 5. Click the span bar to open the inspector ──────────────────────────
  // SpanBarLink renders as <a href="/runs/[id]?span=[spanId]">.
  const spanBar = page.locator('a[href*="?span="]').first();
  await expect(spanBar).toBeVisible({ timeout: 5_000 });
  await spanBar.click();

  // Wait for the URL to reflect the ?span= param (App Router push is async).
  await expect(page).toHaveURL(/\?span=/, { timeout: 5_000 });

  // ── 6. Assert the inspector is populated ─────────────────────────────────
  // The inspector drawer shows the request model and the Identity section.
  await expect(page.getByText("gpt-4o-mini").first()).toBeVisible({ timeout: 5_000 });
  // Body sections appear when input_body / output_body are non-null.
  await expect(page.getByText("e2e-playwright-test")).toBeVisible({ timeout: 5_000 });
});
