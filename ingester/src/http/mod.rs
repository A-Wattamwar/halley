//! HTTP layer: router wiring and shared state.

pub mod health;
pub mod spans;

use crate::storage::clickhouse::ClickHouseStore;
use axum::{
    routing::{get, post},
    Router,
};
use tower_http::{
    classify::{ServerErrorsAsFailures, SharedClassifier},
    trace::{DefaultMakeSpan, DefaultOnFailure, DefaultOnResponse, TraceLayer},
};
use tracing::Level;

/// Shared state handed to every handler.
///
/// Cheap to clone: `ClickHouseStore` is `Arc`-based internally.
#[derive(Clone)]
pub struct AppState {
    pub ch: ClickHouseStore,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route("/v1/spans/json", post(spans::post_span))
        .layer(request_trace_layer())
        .with_state(state)
}

/// `TraceLayer` configured to emit one INFO-level JSON record per request
/// with `method`, `uri`, and `status` fields. The default layer only logs
/// on failure; we want every request visible in logs for the Day 3
/// reviewer checklist. See docs/DECISIONS.md D19.
fn request_trace_layer() -> TraceLayer<SharedClassifier<ServerErrorsAsFailures>> {
    TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
        .on_response(DefaultOnResponse::new().level(Level::INFO))
        .on_failure(DefaultOnFailure::new().level(Level::ERROR))
}
