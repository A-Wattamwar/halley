"""
Invariant evaluator for v1 fixtures.

Evaluates structural, metric, and schema invariants against a replayed run.
Semantic invariants are skipped (disabled in v1).
"""

from typing import Any

from halley_sdk.schema_inference import collect_key_paths


class InvariantResult:
    """Result of evaluating a single invariant."""

    def __init__(self, name: str, passed: bool, message: str = ""):
        self.name = name
        self.passed = passed
        self.message = message

    def __repr__(self):
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.name}: {self.message}"


def evaluate_invariants(
    invariants: dict[str, Any],
    served: list[dict],
    cassette_observations: list[dict],
) -> list[InvariantResult]:
    """Evaluate all invariants against the replayed run.

    Args:
        invariants: The fixture's invariants_json.
        served: The list of served replay entries from the shim.
        cassette_observations: The original cassette observations.

    Returns:
        List of InvariantResult.
    """
    results: list[InvariantResult] = []

    structural = invariants.get("structural", {})
    if structural:
        results.extend(_eval_structural(structural, served))

    metric = invariants.get("metric", {})
    if metric:
        results.extend(_eval_metric(metric, served, cassette_observations))

    schema = invariants.get("schema", {})
    if schema:
        results.extend(_eval_schema(schema, served))

    semantic = invariants.get("semantic", {})
    if semantic and semantic.get("enabled"):
        results.append(InvariantResult("semantic", True, "skipped (disabled in v1)"))

    # If no invariants at all, report a pass with a note.
    if not results:
        results.append(InvariantResult(
            "no_invariants", True, "no invariants defined — pass by default"
        ))

    return results


def _eval_structural(structural: dict, served: list[dict]) -> list[InvariantResult]:
    results = []

    # span_count
    expected_count = structural.get("span_count")
    if expected_count is not None:
        actual = len(served)
        ok = actual == expected_count
        results.append(InvariantResult(
            "structural.span_count",
            ok,
            f"expected {expected_count}, got {actual}",
        ))

    # operation_sequence
    expected_ops = structural.get("operation_sequence")
    if expected_ops is not None:
        actual_ops = [s.get("operation", "") for s in served]
        mode = structural.get("operation_sequence_mode", "exact")
        if mode == "exact":
            ok = actual_ops == expected_ops
            results.append(InvariantResult(
                "structural.operation_sequence",
                ok,
                f"mode=exact, expected={expected_ops}, got={actual_ops}",
            ))
        elif mode == "subsequence":
            ok = _is_subsequence(expected_ops, actual_ops)
            results.append(InvariantResult(
                "structural.operation_sequence",
                ok,
                f"mode=subsequence, expected={expected_ops} ⊆ {actual_ops}",
            ))

    # required_operations
    required = structural.get("required_operations")
    if required is not None:
        actual_ops = {s.get("operation", "") for s in served}
        missing = [op for op in required if op not in actual_ops]
        ok = len(missing) == 0
        results.append(InvariantResult(
            "structural.required_operations",
            ok,
            f"missing={missing}" if missing else "all present",
        ))

    # parent_index (shape check — same length as span_count)
    parent_index = structural.get("parent_index")
    if parent_index is not None:
        ok = len(parent_index) == len(served)
        results.append(InvariantResult(
            "structural.parent_index",
            ok,
            f"expected len={len(parent_index)}, got {len(served)} served",
        ))

    return results


def _eval_metric(
    metric: dict, served: list[dict], cassette_obs: list[dict]
) -> list[InvariantResult]:
    results = []

    # In pure replay, actual tokens come from the cassette (served output bodies
    # contain the same usage as recorded). Sum from served entries.
    total_input = sum(s.get("input_tokens", 0) for s in served)
    total_output = sum(s.get("output_tokens", 0) for s in served)

    # Latency: in replay, durations are near-zero. Evaluate against recorded.
    total_latency_ms = sum(o.get("duration_ms", 0) for o in cassette_obs)

    checks = {
        "input_tokens_max": total_input,
        "output_tokens_max": total_output,
        "latency_max_ms": total_latency_ms,
        "span_count": len(served),
    }

    for key, actual in checks.items():
        bound = metric.get(key)
        if bound is not None:
            ok = actual <= bound
            results.append(InvariantResult(
                f"metric.{key}",
                ok,
                f"bound={bound}, actual={actual}",
            ))

    # cost_max_usd — in pure mode, actual cost is $0.
    cost_bound = metric.get("cost_max_usd")
    if cost_bound is not None:
        results.append(InvariantResult(
            "metric.cost_max_usd",
            True,
            f"bound={cost_bound}, actual=$0.00 (pure replay)",
        ))

    return results


def _eval_schema(schema: dict, served: list[dict]) -> list[InvariantResult]:
    results = []
    per_span = schema.get("per_span", [])

    for i, spec in enumerate(per_span):
        if spec is None:
            continue
        if i >= len(served):
            results.append(InvariantResult(
                f"schema.span[{i}]",
                False,
                f"span {i} not served in replay",
            ))
            continue

        output_body = served[i].get("output_body", {})
        if output_body is None:
            output_body = {}

        # Flatten the actual output body using the same collect_key_paths
        # algorithm used during recording — ensures path format matches.
        actual_key_paths: dict[str, str] = {}
        collect_key_paths(output_body, "", actual_key_paths)

        # Check required_keys.
        required_keys = spec.get("required_keys", [])
        if required_keys:
            missing = [k for k in required_keys if k not in actual_key_paths]
            ok = len(missing) == 0
            results.append(InvariantResult(
                f"schema.span[{i}].required_keys",
                ok,
                f"missing={missing}" if missing else "all present",
            ))

        # Check key_types.
        key_types = spec.get("key_types", {})
        if key_types:
            mismatches = []
            for key_path, expected_type in key_types.items():
                actual_type = actual_key_paths.get(key_path)
                if actual_type is not None and actual_type != expected_type:
                    mismatches.append(f"{key_path}: expected {expected_type}, got {actual_type}")
            ok = len(mismatches) == 0
            results.append(InvariantResult(
                f"schema.span[{i}].key_types",
                ok,
                "; ".join(mismatches) if mismatches else "all types match",
            ))

    return results


def _is_subsequence(sub: list, full: list) -> bool:
    it = iter(full)
    return all(item in it for item in sub)
