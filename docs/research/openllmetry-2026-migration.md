# OpenLLMetry 2026 Migration to OTEL GenAI Semconv — Research Notes

Date: 2026-05-15
Sources:
- https://github.com/traceloop/openllmetry/releases (release history)
- https://github.com/traceloop/openllmetry/pull/3844 (the pivot PR)
- Live observation: traceloop-sdk 0.60.0 span attributes from a real run

---

## What happened

Starting with `traceloop-sdk 0.55.0` (released **2026-03-29**), Traceloop
migrated their OpenAI instrumentation from a proprietary `traceloop.*` attribute
namespace to the upstream **OTEL GenAI Semantic Conventions 0.5.0** standard.

The pivot PR (#3844, merged 2026-03-29) was titled:
> "feat(open-ai): instrumentation to support OTel GenAI Semantic Conventions 0.5.1"

It replaced ~1,500 lines of legacy attribute-setting code with upstream
`gen_ai_attributes` and `openai_attributes` from the OTEL semconv package.

Subsequent releases extended the migration to other providers:
- 0.56.0 (2026-03-30): CrewAI
- 0.57.0 (2026-03-30): Bedrock
- 0.58.0 (2026-04-09): Gemini / google-generativeai
- 0.59.0 (2026-04-13): SDK guardrails
- 0.60.0 (2026-04-19): LlamaIndex, Groq

As of 0.60.0 (current pip-latest as of 2026-05-15), the OpenAI instrumentation
emits **no `traceloop.*` attributes** on LLM spans.

---

## Before vs. after: what attributes a span carries

### traceloop-sdk < 0.55 (legacy)

```
traceloop.span.kind = "llm"
traceloop.entity.name = "openai.chat"
traceloop.entity.input = '{"messages": [...]}'
traceloop.entity.output = '{"choices": [...]}'
gen_ai.system = "openai"                    ← older semconv name
gen_ai.request.model = "gpt-4o-mini"
llm.usage.prompt_tokens = 42
llm.usage.completion_tokens = 17
```

### traceloop-sdk >= 0.55 (current)

```
gen_ai.operation.name = "chat"
gen_ai.request.model = "gpt-4o-mini"
gen_ai.usage.input_tokens = 42
gen_ai.usage.output_tokens = 17
gen_ai.response.finish_reasons = ["stop"]
gen_ai.openai.api_base = "https://api.openai.com/v1/"
openai.response.service_tier = "default"
gen_ai.openai.response.system_fingerprint = "fp_..."
gen_ai.is_streaming = "false"
gen_ai.usage.cache_read.input_tokens = 0
gen_ai.usage.reasoning_tokens = 0
```

No `traceloop.*` keys. Pure OTEL GenAI semconv plus OpenAI-specific extras in
the `gen_ai.openai.*` and `openai.*` namespaces.

---

## Why Traceloop made this change

The OTEL GenAI Semantic Conventions reached a stable enough state (0.5.0,
released early 2026) that Traceloop decided to align with the standard rather
than maintain a parallel proprietary namespace. The PR description states:

> "Migrate span attributes from custom SpanAttributes to upstream gen_ai_attributes
> and openai_attributes"

This is the right call for the ecosystem: it means any OTEL-native backend
(Halley, Langfuse, Laminar, Honeycomb, Grafana) can ingest Traceloop traffic
without a Traceloop-specific adapter. The `traceloop.*` namespace was always a
transitional layer; 0.55 is where they crossed the bridge.

---

## Impact on Halley's normalizer

Halley's `openllmetry` adapter (D31) detects spans by the presence of any
`traceloop.*` attribute key. With 0.55+, no such keys are emitted. Spans fall
through to the `otel-genai` adapter, which handles them correctly:

| Field | Source attribute | Result |
|---|---|---|
| `gen_ai_request_model` | `gen_ai.request.model` | `"gpt-4o-mini"` ✓ |
| `gen_ai_usage_input_tokens` | `gen_ai.usage.input_tokens` | non-zero ✓ |
| `gen_ai_usage_output_tokens` | `gen_ai.usage.output_tokens` | non-zero ✓ |
| `gen_ai_operation` | `gen_ai.operation.name` | `"chat"` ✓ |
| `source_dialect` | (adapter detection) | `"otel-genai"` ✓ |

The `openllmetry` adapter remains correct for users on `traceloop-sdk < 0.55`.
No ingester code change is needed. The adapter priority order (D31) already
handles both cases: if `traceloop.*` keys are present, the openllmetry adapter
claims the span; if not, otel-genai claims it.

---

## What this means for any LLM observability tool

This migration is a signal that the OTEL GenAI semconv is winning as the
industry standard for LLM instrumentation. The practical consequences:

1. **Dialect detection by namespace is fragile.** Any tool that detects
   "this is Traceloop traffic" by looking for `traceloop.*` keys will silently
   misclassify 0.55+ traffic. Halley's design (detect by namespace, fall through
   to otel-genai) handles this gracefully.

2. **The `openllmetry` adapter is now a legacy compatibility layer.** It will
   remain relevant for users who haven't upgraded their SDK, but new deployments
   will route through `otel-genai`. Over time, the `openllmetry` adapter's share
   of real-world traffic will shrink.

3. **OpenInference (Arize) is following the same path.** PR #2931 in the
   openinference repo (merged 2026-03-30, same week as Traceloop's pivot) added
   support for the new `gen_ai.input/output.messages` format from Traceloop
   0.55+. The ecosystem is converging.

4. **For Halley's example apps:** The three example apps now demonstrate three
   genuinely distinct dialect paths:
   - Reasoning Agent (Python, Traceloop 0.60): `otel-genai`
   - Vercel AI app (Next.js): `vercel-ai`
   - Direct TypeScript (OpenInference): `openinference`
   This is more representative of real-world traffic than three apps all using
   the same adapter.

---

## Verified span attributes from our Day 2 run

From `SELECT attributes FROM halley.observations WHERE start_time > '2026-05-18 20:00:00'`:

```json
{
  "gen_ai.is_streaming": "false",
  "gen_ai.openai.api_base": "https://api.openai.com/v1/",
  "gen_ai.openai.response.system_fingerprint": "fp_b3f4b08c22",
  "gen_ai.request.max_tokens": "1024",
  "gen_ai.request.temperature": "0.3",
  "gen_ai.response.id": "chatcmpl-DgzFm5bW05FKjtluReSsTLBrVYNml",
  "gen_ai.usage.cache_read.input_tokens": "0",
  "gen_ai.usage.reasoning_tokens": "0",
  "gen_ai.usage.total_tokens": "33",
  "openai.response.service_tier": "default"
}
```

No `traceloop.*` keys. Confirmed: pure OTEL GenAI semconv + OpenAI extras.
