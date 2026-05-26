//! OTLP/HTTP receiver: `POST /v1/traces`.
//!
//! Accepts OTLP trace exports over HTTP in two encodings:
//! - `application/x-protobuf`: prost-decoded `ExportTraceServiceRequest`
//! - `application/json`: serde_json-decoded OTLP JSON encoding
//!
//! The actual span processing (convert → normalize → hash → publish) is
//! delegated to `pipeline::ingest::ingest_otlp_request`, which is shared
//! with the gRPC receiver in `grpc/otlp.rs`.
//!
//! Response: `ExportTraceServiceResponse {}` (empty, serialized as `{}`).
//! OTLP spec §4.1: a 200 response with an empty body is a full success.

use crate::{errors::IngestError, http::AppState, pipeline::ingest::ingest_otlp_request};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use metrics::histogram;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use serde_json::json;
use std::time::Instant;
use tracing::instrument;

/// `POST /v1/traces`
///
/// Accepts both `application/x-protobuf` and `application/json` OTLP payloads.
/// Returns 200 with `{}` on full success.
#[instrument(skip(state, headers, body))]
pub async fn post_otlp_traces(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, IngestError> {
    let start = Instant::now();
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let request = if content_type.contains("application/x-protobuf")
        || content_type.contains("application/octet-stream")
    {
        ExportTraceServiceRequest::decode(body).map_err(|e| IngestError::InvalidField {
            field: "body",
            reason: format!("protobuf decode error: {e}"),
        })?
    } else if content_type.contains("application/json") {
        serde_json::from_slice::<ExportTraceServiceRequest>(&body).map_err(|e| {
            IngestError::InvalidField {
                field: "body",
                reason: format!("json decode error: {e}"),
            }
        })?
    } else {
        return Err(IngestError::InvalidField {
            field: "content-type",
            reason: format!(
                "unsupported content-type: {content_type:?}; \
                 expected application/x-protobuf or application/json"
            ),
        });
    };

    // Auth check
    let mut project_id = state.auth.default_project_id();
    let auth_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !auth_header.is_empty() {
        if !auth_header.starts_with("Bearer hlly_") {
            return Err(IngestError::Unauthorized(
                "Missing or invalid Bearer token".into(),
            ));
        }

        let token = auth_header.strip_prefix("Bearer ").unwrap();
        match state.auth.validate_token(token).await {
            Ok(Some(pid)) => project_id = pid,
            Ok(None) => {
                return Err(IngestError::Unauthorized(
                    "Invalid or revoked API key".into(),
                ))
            }
            Err(e) => {
                tracing::error!(error = %e, "Auth service error");
                return Err(IngestError::Storage(
                    "Authentication service unavailable".into(),
                ));
            }
        }
    } else if state.auth.is_auth_required() {
        return Err(IngestError::Unauthorized(
            "Missing or invalid Bearer token".into(),
        ));
    }

    let (accepted, errors) =
        ingest_otlp_request(request, &state.normalizer, &state.publisher, project_id).await;

    tracing::info!(accepted, errors, "OTLP/HTTP traces processed");

    histogram!("halley_ingest_latency_seconds", "path" => "http")
        .record(start.elapsed().as_secs_f64());

    Ok((StatusCode::OK, Json(json!({}))).into_response())
}
