//! `POST /v1/spans/json` handler.
//!
//! Phase 2 Day 2: routes through the normalizer instead of calling
//! `ObservationRow::try_from(RawSpan)` directly.
//!
//! Pipeline:
//!   RawSpan (JSON body)
//!     → raw_span_to_otlp()       (halley_raw.rs helper)
//!     → Normalizer::normalize()  (halley-raw adapter)
//!     → CanonicalSpan::into_rows()
//!     → Publisher::publish()
//!     → 202
//!
//! On validation failure: 400 `{"error":"…","field":"…"}`.
//! On normalize failure:  400 `{"error":"…"}`.
//! On publish failure:    500 `{"error":"…"}`.

use crate::{
    domain::span::RawSpan, errors::IngestError, http::AppState,
    normalizer::halley_raw::raw_span_to_otlp,
};
use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use metrics::{counter, histogram};
use serde::Serialize;
use std::time::Instant;
use tracing::instrument;

/// Response body for a successful span ingest.
#[derive(Serialize)]
pub struct Accepted {
    pub accepted: u8,
}

/// `POST /v1/spans/json`
#[instrument(skip(state, raw), fields(trace_id = %raw.trace_id, span_id = %raw.span_id))]
pub async fn post_span(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(raw): Json<RawSpan>,
) -> Result<(StatusCode, Json<Accepted>), IngestError> {
    let start = Instant::now();

    // 1. Auth check
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

    // 2. Convert RawSpan → OtlpSpan (hex decode + attribute packing).
    let otlp_span = raw_span_to_otlp(raw)?;

    // 3. Normalize → CanonicalSpan.
    let mut canonical =
        state
            .normalizer
            .normalize(otlp_span)
            .map_err(|e| IngestError::InvalidField {
                field: "span",
                reason: format!("normalize error: {e}"),
            })?;

    // Phase 4 Day 4: Overwrite the project_id from the payload with the one
    // resolved from the API key. This prevents project impersonation.
    canonical.project_id = project_id;

    let dialect = canonical.source_dialect.clone();
    let unknown_attr_count = canonical.attributes.len() as u64;

    // 4. Hash bodies → (ObservationRow, Vec<BodyRow>).
    let (obs_row, body_rows) = canonical
        .into_rows()
        .map_err(|e| IngestError::Storage(format!("into_rows: {e}")))?;

    let body_count = body_rows.len();

    // 4. Publish to Redis stream.
    state
        .publisher
        .lock()
        .await
        .publish(&obs_row, &body_rows)
        .await
        .map_err(|e| IngestError::Storage(format!("publish error: {e}")))?;

    tracing::info!(body_hash_count = body_count, "span published to stream");

    // Emit metrics.
    let elapsed = start.elapsed().as_secs_f64();
    histogram!("halley_ingest_latency_seconds", "path" => "http").record(elapsed);
    counter!("halley_ingest_requests_total", "dialect" => dialect.clone(), "status" => "ok")
        .increment(1);
    if unknown_attr_count > 0 {
        counter!("halley_normalizer_unknown_attributes_total", "dialect" => dialect)
            .increment(unknown_attr_count);
    }

    Ok((StatusCode::ACCEPTED, Json(Accepted { accepted: 1 })))
}
