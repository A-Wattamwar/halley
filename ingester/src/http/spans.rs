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
use serde::Serialize;
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
    Json(raw): Json<RawSpan>,
) -> Result<(StatusCode, Json<Accepted>), IngestError> {
    // 1. Convert RawSpan → OtlpSpan (hex decode + attribute packing).
    let otlp_span = raw_span_to_otlp(raw)?;

    // 2. Normalize → CanonicalSpan.
    let canonical =
        state
            .normalizer
            .normalize(otlp_span)
            .map_err(|e| IngestError::InvalidField {
                field: "span",
                reason: format!("normalize error: {e}"),
            })?;

    // 3. Hash bodies → (ObservationRow, Vec<BodyRow>).
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

    Ok((StatusCode::ACCEPTED, Json(Accepted { accepted: 1 })))
}
