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
    auth::AuthService,
    normalizer::Normalizer,
    pipeline::{ingest::ingest_otlp_request, publisher::Publisher},
};
use metrics::histogram;
use opentelemetry_proto::tonic::collector::trace::v1::{
    trace_service_server::TraceService, ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tonic::{Request, Response, Status};
use tracing::info;

/// gRPC service implementation for the OTLP TraceService.
pub struct HalleyTraceService {
    pub normalizer: Arc<Normalizer>,
    pub publisher: Arc<Mutex<Publisher>>,
    pub auth: Arc<AuthService>,
}

#[tonic::async_trait]
impl TraceService for HalleyTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let start = Instant::now();

        // 1. Auth check
        let mut project_id = self.auth.default_project_id();
        let auth_header = request
            .metadata()
            .get("authorization")
            .and_then(|m| m.to_str().ok())
            .unwrap_or("");

        if !auth_header.is_empty() {
            if !auth_header.starts_with("Bearer hlly_") {
                return Err(Status::unauthenticated("Missing or invalid Bearer token"));
            }

            let token = auth_header.strip_prefix("Bearer ").unwrap();
            match self.auth.validate_token(token).await {
                Ok(Some(pid)) => project_id = pid,
                Ok(None) => return Err(Status::unauthenticated("Invalid or revoked API key")),
                Err(e) => {
                    tracing::error!(error = %e, "Auth service error");
                    return Err(Status::internal("Authentication service unavailable"));
                }
            }
        } else if self.auth.is_auth_required() {
            return Err(Status::unauthenticated("Missing or invalid Bearer token"));
        }

        let req = request.into_inner();

        let (accepted, errors) =
            ingest_otlp_request(req, &self.normalizer, &self.publisher, project_id).await;

        info!(accepted, errors, "OTLP/gRPC traces processed");

        histogram!("halley_ingest_latency_seconds", "path" => "grpc")
            .record(start.elapsed().as_secs_f64());

        Ok(Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}
