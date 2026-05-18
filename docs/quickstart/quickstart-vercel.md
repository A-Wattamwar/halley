# Quickstart — Vercel AI SDK (Next.js)

Get your Next.js app emitting AI traces into Halley in under 10 minutes.

## Prerequisites

- Next.js 14+ (tested with 14.2.x)
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Install

```bash
npm install ai @ai-sdk/openai \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http
```

## Step 1: Enable the instrumentation hook

In `next.config.mjs` (Next.js 14 only — Next.js 15+ picks up `instrumentation.ts`
natively without this flag):

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
```

## Step 2: Add `instrumentation.ts` at the project root

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
          "http://localhost:4318/v1/traces",
      }),
    });

    sdk.start();
  }
}
```

Next.js calls `register()` once on server startup, before any request handlers.

## Step 3: Add `experimental_telemetry` to every AI SDK call

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// In a Server Component or Server Action:
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "What is the capital of France?",
  experimental_telemetry: {
    isEnabled: true,   // ← REQUIRED. Without this, no spans are emitted.
  },
});
```

**Critical:** `experimental_telemetry: { isEnabled: true }` must be set on
every call. It is opt-in per call, not globally. This is the most common
"where are my traces" mistake.

## Step 4: Set env vars and run

In `.env.local`:

```
OPENAI_API_KEY=sk-...
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

```bash
npm run dev
```

Make a request that triggers your AI call. Traces appear in Halley immediately.

## Verify it worked

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens
           FROM halley.observations
           WHERE source_dialect = 'vercel-ai'
           ORDER BY start_time DESC
           LIMIT 5"
```

Expected output:
```
vercel-ai    gpt-4o-mini    <input_tokens>    <output_tokens>
```

Each `generateText` call produces two spans:
- Outer span (`ai.generateText`): operation-level. Token counts in `ai.usage.*` attributes.
- Inner span (`ai.generateText.doGenerate`): provider-level. Token counts in both
  `ai.usage.*` and `gen_ai.usage.*` columns.

## Troubleshooting

**No spans in ClickHouse:**
- Confirm `experimental_telemetry: { isEnabled: true }` is on the call, not just
  the SDK init. This is opt-in per call.
- For Next.js 14, confirm `experimental.instrumentationHook: true` is in
  `next.config.mjs`.
- Check `OTEL_EXPORTER_OTLP_ENDPOINT` ends with `/v1/traces`.

**`source_dialect = "otel-genai"` instead of `"vercel-ai"`:**
- The Vercel AI SDK emits `ai.operationId` on spans, which Halley's vercel-ai
  adapter detects. If this attribute is missing, the span falls through to
  otel-genai. Confirm you're using `ai` package v4+ and `@ai-sdk/openai`.

**`instrumentationHook` warning in Next.js 15:**
- Remove the `experimental.instrumentationHook` flag. Next.js 15 picks up
  `instrumentation.ts` natively.

## Fuller example

See [`examples/vercel-ai-app/`](../../examples/vercel-ai-app/) for a complete
Next.js 14 app with a working page, server action, and standalone test script
that doesn't require a browser.
