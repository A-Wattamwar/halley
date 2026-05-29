"""
D22-compatible canonical JSON serialization and hashing.

This MUST produce byte-identical output to the Rust ingester's
`canonicalize_json` in `ingester/src/domain/span.rs`:

  1. Recursively sort all object keys in Unicode code-point order.
  2. Compact output — no whitespace between tokens.
  3. Numbers preserved as-is — no float normalization, no integer coercion,
     no exponent rewriting. Python's json.dumps with default encoder
     matches serde_json::Number for well-formed LLM payloads.

We use json.dumps with sort_keys=False (we sort manually with recursive
walk) and separators=(',', ':') for compact output. The recursive walk
ensures nested objects are also sorted.
"""

import hashlib
import json
from typing import Any


def canonicalize_json(value: Any) -> str:
    """Produce canonical JSON matching the Rust D22 implementation."""
    if isinstance(value, dict):
        # Sort keys by Unicode code-point order (Python str comparison = this).
        inner = ",".join(
            f"{json.dumps(k, ensure_ascii=False, separators=(',', ':'))}:{canonicalize_json(v)}"
            for k, v in sorted(value.items())
        )
        return "{" + inner + "}"
    elif isinstance(value, list):
        inner = ",".join(canonicalize_json(item) for item in value)
        return "[" + inner + "]"
    elif isinstance(value, bool):
        return "true" if value else "false"
    elif value is None:
        return "null"
    elif isinstance(value, int):
        return str(value)
    elif isinstance(value, float):
        # Python json.dumps and Rust serde_json agree on standard LLM payload
        # floats (temperature: 0.0, top_p: 1.0, penalty: 0.7, etc.).
        #
        # KNOWN LIMITATION (v1): pathological floats with scientific-notation
        # exponents can diverge. Python renders 1e20 as "1e+20" while Rust
        # serde_json renders it as "1e20"; Python renders 1e-7 as "1e-07"
        # while Rust renders "1e-7". These values do not appear in LLM chat
        # completion request bodies (model, messages, temperature, max_tokens,
        # top_p, frequency_penalty, presence_penalty are all short decimals or
        # integers). Worker-written fixtures containing such values are not
        # guaranteed shim-replayable. This is documented in docs/fixture-format.md.
        return json.dumps(value)
    elif isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_hash(value: Any) -> str:
    """SHA-256 of the D22 canonical JSON, returned as lowercase hex."""
    canonical = canonicalize_json(value)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
