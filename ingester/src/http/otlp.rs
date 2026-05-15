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
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use serde_json::json;
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

    let (accepted, errors) =
        ingest_otlp_request(request, &state.normalizer, &state.publisher).await;

    tracing::info!(accepted, errors, "OTLP/HTTP traces processed");

    Ok((StatusCode::OK, Json(json!({}))).into_response())
}
