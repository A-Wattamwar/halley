"""
Unit tests for metric.cost_max_usd invariant — Day 4 Part 0 fix.

Previously cost_max_usd always passed in hybrid mode (evaluated $0).
Now it evaluates actual live-call cost from served entries.
"""

import pytest
from halley_sdk.invariants import evaluate_invariants


def _served_live(call_index: int, input_tokens: int, output_tokens: int, cost: float) -> dict:
    """Build a served entry representing a live (hybrid) call."""
    return {
        "call_index": call_index,
        "source": "live",
        "operation": "chat",
        "model": "gpt-4o-mini",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost,
        "started_at_ms": 0,
        "ended_at_ms": 100,
        "duration_ms": 100,
        "input_body": {},
        "output_body": {"choices": [{"message": {"content": "ok"}}]},
    }


def _served_cassette(call_index: int, input_tokens: int, output_tokens: int) -> dict:
    """Build a served entry representing a cassette HIT."""
    return {
        "call_index": call_index,
        "source": "cassette",
        "operation": "chat",
        "model": "gpt-4o-mini",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "started_at_ms": 0,
        "ended_at_ms": 0,
        "duration_ms": 0,
        "input_body": {},
        "output_body": {"choices": [{"message": {"content": "ok"}}]},
    }


class TestCostInvariantHybridMode:
    def _make_invariants(self, cost_max_usd: float) -> dict:
        return {
            "metric": {
                "cost_max_usd": cost_max_usd,
                "span_count": 1,
                "input_tokens_max": 1000,
                "output_tokens_max": 1000,
                "latency_max_ms": 60000,
            }
        }

    def test_hybrid_cost_below_bound_passes(self):
        """Live cost within bound → PASS."""
        served = [_served_live(0, 100, 50, 0.00003)]  # $0.00003
        results = evaluate_invariants(
            invariants=self._make_invariants(cost_max_usd=0.0001),
            served=served,
            cassette_observations=[],
        )
        cost_result = next(r for r in results if r.name == "metric.cost_max_usd")
        assert cost_result.passed, f"Expected PASS but got: {cost_result}"
        assert "hybrid" in cost_result.message

    def test_hybrid_cost_exceeds_bound_fails(self):
        """Live cost exceeding bound → FAIL (the Day 3 bug)."""
        # Recorded bound was $0.000054 (5 calls × ~$0.0000108)
        # New run is much more expensive (e.g. a long response)
        live_cost = 0.0005  # $0.0005 >> $0.000054
        served = [_served_live(0, 1000, 500, live_cost)]
        results = evaluate_invariants(
            invariants=self._make_invariants(cost_max_usd=0.0001),
            served=served,
            cassette_observations=[],
        )
        cost_result = next(r for r in results if r.name == "metric.cost_max_usd")
        assert not cost_result.passed, f"Expected FAIL but got: {cost_result}"
        assert "hybrid" in cost_result.message
        assert "0.000500" in cost_result.message

    def test_pure_mode_always_passes_cost(self):
        """Pure replay (all cassette hits): cost = $0 → always PASS."""
        served = [_served_cassette(0, 100, 50)]
        results = evaluate_invariants(
            invariants=self._make_invariants(cost_max_usd=0.000001),  # extremely tight
            served=served,
            cassette_observations=[],
        )
        cost_result = next(r for r in results if r.name == "metric.cost_max_usd")
        assert cost_result.passed, f"Pure replay should always pass cost: {cost_result}"
        assert "pure replay" in cost_result.message

    def test_mixed_run_uses_only_live_cost(self):
        """Mix of hits and live calls: only live cost counts."""
        # 2 cassette hits ($0 each) + 1 live call (expensive)
        served = [
            _served_cassette(0, 50, 5),
            _served_cassette(1, 50, 5),
            _served_live(2, 2000, 1000, 0.001),  # $0.001 live call
        ]
        results = evaluate_invariants(
            invariants=self._make_invariants(cost_max_usd=0.0001),  # bound $0.0001
            served=served,
            cassette_observations=[],
        )
        cost_result = next(r for r in results if r.name == "metric.cost_max_usd")
        assert not cost_result.passed, f"Should fail: live cost $0.001 > bound $0.0001"

    def test_regression_example_reasoning_agent_math(self):
        """The reasoning-agent-math baseline: bound=6.426e-05.
        A hybrid run where the output expanded from 20→196 tokens would
        cost ~$0.000118 — exceeds the bound.
        """
        # obs[4] had a 180-token output in the regression run
        served = [
            _served_cassette(0, 123, 1),
            _served_cassette(1, 64, 10),
            _served_cassette(2, 30, 3),
            _served_cassette(3, 30, 3),
            _served_live(4, 36, 180, 0.000113),  # the drifted long response
        ]
        bound = 6.426e-05
        results = evaluate_invariants(
            invariants=self._make_invariants(cost_max_usd=bound),
            served=served,
            cassette_observations=[],
        )
        cost_result = next(r for r in results if r.name == "metric.cost_max_usd")
        assert not cost_result.passed, (
            f"Live cost $0.000113 > bound ${bound}: should fail. Got: {cost_result}"
        )
