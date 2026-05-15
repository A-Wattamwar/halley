//! `halley-raw` adapter — near-identity normalization for the `/v1/spans/json` dialect.
//!
//! Detection: `source_dialect = "halley-raw"` attribute on the `OtlpSpan`.
//! This is set by the `/v1/spans/json` receiver before handing off to the normalizer.
//!
//! Normalization is near-identity: the `RawSpan` fields map 1:1 to `CanonicalSpan`.
//! The only transformation is that `RawSpan.attributes` (HashMap<String,String>)
//! becomes `CanonicalSpan.attributes` (BTreeMap<String,String>).
//!
//! This adapter acts as the canonical reference implementation — all other adapters
//! produce the same `CanonicalSpan` shape.

use crate::{
    domain::{
        canonical::CanonicalSpan,
        otlp_span::{AnyValue, OtlpSpan},
        span::SpanStatus,
    },
    normalizer::{Adapter, NormalizeError},
};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Attribute key set by the `/v1/spans/json` receiver to identify this dialect.
const DIALECT_ATTR: &str = "source_dialect";
const DIALECT_VALUE: &str = "halley-raw";

pub struct HalleyRawAdapter;

impl Adapter for HalleyRawAdapter {
    fn dialect_id(&self) -> &'static str {
        "halley-raw"
    }

    fn detect(&self, span: &OtlpSpan) -> bool {
        span.attributes
            .get(DIALECT_ATTR)
            .and_then(|v| v.as_str())
            .map(|s| s == DIALECT_VALUE)
            .unwrap_or(false)
    }

    fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError> {
        let attrs = &span.attributes;

        // Helper: extract a String attribute, defaulting to "".
        let str_attr = |key: &str| -> String {
            attrs
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };

        // Helper: extract a u32 attribute, defaulting to 0.
        let u32_attr = |key: &str| -> u32 { attrs.get(key).and_then(|v| v.as_u32()).unwrap_or(0) };

        // Helper: extract a JSON body from an attribute key.
        // Body fields are stored as JSON strings (serialized serde_json::Value).
        let json_attr = |key: &str| -> Option<serde_json::Value> {
            attrs.get(key).and_then(|v| {
                v.as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
                    // Fall back to to_json() for non-string AnyValue variants.
                    .or_else(|| Some(v.to_json()))
            })
        };

        // project_id and pricing_version_id are UUIDs stored as string attributes.
        let project_id = str_attr("project_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());
        let pricing_version_id = str_attr("pricing_version_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());

        // run_tags: stored as a JSON array string in attributes.
        let run_tags: Vec<String> = attrs
            .get("run_tags")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default();

        // Status: "ok" | "error" | "timeout"
        let status = match str_attr("status").as_str() {
            "error" => SpanStatus::Error,
            "timeout" => SpanStatus::Timeout,
            _ => SpanStatus::Ok,
        };

        // Collect unknown attributes — everything that is not a known halley-raw field.
        let known_keys: &[&str] = &[
            DIALECT_ATTR,
            "dialect_version",
            "run_id",
            "project_id",
            "gen_ai_system",
            "gen_ai_operation",
            "gen_ai_request_model",
            "gen_ai_response_model",
            "gen_ai_usage_input_tokens",
            "gen_ai_usage_output_tokens",
            "gen_ai_response_finish_reason",
            "input_body",
            "output_body",
            "tool_name",
            "tool_input",
            "tool_output",
            "tool_side_effect",
            "run_name",
            "run_tags",
            "run_env",
            "pricing_version_id",
            "status",
            "error_message",
        ];

        let mut extra_attributes: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in &span.attributes {
            if !known_keys.contains(&k.as_str()) {
                extra_attributes.insert(k.clone(), v.to_attr_string());
            }
        }

        Ok(CanonicalSpan {
            trace_id: span.trace_id,
            span_id: span.span_id,
            parent_span_id: span.parent_span_id,
            start_time_unix_nano: span.start_time_unix_nano,
            end_time_unix_nano: span.end_time_unix_nano,
            source_dialect: DIALECT_VALUE.to_string(),
            dialect_version: str_attr("dialect_version"),
            gen_ai_system: str_attr("gen_ai_system"),
            gen_ai_operation: str_attr("gen_ai_operation"),
            gen_ai_request_model: str_attr("gen_ai_request_model"),
            gen_ai_response_model: str_attr("gen_ai_response_model"),
            gen_ai_usage_input_tokens: u32_attr("gen_ai_usage_input_tokens"),
            gen_ai_usage_output_tokens: u32_attr("gen_ai_usage_output_tokens"),
            gen_ai_response_finish_reason: str_attr("gen_ai_response_finish_reason"),
            input_body: json_attr("input_body"),
            output_body: json_attr("output_body"),
            tool_input: json_attr("tool_input"),
            tool_output: json_attr("tool_output"),
            tool_name: str_attr("tool_name"),
            tool_side_effect: str_attr("tool_side_effect"),
            project_id,
            run_name: str_attr("run_name"),
            run_tags,
            run_env: str_attr("run_env"),
            pricing_version_id,
            status,
            error_message: str_attr("error_message"),
            attributes: extra_attributes,
            // is_run_root: true when this span is an agent invocation root.
            // halley-raw rule: gen_ai_operation == "invoke_agent" OR
            // halley.run.kind attribute == "agent".
            is_run_root: str_attr("gen_ai_operation") == "invoke_agent"
                || str_attr("halley.run.kind") == "agent",
        })
    }
}

// ---------------------------------------------------------------------------
// Helper: convert a RawSpan into an OtlpSpan for the halley-raw adapter.
// ---------------------------------------------------------------------------

/// Convert a `RawSpan` (from `/v1/spans/json`) into an `OtlpSpan` that the
/// normalizer can process.
///
/// All `RawSpan` fields are packed into the `OtlpSpan.attributes` map as
/// `AnyValue::String` (or typed variants where appropriate). The
/// `source_dialect = "halley-raw"` attribute is injected so the
/// `HalleyRawAdapter::detect()` fires.
///
/// The hex trace_id / span_id are decoded into raw bytes here.
pub fn raw_span_to_otlp(
    raw: crate::domain::span::RawSpan,
) -> Result<OtlpSpan, crate::errors::IngestError> {
    use crate::domain::span::decode_hex_id_pub;

    let trace_id = decode_hex_id_pub::<16>(&raw.trace_id, "trace_id")?;
    let span_id = decode_hex_id_pub::<8>(&raw.span_id, "span_id")?;
    let parent_span_id = raw
        .parent_span_id
        .as_deref()
        .map(|s| decode_hex_id_pub::<8>(s, "parent_span_id"))
        .transpose()?;

    let mut attrs: BTreeMap<String, AnyValue> = BTreeMap::new();

    // Inject dialect marker.
    attrs.insert(
        DIALECT_ATTR.to_string(),
        AnyValue::String(DIALECT_VALUE.to_string()),
    );

    // Identity / provenance fields.
    attrs.insert(
        "dialect_version".to_string(),
        AnyValue::String(raw.dialect_version),
    );
    attrs.insert(
        "project_id".to_string(),
        AnyValue::String(raw.project_id.to_string()),
    );
    if let Some(run_id) = raw.run_id {
        attrs.insert("run_id".to_string(), AnyValue::String(run_id));
    }

    // GenAI fields.
    attrs.insert(
        "gen_ai_system".to_string(),
        AnyValue::String(raw.gen_ai_system),
    );
    attrs.insert(
        "gen_ai_operation".to_string(),
        AnyValue::String(raw.gen_ai_operation),
    );
    attrs.insert(
        "gen_ai_request_model".to_string(),
        AnyValue::String(raw.gen_ai_request_model),
    );
    attrs.insert(
        "gen_ai_response_model".to_string(),
        AnyValue::String(raw.gen_ai_response_model),
    );
    attrs.insert(
        "gen_ai_usage_input_tokens".to_string(),
        AnyValue::Int(raw.gen_ai_usage_input_tokens as i64),
    );
    attrs.insert(
        "gen_ai_usage_output_tokens".to_string(),
        AnyValue::Int(raw.gen_ai_usage_output_tokens as i64),
    );
    attrs.insert(
        "gen_ai_response_finish_reason".to_string(),
        AnyValue::String(raw.gen_ai_response_finish_reason),
    );

    // Body fields: serialize to JSON string so the adapter can parse them back.
    if let Some(v) = raw.input_body {
        attrs.insert("input_body".to_string(), AnyValue::String(v.to_string()));
    }
    if let Some(v) = raw.output_body {
        attrs.insert("output_body".to_string(), AnyValue::String(v.to_string()));
    }
    if let Some(v) = raw.tool_input {
        attrs.insert("tool_input".to_string(), AnyValue::String(v.to_string()));
    }
    if let Some(v) = raw.tool_output {
        attrs.insert("tool_output".to_string(), AnyValue::String(v.to_string()));
    }

    // Tool / run fields.
    attrs.insert("tool_name".to_string(), AnyValue::String(raw.tool_name));
    attrs.insert(
        "tool_side_effect".to_string(),
        AnyValue::String(raw.tool_side_effect),
    );
    attrs.insert("run_name".to_string(), AnyValue::String(raw.run_name));
    // run_tags: serialize as JSON array string.
    attrs.insert(
        "run_tags".to_string(),
        AnyValue::String(serde_json::to_string(&raw.run_tags).unwrap_or_default()),
    );
    attrs.insert("run_env".to_string(), AnyValue::String(raw.run_env));
    attrs.insert(
        "pricing_version_id".to_string(),
        AnyValue::String(raw.pricing_version_id.to_string()),
    );
    attrs.insert("status".to_string(), AnyValue::String(raw.status));
    attrs.insert(
        "error_message".to_string(),
        AnyValue::String(raw.error_message),
    );

    // Pass through any extra attributes from the caller.
    for (k, v) in raw.attributes {
        attrs.entry(k).or_insert(AnyValue::String(v));
    }

    Ok(OtlpSpan {
        trace_id,
        span_id,
        parent_span_id,
        name: String::new(), // not used by halley-raw adapter
        kind: 0,
        start_time_unix_nano: raw.start_time_unix_nano,
        end_time_unix_nano: raw.end_time_unix_nano,
        attributes: attrs,
        events: vec![],
        status_code: 0,
        status_message: String::new(),
    })
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalizer::Adapter;
    use proptest::prelude::*;

    /// Arbitrary gen_ai field values for property tests.
    fn arb_gen_ai_string() -> impl Strategy<Value = String> {
        prop::string::string_regex("[a-z0-9._-]{0,32}").unwrap()
    }

    fn arb_u32() -> impl Strategy<Value = u32> {
        0u32..100_000u32
    }

    proptest! {
        /// Round-trip: arbitrary halley-raw fields survive the normalizer unchanged.
        ///
        /// Constructs a minimal RawSpan, converts to OtlpSpan, normalizes,
        /// and asserts that all gen_ai_* fields in the CanonicalSpan match
        /// the original RawSpan values.
        #[test]
        fn prop_halley_raw_round_trip(
            gen_ai_system in arb_gen_ai_string(),
            gen_ai_operation in arb_gen_ai_string(),
            gen_ai_request_model in arb_gen_ai_string(),
            gen_ai_response_model in arb_gen_ai_string(),
            input_tokens in arb_u32(),
            output_tokens in arb_u32(),
            finish_reason in arb_gen_ai_string(),
        ) {
            use crate::domain::span::RawSpan;
            use uuid::Uuid;

            let raw = RawSpan {
                trace_id: "00000000000000000000000000000001".to_string(),
                span_id: "0000000000000001".to_string(),
                parent_span_id: None,
                run_id: None,
                project_id: Uuid::nil(),
                start_time_unix_nano: 1_000_000,
                end_time_unix_nano: 2_000_000,
                source_dialect: "halley-raw".to_string(),
                dialect_version: "1.0".to_string(),
                gen_ai_system: gen_ai_system.clone(),
                gen_ai_operation: gen_ai_operation.clone(),
                gen_ai_request_model: gen_ai_request_model.clone(),
                gen_ai_response_model: gen_ai_response_model.clone(),
                gen_ai_usage_input_tokens: input_tokens,
                gen_ai_usage_output_tokens: output_tokens,
                gen_ai_response_finish_reason: finish_reason.clone(),
                input_body: None,
                output_body: None,
                tool_name: String::new(),
                tool_input: None,
                tool_output: None,
                tool_side_effect: String::new(),
                run_name: String::new(),
                run_tags: vec![],
                run_env: String::new(),
                pricing_version_id: Uuid::nil(),
                status: "ok".to_string(),
                error_message: String::new(),
                attributes: std::collections::HashMap::new(),
            };

            let otlp = raw_span_to_otlp(raw).expect("raw_span_to_otlp should not fail");
            let adapter = HalleyRawAdapter;
            prop_assert!(adapter.detect(&otlp), "halley-raw adapter should detect the span");

            let canonical = adapter.normalize(otlp).expect("normalize should not fail");

            prop_assert_eq!(&canonical.gen_ai_system, &gen_ai_system);
            prop_assert_eq!(&canonical.gen_ai_operation, &gen_ai_operation);
            prop_assert_eq!(&canonical.gen_ai_request_model, &gen_ai_request_model);
            prop_assert_eq!(&canonical.gen_ai_response_model, &gen_ai_response_model);
            prop_assert_eq!(canonical.gen_ai_usage_input_tokens, input_tokens);
            prop_assert_eq!(canonical.gen_ai_usage_output_tokens, output_tokens);
            prop_assert_eq!(&canonical.gen_ai_response_finish_reason, &finish_reason);
            prop_assert_eq!(&canonical.source_dialect, "halley-raw");
        }

        /// Unknown attributes in a halley-raw span are preserved in CanonicalSpan.attributes.
        #[test]
        fn prop_halley_raw_unknown_attrs_preserved(
            key in "[a-z][a-z0-9_.]{1,20}",
            value in "[a-zA-Z0-9 ]{0,50}",
        ) {
            use crate::domain::span::RawSpan;
            use uuid::Uuid;

            // Ensure the key is not a known halley-raw field.
            let key = format!("custom.{key}");

            let mut extra_attrs = std::collections::HashMap::new();
            extra_attrs.insert(key.clone(), value.clone());

            let raw = RawSpan {
                trace_id: "00000000000000000000000000000001".to_string(),
                span_id: "0000000000000001".to_string(),
                parent_span_id: None,
                run_id: None,
                project_id: Uuid::nil(),
                start_time_unix_nano: 1_000_000,
                end_time_unix_nano: 2_000_000,
                source_dialect: "halley-raw".to_string(),
                dialect_version: "1.0".to_string(),
                gen_ai_system: String::new(),
                gen_ai_operation: String::new(),
                gen_ai_request_model: String::new(),
                gen_ai_response_model: String::new(),
                gen_ai_usage_input_tokens: 0,
                gen_ai_usage_output_tokens: 0,
                gen_ai_response_finish_reason: String::new(),
                input_body: None,
                output_body: None,
                tool_name: String::new(),
                tool_input: None,
                tool_output: None,
                tool_side_effect: String::new(),
                run_name: String::new(),
                run_tags: vec![],
                run_env: String::new(),
                pricing_version_id: Uuid::nil(),
                status: "ok".to_string(),
                error_message: String::new(),
                attributes: extra_attrs,
            };

            let otlp = raw_span_to_otlp(raw).expect("raw_span_to_otlp should not fail");
            let adapter = HalleyRawAdapter;
            let canonical = adapter.normalize(otlp).expect("normalize should not fail");

            prop_assert!(
                canonical.attributes.contains_key(&key),
                "unknown key {key:?} should be preserved in CanonicalSpan.attributes"
            );
            prop_assert_eq!(canonical.attributes.get(&key).map(|s| s.as_str()), Some(value.as_str()));
        }
    }
}
