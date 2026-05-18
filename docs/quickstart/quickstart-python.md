# Quickstart — Python (Traceloop / OpenLLMetry)

Get your Python AI app emitting traces into Halley in under 5 minutes.

## Prerequisites

- Python 3.10+
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Install

```bash
pip install traceloop-sdk openai
```

`traceloop-sdk` pulls in the OpenTelemetry SDK and the OpenAI auto-instrumentation
as transitive dependencies. No separate OTEL install needed.

## Setup (5 lines)

```python
import os
from traceloop.sdk import Traceloop

# Point Traceloop at Halley's OTLP/HTTP endpoint.
# The SDK appends /v1/traces automatically.
os.environ.setdefault("TRACELOOP_BASE_URL", "http://localhost:4318")

Traceloop.init(
    app_name="my-app",
    disable_batch=True,   # flush synchronously — required for short-lived scripts
)

# Your existing OpenAI code is now auto-instrumented.
from openai import OpenAI
client = OpenAI()
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

Or set the env var before running:

```bash
export TRACELOOP_BASE_URL=http://localhost:4318
export OPENAI_API_KEY=sk-...
python your_script.py
```

## Note on `source_dialect`

`traceloop-sdk >= 0.55.0` (released 2026-03-29) migrated to pure OTEL GenAI
semantic conventions. Traces from modern Traceloop versions land as
`source_dialect = "otel-genai"` in Halley — not `"openllmetry"`. Both are
correct; the data (model ID, token counts, prompts) is identical. See
[`docs/research/openllmetry-2026-migration.md`](../research/openllmetry-2026-migration.md)
for the full story.

## Verify it worked

After running your script, check ClickHouse:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens
           FROM halley.observations
           ORDER BY start_time DESC
           LIMIT 5"
```

Or open the dashboard at `http://localhost:3000` — your spans appear in the
table immediately.

Expected output:
```
otel-genai    gpt-4o-mini    <input_tokens>    <output_tokens>
```

## Troubleshooting

**No spans in ClickHouse after running:**
- Check `TRACELOOP_BASE_URL` is set to `http://localhost:4318` (not `:4317`).
  Port 4318 is OTLP/HTTP; port 4317 is OTLP/gRPC.
- Add `disable_batch=True` to `Traceloop.init()`. Short-lived scripts exit
  before the batch timer fires, dropping all spans.
- Confirm Halley is running: `make ready` should show all services healthy.

**`Failed to export metrics batch code: 404`:**
- This warning is harmless. Halley implements the OTLP traces endpoint but not
  the metrics endpoint. Traces still land correctly.

## Fuller example

See [`examples/reasoning-agent-python/`](../../examples/reasoning-agent-python/)
for a complete multi-technique reasoning agent (Self-Consistency, Chain-of-Thought,
Iterative Refinement, PAL) instrumented with Traceloop, producing 5–10 spans
per question.
