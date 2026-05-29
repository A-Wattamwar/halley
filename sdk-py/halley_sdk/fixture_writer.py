"""
Write a v1 fixture (PROVISIONAL) from shim-captured observations.

Produces:
  <fixtures_dir>/<slug>.json            — fixture index
  <fixtures_dir>/<slug>/bodies/sha256-<hash>.json  — content-addressed bodies
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from halley_sdk.canonical import canonical_hash
from halley_sdk.schema_inference import infer_invariants


def write_fixture(
    slug: str,
    observations: list[dict[str, Any]],
    fixtures_dir: str,
    run_name: str | None = None,
) -> str:
    """Write a v1 fixture from captured observations. Returns the fixture path."""
    fixture_id = str(uuid.uuid4())
    # Derive run metadata from first observation.
    first_obs = observations[0] if observations else {}
    run_name = run_name or slug

    # Collect all body hashes and bodies for dedup.
    bodies: dict[str, Any] = {}  # hash -> parsed JSON
    obs_list = []

    for i, obs in enumerate(observations):
        input_body = obs.get("input_body")
        output_body = obs.get("output_body")

        input_hash = canonical_hash(input_body) if input_body is not None else ""
        output_hash = canonical_hash(output_body) if output_body is not None else ""

        if input_hash and input_hash not in bodies:
            bodies[input_hash] = input_body
        if output_hash and output_hash not in bodies:
            bodies[output_hash] = output_body

        input_ref = f"halley/fixtures/{slug}/bodies/sha256-{input_hash}.json" if input_hash else None
        output_ref = f"halley/fixtures/{slug}/bodies/sha256-{output_hash}.json" if output_hash else None

        obs_entry = {
            "index": i,
            "span_id": obs.get("span_id", f"{i:016X}"),
            "parent_span_id": obs.get("parent_span_id"),
            "operation": obs.get("operation", "chat"),
            "model": obs.get("model", ""),
            "system": obs.get("system", "openai"),
            "status": obs.get("status", "ok"),
            "started_at_ms": obs.get("started_at_ms", 0),
            "ended_at_ms": obs.get("ended_at_ms", 0),
            "duration_ms": obs.get("duration_ms", 0),
            "input_tokens": obs.get("input_tokens", 0),
            "output_tokens": obs.get("output_tokens", 0),
            "match_key": input_hash,
            "input_body_ref": input_ref,
            "output_body_ref": output_ref,
        }
        obs_list.append(obs_entry)

    fixture = {
        "fixture_format_version": 1,
        "fixture_id": fixture_id,
        "source_run_id": first_obs.get("run_id", uuid.uuid4().hex),
        "run_name": run_name,
        "started_at_ms": obs_list[0]["started_at_ms"] if obs_list else 0,
        "dialect": "halley-raw",
        "top_model": next(
            (o["model"] for o in obs_list if o["model"]),
            "",
        ),
        "written_at": datetime.now(timezone.utc).isoformat(),
        "observations": obs_list,
        "invariants": infer_invariants(observations),
        "replay_matching": {
            "strategy": "input_body_hash_v1",
            "description": (
                "The replay shim computes SHA-256 of the D22 canonical JSON of "
                "the incoming request body against each observation's match_key. "
                "Matching is ordinal: repeated identical match_keys are consumed "
                "in index order via a per-key cursor. On hit the shim "
                "serves its recorded output_body_ref."
            ),
        },
    }

    # Write body files.
    bodies_dir = os.path.join(fixtures_dir, slug, "bodies")
    os.makedirs(bodies_dir, exist_ok=True)

    written = 0
    skipped = 0
    for h, body in bodies.items():
        path = os.path.join(bodies_dir, f"sha256-{h}.json")
        if os.path.exists(path):
            skipped += 1
            continue
        with open(path, "w") as f:
            json.dump(body, f, indent=2, ensure_ascii=False)
            f.write("\n")
        written += 1

    # Write fixture index.
    fixture_path = os.path.join(fixtures_dir, f"{slug}.json")
    with open(fixture_path, "w") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[halley-shim] wrote {fixture_path} ({len(obs_list)} observations, {written} bodies written, {skipped} deduped)")
    return fixture_path
