//! Halley ingester entry point.
//!
//! Responsibilities at Day 3:
//!   - Load config from env.
//!   - Initialize tracing (JSON if `INGESTER_LOG_JSON=true`).
//!   - Build the axum router with ClickHouseStore in AppState.
//!   - Serve HTTP with graceful shutdown on SIGINT/SIGTERM.
//!
//! Day 6 adds the span insert path; this bootstrap does not change.

use anyhow::Context;
use tracing::info;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod config;
mod domain;
mod errors;
mod http;
mod storage;

use crate::{
    config::Config,
    http::{build_router, AppState},
    storage::clickhouse::ClickHouseStore,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env().context("load config from env")?;

    init_tracing(&cfg);

    info!(
        addr = %cfg.http_addr,
        clickhouse_url = %cfg.clickhouse_url,
        log_json = cfg.log_json,
        "halley-ingester starting"
    );

    let ch = ClickHouseStore::new(&cfg);
    let app = build_router(AppState { ch });

    let listener = tokio::net::TcpListener::bind(cfg.http_addr)
        .await
        .with_context(|| format!("bind {}", cfg.http_addr))?;

    info!(addr = %cfg.http_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum::serve")?;

    info!("halley-ingester stopped");
    Ok(())
}

/// Install a tracing subscriber. JSON when config says so, human
/// otherwise. Respects `RUST_LOG`; falls back to `INGESTER_LOG_LEVEL`.
fn init_tracing(cfg: &Config) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(cfg.log_level.clone()));

    if cfg.log_json {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().json().with_current_span(true).with_span_list(false))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer())
            .init();
    }
}

/// Wait for Ctrl+C or SIGTERM, then return so axum exits gracefully.
/// `docker compose down` sends SIGTERM; the plan's Day 3 acceptance
/// requires not leaking connections on shutdown.
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
