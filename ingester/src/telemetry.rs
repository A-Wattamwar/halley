//! Prometheus metrics initialisation and handle.
//!
//! Call `init_prometheus()` once at startup. It installs the global metrics
//! recorder and returns a `PrometheusHandle` that the `/metrics` route uses
//! to render the current snapshot.
//!
//! # Metric catalogue
//!
//! | Name | Type | Labels | Description |
//! |---|---|---|---|
//! | `halley_ingest_requests_total` | counter | dialect, status | Spans accepted or rejected |
//! | `halley_ingest_latency_seconds` | histogram | path | End-to-end handler latency |
//! | `halley_normalizer_unknown_attributes_total` | counter | dialect | Unknown attrs preserved per span |
//! | `halley_writer_batch_size` | histogram | — | Observations per writer batch |
//! | `halley_writer_flush_latency_seconds` | histogram | — | XREADGROUP → XACK wall time |
//! | `halley_redis_stream_lag` | gauge | — | XLEN halley:spans (polled 1/s) |
//! | `halley_clickhouse_insert_errors_total` | counter | kind | transient or permanent |
//! | `halley_body_dedup_ratio` | gauge | — | Unique bodies / total bodies per batch |
//!
//! Label cardinality is intentionally low: dialect (~5 values) and status
//! (~2 values) only. Model and project_id are never used as labels.
//! See DECISIONS.md D35.

use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

/// Install the global Prometheus recorder and return the render handle.
///
/// Must be called exactly once before any `metrics::counter!` / `metrics::gauge!`
/// / `metrics::histogram!` macro is invoked. Panics if called twice.
pub fn init_prometheus() -> PrometheusHandle {
    PrometheusBuilder::new()
        .install_recorder()
        .expect("failed to install Prometheus recorder")
}
