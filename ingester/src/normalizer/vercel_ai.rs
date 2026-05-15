//! Vercel AI SDK adapter.
//!
//! Detection: presence of `ai.operationId` attribute. This key is unique to
//! Vercel AI SDK spans and is always present when telemetry is enabled.
//! Fallback detection: `ai.model.id` OR `ai.model.provider` (for spans that
//! may omit operationId in older SDK versions).
//!
//! Source of truth: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry
//! Verified against AI SDK v6 docs on 2026-05-15.
//!
//! # Dual-namespace note
//!
//! Vercel AI SDK v6 emits BOTH `ai.*` (Vercel-proprietary) AND `gen_ai.*`
//! (OTEL semconv) attributes on the same span. The `gen_ai.*` attributes are
//! present on inner `doGenerate`/`doStream` spans. This adapter must be
//! registered BEFORE otel-genai in the adapter Vec so that Vercel spans are
//! not claimed by the generic OTEL GenAI adapter. See DECISIONS.md D31.
//!
//! # Attribute mapping
//!
//! | Canonical field               | Vercel attribute (primary)       | Fallback              |
//! |-------------------------------|----------------------------------|-----------------------|
//! | gen_ai_system                 | `ai.model.provider`              | `gen_ai.system`       |
//! | gen_ai_operation              | `ai.operationId` (mapped)        | —                     |
//! | gen_ai_request_model          | `ai.model.id`                    | `gen_ai.request.model`|
//! | gen_ai_response_model         | `ai.response.model`              | `gen_ai.response.model`|
//! | gen_ai_usage_input_tokens     | `ai.usage.promptTokens`          | `gen_ai.usage.input_tokens` |
//! | gen_ai_usage_output_tokens    | `ai.usage.completionTokens`      | `gen_ai.usage.output_tokens` |
//! | gen_ai_response_finish_reason | `ai.response.finishReason`       | `gen_ai.response.finish_reasons[0]` |
//! | input_body                    | `ai.prompt`                      | `ai.prompt.messages`  |
//! | output_body                   | `ai.response.text`               | `ai.response.object`  |
//! | tool_name                     | `ai.toolCall.name`               | —                     |
//! | tool_input                    | `ai.toolCall.args`               | —                     |
//! | tool_output                   | `ai.toolCall.result`             | —                     |
//!
//! # `ai.operationId` → `gen_ai_operation` mapping
//!
//! | Vercel operationId              | canonical gen_ai_operation |
//! |---------------------------------|---------------------------|
//! | "ai.generateText"               | "chat"                    |
//! | "ai.generateText.doGenerate"    | "chat"                    |
//! | "ai.streamText"                 | "chat"                    |
//! | "ai.streamText.doStream"        | "chat"                    |
//! | "ai.embed"                      | "embeddings"              |
//! | "ai.embed.doEmbed"              | "embeddings"              |
//! | "ai.embedMany"                  | "embeddings"              |
//! | "ai.embedMany.doEmbed"          | "embeddings"              |
//! | "ai.toolCall"                   | "execute_tool"            |
//! | anything else                   | passed through verbatim   |
//!
//! # Token attribute precedence (see DECISIONS.md D40)
//!
//! The outer `ai.generateText` span carries `ai.usage.promptTokens` /
//! `ai.usage.completionTokens`. The inner `doGenerate` span carries both
//! those AND `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`.
//! This adapter prefers the `ai.usage.*` keys (Vercel-native) and falls back
//! to `gen_ai.usage.*` so both span types are handled correctly.
//!
//! # Unknown attributes
//!
//! All `ai.*` keys not explicitly consumed are preserved verbatim in
//! `CanonicalSpan.attributes`. `gen_ai.*` keys that are also present (on
//! doGenerate/doStream spans) are consumed and not double-stored.

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

pub struct VercelAiAdapter;

/// Attribute keys consumed by this adapter (not passed through to `attributes`).
const CONSUMED_KEYS: &[&str] = &[
    // Vercel ai.* keys
    "ai.operationId",
    "ai.model.id",
    "ai.model.provider",
    "ai.usage.promptTokens",
    "ai.usage.completionTokens",
    "ai.response.model",
    "ai.response.finishReason",
    "ai.prompt",
    "ai.prompt.messages",
    "ai.response.text",
    "ai.response.object",
    "ai.toolCall.name",
    "ai.toolCall.id",
    "ai.toolCall.args",
    "ai.toolCall.result",
    // gen_ai.* keys also emitted by Vercel on doGenerate/doStream spans
    "gen_ai.system",
    "gen_ai.provider.name",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.response.finish_reasons",
    "gen_ai.response.finish_reason",
    // Halley context attributes injected by the receiver
    "halley.project_id",
    "halley.pricing_version_id",
    "halley.run_name",
    "halley.run_tags",
    "halley.run_env",
    "halley.dialect_version",
    "halley.tool_side_effect",
];

impl Adapter for VercelAiAdapter {
    fn dialect_id(&self) -> &'static str {
        "vercel-ai"
    }

    /// Detect by presence of `ai.operationId`, `ai.model.id`, or `ai.model.provider`.
    ///
    /// `ai.operationId` is the primary marker — always present on Vercel spans.
    /// `ai.model.id` / `ai.model.provider` are fallbacks for edge cases.
    fn detect(&self, span: &OtlpSpan) -> bool {
        span.attributes.contains_key("ai.operationId")
            || span.attributes.contains_key("ai.model.id")
            || span.attributes.contains_key("ai.model.provider")
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

        // u32 with fallback to a second key.
        let u32_attr_with_fallback = |primary: &str, fallback: &str| -> u32 {
            attrs
                .get(primary)
                .and_then(|v| v.as_u32())
                .unwrap_or_else(|| attrs.get(fallback).and_then(|v| v.as_u32()).unwrap_or(0))
        };

        // gen_ai_system: Vercel uses ai.model.provider; fall back to gen_ai.system.
        let gen_ai_system = {
            let from_vercel = str_attr("ai.model.provider");
            if from_vercel.is_empty() {
                // gen_ai.system is the legacy OTEL name; gen_ai.provider.name is current.
                let current = str_attr("gen_ai.provider.name");
                if current.is_empty() {
                    str_attr("gen_ai.system")
                } else {
                    current
                }
            } else {
                from_vercel
            }
        };

        // gen_ai_operation: derived from ai.operationId.
        let operation_id = str_attr("ai.operationId");
        let gen_ai_operation = vercel_operation_id_to_operation(&operation_id);

        // gen_ai_request_model: ai.model.id, fall back to gen_ai.request.model.
        let gen_ai_request_model = {
            let from_vercel = str_attr("ai.model.id");
            if from_vercel.is_empty() {
                str_attr("gen_ai.request.model")
            } else {
                from_vercel
            }
        };

        // gen_ai_response_model: ai.response.model, fall back to gen_ai.response.model.
        let gen_ai_response_model = {
            let from_vercel = str_attr("ai.response.model");
            if from_vercel.is_empty() {
                str_attr("gen_ai.response.model")
            } else {
                from_vercel
            }
        };

        // Token counts: prefer ai.usage.* (outer span), fall back to gen_ai.usage.* (inner span).
        // See module doc comment and DECISIONS.md D40.
        let gen_ai_usage_input_tokens =
            u32_attr_with_fallback("ai.usage.promptTokens", "gen_ai.usage.input_tokens");
        let gen_ai_usage_output_tokens =
            u32_attr_with_fallback("ai.usage.completionTokens", "gen_ai.usage.output_tokens");

        // Finish reason: ai.response.finishReason (string), fall back to gen_ai.response.finish_reasons[0].
        let gen_ai_response_finish_reason = {
            let from_vercel = str_attr("ai.response.finishReason");
            if from_vercel.is_empty() {
                if let Some(AnyValue::Array(arr)) = attrs.get("gen_ai.response.finish_reasons") {
                    arr.first()
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                } else {
                    str_attr("gen_ai.response.finish_reason")
                }
            } else {
                from_vercel
            }
        };

        // input_body: ai.prompt (the full prompt string), fall back to ai.prompt.messages.
        let input_body = {
            if let Some(v) = attrs.get("ai.prompt") {
                Some(parse_json_or_wrap(v))
            } else {
                attrs.get("ai.prompt.messages").map(parse_json_or_wrap)
            }
        };

        // output_body: ai.response.text, fall back to ai.response.object.
        let output_body = {
            if let Some(v) = attrs.get("ai.response.text") {
                Some(parse_json_or_wrap(v))
            } else {
                attrs.get("ai.response.object").map(parse_json_or_wrap)
            }
        };

        // Tool fields (present on ai.toolCall spans).
        let tool_name = str_attr("ai.toolCall.name");
        let tool_input = attrs.get("ai.toolCall.args").map(parse_json_anyvalue);
        let tool_output = attrs.get("ai.toolCall.result").map(parse_json_anyvalue);

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

        // Preserve unknown attributes verbatim (unknown ai.* keys, metadata.*, etc.).
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
            source_dialect: "vercel-ai".to_string(),
            dialect_version,
            gen_ai_system,
            gen_ai_operation,
            gen_ai_request_model,
            gen_ai_response_model,
            gen_ai_usage_input_tokens,
            gen_ai_usage_output_tokens,
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
            // vercel-ai rule: ai.operationId starts with "ai.agent" OR
            // halley.run.kind == "agent".
            is_run_root: operation_id.starts_with("ai.agent")
                || str_attr("halley.run.kind") == "agent",
        })
    }
}

/// Map `ai.operationId` to a canonical `gen_ai_operation` string.
///
/// Source: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry (AI SDK v6)
fn vercel_operation_id_to_operation(op_id: &str) -> String {
    match op_id {
        "ai.generateText" | "ai.generateText.doGenerate" => "chat",
        "ai.streamText" | "ai.streamText.doStream" => "chat",
        "ai.embed" | "ai.embed.doEmbed" => "embeddings",
        "ai.embedMany" | "ai.embedMany.doEmbed" => "embeddings",
        "ai.toolCall" => "execute_tool",
        other => other, // pass through unknown values verbatim
    }
    .to_string()
}

/// Parse an `AnyValue` as JSON if it looks like JSON, otherwise wrap as `{"text": ...}`.
fn parse_json_or_wrap(v: &AnyValue) -> serde_json::Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({ "text": s }))
    } else {
        v.to_json()
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

    /// Build a minimal Vercel AI SDK OtlpSpan (ai.generateText outer span shape).
    fn make_vercel_span(
        provider: &str,
        model_id: &str,
        input_tokens: u32,
        output_tokens: u32,
        extra_attrs: BTreeMap<String, AnyValue>,
    ) -> OtlpSpan {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText".to_string()),
        );
        attrs.insert(
            "ai.model.provider".to_string(),
            AnyValue::String(provider.to_string()),
        );
        attrs.insert(
            "ai.model.id".to_string(),
            AnyValue::String(model_id.to_string()),
        );
        attrs.insert(
            "ai.usage.promptTokens".to_string(),
            AnyValue::Int(input_tokens as i64),
        );
        attrs.insert(
            "ai.usage.completionTokens".to_string(),
            AnyValue::Int(output_tokens as i64),
        );
        for (k, v) in extra_attrs {
            attrs.insert(k, v);
        }
        OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText".to_string(),
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
        /// Round-trip: arbitrary Vercel AI SDK fields survive the normalizer unchanged.
        #[test]
        fn prop_vercel_ai_round_trip(
            provider in arb_model_string(),
            model_id in arb_model_string(),
            input_tokens in arb_u32(),
            output_tokens in arb_u32(),
        ) {
            let span = make_vercel_span(&provider, &model_id, input_tokens, output_tokens, BTreeMap::new());

            let adapter = VercelAiAdapter;
            prop_assert!(adapter.detect(&span), "vercel-ai adapter should detect the span");

            let canonical = adapter.normalize(span).expect("normalize should not fail");

            prop_assert_eq!(&canonical.gen_ai_system, &provider);
            prop_assert_eq!(&canonical.gen_ai_request_model, &model_id);
            prop_assert_eq!(canonical.gen_ai_usage_input_tokens, input_tokens);
            prop_assert_eq!(canonical.gen_ai_usage_output_tokens, output_tokens);
            prop_assert_eq!(&canonical.gen_ai_operation, "chat"); // ai.generateText → chat
            prop_assert_eq!(&canonical.source_dialect, "vercel-ai");
        }

        /// Unknown ai.* keys are preserved verbatim in CanonicalSpan.attributes.
        #[test]
        fn prop_vercel_ai_unknown_keys_preserved(
            suffix in "[a-z][a-z0-9_]{1,20}",
            value in "[a-zA-Z0-9 ]{0,50}",
        ) {
            let key = format!("ai.{suffix}");
            let mut extra = BTreeMap::new();
            extra.insert(key.clone(), AnyValue::String(value.clone()));

            let span = make_vercel_span("openai", "gpt-4o", 10, 20, extra);

            let adapter = VercelAiAdapter;
            let canonical = adapter.normalize(span).expect("normalize should not fail");

            // Only check keys that are not in CONSUMED_KEYS.
            if !CONSUMED_KEYS.contains(&key.as_str()) {
                prop_assert!(
                    canonical.attributes.contains_key(&key),
                    "unknown ai key {key:?} should be preserved in CanonicalSpan.attributes"
                );
                prop_assert_eq!(
                    canonical.attributes.get(&key).map(|s| s.as_str()),
                    Some(value.as_str())
                );
            }
        }
    }

    /// ai.operationId → gen_ai_operation mapping.
    #[test]
    fn vercel_operation_id_mapping() {
        assert_eq!(vercel_operation_id_to_operation("ai.generateText"), "chat");
        assert_eq!(
            vercel_operation_id_to_operation("ai.generateText.doGenerate"),
            "chat"
        );
        assert_eq!(vercel_operation_id_to_operation("ai.streamText"), "chat");
        assert_eq!(
            vercel_operation_id_to_operation("ai.streamText.doStream"),
            "chat"
        );
        assert_eq!(vercel_operation_id_to_operation("ai.embed"), "embeddings");
        assert_eq!(
            vercel_operation_id_to_operation("ai.embed.doEmbed"),
            "embeddings"
        );
        assert_eq!(
            vercel_operation_id_to_operation("ai.embedMany"),
            "embeddings"
        );
        assert_eq!(
            vercel_operation_id_to_operation("ai.toolCall"),
            "execute_tool"
        );
        assert_eq!(vercel_operation_id_to_operation("ai.custom"), "ai.custom");
    }

    /// Detection priority: a span with both traceloop.* and ai.operationId
    /// resolves to "openllmetry" (openllmetry is earlier in the Vec).
    #[test]
    fn detection_priority_openllmetry_beats_vercel_ai() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "traceloop.entity.name".to_string(),
            AnyValue::String("my-agent".to_string()),
        );
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText".to_string()),
        );
        attrs.insert(
            "gen_ai.system".to_string(),
            AnyValue::String("openai".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText".to_string(),
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
            "span with both traceloop.* and ai.* must be detected as openllmetry"
        );
    }

    /// Detection priority: a span with both openinference.span.kind and ai.operationId
    /// resolves to "openinference" (openinference is earlier in the Vec than vercel-ai).
    #[test]
    fn detection_priority_openinference_beats_vercel_ai() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "openinference.span.kind".to_string(),
            AnyValue::String("LLM".to_string()),
        );
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText".to_string(),
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
            canonical.source_dialect, "openinference",
            "span with both openinference.* and ai.* must be detected as openinference"
        );
    }

    /// Token fallback: gen_ai.usage.* used when ai.usage.* absent (doGenerate span shape).
    #[test]
    fn token_fallback_to_gen_ai_usage() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText.doGenerate".to_string()),
        );
        attrs.insert(
            "ai.model.provider".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "ai.model.id".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        // No ai.usage.* — only gen_ai.usage.* (inner doGenerate span)
        attrs.insert("gen_ai.usage.input_tokens".to_string(), AnyValue::Int(100));
        attrs.insert("gen_ai.usage.output_tokens".to_string(), AnyValue::Int(50));

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText.doGenerate".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = VercelAiAdapter.normalize(span).unwrap();
        assert_eq!(canonical.gen_ai_usage_input_tokens, 100);
        assert_eq!(canonical.gen_ai_usage_output_tokens, 50);
    }

    /// input_body: ai.prompt parsed as JSON when it looks like JSON.
    #[test]
    fn input_body_from_ai_prompt() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText".to_string()),
        );
        attrs.insert(
            "ai.model.provider".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "ai.model.id".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        attrs.insert(
            "ai.prompt".to_string(),
            AnyValue::String(r#"{"messages":[{"role":"user","content":"hello"}]}"#.to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = VercelAiAdapter.normalize(span).unwrap();
        let body = canonical.input_body.unwrap();
        assert!(body.is_object(), "expected JSON object: {body}");
        assert!(body.get("messages").is_some());
    }

    /// output_body: plain text ai.response.text wrapped as {"text": ...}.
    #[test]
    fn output_body_plain_text_wrapped() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "ai.operationId".to_string(),
            AnyValue::String("ai.generateText".to_string()),
        );
        attrs.insert(
            "ai.model.provider".to_string(),
            AnyValue::String("openai".to_string()),
        );
        attrs.insert(
            "ai.model.id".to_string(),
            AnyValue::String("gpt-4o".to_string()),
        );
        attrs.insert(
            "ai.response.text".to_string(),
            AnyValue::String("The answer is 42.".to_string()),
        );

        let span = OtlpSpan {
            trace_id: [0u8; 16],
            span_id: [0u8; 8],
            parent_span_id: None,
            name: "ai.generateText".to_string(),
            kind: 1,
            start_time_unix_nano: 0,
            end_time_unix_nano: 0,
            attributes: attrs,
            events: vec![],
            status_code: 0,
            status_message: String::new(),
        };

        let canonical = VercelAiAdapter.normalize(span).unwrap();
        let body = canonical.output_body.unwrap();
        assert_eq!(
            body.get("text").and_then(|v| v.as_str()),
            Some("The answer is 42.")
        );
    }
}
