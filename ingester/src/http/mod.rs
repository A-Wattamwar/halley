//! HTTP layer: router wiring and shared state.

pub mod health;
pub mod otlp;
pub mod spans;

use crate::{
    normalizer::Normalizer, pipeline::publisher::Publisher, storage::clickhouse::ClickHouseStore,
};
use axum::{
    routing::{get, post},
    Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::{
    classify::{ServerErrorsAsFailures, SharedClassifier},
    trace::{DefaultMakeSpan, DefaultOnFailure, DefaultOnResponse, TraceLayer},
};
use tracing::Level;

/// Shared state handed to every handler.
///
/// `ClickHouseStore` is kept for `/readyz` health probing.
/// `Publisher` is behind a `Mutex` because `MultiplexedConnection` requires
/// `&mut self` for async commands. The mutex is uncontended in normal operation
/// (each request holds it only for the duration of one XADD call, ~1ms).
/// `Normalizer` is `Send + Sync` and shared by reference.
#[derive(Clone)]
pub struct AppState {
    pub ch: ClickHouseStore,
    pub publisher: Arc<Mutex<Publisher>>,
    pub normalizer: Arc<Normalizer>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route("/v1/spans/json", post(spans::post_span))
        .route("/v1/traces", post(otlp::post_otlp_traces))
        .layer(request_trace_layer())
        .with_state(state)
}

/// `TraceLayer` configured to emit one INFO-level JSON record per request
/// with `method`, `uri`, and `status` fields.
fn request_trace_layer() -> TraceLayer<SharedClassifier<ServerErrorsAsFailures>> {
    TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
        .on_response(DefaultOnResponse::new().level(Level::INFO))
        .on_failure(DefaultOnFailure::new().level(Level::ERROR))
}
