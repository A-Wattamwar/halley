//! Environment-driven configuration for the ingester.
//!
//! Fields map 1:1 to the `.env.example` keys. `from_env()` is the single
//! entry point; any missing or malformed value produces a `ConfigError`
//! that names the offending variable.

use std::net::SocketAddr;
use thiserror::Error;

/// Ingester configuration, loaded once at startup.
#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP bind address (e.g. `0.0.0.0:4318`).
    pub http_addr: SocketAddr,
    /// `tracing` filter directive (e.g. `info`, `halley_ingester=debug`).
    pub log_level: String,
    /// If true, emit one JSON object per log event; otherwise human-readable.
    pub log_json: bool,
    /// ClickHouse base URL (HTTP interface, e.g. `http://clickhouse:8123`).
    pub clickhouse_url: String,
    /// ClickHouse database name (all DDL/DML targets this).
    pub clickhouse_database: String,
    /// ClickHouse user.
    pub clickhouse_user: String,
    /// ClickHouse password. Empty is accepted for local dev (see DECISIONS D14).
    pub clickhouse_password: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing environment variable: {0}")]
    Missing(&'static str),
    #[error("invalid value for {var}: {reason}")]
    Invalid { var: &'static str, reason: String },
}

impl Config {
    /// Load from process environment.
    ///
    /// Required: all variables listed in `.env.example`. No defaults are
    /// applied silently — a missing variable is a startup error so
    /// mis-configured deployments fail fast.
    pub fn from_env() -> Result<Self, ConfigError> {
        let http_addr_raw = required("INGESTER_HTTP_ADDR")?;
        let http_addr: SocketAddr =
            http_addr_raw
                .parse()
                .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                    var: "INGESTER_HTTP_ADDR",
                    reason: e.to_string(),
                })?;

        let log_level = required("INGESTER_LOG_LEVEL")?;

        let log_json_raw = required("INGESTER_LOG_JSON")?;
        let log_json = match log_json_raw.as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            other => {
                return Err(ConfigError::Invalid {
                    var: "INGESTER_LOG_JSON",
                    reason: format!("expected true|false, got {other:?}"),
                });
            }
        };

        let clickhouse_url = required("CLICKHOUSE_URL")?;
        let clickhouse_database = required("CLICKHOUSE_DATABASE")?;
        let clickhouse_user = required("CLICKHOUSE_USER")?;
        // Password may be empty (local dev default), so read without the
        // `required` helper which rejects empty values.
        let clickhouse_password = std::env::var("CLICKHOUSE_PASSWORD")
            .map_err(|_| ConfigError::Missing("CLICKHOUSE_PASSWORD"))?;

        Ok(Self {
            http_addr,
            log_level,
            log_json,
            clickhouse_url,
            clickhouse_database,
            clickhouse_user,
            clickhouse_password,
        })
    }
}

fn required(key: &'static str) -> Result<String, ConfigError> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => Err(ConfigError::Invalid {
            var: key,
            reason: "value is empty".into(),
        }),
        Err(_) => Err(ConfigError::Missing(key)),
    }
}
