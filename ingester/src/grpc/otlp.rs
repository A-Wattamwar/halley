//! OTLP/gRPC receiver on :4317.
//!
//! Implements the `TraceService` trait from the pre-generated tonic code in
//! `opentelemetry-proto`. No `build.rs` is needed — the `gen-tonic` feature
//! on `opentelemetry-proto` ships pre-generated code. See DECISIONS.md D33.
//!
//! The `export()` method delegates to `pipeline::ingest::ingest_otlp_request`,
//! the same function used by the HTTP receiver. Both paths produce identical
//! canonical rows for equivalent payloads.

use crate::{
    normalizer::Normalizer,
    pipeline::{ingest::ingest_otlp_request, publisher::Publisher},
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    trace_service_server::TraceService, ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::{Request, Response, Status};
use tracing::info;

/// gRPC service implementation for the OTLP TraceService.
pub struct HalleyTraceService {
    pub normalizer: Arc<Normalizer>,
    pub publisher: Arc<Mutex<Publisher>>,
}

#[tonic::async_trait]
impl TraceService for HalleyTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let req = request.into_inner();

        let (accepted, errors) = ingest_otlp_request(req, &self.normalizer, &self.publisher).await;

        info!(accepted, errors, "OTLP/gRPC traces processed");

        Ok(Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}
