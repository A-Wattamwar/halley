"""
Schema inference from raw output bodies.

Mirrors the worker's invariant-infer.ts `collectKeyPaths` / `inferSchema`
logic exactly, so fixtures recorded via the shim have the same schema shape
as fixtures promoted through the dashboard worker.
"""

from typing import Any


# JSON type literals (same set as TypeScript worker).
_JSON_TYPES = frozenset(["string", "number", "boolean", "null", "array", "object"])

# gpt-4o-mini pricing (USD per token) — matches worker/src/query/pricing.ts.
_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o-mini":         (0.00000015, 0.00000060),
    "gpt-4o-mini-2024-07-18": (0.00000015, 0.00000060),
    "gpt-4o":              (0.0000025,  0.0000100),
    "gpt-4o-2024-08-06":   (0.0000025,  0.0000100),
    "gpt-3.5-turbo":       (0.0000005,  0.0000015),
}

METRIC_HEADROOM_FACTOR = 1.2


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "null"


def collect_key_paths(value: Any, prefix: str, out: dict[str, str]) -> None:
    """Walk a JSON value and record every key-path → leaf type.

    Mirrors the worker's collectKeyPaths exactly:
    - Arrays noted at their path with type "array"; first element descended with "[]".
    - Empty objects recorded as type "object".
    - Primitives and null recorded at their path.
    """
    if value is None:
        if prefix:
            out[prefix] = "null"
        return
    if isinstance(value, bool):
        if prefix:
            out[prefix] = "boolean"
        return
    if isinstance(value, (int, float)):
        if prefix:
            out[prefix] = "number"
        return
    if isinstance(value, str):
        if prefix:
            out[prefix] = "string"
        return
    if isinstance(value, list):
        if prefix:
            out[prefix] = "array"
        if value:
            child_prefix = f"{prefix}[]" if prefix else "[]"
            collect_key_paths(value[0], child_prefix, out)
        return
    if isinstance(value, dict):
        keys = list(value.keys())
        if not keys:
            if prefix:
                out[prefix] = "object"
            return
        for key in keys:
            child_prefix = f"{prefix}.{key}" if prefix else key
            collect_key_paths(value[key], child_prefix, out)


def infer_schema(op: str, body: Any) -> dict | None:
    """Infer a SpanSchemaEntry from a parsed output body.

    Returns None if body is None or not a dict/list at root.
    """
    if body is None:
        return None
    if not isinstance(body, (dict, list)):
        return None

    key_types: dict[str, str] = {}
    collect_key_paths(body, "", key_types)

    return {
        "op": op,
        "key_types": key_types,
        "required_keys": list(key_types.keys()),
    }


def compute_span_cost(
    input_tokens: int, output_tokens: int, model: str
) -> float:
    """Compute the cost of a single span. Returns 0 for unknown models."""
    in_rate, out_rate = _PRICING.get(model, (0.0, 0.0))
    return input_tokens * in_rate + output_tokens * out_rate


def infer_invariants(observations: list[dict]) -> dict:
    """Infer structural, schema, and metric invariants from a recorded run.

    Args:
        observations: List of observation dicts (from the recorder).

    Returns:
        An invariants dict matching the worker's InvariantsJson shape.
    """
    if not observations:
        return {}

    # ── Structural ───────────────────────────────────────────────────────────
    op_sequence = [obs.get("operation", "chat") for obs in observations]
    required_ops = sorted(set(op_sequence))

    span_ids = [obs.get("span_id", f"{i:016X}") for i, obs in enumerate(observations)]
    span_index = {sid: i for i, sid in enumerate(span_ids)}

    parent_index = []
    for obs in observations:
        p = obs.get("parent_span_id")
        if p is None or p == "0000000000000000":
            parent_index.append(None)
        else:
            parent_index.append(span_index.get(p))

    structural = {
        "span_count": len(observations),
        "operation_sequence": op_sequence,
        "required_operations": required_ops,
        "parent_index": parent_index,
    }

    # ── Schema ───────────────────────────────────────────────────────────────
    per_span = []
    for obs in observations:
        output_body = obs.get("output_body")
        entry = infer_schema(obs.get("operation", "chat"), output_body)
        per_span.append(entry)

    schema = {"per_span": per_span}

    # ── Metric ───────────────────────────────────────────────────────────────
    total_input = sum(obs.get("input_tokens", 0) for obs in observations)
    total_output = sum(obs.get("output_tokens", 0) for obs in observations)

    start_times = [obs.get("started_at_ms", 0) for obs in observations]
    end_times = [obs.get("ended_at_ms", 0) for obs in observations]
    wall_clock_ms = max(end_times) - min(start_times) if observations else 0

    total_cost = sum(
        compute_span_cost(
            obs.get("input_tokens", 0),
            obs.get("output_tokens", 0),
            obs.get("model", ""),
        )
        for obs in observations
    )

    metric = {
        "cost_max_usd": round(total_cost * METRIC_HEADROOM_FACTOR, 8),
        "latency_max_ms": round(wall_clock_ms * METRIC_HEADROOM_FACTOR),
        "span_count": len(observations),
        "input_tokens_max": int(total_input * METRIC_HEADROOM_FACTOR) + 1,
        "output_tokens_max": int(total_output * METRIC_HEADROOM_FACTOR) + 1,
    }

    return {
        "structural": structural,
        "schema": schema,
        "metric": metric,
        "semantic": {"enabled": False, "judge_model": None, "rubric": None},
    }
