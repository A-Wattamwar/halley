# OpenTelemetry GenAI Semantic Conventions — Research Notes

Date: May 21, 2026
Source: https://opentelemetry.io/docs/specs/semconv/gen-ai/ (semconv v1.41.0)

---

## Stability status

**All GenAI conventions are "Development" status** (the blue badge). None are
stable yet. The spec explicitly says instrumentations SHOULD NOT change the
version they emit by default — there's a transition plan gated behind
`OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`. This means real
traffic in the wild will be a mix of pre-1.36.0 and post-1.36.0 attribute
shapes. Our normalizer must handle both.

---

## Exact attribute names (the ones we normalize TO)

These are the canonical `gen_ai.*` attributes from the spec:

| Attribute | Type | Status | Notes |
|-----------|------|--------|-------|
| `gen_ai.operation.name` | string | Development | `chat`, `embeddings`, `execute_tool`, `invoke_agent`, `invoke_workflow`, `retrieval`, `text_completion`, `generate_content`, `create_agent` |
| `gen_ai.provider.name` | string | Development | `openai`, `anthropic`, `gcp.gemini`, `aws.bedrock`, `deepseek`, `mistral_ai`, etc. |
| `gen_ai.request.model` | string | Development | Exact model name requested |
| `gen_ai.response.model` | string | Development | Exact model name that responded |
| `gen_ai.usage.input_tokens` | int | Development | Total input tokens (includes cached) |
| `gen_ai.usage.output_tokens` | int | Development | Total output tokens |
| `gen_ai.response.finish_reasons` | string[] | Development | Array: `["stop"]`, `["stop", "length"]` |
| `gen_ai.request.temperature` | double | Development | |
| `gen_ai.request.max_tokens` | int | Development | |
| `gen_ai.request.top_p` | double | Development | |
| `gen_ai.input.messages` | any (structured) | Development, Opt-In | Full chat history — JSON schema defined |
| `gen_ai.output.messages` | any (structured) | Development, Opt-In | Model responses — JSON schema defined |
| `gen_ai.system_instructions` | any (structured) | Development, Opt-In | System prompt |
| `gen_ai.tool.definitions` | any (structured) | Development, Opt-In | Tool schemas |
| `gen_ai.tool.name` | string | Development | On execute_tool spans |
| `gen_ai.tool.call.id` | string | Development | |
| `gen_ai.tool.call.arguments` | any | Development, Opt-In | |
| `gen_ai.tool.call.result` | any | Development, Opt-In | |

**Key rename from older versions:** The spec used to use `gen_ai.system` — this
is now `gen_ai.provider.name`. Older instrumentations (OpenLLMetry, pre-2025
versions) still emit `gen_ai.system`. Our normalizer needs to map both.

**Another rename:** `gen_ai.response.finish_reason` (singular, string) in older
versions → `gen_ai.response.finish_reasons` (plural, string array) in current.

---

## What `invoke_agent` looks like

`gen_ai.operation.name = "invoke_agent"` is the agent root span. Two variants:

1. **Client span** (span kind = CLIENT): remote agent invocation (OpenAI
   Assistants, AWS Bedrock Agents). Has `gen_ai.agent.id`, `gen_ai.agent.name`.
2. **Internal span** (span kind = INTERNAL): in-process agent (LangChain,
   CrewAI). Same attributes.

Both carry the full set of inference attributes (model, tokens, messages) plus
agent-specific ones (`gen_ai.agent.name`, `gen_ai.agent.id`,
`gen_ai.conversation.id`).

There's also `invoke_workflow` for multi-agent orchestration (CrewAI crews,
LangGraph graphs). Span kind INTERNAL.

**For Halley's run-grouping (ARCHITECTURE §3.4 tier 1):** a span with
`gen_ai.operation.name = "invoke_agent"` is a run root. This aligns perfectly
with the spec.

---

## The content/body model

The spec defines three Opt-In attributes for capturing full content:
- `gen_ai.input.messages` — structured JSON following a defined schema
- `gen_ai.output.messages` — structured JSON
- `gen_ai.system_instructions` — structured JSON

These are NOT recorded by default. Instrumentations only emit them when the user
opts in (e.g. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` in
OpenLLMetry).

The spec also describes an "upload to external storage" hook pattern where
instrumentations can call a user-defined hook to store content externally and
record a reference on the span. This is exactly what Halley's body-hash approach
does — we're aligned with the spec's direction here.

**Important for Phase 2:** When content IS present on spans, it's in the
structured JSON format defined by the spec (roles, parts with type/content).
When it's NOT present, we need to capture it from the raw HTTP request/response
bodies via the OTLP payload itself. The normalizer needs to handle both paths.

---

## What this means for the Phase 2 normalizer

1. **Primary target:** spans with `gen_ai.*` attributes in the current (post-1.36)
   format. Map directly to our canonical schema.

2. **Legacy handling:** older instrumentations emit `gen_ai.system` instead of
   `gen_ai.provider.name`, and `gen_ai.response.finish_reason` (singular string)
   instead of `gen_ai.response.finish_reasons` (array). Normalize both.

3. **Body capture:** when `gen_ai.input.messages` / `gen_ai.output.messages` are
   present, extract them as our `input_body` / `output_body`. When absent, we
   still need the raw bodies from the OTLP resource/scope attributes or from
   provider-specific attributes (OpenLLMetry puts them in `traceloop.entity.input`).

4. **Run grouping:** `gen_ai.operation.name = "invoke_agent"` is tier 1 of our
   heuristic. `invoke_workflow` could be tier 0 (workflow root) if we want to
   group multi-agent runs.

5. **Tool spans:** `gen_ai.operation.name = "execute_tool"` with `gen_ai.tool.name`,
   `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`. Map to our
   `tool_name`, `tool_input`, `tool_output` fields.
