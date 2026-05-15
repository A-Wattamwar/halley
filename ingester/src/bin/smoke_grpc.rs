//! gRPC smoke test client for Day 5.
//!
//! Connects to localhost:4317, sends the OTEL GenAI fixture span via
//! OTLP/gRPC, and asserts the call succeeds.
//!
//! Usage (from the smoke test shell script):
//!   cargo run --bin smoke-grpc
//!
//! Exit code: 0 on success, 1 on failure.
//!
//! The fixture bytes are read from ingester/fixtures/otlp-genai-trace.bin,
//! decoded into an ExportTraceServiceRequest, and sent via the tonic client.
//! This re-uses the same fixture as the HTTP smoke test (Day 3), so a
//! successful gRPC call with the same payload proves the two receivers
//! produce identical canonical rows.
//!
//! See DECISIONS.md D33.

use opentelemetry_proto::tonic::collector::trace::v1::{
    trace_service_client::TraceServiceClient, ExportTraceServiceRequest,
};
use prost::Message;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    // Load the OTEL GenAI fixture.
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("otlp-genai-trace.bin");

    let bytes = std::fs::read(&fixture_path).unwrap_or_else(|e| {
        eprintln!(
            "ERROR: could not read fixture {}: {e}",
            fixture_path.display()
        );
        std::process::exit(1);
    });

    let request = ExportTraceServiceRequest::decode(bytes.as_slice()).unwrap_or_else(|e| {
        eprintln!("ERROR: could not decode fixture: {e}");
        std::process::exit(1);
    });

    // Connect to the gRPC server.
    let endpoint = "http://localhost:4317";
    let mut client = TraceServiceClient::connect(endpoint)
        .await
        .unwrap_or_else(|e| {
            eprintln!("ERROR: could not connect to {endpoint}: {e}");
            std::process::exit(1);
        });

    // Send the export request.
    match client.export(request).await {
        Ok(response) => {
            println!("OK: gRPC export succeeded: {:?}", response.into_inner());
        }
        Err(status) => {
            eprintln!("ERROR: gRPC export failed: {status}");
            std::process::exit(1);
        }
    }
}
