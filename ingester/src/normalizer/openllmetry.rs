//! OpenLLMetry adapter.
//!
//! Detection: presence of any `traceloop.*` attribute key on the span.
//! OpenLLMetry instrumentations always add `traceloop.*` keys on top of
//! `gen_ai.*`, so this adapter is checked before `otel-genai` in the
//! priority list. See DECISIONS.md D31.
//!
//! # Attribute mapping
//!
//! OpenLLMetry emits standard `gen_ai.*` attributes (same as OTEL GenAI)
//! plus its own `traceloop.*` namespace. This adapter maps both:
//!
//! ## gen_ai.* mapping (identical to otel-genai adapter)
//!
//! | Canonical field               | Attribute                          | Legacy fallback                  |
//! |-------------------------------|------------------------------------|----------------------------------|
//! | gen_ai_system                 | gen_ai.provider.name               | gen_ai.system                    |
//! | gen_ai_operation              | gen_ai.operation.name              | traceloop.span.kind (see below)  |
//! | gen_ai_request_model          | gen_ai.request.model               | —                                |
//! | gen_ai_response_model         | gen_ai.response.model              | —                                |
//! | gen_ai_usage_input_tokens     | gen_ai.usage.input_tokens          | —                                |
//! | gen_ai_usage_output_tokens    | gen_ai.usage.output_tokens         | —                                |
//! | gen_ai_response_finish_reason | gen_ai.response.finish_reasons[0]  | gen_ai.response.finish_reason    |
//!
//! ## traceloop.* mapping
//!
//! | Canonical field | traceloop attribute          | Condition                        |
//! |-----------------|------------------------------|----------------------------------|
//! | run_name        | traceloop.entity.name        | Only if run_name is otherwise "" |
//! | gen_ai_operation| traceloop.span.kind          | Only if gen_ai.operation.name="" |
//!
//! `traceloop.span.kind` → `gen_ai_operation` mapping:
//! - "llm"      → "chat"
//! - "tool"     → "execute_tool"
//! - "agent"    → "invoke_agent"
//! - "workflow" → "invoke_workflow"
//! - "task"     → "invoke_agent"  (OpenLLMetry uses "task" for agent steps)
//! - anything else → passed through verbatim
//!
//! ## Body content
//!
//! OpenLLMetry puts body content in `traceloop.entity.input` /
//! `traceloop.entity.output` (JSON strings). These are checked as a
//! second fallback after the standard gen_ai event/attribute paths.
//!
//! Precedence:
//! 1. Span events (gen_ai.user.message, gen_ai.choice, etc.)
//! 2. gen_ai.input.messages / gen_ai.output.messages attributes
//! 3. traceloop.entity.input / traceloop.entity.output attributes
//!
//! ## Unknown attributes
//!
//! All `traceloop.*` keys not explicitly consumed are preserved verbatim
//! in `CanonicalSpan.attributes`. All other unknown keys are also preserved.

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

pub struct OpenLLMetryAdapter;

/// Attribute keys consumed by this adapter (not passed through to `attributes`).
const CONSUMED_KEYS: &[&str] = &[
    // gen_ai.* (same as otel-genai)
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
    // traceloop.* consumed by this adapter
    "traceloop.entity.name",
    "traceloop.span.kind",
    "traceloop.entity.input",
    "traceloop.entity.output",
    // Halley context attributes injected by the receiver
    "halley.project_id",
    "halley.pricing_version_id",
    "halley.run_name",
    "halley.run_tags",
    "halley.run_env",
    "halley.dialect_version",
    "halley.tool_side_effect",
];

impl Adapter for OpenLLMetryAdapter {
    fn dialect_id(&self) -> &'static str {
        "openllmetry"
    }

    /// Detect by presence of any `traceloop.*` attribute key.
    fn detect(&self, span: &OtlpSpan) -> bool {
        span.attributes.keys().any(|k| k.starts_with("traceloop."))
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

        // gen_ai_operation: prefer gen_ai.operation.name, fall back to traceloop.span.kind.
        let gen_ai_operation = {
            let from_genai = str_attr("gen_ai.operation.name");
            if from_genai.is_empty() {
                traceloop_span_kind_to_operation(&str_attr("traceloop.span.kind"))
            } else {
                from_genai
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

        // Body content: events first, then gen_ai attributes, then traceloop attributes.
        let (input_body, output_body) = extract_bodies(&span.events, attrs);

        // Tool fields.
        let tool_name = str_attr("gen_ai.tool.name");
        let tool_input = attrs
            .get("gen_ai.tool.call.arguments")
            .map(parse_json_anyvalue);
        let tool_output = attrs
            .get("gen_ai.tool.call.result")
            .map(parse_json_anyvalue);

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

        // run_name: prefer halley.run_name, fall back to traceloop.entity.name.
        let run_name = {
            let from_halley = str_attr("halley.run_name");
            if from_halley.is_empty() {
                str_attr("traceloop.entity.name")
            } else {
                from_halley
            }
        };

        // Status from OTLP status code.
        let status = match span.status_code {
            2 => SpanStatus::Error,
            _ => SpanStatus::Ok,
        };

        // Preserve unknown attributes verbatim (including unknown traceloop.* keys).
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
            source_dialect: "openllmetry".to_string(),
            dialect_version,
            gen_ai_system,
            gen_ai_operation,
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
        })
    }
}

/// Map `traceloop.span.kind` to a canonical `gen_ai_operation` string.
///
/// OpenLLMetry uses its own span kind vocabulary. This mapping converts it
/// to the OTEL GenAI `gen_ai.operation.name` vocabulary.
fn traceloop_span_kind_to_operation(kind: &str) -> String {
    match kind {
        "llm" => "chat",
        "tool" => "execute_tool",
        "agent" | "task" => "invoke_agent",
        "workflow" => "invoke_workflow",
        other => other, // pass through unknown values verbatim
    }
    .to_string()
}

/// Extract input_body and output_body.
///
/// Precedence:
/// 1. Span events (gen_ai.user.message, gen_ai.choice, etc.)
/// 2. gen_ai.input.messages / gen_ai.output.messages attributes
/// 3. traceloop.entity.input / traceloop.entity.output attributes
fn extract_bodies(
    events: &[OtlpEvent],
    attrs: &BTreeMap<String, AnyValue>,
) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    let mut input_messages: Vec<serde_json::Value> = Vec::new();
    let mut output_messages: Vec<serde_json::Value> = Vec::new();

    for event in events {
        match event.name.as_str() {
            "gen_ai.user.message" | "gen_ai.system.message" => {
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
    } else if let Some(v) = attrs.get("gen_ai.input.messages") {
        // gen_ai attribute fallback
        v.as_str().and_then(|s| serde_json::from_str(s).ok())
    } else {
        // traceloop fallback
        attrs
            .get("traceloop.entity.input")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
    };

    let output_body = if !output_messages.is_empty() {
        Some(serde_json::Value::Array(output_messages))
    } else if let Some(v) = attrs.get("gen_ai.output.messages") {
        v.as_str().and_then(|s| serde_json::from_str(s).ok())
    } else {
        attrs
            .get("traceloop.entity.output")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
    };

    (input_body, output_body)
}

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

    fn arb_gen_ai_string() -> impl Strategy<Value = String> {
        prop::string::string_regex("[a-z0-9._-]{0,32}").unwrap()
    }

    fn arb_u32() -> impl Strategy<Value = u32> {
        0u32..100_000u32
    }

    /// Build a minimal OpenLLMetry OtlpSpan (has both gen_ai.* and traceloop.*).
    #[allow(clippy::too_many_arguments)]
    fn make_openllmetry_span(
        gen_ai_system: &str,
        gen_ai_operation: &str,
        request_model: &str,
        response_model: &str,
        input_tokens: u32,
        output_tokens: u32,
        finish_reason: &str,
        entity_name: &str,
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
        // traceloop marker — this is what triggers detection
        attrs.insert(
            "traceloop.entity.name".to_string(),
            AnyValue::String(entity_name.to_string()),
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
        /// Round-trip: arbitrary OpenLLMetry fields survive the normalizer unchanged.
        #[allow(clippy::too_many_arguments)]
        #[test]
        fn prop_openllmetry_round_trip(
            gen_ai_system in arb_gen_ai_string(),
            gen_ai_operation in arb_gen_ai_string(),
            request_model in arb_gen_ai_string(),
            response_model in arb_gen_ai_string(),
            input_tokens in arb_u32(),
            output_tokens in arb_u32(),
            finish_reason in arb_gen_ai_string(),
            entity_name in arb_gen_ai_string(),
        ) {
            let span = make_openllmetry_span(
                &gen_ai_system,
                &gen_ai_operation,
                &request_model,
                &response_model,
                input_tokens,
                output_tokens,
                &finish_reason,
                &entity_name,
                BTreeMap::new(),
            );

            let adapter = OpenLLMetryAdapter;
            prop_assert!(adapter.detect(&span), "openllmetry adapter should detect the span");

            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert_eq!(&canonical.gen_ai_system, &gen_ai_system);
            prop_assert_eq!(&canonical.gen_ai_operation, &gen_ai_operation);
            prop_assert_eq!(&canonical.gen_ai_request_model, &request_model);
            prop_assert_eq!(&canonical.gen_ai_response_model, &response_model);
            prop_assert_eq!(canonical.gen_ai_usage_input_tokens, input_tokens);
            prop_assert_eq!(canonical.gen_ai_usage_output_tokens, output_tokens);
            prop_assert_eq!(&canonical.gen_ai_response_finish_reason, &finish_reason);
            prop_assert_eq!(&canonical.source_dialect, "openllmetry");
            // run_name should come from traceloop.entity.name when halley.run_name is absent
            prop_assert_eq!(&canonical.run_name, &entity_name);
        }

        /// Unknown traceloop.* keys are preserved verbatim in CanonicalSpan.attributes.
        #[test]
        fn prop_openllmetry_unknown_traceloop_attrs_preserved(
            suffix in "[a-z][a-z0-9_]{1,20}",
            value in "[a-zA-Z0-9 ]{0,50}",
        ) {
            let key = format!("traceloop.{suffix}");
            let mut extra = BTreeMap::new();
            extra.insert(key.clone(), AnyValue::String(value.clone()));

            let span = make_openllmetry_span(
                "openai", "chat", "gpt-4o", "gpt-4o", 10, 20, "stop",
                "my-run", extra,
            );

            let adapter = OpenLLMetryAdapter;
            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert!(
                canonical.attributes.contains_key(&key),
                "unknown traceloop key {key:?} should be preserved in CanonicalSpan.attributes"
            );
            prop_assert_eq!(
                canonical.attributes.get(&key).map(|s| s.as_str()),
                Some(value.as_str())
            );
        }
    }

    /// Detection priority: a span with BOTH gen_ai.system AND traceloop.entity.name
    /// must be detected as "openllmetry", not "otel-genai".
    #[test]
    fn detection_priority_openllmetry_beats_otel_genai() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "traceloop.entity.name".to_string(),
            AnyValue::String("my-agent".to_string()),
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
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let normalizer = Normalizer::new();
        let canonical = normalizer.normalize(span).expect("should normalize");
        assert_eq!(
            canonical.source_dialect, "openllmetry",
            "span with both gen_ai.system and traceloop.* must be detected as openllmetry"
        );
    }

    /// traceloop.span.kind → gen_ai_operation mapping.
    #[test]
    fn traceloop_span_kind_mapping() {
        assert_eq!(traceloop_span_kind_to_operation("llm"), "chat");
        assert_eq!(traceloop_span_kind_to_operation("tool"), "execute_tool");
        assert_eq!(traceloop_span_kind_to_operation("agent"), "invoke_agent");
        assert_eq!(traceloop_span_kind_to_operation("task"), "invoke_agent");
        assert_eq!(
            traceloop_span_kind_to_operation("workflow"),
            "invoke_workflow"
        );
        assert_eq!(traceloop_span_kind_to_operation("custom"), "custom");
    }

    /// traceloop.entity.name → run_name when gen_ai.operation.name is absent.
    #[test]
    fn traceloop_entity_name_sets_run_name() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "traceloop.entity.name".to_string(),
            AnyValue::String("my-workflow".to_string()),
        );
        attrs.insert(
            "traceloop.span.kind".to_string(),
            AnyValue::String("llm".to_string()),
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
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = OpenLLMetryAdapter.normalize(span).unwrap();
        assert_eq!(canonical.run_name, "my-workflow");
        // traceloop.span.kind = "llm" → gen_ai_operation = "chat"
        assert_eq!(canonical.gen_ai_operation, "chat");
    }
}
