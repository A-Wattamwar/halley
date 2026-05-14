# Laminar — Research Notes

Date: May 21, 2026
Sources:
- https://laminar.sh/blog/2026-03-16-laminar-launch
- https://docs.lmnr.ai/tracing/integrations/vercel-ai-sdk
- https://github.com/lmnr-ai/lmnr
- https://www.ycombinator.com/launches/PeQ-laminar-understand-why-your-agent-failed-iterate-fast-to-fix-it

---

## How their OTLP endpoint works

Laminar is **OpenTelemetry-native from the ground up** (YC S24, $3M seed March
2026). Their SDK (`@lmnr-ai/lmnr`) is a thin wrapper around the official
OpenTelemetry SDK. It:

1. Calls `Laminar.initialize()` which registers a `TracerProvider` with a
   `LaminarSpanProcessor` that exports spans to their backend.
2. Exposes `getTracer()` which returns the OTEL tracer instance.
3. Users pass this tracer to framework-specific telemetry hooks (e.g. Vercel AI
   SDK's `experimental_telemetry.tracer`).

**What their OTLP traffic looks like:**
- Standard OTLP export from the OpenTelemetry SDK
- Spans carry `gen_ai.*` attributes (they follow the OTEL GenAI semconv)
- Auth via `LMNR_PROJECT_API_KEY` in headers
- They auto-instrument OpenAI, Anthropic, LangChain, Vercel AI SDK, CrewAI,
  and others via OpenTelemetry instrumentation libraries

**Key difference from Langfuse:** Laminar's SDK IS the OpenTelemetry SDK (with a
custom span processor). Langfuse's SDK is a separate thing that also happens to
accept OTLP. This means Laminar users' traffic is pure standard OTLP — no
`laminar.*` namespace attributes to worry about.

---

## Their trace timeline / reader mode (the UX they're proud of)

Laminar's headline UX feature is their **"reader mode" / transcript view**:
instead of showing a tree of spans (which gets unreadable for long-running
agents), they render the agent's reasoning and actions as a clean, readable feed.

- System prompt, user messages, model output, tool calls, and tool results are
  laid out as a conversation transcript.
- Sub-agents collapse to their input and final output.
- For browser agents, they record full browser sessions synced with traces so
  you can see what the agent saw at every step.

This is a pure UX innovation — the underlying data model is still OTLP spans.
They just render them differently.

---

## Whether they have anything like cassette capture or fixture-based CI

**No.** Laminar has:
- Tracing and observability (their core)
- "Signals" — LLM-as-judge pattern detectors that run on traces (e.g. "detect
  when the agent recommends an out-of-stock product")
- SQL editor for querying across traces
- Replay-debug from any step (interactive, not CI)

But they do NOT have:
- Cassette/fixture capture
- Deterministic replay in CI
- Invariant inference
- `halley ci`-style regression testing
- Bisect

Their "replay-debug from any step" is interactive (you fork from a point and
re-run with the live model). It's not deterministic and not CI-integrated.

---

## What Halley does differently and why

Laminar is the closest competitor in spirit — they're also OTEL-native, also
focused on agents, also ClickHouse-backed. But their value prop is "understand
why your agent failed" (debugging), not "catch the next failure before it ships"
(regression testing).

Key differences:
1. **No fixture/CI loop** — Laminar shows you what happened. Halley turns what
   happened into a test that catches the next regression.
2. **No cassette capture** — Laminar stores traces for viewing. Halley stores
   bit-fidelity cassettes for replay.
3. **No deterministic replay** — Laminar's replay is interactive and hits the
   live model. Halley's replay is deterministic (zero LLM cost in pure mode).
4. **Browser session recording** — Laminar records browser sessions for browser
   agents. Halley does not compete here (ARCHITECTURE §1.2 non-goal).

**Concrete takeaway for Phase 2:** A Laminar user's OTLP traffic is standard
OpenTelemetry with `gen_ai.*` attributes. No proprietary namespace to worry
about. Our normalizer handles their traffic natively via the OTEL GenAI adapter.
The only Laminar-specific thing is their `observe()` wrapper which creates parent
spans — these are just regular OTEL spans with no special attributes.
