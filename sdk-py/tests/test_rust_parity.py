"""
D22 canonical-hash PARITY GUARD — Python (sdk-py) vs Rust (halley-canonical).

This is the permanent guard the Phase 6 Day-1 `halley-canonical` extraction
relies on (DECISIONS.md D22, D54). It pipes the SAME inputs through BOTH
implementations and asserts byte-identical hex:

  - Python:  halley_sdk.canonical.canonical_hash(value)
  - Rust:    echo <json> | cli/target/.../canonical-hash   (prints hex SHA-256
             of the D22 canonical JSON, via the halley-canonical crate)

If the two ever diverge — e.g. someone "improves" one canonicalizer — this test
FAILS LOUDLY. It runs in the `parity` job of .github/workflows/ci.yml on every
push/PR.

Inputs include the adversarial non-ASCII/Unicode case from Week 11 Day 1 and a
real recorded fixture body (content-addressed, so its filename is itself the
expected D22 hash — an independent third check).
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from halley_sdk.canonical import canonical_hash, canonicalize_json

# Repo root = .../halley (this file is sdk-py/tests/test_rust_parity.py).
REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_DIR = REPO_ROOT / "cli"


def _locate_or_build_canonical_hash() -> str:
    """
    Return the path to the `canonical-hash` Rust binary, building it if needed.

    Prefers an already-built binary (release > debug). Falls back to
    `cargo build --release --bin canonical-hash` in cli/. Skips the test only if
    cargo is entirely unavailable (never in CI, where Rust is installed).
    """
    release = CLI_DIR / "target" / "release" / "canonical-hash"
    debug = CLI_DIR / "target" / "debug" / "canonical-hash"
    if release.exists():
        return str(release)
    if debug.exists():
        return str(debug)

    if shutil.which("cargo") is None:
        pytest.skip("cargo not available and canonical-hash binary not built")

    subprocess.run(
        ["cargo", "build", "--release", "--bin", "canonical-hash"],
        cwd=str(CLI_DIR),
        check=True,
        capture_output=True,
    )
    if release.exists():
        return str(release)
    raise RuntimeError("canonical-hash build succeeded but binary not found")


def _rust_hash(binary: str, value) -> str:
    """Pipe `value` as JSON through the Rust canonical-hash binary; return hex."""
    payload = json.dumps(value)
    proc = subprocess.run(
        [binary],
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )
    # The binary prints the hex hash on stdout (canonical string preview on stderr).
    return proc.stdout.strip()


# Inputs exercised through BOTH implementations.
PARITY_INPUTS = {
    "simple_key_order": {"z": 1, "a": 2, "m": 3},
    "nested": {"z": {"b": 1, "a": 2}, "a": {"y": 3, "x": 4}},
    "realistic_openai_request": {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "What is 2+2?"},
        ],
        "temperature": 0.0,
        "max_tokens": 1024,
    },
    # The Week 11 Day 1 adversarial non-ASCII / Unicode case: non-ASCII keys
    # that must sort by Unicode code point, emoji, CJK, Hebrew, nested floats.
    "adversarial_unicode": {
        "zzz": "éüñ café",
        "emoji": "🚀✨",
        "mixed": {"Ångström": 1, "a": 2, "中文": [3, 4, {"שלום": True}]},
        "num": 1.0000000001,
        "neg": -0.5,
        "big": 123456789012345,
        "nested": {"b": {"d": 4, "c": 3}, "a": {"z": 26, "y": 25}},
        "unicode_key_ø": "value",
        "arr": [{"k2": 2, "k1": 1}, "æøå", None, False],
    },
}


@pytest.fixture(scope="module")
def canonical_hash_bin() -> str:
    return _locate_or_build_canonical_hash()


@pytest.mark.parametrize("name", sorted(PARITY_INPUTS.keys()))
def test_python_rust_hash_parity(canonical_hash_bin: str, name: str):
    """Python and Rust must produce byte-identical D22 hashes for each input."""
    value = PARITY_INPUTS[name]
    py = canonical_hash(value)
    rs = _rust_hash(canonical_hash_bin, value)
    assert py == rs, (
        f"D22 PARITY BREAK for '{name}':\n"
        f"  python: {py}\n"
        f"  rust:   {rs}\n"
        f"  python canonical: {canonicalize_json(value)}"
    )


def test_real_recorded_body_parity(canonical_hash_bin: str):
    """
    A real recorded fixture body: its content-addressed filename IS the D22
    hash, giving three-way agreement (filename == Python == Rust).
    """
    bodies = sorted(
        REPO_ROOT.glob("examples/replay-target/halley/fixtures/**/bodies/sha256-*.json")
    )
    if not bodies:
        pytest.skip("no recorded fixture bodies found in examples/replay-target")

    body_path = bodies[0]
    # Filename form: sha256-<64hex>.json
    expected_from_filename = body_path.stem.replace("sha256-", "")
    value = json.loads(body_path.read_text())

    py = canonical_hash(value)
    rs = _rust_hash(canonical_hash_bin, value)

    assert py == rs, f"Python/Rust divergence on real body {body_path.name}: {py} != {rs}"
    assert py == expected_from_filename, (
        f"hash mismatch vs content-addressed filename for {body_path.name}:\n"
        f"  computed: {py}\n"
        f"  filename: {expected_from_filename}"
    )
