"""
Tests for D22 canonical JSON parity between Python shim and Rust ingester.

The Rust implementation in ingester/src/domain/span.rs::canonicalize_json:
  1. Recursively sorts object keys (Unicode code-point order via BTreeMap).
  2. Compact output (no whitespace).
  3. Numbers preserved as-is (serde_json::Number).
  4. Strings escaped via serde_json::to_string (which matches json.dumps).

These tests verify byte-identical output for representative LLM payloads.
"""

import hashlib
import json

from halley_sdk.canonical import canonical_hash, canonicalize_json


class TestCanonicalJson:
    """Verify canonicalize_json matches Rust behavior."""

    def test_key_order(self):
        """Keys sorted alphabetically — mirrors Rust canonical_json_key_order test."""
        a = {"z": 1, "a": 2, "m": 3}
        b = {"m": 3, "z": 1, "a": 2}
        assert canonicalize_json(a) == canonicalize_json(b)
        assert canonicalize_json(a) == '{"a":2,"m":3,"z":1}'

    def test_nested_key_order(self):
        """Nested objects sorted recursively — mirrors Rust canonical_json_nested_key_order."""
        a = {"z": {"b": 1, "a": 2}, "a": {"y": 3, "x": 4}}
        b = {"a": {"x": 4, "y": 3}, "z": {"a": 2, "b": 1}}
        assert canonicalize_json(a) == canonicalize_json(b)
        assert canonicalize_json(a) == '{"a":{"x":4,"y":3},"z":{"a":2,"b":1}}'

    def test_array_preserved(self):
        assert canonicalize_json([3, 1, 2]) == "[3,1,2]"

    def test_string_escaping(self):
        assert canonicalize_json("hello\nworld") == '"hello\\nworld"'

    def test_null(self):
        assert canonicalize_json(None) == "null"

    def test_boolean(self):
        assert canonicalize_json(True) == "true"
        assert canonicalize_json(False) == "false"

    def test_float_temperature(self):
        """Temperature 0.7 — common in LLM payloads."""
        assert canonicalize_json(0.7) == "0.7"

    def test_float_zero(self):
        """Temperature 0 as float — serde_json renders 0.0 as '0.0'."""
        # In Python, json.dumps(0.0) -> "0.0" which matches serde_json.
        assert canonicalize_json(0.0) == "0.0"

    def test_integer(self):
        assert canonicalize_json(42) == "42"

    def test_realistic_openai_request(self):
        """A realistic chat completion request body."""
        body = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "What is 2+2?"},
            ],
            "temperature": 0.0,
            "max_tokens": 1024,
        }
        canonical = canonicalize_json(body)
        # Keys must be sorted: max_tokens, messages, model, temperature.
        # Within messages, each dict's keys sorted: content, role.
        expected = (
            '{"max_tokens":1024,'
            '"messages":[{"content":"You are helpful.","role":"system"},{"content":"What is 2+2?","role":"user"}],'
            '"model":"gpt-4o-mini",'
            '"temperature":0.0}'
        )
        assert canonical == expected

    def test_hash_stability(self):
        """Same body hashes identically regardless of key order."""
        body1 = {"model": "gpt-4o-mini", "messages": [], "temperature": 0.7}
        body2 = {"temperature": 0.7, "messages": [], "model": "gpt-4o-mini"}
        assert canonical_hash(body1) == canonical_hash(body2)

    def test_hash_is_lowercase_hex(self):
        h = canonical_hash({"hello": "world"})
        assert len(h) == 64
        assert h == h.lower()
        assert all(c in "0123456789abcdef" for c in h)


class TestD22RustParity:
    """
    Cross-validate against known Rust outputs.

    To produce the reference values:
      1. Run the Rust test: cargo test -p halley-ingester canonical_json
      2. Or: compute SHA-256 of the canonical JSON string manually.
    """

    def test_simple_object_hash(self):
        """{"a":2,"m":3,"z":1} — the Rust unit test body."""
        body = {"z": 1, "a": 2, "m": 3}
        canonical = canonicalize_json(body)
        assert canonical == '{"a":2,"m":3,"z":1}'
        h = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        assert h == canonical_hash(body)
        expected_hash = hashlib.sha256(b'{"a":2,"m":3,"z":1}').hexdigest()
        assert h == expected_hash

    def test_realistic_openai_body_parity(self):
        """Rust canonical-hash binary produces this hash for the same body.

        Verified via: cat body.json | cargo run --bin canonical-hash
        """
        body = {
            "messages": [
                {"role": "system", "content": "You are a question classifier. Reply with exactly one word."},
                {"role": "user", "content": (
                    "Classify this question into ONE category:\n"
                    "- math: calculations, numbers, arithmetic, algebra, geometry\n"
                    "- coding: write code, function, program, algorithm\n"
                    "- planning: sequence of actions, steps, moves, logistics\n"
                    "- future: predictions, forecasts, future events\n"
                    "- general: factual questions, reading comprehension, common sense, multiple choice\n"
                    "\n"
                    "Question: Solve: 47 * 23 + 19\n"
                    "\n"
                    "Reply with exactly one word: math, coding, planning, future, or general"
                )},
            ],
            "model": "gpt-4o-mini",
            "max_tokens": 1024,
            "temperature": 0.0,
        }
        RUST_HASH = "006959f34df0e7ce4a5619cad0f2acad74e84d3ccdf55f8b42d9a7e9e2cdac83"
        assert canonical_hash(body) == RUST_HASH

    def test_unicode_body_parity(self):
        """Non-ASCII content: café, checkmark, CJK. Rust hash verified."""
        body = {
            "content": "café ✓ 你好",
            "temperature": 0.7,
            "model": "gpt-4o-mini",
            "tags": ["日本語", "Ñoño"],
        }
        RUST_HASH = "7e0a0c9d4485e58c0cef5f491eca2cb7b990b11b562e0d1e06f6230ca7c1a458"
        assert canonical_hash(body) == RUST_HASH
