//! Redis Streams publisher: XADD one entry per span.
//!
//! The publisher is the write side of the pipeline. It encodes the
//! already-normalized, already-hashed `(ObservationRow, Vec<BodyRow>)` tuple
//! using bincode and publishes it to the `halley:spans` stream.
//!
//! The receiver calls `Publisher::publish()` after the full pipeline:
//!   OtlpSpan → CanonicalSpan → (ObservationRow, Vec<BodyRow>) → publish
//!
//! See DECISIONS.md D26 for encoding rationale.

use crate::{
    domain::span::{BodyRow, ObservationRow},
    pipeline::STREAM_KEY,
};
use redis::{aio::MultiplexedConnection, AsyncCommands, Client};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PublishError {
    #[error("redis error: {0}")]
    Redis(#[from] redis::RedisError),
    #[error("bincode encode error: {0}")]
    Encode(#[from] bincode::Error),
}

/// Publishes span entries to the `halley:spans` Redis stream.
///
/// Cheap to clone: the underlying `MultiplexedConnection` is `Arc`-based.
#[derive(Clone)]
pub struct Publisher {
    conn: MultiplexedConnection,
}

impl Publisher {
    /// Connect to Redis and return a `Publisher`.
    pub async fn new(url: &str) -> Result<Self, PublishError> {
        let client = Client::open(url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { conn })
    }

    /// Encode `(obs, bodies)` with bincode and XADD to `halley:spans`.
    ///
    /// The stream entry has a single field `"span"` whose value is the
    /// bincode-encoded bytes. The writer decodes this field.
    ///
    /// Returns the Redis stream entry ID on success.
    pub async fn publish(
        &mut self,
        obs: &ObservationRow,
        bodies: &[BodyRow],
    ) -> Result<String, PublishError> {
        let payload: Vec<u8> = bincode::serialize(&(obs, bodies))?;
        // XADD halley:spans * span <bytes>
        // "*" tells Redis to auto-generate the entry ID.
        let id: String = self
            .conn
            .xadd(STREAM_KEY, "*", &[("span", payload)])
            .await?;
        Ok(id)
    }
}
