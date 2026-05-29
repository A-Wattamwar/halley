"""
Halley REPLAY mode shim (pure and hybrid) for the OpenAI Python SDK.

Patches `httpx.Client.send` at the same interception point as RECORD mode.

Pure mode (default):
  On each intercepted call, computes D22 match_key, looks up the cassette
  via ordinal per-key cursor. HIT → synthetic response, no network call.
  MISS → sys.exit(78) with a clear error. $0 cost guaranteed.

Hybrid mode (HALLEY_HYBRID=1 or HALLEY_MODE=hybrid):
  HIT → served from cassette ($0).
  MISS → real live call to the provider, response recorded as a new
         cassette version for diffing. Reports live-call count + cost.

Both modes write served entries to HALLEY_SERVED_JSON for invariant evaluation.
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
from halley_sdk.schema_inference import compute_span_cost


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
        self.slug = Path(fixture_path).stem

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
        """Load a body file by its ref path.

        Handles two ref styles produced by different writers:
          - Short form (shim recorder): "bodies/sha256-<h>.json"
            → resolved relative to <fixtures_dir>/<slug>/
          - Long form (worker, tests):  "halley/fixtures/<slug>/bodies/sha256-<h>.json"
            → resolved by stripping "halley/fixtures/" prefix and joining to fixtures_dir
        """
        if not body_ref:
            return None
        ref_path = Path(body_ref)
        slug_dir = self._fixture_dir / self.slug
        candidates: list[Path] = [
            # Long form: strip the "halley/fixtures/" repo-root prefix.
            self._fixture_dir / ref_path.relative_to("halley/fixtures")
            if str(ref_path).startswith("halley/fixtures")
            else None,  # type: ignore[arg-type]
            slug_dir / ref_path,       # short form: <fixtures_dir>/<slug>/bodies/…
            self._fixture_dir / ref_path,  # fallback
            Path(body_ref),            # absolute path
        ]
        for bp in candidates:
            if bp is not None and bp.exists():
                with open(bp) as f:
                    return json.load(f)
        return None


# ── Module-level state ────────────────────────────────────────────────────

_original_send: Any = None
_cassette: Cassette | None = None
_mode: str = "pure"  # "pure" or "hybrid"
_served: list[dict] = []        # all served entries (hits + live misses)
_live_calls: list[dict] = []    # hybrid: only the live-call entries
_call_index: int = 0
_patched: bool = False
_miss_errors: list[str] = []
_written: bool = False

# Irreversible tool config: set from env HALLEY_IRREVERSIBLE_TOOLS (comma-sep)
_irreversible_tools: set[str] = set()


def _is_openai_post(request: httpx.Request) -> bool:
    url = str(request.url)
    return (
        "api.openai.com" in url
        or "openai" in url.lower()
    ) and request.method == "POST"


def _parse_request_body(request: httpx.Request) -> dict | None:
    try:
        raw = request.content
        if raw:
            return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass
    return None


def _check_irreversible_tool(request_body: dict) -> None:
    """Guard: refuse live call if tools in the request are marked irreversible."""
    if not _irreversible_tools:
        return
    tools = request_body.get("tools", [])
    for tool in tools:
        name = (tool.get("function") or {}).get("name") or tool.get("name", "")
        if name in _irreversible_tools:
            msg = (
                f"[halley-shim] IRREVERSIBLE TOOL GUARD: tool '{name}' is marked "
                f"irreversible and this call is a cassette miss in hybrid mode. "
                f"Pass --allow-irreversible to permit live calls for irreversible tools."
            )
            print(msg, flush=True)
            _miss_errors.append(msg)
            _write_served()
            import sys
            sys.exit(79)  # EX_DATAERR-adjacent, distinct from pure-miss (78)


# ── Interceptor ──────────────────────────────────────────────────────────

def _replay_send(self: httpx.Client, request: httpx.Request, **kwargs) -> httpx.Response:
    """Intercept httpx requests: serve from cassette (HIT) or handle miss."""
    global _call_index

    if not _is_openai_post(request):
        return _original_send(self, request, **kwargs)

    request_body = _parse_request_body(request)
    if request_body is None:
        return _original_send(self, request, **kwargs)

    match_key = canonical_hash(request_body)
    obs = _cassette.lookup(match_key) if _cassette else None

    # ── HIT ──
    if obs is not None:
        output_body = _cassette.load_body(obs.get("output_body_ref")) or {}
        response_bytes = json.dumps(output_body).encode("utf-8")

        model = request_body.get("model", obs.get("model", ""))
        print(
            f"[halley-shim] REPLAY HIT  #{_call_index}: "
            f"{model} {obs.get('operation', '?')} "
            f"→ cassette obs[{obs['index']}] "
            f"(match_key={match_key[:16]}...)",
            flush=True,
        )

        served_entry = {
            "call_index": _call_index,
            "match_key": match_key,
            "observation_index": obs["index"],
            "source": "cassette",
            "operation": obs.get("operation", ""),
            "model": model,
            "input_tokens": obs.get("input_tokens", 0),
            "output_tokens": obs.get("output_tokens", 0),
            "started_at_ms": int(time.time() * 1000),
            "ended_at_ms": int(time.time() * 1000),
            "duration_ms": 0,
            "input_body": request_body,
            "output_body": output_body,
        }
        _served.append(served_entry)
        _call_index += 1

        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=response_bytes,
            request=request,
        )

    # ── MISS ──
    if _mode == "pure":
        msg = (
            f"[halley-shim] REPLAY MISS at call #{_call_index}: "
            f"match_key={match_key[:16]}... not found in cassette "
            f"(or cursor exhausted). Pure mode — failing."
        )
        print(msg, flush=True)
        _miss_errors.append(msg)
        _write_served()
        import sys
        sys.exit(78)

    # ── HYBRID MISS: live call ──
    _check_irreversible_tool(request_body)

    started_at_ms = int(time.time() * 1000)
    print(
        f"[halley-shim] HYBRID MISS #{_call_index}: "
        f"match_key={match_key[:16]}... → live call",
        flush=True,
    )

    live_response = _original_send(self, request, **kwargs)
    ended_at_ms = int(time.time() * 1000)

    live_body: dict = {}
    try:
        live_body = json.loads(live_response.text) if live_response.text else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    model = request_body.get("model", "")
    usage = live_body.get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)
    cost = compute_span_cost(input_tokens, output_tokens, model)

    print(
        f"[halley-shim] HYBRID LIVE  #{_call_index}: {model} "
        f"({input_tokens}+{output_tokens} tokens, ${cost:.6f})",
        flush=True,
    )

    live_entry = {
        "call_index": _call_index,
        "match_key": match_key,
        "observation_index": None,
        "source": "live",
        "operation": "chat",
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "started_at_ms": started_at_ms,
        "ended_at_ms": ended_at_ms,
        "duration_ms": ended_at_ms - started_at_ms,
        "cost_usd": cost,
        "input_body": request_body,
        "output_body": live_body,
    }
    _served.append(live_entry)
    _live_calls.append(live_entry)
    _call_index += 1

    return live_response


# ── Patch / unpatch ──────────────────────────────────────────────────────

def patch(cassette_path: str, mode: str = "pure") -> None:
    """Activate REPLAY mode (pure or hybrid) with the given cassette."""
    global _original_send, _cassette, _mode, _call_index, _patched
    global _served, _live_calls, _miss_errors, _written, _irreversible_tools

    if _patched:
        return

    _cassette = Cassette(cassette_path)
    _mode = mode
    _original_send = httpx.Client.send
    httpx.Client.send = _replay_send
    _call_index = 0
    _served = []
    _live_calls = []
    _miss_errors = []
    _written = False

    # Load irreversible tools from env (set by CLI from halley.config.json).
    irreversible_env = os.environ.get("HALLEY_IRREVERSIBLE_TOOLS", "")
    _irreversible_tools = {t.strip() for t in irreversible_env.split(",") if t.strip()}
    _allow_irreversible = os.environ.get("HALLEY_ALLOW_IRREVERSIBLE", "") == "1"
    if _allow_irreversible:
        _irreversible_tools = set()

    _patched = True

    atexit.register(_on_exit)
    print(
        f"[halley-shim] REPLAY mode={mode} active "
        f"(cassette={_cassette.slug}, {len(_cassette.observations)} observations"
        + (f", irreversible_guard={sorted(_irreversible_tools)}" if _irreversible_tools else "")
        + ")",
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
    return list(_served)


def get_live_calls() -> list[dict]:
    return list(_live_calls)


def get_miss_errors() -> list[str]:
    return list(_miss_errors)


def _write_served() -> None:
    """Write served entries and hybrid cassette (idempotent)."""
    global _written
    if _written:
        return
    _written = True

    hits = sum(1 for s in _served if s.get("source") == "cassette")
    live = len(_live_calls)
    total_obs = len(_cassette.observations) if _cassette else 0
    total_live_cost = sum(s.get("cost_usd", 0.0) for s in _live_calls)

    print(
        f"[halley-shim] replay done: {hits} hits, {live} live calls, "
        f"{len(_miss_errors)} pure-misses, {total_obs} cassette observations",
        flush=True,
    )
    if live > 0:
        print(
            f"[halley-shim] hybrid live-call cost: ${total_live_cost:.6f} "
            f"({live} call(s))",
            flush=True,
        )

    # Write served entries for invariant evaluation.
    output_path = os.environ.get("HALLEY_SERVED_JSON")
    if output_path:
        with open(output_path, "w") as f:
            json.dump(_served, f, indent=2)
        print(f"[halley-shim] served entries written to {output_path}", flush=True)

    # Hybrid: write a new cassette version alongside the old.
    if _live_calls and _cassette:
        _write_hybrid_cassette()

    # Write cost summary for CLI to parse.
    cost_path = os.environ.get("HALLEY_COST_JSON")
    if cost_path:
        summary = {
            "hits": hits,
            "live_calls": live,
            "total_cost_usd": total_live_cost,
        }
        with open(cost_path, "w") as f:
            json.dump(summary, f)


def _write_hybrid_cassette() -> None:
    """Write a new versioned cassette for the hybrid run's drifted calls."""
    from halley_sdk.fixture_writer import write_fixture

    if not _cassette:
        return

    # Build a new observation list: cassette hits as-is, live calls as new obs.
    observations = []
    for entry in _served:
        obs = {
            "span_id": f"{entry['call_index']:016X}",
            "parent_span_id": None,
            "operation": entry.get("operation", "chat"),
            "model": entry.get("model", ""),
            "system": "openai",
            "status": "ok",
            "started_at_ms": entry.get("started_at_ms", 0),
            "ended_at_ms": entry.get("ended_at_ms", 0),
            "duration_ms": entry.get("duration_ms", 0),
            "input_tokens": entry.get("input_tokens", 0),
            "output_tokens": entry.get("output_tokens", 0),
            "input_body": entry.get("input_body"),
            "output_body": entry.get("output_body"),
        }
        observations.append(obs)

    # Versioned slug: <original>-hybrid-<timestamp>
    ts = int(time.time())
    new_slug = f"{_cassette.slug}-hybrid-{ts}"
    fixtures_dir = str(_cassette._fixture_dir)

    write_fixture(slug=new_slug, observations=observations, fixtures_dir=fixtures_dir,
                  run_name=f"{_cassette.slug} (hybrid)")

    print(
        f"[halley-shim] hybrid cassette written: {new_slug}.json "
        f"({len(_live_calls)} drifted observation(s) updated)",
        flush=True,
    )

    # Record path for CLI to know the new cassette.
    cost_path = os.environ.get("HALLEY_COST_JSON")
    if cost_path:
        try:
            with open(cost_path) as f:
                data = json.load(f)
        except Exception:
            data = {}
        data["hybrid_cassette_slug"] = new_slug
        with open(cost_path, "w") as f:
            json.dump(data, f)


def _on_exit() -> None:
    """atexit handler — write served + hybrid cassette."""
    _write_served()
