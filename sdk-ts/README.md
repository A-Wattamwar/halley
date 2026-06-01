# `@halley/sdk` (placeholder — not built)

This directory is a **placeholder scaffold**. There is **no TypeScript SDK or
record/replay shim implemented here yet** — nothing in this folder ships today.

A TypeScript record/replay shim is **planned but deferred** (P1). It is not part
of the current release. The implemented recorder is the **Python shim**
([`../sdk-py/`](../sdk-py/)), which provides bit-fidelity capture and `$0`
pure-mode replay (see [`../docs/fixture-format.md`](../docs/fixture-format.md),
Tier 2).

## TypeScript / Node.js users today

You do **not** need a Halley SDK to use Halley. Instrument your app with standard
OTLP (OpenInference or any OTEL GenAI emitter) and point the exporter at the
ingester:

→ [`../docs/quickstart/quickstart-typescript.md`](../docs/quickstart/quickstart-typescript.md)

This gives you **Tier 1** observability and invariant inference. **Tier 2**
bit-fidelity replay currently requires the Python recorder shim; a TS shim is the
deferred follow-up that would bring Tier 2 to Node agents.

See [`../docs/ROADMAP.md`](../docs/ROADMAP.md) (deferrals) and
[`../docs/DECISIONS.md`](../docs/DECISIONS.md) (D41 — the standalone SDK was
dropped in Phase 3 in favor of OTLP-direct instrumentation).
