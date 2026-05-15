//! One-shot test that generates `ingester/fixtures/otlp-genai-trace.bin`.
//!
//! Run with:
//!   cargo test --test gen_otlp_fixture -- --nocapture
//!
//! The fixture is a protobuf-encoded `ExportTraceServiceRequest` containing
//! one OTEL GenAI span with the following attributes:
//!   - gen_ai.system = "openai"
//!   - gen_ai.operation.name = "chat"
//!   - gen_ai.request.model = "gpt-4o"
//!   - gen_ai.response.model = "gpt-4o"
//!   - gen_ai.usage.input_tokens = 42
//!   - gen_ai.usage.output_tokens = 17
//!   - gen_ai.response.finish_reasons = ["stop"]
//!
//! The fixture is deterministic (fixed trace_id, span_id, timestamps).
//! Re-run this test to regenerate if the schema changes.
//!
//! See DECISIONS.md D32.

use opentelemetry_proto::tonic::{
    collector::trace::v1::ExportTraceServiceRequest,
    common::v1::{any_value::Value, AnyValue, ArrayValue, KeyValue},
    resource::v1::Resource,
    trace::v1::{ResourceSpans, ScopeSpans, Span, Status},
};
use prost::Message;
use std::path::PathBuf;

fn make_kv(key: &str, value: Value) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue { value: Some(value) }),
    }
}

fn str_kv(key: &str, val: &str) -> KeyValue {
    make_kv(key, Value::StringValue(val.to_string()))
}

fn int_kv(key: &str, val: i64) -> KeyValue {
    make_kv(key, Value::IntValue(val))
}

fn arr_str_kv(key: &str, vals: &[&str]) -> KeyValue {
    let values = vals
        .iter()
        .map(|s| AnyValue {
            value: Some(Value::StringValue(s.to_string())),
        })
        .collect();
    make_kv(key, Value::ArrayValue(ArrayValue { values }))
}

#[test]
fn generate_otlp_genai_fixture() {
    // Fixed IDs for determinism.
    let trace_id = hex::decode("0102030405060708090a0b0c0d0e0f10").unwrap();
    let span_id = hex::decode("0102030405060708").unwrap();

    let span = Span {
        trace_id,
        span_id,
        parent_span_id: vec![],
        name: "openai.chat".to_string(),
        kind: 3, // CLIENT
        start_time_unix_nano: 1_778_655_600_000_000_000,
        end_time_unix_nano: 1_778_655_601_000_000_000,
        attributes: vec![
            str_kv("gen_ai.system", "openai"),
            str_kv("gen_ai.operation.name", "chat"),
            str_kv("gen_ai.request.model", "gpt-4o"),
            str_kv("gen_ai.response.model", "gpt-4o"),
            int_kv("gen_ai.usage.input_tokens", 42),
            int_kv("gen_ai.usage.output_tokens", 17),
            arr_str_kv("gen_ai.response.finish_reasons", &["stop"]),
        ],
        events: vec![],
        links: vec![],
        status: Some(Status {
            code: 1, // OK
            message: String::new(),
        }),
        ..Default::default()
    };

    let scope_spans = ScopeSpans {
        scope: None,
        spans: vec![span],
        schema_url: String::new(),
    };

    let resource_spans = ResourceSpans {
        resource: Some(Resource {
            attributes: vec![str_kv("service.name", "halley-test")],
            dropped_attributes_count: 0,
        }),
        scope_spans: vec![scope_spans],
        schema_url: String::new(),
    };

    let request = ExportTraceServiceRequest {
        resource_spans: vec![resource_spans],
    };

    // Serialize to protobuf bytes.
    let mut buf = Vec::new();
    request.encode(&mut buf).expect("encode should not fail");

    // Write to fixtures directory.
    let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    std::fs::create_dir_all(&fixtures_dir).expect("create fixtures dir");
    let out_path = fixtures_dir.join("otlp-genai-trace.bin");
    std::fs::write(&out_path, &buf).expect("write fixture");

    println!("Wrote {} bytes to {}", buf.len(), out_path.display());

    // Sanity check: round-trip decode.
    let decoded = ExportTraceServiceRequest::decode(buf.as_slice()).expect("decode should work");
    assert_eq!(decoded.resource_spans.len(), 1);
    let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
    assert_eq!(span.name, "openai.chat");
    let sys_attr = span
        .attributes
        .iter()
        .find(|kv| kv.key == "gen_ai.system")
        .unwrap();
    assert_eq!(
        sys_attr.value.as_ref().unwrap().value,
        Some(Value::StringValue("openai".to_string()))
    );
    println!("Round-trip decode OK");
}

/// Generate `ingester/fixtures/otlp-openllmetry-trace.bin`.
///
/// One span carrying both gen_ai.* and traceloop.* attributes.
/// This fixture is used by the Day 4 smoke test assertion.
///
/// See DECISIONS.md D32.
#[test]
fn generate_otlp_openllmetry_fixture() {
    // Fixed IDs for determinism (different from the otel-genai fixture).
    let trace_id = hex::decode("1112131415161718191a1b1c1d1e1f20").unwrap();
    let span_id = hex::decode("1112131415161718").unwrap();

    let span = Span {
        trace_id,
        span_id,
        parent_span_id: vec![],
        name: "openai.chat".to_string(),
        kind: 3, // CLIENT
        start_time_unix_nano: 1_778_655_600_000_000_000,
        end_time_unix_nano: 1_778_655_601_000_000_000,
        attributes: vec![
            // gen_ai.* attributes (OpenLLMetry emits these too)
            str_kv("gen_ai.system", "openai"),
            str_kv("gen_ai.operation.name", "chat"),
            str_kv("gen_ai.request.model", "gpt-4o"),
            str_kv("gen_ai.response.model", "gpt-4o"),
            int_kv("gen_ai.usage.input_tokens", 55),
            int_kv("gen_ai.usage.output_tokens", 23),
            arr_str_kv("gen_ai.response.finish_reasons", &["stop"]),
            // traceloop.* attributes (OpenLLMetry-specific)
            str_kv("traceloop.entity.name", "test-run"),
            str_kv("traceloop.workflow.name", "demo"),
            str_kv("traceloop.span.kind", "llm"),
        ],
        events: vec![],
        links: vec![],
        status: Some(Status {
            code: 1, // OK
            message: String::new(),
        }),
        ..Default::default()
    };

    let scope_spans = ScopeSpans {
        scope: None,
        spans: vec![span],
        schema_url: String::new(),
    };

    let resource_spans = ResourceSpans {
        resource: Some(Resource {
            attributes: vec![str_kv("service.name", "halley-test-openllmetry")],
            dropped_attributes_count: 0,
        }),
        scope_spans: vec![scope_spans],
        schema_url: String::new(),
    };

    let request = ExportTraceServiceRequest {
        resource_spans: vec![resource_spans],
    };

    let mut buf = Vec::new();
    request.encode(&mut buf).expect("encode should not fail");

    let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    std::fs::create_dir_all(&fixtures_dir).expect("create fixtures dir");
    let out_path = fixtures_dir.join("otlp-openllmetry-trace.bin");
    std::fs::write(&out_path, &buf).expect("write fixture");

    println!("Wrote {} bytes to {}", buf.len(), out_path.display());

    // Sanity check: round-trip decode.
    let decoded = ExportTraceServiceRequest::decode(buf.as_slice()).expect("decode should work");
    let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
    let entity_name = span
        .attributes
        .iter()
        .find(|kv| kv.key == "traceloop.entity.name")
        .unwrap();
    assert_eq!(
        entity_name.value.as_ref().unwrap().value,
        Some(Value::StringValue("test-run".to_string()))
    );
    println!("Round-trip decode OK");
}
