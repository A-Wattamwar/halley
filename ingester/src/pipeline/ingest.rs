//! Shared OTLP ingest logic used by both the HTTP and gRPC receivers.
//!
//! Both `http/otlp.rs` and `grpc/otlp.rs` call `ingest_otlp_request()` to
//! avoid duplicating the ResourceSpans → ScopeSpans → Span iteration loop.
//!
//! The function is intentionally thin: it iterates the request, converts each
//! prost `Span` to `OtlpSpan`, normalizes, hashes, and publishes. Errors on
//! individual spans are logged and counted but do not abort the batch.

use crate::{
    domain::otlp_span::{AnyValue as HalleyAnyValue, OtlpEvent, OtlpSpan},
    errors::IngestError,
    normalizer::{NormalizeError, Normalizer},
    pipeline::publisher::Publisher,
};
use metrics::counter;
use opentelemetry_proto::tonic::{
    collector::trace::v1::ExportTraceServiceRequest,
    common::v1::{any_value::Value as ProtoValue, AnyValue as ProtoAnyValue, KeyValue},
    trace::v1::Span as ProtoSpan,
};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::warn;

use uuid::Uuid;

/// Process an `ExportTraceServiceRequest`: iterate all spans, normalize, hash, publish.
///
/// Returns `(accepted, errors)` counts. Individual span errors are logged but
/// do not abort the batch — the caller decides how to surface them.
pub async fn ingest_otlp_request(
    request: ExportTraceServiceRequest,
    normalizer: &Arc<Normalizer>,
    publisher: &Arc<Mutex<Publisher>>,
    project_id: Uuid,
) -> (u32, u32) {
    let mut accepted = 0u32;
    let mut errors = 0u32;

    for resource_spans in request.resource_spans {
        for scope_spans in resource_spans.scope_spans {
            for proto_span in scope_spans.spans {
                match process_one_span(proto_span, normalizer, publisher, project_id).await {
                    Ok(()) => accepted += 1,
                    Err(e) => {
                        warn!(error = %e, "OTLP span processing failed");
                        // Count rejected spans with dialect "unknown" (we don't know
                        // the dialect if normalization failed before we could read it).
                        counter!("halley_ingest_requests_total",
                            "dialect" => "unknown", "status" => "error")
                        .increment(1);
                        errors += 1;
                    }
                }
            }
        }
    }

    (accepted, errors)
}

/// Process a single prost `Span`: convert → normalize → hash → publish.
async fn process_one_span(
    proto_span: ProtoSpan,
    normalizer: &Arc<Normalizer>,
    publisher: &Arc<Mutex<Publisher>>,
    project_id: Uuid,
) -> Result<(), IngestError> {
    let otlp_span = proto_span_to_otlp(proto_span);

    let mut canonical = normalizer.normalize(otlp_span).map_err(|e| match e {
        NormalizeError::UnknownDialect => IngestError::InvalidField {
            field: "span",
            reason: "unknown dialect: no adapter matched".to_string(),
        },
        NormalizeError::Failed(msg) => IngestError::InvalidField {
            field: "span",
            reason: format!("normalize failed: {msg}"),
        },
    })?;

    // Phase 4 Day 4: Overwrite the project_id from the payload with the one
    // resolved from the API key. This prevents project impersonation.
    canonical.project_id = project_id;

    // Emit metrics after successful normalization.
    let dialect = canonical.source_dialect.clone();
    let unknown_attr_count = canonical.attributes.len() as u64;

    let (obs_row, body_rows) = canonical.into_rows()?;

    publisher
        .lock()
        .await
        .publish(&obs_row, &body_rows)
        .await
        .map_err(|e| IngestError::Storage(format!("publish error: {e}")))?;

    // Count accepted span.
    counter!("halley_ingest_requests_total", "dialect" => dialect.clone(), "status" => "ok")
        .increment(1);
    // Count unknown attributes preserved (one increment per attribute per span).
    if unknown_attr_count > 0 {
        counter!("halley_normalizer_unknown_attributes_total", "dialect" => dialect)
            .increment(unknown_attr_count);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Conversion: prost Span → hand-rolled OtlpSpan
// (shared between HTTP and gRPC receivers)
// ---------------------------------------------------------------------------

/// Convert a prost-generated `Span` into our hand-rolled `OtlpSpan`.
/// This is the boundary between the protobuf world and the normalizer world.
pub fn proto_span_to_otlp(span: ProtoSpan) -> OtlpSpan {
    let trace_id = bytes_to_array_16(&span.trace_id);
    let span_id = bytes_to_array_8(&span.span_id);
    let parent_span_id = if span.parent_span_id.is_empty() {
        None
    } else {
        Some(bytes_to_array_8(&span.parent_span_id))
    };

    let attributes = kvlist_to_btree(span.attributes);
    let events = span
        .events
        .into_iter()
        .map(|e| OtlpEvent {
            name: e.name,
            time_unix_nano: e.time_unix_nano,
            attributes: kvlist_to_btree(e.attributes),
        })
        .collect();

    let status_code = span.status.as_ref().map(|s| s.code).unwrap_or(0);
    let status_message = span
        .status
        .as_ref()
        .map(|s| s.message.clone())
        .unwrap_or_default();

    OtlpSpan {
        trace_id,
        span_id,
        parent_span_id,
        name: span.name,
        kind: span.kind,
        start_time_unix_nano: span.start_time_unix_nano,
        end_time_unix_nano: span.end_time_unix_nano,
        attributes,
        events,
        status_code,
        status_message,
    }
}

/// Convert a `Vec<KeyValue>` into a `BTreeMap<String, HalleyAnyValue>`.
pub fn kvlist_to_btree(kvs: Vec<KeyValue>) -> BTreeMap<String, HalleyAnyValue> {
    kvs.into_iter()
        .filter_map(|kv| {
            kv.value
                .and_then(proto_anyvalue_to_halley)
                .map(|v| (kv.key, v))
        })
        .collect()
}

/// Convert a prost `AnyValue` into our `HalleyAnyValue`.
pub fn proto_anyvalue_to_halley(av: ProtoAnyValue) -> Option<HalleyAnyValue> {
    match av.value? {
        ProtoValue::StringValue(s) => Some(HalleyAnyValue::String(s)),
        ProtoValue::BoolValue(b) => Some(HalleyAnyValue::Bool(b)),
        ProtoValue::IntValue(i) => Some(HalleyAnyValue::Int(i)),
        ProtoValue::DoubleValue(d) => Some(HalleyAnyValue::Double(d)),
        ProtoValue::BytesValue(b) => Some(HalleyAnyValue::Bytes(b)),
        ProtoValue::ArrayValue(arr) => {
            let values = arr
                .values
                .into_iter()
                .filter_map(proto_anyvalue_to_halley)
                .collect();
            Some(HalleyAnyValue::Array(values))
        }
        ProtoValue::KvlistValue(kvlist) => {
            let map = kvlist
                .values
                .into_iter()
                .filter_map(|kv| {
                    kv.value
                        .and_then(proto_anyvalue_to_halley)
                        .map(|v| (kv.key, v))
                })
                .collect();
            Some(HalleyAnyValue::Kvlist(map))
        }
    }
}

fn bytes_to_array_16(b: &[u8]) -> [u8; 16] {
    let mut arr = [0u8; 16];
    let len = b.len().min(16);
    arr[..len].copy_from_slice(&b[..len]);
    arr
}

fn bytes_to_array_8(b: &[u8]) -> [u8; 8] {
    let mut arr = [0u8; 8];
    let len = b.len().min(8);
    arr[..len].copy_from_slice(&b[..len]);
    arr
}
