# Vercel AI SDK — Next.js example

Minimal Next.js 14 app demonstrating Vercel AI SDK telemetry with Halley.
Every `generateText` call emits OTLP spans to Halley's ingester, landing as
`source_dialect = "vercel-ai"` in ClickHouse.

## How it works

The Vercel AI SDK has built-in OpenTelemetry support via `experimental_telemetry`.
Two things are required:

1. A running OTEL `NodeSDK` with an OTLP exporter pointed at Halley — wired in
   `instrumentation.ts`, which Next.js loads automatically on server startup.
2. `experimental_telemetry: { isEnabled: true }` on every AI SDK call — in
   `src/app/actions.ts`.

Without `isEnabled: true` on the call, no spans are emitted. This is the most
common "where are my traces" mistake.

## Prerequisites

- Node 20+
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Setup

```bash
cd examples/vercel-ai-app

# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env.local
# Edit .env.local: set OPENAI_API_KEY

# Start the dev server
npm run dev
# App runs at http://localhost:3001 (3000 is taken by the Halley dashboard)
```

Then open `http://localhost:3001`, pick a question, and click **Ask (emits trace)**.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | Your OpenAI API key |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4318/v1/traces` | Full OTLP/HTTP traces URL for Halley's ingester |

## Verify traces landed

After clicking the button, check ClickHouse:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT count() FROM halley.observations WHERE source_dialect = 'vercel-ai'"
```

For more detail:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens,
                  start_time
           FROM halley.observations
           WHERE source_dialect = 'vercel-ai'
           ORDER BY start_time DESC
           LIMIT 5"
```

Expected: `source_dialect = 'vercel-ai'`, `gen_ai_request_model = 'gpt-4o-mini'`.

## Standalone test script (no browser needed)

```bash
OPENAI_API_KEY=sk-... \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces \
node scripts/test-trace.mjs
```

This initialises the OTEL SDK directly and calls `generateText` once, then
shuts down cleanly (flushing all spans before exit).

## What spans look like

Each `generateText` call produces two spans:

- **Outer span** (`ai.generateText`): operation-level span. Token counts are in
  `ai.usage.*` attributes (Vercel AI SDK native). `gen_ai_usage_*` columns are 0
  on this span — that's expected.
- **Inner span** (`ai.generateText.doGenerate`): provider-level span. Has both
  `ai.usage.*` and `gen_ai.usage.*` attributes. `gen_ai_usage_input_tokens` and
  `gen_ai_usage_output_tokens` are non-zero here.

Both spans have `source_dialect = "vercel-ai"` because the outer span carries
`ai.operationId`, which Halley's vercel-ai adapter detects.

## Build

```bash
npm run build
```

Build is clean with no TypeScript errors.

## Project structure

```
instrumentation.ts          # OTEL NodeSDK init — loaded by Next.js on startup
next.config.mjs             # instrumentationHook: true (required for Next.js 14)
src/app/
  layout.tsx                # Minimal HTML shell
  page.tsx                  # Client component with question form
  actions.ts                # Server action: generateText with telemetry
scripts/
  test-trace.mjs            # Standalone test script (no browser needed)
.env.example                # Environment variable template
```
