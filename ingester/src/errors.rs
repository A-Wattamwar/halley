//! HTTP error type used across the ingester handlers.
//!
//! `IngestError::into_response` maps each variant to an HTTP status and a
//! JSON body. Validation errors return 400 with `{"error":"…","field":"…"}`;
//! storage errors return 500.
//!
//! Day 6 will add the `InvalidField` and `Storage` variants' use sites.
//! Day 3 only needs the NotImplemented variant for the /v1/spans/json stub.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)] // InvalidField and Storage are used on Day 6. Keeping them
                    // here on Day 3 keeps the error contract documented.
pub enum IngestError {
    /// Validation failure on an incoming span. `field` is the canonical
    /// JSON key that failed (e.g. `"trace_id"`); `reason` is a human
    /// description.
    #[error("invalid field {field}: {reason}")]
    InvalidField { field: &'static str, reason: String },

    /// ClickHouse or body serialization failure.
    #[error("storage error: {0}")]
    Storage(String),

    /// Missing or invalid API key.
    #[error("unauthorized: {0}")]
    Unauthorized(String),

    /// Day 3 stub for the spans endpoint until Day 6 implements it.
    #[error("not implemented")]
    NotImplemented,
}

impl IntoResponse for IngestError {
    fn into_response(self) -> Response {
        match self {
            IngestError::InvalidField { field, reason } => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": reason, "field": field })),
            )
                .into_response(),
            IngestError::Storage(reason) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": reason })),
            )
                .into_response(),
            IngestError::Unauthorized(reason) => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": reason }))).into_response()
            }
            IngestError::NotImplemented => (
                StatusCode::NOT_IMPLEMENTED,
                Json(json!({ "error": "POST /v1/spans/json is implemented on Day 6" })),
            )
                .into_response(),
        }
    }
}
