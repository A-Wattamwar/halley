# Halley Ingester

Rust service. Accepts OTLP spans over gRPC (port 4317) and HTTP (port 4318), validates against the OpenTelemetry GenAI semantic conventions, enriches with cost and run-grouping metadata, buffers through Redis Streams, and batch-writes to ClickHouse.

Built in Phases 1–2 (Weeks 1–4). See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §3.2–3.3 and [`../docs/ROADMAP.md`](../docs/ROADMAP.md).
