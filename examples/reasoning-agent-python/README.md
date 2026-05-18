# Reasoning Agent — Python + OpenLLMetry example

This example shows a real Python AI agent emitting OpenTelemetry traces into
Halley via OpenLLMetry's auto-instrumentation. Every LLM call the agent makes
produces a span with `source_dialect = "openllmetry"` in ClickHouse.

## Attribution

This example adapts Ayush Wattamwar's Inference-Time LLM Reasoning Agent
(CSE 476 — Introduction to Natural Language Processing, Arizona State
University, Fall 2025).

The four reasoning techniques (Self-Consistency, Chain-of-Thought with
Verification, Iterative Refinement, Program-Aided Language) and the question
classifier are **unchanged** from the original. Only `api.py` — the model-call
layer — was rewritten to use the OpenAI SDK directly so the example is
self-contained and runnable by anyone with an OpenAI key.

Original project: <https://github.com/A-Wattamwar/CSE476_FinalProject_InferenceTime>

## How the agent works

The agent classifies each question into a type (math, coding, planning, future,
general) and routes it to the appropriate combination of techniques:

- **Math**: PAL (generates and executes Python code) + Self-Consistency
- **General**: Self-Consistency + Chain-of-Thought with Verification
- **Other**: Self-Consistency + Chain-of-Thought with Verification

Each technique makes 1–5 LLM calls. A full run issues up to ~10 calls total,
costing ~$0.002 with `gpt-4o-mini`.

## Prerequisites

- Python 3.10+
- An OpenAI API key
- Halley running locally (`make up && make ready` from the repo root)

## Setup

```bash
cd examples/reasoning-agent-python

# Copy and fill in env vars
cp .env.example .env
# Edit .env: set OPENAI_API_KEY

# Run (creates venv, installs deps, runs the agent)
./run.sh
```

Or manually:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY=sk-...
export TRACELOOP_BASE_URL=http://localhost:4318

python agent.py "Solve: 47 * 23 + 19"
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | Your OpenAI API key |
| `TRACELOOP_BASE_URL` | No | `http://localhost:4318` | Halley OTLP/HTTP endpoint. The SDK appends `/v1/traces` automatically. |
| `MODEL_NAME` | No | `gpt-4o-mini` | OpenAI model to use |
| `TRACELOOP_TRACE_CONTENT` | No | `true` | Set to `false` to suppress prompt/completion content in spans |

## Verify traces landed

After a run, check ClickHouse:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT count(), gen_ai_request_model, source_dialect
           FROM halley.observations
           WHERE source_dialect = 'otel-genai'
           GROUP BY gen_ai_request_model, source_dialect
           ORDER BY count() DESC"
```

Expected output:
```
10    gpt-4o-mini    otel-genai
```

For more detail:

```bash
docker exec halley-clickhouse clickhouse-client \
  --query "SELECT source_dialect, gen_ai_request_model,
                  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens,
                  start_time
           FROM halley.observations
           WHERE source_dialect = 'otel-genai'
           ORDER BY start_time DESC
           LIMIT 15"
```

## Note on `source_dialect`

Traces from this example land as `source_dialect = "otel-genai"`, not
`"openllmetry"`. This is correct behavior for `traceloop-sdk >= 0.55.0`.

**Why:** In version 0.55.0 (released 2026-03-29, PR #3844), Traceloop migrated
the OpenAI instrumentation from its legacy `traceloop.*` / `SpanAttributes`
namespace to the upstream OTEL GenAI Semantic Conventions 0.5.0. Spans no
longer carry `traceloop.*` attributes — they emit pure `gen_ai.*` attributes
instead. Halley's normalizer detects `traceloop.*` keys to identify the
`openllmetry` dialect; without those keys, spans correctly route through the
`otel-genai` adapter.

The `openllmetry` adapter in Halley remains active for users on
`traceloop-sdk < 0.55` (legacy `traceloop.*` namespace). Modern versions
(0.55+) flow through `otel-genai`. Both paths produce correct canonical rows
with accurate model IDs and token counts.

## What you'll see in the dashboard

Each LLM call the agent makes appears as a row in the spans table at
`http://localhost:3000`. The `source_dialect` column shows `otel-genai`,
confirming Halley's normalizer correctly handled the Traceloop 0.55+
instrumentation via the OTEL GenAI adapter.

## Project structure

```
agent.py                        # Main orchestrator + OpenLLMetry init
api.py                          # OpenAI SDK adapter (adapted from original)
answer_parser.py                # Question classifier + answer extraction
technique1_self_consistency.py  # Self-consistency with majority voting
technique2_cot_verify.py        # Chain-of-thought with verification
technique3_refinement.py        # Iterative refinement
technique4_pal.py               # Program-aided language for math
requirements.txt                # traceloop-sdk, openai
.env.example                    # Environment variable template
run.sh                          # One-command setup and run
```
