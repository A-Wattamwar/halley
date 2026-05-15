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

/// Generate `ingester/fixtures/otlp-openinference-trace.bin`.
///
/// One span carrying OpenInference attributes:
///   - openinference.span.kind = "LLM"
///   - llm.system = "openai"
///   - llm.model_name = "gpt-4o"
///   - llm.token_count.prompt = 30
///   - llm.token_count.completion = 12
///   - input.value = JSON string
///   - input.mime_type = "application/json"
///   - output.value = plain text
///   - output.mime_type = "text/plain"
///
/// See DECISIONS.md D32.
#[test]
fn generate_otlp_openinference_fixture() {
    // Fixed IDs for determinism (different from the other fixtures).
    let trace_id = hex::decode("2122232425262728292a2b2c2d2e2f30").unwrap();
    let span_id = hex::decode("2122232425262728").unwrap();

    let span = Span {
        trace_id,
        span_id,
        parent_span_id: vec![],
        name: "ChatCompletion".to_string(),
        kind: 1, // INTERNAL
        start_time_unix_nano: 1_778_655_600_000_000_000,
        end_time_unix_nano: 1_778_655_601_000_000_000,
        attributes: vec![
            // OpenInference-specific attributes
            str_kv("openinference.span.kind", "LLM"),
            str_kv("llm.system", "openai"),
            str_kv("llm.model_name", "gpt-4o"),
            int_kv("llm.token_count.prompt", 30),
            int_kv("llm.token_count.completion", 12),
            int_kv("llm.token_count.total", 42),
            str_kv(
                "input.value",
                r#"{"messages":[{"role":"user","content":"What is 2+2?"}]}"#,
            ),
            str_kv("input.mime_type", "application/json"),
            str_kv("output.value", "2+2 equals 4."),
            str_kv("output.mime_type", "text/plain"),
            str_kv(
                "llm.invocation_parameters",
                r#"{"model":"gpt-4o","temperature":0.0}"#,
            ),
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
            attributes: vec![str_kv("service.name", "halley-test-openinference")],
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
    let out_path = fixtures_dir.join("otlp-openinference-trace.bin");
    std::fs::write(&out_path, &buf).expect("write fixture");

    println!("Wrote {} bytes to {}", buf.len(), out_path.display());

    // Sanity check: round-trip decode.
    let decoded = ExportTraceServiceRequest::decode(buf.as_slice()).expect("decode should work");
    let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
    let kind_attr = span
        .attributes
        .iter()
        .find(|kv| kv.key == "openinference.span.kind")
        .unwrap();
    assert_eq!(
        kind_attr.value.as_ref().unwrap().value,
        Some(Value::StringValue("LLM".to_string()))
    );
    println!("Round-trip decode OK");
}

/// Generate `ingester/fixtures/otlp-vercel-ai-trace.bin`.
///
/// One span carrying Vercel AI SDK attributes (ai.generateText outer span shape):
///   - ai.operationId = "ai.generateText"
///   - ai.model.provider = "openai"
///   - ai.model.id = "gpt-4o"
///   - ai.usage.promptTokens = 25
///   - ai.usage.completionTokens = 10
///   - ai.prompt = JSON string
///   - ai.response.text = plain text
///   - ai.response.finishReason = "stop"
///
/// See DECISIONS.md D32.
#[test]
fn generate_otlp_vercel_ai_fixture() {
    // Fixed IDs for determinism (different from the other fixtures).
    let trace_id = hex::decode("3132333435363738393a3b3c3d3e3f40").unwrap();
    let span_id = hex::decode("3132333435363738").unwrap();

    let span = Span {
        trace_id,
        span_id,
        parent_span_id: vec![],
        name: "ai.generateText".to_string(),
        kind: 1, // INTERNAL
        start_time_unix_nano: 1_778_655_600_000_000_000,
        end_time_unix_nano: 1_778_655_601_000_000_000,
        attributes: vec![
            // Vercel AI SDK ai.* attributes
            str_kv("ai.operationId", "ai.generateText"),
            str_kv("ai.model.provider", "openai"),
            str_kv("ai.model.id", "gpt-4o"),
            int_kv("ai.usage.promptTokens", 25),
            int_kv("ai.usage.completionTokens", 10),
            str_kv(
                "ai.prompt",
                r#"{"messages":[{"role":"user","content":"What is 6 times 7?"}]}"#,
            ),
            str_kv("ai.response.text", "6 times 7 is 42."),
            str_kv("ai.response.finishReason", "stop"),
            str_kv("ai.telemetry.functionId", "halley-test-fn"),
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
            attributes: vec![str_kv("service.name", "halley-test-vercel-ai")],
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
    let out_path = fixtures_dir.join("otlp-vercel-ai-trace.bin");
    std::fs::write(&out_path, &buf).expect("write fixture");

    println!("Wrote {} bytes to {}", buf.len(), out_path.display());

    // Sanity check: round-trip decode.
    let decoded = ExportTraceServiceRequest::decode(buf.as_slice()).expect("decode should work");
    let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
    let op_id = span
        .attributes
        .iter()
        .find(|kv| kv.key == "ai.operationId")
        .unwrap();
    assert_eq!(
        op_id.value.as_ref().unwrap().value,
        Some(Value::StringValue("ai.generateText".to_string()))
    );
    println!("Round-trip decode OK");
}
