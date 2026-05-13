//! Canonical span domain model.
//!
//! Day 3: this module is a stub. Day 6 will add:
//!   - `RawSpan`: the incoming canonical JSON shape (see the Week 1 plan
//!     and `ingester/fixtures/hello-span.json`).
//!   - `ObservationRow` / `BodyRow`: ClickHouse row types with
//!     `clickhouse::Row` derive, holding raw bytes for FixedString(N) cols.
//!   - `TryInto<ObservationRow>` for `RawSpan` with hex-id validation,
//!     `run_id = trace_id` defaulting, canonical-JSON body hashing.
//!   - A `canonicalize_json` helper (sort keys, compact, leave numbers
//!     as `serde_json::Number`). Pinned as a code comment that it is
//!     NOT RFC 8785 JCS — see the user's Day 1 sign-off.
//!   - Unit tests: hex→bytes→hex round-trip asserting length, and
//!     "two bodies differing only in key order hash the same."
