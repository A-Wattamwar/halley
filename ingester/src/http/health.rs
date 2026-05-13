//! Liveness and readiness handlers.
//!
//! `/healthz` is liveness: the process is running, the HTTP stack works.
//! Always returns 200 with body `ok`.
//!
//! `/readyz` is readiness: dependencies this process needs are reachable.
//! Day 3 probes ClickHouse only; Week 3 will add Redis.

use crate::http::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

pub async fn healthz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

pub async fn readyz(State(state): State<AppState>) -> Response {
    match state.ch.ping().await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ready": true }))).into_response(),
        Err(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "ready": false,
                "dependency": "clickhouse",
                "error": reason,
            })),
        )
            .into_response(),
    }
}
