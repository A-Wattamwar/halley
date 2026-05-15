//! Normalizer: dialect detection and adapter dispatch.
//!
//! # Detection priority (DECISIONS.md D31)
//!
//! Adapters are tried in this order:
//!
//! 1. **halley-raw**: detected by `source_dialect = "halley-raw"` attribute.
//!    This is an explicit opt-in from the `/v1/spans/json` receiver and must
//!    be checked first to avoid misclassification.
//!
//! 2. **openllmetry**: detected by presence of any `traceloop.*` attribute key.
//!    OpenLLMetry always adds `traceloop.*` keys on top of `gen_ai.*`, so it
//!    must be checked before the generic OTEL GenAI adapter to avoid the
//!    generic adapter claiming OpenLLMetry spans.
//!
//! 3. **openinference**: detected by presence of `openinference.span.kind` OR
//!    `llm.model_name`. Must come before otel-genai because OpenInference spans
//!    may also carry `gen_ai.*` attributes in mixed instrumentations.
//!
//! 4. **vercel-ai**: detected by presence of `ai.operationId`, `ai.model.id`,
//!    or `ai.model.provider`. Must come before otel-genai because Vercel AI SDK
//!    v6 also emits `gen_ai.*` attributes on inner doGenerate/doStream spans.
//!
//! 5. **otel-genai**: detected by presence of `gen_ai.system` or
//!    `gen_ai.provider.name` attribute. Fallback for any GenAI span that is
//!    not claimed by a more specific adapter.
//!
//! 6. **fallback**: no adapter matched → `NormalizeError::UnknownDialect`.
//!    The span is not dropped; the caller decides what to do (log, DLQ, etc.).
//!
//! This priority is documented here and in DECISIONS.md D31.

pub mod halley_raw;
pub mod openinference;
pub mod openllmetry;
pub mod otel_genai;
pub mod vercel_ai;

use crate::{
    domain::{canonical::CanonicalSpan, otlp_span::OtlpSpan},
    normalizer::{
        halley_raw::HalleyRawAdapter, openinference::OpenInferenceAdapter,
        openllmetry::OpenLLMetryAdapter, otel_genai::OtelGenAiAdapter, vercel_ai::VercelAiAdapter,
    },
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NormalizeError {
    #[error("unknown dialect: no adapter matched the span")]
    UnknownDialect,
    /// Used by adapters that encounter malformed data within a detected dialect.
    #[allow(dead_code)]
    #[error("normalization failed: {0}")]
    Failed(String),
}

/// Adapter trait. Each dialect implements this.
///
/// `detect` is called in priority order; the first adapter that returns `true`
/// wins. `normalize` is only called on the winning adapter.
pub trait Adapter: Send + Sync {
    /// Short identifier for this dialect (e.g. "halley-raw", "otel-genai").
    /// Used by the compatibility matrix (Week 4 Day 6).
    #[allow(dead_code)]
    fn dialect_id(&self) -> &'static str;

    /// Return `true` if this adapter should handle the given span.
    fn detect(&self, span: &OtlpSpan) -> bool;

    /// Normalize the span into a `CanonicalSpan`.
    fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError>;
}

/// Normalizer registry. Holds all registered adapters in priority order.
pub struct Normalizer {
    adapters: Vec<Box<dyn Adapter>>,
}

impl Normalizer {
    /// Build the normalizer with all adapters registered in detection priority order.
    ///
    /// Priority: halley-raw → openllmetry → openinference → vercel-ai → otel-genai
    /// See module-level doc comment and DECISIONS.md D31.
    pub fn new() -> Self {
        Self {
            adapters: vec![
                Box::new(HalleyRawAdapter),
                Box::new(OpenLLMetryAdapter), // more specific than otel-genai; must come first
                Box::new(OpenInferenceAdapter), // before otel-genai; may carry gen_ai.* too
                Box::new(VercelAiAdapter),    // before otel-genai; v6 emits gen_ai.* too
                Box::new(OtelGenAiAdapter),
            ],
        }
    }

    /// Detect the dialect and normalize the span.
    ///
    /// Tries adapters in priority order. Returns `NormalizeError::UnknownDialect`
    /// if no adapter matches.
    pub fn normalize(&self, span: OtlpSpan) -> Result<CanonicalSpan, NormalizeError> {
        for adapter in &self.adapters {
            if adapter.detect(&span) {
                return adapter.normalize(span);
            }
        }
        Err(NormalizeError::UnknownDialect)
    }
}

impl Default for Normalizer {
    fn default() -> Self {
        Self::new()
    }
}
