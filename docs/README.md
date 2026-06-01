# Halley docs

The front door for Halley's documentation. Start with the project [`README`](../README.md) for the pitch, the hero GIF, and one-command install; this index points to everything else.

## Getting started

- [Quickstart — Python (Traceloop / OpenLLMetry)](quickstart/quickstart-python.md) — instrument a Python + OpenAI app; lands as the `otel-genai` dialect.
- [Quickstart — TypeScript / Node.js (OpenInference)](quickstart/quickstart-typescript.md) — instrument a Node + OpenAI app; lands as the `openinference` dialect.
- [Quickstart — Vercel AI SDK (Next.js)](quickstart/quickstart-vercel.md) — instrument a Next.js app via the AI SDK's native OTEL export; lands as the `vercel-ai` dialect.
- [Running the loop](running-the-loop.md) — the dashboard + runner + terminal model: which worker runs what, starting a host runner, and the always-available terminal commands for record → promote → CI → bisect.

## Concepts

- [Scenario](SCENARIO.md) — a concrete real-world story (a prompt change silently breaks production) showing what Halley does and why it matters. Read this first if the architecture feels abstract.
- [Architecture](ARCHITECTURE.md) — the full system design: components, data flow, storage model, and the rationale behind each technical choice.

## Reference

- [Fixture format v1](fixture-format.md) — the locked on-disk contract for a Halley fixture (`<slug>.json` + content-addressed bodies), the replay-matching spec, and the two capture tiers.
- [Decisions log](DECISIONS.md) — append-only record of every non-obvious technical choice (D1 onward), with the tradeoff for each.
- [Roadmap](ROADMAP.md) — the build plan, phase deliverables, North-star criteria, and what is deferred.

## Research notes

Background notes captured while building (competitive landscape and instrumentation specifics). Not required reading, but useful context.

- [OpenTelemetry GenAI semantic conventions](research/otel-genai-semconv.md) — the primary span dialect Halley normalizes to.
- [OpenLLMetry 2026 migration](research/openllmetry-2026-migration.md) — why Traceloop ≥ 0.55 traffic flows through the `otel-genai` adapter, not `openllmetry`.
- [OpenLLMetry Python setup](research/openllmetry-python-setup.md) — instrumentation specifics for the Python quickstart.
- [Vercel AI SDK telemetry setup](research/vercel-ai-telemetry-setup.md) — instrumentation specifics for the Vercel quickstart.
- [Langfuse v4 notes](research/langfuse-v4.md) — how Langfuse captures bodies and structures storage.
- [Laminar notes](research/laminar.md) — competitive notes on Laminar's replay and recording.
