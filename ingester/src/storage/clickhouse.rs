//! Thin wrapper around the official `clickhouse` crate.
//!
//! Day 3 scope: construct a client from `Config`, expose a `ping()` that
//! runs `SELECT 1` with a bounded timeout. Day 6 will add row-insert
//! methods.

use crate::config::Config;
use std::time::Duration;
use tokio::time::timeout;

/// Wrapper around the ClickHouse HTTP client.
///
/// The underlying `clickhouse::Client` is cheap to clone (it is a bundle
/// of `Arc`s internally) so we share a single instance through `AppState`.
#[derive(Clone)]
pub struct ClickHouseStore {
    client: clickhouse::Client,
}

/// Upper bound on how long `/readyz` waits for ClickHouse. A longer
/// timeout would hang the endpoint while ClickHouse is down; a shorter
/// one would false-alarm under load. See docs/DECISIONS.md D20.
const PING_TIMEOUT: Duration = Duration::from_secs(2);

impl ClickHouseStore {
    pub fn new(cfg: &Config) -> Self {
        let mut client = clickhouse::Client::default()
            .with_url(&cfg.clickhouse_url)
            .with_database(&cfg.clickhouse_database)
            .with_user(&cfg.clickhouse_user);
        if !cfg.clickhouse_password.is_empty() {
            client = client.with_password(&cfg.clickhouse_password);
        }
        Self { client }
    }

    /// Run `SELECT 1` with a 2s timeout. Returns `Ok(())` on success, a
    /// short error string on failure (timeout, connection, SQL error).
    ///
    /// Used by `/readyz`. Intentionally minimal: any failure mode becomes
    /// "ClickHouse is not ready" — we do not expose server-side details
    /// to unauthenticated readyz callers.
    pub async fn ping(&self) -> Result<(), String> {
        let fut = self.client.query("SELECT 1").fetch_one::<u8>();
        match timeout(PING_TIMEOUT, fut).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("clickhouse error: {e}")),
            Err(_) => Err("clickhouse ping timed out".into()),
        }
    }
}
