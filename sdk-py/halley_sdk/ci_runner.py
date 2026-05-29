"""
CI runner: evaluate a single fixture's replay results.

Called by the halley CLI after the agent subprocess exits.
Reads the replay results from the shim's output and evaluates invariants.
"""

import json
import sys
from pathlib import Path
from typing import Any

from halley_sdk.invariants import evaluate_invariants
from halley_sdk.replayer import Cassette


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
    cassette = Cassette(fixture_path)
    slug = cassette.slug

    with open(served_json_path) as f:
        served = json.load(f)

    results = evaluate_invariants(
        invariants=cassette.invariants,
        served=served,
        cassette_observations=cassette.observations,
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
