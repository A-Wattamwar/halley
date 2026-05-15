//! Redis Streams pipeline: publisher (XADD) and writer (XREADGROUP → ClickHouse).
//!
//! Architecture (ARCHITECTURE.md §3.2, §3.5, phase-2-overview.md):
//!
//! ```text
//! Receiver (axum / tonic)
//!   → normalize → hash → Publisher::publish()
//!       → XADD halley:spans  (one entry per span)
//!
//! Writer::run()  (separate tokio::spawn'd task)
//!   → XREADGROUP halley:writers COUNT 500 BLOCK 100
//!       → decode (ObservationRow, Vec<BodyRow>) via bincode
//!           → dedup body hashes within batch
//!               → batch insert to ClickHouse
//!                   → XACK on success
//! ```
//!
//! Stream entry encoding: bincode v1. See DECISIONS.md D26.

pub mod ingest;
pub mod publisher;
pub mod writer;

/// Redis stream key for ingest pipeline.
pub const STREAM_KEY: &str = "halley:spans";

/// Consumer group name. Multiple writer instances can share this group.
pub const CONSUMER_GROUP: &str = "halley:writers";

/// DLQ stream key for spans that fail after all retries.
pub const DLQ_KEY: &str = "halley:spans:dlq";

/// Maximum number of entries to read per XREADGROUP call.
pub const BATCH_SIZE: usize = 500;

/// BLOCK timeout in milliseconds for XREADGROUP.
pub const BLOCK_MS: usize = 100;

/// Number of retry attempts before dead-lettering to DLQ.
pub const MAX_RETRIES: u32 = 3;
