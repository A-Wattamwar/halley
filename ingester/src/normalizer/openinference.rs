//! OpenInference adapter (Arize / Phoenix-flavored OTLP).
//!
//! Detection: presence of `openinference.span.kind` attribute OR any `llm.model_name`
//! attribute (older instrumentations that omit the span.kind marker).
//!
//! Source of truth: https://github.com/Arize-ai/openinference/blob/main/spec/llm_spans.md
//! Verified against the live repo on 2026-05-15.
//!
//! # Attribute mapping
//!
//! | Canonical field               | OpenInference attribute              | Notes                              |
//! |-------------------------------|--------------------------------------|------------------------------------|
//! | gen_ai_system                 | `llm.system`                         | NOT `llm.provider` (live spec)     |
//! | gen_ai_operation              | `openinference.span.kind` (mapped)   | See span_kind_to_operation()       |
//! | gen_ai_request_model          | `llm.model_name`                     | OI doesn't split req/resp model    |
//! | gen_ai_response_model         | `llm.model_name`                     | Same value for both                |
//! | gen_ai_usage_input_tokens     | `llm.token_count.prompt`             |                                    |
//! | gen_ai_usage_output_tokens    | `llm.token_count.completion`         |                                    |
//! | input_body                    | `input.value` + `input.mime_type`    | JSON-parsed or text-wrapped        |
//! | output_body                   | `output.value` + `output.mime_type`  | JSON-parsed or text-wrapped        |
//! | tool_name                     | `tool.name`                          | On TOOL spans                      |
//! | tool_input                    | `tool.parameters`                    | Tool parameter schema (JSON)       |
//!
//! # `openinference.span.kind` → `gen_ai_operation` mapping
//!
//! | OI value      | canonical gen_ai_operation |
//! |---------------|---------------------------|
//! | "LLM"         | "chat"                    |
//! | "TOOL"        | "execute_tool"            |
//! | "RETRIEVER"   | "retrieve"                |
//! | "AGENT"       | "invoke_agent"            |
//! | "CHAIN"       | "invoke_agent"            | (chains are orchestration roots)
//! | "RERANKER"    | "retrieve"                |
//! | "EMBEDDING"   | "embeddings"              |
//! | anything else | passed through verbatim   |
//!
//! # Body content
//!
//! `input.value` is often a JSON string. When `input.mime_type == "application/json"`,
//! parse it as JSON; otherwise wrap as `{"text": <value>}`. Same rule for `output.value`.
//!
//! # `is_run_root` (Day 3 note)
//!
//! When wiring `is_run_root` on Day 3, set it to `true` when:
//!   - `openinference.span.kind == "AGENT"` (explicit agent root)
//!   - `openinference.span.kind == "CHAIN"` (orchestration root — same reasoning as AGENT)
//!   - `halley.run.kind == "agent"` (explicit Halley SDK override)
//!
//! Both AGENT and CHAIN map to `invoke_agent` in gen_ai_operation, so the
//! is_run_root rule follows naturally from the span kind.
//!
//! # Unknown attributes
//!
//! All `openinference.*`, `llm.*`, `input.*`, `output.*`, `tool.*`, `session.*`,
//! `user.*`, `tag.*`, `metadata` keys not explicitly consumed are preserved verbatim
//! in `CanonicalSpan.attributes`.

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

pub struct OpenInferenceAdapter;

/// Attribute keys consumed by this adapter (not passed through to `attributes`).
const CONSUMED_KEYS: &[&str] = &[
    // OpenInference span kind (the primary detection key)
    "openinference.span.kind",
    // LLM fields
    "llm.system",
    "llm.model_name",
    "llm.token_count.prompt",
    "llm.token_count.completion",
    "llm.token_count.total",
    "llm.invocation_parameters", // preserved in attributes (unknown to canonical schema)
    // Body fields
    "input.value",
    "input.mime_type",
    "output.value",
    "output.mime_type",
    // Tool fields
    "tool.name",
    "tool.parameters",
    // Halley context attributes injected by the receiver
    "halley.project_id",
    "halley.pricing_version_id",
    "halley.run_name",
    "halley.run_tags",
    "halley.run_env",
    "halley.dialect_version",
    "halley.tool_side_effect",
];

impl Adapter for OpenInferenceAdapter {
    fn dialect_id(&self) -> &'static str {
        "openinference"
    }

    /// Detect by presence of `openinference.span.kind` OR `llm.model_name`.
    ///
    /// `openinference.span.kind` is the primary marker — all current OI
    /// instrumentations set it. `llm.model_name` is a fallback for older
    /// instrumentations that may omit the span kind.
    fn detect(&self, span: &OtlpSpan) -> bool {
        span.attributes.contains_key("openinference.span.kind")
            || span.attributes.contains_key("llm.model_name")
    }

    fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError> {
        let attrs = &span.attributes;

        let str_attr = |key: &str| -> String {
            attrs
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };

        let u32_attr = |key: &str| -> u32 { attrs.get(key).and_then(|v| v.as_u32()).unwrap_or(0) };

        // gen_ai_system: OpenInference uses `llm.system` (NOT `llm.provider`).
        // Source: spec/llm_spans.md — "llm.system: The AI system/product (e.g., 'openai', 'anthropic')"
        let gen_ai_system = str_attr("llm.system");

        // gen_ai_operation: derived from openinference.span.kind.
        let span_kind = str_attr("openinference.span.kind");
        let gen_ai_operation = openinference_span_kind_to_operation(&span_kind);

        // Model: OI uses a single llm.model_name for both request and response.
        let model = str_attr("llm.model_name");

        // Token counts.
        let gen_ai_usage_input_tokens = u32_attr("llm.token_count.prompt");
        let gen_ai_usage_output_tokens = u32_attr("llm.token_count.completion");

        // Body content: input.value / output.value with mime_type-aware parsing.
        let input_body = parse_body_value(attrs.get("input.value"), attrs.get("input.mime_type"));
        let output_body =
            parse_body_value(attrs.get("output.value"), attrs.get("output.mime_type"));

        // Tool fields (present on TOOL spans).
        let tool_name = str_attr("tool.name");
        let tool_input = attrs.get("tool.parameters").map(parse_json_anyvalue);

        // Halley context attributes.
        let project_id = str_attr("halley.project_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());
        let pricing_version_id = str_attr("halley.pricing_version_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());
        let run_env = str_attr("halley.run_env");
        let tool_side_effect = str_attr("halley.tool_side_effect");
        let dialect_version = str_attr("halley.dialect_version");
        let run_tags: Vec<String> = attrs
            .get("halley.run_tags")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let run_name = str_attr("halley.run_name");

        // Status from OTLP status code.
        let status = match span.status_code {
            2 => SpanStatus::Error,
            _ => SpanStatus::Ok,
        };

        // Preserve unknown attributes verbatim.
        // Note: llm.invocation_parameters is in CONSUMED_KEYS above so it is NOT
        // passed through here. Re-add it explicitly so it lands in attributes
        // (it's unknown to the canonical schema but useful to preserve).
        let mut extra_attributes: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in &span.attributes {
            if !CONSUMED_KEYS.contains(&k.as_str()) {
                extra_attributes.insert(k.clone(), v.to_attr_string());
            }
        }
        // llm.invocation_parameters: not a canonical field, but preserve it.
        if let Some(v) = attrs.get("llm.invocation_parameters") {
            extra_attributes.insert("llm.invocation_parameters".to_string(), v.to_attr_string());
        }

        Ok(CanonicalSpan {
            trace_id: span.trace_id,
            span_id: span.span_id,
            parent_span_id: span.parent_span_id,
            start_time_unix_nano: span.start_time_unix_nano,
            end_time_unix_nano: span.end_time_unix_nano,
            source_dialect: "openinference".to_string(),
            dialect_version,
            gen_ai_system,
            gen_ai_operation: gen_ai_operation.clone(),
            gen_ai_request_model: model.clone(),
            gen_ai_response_model: model,
            gen_ai_usage_input_tokens,
            gen_ai_usage_output_tokens,
            gen_ai_response_finish_reason: String::new(), // OI does not expose finish_reason
            input_body,
            output_body,
            tool_input,
            tool_output: None, // OI tool output comes via output.value, already in output_body
            tool_name,
            tool_side_effect,
            project_id,
            run_name,
            run_tags,
            run_env,
            pricing_version_id,
            status,
            error_message: span.status_message.clone(),
            attributes: extra_attributes,
            // is_run_root: true when this span is an agent invocation root.
            // openinference rule: gen_ai_operation == "invoke_agent" (which covers
            // openinference.span.kind in {"AGENT", "CHAIN"} via the mapping above)
            // OR halley.run.kind == "agent".
            // CHAIN is included because chains are orchestration roots with the
            // same run-grouping semantics as agents. See DECISIONS.md D39.
            is_run_root: gen_ai_operation == "invoke_agent"
                || str_attr("halley.run.kind") == "agent",
        })
    }
}

/// Map `openinference.span.kind` to a canonical `gen_ai_operation` string.
///
/// Source: https://github.com/Arize-ai/openinference/blob/main/spec/llm_spans.md
///
/// AGENT and CHAIN both map to "invoke_agent" — chains are orchestration roots
/// with the same run-grouping semantics as agents. See Day 3 is_run_root note
/// in the module doc comment above.
fn openinference_span_kind_to_operation(kind: &str) -> String {
    match kind {
        "LLM" => "chat",
        "TOOL" => "execute_tool",
        "RETRIEVER" | "RERANKER" => "retrieve",
        "AGENT" | "CHAIN" => "invoke_agent",
        "EMBEDDING" => "embeddings",
        other => other, // pass through unknown values verbatim
    }
    .to_string()
}

/// Parse `input.value` / `output.value` into a `serde_json::Value`.
///
/// If `mime_type == "application/json"`, attempt to parse the value as JSON.
/// Otherwise (or if parsing fails), wrap as `{"text": <value>}`.
///
/// This handles the common OpenInference pattern where `input.value` is a
/// JSON string when `input.mime_type == "application/json"`, and a plain
/// string otherwise. See phase-2-week-4.md "Common pitfalls" #1.
fn parse_body_value(
    value: Option<&AnyValue>,
    mime_type: Option<&AnyValue>,
) -> Option<serde_json::Value> {
    let v = value?;
    let raw = v.as_str()?;
    let is_json = mime_type
        .and_then(|m| m.as_str())
        .map(|m| m == "application/json")
        .unwrap_or(false);

    if is_json {
        // Try to parse as JSON; fall back to text wrap on failure.
        serde_json::from_str(raw)
            .ok()
            .or_else(|| Some(serde_json::json!({ "text": raw })))
    } else {
        Some(serde_json::json!({ "text": raw }))
    }
}

/// Parse an `AnyValue` as a `serde_json::Value`.
/// If the value is a String that looks like JSON, parse it; otherwise use `to_json()`.
fn parse_json_anyvalue(v: &AnyValue) -> serde_json::Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| serde_json::Value::String(s.to_string()))
    } else {
        v.to_json()
    }
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::otlp_span::{AnyValue, OtlpSpan},
        normalizer::{Adapter, Normalizer},
    };
    use proptest::prelude::*;
    use std::collections::BTreeMap;

    fn arb_model_string() -> impl Strategy<Value = String> {
        prop::string::string_regex("[a-z0-9._-]{0,32}").unwrap()
    }

    fn arb_u32() -> impl Strategy<Value = u32> {
        0u32..100_000u32
    }

    /// Build a minimal OpenInference OtlpSpan.
    fn make_openinference_span(
        llm_system: &str,
        span_kind: &str,
        model: &str,
        input_tokens: u32,
        output_tokens: u32,
        extra_attrs: BTreeMap<String, AnyValue>,
    ) -> OtlpSpan {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String(span_kind.to_string()),
        );
        attrs.insert(
            "llm.system".to_string(),
            AnyValue::String(llm_system.to_string()),
        );
        attrs.insert(
            "llm.model_name".to_string(),
            AnyValue::String(model.to_string()),
        );
        attrs.insert(
            "llm.token_count.prompt".to_string(),
            AnyValue::Int(input_tokens as i64),
        );
        attrs.insert(
            "llm.token_count.completion".to_string(),
            AnyValue::Int(output_tokens as i64),
        );
        for (k, v) in extra_attrs {
            attrs.insert(k, v);
        }
        OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ChatCompletion".to_string(),
            kind: 1, // INTERNAL
            start_time_unix_nano: 1_000_000,
            end_time_unix_nano: 2_000_000,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        }
    }

    proptest! {
        /// Round-trip: arbitrary OpenInference fields survive the normalizer unchanged.
        #[test]
        fn prop_openinference_round_trip(
            llm_system in arb_model_string(),
            model in arb_model_string(),
            input_tokens in arb_u32(),
            output_tokens in arb_u32(),
        ) {
            let span = make_openinference_span(
                &llm_system,
                "LLM",
                &model,
                input_tokens,
                output_tokens,
                BTreeMap::new(),
            );

            let adapter = OpenInferenceAdapter;
            prop_assert!(adapter.detect(&span), "openinference adapter should detect the span");

            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert_eq!(&canonical.gen_ai_system, &llm_system);
            prop_assert_eq!(&canonical.gen_ai_request_model, &model);
            prop_assert_eq!(&canonical.gen_ai_response_model, &model);
            prop_assert_eq!(canonical.gen_ai_usage_input_tokens, input_tokens);
            prop_assert_eq!(canonical.gen_ai_usage_output_tokens, output_tokens);
            prop_assert_eq!(&canonical.gen_ai_operation, "chat"); // LLM → chat
            prop_assert_eq!(&canonical.source_dialect, "openinference");
        }

        /// Unknown openinference.* and other keys are preserved verbatim.
        #[test]
        fn prop_openinference_unknown_keys_preserved(
            suffix in "[a-z][a-z0-9_]{1,20}",
            value in "[a-zA-Z0-9 ]{0,50}",
        ) {
            let key = format!("openinference.{suffix}");
            let mut extra = BTreeMap::new();
            extra.insert(key.clone(), AnyValue::String(value.clone()));

            let span = make_openinference_span(
                "openai", "LLM", "gpt-4o", 10, 20, extra,
            );

            let adapter = OpenInferenceAdapter;
            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert!(
                canonical.attributes.contains_key(&key),
                "unknown openinference key {key:?} should be preserved in CanonicalSpan.attributes"
            );
            prop_assert_eq!(
                canonical.attributes.get(&key).map(|s| s.as_str()),
                Some(value.as_str())
            );
        }
    }

    /// span_kind → gen_ai_operation mapping.
    #[test]
    fn openinference_span_kind_mapping() {
        assert_eq!(openinference_span_kind_to_operation("LLM"), "chat");
        assert_eq!(openinference_span_kind_to_operation("TOOL"), "execute_tool");
        assert_eq!(
            openinference_span_kind_to_operation("RETRIEVER"),
            "retrieve"
        );
        assert_eq!(openinference_span_kind_to_operation("RERANKER"), "retrieve");
        assert_eq!(
            openinference_span_kind_to_operation("AGENT"),
            "invoke_agent"
        );
        assert_eq!(
            openinference_span_kind_to_operation("CHAIN"),
            "invoke_agent"
        );
        assert_eq!(
            openinference_span_kind_to_operation("EMBEDDING"),
            "embeddings"
        );
        assert_eq!(openinference_span_kind_to_operation("CUSTOM"), "CUSTOM");
    }

    /// Detection priority: a span with BOTH traceloop.entity.name AND
    /// openinference.span.kind resolves to "openllmetry" (openllmetry is
    /// earlier in the adapter Vec).
    #[test]
    fn detection_priority_openllmetry_beats_openinference() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "traceloop.entity.name".to_string(),
            AnyValue::String("my-agent".to_string()),
        );
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String("LLM".to_string()),
        );
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("openai".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ChatCompletion".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let normalizer = Normalizer::new();
        let canonical = normalizer.normalize(span).expect("should normalize");
        assert_eq!(
            canonical.source_dialect, "openllmetry",
            "span with both traceloop.* and openinference.* must be detected as openllmetry"
        );
    }

    /// Body parsing: JSON mime type → parsed JSON object.
    #[test]
    fn body_parsed_as_json_when_mime_is_application_json() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String("LLM".to_string()),
        );
        attrs.insert(
            "llm.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "llm.model_name".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        attrs.insert(
            "input.value".to_string(),
            AnyValue::String(r#"{"messages":[{"role":"user","content":"hello"}]}"#.to_string()),
        );
        attrs.insert(
            "input.mime_type".to_string(),
            AnyValue::String("application/json".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ChatCompletion".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OpenInferenceAdapter.normalize(span).unwrap();
        let body = canonical.input_body.unwrap();
        // Should be a JSON object, not a {"text": ...} wrapper.
        assert!(body.is_object(), "expected JSON object, got: {body}");
        assert!(
            body.get("messages").is_some(),
            "expected 'messages' key: {body}"
        );
    }

    /// Body parsing: non-JSON mime type → text-wrapped.
    #[test]
    fn body_wrapped_as_text_when_mime_is_not_json() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String("LLM".to_string()),
        );
        attrs.insert(
            "llm.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "llm.model_name".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        attrs.insert(
            "output.value".to_string(),
            AnyValue::String("The answer is 42.".to_string()),
        );
        attrs.insert(
            "output.mime_type".to_string(),
            AnyValue::String("text/plain".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ChatCompletion".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OpenInferenceAdapter.normalize(span).unwrap();
        let body = canonical.output_body.unwrap();
        // Should be {"text": "The answer is 42."}
        assert_eq!(
            body.get("text").and_then(|v| v.as_str()),
            Some("The answer is 42."),
            "expected text-wrapped body: {body}"
        );
    }

    /// llm.invocation_parameters is preserved in attributes (not a canonical field).
    #[test]
    fn llm_invocation_parameters_preserved_in_attributes() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String("LLM".to_string()),
        );
        attrs.insert(
            "llm.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "llm.model_name".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        attrs.insert(
            "llm.invocation_parameters".to_string(),
            AnyValue::String(r#"{"temperature":0.7,"max_tokens":256}"#.to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ChatCompletion".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OpenInferenceAdapter.normalize(span).unwrap();
        assert!(
            canonical
                .attributes
                .contains_key("llm.invocation_parameters"),
            "llm.invocation_parameters should be preserved in attributes"
        );
    }
}
