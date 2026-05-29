//! Compute D22 canonical JSON hash — identical algorithm to
//! `ingester/src/domain/span.rs::canonicalize_json`.
//!
//! Reads JSON from stdin, prints `hex(SHA-256(canonicalize_json(value)))`.
//! Used for cross-language parity testing: Python shim vs Rust.
//!
//! Usage:
//!   echo '{"z":1,"a":2}' | cargo run --bin canonical-hash

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// D22 canonical JSON — byte-identical copy of ingester/src/domain/span.rs.
fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
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
        other => serde_json::to_string(other).expect("primitive serialization"),
    }
}

fn main() {
    let input = std::io::read_to_string(std::io::stdin()).expect("reading stdin");
    let value: Value = serde_json::from_str(input.trim()).expect("parsing JSON");
    let canonical = canonicalize_json(&value);
    let hash = Sha256::digest(canonical.as_bytes());
    // Also print canonical string on stderr for inspection.
    eprintln!("canonical: {}", &canonical[..canonical.len().min(200)]);
    println!("{}", hex::encode(hash));
}
