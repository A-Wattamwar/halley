//! Hand-rolled intermediate span type that all receiver layers populate.
//!
// ... (doc comment continues)

// Fields `name`, `kind`, `time_unix_nano` are used by the OTLP HTTP/gRPC
// receivers added on Days 3 and 5. AnyValue variants beyond String/Int are
// used by those receivers too. Suppress dead_code for this module.
#![allow(dead_code)]
//! # Why hand-rolled instead of using prost-generated types?
//!
//! The normalizer trait takes `OtlpSpan` as input. If we used the prost-generated
//! `opentelemetry_proto::tonic::trace::v1::Span` directly, the normalizer would
//! be coupled to the protobuf crate and property tests would need to construct
//! prost types — awkward and fragile. A hand-rolled struct:
//!   - Decouples the normalizer from the wire format (HTTP protobuf, HTTP JSON,
//!     gRPC all produce the same `OtlpSpan`).
//!   - Makes property tests trivial: generate arbitrary `OtlpSpan` values with
//!     proptest without touching prost.
//!   - Mirrors the OTLP data model exactly where we need it, nothing more.
//!
//! See DECISIONS.md D27 (adapter detection priority) for how this type flows
//! through the normalizer.
//!
//! # Field notes
//!
//! - `trace_id` / `span_id` / `parent_span_id`: raw bytes as OTLP sends them
//!   (16 bytes, 8 bytes, 8 bytes). The halley-raw adapter converts hex strings
//!   from `RawSpan` into these byte arrays before handing off to the normalizer.
//! - `attributes`: `BTreeMap<String, AnyValue>` — sorted for determinism.
//!   Unknown keys are preserved verbatim into `CanonicalSpan.attributes`.
//! - `events`: span events per the OTLP spec. The OTEL GenAI adapter reads
//!   `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.choice` events
//!   to extract body content.

use std::collections::BTreeMap;

/// Intermediate span type. All receiver layers (HTTP JSON, OTLP HTTP, OTLP gRPC)
/// convert their wire format into this struct before passing to the normalizer.
///
/// Mirrors the OTLP Span data model at the fields we care about.
/// Fields we do not use (links, dropped_attributes_count, etc.) are omitted.
#[derive(Debug, Clone)]
pub struct OtlpSpan {
    /// 16-byte trace ID (OTLP wire size).
    pub trace_id: [u8; 16],
    /// 8-byte span ID (OTLP wire size).
    pub span_id: [u8; 8],
    /// 8-byte parent span ID, or None for root spans.
    pub parent_span_id: Option<[u8; 8]>,
    /// Span name (e.g. "openai.chat", "ChatOpenAI").
    pub name: String,
    /// OTLP SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
    pub kind: i32,
    /// Start time in nanoseconds since Unix epoch.
    pub start_time_unix_nano: u64,
    /// End time in nanoseconds since Unix epoch.
    pub end_time_unix_nano: u64,
    /// Span attributes. BTreeMap for deterministic iteration order.
    pub attributes: BTreeMap<String, AnyValue>,
    /// Span events (e.g. gen_ai.user.message, gen_ai.choice).
    pub events: Vec<OtlpEvent>,
    /// OTLP status code: 0=UNSET, 1=OK, 2=ERROR.
    pub status_code: i32,
    /// Status message (populated on error).
    pub status_message: String,
}

/// A single span event.
#[derive(Debug, Clone)]
pub struct OtlpEvent {
    /// Event name (e.g. "gen_ai.user.message", "gen_ai.choice").
    pub name: String,
    /// Event timestamp in nanoseconds since Unix epoch.
    pub time_unix_nano: u64,
    /// Event attributes.
    pub attributes: BTreeMap<String, AnyValue>,
}

/// OTLP AnyValue — mirrors the protobuf `oneof value` in `opentelemetry.proto.common.v1.AnyValue`.
///
/// We define our own enum rather than using the prost-generated type so that:
///   1. The normalizer is decoupled from the protobuf crate.
///   2. Property tests can generate arbitrary `AnyValue` without prost.
///   3. The HTTP JSON receiver can deserialize directly into this type.
#[derive(Debug, Clone, PartialEq)]
pub enum AnyValue {
    String(String),
    Bool(bool),
    Int(i64),
    Double(f64),
    Bytes(Vec<u8>),
    Array(Vec<AnyValue>),
    Kvlist(BTreeMap<String, AnyValue>),
}

impl AnyValue {
    /// Extract as `&str` if this is a String variant.
    pub fn as_str(&self) -> Option<&str> {
        if let AnyValue::String(s) = self {
            Some(s.as_str())
        } else {
            None
        }
    }

    /// Extract as `i64` if this is an Int variant.
    pub fn as_int(&self) -> Option<i64> {
        if let AnyValue::Int(i) = self {
            Some(*i)
        } else {
            None
        }
    }

    /// Extract as `u32`, clamping negative values to 0.
    pub fn as_u32(&self) -> Option<u32> {
        self.as_int().map(|i| i.max(0) as u32)
    }

    /// Convert to a `serde_json::Value` for body extraction.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            AnyValue::String(s) => serde_json::Value::String(s.clone()),
            AnyValue::Bool(b) => serde_json::Value::Bool(*b),
            AnyValue::Int(i) => serde_json::Value::Number((*i).into()),
            AnyValue::Double(f) => serde_json::json!(*f),
            AnyValue::Bytes(b) => serde_json::Value::String(hex::encode(b)),
            AnyValue::Array(arr) => {
                serde_json::Value::Array(arr.iter().map(|v| v.to_json()).collect())
            }
            AnyValue::Kvlist(map) => {
                let obj: serde_json::Map<String, serde_json::Value> =
                    map.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
                serde_json::Value::Object(obj)
            }
        }
    }

    /// Convert to a display string for use in `CanonicalSpan.attributes`.
    /// Arrays and Kvlists are JSON-serialized.
    pub fn to_attr_string(&self) -> String {
        match self {
            AnyValue::String(s) => s.clone(),
            AnyValue::Bool(b) => b.to_string(),
            AnyValue::Int(i) => i.to_string(),
            AnyValue::Double(f) => f.to_string(),
            AnyValue::Bytes(b) => hex::encode(b),
            other => serde_json::to_string(&other.to_json()).unwrap_or_default(),
        }
    }
}
