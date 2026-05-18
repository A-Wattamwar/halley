# Quickstart — TypeScript / Node.js (OpenInference)

Get your Node.js AI app emitting traces into Halley in under 5 minutes.

## Prerequisites

- Node 20+
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Install

```bash
npm install openai \
  @arizeai/openinference-instrumentation-openai \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http
```

## Setup (~15 lines)

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";

// 1. Start the OTEL SDK with OpenInference instrumentation FIRST.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
  }),
  instrumentations: [new OpenAIInstrumentation()],
});
sdk.start();

// 2. Load openai with require() AFTER sdk.start().
//    Static `import OpenAI from "openai"` is hoisted before sdk.start() runs,
//    which means the instrumentation patch never applies. require() is not hoisted.
const OpenAI = require("openai").default;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3. Your existing OpenAI code is now auto-instrumented.
async function main() {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  });
  console.log(response.choices[0].message.content);

  // Flush spans before process exits.
  await sdk.shutdown();
}

main();
```

Run with:

```bash
OPENAI_API_KEY=sk-... \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces \
npx tsx src/index.ts
```

## Why `require()` instead of `import`?

TypeScript `import` statements are hoisted to the top of the compiled output.
This means `openai` is loaded before `sdk.start()` runs, so the OpenInference
instrumentation patch never applies — and no spans are emitted.

Using `require("openai")` after `sdk.start()` guarantees the patch is in place
before the module loads. This is the standard pattern for OTEL auto-instrumentation
in Node.js CJS environments.

If you use a bundler (webpack, esbuild) that converts imports to requires, the
hoisting issue may not apply — but `require()` is always safe.

## Verify it worked

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens
           FROM halley.observations
           WHERE source_dialect = 'openinference'
           ORDER BY start_time DESC
           LIMIT 5"
```

Expected output:
```
openinference    gpt-4o-mini-2024-07-18    <input_tokens>    <output_tokens>
```

Note: OpenInference captures the resolved model snapshot name (e.g.
`gpt-4o-mini-2024-07-18`) rather than the alias (`gpt-4o-mini`).

## Troubleshooting

**No spans in ClickHouse:**
- Confirm you're using `require("openai")` after `sdk.start()`, not a static
  `import`. This is the most common mistake.
- Check `OTEL_EXPORTER_OTLP_ENDPOINT` ends with `/v1/traces` (the full path,
  not just the base URL).
- Call `await sdk.shutdown()` before the process exits to flush pending spans.

**`source_dialect = "otel-genai"` instead of `"openinference"`:**
- The OpenInference instrumentation is not patching the openai module. See the
  `require()` note above.

## Fuller example

See [`examples/openai-direct-typescript/`](../../examples/openai-direct-typescript/)
for a complete working example with 4 OpenAI calls, clean shutdown, and
verification instructions.
