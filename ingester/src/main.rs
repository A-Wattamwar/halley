//! Halley ingester entry point.
//!
//! Phase 2 Day 5: three tokio tasks in one process.
//!   1. axum HTTP server (OTLP/HTTP :4318 + /v1/spans/json)
//!   2. tonic gRPC server (OTLP/gRPC :4317)
//!   3. Writer (Redis consumer → ClickHouse batch inserter)
//!
//! See ARCHITECTURE §3.2, §3.5 and phase-2-overview.md for the data-flow.

use anyhow::Context;
use std::sync::Arc;
use tokio::sync::{watch, Mutex};
use tracing::info;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod auth;
mod config;
mod domain;
mod errors;
mod grpc;
mod http;
mod normalizer;
mod pipeline;
mod storage;
mod telemetry;

use crate::{
    auth::AuthService,
    config::Config,
    grpc::otlp::HalleyTraceService,
    http::{build_router, AppState},
    normalizer::Normalizer,
    pipeline::{publisher::Publisher, writer::Writer},
    storage::clickhouse::ClickHouseStore,
    telemetry::init_prometheus,
};
use metrics::gauge;
use opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceServiceServer;
use tonic::transport::Server as TonicServer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env().context("load config from env")?;

    init_tracing(&cfg);

    info!(
        http_addr = %cfg.http_addr,
        grpc_addr = %cfg.grpc_addr,
        clickhouse_url = %cfg.clickhouse_url,
        redis_url = %cfg.redis_url,
        log_json = cfg.log_json,
        "halley-ingester starting"
    );

    // --- Storage and pipeline setup ---

    let ch = ClickHouseStore::new(&cfg);

    // Install Prometheus recorder. Must happen before any metrics macros fire.
    let metrics_handle = init_prometheus();

    let publisher = Publisher::new(&cfg.redis_url)
        .await
        .context("connect publisher to Redis")?;

    let writer =
        Writer::new(&cfg.redis_url, ch.clone(), "writer-0".to_string()).context("create writer")?;

    // Graceful shutdown channel. Sender fires `true` on SIGINT/SIGTERM.
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Spawn the writer task. It runs independently of axum.
    // IMPORTANT: tokio::spawn so the writer does not block the receiver.
    let writer_handle = tokio::spawn(async move {
        writer.run(shutdown_rx).await;
    });

    // Spawn the Redis stream lag poller (every 1s, updates halley_redis_stream_lag gauge).
    // Runs independently; failure to poll is non-fatal.
    {
        let redis_url = cfg.redis_url.clone();
        tokio::spawn(async move {
            use redis::AsyncCommands;
            let client = match redis::Client::open(redis_url.as_str()) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "redis lag poller: failed to create client");
                    return;
                }
            };
            let mut conn = match client.get_multiplexed_async_connection().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "redis lag poller: failed to connect");
                    return;
                }
            };
            loop {
                let lag: i64 = conn.xlen(crate::pipeline::STREAM_KEY).await.unwrap_or(0);
                gauge!("halley_redis_stream_lag").set(lag as f64);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }

    // --- Auth service ---
    let auth_service = Arc::new(
        AuthService::new(&cfg.redis_url, &cfg.postgres_url, cfg.auth_required)
            .context("initialize auth service")?,
    );

    // --- gRPC server (OTLP :4317) ---

    let grpc_normalizer = Arc::new(Normalizer::new());
    let grpc_publisher = Arc::new(Mutex::new(
        Publisher::new(&cfg.redis_url)
            .await
            .context("connect gRPC publisher to Redis")?,
    ));

    let trace_service = HalleyTraceService {
        normalizer: grpc_normalizer,
        publisher: grpc_publisher,
        auth: auth_service.clone(),
    };

    let grpc_addr = cfg.grpc_addr;
    let grpc_handle = tokio::spawn(async move {
        info!(addr = %grpc_addr, "gRPC server listening");
        if let Err(e) = TonicServer::builder()
            .add_service(TraceServiceServer::new(trace_service))
            .serve(grpc_addr)
            .await
        {
            tracing::error!(error = %e, "gRPC server error");
        }
    });

    // --- HTTP server ---

    let state = AppState {
        ch,
        publisher: Arc::new(Mutex::new(publisher)),
        normalizer: Arc::new(Normalizer::new()),
        metrics_handle,
        auth: auth_service,
    };
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(cfg.http_addr)
        .await
        .with_context(|| format!("bind {}", cfg.http_addr))?;

    info!(addr = %cfg.http_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum::serve")?;

    // --- Graceful shutdown ---

    info!("HTTP server stopped, signaling writer to drain");
    // Signal the writer to finish its current batch and exit.
    let _ = shutdown_tx.send(true);

    // Wait for the writer to drain. Give it up to 10 seconds.
    match tokio::time::timeout(std::time::Duration::from_secs(10), writer_handle).await {
        Ok(Ok(())) => info!("writer drained cleanly"),
        Ok(Err(e)) => tracing::warn!(error = %e, "writer task panicked"),
        Err(_) => tracing::warn!("writer did not drain within 10s, forcing exit"),
    }

    // Abort the gRPC server (it has no drain semantics; in-flight RPCs complete
    // before the task exits because tonic handles that internally).
    grpc_handle.abort();

    info!("halley-ingester stopped");
    Ok(())
}

/// Install a tracing subscriber. JSON when config says so, human
/// otherwise. Respects `RUST_LOG`; falls back to `INGESTER_LOG_LEVEL`.
fn init_tracing(cfg: &Config) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(cfg.log_level.clone()));

    if cfg.log_json {
        tracing_subscriber::registry()
            .with(filter)
            .with(
                fmt::layer()
                    .json()
                    .with_current_span(true)
                    .with_span_list(false),
            )
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer())
            .init();
    }
}

/// Wait for Ctrl+C or SIGTERM, then return so axum exits gracefully.
/// `docker compose down` sends SIGTERM.
async fn shutdown_signal() {
    use tokio::signal;

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = signal::ctrl_c() => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
