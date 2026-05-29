"""
Halley RECORD mode shim for the OpenAI Python SDK.

Patches `httpx.Client.send` to intercept every HTTP request/response,
capturing the FULL RAW JSON payloads (not the gen_ai-semantic subset).
This is the bit-fidelity capture path described in D53.

Usage (one-line import at the top of the agent):

    import halley_sdk; halley_sdk.patch()

Or set HALLEY_RECORD=1 and import halley_sdk (auto-patches on import
when the env var is set — see __init__.py).

At process exit (via atexit), the captured observations are written as
a v1 fixture to HALLEY_FIXTURES_DIR.
"""

import atexit
import json
import os
import time
import uuid

import httpx

from halley_sdk.canonical import canonical_hash
from halley_sdk.fixture_writer import write_fixture

# ── State ─────────────────────────────────────────────────────────────────

_original_send: object = None
_observations: list[dict] = []
_run_id: str = ""
_call_index: int = 0
_patched: bool = False


def _make_run_id() -> str:
    return uuid.uuid4().hex


# ── httpx.Client.send monkey-patch ────────────────────────────────────────

def _patched_send(self: httpx.Client, request: httpx.Request, **kwargs) -> httpx.Response:
    """Intercept httpx requests to OpenAI, capture raw req+resp bodies."""
    global _call_index

    url = str(request.url)
    is_openai = (
        "api.openai.com" in url
        or "openai" in url.lower()
    ) and request.method == "POST"

    if not is_openai:
        return _original_send(self, request, **kwargs)

    # Capture the raw request body BEFORE the call.
    request_body = None
    try:
        raw_bytes = request.content
        if raw_bytes:
            request_body = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    started_at_ms = int(time.time() * 1000)

    # Forward the call untouched to the real provider.
    response = _original_send(self, request, **kwargs)

    ended_at_ms = int(time.time() * 1000)

    # Capture the raw response body.
    response_body = None
    try:
        resp_text = response.text
        if resp_text:
            response_body = json.loads(resp_text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    if request_body is not None:
        _record_observation(
            request_body=request_body,
            response_body=response_body,
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
        )

    return response


def _record_observation(
    request_body: dict,
    response_body: dict | None,
    started_at_ms: int,
    ended_at_ms: int,
) -> None:
    """Store a captured observation for later fixture writing."""
    global _call_index

    model = request_body.get("model", "")

    # Extract token usage from raw response.
    usage = (response_body or {}).get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)

    # Determine operation from endpoint / request shape.
    operation = "chat"  # Default; all chat completions calls.

    span_id = f"{_call_index:016X}"

    obs = {
        "run_id": _run_id,
        "span_id": span_id,
        "parent_span_id": None,
        "operation": operation,
        "model": model,
        "system": "openai",
        "status": "ok" if response_body and "error" not in response_body else "error",
        "started_at_ms": started_at_ms,
        "ended_at_ms": ended_at_ms,
        "duration_ms": ended_at_ms - started_at_ms,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "input_body": request_body,
        "output_body": response_body,
    }

    _observations.append(obs)
    match_key = canonical_hash(request_body)
    print(
        f"[halley-shim] captured call #{_call_index}: "
        f"{model} {operation} "
        f"({input_tokens}+{output_tokens} tokens, "
        f"{ended_at_ms - started_at_ms}ms, "
        f"match_key={match_key[:16]}...)"
    )
    _call_index += 1


# ── Patch / unpatch ──────────────────────────────────────────────────────

def patch() -> None:
    """Activate RECORD mode: monkey-patch httpx.Client.send."""
    global _original_send, _run_id, _call_index, _patched, _observations

    if _patched:
        return

    _original_send = httpx.Client.send
    httpx.Client.send = _patched_send
    _run_id = _make_run_id()
    _call_index = 0
    _observations = []
    _patched = True

    atexit.register(_on_exit)
    print(f"[halley-shim] RECORD mode active (run_id={_run_id[:16]}...)")


def unpatch() -> None:
    """Deactivate RECORD mode: restore original httpx.Client.send."""
    global _patched
    if not _patched:
        return
    httpx.Client.send = _original_send
    _patched = False


def _on_exit() -> None:
    """Write the fixture at process exit."""
    if not _observations:
        print("[halley-shim] no observations captured — skipping fixture write.")
        return

    fixtures_dir = os.environ.get("HALLEY_FIXTURES_DIR", "halley/fixtures")
    slug = os.environ.get("HALLEY_FIXTURE_SLUG", f"record-{_run_id[:8]}")

    write_fixture(
        slug=slug,
        observations=_observations,
        fixtures_dir=fixtures_dir,
        run_name=slug,
    )
