# OpenLLMetry Python Setup — Research Notes

Date: 2026-05-15
Sources:
- https://docs.traceloop.com/docs/openllmetry/getting-started-python
- https://docs.traceloop.com/docs/openllmetry/configuration
- https://docs.traceloop.com/docs/openllmetry/integrations/splunk (TRACELOOP_BASE_URL pattern)
- https://signoz.io/docs/traceloop/ (working code example)

---

## Install

```bash
pip install traceloop-sdk openai
```

`traceloop-sdk` pulls in `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`,
and all the LLM auto-instrumentation packages (openai, anthropic, etc.) as
transitive deps. No separate OTEL install needed.

---

## Initialization — two patterns

### Pattern A: env var (preferred for examples)

```bash
export TRACELOOP_BASE_URL="http://localhost:4318"
export OPENAI_API_KEY="sk-..."
```

```python
from traceloop.sdk import Traceloop

Traceloop.init(app_name="reasoning-agent", disable_batch=True)
```

`TRACELOOP_BASE_URL` is the base URL; the SDK appends `/v1/traces` automatically.
`disable_batch=True` flushes spans eagerly — good for short-lived scripts and demos
where the process exits before the batch timer fires. Set to `False` (default) in
production long-running services.

### Pattern B: constructor arg (also works, but env var is cleaner)

The plan's original snippet used `api_endpoint=` as a constructor argument.
**This parameter does NOT exist in the current traceloop-sdk API.**
The correct constructor parameter is `exporter_type` (to switch between OTLP,
console, etc.) — the endpoint itself is controlled via `TRACELOOP_BASE_URL`.

Use Pattern A (env var) for the example apps. It's cleaner and matches all
official integration docs.

---

## What attributes it emits

OpenLLMetry Python emits `traceloop.*` attributes on every span:
- `traceloop.span.kind` — `"llm"`, `"task"`, `"agent"`, `"tool"`, `"workflow"`
- `traceloop.entity.name` — the function/class name being traced
- `traceloop.entity.input` — JSON-serialized input (the body we capture)
- `traceloop.entity.output` — JSON-serialized output

Plus standard `gen_ai.*` attributes on LLM spans:
- `gen_ai.system` (older convention, maps to `gen_ai.provider.name`)
- `gen_ai.request.model`
- `gen_ai.usage.prompt_tokens` / `gen_ai.usage.completion_tokens`

Our normalizer detects `traceloop.*` → `source_dialect = "openllmetry"`. ✓

---

## Content capture opt-in

By default, prompts and completions are NOT captured (privacy-safe default).
To enable:

```bash
export TRACELOOP_TRACE_CONTENT=true
```

Or in code:
```python
Traceloop.init(app_name="...", disable_batch=True)
# content capture is on by default in traceloop-sdk >= 0.28
# set TRACELOOP_TRACE_CONTENT=false to disable
```

**Note:** As of traceloop-sdk ~0.28+, content capture is ON by default.
Verify the installed version's default at Day 2 runtime.

---

## Verifying traces landed

After a run, check ClickHouse:
```sql
SELECT source_dialect, gen_ai_request_model, gen_ai_usage_input_tokens, gen_ai_usage_output_tokens
FROM halley.observations
WHERE source_dialect = 'openllmetry'
ORDER BY start_time DESC
LIMIT 10;
```

Expected: `source_dialect = 'openllmetry'`, `gen_ai_request_model = 'gpt-4o-mini'`,
non-zero token counts.

---

## Common pitfall: process exits before flush

Short-lived Python scripts exit before the OTLP exporter's background thread
flushes the batch. Fix: `disable_batch=True` in `Traceloop.init()`. This makes
every span export synchronously before the process exits.

Alternative: call `Traceloop.flush()` explicitly before `sys.exit()`.
