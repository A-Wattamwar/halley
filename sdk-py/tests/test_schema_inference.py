"""Tests for schema inference — mirrors worker invariant-infer.ts logic."""

import pytest
from halley_sdk.schema_inference import collect_key_paths, infer_schema, infer_invariants


class TestCollectKeyPaths:
    def test_flat_object(self):
        out: dict[str, str] = {}
        collect_key_paths({"id": "abc", "n": 1}, "", out)
        assert out == {"id": "string", "n": "number"}

    def test_nested_object(self):
        out: dict[str, str] = {}
        collect_key_paths({"a": {"b": True}}, "", out)
        assert out == {"a.b": "boolean"}

    def test_array_first_element(self):
        out: dict[str, str] = {}
        collect_key_paths({"choices": [{"text": "hi"}]}, "", out)
        assert "choices" in out
        assert out["choices"] == "array"
        assert out["choices[].text"] == "string"

    def test_null_leaf(self):
        out: dict[str, str] = {}
        collect_key_paths({"x": None}, "", out)
        assert out == {"x": "null"}

    def test_empty_array(self):
        out: dict[str, str] = {}
        collect_key_paths({"items": []}, "", out)
        assert out["items"] == "array"
        assert not any(k.startswith("items[]") for k in out)

    def test_empty_object_leaf(self):
        out: dict[str, str] = {}
        collect_key_paths({"meta": {}}, "", out)
        assert out["meta"] == "object"


class TestInferSchema:
    def test_none_body(self):
        assert infer_schema("chat", None) is None

    def test_openai_response(self):
        body = {
            "id": "chatcmpl-123",
            "choices": [{"message": {"role": "assistant", "content": "math"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 1},
            "model": "gpt-4o-mini",
        }
        result = infer_schema("chat", body)
        assert result is not None
        assert result["op"] == "chat"
        assert "id" in result["key_types"]
        assert result["key_types"]["id"] == "string"
        assert "choices" in result["key_types"]
        assert result["key_types"]["choices"] == "array"
        assert "usage.prompt_tokens" in result["key_types"]
        assert result["key_types"]["usage.prompt_tokens"] == "number"
        assert set(result["required_keys"]) == set(result["key_types"].keys())


class TestInferInvariants:
    def _make_obs(self, idx: int, op: str = "chat", model: str = "gpt-4o-mini",
                  input_tokens: int = 10, output_tokens: int = 5,
                  output_body: dict | None = None) -> dict:
        return {
            "span_id": f"{idx:016X}",
            "parent_span_id": None,
            "operation": op,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "started_at_ms": idx * 1000,
            "ended_at_ms": idx * 1000 + 500,
            "duration_ms": 500,
            "output_body": output_body or {
                "id": f"cmp-{idx}",
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": input_tokens, "completion_tokens": output_tokens},
            },
        }

    def test_structural(self):
        obs = [self._make_obs(0), self._make_obs(1, op="chat")]
        result = infer_invariants(obs)
        s = result["structural"]
        assert s["span_count"] == 2
        assert s["operation_sequence"] == ["chat", "chat"]
        assert s["required_operations"] == ["chat"]
        assert s["parent_index"] == [None, None]

    def test_schema_per_span(self):
        obs = [self._make_obs(0)]
        result = infer_invariants(obs)
        per_span = result["schema"]["per_span"]
        assert len(per_span) == 1
        assert per_span[0] is not None
        assert "id" in per_span[0]["key_types"]
        assert "choices" in per_span[0]["key_types"]

    def test_metric_headroom(self):
        obs = [self._make_obs(0, input_tokens=100, output_tokens=20)]
        result = infer_invariants(obs)
        m = result["metric"]
        assert m["input_tokens_max"] >= 120   # 100 * 1.2
        assert m["output_tokens_max"] >= 24   # 20 * 1.2
        assert m["span_count"] == 1
        # gpt-4o-mini cost check
        assert m["cost_max_usd"] > 0

    def test_semantic_disabled(self):
        obs = [self._make_obs(0)]
        result = infer_invariants(obs)
        assert result["semantic"]["enabled"] is False
