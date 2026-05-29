"""Tests for the replay shim: ordinal cursor, hit/miss, synthetic response."""

import json
import os
import tempfile
from pathlib import Path

import pytest

from halley_sdk.canonical import canonical_hash
from halley_sdk.replayer import Cassette, ReplayMiss


def _make_fixture(tmp_path: Path, observations: list[dict]) -> str:
    """Create a minimal v1 fixture on disk with body files."""
    slug = "test-fixture"
    fixture_dir = tmp_path / "halley" / "fixtures"
    bodies_dir = fixture_dir / slug / "bodies"
    bodies_dir.mkdir(parents=True)

    bodies = {}
    for obs in observations:
        for key in ("input_body", "output_body"):
            body = obs.get(key)
            if body is not None:
                h = canonical_hash(body)
                ref = f"halley/fixtures/{slug}/bodies/sha256-{h}.json"
                obs[f"{key}_ref"] = ref
                if h not in bodies:
                    body_path = bodies_dir / f"sha256-{h}.json"
                    body_path.write_text(json.dumps(body))
                    bodies[h] = True
                obs["match_key"] = canonical_hash(obs["input_body"]) if key == "input_body" else obs.get("match_key", "")

    fixture = {
        "fixture_format_version": 1,
        "fixture_id": "test-id",
        "source_run_id": "deadbeef" * 4,
        "run_name": "test",
        "started_at_ms": 0,
        "dialect": "halley-raw",
        "top_model": "gpt-4o-mini",
        "written_at": "2026-01-01T00:00:00Z",
        "observations": [
            {
                "index": i,
                "span_id": f"{i:016X}",
                "parent_span_id": None,
                "operation": obs.get("operation", "chat"),
                "model": obs.get("model", "gpt-4o-mini"),
                "system": "openai",
                "status": "ok",
                "started_at_ms": i * 1000,
                "ended_at_ms": i * 1000 + 500,
                "duration_ms": 500,
                "input_tokens": 10,
                "output_tokens": 5,
                "match_key": obs.get("match_key", ""),
                "input_body_ref": obs.get("input_body_ref"),
                "output_body_ref": obs.get("output_body_ref"),
            }
            for i, obs in enumerate(observations)
        ],
        "invariants": {},
        "replay_matching": {"strategy": "input_body_hash_v1"},
    }

    fixture_path = fixture_dir / f"{slug}.json"
    fixture_path.write_text(json.dumps(fixture, indent=2))
    return str(fixture_path)


class TestCassette:
    def test_ordinal_cursor_distinct_keys(self, tmp_path):
        """Each distinct key returns its own observation."""
        obs = [
            {"input_body": {"prompt": "A"}, "output_body": {"text": "rA"}},
            {"input_body": {"prompt": "B"}, "output_body": {"text": "rB"}},
        ]
        path = _make_fixture(tmp_path, obs)
        c = Cassette(path)

        key_a = canonical_hash({"prompt": "A"})
        key_b = canonical_hash({"prompt": "B"})

        hit_a = c.lookup(key_a)
        assert hit_a is not None
        assert hit_a["index"] == 0

        hit_b = c.lookup(key_b)
        assert hit_b is not None
        assert hit_b["index"] == 1

    def test_ordinal_cursor_shared_key(self, tmp_path):
        """Two observations with the same input body are served in index order."""
        body = {"prompt": "same"}
        obs = [
            {"input_body": body, "output_body": {"text": "first"}},
            {"input_body": body, "output_body": {"text": "second"}},
        ]
        path = _make_fixture(tmp_path, obs)
        c = Cassette(path)

        key = canonical_hash(body)

        first = c.lookup(key)
        assert first is not None
        assert first["index"] == 0

        second = c.lookup(key)
        assert second is not None
        assert second["index"] == 1

        exhausted = c.lookup(key)
        assert exhausted is None

    def test_miss_returns_none(self, tmp_path):
        """Unknown key returns None."""
        obs = [{"input_body": {"prompt": "A"}, "output_body": {"text": "rA"}}]
        path = _make_fixture(tmp_path, obs)
        c = Cassette(path)

        assert c.lookup("0" * 64) is None

    def test_load_body(self, tmp_path):
        """Body files are loaded correctly."""
        body = {"hello": "world"}
        obs = [{"input_body": body, "output_body": {"resp": True}}]
        path = _make_fixture(tmp_path, obs)
        c = Cassette(path)

        hit = c.lookup(canonical_hash(body))
        assert hit is not None
        loaded = c.load_body(hit["output_body_ref"])
        assert loaded == {"resp": True}
