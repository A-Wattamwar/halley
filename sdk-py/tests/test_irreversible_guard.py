"""
Tests for the irreversible tool guard in hybrid mode.

The guard fires when:
1. The shim is in hybrid mode
2. A cassette miss occurs (no match_key found)
3. The request body includes a tool definition marked irreversible

Because in-process Python function tools are not intercepted (they are not
HTTP calls), the guard only applies to tools whose invocation goes through the
httpx layer (i.e., tools embedded in an OpenAI chat.completions request with
function calling, which IS intercepted).
"""

import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import tempfile

import pytest

from halley_sdk.canonical import canonical_hash


def _make_minimal_fixture(tmp_path: Path) -> str:
    """Create an empty fixture (no observations) so any call is a miss."""
    slug = "test-irreversible"
    fixture_dir = tmp_path / "halley" / "fixtures"
    fixture_dir.mkdir(parents=True)
    fixture = {
        "fixture_format_version": 1,
        "fixture_id": "test-id",
        "source_run_id": "deadbeef" * 4,
        "run_name": "test",
        "started_at_ms": 0,
        "dialect": "halley-raw",
        "top_model": "gpt-4o-mini",
        "written_at": "2026-01-01T00:00:00Z",
        "observations": [],
        "invariants": {},
        "replay_matching": {"strategy": "input_body_hash_v1"},
    }
    path = fixture_dir / f"{slug}.json"
    path.write_text(json.dumps(fixture))
    return str(path)


class TestIrreversibleGuard:
    def test_irreversible_tool_blocks_live_call(self, tmp_path, monkeypatch):
        """Guard fires for irreversible tool on cassette miss in hybrid mode."""
        import importlib
        import halley_sdk.replayer as replayer_module

        # Reset module state before patching.
        replayer_module._patched = False
        replayer_module._written = False
        replayer_module._served = []
        replayer_module._live_calls = []
        replayer_module._miss_errors = []
        replayer_module._cassette = None
        replayer_module._call_index = 0

        fixture_path = _make_minimal_fixture(tmp_path)

        # Mark "send_email" as irreversible.
        monkeypatch.setenv("HALLEY_IRREVERSIBLE_TOOLS", "send_email")
        monkeypatch.setenv("HALLEY_HYBRID", "1")
        monkeypatch.delenv("HALLEY_ALLOW_IRREVERSIBLE", raising=False)

        # Build a request body that includes the irreversible tool.
        request_body = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Send an email to alice@example.com"}],
            "tools": [{"function": {"name": "send_email"}, "type": "function"}],
        }
        request_bytes = json.dumps(request_body).encode()

        import httpx

        # Create a fake httpx request.
        fake_request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions",
                                     content=request_bytes,
                                     headers={"content-type": "application/json"})

        # Patch atexit.register to prevent actual atexit registration.
        with patch("atexit.register"):
            replayer_module.patch(fixture_path, mode="hybrid")

        # The guard should call sys.exit(79) on a miss with an irreversible tool.
        with pytest.raises(SystemExit) as exc_info:
            replayer_module._replay_send(None, fake_request)

        assert exc_info.value.code == 79

        # Clean up.
        replayer_module.unpatch()

    def test_allow_irreversible_permits_live_call(self, tmp_path, monkeypatch):
        """--allow-irreversible disables the guard."""
        import halley_sdk.replayer as replayer_module

        replayer_module._patched = False
        replayer_module._written = False
        replayer_module._served = []
        replayer_module._live_calls = []
        replayer_module._miss_errors = []
        replayer_module._cassette = None
        replayer_module._call_index = 0

        fixture_path = _make_minimal_fixture(tmp_path)

        monkeypatch.setenv("HALLEY_IRREVERSIBLE_TOOLS", "send_email")
        monkeypatch.setenv("HALLEY_HYBRID", "1")
        monkeypatch.setenv("HALLEY_ALLOW_IRREVERSIBLE", "1")

        request_body = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Send email"}],
            "tools": [{"function": {"name": "send_email"}, "type": "function"}],
        }
        import httpx
        fake_request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions",
                                     content=json.dumps(request_body).encode(),
                                     headers={"content-type": "application/json"})

        with patch("atexit.register"):
            replayer_module.patch(fixture_path, mode="hybrid")

        # With allow-irreversible, the guard is disabled. The live call will be
        # attempted (but original_send is a mock, so it returns a dummy response).
        mock_response = httpx.Response(200, content=b'{"choices":[]}', request=fake_request)

        with patch.object(replayer_module, "_original_send", return_value=mock_response):
            response = replayer_module._replay_send(None, fake_request)

        assert response.status_code == 200

        replayer_module.unpatch()

    def test_reversible_tool_does_not_block(self, tmp_path, monkeypatch):
        """A reversible tool (not in irreversible list) does not trigger the guard."""
        import halley_sdk.replayer as replayer_module

        replayer_module._patched = False
        replayer_module._written = False
        replayer_module._served = []
        replayer_module._live_calls = []
        replayer_module._miss_errors = []
        replayer_module._cassette = None
        replayer_module._call_index = 0

        fixture_path = _make_minimal_fixture(tmp_path)

        # Only "send_email" is irreversible; "calculator" is not.
        monkeypatch.setenv("HALLEY_IRREVERSIBLE_TOOLS", "send_email")
        monkeypatch.setenv("HALLEY_HYBRID", "1")
        monkeypatch.delenv("HALLEY_ALLOW_IRREVERSIBLE", raising=False)

        request_body = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Calculate 2+2"}],
            "tools": [{"function": {"name": "calculator"}, "type": "function"}],
        }
        import httpx
        fake_request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions",
                                     content=json.dumps(request_body).encode(),
                                     headers={"content-type": "application/json"})

        with patch("atexit.register"):
            replayer_module.patch(fixture_path, mode="hybrid")

        mock_response = httpx.Response(200, content=b'{"choices":[]}', request=fake_request)
        with patch.object(replayer_module, "_original_send", return_value=mock_response):
            # Should NOT raise SystemExit — guard does not fire for reversible tools.
            response = replayer_module._replay_send(None, fake_request)

        assert response.status_code == 200

        replayer_module.unpatch()
