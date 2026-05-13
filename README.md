# Halley

**Agent-first observability for LLM applications.**
Self-hostable. OpenTelemetry-native. Built for the era of multi-step AI agents.

> Status: Pre-alpha. Active development — May 2026 to August 2026.
> Tracking repo setup and weekly progress in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Why Halley

Every LLM observability tool on the market today (Langfuse, Helicone, LangSmith, Arize Phoenix, Datadog LLM) treats a trace as a list of LLM calls. That worked when apps were single-prompt chatbots. It does not work for modern AI agents that plan, call tools, retry, self-correct, and loop.

Halley treats an **agent run** as the first-class unit. Around that model, Halley gives you:

1. **Reasoning graph view** — not a flat trace, a DAG of tool calls, branches, retries, and self-corrections, navigable like a debugger's call tree.
2. **Replay and fork** — pick any step of a past run, change the prompt, model, or tool response, and re-execute only from that step forward.
3. **Outcome-level evaluation** — did the agent succeed at its task end-to-end, not just "was each prompt fluent."
4. **Cost attribution per agent run** — see dollars spent per task, not per call.
5. **OpenTelemetry-native ingestion** — any app using OpenLLMetry, the OpenAI/Anthropic SDK auto-instrumentation, or LangChain callbacks becomes a Halley user by pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at Halley.

---

## Architecture at a glance

```
Your AI app ─── OTLP ───▶ Rust Ingester ─── Redis Streams ──▶ ClickHouse
                                                                   │
                                                                   ▼
                                                         Next.js Dashboard
```

Full system design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Tech stack

| Layer | Choice |
|---|---|
| Ingester | Rust (`tokio`, `axum`, `tonic`, `prost`) |
| Queue / buffer | Redis Streams |
| Storage | ClickHouse (traces, spans, runs) + Postgres (auth, projects, configs) |
| Dashboard | Next.js 14 (App Router, Server Components) + Tailwind + shadcn/ui |
| SDK | TypeScript (wraps OpenTelemetry JS SDK) |
| Protocol | OTLP (gRPC + HTTP) following OpenTelemetry GenAI semantic conventions |
| Orchestration | Docker Compose (local), Kubernetes Helm (post-launch) |

---

## Getting started (will be real by Phase 1 end)

```bash
git clone https://github.com/A-Wattamwar/halley
cd halley
docker compose up
# dashboard at http://localhost:3000
# ingester OTLP endpoint at http://localhost:4318
```

Point any OTEL-instrumented AI app at the ingester and agent traces start flowing.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, data model, component responsibilities
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — 12-week build plan, phase deliverables, living truth base

---

## License

MIT. See [`LICENSE`](LICENSE).

---

## Author

Built by [Ayush Wattamwar](https://ayushwattamwar.com) — CS @ Arizona State University.
Named after Edmond Halley, who used obsessive cataloging of past observations to predict the future. Which is what this tool does for agents.
