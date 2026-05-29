"""
CI runner: evaluate a single fixture's replay results.

Called by the halley CLI after the agent subprocess exits.
Reads the replay results from the shim's output and evaluates invariants.

This module only uses stdlib + halley_sdk.invariants + halley_sdk.schema_inference.
It deliberately avoids importing halley_sdk.replayer (which needs httpx) so it
can run in any Python env (e.g. system python3 without httpx installed).
"""

import json
import sys
from pathlib import Path
from typing import Any

from halley_sdk.invariants import evaluate_invariants


def evaluate_fixture(
    fixture_path: str,
    served_json_path: str,
) -> list[dict[str, Any]]:
    """Evaluate invariants for a single fixture.

    Args:
        fixture_path: Path to the fixture's <slug>.json.
        served_json_path: Path to the JSON file with served replay entries.

    Returns:
        List of result dicts for JUnit output.
    """
    # Load fixture directly — no Cassette class needed (avoids httpx dependency).
    with open(fixture_path) as f:
        fixture = json.load(f)

    slug = Path(fixture_path).stem
    invariants: dict = fixture.get("invariants", {})
    observations: list[dict] = fixture.get("observations", [])

    with open(served_json_path) as f:
        served = json.load(f)

    results = evaluate_invariants(
        invariants=invariants,
        served=served,
        cassette_observations=observations,
    )

    return [
        {
            "fixture_slug": slug,
            "invariant_name": r.name,
            "passed": r.passed,
            "message": r.message,
            "time_s": 0.0,
        }
        for r in results
    ]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <fixture.json> <served.json>", file=sys.stderr)
        sys.exit(1)
    results = evaluate_fixture(sys.argv[1], sys.argv[2])
    json.dump(results, sys.stdout, indent=2)
    print()
