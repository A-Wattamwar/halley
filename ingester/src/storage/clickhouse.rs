//! Thin wrapper around the official `clickhouse` crate.
//!
//! Day 3: `ping()` for `/readyz`.
//! Day 6: `insert_bodies()` and `insert_observation()` for the span handler.

use crate::{
    config::Config,
    domain::span::{BodyRow, ObservationRow},
    errors::IngestError,
};
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

/// Upper bound on how long `/readyz` waits for ClickHouse. See DECISIONS.md D20.
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

    /// Run `SELECT 1` with a 2s timeout. Returns `Ok(())` on success.
    /// Used by `/readyz`. See DECISIONS.md D20.
    pub async fn ping(&self) -> Result<(), String> {
        let fut = self.client.query("SELECT 1").fetch_one::<u8>();
        match timeout(PING_TIMEOUT, fut).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("clickhouse error: {e}")),
            Err(_) => Err("clickhouse ping timed out".into()),
        }
    }

    /// Batch-insert body rows into `halley.observation_body`.
    ///
    /// If `rows` is empty, returns `Ok(())` immediately without touching
    /// ClickHouse. `ReplacingMergeTree` handles dedup on background merge;
    /// the insert itself is unconditional (see pitfalls in week-1 plan).
    ///
    /// Must be called before `insert_observation` so that body hashes
    /// referenced by the observation row already exist in the body table.
    pub async fn insert_bodies(&self, rows: Vec<BodyRow>) -> Result<(), IngestError> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut insert = self
            .client
            .insert("observation_body")
            .map_err(|e| IngestError::Storage(format!("insert_bodies prepare: {e}")))?;
        for row in rows {
            insert
                .write(&row)
                .await
                .map_err(|e| IngestError::Storage(format!("insert_bodies write: {e}")))?;
        }
        insert
            .end()
            .await
            .map_err(|e| IngestError::Storage(format!("insert_bodies end: {e}")))?;
        Ok(())
    }

    /// Single-row insert into `halley.observations`.
    ///
    /// Week 1 uses single-row inserts; Week 3 introduces batching via
    /// Redis Streams. See ARCHITECTURE §3.5.
    pub async fn insert_observation(&self, row: ObservationRow) -> Result<(), IngestError> {
        let mut insert = self
            .client
            .insert("observations")
            .map_err(|e| IngestError::Storage(format!("insert_observation prepare: {e}")))?;
        insert
            .write(&row)
            .await
            .map_err(|e| IngestError::Storage(format!("insert_observation write: {e}")))?;
        insert
            .end()
            .await
            .map_err(|e| IngestError::Storage(format!("insert_observation end: {e}")))?;
        Ok(())
    }
}
