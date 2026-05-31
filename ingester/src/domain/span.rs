//! Canonical span domain model: wire format, row types, and body hashing.
//!
//! # Canonical JSON rule (NOT RFC 8785 / JCS)
//!
//! Bodies are hashed after serializing to a canonical JSON form defined as:
//!   1. Recursively sort all object keys alphabetically (Unicode code-point order).
//!   2. Compact output — no whitespace between tokens.
//!   3. Leave numbers as `serde_json::Number` — no float normalization,
//!      no integer coercion, no exponent rewriting.
//!
//! This is intentionally simpler than RFC 8785 (JCS). JCS additionally
//! normalizes floating-point numbers to IEEE 754 decimal representation,
//! which requires a non-trivial algorithm and a dependency we do not want
//! in Week 1. Our bodies are LLM request/response JSON; numbers in those
//! payloads are token counts, temperatures, and costs — all of which
//! round-trip through `serde_json::Number` without loss. Two bodies that
//! differ only in key order MUST hash the same; that is the acceptance bar
//! (see unit test `canonical_json_key_order`). RFC 8785 is deferred to
//! whenever we need cross-language hash compatibility. See DECISIONS.md D22.

use crate::errors::IngestError;
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_repr::Serialize_repr;
use sha2::{Digest, Sha256};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Wire format (incoming JSON)
// ---------------------------------------------------------------------------

/// Incoming canonical JSON span. Matches the `POST /v1/spans/json` schema
/// defined in the Week 1 plan and `ingester/fixtures/hello-span.json`.
#[derive(Debug, Deserialize)]
pub struct RawSpan {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    /// If null, defaults to `trace_id` (ARCHITECTURE §3.4 tier 4).
    pub run_id: Option<String>,
    pub project_id: Uuid,

    pub start_time_unix_nano: u64,
    pub end_time_unix_nano: u64,

    pub source_dialect: String,
    pub dialect_version: String,

    pub gen_ai_system: String,
    pub gen_ai_operation: String,
    pub gen_ai_request_model: String,
    pub gen_ai_response_model: String,
    pub gen_ai_usage_input_tokens: u32,
    pub gen_ai_usage_output_tokens: u32,
    pub gen_ai_response_finish_reason: String,

    /// Optional body fields. If present, each is canonicalized and hashed.
    pub input_body: Option<Value>,
    pub output_body: Option<Value>,
    pub tool_name: String,
    pub tool_input: Option<Value>,
    pub tool_output: Option<Value>,
    pub tool_side_effect: String,

    pub run_name: String,
    pub run_tags: Vec<String>,
    pub run_env: String,

    pub pricing_version_id: Uuid,
    pub status: String,
    pub error_message: String,
    pub attributes: std::collections::HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// ClickHouse row types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ClickHouse row types
// ---------------------------------------------------------------------------

/// Enum8('ok'=1,'error'=2,'timeout'=3) in ClickHouse.
/// `serde_repr` serializes as the numeric discriminant, which is what
/// ClickHouse's RowBinary format expects for Enum8 columns.
#[derive(Debug, Clone, Serialize_repr, serde_repr::Deserialize_repr)]
#[repr(u8)]
pub enum SpanStatus {
    Ok = 1,
    Error = 2,
    Timeout = 3,
}

impl SpanStatus {
    fn from_str(s: &str) -> Self {
        match s {
            "error" => SpanStatus::Error,
            "timeout" => SpanStatus::Timeout,
            _ => SpanStatus::Ok, // default to ok for unknown values
        }
    }
}

/// One row in `halley.observations`.
///
/// Column type mapping:
/// - `FixedString(16)` → `[u8; 16]`  (trace_id, run_id)
/// - `FixedString(8)`  → `[u8; 8]`   (span_id, parent_span_id)
/// - `FixedString(32)` → `[u8; 32]`  (body hashes)
/// - `UUID`            → `uuid::Uuid` with `clickhouse::serde::uuid`
/// - `DateTime64(9)`   → `u64` nanoseconds since epoch
/// - `Enum8`           → `SpanStatus` with `serde_repr` (numeric discriminant)
/// - `Map(String,String)` → `Vec<(String,String)>`
#[derive(Debug, Clone, Row, Serialize, Deserialize)]
pub struct ObservationRow {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent_span_id: Option<[u8; 8]>,
    pub run_id: [u8; 16],
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,

    /// Nanoseconds since Unix epoch → DateTime64(9, 'UTC').
    /// The clickhouse crate maps u64 nanoseconds to DateTime64(9) in RowBinary.
    pub start_time: u64,
    pub end_time: u64,

    pub source_dialect: String,
    pub dialect_version: String,

    pub gen_ai_system: String,
    pub gen_ai_operation: String,
    pub gen_ai_request_model: String,
    pub gen_ai_response_model: String,
    pub gen_ai_usage_input_tokens: u32,
    pub gen_ai_usage_output_tokens: u32,
    pub gen_ai_response_finish_reason: String,

    pub input_body_hash: Option<[u8; 32]>,
    pub output_body_hash: Option<[u8; 32]>,
    pub tool_input_hash: Option<[u8; 32]>,
    pub tool_output_hash: Option<[u8; 32]>,
    pub tool_name: String,
    pub tool_side_effect: String,

    pub run_name: String,
    pub run_tags: Vec<String>,
    pub run_env: String,

    #[serde(with = "clickhouse::serde::uuid")]
    pub pricing_version_id: Uuid,
    /// Enum8('ok'=1,'error'=2,'timeout'=3). Serialized as u8 via serde_repr.
    pub status: SpanStatus,
    pub error_message: String,
    pub attributes: Vec<(String, String)>, // Map(String,String)
    /// True if this span is the root of an agent run.
    /// Set at write time by the normalizer adapters (Week 4 Day 3).
    /// Corresponds to `is_run_root Bool DEFAULT false` added by migration
    /// 20260520000001_observations_is_run_root.sql.
    /// Must be the LAST field — ALTER TABLE ADD COLUMN appends to the end,
    /// and the clickhouse Row derive serializes fields in declaration order.
    pub is_run_root: bool,
}

/// One row in `halley.observation_body`.
///
/// - `FixedString(32)` → `[u8; 32]`
/// - `UUID`            → `uuid::Uuid` with `clickhouse::serde::uuid`
/// - `DateTime64(6)`   → `u64` microseconds since epoch
#[derive(Debug, Clone, Row, Serialize, Deserialize)]
pub struct BodyRow {
    pub body_hash: [u8; 32],
    pub body: String,
    pub content_type: String,
    pub byte_size: u32,
    /// Microseconds since Unix epoch → DateTime64(6, 'UTC').
    pub first_seen_at: u64,
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
}

// ---------------------------------------------------------------------------
// Conversion: RawSpan → (ObservationRow, Vec<BodyRow>)
// ---------------------------------------------------------------------------

impl TryFrom<RawSpan> for (ObservationRow, Vec<BodyRow>) {
    type Error = IngestError;

    fn try_from(raw: RawSpan) -> Result<Self, Self::Error> {
        // --- ID validation and decoding ---
        let trace_id = decode_hex_id::<16>(&raw.trace_id, "trace_id")?;
        let span_id = decode_hex_id::<8>(&raw.span_id, "span_id")?;
        let parent_span_id = raw
            .parent_span_id
            .as_deref()
            .map(|s| decode_hex_id::<8>(s, "parent_span_id"))
            .transpose()?;

        // run_id defaults to trace_id when absent (ARCHITECTURE §3.4 tier 4).
        let run_id = match raw.run_id.as_deref() {
            Some(s) => decode_hex_id::<16>(s, "run_id")?,
            None => trace_id,
        };

        // UUID fields pass through directly — ClickHouse crate handles Uuid natively.
        let project_id = raw.project_id;
        let pricing_version_id = raw.pricing_version_id;

        // --- Body hashing ---
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;

        let mut body_rows: Vec<BodyRow> = Vec::new();

        let input_body_hash = hash_body(raw.input_body, project_id, now_us, &mut body_rows);
        let output_body_hash = hash_body(raw.output_body, project_id, now_us, &mut body_rows);
        let tool_input_hash = hash_body(raw.tool_input, project_id, now_us, &mut body_rows);
        let tool_output_hash = hash_body(raw.tool_output, project_id, now_us, &mut body_rows);

        // --- Attributes: HashMap → sorted Vec<(String,String)> ---
        // Clone before moving into Vec so we can still read attributes for is_run_root.
        let mut attributes: Vec<(String, String)> = raw.attributes.clone().into_iter().collect();
        attributes.sort_by(|a, b| a.0.cmp(&b.0));

        // Compute is_run_root before moving raw fields into the struct.
        let is_run_root = raw.gen_ai_operation == "invoke_agent"
            || raw.attributes.get("halley.run.kind").map(|s| s.as_str()) == Some("agent");

        let obs = ObservationRow {
            trace_id,
            span_id,
            parent_span_id,
            run_id,
            project_id,
            start_time: raw.start_time_unix_nano,
            end_time: raw.end_time_unix_nano,
            source_dialect: raw.source_dialect,
            dialect_version: raw.dialect_version,
            gen_ai_system: raw.gen_ai_system,
            gen_ai_operation: raw.gen_ai_operation,
            gen_ai_request_model: raw.gen_ai_request_model,
            gen_ai_response_model: raw.gen_ai_response_model,
            gen_ai_usage_input_tokens: raw.gen_ai_usage_input_tokens,
            gen_ai_usage_output_tokens: raw.gen_ai_usage_output_tokens,
            gen_ai_response_finish_reason: raw.gen_ai_response_finish_reason,
            input_body_hash,
            output_body_hash,
            tool_input_hash,
            tool_output_hash,
            tool_name: raw.tool_name,
            tool_side_effect: raw.tool_side_effect,
            run_name: raw.run_name,
            run_tags: raw.run_tags,
            run_env: raw.run_env,
            pricing_version_id,
            status: SpanStatus::from_str(&raw.status),
            error_message: raw.error_message,
            attributes,
            is_run_root,
        };

        Ok((obs, body_rows))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Decode a hex string of exactly `N*2` characters into `[u8; N]`.
/// Returns `IngestError::InvalidField` on wrong length or invalid hex.
fn decode_hex_id<const N: usize>(s: &str, field: &'static str) -> Result<[u8; N], IngestError> {
    let expected_len = N * 2;
    if s.len() != expected_len {
        return Err(IngestError::InvalidField {
            field,
            reason: format!("expected {} hex chars, got {}", expected_len, s.len()),
        });
    }
    let bytes = hex::decode(s).map_err(|e| IngestError::InvalidField {
        field,
        reason: format!("invalid hex: {e}"),
    })?;
    // bytes.len() == N is guaranteed by the length check above.
    let mut arr = [0u8; N];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// Public re-export of `decode_hex_id` for use by the normalizer layer.
/// The normalizer needs to decode hex IDs from `RawSpan` when converting
/// to `OtlpSpan`. See `normalizer/halley_raw.rs::raw_span_to_otlp`.
pub fn decode_hex_id_pub<const N: usize>(
    s: &str,
    field: &'static str,
) -> Result<[u8; N], IngestError> {
    decode_hex_id::<N>(s, field)
}

/// Canonicalize a `serde_json::Value`, SHA-256 hash it, push a `BodyRow`,
/// and return the 32-byte hash. Returns `None` if `body` is `None`.
///
/// See the module-level doc comment for the canonical JSON rule.
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

/// Produce canonical JSON from a `serde_json::Value`.
///
/// # Canonical JSON rule (NOT RFC 8785 / JCS)
///
/// - Recursively sort object keys alphabetically (Unicode code-point order).
/// - Compact output — no whitespace.
/// - Numbers are left as-is (`serde_json::Number`); no float normalization.
///
/// Two objects that differ only in key order produce identical output and
/// therefore identical SHA-256 hashes. This is the acceptance bar verified
/// by the `canonical_json_key_order` unit test.
///
/// # Single source of truth (Phase 6 Week 11 Day 1)
///
/// The implementation now lives in the `halley-canonical` crate so the D22
/// algorithm has exactly one Rust home (previously triplicated: here, the CLI
/// `canonical-hash` bin, and the Python sibling). This is a `pub use`
/// re-export — byte-for-byte identical behavior, same public signature
/// `canonicalize_json(&Value) -> String`. Callers in this crate
/// (`domain/canonical.rs`, `hash_body` below) are unchanged. See D22, D54.
pub use halley_canonical::canonicalize_json;

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    /// Decode a 32-char hex string to [u8; 16], re-encode, assert round-trip.
    #[test]
    fn hex_round_trip() {
        let original = "00000000000000000000000000000001";
        let bytes: [u8; 16] = decode_hex_id(original, "trace_id").expect("decode");
        let re_encoded = hex::encode(bytes);
        assert_eq!(re_encoded, original);
        assert_eq!(re_encoded.len(), 32);
    }

    /// Two JSON objects with the same keys/values but different key order
    /// must produce identical SHA-256 hashes after canonicalization.
    #[test]
    fn canonical_json_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":1,"a":2,"m":3}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"m":3,"z":1,"a":2}"#).unwrap();

        let ca = canonicalize_json(&a);
        let cb = canonicalize_json(&b);

        // Both must produce the same canonical string.
        assert_eq!(ca, cb, "canonical strings differ: {ca:?} vs {cb:?}");

        // And therefore the same hash.
        let ha = Sha256::digest(ca.as_bytes());
        let hb = Sha256::digest(cb.as_bytes());
        assert_eq!(ha, hb);
    }

    /// Nested objects must also be sorted recursively.
    #[test]
    fn canonical_json_nested_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":{"b":1,"a":2},"a":{"y":3,"x":4}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"x":4,"y":3},"z":{"a":2,"b":1}}"#).unwrap();
        assert_eq!(canonicalize_json(&a), canonicalize_json(&b));
    }

    /// A 31-char hex string must return Err with field = "trace_id".
    #[test]
    fn invalid_trace_id_length() {
        let short = "0000000000000000000000000000001"; // 31 chars
        let err = decode_hex_id::<16>(short, "trace_id").unwrap_err();
        match err {
            IngestError::InvalidField { field, reason } => {
                assert_eq!(field, "trace_id");
                assert!(
                    reason.contains("32"),
                    "reason should mention expected length 32, got: {reason}"
                );
            }
            other => panic!("expected InvalidField, got {other:?}"),
        }
    }

    /// A valid 32-char hex string must decode without error.
    #[test]
    fn valid_trace_id() {
        let id = "0123456789abcdef0123456789abcdef";
        let bytes: [u8; 16] = decode_hex_id(id, "trace_id").expect("should succeed");
        assert_eq!(hex::encode(bytes), id);
    }

    /// A 15-char hex string for span_id must return Err with field = "span_id".
    #[test]
    fn invalid_span_id_length() {
        let short = "000000000000001"; // 15 chars
        let err = decode_hex_id::<8>(short, "span_id").unwrap_err();
        match err {
            IngestError::InvalidField { field, .. } => assert_eq!(field, "span_id"),
            other => panic!("expected InvalidField, got {other:?}"),
        }
    }
}
