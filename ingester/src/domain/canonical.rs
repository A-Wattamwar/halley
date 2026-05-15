//! `CanonicalSpan` — the normalizer's output type.
//!
//! This is the middle stage of the three-stage pipeline:
//!
//! ```text
//! OtlpSpan          (receiver output — dialect-agnostic raw values)
//!   → CanonicalSpan (normalizer output — dialect-agnostic, bodies as serde_json::Value)
//!   → (ObservationRow, Vec<BodyRow>)  (ClickHouse-ready, body hashes as bytes)
//! ```
//!
//! `CanonicalSpan` matches `RawSpan` 1:1 by design. Phase 4 may add fields;
//! Phase 2 does not. See phase-2-week-3.md "Common pitfalls to avoid" #1.
//!
//! The `into_rows()` factory replaces the old `ObservationRow::try_from(RawSpan)`
//! path. Body hashing (SHA-256 of canonical JSON) happens here, not in the
//! normalizer adapters.

use crate::{
    domain::span::{canonicalize_json, BodyRow, ObservationRow, SpanStatus},
    errors::IngestError,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

/// The normalizer's output. Dialect-agnostic, bodies as `serde_json::Value`.
///
/// All fields match the `halley.observations` schema 1:1.
/// Body fields are `Option<serde_json::Value>` — hashing happens in `into_rows()`.
#[derive(Debug, Clone)]
pub struct CanonicalSpan {
    // --- identity ---
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent_span_id: Option<[u8; 8]>,
    // --- time ---
    pub start_time_unix_nano: u64,
    pub end_time_unix_nano: u64,
    // --- dialect provenance ---
    pub source_dialect: String,
    pub dialect_version: String,
    // --- canonical GenAI fields ---
    pub gen_ai_system: String,
    pub gen_ai_operation: String,
    pub gen_ai_request_model: String,
    pub gen_ai_response_model: String,
    pub gen_ai_usage_input_tokens: u32,
    pub gen_ai_usage_output_tokens: u32,
    pub gen_ai_response_finish_reason: String,
    // --- bodies (hashing deferred to into_rows()) ---
    pub input_body: Option<Value>,
    pub output_body: Option<Value>,
    pub tool_input: Option<Value>,
    pub tool_output: Option<Value>,
    pub tool_name: String,
    pub tool_side_effect: String,
    // --- run / project ---
    pub project_id: Uuid,
    pub run_name: String,
    pub run_tags: Vec<String>,
    pub run_env: String,
    pub pricing_version_id: Uuid,
    // --- status ---
    pub status: SpanStatus,
    pub error_message: String,
    // --- unknown keys preserved verbatim ---
    pub attributes: BTreeMap<String, String>,
}

impl CanonicalSpan {
    /// Convert into ClickHouse-ready row types.
    ///
    /// This is the only place body hashing happens. The `run_id` is always
    /// `trace_id` (ARCHITECTURE §3.4 — run grouping tier 4; `is_run_root`
    /// detection is Week 4 Day 3).
    pub fn into_rows(self) -> Result<(ObservationRow, Vec<BodyRow>), IngestError> {
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;

        let mut body_rows: Vec<BodyRow> = Vec::new();

        let input_body_hash = hash_body(self.input_body, self.project_id, now_us, &mut body_rows);
        let output_body_hash = hash_body(self.output_body, self.project_id, now_us, &mut body_rows);
        let tool_input_hash = hash_body(self.tool_input, self.project_id, now_us, &mut body_rows);
        let tool_output_hash = hash_body(self.tool_output, self.project_id, now_us, &mut body_rows);

        // Attributes: BTreeMap → sorted Vec<(String,String)> for ClickHouse Map type.
        let attributes: Vec<(String, String)> = self.attributes.into_iter().collect();

        let obs = ObservationRow {
            trace_id: self.trace_id,
            span_id: self.span_id,
            parent_span_id: self.parent_span_id,
            // run_id = trace_id always at this stage (Week 4 adds is_run_root).
            run_id: self.trace_id,
            project_id: self.project_id,
            start_time: self.start_time_unix_nano,
            end_time: self.end_time_unix_nano,
            source_dialect: self.source_dialect,
            dialect_version: self.dialect_version,
            gen_ai_system: self.gen_ai_system,
            gen_ai_operation: self.gen_ai_operation,
            gen_ai_request_model: self.gen_ai_request_model,
            gen_ai_response_model: self.gen_ai_response_model,
            gen_ai_usage_input_tokens: self.gen_ai_usage_input_tokens,
            gen_ai_usage_output_tokens: self.gen_ai_usage_output_tokens,
            gen_ai_response_finish_reason: self.gen_ai_response_finish_reason,
            input_body_hash,
            output_body_hash,
            tool_input_hash,
            tool_output_hash,
            tool_name: self.tool_name,
            tool_side_effect: self.tool_side_effect,
            run_name: self.run_name,
            run_tags: self.run_tags,
            run_env: self.run_env,
            pricing_version_id: self.pricing_version_id,
            status: self.status,
            error_message: self.error_message,
            attributes,
        };

        Ok((obs, body_rows))
    }
}

// ---------------------------------------------------------------------------
// Body hashing (same algorithm as domain/span.rs — canonical JSON + SHA-256)
// ---------------------------------------------------------------------------

fn hash_body(
    body: Option<Value>,
    project_id: Uuid,
    first_seen_at: u64,
    out: &mut Vec<BodyRow>,
) -> Option<[u8; 32]> {
    let value = body?;
    let canonical = canonicalize_json(&value);
    let bytes = canonical.as_bytes();
    let hash_vec = Sha256::digest(bytes);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&hash_vec);
    let byte_size = bytes.len() as u32;
    out.push(BodyRow {
        body_hash: hash,
        body: canonical,
        content_type: "application/json".into(),
        byte_size,
        first_seen_at,
        project_id,
    });
    Some(hash)
}
