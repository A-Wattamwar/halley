//! OTEL GenAI semantic conventions adapter.
//!
//! Detection: presence of `gen_ai.system` OR `gen_ai.provider.name` attribute.
//! (`gen_ai.system` is the pre-1.36 name; `gen_ai.provider.name` is current.
//! Both are accepted. See docs/research/otel-genai-semconv.md.)
//!
//! # Attribute mapping
//!
//! | Canonical field                  | OTEL GenAI attribute (current)     | Legacy fallback         |
//! |----------------------------------|------------------------------------|-------------------------|
//! | gen_ai_system                    | gen_ai.provider.name               | gen_ai.system           |
//! | gen_ai_operation                 | gen_ai.operation.name              | —                       |
//! | gen_ai_request_model             | gen_ai.request.model               | —                       |
//! | gen_ai_response_model            | gen_ai.response.model              | —                       |
//! | gen_ai_usage_input_tokens        | gen_ai.usage.input_tokens          | —                       |
//! | gen_ai_usage_output_tokens       | gen_ai.usage.output_tokens         | —                       |
//! | gen_ai_response_finish_reason    | gen_ai.response.finish_reasons[0]  | gen_ai.response.finish_reason (singular) |
//!
//! # Body content extraction precedence
//!
//! Content can live in span events OR attributes depending on instrumentation version.
//! Precedence (events first, attributes fallback):
//!
//! 1. **Span events** (current spec, opt-in):
//!    - `input_body`: assembled from `gen_ai.user.message`, `gen_ai.system.message` events.
//!    - `output_body`: assembled from `gen_ai.assistant.message`, `gen_ai.choice` events.
//!
//! 2. **Attributes** (older instrumentations, fallback):
//!    - `input_body`: `gen_ai.input.messages` attribute (JSON string).
//!    - `output_body`: `gen_ai.output.messages` attribute (JSON string).
//!
//! Tool spans (`gen_ai.operation.name = "execute_tool"`):
//!    - `tool_name`: `gen_ai.tool.name`
//!    - `tool_input`: `gen_ai.tool.call.arguments` (JSON)
//!    - `tool_output`: `gen_ai.tool.call.result` (JSON)
//!
//! Unknown attributes (anything not in the mapping table above) are preserved
//! verbatim in `CanonicalSpan.attributes`.

use crate::{
    domain::{
        canonical::CanonicalSpan,
        otlp_span::{AnyValue, OtlpEvent, OtlpSpan},
        span::SpanStatus,
    },
    normalizer::{Adapter, NormalizeError},
};
use std::collections::BTreeMap;
use uuid::Uuid;

pub struct OtelGenAiAdapter;

/// Attribute keys consumed by this adapter (not passed through to `attributes`).
const CONSUMED_KEYS: &[&str] = &[
    "gen_ai.system",
    "gen_ai.provider.name",
    "gen_ai.operation.name",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.response.finish_reasons",
    "gen_ai.response.finish_reason",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.name",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    // Halley-specific context attributes injected by the receiver.
    "halley.project_id",
    "halley.pricing_version_id",
    "halley.run_name",
    "halley.run_tags",
    "halley.run_env",
    "halley.dialect_version",
    "halley.tool_side_effect",
];

impl Adapter for OtelGenAiAdapter {
    fn dialect_id(&self) -> &'static str {
        "otel-genai"
    }

    fn detect(&self, span: &OtlpSpan) -> bool {
        span.attributes.contains_key("gen_ai.system")
            || span.attributes.contains_key("gen_ai.provider.name")
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

        // gen_ai_system: prefer current name, fall back to legacy.
        let gen_ai_system = {
            let current = str_attr("gen_ai.provider.name");
            if current.is_empty() {
                str_attr("gen_ai.system")
            } else {
                current
            }
        };

        // gen_ai_response_finish_reason: prefer array (current), fall back to singular (legacy).
        let gen_ai_response_finish_reason = {
            if let Some(AnyValue::Array(arr)) = attrs.get("gen_ai.response.finish_reasons") {
                arr.first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                str_attr("gen_ai.response.finish_reason")
            }
        };

        // Body content: events first, then attributes.
        let (input_body, output_body) = extract_bodies(&span.events, attrs);

        // Tool fields.
        let tool_name = str_attr("gen_ai.tool.name");
        let tool_input = attrs
            .get("gen_ai.tool.call.arguments")
            .map(parse_json_anyvalue);
        let tool_output = attrs
            .get("gen_ai.tool.call.result")
            .map(parse_json_anyvalue);

        // Halley context attributes (injected by the OTLP receiver for project routing).
        let project_id = str_attr("halley.project_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());
        let pricing_version_id = str_attr("halley.pricing_version_id")
            .parse::<Uuid>()
            .unwrap_or(Uuid::nil());
        let run_name = str_attr("halley.run_name");
        let run_tags: Vec<String> = attrs
            .get("halley.run_tags")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let run_env = str_attr("halley.run_env");
        let tool_side_effect = str_attr("halley.tool_side_effect");
        let dialect_version = str_attr("halley.dialect_version");

        // Status from OTLP status code.
        let status = match span.status_code {
            2 => SpanStatus::Error,
            _ => SpanStatus::Ok,
        };

        // Preserve unknown attributes verbatim.
        let mut extra_attributes: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in &span.attributes {
            if !CONSUMED_KEYS.contains(&k.as_str()) {
                extra_attributes.insert(k.clone(), v.to_attr_string());
            }
        }

        Ok(CanonicalSpan {
            trace_id: span.trace_id,
            span_id: span.span_id,
            parent_span_id: span.parent_span_id,
            start_time_unix_nano: span.start_time_unix_nano,
            end_time_unix_nano: span.end_time_unix_nano,
            source_dialect: "otel-genai".to_string(),
            dialect_version,
            gen_ai_system,
            gen_ai_operation: str_attr("gen_ai.operation.name"),
            gen_ai_request_model: str_attr("gen_ai.request.model"),
            gen_ai_response_model: str_attr("gen_ai.response.model"),
            gen_ai_usage_input_tokens: u32_attr("gen_ai.usage.input_tokens"),
            gen_ai_usage_output_tokens: u32_attr("gen_ai.usage.output_tokens"),
            gen_ai_response_finish_reason,
            input_body,
            output_body,
            tool_input,
            tool_output,
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
            // otel-genai rule: gen_ai.operation.name == "invoke_agent" OR
            // halley.run.kind == "agent".
            is_run_root: str_attr("gen_ai.operation.name") == "invoke_agent"
                || str_attr("halley.run.kind") == "agent",
        })
    }
}

/// Extract input_body and output_body from span events and/or attributes.
///
/// # Precedence (events first, attributes fallback)
///
/// Events (current spec, opt-in via OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT):
/// - input_body: assembled from gen_ai.user.message + gen_ai.system.message events.
/// - output_body: assembled from gen_ai.assistant.message + gen_ai.choice events.
///
/// Attributes (older instrumentations):
/// - input_body: gen_ai.input.messages (JSON string)
/// - output_body: gen_ai.output.messages (JSON string)
fn extract_bodies(
    events: &[OtlpEvent],
    attrs: &BTreeMap<String, AnyValue>,
) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    // Collect input messages from events.
    let mut input_messages: Vec<serde_json::Value> = Vec::new();
    let mut output_messages: Vec<serde_json::Value> = Vec::new();

    for event in events {
        match event.name.as_str() {
            "gen_ai.user.message" | "gen_ai.system.message" => {
                // Build a message object from event attributes.
                let role = event
                    .attributes
                    .get("gen_ai.system")
                    .or_else(|| event.attributes.get("role"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(if event.name == "gen_ai.system.message" {
                        "system"
                    } else {
                        "user"
                    });
                let content = event
                    .attributes
                    .get("gen_ai.event.content")
                    .or_else(|| event.attributes.get("content"))
                    .map(|v| v.to_json())
                    .unwrap_or(serde_json::Value::Null);
                input_messages.push(serde_json::json!({ "role": role, "content": content }));
            }
            "gen_ai.assistant.message" | "gen_ai.choice" => {
                let content = event
                    .attributes
                    .get("gen_ai.event.content")
                    .or_else(|| event.attributes.get("content"))
                    .map(|v| v.to_json())
                    .unwrap_or(serde_json::Value::Null);
                output_messages
                    .push(serde_json::json!({ "role": "assistant", "content": content }));
            }
            _ => {}
        }
    }

    let input_body = if !input_messages.is_empty() {
        Some(serde_json::Value::Array(input_messages))
    } else {
        // Fallback: gen_ai.input.messages attribute (JSON string).
        attrs
            .get("gen_ai.input.messages")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
    };

    let output_body = if !output_messages.is_empty() {
        Some(serde_json::Value::Array(output_messages))
    } else {
        // Fallback: gen_ai.output.messages attribute (JSON string).
        attrs
            .get("gen_ai.output.messages")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
    };

    (input_body, output_body)
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
        domain::otlp_span::{AnyValue, OtlpEvent, OtlpSpan},
        normalizer::Adapter,
    };
    use proptest::prelude::*;
    use std::collections::BTreeMap;

    fn arb_gen_ai_string() -> impl Strategy<Value = String> {
        prop::string::string_regex("[a-z0-9._-]{0,32}").unwrap()
    }

    fn arb_u32() -> impl Strategy<Value = u32> {
        0u32..100_000u32
    }

    /// Build a minimal OtlpSpan with gen_ai.system set (triggers detection).
    #[allow(clippy::too_many_arguments)]
    fn make_otel_genai_span(
        gen_ai_system: &str,
        gen_ai_operation: &str,
        request_model: &str,
        response_model: &str,
        input_tokens: u32,
        output_tokens: u32,
        finish_reason: &str,
        extra_attrs: BTreeMap<String, AnyValue>,
    ) -> OtlpSpan {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String(gen_ai_system.to_string()),
        );
        attrs.insert(
            "gen_ai.operation.name".to_string(),
            AnyValue::String(gen_ai_operation.to_string()),
        );
        attrs.insert(
            "gen_ai.request.model".to_string(),
            AnyValue::String(request_model.to_string()),
        );
        attrs.insert(
            "gen_ai.response.model".to_string(),
            AnyValue::String(response_model.to_string()),
        );
        attrs.insert(
            "gen_ai.usage.input_tokens".to_string(),
            AnyValue::Int(input_tokens as i64),
        );
        attrs.insert(
            "gen_ai.usage.output_tokens".to_string(),
            AnyValue::Int(output_tokens as i64),
        );
        attrs.insert(
            "gen_ai.response.finish_reasons".to_string(),
            AnyValue::Array(vec![AnyValue::String(finish_reason.to_string())]),
        );
        for (k, v) in extra_attrs {
            attrs.insert(k, v);
        }
        OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "openai.chat".to_string(),
            kind: 3,
            start_time_unix_nano: 1_000_000,
            end_time_unix_nano: 2_000_000,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        }
    }

    proptest! {
        /// Round-trip: arbitrary OTEL GenAI fields survive the normalizer unchanged.
        #[test]
        fn prop_otel_genai_round_trip(
            gen_ai_system in arb_gen_ai_string(),
            gen_ai_operation in arb_gen_ai_string(),
            request_model in arb_gen_ai_string(),
            response_model in arb_gen_ai_string(),
            input_tokens in arb_u32(),
            output_tokens in arb_u32(),
            finish_reason in arb_gen_ai_string(),
        ) {
            let span = make_otel_genai_span(
                &gen_ai_system,
                &gen_ai_operation,
                &request_model,
                &response_model,
                input_tokens,
                output_tokens,
                &finish_reason,
                BTreeMap::new(),
            );

            let adapter = OtelGenAiAdapter;
            prop_assert!(adapter.detect(&span), "otel-genai adapter should detect the span");

            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert_eq!(&canonical.gen_ai_system, &gen_ai_system);
            prop_assert_eq!(&canonical.gen_ai_operation, &gen_ai_operation);
            prop_assert_eq!(&canonical.gen_ai_request_model, &request_model);
            prop_assert_eq!(&canonical.gen_ai_response_model, &response_model);
            prop_assert_eq!(canonical.gen_ai_usage_input_tokens, input_tokens);
            prop_assert_eq!(canonical.gen_ai_usage_output_tokens, output_tokens);
            prop_assert_eq!(&canonical.gen_ai_response_finish_reason, &finish_reason);
            prop_assert_eq!(&canonical.source_dialect, "otel-genai");
        }

        /// Unknown attributes are preserved verbatim in CanonicalSpan.attributes.
        #[test]
        fn prop_otel_genai_unknown_attrs_preserved(
            key in "[a-z][a-z0-9_]{1,20}",
            value in "[a-zA-Z0-9 ]{0,50}",
        ) {
            // Use a namespace that is not in CONSUMED_KEYS.
            let key = format!("custom.{key}");
            let mut extra = BTreeMap::new();
            extra.insert(key.clone(), AnyValue::String(value.clone()));

            let span = make_otel_genai_span(
                "openai", "chat", "gpt-4o", "gpt-4o", 10, 20, "stop",
                extra,
            );

            let adapter = OtelGenAiAdapter;
            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert!(
                canonical.attributes.contains_key(&key),
                "unknown key {key:?} should be preserved in CanonicalSpan.attributes"
            );
            prop_assert_eq!(
                canonical.attributes.get(&key).map(|s| s.as_str()),
                Some(value.as_str())
            );
        }
    }

    /// Unit test: content from span events takes precedence over attributes.
    #[test]
    fn otel_genai_events_take_precedence_over_attrs() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        // Attribute fallback — should NOT be used when events are present.
        attrs.insert(
            "gen_ai.input.messages".to_string(),
            AnyValue::String(r#"[{"role":"user","content":"from_attr"}]"#.to_string()),
        );

        let mut event_attrs = BTreeMap::new();
        event_attrs.insert(
            "gen_ai.event.content".to_string(),
            AnyValue::String("from_event".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "openai.chat".to_string(),
            kind: 3,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![OtlpEvent {
                name: "gen_ai.user.message".to_string(),
                time_unix_nano: 0,
                attributes: event_attrs,
            }],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OtelGenAiAdapter.normalize(span).unwrap();
        let input_body = canonical.input_body.unwrap();
        // Should contain the event content, not the attribute content.
        let body_str = input_body.to_string();
        assert!(
            body_str.contains("from_event"),
            "event content should take precedence: {body_str}"
        );
        assert!(
            !body_str.contains("from_attr"),
            "attribute fallback should not appear when events present: {body_str}"
        );
    }

    /// Unit test: attribute fallback works when no events are present.
    #[test]
    fn otel_genai_attribute_fallback_for_bodies() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("anthropic".to_string()),
        );
        attrs.insert(
            "gen_ai.input.messages".to_string(),
            AnyValue::String(r#"[{"role":"user","content":"hello"}]"#.to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "anthropic.chat".to_string(),
            kind: 3,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![], // no events
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OtelGenAiAdapter.normalize(span).unwrap();
        let input_body = canonical.input_body.unwrap();
        assert!(
            input_body.to_string().contains("hello"),
            "attribute fallback should populate input_body: {input_body}"
        );
    }

    proptest! {
        /// is_run_root is true iff gen_ai.operation.name == "invoke_agent"
        /// or halley.run.kind == "agent".
        #[test]
        fn prop_is_run_root_when_invoke_agent(
            operation in arb_gen_ai_string(),
        ) {
            let span = make_otel_genai_span(
                "openai", &operation, "gpt-4o", "gpt-4o", 10, 20, "stop",
                BTreeMap::new(),
            );
            let canonical = OtelGenAiAdapter.normalize(span).expect("normalize should not fail");
            let expected = operation == "invoke_agent";
            prop_assert_eq!(
                canonical.is_run_root,
                expected,
                "is_run_root should be {} for operation {:?}",
                expected,
                operation
            );
        }
    }

    /// is_run_root is true when halley.run.kind == "agent" regardless of operation.
    #[test]
    fn is_run_root_via_halley_run_kind() {
        let mut extra = BTreeMap::new();
        extra.insert(
            "halley.run.kind".to_string(),
            AnyValue::String("agent".to_string()),
        );
        let span =
            make_otel_genai_span("openai", "chat", "gpt-4o", "gpt-4o", 10, 20, "stop", extra);
        let canonical = OtelGenAiAdapter.normalize(span).unwrap();
        assert!(
            canonical.is_run_root,
            "halley.run.kind=agent should set is_run_root"
        );
    }

    /// is_run_root is false for a regular chat span.
    #[test]
    fn is_run_root_false_for_chat() {
        let span = make_otel_genai_span(
            "openai",
            "chat",
            "gpt-4o",
            "gpt-4o",
            10,
            20,
            "stop",
            BTreeMap::new(),
        );
        let canonical = OtelGenAiAdapter.normalize(span).unwrap();
        assert!(!canonical.is_run_root, "chat span should not be run root");
    }
}
