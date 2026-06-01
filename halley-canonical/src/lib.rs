//! Halley canonical JSON + SHA-256 body hashing — the single source of truth.
//!
//! # Canonical JSON rule (NOT RFC 8785 / JCS) — DECISIONS.md D22
//!
//! Bodies are hashed after serializing to a canonical JSON form defined as:
//!   1. Recursively sort all object keys alphabetically (Unicode code-point order).
//!   2. Compact output — no whitespace between tokens.
//!   3. Leave numbers as `serde_json::Number` — no float normalization,
//!      no integer coercion, no exponent rewriting.
//!
//! This is intentionally simpler than RFC 8785 (JCS). JCS additionally
//! normalizes floating-point numbers to IEEE 754 decimal representation,
//! which requires a non-trivial algorithm and a dependency we do not want.
//! Our bodies are LLM request/response JSON; numbers in those payloads are
//! token counts, temperatures, and costs — all of which round-trip through
//! `serde_json::Number` without loss. Two bodies that differ only in key
//! order MUST hash the same; that is the acceptance bar (see the unit test
//! `canonical_json_key_order`).
//!
//! This crate is the ONE Rust home for the D22 algorithm. The ingester
//! (`ingester/src/domain/span.rs`) and the CLI parity tool
//! (`cli/src/bin/canonical_hash.rs`) both depend on it. The Python sibling
//! (`sdk-py/halley_sdk/canonical.py`) cannot share a Rust crate and is
//! guarded by a cross-language parity test. See DECISIONS.md D22.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Produce canonical JSON from a `serde_json::Value`.
///
/// # Canonical JSON rule (NOT RFC 8785 / JCS)
///
/// - Recursively sort object keys alphabetically (Unicode code-point order).
/// - Compact output — no whitespace.
/// - Numbers are left as-is (`serde_json::Number`); no float normalization.
///
/// Two objects that differ only in key order produce identical output and
/// therefore identical SHA-256 hashes. This is the acceptance bar verified
/// by the `canonical_json_key_order` unit test. See DECISIONS.md D22.
pub fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            // Collect into a BTreeMap to sort keys.
            let sorted: BTreeMap<&str, &Value> = map.iter().map(|(k, v)| (k.as_str(), v)).collect();
            let inner: Vec<String> = sorted
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("key serialization"),
                        canonicalize_json(v)
                    )
                })
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(arr) => {
            let inner: Vec<String> = arr.iter().map(canonicalize_json).collect();
            format!("[{}]", inner.join(","))
        }
        // Primitives: delegate to serde_json which produces compact output
        // and preserves Number exactly.
        other => serde_json::to_string(other).expect("primitive serialization"),
    }
}

/// SHA-256 of the D22 canonical JSON bytes of `value`.
///
/// Returns the raw 32-byte digest. Callers that need hex should encode it
/// themselves (e.g. via the `hex` crate) — this crate intentionally keeps
/// its dependency surface to `serde_json` + `sha2` only.
pub fn canonical_hash(value: &Value) -> [u8; 32] {
    let canonical = canonicalize_json(value);
    let digest = Sha256::digest(canonical.as_bytes());
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&digest);
    hash
}

// ---------------------------------------------------------------------------
// Unit tests — moved here from ingester/src/domain/span.rs (D22 source).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    /// Two JSON objects with the same keys/values but different key order
    /// must produce identical SHA-256 hashes after canonicalization.
    #[test]
    fn canonical_json_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":1,"a":2,"m":3}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"m":3,"z":1,"a":2}"#).unwrap();

        let ca = canonicalize_json(&a);
        let cb = canonicalize_json(&b);

        // Both must produce the same canonical string.
        assert_eq!(ca, cb, "canonical strings differ: {ca:?} vs {cb:?}");

        // And therefore the same hash.
        let ha = Sha256::digest(ca.as_bytes());
        let hb = Sha256::digest(cb.as_bytes());
        assert_eq!(ha, hb);
    }

    /// Nested objects must also be sorted recursively.
    #[test]
    fn canonical_json_nested_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":{"b":1,"a":2},"a":{"y":3,"x":4}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"x":4,"y":3},"z":{"a":2,"b":1}}"#).unwrap();
        assert_eq!(canonicalize_json(&a), canonicalize_json(&b));
    }

    /// `canonical_hash` must equal the SHA-256 of the canonical string.
    #[test]
    fn canonical_hash_matches_manual_digest() {
        let v: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        let canonical = canonicalize_json(&v);
        assert_eq!(canonical, r#"{"a":1,"b":2}"#);

        let expected = Sha256::digest(canonical.as_bytes());
        assert_eq!(canonical_hash(&v), expected.as_slice());
    }
}
