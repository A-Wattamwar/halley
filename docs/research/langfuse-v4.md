# Langfuse v4 ("Fast Preview") — Research Notes

Date: May 21, 2026
Sources:
- https://langfuse.com/docs/v4
- https://langfuse.com/blog/2026-03-10-simplify-langfuse-for-scale
- https://langfuse.com/docs/opentelemetry/get-started

---

## Single observations table (the v4 pivot)

Langfuse v4 ("Fast Preview", released March 2026) moved from a two-table model
(traces + observations) to a **single denormalized observations table** in
ClickHouse. Every LLM call, tool execution, and agent step is one row. Trace-level
attributes (user_id, session_id, tags, environment) are materialized onto every
observation row — no JOINs needed.

This is exactly the same pattern Halley uses (ARCHITECTURE §4.1, §6.7). We
independently arrived at the same conclusion: agentic workloads put the
interesting data deep in the span tree, not on the root trace row.

Their SDK v4 (Python) and v5 (JS/TS) propagate correlating attributes to every
span automatically. Older SDKs only set them on the trace root.

---

## How they handle OTLP ingestion

**Endpoint:** `/api/public/otel` (OTLP/HTTP). Supports both `HTTP/JSON` and
`HTTP/protobuf`. **gRPC is NOT supported** — they only do OTLP over HTTP.

**Auth:** Basic Auth in the `Authorization` header. The auth string is
`base64(public_key:secret_key)`.

**Versioning header:** `x-langfuse-ingestion-version: 4` — this header tells
Langfuse to use the v4 (observations-first) data model. Without it, spans are
ingested into the legacy two-table model.

**What a Langfuse user's OTLP traffic looks like:**
- Standard OTLP/HTTP POST to `/api/public/otel/v1/traces`
- `Authorization: Basic <base64(pk:sk)>`
- `x-langfuse-ingestion-version: 4`
- Body is either protobuf or JSON-encoded OTLP ExportTraceServiceRequest
- Spans carry `gen_ai.*` attributes per the OTEL GenAI semconv
- Langfuse-specific attributes in the `langfuse.*` namespace for metadata,
  user/session IDs, observation types, cost details

---

## Body/content storage

Langfuse maps content from multiple sources (priority order):
1. `langfuse.observation.input` / `langfuse.observation.output` (explicit)
2. `gen_ai.prompt` / `gen_ai.completion` (older convention)
3. `input.value` / `output.value` (OpenInference)
4. `mlflow.spanInputs` / `mlflow.spanOutputs` (MLflow)

They store the content as part of the observation row — it's a column in their
ClickHouse table, not a separate content-addressed store. This means:
- No dedup across identical prompts
- Content is always fetched with the observation (no separate body table)
- Simpler model but worse compression for repeated system prompts

**Halley's difference:** We split bodies into a separate content-addressed table
(`observation_body`) keyed by SHA-256. This gives massive dedup (identical system
prompts across 10K runs store once) and keeps the hot-path observation scans
narrow. Langfuse trades dedup for simplicity.

---

## Attribute mapping (what their normalizer does)

Langfuse's normalizer maps from multiple dialects to their internal model:

| Langfuse field | Sources (priority order) |
|---|---|
| model | `langfuse.observation.model.name` > `gen_ai.request.model` > `gen_ai.response.model` > `llm.model_name` > `model` |
| input | `langfuse.observation.input` > `gen_ai.prompt` > `input.value` > `mlflow.spanInputs` |
| output | `langfuse.observation.output` > `gen_ai.completion` > `output.value` > `mlflow.spanOutputs` |
| usage (tokens) | `langfuse.observation.usage_details` > `gen_ai.usage.*` > `llm.token_count.*` |
| cost | `langfuse.observation.cost_details` > `gen_ai.usage.cost` |

They also support `langfuse.*` namespace attributes that always take precedence
over generic OTEL conventions. This is their escape hatch for when the OTEL
semconv doesn't cover something.

---

## What Halley does differently and why

Langfuse is a general-purpose LLM observability platform that added OTLP support
as an ingestion path. Their value is the dashboard, prompt management, and eval
tooling. They do NOT close the loop from "production run happened" to "regression
test in CI."

Halley's key differences:
1. **Content-addressed body storage** — dedup and separate from the observation
   table. Langfuse stores bodies inline.
2. **Cassette capture** — we store the raw request/response bytes for bit-fidelity
   replay. Langfuse stores a normalized representation.
3. **No fixture/replay concept** — Langfuse has no equivalent of "turn this run
   into a test." That's our hero capability.
4. **gRPC support planned** — Langfuse only does OTLP/HTTP. We plan both gRPC
   and HTTP (Phase 2).

**Concrete takeaway for Phase 2:** A Langfuse user switching to Halley will send
OTLP/HTTP traffic with `gen_ai.*` attributes and possibly `langfuse.*` namespace
attributes. Our normalizer should handle the `gen_ai.*` attributes natively and
preserve `langfuse.*` attributes in our `attributes` map without dropping them.
We do NOT need to understand `langfuse.*` semantics — just preserve them.
