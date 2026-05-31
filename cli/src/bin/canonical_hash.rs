//! Compute D22 canonical JSON hash via the shared `halley-canonical` crate —
//! the single Rust source of truth (see DECISIONS.md D22, D54).
//!
//! Reads JSON from stdin, prints `hex(SHA-256(canonicalize_json(value)))`.
//! Used for cross-language parity testing: Python shim vs Rust.
//!
//! Usage:
//!   echo '{"z":1,"a":2}' | cargo run --bin canonical-hash

use halley_canonical::{canonical_hash, canonicalize_json};
use serde_json::Value;

fn main() {
    let input = std::io::read_to_string(std::io::stdin()).expect("reading stdin");
    let value: Value = serde_json::from_str(input.trim()).expect("parsing JSON");
    // Canonical string for inspection (stderr); hash for the contract (stdout).
    let canonical = canonicalize_json(&value);
    let hash = canonical_hash(&value);
    eprintln!("canonical: {}", &canonical[..canonical.len().min(200)]);
    println!("{}", hex::encode(hash));
}

#[cfg(test)]
mod tests {
    use halley_canonical::canonicalize_json;
    use serde_json::Value;

    /// Local parity guard: a divergence in the shared crate's key-ordering
    /// behavior must fail here too, not just in the ingester. Keeps the CLI
    /// honest against the D22 contract (DECISIONS.md D22).
    #[test]
    fn canonical_hash_bin_uses_d22_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":1,"a":2,"m":3}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"m":3,"z":1,"a":2}"#).unwrap();
        assert_eq!(canonicalize_json(&a), canonicalize_json(&b));
        assert_eq!(canonicalize_json(&a), r#"{"a":2,"m":3,"z":1}"#);
    }
}
