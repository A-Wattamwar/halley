//! `POST /v1/spans/json` handler.
//!
//! Accepts a canonical JSON span, validates IDs, hashes bodies, and
//! inserts into ClickHouse. Returns 202 on success, 400 on validation
//! failure, 500 on storage failure.

use crate::{domain::span::RawSpan, errors::IngestError, http::AppState};
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
///
/// Flow:
/// 1. Deserialize and validate the incoming `RawSpan`.
/// 2. Canonicalize + hash any body fields → `Vec<BodyRow>`.
/// 3. Insert bodies first (so hashes exist before the observation row).
/// 4. Insert the observation row.
/// 5. Return 202 `{"accepted":1}`.
///
/// On validation failure: 400 `{"error":"…","field":"…"}`.
/// On storage failure:    500 `{"error":"…"}`.
#[instrument(skip(state, raw), fields(trace_id = %raw.trace_id, span_id = %raw.span_id))]
pub async fn post_span(
    State(state): State<AppState>,
    Json(raw): Json<RawSpan>,
) -> Result<(StatusCode, Json<Accepted>), IngestError> {
    let (obs_row, body_rows) = raw.try_into()?;

    let body_count = body_rows.len();
    state.ch.insert_bodies(body_rows).await?;
    state.ch.insert_observation(obs_row).await?;

    tracing::info!(body_hash_count = body_count, "span inserted");

    Ok((StatusCode::ACCEPTED, Json(Accepted { accepted: 1 })))
}
