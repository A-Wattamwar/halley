"""
Halley REPLAY mode shim for the OpenAI Python SDK.

Patches the same `httpx.Client.send` interception point as RECORD mode.
On each outgoing call, computes the D22 canonical match_key, looks up the
cassette using ordinal per-key consumption, and returns a synthetic response
WITHOUT any network call.

Pure mode: any miss raises ReplayMiss (non-zero exit). Hybrid mode is Day 3.
"""

import atexit
import json
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import httpx

from halley_sdk.canonical import canonical_hash


class ReplayMiss(Exception):
    """Raised in pure mode when no cassette match exists."""


# ── Cassette ──────────────────────────────────────────────────────────────

class Cassette:
    """Loaded v1 fixture with ordinal cursor per match_key."""

    def __init__(self, fixture_path: str):
        self.fixture_path = fixture_path
        with open(fixture_path) as f:
            self.fixture = json.load(f)

        self.observations: list[dict] = self.fixture.get("observations", [])
        self.invariants: dict = self.fixture.get("invariants", {})

        # Build ordinal lookup: match_key → [obs indices in order].
        self._key_to_indices: dict[str, list[int]] = defaultdict(list)
        for obs in self.observations:
            mk = obs.get("match_key", "")
            if mk:
                self._key_to_indices[mk].append(obs["index"])

        # Per-key cursor: how many times each key has been consumed.
        self._cursors: dict[str, int] = defaultdict(int)

        # Resolve the fixture's parent dir for body file loading.
        self._fixture_dir = Path(fixture_path).parent

    def lookup(self, match_key: str) -> dict | None:
        """Find the next observation for this match_key (ordinal cursor).

        Returns the observation dict or None if exhausted/missing.
        """
        indices = self._key_to_indices.get(match_key, [])
        cursor = self._cursors[match_key]
        if cursor >= len(indices):
            return None
        obs_index = indices[cursor]
        self._cursors[match_key] = cursor + 1
        return self.observations[obs_index]

    def load_body(self, body_ref: str | None) -> Any:
        """Load a body file by its ref path (e.g. halley/fixtures/<slug>/bodies/sha256-xxx.json)."""
        if not body_ref:
            return None
        ref_path = Path(body_ref)
        # body_ref is like "halley/fixtures/<slug>/bodies/sha256-xxx.json".
        # _fixture_dir is the dir containing <slug>.json (which is halley/fixtures/).
        # So the file is at _fixture_dir / <slug> / bodies / sha256-xxx.json.
        # Try: relative to the fixture_dir's parent's parent (the repo root).
        candidates = [
            self._fixture_dir / ref_path.relative_to("halley/fixtures") if str(ref_path).startswith("halley/fixtures") else None,
            self._fixture_dir.parent.parent / ref_path,
            Path(body_ref),
        ]
        for bp in candidates:
            if bp is not None and bp.exists():
                with open(bp) as f:
                    return json.load(f)
        return None

    @property
    def slug(self) -> str:
        return Path(self.fixture_path).stem


# ── Replay state ──────────────────────────────────────────────────────────

_original_send: object = None
_cassette: Cassette | None = None
_served: list[dict] = []
_call_index: int = 0
_patched: bool = False
_miss_errors: list[str] = []


def _replay_send(self: httpx.Client, request: httpx.Request, **kwargs) -> httpx.Response:
    """Intercept httpx requests and serve from cassette."""
    global _call_index

    url = str(request.url)
    is_openai = (
        "api.openai.com" in url
        or "openai" in url.lower()
    ) and request.method == "POST"

    if not is_openai:
        return _original_send(self, request, **kwargs)

    # Parse the request body.
    request_body = None
    try:
        raw_bytes = request.content
        if raw_bytes:
            request_body = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    if request_body is None:
        return _original_send(self, request, **kwargs)

    match_key = canonical_hash(request_body)
    obs = _cassette.lookup(match_key) if _cassette else None

    if obs is None:
        msg = (
            f"[halley-shim] REPLAY MISS at call #{_call_index}: "
            f"match_key={match_key[:16]}... not found in cassette "
            f"(or cursor exhausted). Pure mode — failing."
        )
        print(msg, flush=True)
        _miss_errors.append(msg)
        # Write served entries before dying (for partial evaluation).
        _write_served()
        import sys
        sys.exit(78)  # EX_CONFIG — distinct from generic failure

    # Load the recorded response body.
    output_body = _cassette.load_body(obs.get("output_body_ref"))
    if output_body is None:
        output_body = {}

    response_bytes = json.dumps(output_body).encode("utf-8")

    served_entry = {
        "call_index": _call_index,
        "match_key": match_key,
        "observation_index": obs["index"],
        "operation": obs.get("operation", ""),
        "model": obs.get("model", ""),
        "input_tokens": obs.get("input_tokens", 0),
        "output_tokens": obs.get("output_tokens", 0),
        "served_at_ms": int(time.time() * 1000),
        "input_body": request_body,
        "output_body": output_body,
    }
    _served.append(served_entry)

    model = request_body.get("model", obs.get("model", ""))
    print(
        f"[halley-shim] REPLAY HIT  #{_call_index}: "
        f"{model} {obs.get('operation', '?')} "
        f"→ cassette obs[{obs['index']}] "
        f"(match_key={match_key[:16]}...)",
        flush=True,
    )
    _call_index += 1

    # Build a synthetic httpx.Response.
    return httpx.Response(
        status_code=200,
        headers={"content-type": "application/json"},
        content=response_bytes,
        request=request,
    )


# ── Patch / unpatch ──────────────────────────────────────────────────────

def patch(cassette_path: str) -> None:
    """Activate REPLAY mode with the given cassette."""
    global _original_send, _cassette, _call_index, _patched, _served, _miss_errors

    if _patched:
        return

    _cassette = Cassette(cassette_path)
    _original_send = httpx.Client.send
    httpx.Client.send = _replay_send
    _call_index = 0
    _served = []
    _miss_errors = []
    _patched = True

    atexit.register(_on_exit)
    print(
        f"[halley-shim] REPLAY mode active "
        f"(cassette={_cassette.slug}, {len(_cassette.observations)} observations)",
        flush=True,
    )


def unpatch() -> None:
    """Deactivate REPLAY mode."""
    global _patched
    if not _patched:
        return
    httpx.Client.send = _original_send
    _patched = False


def get_served() -> list[dict]:
    """Return the list of served replay entries (for invariant evaluation)."""
    return list(_served)


def get_miss_errors() -> list[str]:
    """Return any miss errors that occurred."""
    return list(_miss_errors)


_written = False


def _write_served() -> None:
    """Write served entries to disk (idempotent)."""
    global _written
    if _written:
        return
    _written = True
    hits = len(_served)
    misses = len(_miss_errors)
    total = _cassette.observations if _cassette else []
    print(
        f"[halley-shim] replay done: {hits} hits, {misses} misses, "
        f"{len(total)} cassette observations",
        flush=True,
    )
    output_path = os.environ.get("HALLEY_SERVED_JSON")
    if output_path:
        with open(output_path, "w") as f:
            json.dump(_served, f, indent=2)
        print(f"[halley-shim] served entries written to {output_path}", flush=True)


def _on_exit() -> None:
    """atexit handler — delegates to _write_served."""
    _write_served()
