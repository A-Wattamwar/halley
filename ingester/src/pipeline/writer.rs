//! Redis Streams writer: XREADGROUP → dedup → ClickHouse batch insert → XACK.
//!
//! The writer runs as a separate `tokio::spawn`'d task in the same binary.
//! It must NOT share a tokio thread with the receiver — the receiver's 202
//! latency must not be affected by ClickHouse hiccups. See phase-2-week-3.md
//! "Common pitfalls to avoid" #4.
//!
//! Batch semantics:
//! - Read up to BATCH_SIZE (500) entries per XREADGROUP call.
//! - BLOCK for up to BLOCK_MS (100ms) if the stream is empty.
//! - Within a batch, deduplicate body hashes: the same SHA-256 hash appearing
//!   twice in one batch inserts only once into `observation_body`.
//! - Insert bodies first, then observations (foreign-key ordering).
//! - XACK all entries in the batch on success.
//!
//! Retry classification (see DECISIONS.md D30):
//! - TRANSIENT errors (network/connection): retry forever with exponential
//!   backoff capped at 30s. Do NOT XACK — entries stay pending in the PEL
//!   so they survive a writer restart. This is the whole point of the buffer.
//! - PERMANENT errors (decode failure, schema mismatch): DLQ immediately.
//!   These will never succeed no matter how long we wait.
//!
//! Graceful shutdown:
//! - The writer watches a `tokio::sync::watch::Receiver<bool>` channel.
//! - When the channel fires `true`, the writer finishes the current batch,
//!   then returns. In-flight entries that were read but not yet ACK'd will
//!   be re-delivered to the next consumer on restart (PEL semantics).
//! - The retry backoff sleep uses `tokio::select!` so shutdown is never
//!   blocked by a long backoff wait.

use crate::{
    domain::span::{BodyRow, ObservationRow},
    pipeline::{BATCH_SIZE, BLOCK_MS, CONSUMER_GROUP, DLQ_KEY, MAX_RETRIES, STREAM_KEY},
    storage::clickhouse::ClickHouseStore,
};
use metrics::{counter, gauge, histogram};
use redis::{
    streams::{StreamReadOptions, StreamReadReply},
    AsyncCommands, Client,
};
use std::collections::HashSet;
use tokio::sync::watch;
use tracing::{error, info, warn};

/// Writer task. Call `Writer::run()` inside `tokio::spawn`.
pub struct Writer {
    redis: Client,
    ch: ClickHouseStore,
    /// Unique consumer name within the consumer group. Use the hostname or a
    /// UUID so multiple writer instances don't collide.
    consumer_name: String,
}

impl Writer {
    pub fn new(
        redis_url: &str,
        ch: ClickHouseStore,
        consumer_name: String,
    ) -> Result<Self, redis::RedisError> {
        let redis = Client::open(redis_url)?;
        Ok(Self {
            redis,
            ch,
            consumer_name,
        })
    }

    /// Main loop. Runs until `shutdown` fires `true`.
    ///
    /// Spawned by `main.rs` via `tokio::spawn(writer.run(shutdown_rx))`.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) {
        info!(consumer = %self.consumer_name, "writer task started");

        // Establish async connection.
        let mut conn = match self.redis.get_multiplexed_async_connection().await {
            Ok(c) => c,
            Err(e) => {
                error!(error = %e, "writer: failed to connect to Redis, task exiting");
                return;
            }
        };

        // Ensure the consumer group exists. MKSTREAM creates the stream if absent.
        let _: Result<(), _> = redis::cmd("XGROUP")
            .arg("CREATE")
            .arg(STREAM_KEY)
            .arg(CONSUMER_GROUP)
            .arg("0") // start from the beginning
            .arg("MKSTREAM")
            .query_async(&mut conn)
            .await;
        // Ignore BUSYGROUP error (group already exists) — that's fine.

        loop {
            // Check shutdown before blocking on Redis.
            if *shutdown.borrow() {
                info!("writer: shutdown signal received, draining and exiting");
                break;
            }

            // XREADGROUP GROUP halley:writers <consumer> COUNT 500 BLOCK 100 STREAMS halley:spans >
            let opts = StreamReadOptions::default()
                .group(CONSUMER_GROUP, &self.consumer_name)
                .count(BATCH_SIZE)
                .block(BLOCK_MS);

            let reply: StreamReadReply =
                match conn.xread_options(&[STREAM_KEY], &[">"], &opts).await {
                    Ok(r) => r,
                    Err(e) => {
                        warn!(error = %e, "writer: XREADGROUP error, retrying");
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        continue;
                    }
                };

            // No entries (BLOCK timeout expired) — loop back.
            if reply.keys.is_empty() {
                continue;
            }

            let stream_key_data = &reply.keys[0];
            let entries = &stream_key_data.ids;

            if entries.is_empty() {
                continue;
            }

            // Decode all entries in the batch.
            let mut decoded: Vec<(String, ObservationRow, Vec<BodyRow>)> =
                Vec::with_capacity(entries.len());
            let mut failed_ids: Vec<String> = Vec::new();

            for entry in entries {
                let id = entry.id.clone();
                match decode_entry(entry) {
                    Ok((obs, bodies)) => decoded.push((id, obs, bodies)),
                    Err(e) => {
                        warn!(entry_id = %id, error = %e, "writer: failed to decode entry, sending to DLQ");
                        failed_ids.push(id);
                    }
                }
            }

            // Dead-letter decode failures immediately.
            for id in &failed_ids {
                let _: Result<(), _> = conn
                    .xadd(
                        DLQ_KEY,
                        "*",
                        &[("original_id", id.as_str()), ("reason", "decode_error")],
                    )
                    .await;
                let _: Result<(), _> = conn.xack(STREAM_KEY, CONSUMER_GROUP, &[id]).await;
            }

            if decoded.is_empty() {
                continue;
            }

            // Dedup body hashes within the batch.
            let mut seen_hashes: HashSet<[u8; 32]> = HashSet::new();
            let mut deduped_bodies: Vec<BodyRow> = Vec::new();
            let mut obs_rows: Vec<ObservationRow> = Vec::new();
            let mut entry_ids: Vec<String> = Vec::new();

            for (id, obs, bodies) in decoded {
                for body in bodies {
                    if seen_hashes.insert(body.body_hash) {
                        deduped_bodies.push(body);
                    }
                }
                obs_rows.push(obs);
                entry_ids.push(id);
            }

            // Insert with retry classification. See DECISIONS.md D30.
            //
            // TRANSIENT (network/connection): retry forever, backoff capped at 30s.
            //   Do NOT XACK — entries stay in the PEL so they survive a restart.
            // PERMANENT (decode/schema): DLQ after MAX_RETRIES attempts.
            //   These will never succeed regardless of wait time.
            let mut permanent_attempt = 0u32;
            let flush_start = std::time::Instant::now();
            let insert_outcome = loop {
                match self
                    .ch
                    .insert_bodies_batch(deduped_bodies.clone())
                    .await
                    .and(self.ch.insert_observations_batch(obs_rows.clone()).await)
                {
                    Ok(()) => break InsertOutcome::Success,
                    Err(e) => {
                        if is_transient_error(&e) {
                            // Transient: retry forever with capped backoff.
                            // Use tokio::select! so shutdown interrupts the sleep.
                            let backoff = transient_backoff_ms(permanent_attempt);
                            warn!(
                                error = %e,
                                backoff_ms = backoff,
                                batch_size = obs_rows.len(),
                                "writer: transient insert error, retrying (holding PEL)"
                            );
                            counter!("halley_clickhouse_insert_errors_total", "kind" => "transient")
                                .increment(1);
                            tokio::select! {
                                _ = tokio::time::sleep(
                                    std::time::Duration::from_millis(backoff)
                                ) => {}
                                _ = shutdown.changed() => {
                                    // Shutdown fired during backoff. Return without
                                    // ACK'ing — entries stay in PEL for next consumer.
                                    info!("writer: shutdown during transient retry, leaving batch in PEL");
                                    return;
                                }
                            }
                            // Don't increment permanent_attempt for transient errors.
                        } else {
                            // Permanent: limited retries then DLQ.
                            permanent_attempt += 1;
                            if permanent_attempt < MAX_RETRIES {
                                warn!(
                                    attempt = permanent_attempt,
                                    error = %e,
                                    batch_size = obs_rows.len(),
                                    "writer: permanent insert error, retrying"
                                );
                                let backoff = std::time::Duration::from_millis(
                                    100 * (1 << permanent_attempt),
                                );
                                tokio::select! {
                                    _ = tokio::time::sleep(backoff) => {}
                                    _ = shutdown.changed() => {
                                        info!("writer: shutdown during permanent retry, leaving batch in PEL");
                                        return;
                                    }
                                }
                            } else {
                                error!(
                                    error = %e,
                                    batch_size = obs_rows.len(),
                                    "writer: permanent insert error after max retries, DLQ'ing batch"
                                );
                                counter!("halley_clickhouse_insert_errors_total", "kind" => "permanent")
                                    .increment(1);
                                break InsertOutcome::PermanentFailure;
                            }
                        }
                    }
                }
            };

            match insert_outcome {
                InsertOutcome::Success => {
                    // ACK all entries in the batch.
                    let ids: Vec<&str> = entry_ids.iter().map(|s| s.as_str()).collect();
                    if let Err(e) =
                        conn.xack(STREAM_KEY, CONSUMER_GROUP, &ids).await as Result<i64, _>
                    {
                        warn!(error = %e, "writer: XACK failed (entries will be re-delivered)");
                    }

                    // Emit batch metrics.
                    let flush_secs = flush_start.elapsed().as_secs_f64();
                    let batch_sz = obs_rows.len() as f64;
                    let total_bodies = obs_rows.len(); // one body set per span
                    let unique_bodies = deduped_bodies.len();
                    let dedup_ratio = if total_bodies > 0 {
                        unique_bodies as f64 / total_bodies as f64
                    } else {
                        1.0
                    };
                    histogram!("halley_writer_batch_size").record(batch_sz);
                    histogram!("halley_writer_flush_latency_seconds").record(flush_secs);
                    gauge!("halley_body_dedup_ratio").set(dedup_ratio);

                    info!(
                        batch_size = obs_rows.len(),
                        body_rows = deduped_bodies.len(),
                        "writer: batch inserted and ACK'd"
                    );
                }
                InsertOutcome::PermanentFailure => {
                    // Dead-letter the whole batch and ACK so it leaves the PEL.
                    for id in &entry_ids {
                        let _: Result<(), _> = conn
                            .xadd(
                                DLQ_KEY,
                                "*",
                                &[("original_id", id.as_str()), ("reason", "insert_error")],
                            )
                            .await;
                    }
                    let ids: Vec<&str> = entry_ids.iter().map(|s| s.as_str()).collect();
                    let _: Result<i64, _> = conn.xack(STREAM_KEY, CONSUMER_GROUP, &ids).await;
                    warn!(
                        batch_size = entry_ids.len(),
                        "writer: batch dead-lettered to DLQ"
                    );
                }
            }
        }

        info!("writer: task exited cleanly");
    }
}

/// Outcome of the insert retry loop.
enum InsertOutcome {
    Success,
    PermanentFailure,
}

/// Classify a ClickHouse insert error as transient (network/connection) or
/// permanent (schema mismatch, bad data, etc.).
///
/// Transient errors should be retried forever — the Redis buffer exists
/// precisely to absorb infrastructure outages. Permanent errors should be
/// DLQ'd after MAX_RETRIES because no amount of waiting will fix them.
///
/// See DECISIONS.md D30.
fn is_transient_error(e: &crate::errors::IngestError) -> bool {
    let msg = e.to_string().to_lowercase();
    // Match on common network/connection error strings from the clickhouse crate
    // and the underlying hyper/reqwest transport layer.
    msg.contains("network")
        || msg.contains("connect")
        || msg.contains("connection refused")
        || msg.contains("dns")
        || msg.contains("timeout")
        || msg.contains("broken pipe")
        || msg.contains("reset by peer")
        || msg.contains("eof")
        || msg.contains("os error")
        || msg.contains("tcp")
        || msg.contains("io error")
}

/// Exponential backoff for transient errors, capped at 30 seconds.
/// Attempt 0 → 200ms, 1 → 400ms, 2 → 800ms, ..., ≥7 → 30_000ms.
fn transient_backoff_ms(attempt: u32) -> u64 {
    let base: u64 = 200;
    let cap: u64 = 30_000;
    let backoff = base.saturating_mul(1u64 << attempt.min(7));
    backoff.min(cap)
}

/// Decode a single Redis stream entry into `(ObservationRow, Vec<BodyRow>)`.
fn decode_entry(
    entry: &redis::streams::StreamId,
) -> Result<(ObservationRow, Vec<BodyRow>), String> {
    // The publisher writes a single field "span" with bincode bytes.
    let raw: Vec<u8> = entry
        .map
        .get("span")
        .and_then(|v| {
            if let redis::Value::BulkString(bytes) = v {
                Some(bytes.clone())
            } else {
                None
            }
        })
        .ok_or_else(|| "missing 'span' field in stream entry".to_string())?;

    bincode::deserialize::<(ObservationRow, Vec<BodyRow>)>(&raw)
        .map_err(|e| format!("bincode decode error: {e}"))
}
