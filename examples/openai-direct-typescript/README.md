# OpenAI Direct TypeScript — OpenInference example

Minimal Node.js TypeScript app demonstrating OpenInference auto-instrumentation
with Halley. Every OpenAI call emits OTLP spans to Halley's ingester, landing
as `source_dialect = "openinference"` in ClickHouse.

This completes the three distinct dialect paths across the Week 5 example apps:

| Example | Instrumentation | `source_dialect` |
|---|---|---|
| `reasoning-agent-python/` | Traceloop 0.60 (OTEL GenAI semconv) | `otel-genai` |
| `vercel-ai-app/` | Vercel AI SDK native telemetry | `vercel-ai` |
| `openai-direct-typescript/` | OpenInference auto-instrumentation | `openinference` |

## How it works

`@arizeai/openinference-instrumentation-openai` patches the `openai` module at
startup and wraps every `chat.completions.create()` call with an OTEL span.
Spans carry `openinference.*` and `llm.*` attributes — Halley's openinference
adapter detects these and normalises them into the canonical schema.

## Prerequisites

- Node 20+
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Setup

```bash
cd examples/openai-direct-typescript

# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env
# Edit .env: set OPENAI_API_KEY

# Run
npm start
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | Your OpenAI API key |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4318/v1/traces` | Full OTLP/HTTP traces URL for Halley's ingester |

## Verify traces landed

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT count() FROM halley.observations WHERE source_dialect = 'openinference'"
```

For more detail:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens,
                  start_time
           FROM halley.observations
           WHERE source_dialect = 'openinference'
           ORDER BY start_time DESC
           LIMIT 5"
```

Expected: `source_dialect = 'openinference'`, `gen_ai_request_model = 'gpt-4o-mini-...'`
(OpenInference captures the resolved model snapshot name), non-zero token counts.

## What spans look like

Each `chat.completions.create()` call produces one span with:

- `openinference.span.kind = "LLM"` — detected by Halley's openinference adapter
- `llm.model_name` — the model used
- `llm.token_count.prompt` / `llm.token_count.completion` — token counts
- `llm.input_messages.*` / `llm.output_messages.*` — full prompt and response
- `llm.invocation_parameters` — model parameters as JSON
- `llm.provider = "openai"`

## Implementation note: require() for openai

The `openai` module is loaded via `require()` rather than a static `import`
statement. This is intentional.

TypeScript `import` statements are hoisted to the top of the compiled output,
which means `openai` would be loaded before `sdk.start()` runs. The
OpenInference instrumentation patches the `openai` module at startup via Node's
`require` hooks — if `openai` is already loaded when the patch runs, the
instrumentation has no effect and no spans are emitted.

Using `require()` after `sdk.start()` guarantees the patch is applied before
the module is first loaded. This is a standard pattern for OTEL auto-instrumentation
in Node.js CJS environments.

## Project structure

```
src/index.ts        # Main script: OTEL init, OpenInference registration, 4 OpenAI calls
.env.example        # Environment variable template
package.json        # Dependencies and run script
tsconfig.json       # TypeScript config
```
