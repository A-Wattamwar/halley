# Vercel AI SDK Telemetry Setup — Research Notes

Date: 2026-05-15
Sources:
- https://sdk.vercel.ai/docs/ai-sdk-core/telemetry
- https://signoz.io/docs/vercel-ai-sdk-observability/
- https://openobserve.ai/docs/integration/ai/frameworks/vercel-ai-sdk/
- https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/integrations/vercelai/

---

## How it works

Vercel AI SDK has built-in OpenTelemetry support via `experimental_telemetry`.
No separate instrumentation package is needed for the AI SDK itself. You wire
up a standard OTEL `NodeSDK` and every AI SDK call is automatically traced.

Two things required:
1. A running OTEL `NodeSDK` with an OTLP exporter pointed at Halley.
2. `experimental_telemetry: { isEnabled: true }` on every AI SDK call.

---

## Install

```bash
npm install ai @ai-sdk/openai \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/auto-instrumentations-node
```

---

## Next.js 14 setup: `instrumentation.ts`

Place at the project root (Next.js 14+ picks it up automatically via the
`instrumentationHook` experimental flag, or natively in Next.js 15+):

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
          'http://localhost:4318/v1/traces',
      }),
    });
    sdk.start();
  }
}
```

**Note:** Use `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTEL env var) rather than
a custom `HALLEY_OTLP_ENDPOINT`. The standard var is recognized by the OTEL SDK
directly; the custom var requires explicit wiring. Either works — just be
consistent in `.env.example`.

---

## Per-call opt-in

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: openai('gpt-4o-mini'),
  prompt: 'What is the capital of France?',
  experimental_telemetry: { isEnabled: true },
});
```

**Critical:** Without `experimental_telemetry: { isEnabled: true }`, NO spans
are emitted. This is the most common "where are my traces" mistake (plan pitfall #2).

---

## What attributes it emits

Vercel AI SDK v6 emits `ai.*` attributes (our adapter detects these):
- `ai.operationId` — `"ai.generateText"`, `"ai.streamText"`, etc.
- `ai.model.id` — `"gpt-4o-mini"`
- `ai.model.provider` — `"openai.chat"`
- `ai.usage.promptTokens` / `ai.usage.completionTokens`
- `ai.prompt` / `ai.response.text` (when content capture is on)

On inner `doGenerate`/`doStream` spans, also emits `gen_ai.*` attributes.
Our adapter detects `ai.operationId` → `source_dialect = "vercel-ai"`. ✓

---

## next.config.mjs for instrumentation hook

For Next.js 14 (before 15 where it's native):

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
```

Next.js 15+ does not need this flag — `instrumentation.ts` is picked up natively.
Check the installed Next.js version at Day 3 runtime.

---

## Verifying traces landed

```sql
SELECT source_dialect, gen_ai_request_model, gen_ai_usage_input_tokens
FROM halley.observations
WHERE source_dialect = 'vercel-ai'
ORDER BY start_time DESC
LIMIT 10;
```

Expected: `source_dialect = 'vercel-ai'`, `gen_ai_request_model = 'gpt-4o-mini'`.
