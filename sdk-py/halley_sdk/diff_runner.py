"""
halley diff — human-readable delta between recorded baseline and current run.

Compares a baseline fixture with a hybrid cassette (the current run), showing:
  - Prompt-text diffs (per observation where input bodies changed)
  - Model-id diffs
  - Token/cost changes
  - Output content diffs

Called by `halley diff <fixture>` via the Rust CLI.
"""

import difflib
import json
import sys
from pathlib import Path
from typing import Any

from halley_sdk.replayer import Cassette


def _truncate(s: str, n: int = 80) -> str:
    if len(s) <= n:
        return s
    return s[:n] + "…"


def _messages_text(body: dict | None) -> str:
    """Extract a readable prompt string from an OpenAI request body."""
    if not body or not isinstance(body, dict):
        return ""
    messages = body.get("messages", [])
    parts = []
    for m in messages:
        role = m.get("role", "?")
        content = m.get("content", "")
        if isinstance(content, list):
            content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
        parts.append(f"[{role}] {content}")
    return "\n".join(parts)


def _output_text(body: dict | None) -> str:
    """Extract response content from an OpenAI response body."""
    if not body or not isinstance(body, dict):
        return ""
    choices = body.get("choices", [])
    if not choices:
        return ""
    msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    return msg.get("content", "") or ""


def diff_fixtures(baseline_path: str, current_path: str) -> None:
    """Print a human-readable diff between baseline and current fixture."""
    baseline = Cassette(baseline_path)
    current = Cassette(current_path)

    b_slug = baseline.slug
    c_slug = current.slug

    print(f"halley diff: {b_slug} (baseline) vs {c_slug} (current)")
    print("=" * 72)

    b_obs = baseline.observations
    c_obs = current.observations

    # Report overall span count change.
    if len(b_obs) != len(c_obs):
        print(f"\n⚠  span count changed: {len(b_obs)} → {len(c_obs)}")

    drifted = 0
    n = max(len(b_obs), len(c_obs))

    for i in range(n):
        b = b_obs[i] if i < len(b_obs) else None
        c = c_obs[i] if i < len(c_obs) else None

        if b is None:
            print(f"\n[obs {i}] ADDED in current run")
            _print_obs_summary(current, c, label="current")
            drifted += 1
            continue

        if c is None:
            print(f"\n[obs {i}] REMOVED from current run")
            _print_obs_summary(baseline, b, label="baseline")
            drifted += 1
            continue

        # Load bodies.
        b_in = baseline.load_body(b.get("input_body_ref"))
        c_in = current.load_body(c.get("input_body_ref"))
        b_out = baseline.load_body(b.get("output_body_ref"))
        c_out = current.load_body(c.get("output_body_ref"))

        changes = []

        # Model changed?
        if b.get("model") != c.get("model"):
            changes.append(f"  model:   {b.get('model')} → {c.get('model')}")

        # Match key (= input body) changed?
        b_mk = b.get("match_key", "")
        c_mk = c.get("match_key", "")
        if b_mk != c_mk:
            changes.append("  input:   CHANGED (match_key differs)")
            # Show prompt diff.
            b_prompt = _messages_text(b_in)
            c_prompt = _messages_text(c_in)
            if b_prompt != c_prompt:
                diff_lines = list(difflib.unified_diff(
                    b_prompt.splitlines(keepends=True),
                    c_prompt.splitlines(keepends=True),
                    fromfile="baseline/prompt",
                    tofile="current/prompt",
                    n=2,
                ))
                if diff_lines:
                    changes.append("  prompt diff:")
                    for line in diff_lines[:30]:
                        changes.append("    " + line.rstrip("\n"))

        # Output changed?
        b_content = _output_text(b_out)
        c_content = _output_text(c_out)
        if b_content != c_content:
            changes.append("  output:  CHANGED")
            changes.append(f"    baseline: {_truncate(b_content)}")
            changes.append(f"    current:  {_truncate(c_content)}")

        # Token / cost changes.
        b_in_tok = b.get("input_tokens", 0)
        c_in_tok = c.get("input_tokens", 0)
        b_out_tok = b.get("output_tokens", 0)
        c_out_tok = c.get("output_tokens", 0)
        if b_in_tok != c_in_tok or b_out_tok != c_out_tok:
            changes.append(
                f"  tokens:  {b_in_tok}+{b_out_tok} → {c_in_tok}+{c_out_tok}"
            )

        if changes:
            drifted += 1
            op = b.get("operation", "?")
            print(f"\n[obs {i}] {op} — DRIFTED")
            for ch in changes:
                print(ch)
        else:
            print(f"[obs {i}] {b.get('operation','?')} — unchanged")

    print()
    print("─" * 72)
    if drifted == 0:
        print("No drift detected — baseline and current are identical.")
    else:
        print(f"{drifted} of {n} observation(s) drifted.")


def _print_obs_summary(cassette: Cassette, obs: dict | None, label: str) -> None:
    if obs is None:
        return
    body = cassette.load_body(obs.get("output_body_ref"))
    content = _output_text(body)
    print(f"  [{label}] {obs.get('operation','?')} model={obs.get('model','?')}")
    print(f"  output: {_truncate(content)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <baseline.json> <current.json>", file=sys.stderr)
        sys.exit(1)
    diff_fixtures(sys.argv[1], sys.argv[2])
